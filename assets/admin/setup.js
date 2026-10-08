'use strict';

/*
 * ADR 0028: browser setup. The page loads app.js (api, el, setText), icons.js and this file only.
 * Everything the GM types is checked on the SERVER (GET /api/setup/check, the same functions
 * `init` uses); this file never decides validity, it only draws the answer and the shared rule
 * line under it. DOM is built with el()/setText() (textContent) only, never markup. The admin CSP
 * has form-action 'none', so every submit is preventDefault()ed. Screens are reached by hash
 * (#name, #vault, ...); the focus lands on each screen's h1; status regions are aria-live.
 *
 * ADR 0052: the same page, served at /campaigns/add, adds another campaign to a running panel
 * ("add mode"). Add mode asks the add routes instead of the setup routes (the same checks and the
 * same answer rules, server side), commits to /api/campaigns/add with the config sha the page
 * was given, and offers to switch to the new campaign. First run is unchanged in every respect.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var el = A.el;
  var setText = A.setText;
  var icon = A.icon;
  var ADD = location.pathname === '/campaigns/add';

  // Two ways in (ADR 0048): an existing vault, or a new campaign that has setup make the vault.
  var ORDER_HAVE = ['name', 'vault', 'output', 'title', 'theme', 'review'];
  var ORDER_NEW = ['name', 'newfolder', 'title', 'system', 'output', 'theme', 'review'];
  var LABEL = { name: 'Campaign name', vault: 'Vault folder', newfolder: 'New vault folder', output: 'Output folder', title: 'Site title', system: 'Game system', theme: 'Theme', review: 'Review' };
  var SCREENS = ['start', 'name', 'vault', 'newfolder', 'output', 'title', 'system', 'theme', 'review', 'added', 'build', 'ready'];
  var SYSTEM_NAMES = { none: 'None', 'dnd-5e-2024': 'D&D 5e (2024)', pf2e: 'Pathfinder 2e', fitd: 'Forged in the Dark' };
  var SYSTEM_ORDER = ['none', 'dnd-5e-2024', 'pf2e', 'fitd'];
  var SYSTEM_NOTES = { none: 'No system templates. Fits any game.' };
  var SYSTEM_REQUEST_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/issues/new?template=game_system_request.yml';
  var STEPS_SIX = [0, 13, 27, 40, 53, 67, 80];
  var DEBOUNCE_MS = 300;
  var THEME_COPY = {
    plain: { scheme: 'light', text: 'No theme CSS. Your campaign’s own palette and overrides.css carry the look.' },
    haze: { scheme: 'dark', text: 'Smoky dark ground, brass headings, recaps on a parchment slip, IM Fell type.' },
    gloam: { scheme: 'dark', text: 'The default for a new campaign: a dark base with its own palette, ready to use as it is.' }
  };

  var S = {
    server: null,
    way: 'have', newvault: '', system: 'dnd-5e-2024',
    name: '', vault: '', output: '', outputTouched: false, outputConfirmed: false, title: '', theme: null,
    res: {}, // latest server answer per field
    committed: false, built: null, result: null, failure: null, progress: [], switched: false
  };

  var root = document.querySelector('[data-role="setup-root"]');
  var seq = { name: 0, vault: 0, newVault: 0, output: 0, title: 0, starterTitle: 0, system: 0, theme: 0 };
  var timers = {};

  function h(tag, cls, text) {
    var n = el(tag);
    if (cls) n.className = cls;
    if (text !== undefined) setText(n, text);
    return n;
  }
  function add(parent, kids) {
    kids.forEach(function (k) {
      if (k) parent.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return parent;
  }
  function code(text) {
    return h('code', null, text);
  }
  function button(cls, label, ico, onClick) {
    var b = h('button', 'a1-btn ' + cls);
    b.type = 'button';
    if (ico && ico !== 'arrow') b.appendChild(icon(ico));
    b.appendChild(document.createTextNode(label));
    if (ico === 'arrow') b.appendChild(icon('arrow'));
    b.addEventListener('click', onClick);
    return b;
  }
  function joinPath(parts) {
    return parts.join(S.server ? S.server.sep : '/');
  }
  function order() {
    return S.way === 'new' ? ORDER_NEW : ORDER_HAVE;
  }
  function qnOf(k) {
    var i = order().indexOf(k);
    return i >= 0 && k !== 'review' ? i + 1 : 0;
  }
  function qTotal() {
    return S.way === 'new' ? 6 : 5;
  }
  function nextOf(k) {
    var o = order();
    return o[o.indexOf(k) + 1];
  }
  function prevOf(k) {
    var o = order();
    var i = o.indexOf(k);
    return i > 0 ? o[i - 1] : 'start';
  }
  /** The vault folder as the server last answered it: the existing vault, or the new one. */
  function vaultValue() {
    if (S.way === 'new') return S.res.newVault ? S.res.newVault.value : S.newvault;
    return S.res.vault ? S.res.vault.value : S.vault;
  }
  function packDir() {
    return joinPath([vaultValue(), '_meta', 'scriptorium']);
  }
  function leafOf(p) {
    var parts = String(p).split(/[\\/]/).filter(function (x) { return x !== ''; });
    return parts.length ? parts[parts.length - 1] : String(p);
  }
  function parentOf(p) {
    var s2 = String(p).replace(/[\\/]+$/, '');
    var i = Math.max(s2.lastIndexOf('/'), s2.lastIndexOf('\\'));
    return i > 0 ? s2.slice(0, i) : s2;
  }
  function systemName(id) {
    return SYSTEM_NAMES[id] || id;
  }

  // --- server calls -------------------------------------------------------------------------

  function checkUrl(field, value, commit) {
    var q = new URLSearchParams();
    q.set('field', field);
    if (value !== undefined && value !== null) q.set('value', value);
    q.set('commit', commit ? '1' : '0');
    q.set('name', S.name.trim());
    if (field === 'output' || field === 'title' || field === 'theme') q.set('vault', vaultValue());
    return (ADD ? '/api/campaigns/add/check?' : '/api/setup/check?') + q.toString();
  }

  var inflight = {};

  /**
   * Asks the server; only the newest answer for a field is kept. In add mode a committed check of a
   * path that is already on its way is shared rather than sent again (leaving the box and pressing
   * Continue are one act, and over remote access each committed check is a line in the audit log).
   * @returns {Promise<object|null>}
   */
  function ask(field, value, commit) {
    var key = ADD && commit ? field + '\u0000' + value : null;
    if (key && inflight[key]) return inflight[key];
    var mine = ++seq[field];
    var p = A.api(checkUrl(field, value, commit)).then(function (r) {
      if (mine !== seq[field]) return null;
      if (!r.ok || !r.body) {
        S.res[field] = { field: field, state: 'unreachable', value: value, rule: 'The panel did not answer. Is GM-Scriptorium still running?', facts: { reason: 'panel' } };
      } else {
        S.res[field] = r.body;
      }
      return S.res[field];
    });
    if (key) {
      inflight[key] = p;
      var done = function () { delete inflight[key]; };
      p.then(done, done);
    }
    return p;
  }

  function later(field, fn) {
    clearTimeout(timers[field]);
    timers[field] = setTimeout(fn, DEBOUNCE_MS);
  }

  // --- chrome ----------------------------------------------------------------------------------

  function currentScreen() {
    var id = location.hash.replace(/^#/, '');
    return SCREENS.indexOf(id) >= 0 ? id : 'start';
  }
  function go(id) {
    if (location.hash === '#' + id) render();
    else location.hash = '#' + id;
  }

  function stepState(k, cur) {
    var i = order().indexOf(k);
    var c = cur === 'build' || cur === 'ready' ? order().length : order().indexOf(cur);
    if (cur === 'start') c = -1;
    if (cur === 'added') c = order().length;
    return i < c ? 'done' : i === c ? 'cur' : 'todo';
  }
  function railValue(k) {
    if (k === 'name') return S.name.trim();
    if (k === 'vault') return S.res.vault ? S.res.vault.value : S.vault;
    if (k === 'newfolder') return S.res.newVault ? S.res.newVault.value : S.newvault;
    if (k === 'system') return systemName(S.system);
    if (k === 'output') return S.res.output ? S.res.output.value : S.output;
    if (k === 'title') return titleValue();
    if (k === 'theme') return themeValue();
    return '';
  }

  function brand(compactLabel) {
    var wrap = h('div', 'a1-brand');
    var crest = h('div', 'a1-crest');
    crest.setAttribute('aria-hidden', 'true');
    crest.appendChild(h('span', null, 'GM'));
    wrap.appendChild(crest);
    var lines = h('div');
    lines.appendChild(h('div', 'a1-camp', 'GM-Scriptorium'));
    lines.appendChild(h('div', 'a1-sub', compactLabel || 'Setup · first campaign'));
    wrap.appendChild(lines);
    return wrap;
  }

  function sidebar(cur) {
    var side = h('nav', 'a1-side');
    side.setAttribute('data-role', 'side');
    side.setAttribute('aria-label', 'Setup steps');
    side.appendChild(brand(ADD ? 'Adding to ' + (S.server.campaign || 'this panel') : undefined));
    var group = h('div', 'a1-ng');
    group.appendChild(h('div', 'a1-ng-label', ADD ? 'Add a campaign' : 'Setup'));
    var list = h('ol', 'su-rail');
    var busy = cur === 'build' || cur === 'ready' || cur === 'added';
    order().forEach(function (k) {
      var st = stepState(k, cur);
      var warn = st === 'done' && ((k === 'vault' && S.res.vault && S.res.vault.state === 'warn') || (k === 'newfolder' && S.res.newVault && S.res.newVault.state === 'warn'));
      var li = h('li');
      var b = h('button', st + (warn ? ' warn' : ''));
      b.type = 'button';
      if (st === 'todo' || busy) b.disabled = true;
      if (st === 'cur') b.setAttribute('aria-current', 'step');
      var mk = h('span', 'mk');
      if (st === 'done') mk.appendChild(icon(warn ? 'warn' : 'tick'));
      else mk.appendChild(h('i'));
      b.appendChild(mk);
      b.appendChild(h('span', null, LABEL[k]));
      if (st === 'done' && k !== 'review') b.appendChild(h('span', 'v', railValue(k)));
      b.addEventListener('click', function () {
        go(k);
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    group.appendChild(list);
    side.appendChild(group);
    var foot = h('footer', 'a1-sidefoot');
    if (ADD && S.server.via === 'remote') {
      // A remote session is not on the machine: no claim about 127.0.0.1 (ADR 0052, section 6).
      var remote = h('span');
      remote.appendChild(icon('globe'));
      add(remote, [' Remote session']);
      foot.appendChild(remote);
      foot.appendChild(h('span', null, 'Folders you type are checked when you leave the box. Checks and the add are recorded in the audit log.'));
    } else {
      var bound = h('span');
      bound.appendChild(icon('lock'));
      add(bound, [' Bound to ', code('127.0.0.1'), ' only']);
      foot.appendChild(bound);
      foot.appendChild(h('span', null, 'Files are written at the review. New folder makes its folder at once.'));
    }
    side.appendChild(foot);
    return side;
  }

  function topBar(cur) {
    var qn = qnOf(cur);
    var label = cur === 'start' ? (ADD ? 'Add a campaign' : 'Getting started') : qn ? 'Question ' + qn + ' of ' + qTotal() : cur === 'review' ? 'Review' : cur === 'build' ? 'Setting up' : 'Done';
    var pct = cur === 'start' ? 3 : qn ? (S.way === 'new' ? STEPS_SIX[qn] : qn * 16) : cur === 'review' ? 92 : 100;
    var mt = h('header', 'su-mt');
    var crest = h('div', 'a1-crest');
    crest.setAttribute('aria-hidden', 'true');
    crest.appendChild(h('span', null, 'GM'));
    mt.appendChild(crest);
    var grow = h('div', 'grow');
    var camp = h('div', 'a1-camp', ADD ? 'GM-Scriptorium · add a campaign' : 'GM-Scriptorium setup');
    camp.className += ' su-camp-sm';
    grow.appendChild(camp);
    grow.appendChild(h('div', 'l', label));
    var bar = h('div', 'su-pbar');
    bar.setAttribute('aria-hidden', 'true');
    var fill = h('i');
    fill.className = 'w' + pct;
    bar.appendChild(fill);
    grow.appendChild(bar);
    mt.appendChild(grow);
    return mt;
  }

  /** Add mode: the way back to the Campaigns screen, above every screen until the add is made. */
  function backLink() {
    var p = h('p', 'am-back-row');
    var a = h('a', 'a1-link am-back');
    a.href = '/#/campaigns';
    a.appendChild(icon('arrow'));
    a.appendChild(document.createTextNode('Back to campaigns'));
    p.appendChild(a);
    return p;
  }

  function qHead(n, title, lede) {
    var head = h('header');
    head.appendChild(h('div', 'a1-eyebrow', 'Question ' + n + ' of ' + qTotal()));
    var h1 = h('h1', 'a1-h2', title);
    h1.tabIndex = -1;
    head.appendChild(h1);
    var p = h('p', 'a1-lede');
    if (typeof lede === 'string') setText(p, lede);
    else add(p, lede);
    head.appendChild(p);
    return head;
  }

  function foot(back, nextLabel, onNext, note) {
    var f = h('div', 'su-foot' + (back ? ' has-back' : ''));
    if (back) f.appendChild(button('ghost', 'Back', null, function () { go(back); }));
    var grow = h('span', 'grow');
    grow.setAttribute('data-part', 'foot-note');
    if (note) setText(grow, note);
    f.appendChild(grow);
    var next = button('primary', nextLabel || 'Continue', 'arrow', onNext);
    next.setAttribute('data-part', 'next');
    next.disabled = true;
    f.appendChild(next);
    return f;
  }

  function ruleLine(msg) {
    return h('p', 'su-rule', msg);
  }

  function note(kind, ico, kids) {
    var n = h('div', 'a1-note ' + kind);
    n.appendChild(icon(ico));
    var body = h('div');
    add(body, kids);
    n.appendChild(body);
    return n;
  }

  function checksList(rows) {
    var ic = { ok: 'tick', warn: 'warn', bad: 'x', na: 'more', info: 'info' };
    var ul = h('ul', 'su-checks');
    ul.setAttribute('aria-label', 'Checks');
    rows.forEach(function (r) {
      var li = h('li', r[0]);
      li.appendChild(icon(ic[r[0]]));
      li.appendChild(h('b', null, r[1]));
      if (r[2] !== undefined && r[2] !== null && r[2] !== '') {
        var d = h('span', 'd');
        if (typeof r[2] === 'string') setText(d, r[2]);
        else d.appendChild(r[2]);
        li.appendChild(d);
      }
      ul.appendChild(li);
    });
    return ul;
  }

  function commandRows(cmds) {
    var wrap = h('div', 'su-cmds');
    cmds.forEach(function (c) {
      var row = h('div', 'su-cmd');
      row.appendChild(h('span', 'pr', '>'));
      row.appendChild(code(c));
      var b = button('ghost small', 'Copy', null, function () {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c).then(function () { setText(b, 'Copied'); }, function () {});
      });
      b.setAttribute('aria-label', 'Copy ' + c);
      row.appendChild(b);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function setNext(enabled, noteText) {
    var next = root.querySelector('[data-part="next"]');
    if (next) next.disabled = !enabled;
    var n = root.querySelector('[data-part="foot-note"]');
    if (n) setText(n, noteText || '');
  }

  function fieldBlock(id, label, input, statusId) {
    var f = h('div', 'a1-field');
    var lab = h('label', 'su-lab', label);
    lab.setAttribute('for', id);
    f.appendChild(lab);
    var row = h('div', 'su-row');
    row.appendChild(input);
    f.appendChild(row);
    var st = h('div', 'su-status');
    st.id = statusId;
    st.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', statusId);
    f.appendChild(st);
    return { field: f, status: st, row: row };
  }

  function textInput(id, value, mono) {
    var i = h('input', 'a1-in' + (mono ? ' mono' : ''));
    i.type = 'text';
    i.id = id;
    i.value = value;
    i.spellcheck = false;
    i.autocomplete = 'off';
    return i;
  }

  function markInput(input, state) {
    input.classList.remove('ok', 'bad', 'warn');
    if (state === 'ok') input.classList.add('ok');
    else if (state === 'bad' || state === 'unreachable') input.classList.add('bad');
    else if (state === 'warn') input.classList.add('warn');
  }

  // --- screens ---------------------------------------------------------------------------------

  function pathChoice(id, ico, title, text, disabledWhy) {
    var sel = S.way === id;
    var label = h('label', 'su-path' + (sel ? ' sel' : ''));
    var input = h('input');
    input.type = 'radio';
    input.name = 'su-way';
    input.value = id;
    input.checked = sel;
    if (disabledWhy) input.disabled = true;
    input.addEventListener('change', function () {
      S.way = id;
      render();
      var again = root.querySelector('input[name="su-way"][value="' + id + '"]');
      if (again) again.focus();
    });
    label.appendChild(input);
    var ic = h('span', 'ic');
    ic.appendChild(icon(ico));
    label.appendChild(ic);
    label.appendChild(h('b', null, title));
    var rd = h('span', 'su-rd');
    rd.setAttribute('aria-hidden', 'true');
    label.appendChild(rd);
    label.appendChild(h('p', null, disabledWhy || text));
    return label;
  }

  function screenStart() {
    var isNew = S.way === 'new';
    var wrap = h('div', 'su-page');
    var head = h('header', 'su-intro');
    head.appendChild(h('div', 'a1-eyebrow', ADD ? 'Add a campaign' : 'Welcome to GM-Scriptorium'));
    var h1 = h('h1', 'a1-h2', ADD ? 'Add another campaign' : 'Let’s set up your first campaign');
    h1.tabIndex = -1;
    head.appendChild(h1);
    var lede = h('p', 'a1-lede');
    if (ADD && isNew) add(lede, ['Six questions, the same ones as when you first set up, with the same checks. Nothing is created until the last screen, and then setup makes your new vault in a folder that is empty or new.']);
    else if (ADD) add(lede, ['Five questions, the same ones as when you first set up, with the same checks. Nothing in your vault changes until the last screen, and even then setup only adds new files under ', code(joinPath(['_meta', 'scriptorium'])), '.']);
    else if (isNew) add(lede, ['Six questions. They are the ones ', code('gm-scriptorium init'), ' asks in a terminal. Nothing is created until the last screen, and then setup makes your new vault in a folder that is empty or new.']);
    else add(lede, ['Five questions. They are the ones ', code('gm-scriptorium init'), ' asks in a terminal. Nothing in your vault changes until the last screen, and even then setup only adds new files under ', code(joinPath(['_meta', 'scriptorium'])), '.']);
    head.appendChild(lede);
    wrap.appendChild(head);
    if (ADD) {
      wrap.appendChild(note('', 'info', [(function () { var pp = h('p'); pp.appendChild(h('b', null, 'The panel is on ' + (S.server.campaign || 'its campaign') + ', and it stays there.')); pp.appendChild(document.createTextNode(' Adding a campaign does not change it. You choose whether to switch at the end.')); return pp; })()]));
    }

    var nv = S.server && S.server.newVault;
    var fs2 = h('fieldset', 'su-paths');
    fs2.appendChild(h('legend', 'su-lab', 'How do you want to start?'));
    var opts = h('div', 'opts');
    opts.setAttribute('role', 'presentation');
    opts.appendChild(pathChoice('have', 'folder', 'I already have a vault', 'Use the gm-apprentice vault you keep your notes in.'));
    opts.appendChild(pathChoice('new', 'plus', 'Start a new campaign', 'I don’t have a vault yet. Setup makes one for you.', nv && !nv.available ? 'Not available in this build: ' + nv.problem + '.' : null));
    fs2.appendChild(opts);
    wrap.appendChild(fs2);

    var need = h('div', 'su-need');
    var first = isNew
      ? ['folder', 'An empty folder', ['Or a new one. Setup makes the vault there and touches nothing else.']]
      : ['folder', 'Your vault folder', ['The gm-apprentice vault that holds ', code(joinPath(['_meta', 'vault-config.md'])), '.']];
    [first,
      ADD ? ['globe', 'A folder for the site', ['Outside every vault. We suggest one next to it.']] : ['globe', 'Where the player site goes.', ['A separate folder from your vault, so the site never mixes with your notes. We’ll suggest one in the same parent folder as your vault. For example, if your vault is ', code('D:\\Campaigns\\Long Lease'), ', we’ll suggest ', code('D:\\Campaigns\\long-lease-site'), '. You can pick anywhere else.']],
      ADD ? ['info', 'About two minutes', ['Then you choose whether to switch to it.']] : ['info', 'About two minutes', ['Then a first preview that only you can see.']]].forEach(function (c) {
      var d = h('div');
      var ic = h('span', 'ic');
      ic.appendChild(icon(c[0]));
      d.appendChild(ic);
      d.appendChild(h('b', null, c[1]));
      var p = h('p');
      add(p, c[2]);
      d.appendChild(p);
      need.appendChild(d);
    });
    wrap.appendChild(need);
    var f = h('div', 'su-foot');
    var g = h('span', 'grow');
    if (ADD) add(g, ['Prefer a terminal? Run ', code('gm-scriptorium init'), ' there.']);
    else add(g, ['Prefer a terminal? Close this and run ', code('gm-scriptorium init'), '.']);
    f.appendChild(g);
    var start = button('primary big', 'Start', 'arrow', function () { go('name'); });
    f.appendChild(start);
    wrap.appendChild(f);
    if (S.server && S.server.remoteDeferred) {
      wrap.appendChild(note('', 'info', [h('p', null, 'Remote access (' + S.server.remoteDeferred + ') is saved in your settings. Setup runs on this computer only; remote access starts the next time GM-Scriptorium starts.')]));
    }
    return wrap;
  }

  function nameStatusDraw(status, input, r) {
    status.textContent = '';
    markInput(input, r ? r.state : null);
    if (!r) {
      status.appendChild(h('p', 'a1-hint', '1 to 63 characters: a to z, 0 to 9 and hyphens, starting with a letter or digit.'));
    } else if (r.state === 'ok') {
      var p = h('p', 'su-ok');
      p.appendChild(icon('tick'));
      p.appendChild(h('b', null, r.value));
      var sp = h('span');
      add(sp, ['works. Commands use it, like ', code('gm-scriptorium build ' + r.value), '.']);
      p.appendChild(sp);
      status.appendChild(p);
    } else if (r.facts && r.facts.clash) {
      var cp = h('p');
      cp.appendChild(h('b', null, 'That name is already used.'));
      cp.appendChild(document.createTextNode(' Each campaign needs its own name. Add a word, or pick another.'));
      status.appendChild(note('err', 'warn', [cp, ruleLine(r.rule)]));
    } else {
      var kids = [h('p', null, ''), null];
      kids[0].appendChild(h('b', null, 'Use lowercase letters, digits and hyphens only.'));
      kids[0].appendChild(document.createTextNode(' Spaces and capitals belong in the site title, question ' + qnOf('title') + '.'));
      if (r.facts && r.facts.suggestion) {
        var acts = h('div', 'a1-actions');
        acts.classList.add('su-mt8');
        acts.appendChild(button('small', 'Use ' + r.facts.suggestion, null, function () {
          var i = document.getElementById('su-name');
          i.value = r.facts.suggestion;
          i.focus();
          onName(i);
        }));
        kids[1] = acts;
      }
      kids.push(ruleLine(r.rule));
      status.appendChild(note('err', 'warn', kids));
    }
  }

  function onName(input) {
    S.name = input.value;
    var status = document.getElementById('su-name-st');
    if (input.value.trim() === '') {
      seq.name++;
      nameStatusDraw(status, input, null);
      setNext(false);
      return;
    }
    later('name', function () {
      ask('name', input.value, false).then(function (r) {
        if (!r) return;
        nameStatusDraw(status, input, r);
        setNext(r.state === 'ok');
      });
    });
  }

  function screenName() {
    var wrap = h('div', 'su-q');
    wrap.appendChild(qHead(qnOf('name'), 'What should we call this campaign?', 'A short name for commands and folder names. Lowercase letters, digits and hyphens. The title your players see comes later.'));
    var input = textInput('su-name', S.name, true);
    var fb = fieldBlock('su-name', 'Campaign name', input, 'su-name-st');
    if (ADD && S.server.campaigns && S.server.campaigns.length) fb.field.insertBefore(h('p', 'a1-hint', 'Already registered: ' + S.server.campaigns.join(', ') + '.'), fb.status);
    wrap.appendChild(fb.field);
    wrap.appendChild(foot('start', 'Continue', function () { go(nextOf('name')); }));
    input.addEventListener('input', function () { onName(input); });
    nameStatusDraw(fb.status, input, S.res.name && S.name.trim() !== '' ? S.res.name : null);
    setTimeout(function () {
      setNext(Boolean(S.res.name && S.res.name.state === 'ok' && S.name.trim() !== ''));
    }, 0);
    return wrap;
  }

  /** The way across to a new campaign, from the two dead ends of the vault question. */
  function acrossBtn(input) {
    return button('small ghost', 'Start a new campaign here instead', null, function () {
      S.way = 'new';
      S.newvault = input.value;
      S.res.newVault = null;
      go('newfolder');
    });
  }

  /** Add mode, remote session: every typed path waits until the GM leaves the box (ADR 0052, section 6). */
  function remoteDeferHint(recheck) {
    var p = h('p', 'a1-hint');
    p.appendChild(document.createTextNode('This path is checked when you leave the box, so nothing is probed while you type. Press Continue, or '));
    var b = h('button', 'a1-link', 'check it now');
    b.type = 'button';
    b.addEventListener('click', recheck);
    p.appendChild(b);
    p.appendChild(document.createTextNode('.'));
    return p;
  }

  function isRemoteAdd() {
    return ADD && S.server.via === 'remote';
  }

  /** Add mode: a path that clashes with a registered campaign (the server's rule line, word for word). */
  function clashNotes(r, kind) {
    var c = r.facts.clash;
    var other = c.campaign;
    var p = h('p');
    var acts = null;
    if (kind === 'vault-equal') {
      p.appendChild(h('b', null, 'That vault is already a campaign.'));
      p.appendChild(document.createTextNode(' Each campaign needs its own vault. Pick another folder, or go to the campaigns list to switch to ' + other + '.'));
      acts = h('div', 'a1-actions');
      acts.classList.add('su-mt8');
      acts.appendChild(button('small ghost', 'Go to Campaigns', null, function () { location.assign('/#/campaigns'); }));
    } else if (kind === 'vault-in-output') {
      p.appendChild(h('b', null, 'That vault sits inside another campaign’s site folder.'));
      p.appendChild(document.createTextNode(' Every build of ' + other + ' replaces that whole folder, so your notes would go with it. Pick a folder outside it.'));
    } else if (kind === 'output-in-vault') {
      p.appendChild(h('b', null, 'That folder is inside another campaign’s vault.'));
      p.appendChild(document.createTextNode(' Every build would write the website into ' + other + '’s notes. Pick a folder outside every vault; the suggested one sits next to yours.'));
    } else {
      p.appendChild(h('b', null, 'That is another campaign’s site folder.'));
      p.appendChild(document.createTextNode(' Each campaign needs its own, because a build replaces everything in it. Pick another folder.'));
    }
    return { p: p, acts: acts };
  }

  var CLASH_ROW = {
    'vault-equal': ['Already a campaign', function (o) { return ['Registered as ', code(o)]; }],
    'vault-in-output': ['Inside another campaign’s site folder', function (o) { return ['It overlaps the output folder of ', code(o)]; }],
    'output-in-vault': ['Inside another campaign’s vault', function (o) { return ['It overlaps the vault of ', code(o)]; }],
    'output-overlap-output': ['Another campaign’s site folder', function (o) { return ['It overlaps the output folder of ', code(o)]; }]
  };

  function clashRow(r) {
    var spec = CLASH_ROW[r.facts.clash.kind];
    var d = h('span');
    add(d, spec[1](r.facts.clash.campaign));
    return ['bad', spec[0], d];
  }

  function vaultDraw(status, input, r, extraBtn) {
    status.textContent = '';
    markInput(input, r ? r.state : null);
    if (!r) return;
    var f = r.facts || {};
    if (r.state === 'deferred') {
      if (isRemoteAdd()) status.appendChild(remoteDeferHint(function () { onVault(input, true); }));
      else status.appendChild(h('p', 'a1-hint', 'This looks like a network path. It is checked when you leave the box, so nothing is probed while you type.'));
      return;
    }
    if (f.clash) {
      var cn = clashNotes(r, f.clash.kind);
      var clashKids = [cn.p];
      if (cn.acts) clashKids.push(cn.acts);
      clashKids.push(ruleLine(r.rule));
      status.appendChild(checksList([['ok', 'Folder found', code(r.value)], ['ok', 'A gm-apprentice vault', (function () { var sp = h('span'); add(sp, [code(joinPath(['_meta', 'vault-config.md'])), f.campaignTitle ? ' says “' + f.campaignTitle + '”' : ' is there']); return sp; })()], clashRow(r)]));
      status.appendChild(note('err', 'warn', clashKids));
      return;
    }
    if (r.state === 'unreachable') {
      var acts = h('div', 'a1-actions');
      acts.classList.add('su-mt8');
      acts.appendChild(extraBtn());
      status.appendChild(note('err', 'warn', [h('p', null, ''), acts, ruleLine(r.rule)]));
      status.querySelector('p').appendChild(h('b', null, 'Can’t check that folder.'));
      return;
    }
    var rows;
    var extra = [];
    if (r.state === 'ok' || r.state === 'warn') {
      rows = [['ok', 'Folder found', code(r.value)], ['ok', 'A gm-apprentice vault', (function () { var sp = h('span'); add(sp, [code(joinPath(['_meta', 'vault-config.md'])), f.campaignTitle ? ' says “' + f.campaignTitle + '”' : ' is there']); return sp; })()]];
      if (f.unc) rows.push(['warn', 'On a network share', code(r.value)]);
      rows.push(['info', f.packExists ? 'A campaign pack already exists' : 'No campaign pack yet', f.packExists ? 'Setup leaves every existing pack file as it is' : h('span', null, 'Setup adds ' + joinPath(['_meta', 'scriptorium']) + ' at the end')]);
      if (f.unc) {
        extra.push(note('warn', 'warn', [
          (function () { var p = h('p'); p.appendChild(h('b', null, 'This vault is on a network share. Commit to git before you continue.')); return p; })(),
          h('p', null, 'At the end, setup adds new files under ' + joinPath(['_meta', 'scriptorium']) + '. Writing over a share is the least-tested path; commit first and any bad write is one git checkout away. The panel never commits for you.'),
          commandRows(['git add -A', 'git commit -m "Checkpoint before GM-Scriptorium setup"'])
        ]));
      }
    } else if (f.found) {
      rows = [['ok', 'Folder found', code(r.value)], ['bad', 'Not a gm-apprentice vault', 'There is no ' + joinPath(['_meta', 'vault-config.md']) + ' in this folder'], ['na', 'Where it lives', 'Checked once it is a vault']];
      var kids = [h('p'), null];
      kids[0].appendChild(h('b', null, f.candidate ? 'This folder isn’t a vault, but one folder down is.' : 'This folder isn’t a vault.'));
      if (f.candidate) add(kids[0], [' ', code(f.candidate.split(/[\\/]/).pop()), ' has a ', code(joinPath(['_meta', 'vault-config.md'])), '.']);
      var a2 = h('div', 'a1-actions');
      a2.classList.add('su-mt8');
      if (f.candidate) {
        a2.appendChild(button('small', 'Use ' + f.candidate, null, function () {
          input.value = f.candidate;
          input.focus();
          onVault(input, false);
        }));
      }
      a2.appendChild(acrossBtn(input));
      kids[1] = a2;
      kids.push(ruleLine(r.rule));
      extra.push(note('err', 'warn', kids));
    } else {
      rows = [['bad', 'Folder not found', code(r.value)], ['na', 'A gm-apprentice vault', 'Checked once the folder is found'], ['na', 'Where it lives', '']];
      var a3 = h('div', 'a1-actions');
      a3.classList.add('su-mt8');
      a3.appendChild(extraBtn());
      a3.appendChild(acrossBtn(input));
      var p3 = h('p');
      p3.appendChild(h('b', null, 'Can’t find that folder.'));
      extra.push(note('err', 'warn', [p3, a3, ruleLine(r.rule)]));
    }
    status.appendChild(checksList(rows));
    extra.forEach(function (n) { status.appendChild(n); });
  }

  function onVault(input, commit) {
    S.vault = input.value;
    var status = document.getElementById('su-vault-st');
    var recheck = function () {
      return button('small', 'Check again', 'refresh', function () { onVault(input, true); });
    };
    var run = function () {
      ask('vault', input.value, commit).then(function (r) {
        if (!r) return;
        S.res.output = null;
        vaultDraw(status, input, r, recheck);
        setNext(r.state === 'ok' || r.state === 'warn', r.state === 'warn' ? 'Continue works; the warning stays on the review.' : '');
      });
    };
    if (input.value.trim() === '') {
      seq.vault++;
      status.textContent = '';
      markInput(input, null);
      setNext(false);
      return;
    }
    if (commit) {
      clearTimeout(timers.vault);
      run();
    } else later('vault', run);
  }

  function screenVault() {
    var wrap = h('div', 'su-q');
    wrap.appendChild(qHead(qnOf('vault'), 'Where is your campaign vault?', ['The folder that holds ', code(joinPath(['_meta', 'vault-config.md'])), '. It stays where it is. GM-Scriptorium reads it, and at the end of setup adds one small folder inside ', code('_meta'), '.']));
    var input = textInput('su-vault', S.vault, true);
    var fb = fieldBlock('su-vault', 'Vault folder', input, 'su-vault-st');
    wrap.appendChild(fb.field);
    // ADR 0049: Browse only fills the field; the field's own server check then runs as always.
    A.picker.attach(input, { row: fb.row, host: fb.status, label: 'the vault folder', allowCreate: false, onChoose: function () { onVault(input, true); } });
    wrap.appendChild(foot('name', 'Continue', function () {
      // A network path (and every path over remote access) is only probed when the GM commits the field.
      if (S.res.vault && S.res.vault.state === 'deferred') onVault(input, true);
      else go(nextOf('vault'));
    }));
    input.addEventListener('input', function () { onVault(input, false); });
    // Leaving the box commits the field: a network path is probed now (never per keystroke).
    input.addEventListener('blur', function () {
      if (input.value.trim() !== '' && document.body.contains(input)) onVault(input, true);
    });
    var recheck = function () { return button('small', 'Check again', 'refresh', function () { onVault(input, true); }); };
    if (S.res.vault && S.vault.trim() !== '') vaultDraw(fb.status, input, S.res.vault, recheck);
    else if (S.vault.trim() !== '') setTimeout(function () { onVault(input, true); }, 0); // arrived with a folder already chosen
    setTimeout(function () {
      var r = S.res.vault;
      setNext(Boolean(r && (r.state === 'ok' || r.state === 'warn')), r && r.state === 'warn' ? 'Continue works; the warning stays on the review.' : '');
      if (r && r.state === 'deferred') setNext(true);
    }, 0);
    return wrap;
  }

  // --- the new vault folder (ADR 0048) --------------------------------------------------------

  function chipList(paths) {
    var sp = h('span');
    paths.forEach(function (x, i) {
      if (i) sp.appendChild(document.createTextNode(', '));
      sp.appendChild(code(x));
    });
    return sp;
  }

  function newFolderDraw(status, input, r) {
    status.textContent = '';
    markInput(input, r ? r.state : null);
    if (!r) return;
    var f = r.facts || {};
    if (r.state === 'deferred') {
      if (isRemoteAdd()) status.appendChild(remoteDeferHint(function () { onNewFolder(input, true); }));
      else status.appendChild(h('p', 'a1-hint', 'This looks like a network path. It is checked when you leave the box, so nothing is probed while you type.'));
      return;
    }
    if (f.clash) {
      var nvc = clashNotes(r, f.clash.kind);
      var nvKids = [nvc.p];
      if (nvc.acts) nvKids.push(nvc.acts);
      nvKids.push(ruleLine(r.rule));
      status.appendChild(checksList([clashRow(r)]));
      status.appendChild(note('err', 'warn', nvKids));
      return;
    }
    if (r.state === 'unreachable') {
      status.appendChild(note('err', 'warn', [h('p', null, r.rule)]));
      return;
    }
    var notInside = ['ok', 'Not inside a vault', 'No ' + joinPath(['_meta', 'vault-config.md']) + ' in any folder above it'];
    var rows;
    var extra = [];
    var acts;
    if (r.state === 'ok' || r.state === 'warn') {
      var made = function () {
        var d = h('span');
        add(d, [code(leafOf(r.value)), ' inside ', code(parentOf(r.value))]);
        return ['ok', 'A new folder will be created', d];
      };
      if (!f.exists) {
        rows = [made()];
        if (f.missingAncestors && f.missingAncestors.length) rows.push(['info', 'Folders above it will be created first', chipList(f.missingAncestors)]);
        rows.push(notInside);
        if (!(f.missingAncestors && f.missingAncestors.length) && !f.unc && !f.oneDrive) rows.push(['info', 'Nothing is created yet', 'Setup makes the folder on the last screen']);
      } else {
        var lit = f.litter || [];
        var why;
        if (lit.length) {
          why = h('span');
          add(why, ['Apart from ', chipList(lit), ', which setup never reads or changes']);
        } else why = 'The new vault goes straight into it';
        rows = [['ok', 'Folder found', code(r.value)], ['ok', 'Folder is empty', why], notInside];
      }
      if (f.unc) rows.push(['warn', 'On a network share', code(r.value)]);
      if (f.oneDrive) rows.push(['info', 'In OneDrive', 'OneDrive will sync the new vault']);
      if (f.unc) {
        extra.push(note('warn', 'warn', [
          (function () { var pp = h('p'); pp.appendChild(h('b', null, 'This folder is on a network share. Setup never runs git for you.')); return pp; })(),
          h('p', null, 'Writing over a share is the least-tested path. Once setup has made the vault, start git in it and commit, so any bad write later is one git checkout away. Run these in the new vault:'),
          commandRows(['git init', 'git add -A', 'git commit -m "New campaign vault"'])
        ]));
      }
      if (f.oneDrive) {
        extra.push(note('', 'info', [
          (function () { var pp = h('p'); pp.appendChild(h('b', null, 'This folder syncs with OneDrive. That works.')); pp.appendChild(document.createTextNode(' OneDrive uploads the files as setup writes them. If it adds a ')); pp.appendChild(code('desktop.ini')); pp.appendChild(document.createTextNode(', setup leaves it alone.')); return pp; })(),
          h('p', null, 'Let OneDrive finish syncing before you open the vault on another computer.')
        ]));
      }
    } else {
      var kind = f.refusal;
      var pb = h('p');
      if (kind === 'not-empty') {
        rows = [['ok', 'Folder found', code(r.value)], ['bad', 'Not empty', 'Has ' + (f.holds ? f.holds.length : 'some') + ' item' + (f.holds && f.holds.length === 1 ? '' : 's') + ' already'], ['na', 'Not inside a vault', 'Checked once the folder can be used']];
        pb.appendChild(h('b', null, 'That folder isn’t empty.'));
        pb.appendChild(document.createTextNode(' A new vault needs an empty folder, or a new one, so nothing of yours can ever be overwritten. Pick another folder, or add a new folder name to the end of this one.'));
        extra.push(note('err', 'warn', [pb, ruleLine(r.rule)]));
      } else if (kind === 'file') {
        rows = [['bad', 'Not a folder', (function () { var d = h('span'); add(d, [code(r.value), ' is a file']); return d; })()]];
        pb.appendChild(h('b', null, 'That’s a file, not a folder.'));
        pb.appendChild(document.createTextNode(' Pick a folder that is empty, or one that doesn’t exist yet.'));
        extra.push(note('err', 'warn', [pb, ruleLine(r.rule)]));
      } else if (kind === 'link') {
        rows = [['ok', 'Folder found', code(r.value)], ['bad', 'A link to another folder', 'Shortcuts, symlinks and junctions can’t be used']];
        pb.appendChild(h('b', null, 'That folder is a link.'));
        pb.appendChild(document.createTextNode(' Setup only makes a vault in a real folder, so it always knows where the files land. Pick the folder the link points to, or another one.'));
        extra.push(note('err', 'warn', [pb, ruleLine(r.rule)]));
      } else if (kind === 'inside-vault') {
        rows = [['bad', 'Inside an existing vault', (function () { var d = h('span'); add(d, [code(f.ancestor || ''), ' has a ', code(joinPath(['_meta', 'vault-config.md']))]); return d; })()]];
        pb.appendChild(h('b', null, 'That folder is inside a vault.'));
        add(pb, [' A vault can’t hold another vault. Pick a folder outside it. If ', code(leafOf(f.ancestor || '')), ' is the campaign you meant, use it as your vault instead.']);
        acts = h('div', 'a1-actions');
        acts.classList.add('su-mt8');
        acts.appendChild(button('small', 'Use ' + (f.ancestor || '') + ' as my vault', null, function () {
          S.way = 'have';
          S.vault = f.ancestor || '';
          S.res.vault = null;
          go('vault');
        }));
        extra.push(note('err', 'warn', [pb, acts, ruleLine(r.rule)]));
      } else {
        rows = [['bad', 'Not allowed', 'That folder can’t be used']];
        pb.appendChild(h('b', null, 'That folder can’t be used.'));
        extra.push(note('err', 'warn', [pb, ruleLine(r.rule)]));
      }
    }
    status.appendChild(checksList(rows));
    extra.forEach(function (n) { status.appendChild(n); });
  }

  function newFolderReady(r) {
    return Boolean(r && (r.state === 'ok' || r.state === 'warn'));
  }

  function onNewFolder(input, commit) {
    S.newvault = input.value;
    var status = document.getElementById('su-newvault-st');
    var run = function () {
      ask('newVault', input.value, commit).then(function (r) {
        if (!r) return;
        S.res.output = null;
        newFolderDraw(status, input, r);
        setNext(newFolderReady(r) || r.state === 'deferred', r.state === 'warn' ? 'Continue works; the warning stays on the review.' : '');
      });
    };
    if (input.value.trim() === '') {
      seq.newVault++;
      status.textContent = '';
      markInput(input, null);
      setNext(false);
      return;
    }
    if (commit) {
      clearTimeout(timers.newVault);
      run();
    } else later('newVault', run);
  }

  function screenNewFolder() {
    var wrap = h('div', 'su-q');
    wrap.appendChild(qHead(qnOf('newfolder'), 'Where should the new vault go?', 'An empty folder, or one that doesn’t exist yet. Setup makes the vault there on the last screen, and never changes anything else on your computer.'));
    var input = textInput('su-newvault', S.newvault, true);
    var fb = fieldBlock('su-newvault', 'New vault folder', input, 'su-newvault-st');
    var hint = h('p', 'a1-hint');
    add(hint, ['Folders above it that don’t exist yet are made on the last screen, one at a time, and listed on the review. A folder that holds only ', code('.git'), ', ', code('.obsidian'), ' or operating-system files such as ', code('desktop.ini'), ' counts as empty.']);
    fb.field.insertBefore(hint, fb.status);
    wrap.appendChild(fb.field);
    // ADR 0049: Browse only fills the field; the field's own server check then runs as always.
    A.picker.attach(input, { row: fb.row, host: fb.status, label: 'the new vault folder', allowCreate: false, onChoose: function () { onNewFolder(input, true); } });
    wrap.appendChild(foot('name', 'Continue', function () {
      if (S.res.newVault && S.res.newVault.state === 'deferred') onNewFolder(input, true);
      else go(nextOf('newfolder'));
    }));
    input.addEventListener('input', function () { onNewFolder(input, false); });
    input.addEventListener('blur', function () {
      if (input.value.trim() !== '' && document.body.contains(input)) onNewFolder(input, true);
    });
    if (S.res.newVault && S.newvault.trim() !== '') newFolderDraw(fb.status, input, S.res.newVault);
    else if (S.newvault.trim() !== '') setTimeout(function () { onNewFolder(input, true); }, 0); // arrived with a folder already chosen
    setTimeout(function () {
      var r = S.res.newVault;
      setNext(newFolderReady(r) || Boolean(r && r.state === 'deferred'), r && r.state === 'warn' ? 'Continue works; the warning stays on the review.' : '');
    }, 0);
    return wrap;
  }

  function outputDraw(status, input, r) {
    status.textContent = '';
    var sug = document.getElementById('su-out-hint');
    if (sug) sug.hidden = !(r && r.state === 'ok');
    markInput(input, r ? r.state : null);
    if (!r) return;
    var f = r.facts || {};
    if (r.state === 'deferred') {
      if (isRemoteAdd()) status.appendChild(remoteDeferHint(function () { onOutput(input, true); }));
      else status.appendChild(h('p', 'a1-hint', 'This looks like a network path. It is checked when you leave the box.'));
      return;
    }
    if (r.state === 'unreachable') {
      status.appendChild(note('err', 'warn', [h('p', null, r.rule)]));
      return;
    }
    var rows;
    var extra = [];
    var useDefault = function () {
      input.value = f.default;
      input.focus();
      S.outputConfirmed = false;
      onOutput(input, false);
    };
    if (f.clash) {
      var oc = clashNotes(r, f.clash.kind);
      var ocKids = [oc.p];
      var oa = h('div', 'a1-actions');
      oa.classList.add('su-mt8');
      if (f.default) oa.appendChild(button('small', 'Use ' + f.default, null, useDefault));
      ocKids.push(oa, ruleLine(r.rule));
      status.appendChild(checksList([clashRow(r), ['ok', 'Outside your vault', '']]));
      status.appendChild(note('err', 'warn', ocKids));
      return;
    }
    if (r.state === 'ok') {
      rows = [['ok', 'Outside the vault', ''], [ 'ok', f.exists ? 'Folder is free to use' : 'New folder', f.exists ? 'Empty, or an earlier GM-Scriptorium build' : 'Created by the first build'], ['info', 'Next to your vault', 'Suggested, so it’s easy to find']];
    } else if (r.state === 'warn') {
      rows = [['ok', 'Outside the vault', ''], ['warn', 'Not empty', 'Has other files, and isn’t an earlier GM-Scriptorium build']];
      var p = h('p');
      var pb2 = h('b');
      pb2.appendChild(code(r.value));
      pb2.appendChild(document.createTextNode(' already has other files in it.'));
      p.appendChild(pb2);
      p.appendChild(document.createTextNode(' The first build replaces everything in this folder.'));
      var lab = h('label', 'st-check');
      lab.setAttribute('for', 'su-outok');
      var cb = h('input');
      cb.type = 'checkbox';
      cb.id = 'su-outok';
      cb.checked = S.outputConfirmed;
      cb.addEventListener('change', function () {
        S.outputConfirmed = cb.checked;
        setNext(cb.checked, cb.checked ? '' : 'Tick the box, or pick another folder.');
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' Replace this folder’s contents on the first build'));
      lab.classList.add('su-mt8');
      var acts = h('div', 'a1-actions');
      acts.classList.add('su-mt8');
      acts.appendChild(button('small ghost', 'Use the suggested folder instead', null, useDefault));
      extra.push(note('warn', 'warn', [p, lab, acts, ruleLine(r.rule)]));
    } else {
      var vaultCode = S.res.vault ? S.res.vault.value : S.vault;
      var innerDetail = h('span');
      if (f.inside) add(innerDetail, [code(vaultCode), ' contains it']);
      else setText(innerDetail, 'That folder can’t be used');
      rows = [['bad', f.inside ? 'Inside the vault' : 'Not allowed', innerDetail]];
      var pb = h('p');
      pb.appendChild(h('b', null, f.inside ? 'That folder is inside your vault.' : 'That folder can’t be used.'));
      pb.appendChild(document.createTextNode(f.inside ? ' Every build would write the website into your notes. Pick a folder outside it; the suggested one sits next to the vault.' : ''));
      var a2 = h('div', 'a1-actions');
      a2.classList.add('su-mt8');
      if (f.default) a2.appendChild(button('small', 'Use ' + f.default, null, useDefault));
      extra.push(note('err', 'warn', [pb, a2, ruleLine(r.rule)]));
    }
    status.appendChild(checksList(rows));
    extra.forEach(function (n) { status.appendChild(n); });
  }

  function outputReady(r) {
    if (!r) return false;
    if (r.state === 'ok') return true;
    // Add mode over remote access: a deferred path can be continued; Continue then checks it (as the vault question does).
    if (r.state === 'deferred' && isRemoteAdd()) return true;
    return r.state === 'warn' && S.outputConfirmed;
  }

  function onOutput(input, commit) {
    S.output = input.value;
    S.outputTouched = true;
    var status = document.getElementById('su-out-st');
    var run = function () {
      ask('output', input.value, commit).then(function (r) {
        if (!r) return;
        outputDraw(status, input, r);
        setNext(outputReady(r), r.state === 'warn' && !S.outputConfirmed ? 'Tick the box, or pick another folder.' : '');
      });
    };
    if (commit) {
      clearTimeout(timers.output);
      run();
    } else later('output', run);
  }

  function screenOutput() {
    var wrap = h('div', 'su-q');
    wrap.appendChild(qHead(qnOf('output'), 'Where should the built site go?', ADD ? 'Each build writes the player website here. It has to be outside your vault, and outside every other campaign’s vault and site folder.' : 'Each build writes the player website here. It has to be outside your vault, so the site never ends up in your notes.'));
    var input = textInput('su-out', S.output, true);
    var fb = fieldBlock('su-out', 'Output folder', input, 'su-out-st');
    wrap.appendChild(fb.field);
    A.picker.attach(input, { row: fb.row, host: fb.status, label: 'the output folder', allowCreate: true, onChoose: function () { S.outputConfirmed = false; onOutput(input, true); } });
    var hint = h('p', 'a1-hint', 'Suggested: next to your vault, named after the campaign.');
    hint.id = 'su-out-hint';
    fb.field.insertBefore(hint, fb.status);
    wrap.appendChild(foot(prevOf('output'), 'Continue', function () {
      if (S.res.output && S.res.output.state === 'deferred') onOutput(input, true);
      else go(nextOf('output'));
    }));
    input.addEventListener('input', function () { S.outputConfirmed = false; onOutput(input, false); });
    input.addEventListener('blur', function () {
      if (input.value.trim() !== '' && document.body.contains(input)) onOutput(input, true);
    });
    // The default comes from the server: ask once with an empty value, then fill the box.
    var seed = !S.outputTouched; // an untouched suggestion follows the vault; a folder the GM chose never moves
    ask('output', seed ? '' : S.output, false).then(function (r0) {
      if (!r0) return;
      if (seed && r0.facts && r0.facts.default) {
        input.value = r0.facts.default;
        S.output = input.value;
        ask('output', input.value, false).then(function (r) {
          if (!r) return;
          outputDraw(fb.status, input, r);
          setNext(outputReady(r));
        });
      } else {
        outputDraw(fb.status, input, r0);
        setNext(outputReady(r0));
      }
    });
    return wrap;
  }

  function titleValue() {
    if (S.way === 'new') {
      return S.title.trim().replace(/\s+/g, ' '); // as the server will normalise it
    }
    var r = S.res.title;
    if (r && r.facts && r.facts.readOnly) return r.value;
    return S.title.trim();
  }

  function titleDraw(status, input, r) {
    status.textContent = '';
    markInput(input, r ? r.state : null);
    if (!r) return;
    if (r.state === 'ok') {
      var p = h('p', 'su-ok');
      p.appendChild(icon('tick'));
      var sp = h('span');
      add(sp, ['Players will see ', h('b', null, r.value), ' at the top of every page.']);
      p.appendChild(sp);
      status.appendChild(p);
    } else {
      var q = h('p');
      q.appendChild(h('b', null, 'The title needs some words, on one line.'));
      status.appendChild(note('err', 'warn', [q, ruleLine(r.rule)]));
    }
  }

  function titleNewDraw(status, input, r) {
    status.textContent = '';
    markInput(input, r ? r.state : null);
    if (!r) return;
    if (r.state === 'ok') {
      var p = h('p', 'su-ok');
      p.appendChild(icon('tick'));
      var sp = h('span');
      add(sp, ['Players will see ', h('b', null, r.value), ' at the top of every page.']);
      p.appendChild(sp);
      status.appendChild(p);
    } else {
      var q = h('p');
      q.appendChild(h('b', null, 'That title can’t be used.'));
      status.appendChild(note('err', 'warn', [q, ruleLine(r.rule)]));
    }
  }

  /** The site title on the new-campaign path: the same words also name the campaign inside the new vault. */
  function screenTitleNew() {
    var wrap = h('div', 'su-q');
    wrap.appendChild(qHead(qnOf('title'), 'What’s the site called?', 'Players see this at the top of every page. Anything on one line.'));
    var input = textInput('su-title', S.title, false);
    var fb = fieldBlock('su-title', 'Site title', input, 'su-title-st');
    fb.field.insertBefore(h('p', 'a1-hint', 'Also used as the campaign name inside the new vault.'), fb.status);
    wrap.appendChild(fb.field);
    wrap.appendChild(foot(prevOf('title'), 'Continue', function () { go(nextOf('title')); }));
    var check = function (immediate) {
      S.title = input.value;
      var run = function () {
        ask('starterTitle', input.value, false).then(function (r) {
          if (!r) return;
          titleNewDraw(fb.status, input, r);
          setNext(r.state === 'ok');
        });
      };
      if (immediate) run();
      else later('starterTitle', run);
    };
    input.addEventListener('input', function () { check(false); });
    if (S.title === '') {
      // The default comes from the server: ask once with no value, then fill the box.
      ask('starterTitle', undefined, false).then(function (r0) {
        if (!r0) return;
        if (S.title === '' && r0.value) {
          input.value = r0.value;
          S.title = r0.value;
        }
        check(true);
      });
    } else check(true);
    return wrap;
  }

  function screenTitle() {
    if (S.way === 'new') return screenTitleNew();
    var wrap = h('div', 'su-q');
    wrap.appendChild(h('div'));
    var body = h('div', 'su-q');
    wrap.appendChild(body);
    ask('title', undefined, false).then(function (r0) {
      if (!r0) return;
      var f = r0.facts || {};
      wrap.removeChild(wrap.firstChild);
      if (f.readOnly) {
        wrap.insertBefore(qHead(qnOf('title'), 'What’s the site called?', 'Players see this at the top of every page.'), body);
        var ro = h('div', 'su-ro');
        ro.appendChild(h('span', 'su-lab', 'Already set in your campaign pack'));
        ro.appendChild(h('span', 'v', r0.value === null ? '(not set)' : r0.value));
        var hint = h('p', 'a1-hint');
        add(hint, ['From ', code(joinPath(['_meta', 'scriptorium', 'vault.config.json'])), '. Setup never edits a pack file that already exists. Change the title later under Title & tagline.']);
        ro.appendChild(hint);
        body.appendChild(ro);
        body.appendChild(foot(prevOf('title'), 'Continue', function () { go(nextOf('title')); }));
        setNext(true);
        return;
      }
      wrap.insertBefore(qHead(qnOf('title'), 'What’s the site called?', 'Players see this at the top of every page. Anything on one line.'), body);
      if (S.title === '' && f.default) S.title = f.default;
      var input = textInput('su-title', S.title, false);
      var fb = fieldBlock('su-title', 'Site title', input, 'su-title-st');
      var hint2 = h('p', 'a1-hint');
      add(hint2, ['Filled in from ', code('campaign:'), ' in ', code(joinPath(['_meta', 'vault-config.md'])), ' when it has one.']);
      fb.field.insertBefore(hint2, fb.status);
      body.appendChild(fb.field);
      body.appendChild(foot(prevOf('title'), 'Continue', function () { go(nextOf('title')); }));
      var check = function (immediate) {
        S.title = input.value;
        var run = function () {
          ask('title', input.value, false).then(function (r) {
            if (!r) return;
            S.res.title = r;
            titleDraw(fb.status, input, r);
            setNext(r.state === 'ok');
          });
        };
        if (immediate) run();
        else later('title', run);
      };
      input.addEventListener('input', function () { check(false); });
      check(true);
    });
    return wrap;
  }

  function themeValue() {
    var r = S.res.theme;
    if (r && r.facts && r.facts.readOnly) return r.value;
    return S.theme || (S.server && S.server.defaultTheme) || '';
  }

  function themeSketch(name) {
    var pv = h('div', 'pv pv-' + name);
    pv.setAttribute('aria-hidden', 'true');
    var inn = h('div', 'pv-in');
    var nav = h('div', 'pv-nav');
    nav.appendChild(h('span', 'pv-brand', titleValue() || 'Your title'));
    ['Story', 'Characters', 'World'].forEach(function (t) { nav.appendChild(h('span', null, t)); });
    nav.appendChild(h('span', 'pv-search', 'Search'));
    inn.appendChild(nav);
    var hero = h('div', 'pv-hero');
    hero.appendChild(h('div', 'pv-h1', titleValue() || 'Your title'));
    inn.appendChild(hero);
    var body = h('div', 'pv-body');
    body.appendChild(h('div', 'pv-sh', 'Latest session'));
    body.appendChild(h('div', 'pv-card', 'A short recap of the last session sits here.'));
    body.appendChild(h('div', 'pv-sh', 'The Team'));
    var team = h('div', 'pv-team');
    for (var i = 0; i < 4; i++) team.appendChild(h('i'));
    body.appendChild(team);
    inn.appendChild(body);
    pv.appendChild(inn);
    return pv;
  }

  /** Marks the picked theme, and the default one while it is not the picked one. */
  function pills(grid) {
    Array.prototype.forEach.call(grid.querySelectorAll('.st'), function (st) {
      var name = st.getAttribute('data-theme');
      st.textContent = '';
      if (name === S.theme) st.appendChild(h('span', 'a1-pill sage', 'picked'));
      else if (name === S.server.defaultTheme) st.appendChild(h('span', 'a1-pill muted', 'default'));
    });
  }

  function screenTheme() {
    var wrap = h('div', 'su-q');
    wrap.classList.add('wide');
    var body = h('div');
    wrap.appendChild(body);
    ask('theme', S.theme === null ? undefined : S.theme, false).then(function (r0) {
      if (!r0) return;
      var f = r0.facts || {};
      body.textContent = '';
      body.className = 'su-q wide';
      body.appendChild(qHead(qnOf('theme'), 'Pick a look for the player site', 'Sketches of your landing page in each theme, using your title. You can switch any time under Theme.'));
      var noteHost = h('div', 'su-themes-note');
      noteHost.setAttribute('aria-live', 'polite');
      var drawNote = function (r) {
        noteHost.textContent = '';
        if (r && r.facts && r.facts.note) noteHost.appendChild(note('', 'info', [h('p', null, r.facts.note)]));
      };
      if (f.readOnly) {
        var ro = h('div', 'su-ro');
        ro.appendChild(h('span', 'su-lab', 'Already set in your campaign pack'));
        ro.appendChild(h('span', 'v', r0.value));
        var hint = h('p', 'a1-hint');
        add(hint, ['From ', code(joinPath(['_meta', 'scriptorium', 'pack.toml'])), '. Setup never edits a pack file that already exists. Change the theme later under Theme.']);
        ro.appendChild(hint);
        body.appendChild(ro);
      } else {
        if (S.theme === null) S.theme = S.server.defaultTheme;
        var grid = h('div', 'su-themes');
        grid.setAttribute('role', 'radiogroup');
        grid.setAttribute('aria-label', 'Theme');
        S.server.themes.forEach(function (name) {
          var copy = THEME_COPY[name] || { scheme: '', text: '' };
          var label = h('label', 'su-theme' + (S.theme === name ? ' sel' : ''));
          var input = h('input');
          input.type = 'radio';
          input.name = 'su-theme';
          input.id = 'su-theme-' + name;
          input.value = name;
          input.checked = S.theme === name;
          var frame = h('div', 'su-frame');
          frame.appendChild(themeSketch(name));
          var cap = h('div', 'a1-cap2');
          cap.appendChild(h('span', 'nm', name));
          if (copy.scheme) cap.appendChild(h('span', 'a1-pill muted', copy.scheme));
          var st = h('span', 'st');
          st.setAttribute('data-theme', name);
          cap.appendChild(st);
          label.appendChild(input);
          label.appendChild(frame);
          label.appendChild(cap);
          label.appendChild(h('p', null, copy.text));
          input.addEventListener('change', function () {
            S.theme = name;
            Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('sel'); });
            label.classList.add('sel');
            pills(grid);
            ask('theme', name, false).then(function (r) { drawNote(r); });
          });
          grid.appendChild(label);
        });
        pills(grid);
        body.appendChild(grid);
      }
      drawNote(r0);
      body.appendChild(noteHost);
      body.appendChild(foot(prevOf('theme'), 'Continue', function () { go(nextOf('theme')); }));
      setNext(r0.state === 'ok');
    });
    return wrap;
  }

  // --- the game system (ADR 0048) -----------------------------------------------------------

  function systemIds() {
    var offered = (S.server && S.server.newVault && S.server.newVault.systems) || [];
    var ids = ['none'].concat(offered.filter(function (x) { return x !== 'none'; }));
    var rank = function (x) { var i = SYSTEM_ORDER.indexOf(x); return i < 0 ? 99 : i; };
    return ids.sort(function (a, b) { return rank(a) - rank(b) || (a < b ? -1 : 1); });
  }

  function screenSystem() {
    if (systemIds().indexOf(S.system) < 0) S.system = 'none'; // a build without that system falls back
    var wrap = h('div', 'su-q');
    wrap.appendChild(qHead(qnOf('system'), 'Which game system?', 'Setup adds note templates for this system to the new vault. They are ordinary notes you can change.'));
    var box = h('fieldset', 'su-sys');
    box.appendChild(h('legend', 'su-lab', 'Game system'));
    var rows = h('div', 'rows');
    systemIds().forEach(function (id) {
      var label = h('label', 'su-opt' + (S.system === id ? ' sel' : ''));
      var input = h('input');
      input.type = 'radio';
      input.name = 'su-sys';
      input.value = id;
      input.checked = S.system === id;
      label.appendChild(input);
      var rd = h('span', 'su-rd');
      rd.setAttribute('aria-hidden', 'true');
      label.appendChild(rd);
      label.appendChild(h('span', 'nm', systemName(id)));
      label.appendChild(h('span', 'id', id));
      if (SYSTEM_NOTES[id]) label.appendChild(h('span', 'd', SYSTEM_NOTES[id]));
      input.addEventListener('change', function () {
        S.system = id;
        Array.prototype.forEach.call(rows.children, function (c) { c.classList.remove('sel'); });
        label.classList.add('sel');
        ask('system', id, false).then(function (r) { if (r) setNext(r.state === 'ok'); });
      });
      rows.appendChild(label);
    });
    box.appendChild(rows);
    wrap.appendChild(box);
    var hint = h('p', 'a1-hint');
    var more = h('a', null, 'Ask for yours');
    more.href = SYSTEM_REQUEST_URL;
    more.target = '_blank';
    more.rel = 'noopener noreferrer';
    add(hint, ['More systems are on the way. ', more]);
    wrap.appendChild(hint);
    wrap.appendChild(foot(prevOf('system'), 'Continue', function () { go(nextOf('system')); }));
    ask('system', S.system, false).then(function (r) { if (r) setNext(r.state === 'ok'); });
    return wrap;
  }

  function reviewRows() {
    if (S.way === 'new') return reviewRowsNew();
    var unc = S.res.vault && S.res.vault.facts && S.res.vault.facts.unc;
    var vaultCell = [code(S.res.vault ? S.res.vault.value : S.vault)];
    if (unc) vaultCell.push(document.createTextNode(' '), h('span', 'a1-pill rose', 'network share'));
    var titleFromPack = S.res.title && S.res.title.facts && S.res.title.facts.readOnly;
    var themeFromPack = S.res.theme && S.res.theme.facts && S.res.theme.facts.readOnly;
    return [
      ['Campaign name', [code(S.name.trim())], 'name'],
      ['Vault', vaultCell, 'vault'],
      ['Output folder', [code(S.res.output ? S.res.output.value : S.output)], 'output'],
      ['Site title', [document.createTextNode(titleValue()), titleFromPack ? document.createTextNode(' ') : null, titleFromPack ? h('span', 'a1-pill muted', 'from pack') : null], 'title'],
      ['Theme', [document.createTextNode(themeValue()), themeFromPack ? document.createTextNode(' ') : null, themeFromPack ? h('span', 'a1-pill muted', 'from pack') : null], 'theme']
    ];
  }

  function reviewRowsNew() {
    var r = S.res.newVault || { value: S.newvault, facts: {} };
    var unc = r.facts && r.facts.unc;
    var vaultCell = [code(r.value), document.createTextNode(' '), unc ? h('span', 'a1-pill rose', 'network share') : h('span', 'a1-pill muted', r.facts && r.facts.exists ? 'empty folder' : 'new folder')];
    var themeFromPack = false;
    return [
      ['Campaign name', [code(S.name.trim())], 'name'],
      ['New vault', vaultCell, 'newfolder'],
      ['Site title', [document.createTextNode(titleValue())], 'title'],
      ['Game system', [document.createTextNode(systemName(S.system))], 'system'],
      ['Output folder', [code(S.res.output ? S.res.output.value : S.output)], 'output'],
      ['Theme', [document.createTextNode(themeValue()), themeFromPack ? null : null], 'theme']
    ];
  }

  /** The "Create the new vault" step of the review, with what the starter holds for the chosen system. */
  function newVaultSteps(ol) {
    var r = S.res.newVault || { value: S.newvault, facts: {} };
    var f = r.facts || {};
    var sys = S.res.system && S.res.system.facts ? S.res.system.facts.layout : null;
    if (f.missingAncestors && f.missingAncestors.length) {
      var la = h('li');
      add(la, ['Create the folders above it, one at a time: ', chipList(f.missingAncestors), '.']);
      ol.appendChild(la);
    }
    var li = h('li');
    add(li, ['Create the new vault, ', code(r.value), ':']);
    var ul = h('ul');
    var starter = h('li');
    if (S.system === 'none') add(starter, ['The gm-apprentice starter: its folders, its general templates (no system ones), and its ', code('_meta'), ' files, such as ', code('vault-config.md'), ' and ', code('publish-manifest.md'), '.']);
    else add(starter, ['The gm-apprentice starter: its folders, note templates for ', systemName(S.system), ', and its ', code('_meta'), ' files, such as ', code('vault-config.md'), ' and ', code('publish-manifest.md'), '.']);
    ul.appendChild(starter);
    var wl = h('li');
    add(wl, ['A welcome page, ', code(joinPath(['_Campaign', 'Welcome.md'])), '. It is the only page on the site at first.']);
    ul.appendChild(wl);
    var nl = h('li');
    add(nl, [code(joinPath(['_meta', 'NOTICE.txt'])), ', crediting gm-apprentice (CC BY-SA 4.0).']);
    ul.appendChild(nl);
    li.appendChild(ul);
    ol.appendChild(li);
    return sys;
  }

  function treeBox(layout) {
    var det = h('details', 'su-tree');
    det.appendChild(h('summary', null, 'See every folder and file it makes'));
    var box = h('div', 'box');
    var ul = h('ul');
    var sep = S.server ? S.server.sep : '/';
    layout.dirs.forEach(function (d) { ul.appendChild(h('li', null, d.split('/').join(sep) + sep)); });
    layout.files.forEach(function (x) { ul.appendChild(h('li', null, x.split('/').join(sep))); });
    box.appendChild(ul);
    box.appendChild(h('p', null, 'This is the exact list from the starter built into GM-Scriptorium.'));
    det.appendChild(box);
    return det;
  }

  function screenReview() {
    var wrap = h('div', 'su-page');
    var head = h('header');
    head.appendChild(h('div', 'a1-eyebrow', 'Last step'));
    var h1 = h('h1', 'a1-h2', 'Check your answers');
    h1.tabIndex = -1;
    head.appendChild(h1);
    head.appendChild(h('p', 'a1-lede', ADD ? 'This is the only screen that writes anything. A folder you made with New folder is already on your disk.' : S.way === 'new' ? 'This is the only screen that writes anything: setup creates your new vault when you press a button below. A folder you made with New folder is already on your disk.' : 'Setup writes your campaign’s files when you press a button below. A folder you made with New folder is already on your disk.'));
    wrap.appendChild(head);

    var slip = h('section', 'a1-slip inline');
    slip.setAttribute('aria-labelledby', 'su-rv');
    var seal = h('div', 'a1-seal', 'S');
    seal.setAttribute('aria-hidden', 'true');
    slip.appendChild(seal);
    slip.appendChild(h('div', 'cf-eyebrow', ADD ? 'Review before adding' : 'Review before setting up'));
    var title = h('h2', 'cf-title', (ADD ? 'Add ' : 'Set up ') + S.name.trim());
    title.id = 'su-rv';
    slip.appendChild(title);
    var sum = h('div', 'su-sum');
    reviewRows().forEach(function (r) {
      var row = h('div');
      row.appendChild(h('span', 'k', r[0]));
      var v = h('span', 'v');
      add(v, r[1]);
      row.appendChild(v);
      var change = h('button', 'a1-link', 'Change');
      change.type = 'button';
      change.setAttribute('aria-label', 'Change ' + r[0].toLowerCase());
      change.addEventListener('click', function () { go(r[2]); });
      row.appendChild(change);
      sum.appendChild(row);
    });
    slip.appendChild(sum);

    var footer = h('div', 'cf-foot');
    if (ADD) footer.appendChild(h('p', 'cf-eyebrow', 'Created now'));
    var packExists = S.way !== 'new' && S.res.vault && S.res.vault.facts && S.res.vault.facts.packExists;
    var ol = h('ol', 'su-do');
    var layout = S.way === 'new' ? newVaultSteps(ol) : null;
    var li1 = h('li');
    add(li1, [packExists
      ? ['Add whatever is missing in ', code(packDir() + joinPath(['']) ), ': ', code('css'), ', ', code('images'), ', ', code('pack.toml'), ' and ', code('vault.config.json'), '. Every file that already exists is left alone, and listed afterwards.']
      : ['Create in ', code(packDir() + joinPath([''])), ': ', code('css'), ', ', code('images'), ', ', code('pack.toml'), ' and ', code('vault.config.json'), '. Nothing else in the vault changes, and no existing file is overwritten.']
    ].reduce(function (a, b) { return a.concat(b); }, []).map(function (x) { return typeof x === 'string' ? document.createTextNode(x) : x; }));
    ol.appendChild(li1);
    if (S.res.output && S.res.output.facts && S.res.output.facts.exists === false) {
      var liOut = h('li');
      add(liOut, ['Created by the first build: ', code(S.res.output.value)]);
      ol.appendChild(liOut);
    }
    var li2 = h('li');
    if (ADD) {
      add(li2, ['Add ', h('b', null, S.name.trim()), ' to your campaigns, in ', code(S.server.configPath), '.']);
      ol.appendChild(li2);
      var dflt = S.server.defaultCampaign;
      var li3 = h('li');
      if (dflt) add(li3, ['Your default stays ', h('b', null, dflt), '. GM-Scriptorium opens it when you don’t name a campaign.']);
      else add(li3, [h('b', null, S.name.trim()), ' becomes your default campaign, because none is set.']);
      ol.appendChild(li3);
      ol.appendChild(h('li', null, 'Show a short welcome the first time you open it in a browser on the PC.'));
      if (isRemoteAdd()) ol.appendChild(h('li', null, 'Record this add, with the vault path, in the audit log.'));
    } else {
      add(li2, ['Register ', h('b', null, S.name.trim()), ' as your default campaign, in ', code(S.server.configPath), '.']);
      ol.appendChild(li2);
      ol.appendChild(h('li', null, 'Run a first check, then build a preview that only you can see.'));
    }
    footer.appendChild(ol);
    if (layout) footer.appendChild(treeBox(layout));
    if (S.way === 'new') footer.appendChild(h('p', 'cf-note', 'Setup never deletes anything. If it stops partway, it lists exactly what it made, and writes nothing else.'));
    if (ADD) footer.appendChild(h('p', 'cf-note', 'Nothing is switched yet. You choose that on the next screen.'));
    if (S.way === 'new' && S.res.newVault && S.res.newVault.facts && S.res.newVault.facts.unc) {
      var cn2 = h('p', 'cf-note');
      cn2.appendChild(h('b', null, 'Network share:'));
      cn2.appendChild(document.createTextNode(' once the vault is made, start git in it and commit. The panel never runs git for you.'));
      footer.appendChild(cn2);
    } else if (S.way !== 'new' && S.res.vault && S.res.vault.facts && S.res.vault.facts.unc) {
      var cn = h('p', 'cf-note');
      cn.appendChild(h('b', null, 'Network share:'));
      cn.appendChild(document.createTextNode(' commit your vault first if you haven’t. The panel never commits for you.'));
      footer.appendChild(cn);
    }
    var status = h('div');
    status.id = 'su-commit-st';
    status.setAttribute('aria-live', 'polite');
    // Add mode: a refusal is shown above the review, on the page's own ground (the slip's paper would wash the note out).
    if (ADD) wrap.insertBefore(status, head);
    else footer.appendChild(status);
    var btns = h('div', 'cf-btns');
    if (ADD) {
      var addBtn = button('primary', 'Add ' + S.name.trim(), 'plus', function () { commitAdd(status, [addBtn]); });
      btns.appendChild(addBtn);
    } else {
      var nobuild = button('', 'Set up without building', null, function () { commit(false, status, [nobuild, buildBtn]); });
      var buildBtn = button('primary', 'Build my first preview', 'play', function () { commit(true, status, [nobuild, buildBtn]); });
      btns.appendChild(nobuild);
      btns.appendChild(buildBtn);
    }
    footer.appendChild(btns);
    slip.appendChild(footer);
    wrap.appendChild(slip);
    if (S.failure) {
      status.appendChild(h('p', 'su-rule', S.failure));
    }
    return wrap;
  }

  // --- commit and build ------------------------------------------------------------------------

  function answersBody() {
    var body = {
      name: S.name.trim(),
      vault: vaultValue(),
      output: S.res.output ? S.res.output.value : S.output,
      outputConfirmed: S.outputConfirmed === true
    };
    if (S.way === 'new') {
      body.newVault = true;
      body.system = S.system;
      if (S.title.trim() !== '') body.title = S.title;
      if (S.theme) body.theme = S.theme;
      return body;
    }
    var tr = S.res.title;
    if (!(tr && tr.facts && tr.facts.readOnly) && S.title.trim() !== '') body.title = S.title;
    var hr = S.res.theme;
    if (!(hr && hr.facts && hr.facts.readOnly) && S.theme) body.theme = S.theme;
    return body;
  }

  var FIELD_SCREEN = { newVault: 'newfolder', starterTitle: 'title', config: 'review' };

  function commit(withBuild, status, buttons) {
    buttons.forEach(function (b) { b.disabled = true; });
    status.textContent = '';
    A.api('/api/setup/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answersBody()) }).then(function (r) {
      if (r.ok && r.body) {
        S.result = r.body;
        S.committed = true;
        S.failure = r.body.handover === 'failed' ? 'Your campaign is registered, but the panel could not switch over: ' + (r.body.message || 'unknown problem') + ' Restart GM-Scriptorium to open it.' : null;
        S.progress = [];
        if (S.failure) {
          go('ready');
          return;
        }
        if (withBuild) {
          go('build');
        } else {
          S.built = 'skipped';
          go('ready');
        }
        return;
      }
      buttons.forEach(function (b) { b.disabled = false; });
      var body = r.body || {};
      if (r.status === 409 && body.error === 'taken') {
        status.appendChild(note('err', 'warn', [h('p', null, 'A campaign was registered while you were answering (another window or a terminal). Nothing was written. Restart GM-Scriptorium to open it.')]));
      } else if (r.status === 400 && body.error === 'invalid' && body.field) {
        var back = FIELD_SCREEN[body.field] || body.field;
        S.failure = body.rule;
        var wrote = body.field === 'newVault' && /^stopped creating the vault|was created and is left as it is/.test(body.rule);
        status.appendChild(note('err', 'warn', [h('p', null, wrote ? 'Setup stopped partway. Nothing was removed. This is what it says it made:' : 'Setup stopped before writing anything. Go back and fix the ' + (FIELD_SCREEN[body.field] && body.field !== 'config' ? LABEL[back].toLowerCase() : body.field) + ' answer.'), ruleLine(body.rule)]));
        if (SCREENS.indexOf(back) >= 0 && back !== 'review' && !wrote) {
          var a = h('div', 'a1-actions');
          a.appendChild(button('small', 'Go to ' + LABEL[back].toLowerCase(), 'arrow', function () { go(back); }));
          status.appendChild(a);
        }
      } else {
        status.appendChild(note('err', 'warn', [h('p', null, 'Setup could not finish. ' + (body.message || 'The panel answered with an unexpected error.'))]));
      }
    });
  }

  // --- add mode: the commit, the switch and the refusals -----------------------------------------

  function reloadButton() {
    return button('small primary', 'Reload', 'refresh', function () { location.reload(); });
  }

  /** One refusal, for the add commit and the switch. @returns {boolean} true when it was a refusal this handled */
  function refusalNote(status, r) {
    var body = r.body || {};
    if (r.status === 409 && body.error === 'campaign-changed') {
      var a = h('div', 'a1-actions');
      a.classList.add('su-mt8');
      a.appendChild(reloadButton());
      status.appendChild(note('err', 'warn', [(function () { var p = h('p'); p.appendChild(h('b', null, 'This tab is out of date. Reload to continue.')); return p; })(), h('p', null, 'The panel is now on ' + (body.campaign || 'another campaign') + '. Nothing was added.'), a]));
      return true;
    }
    if (r.status === 409 && body.error === 'config-changed') {
      var a2 = h('div', 'a1-actions');
      a2.classList.add('su-mt8');
      a2.appendChild(reloadButton());
      status.appendChild(note('err', 'warn', [(function () { var p = h('p'); p.appendChild(h('b', null, body.message || 'Your settings changed outside the panel. Reload and try again.')); return p; })(), h('p', null, 'Another window or a terminal changed your campaigns while you were here. Nothing was added.'), a2]));
      return true;
    }
    if (r.status === 409 && body.error === 'config-invalid') {
      status.appendChild(note('err', 'warn', [h('p', null, 'Your settings file can’t be read, so nothing was added.'), ruleLine(body.message || '')]));
      return true;
    }
    if (r.status === 409 && body.error === 'busy') {
      status.appendChild(note('err', 'warn', [h('p', null, 'The panel is busy with another task. Try again in a moment.')]));
      return true;
    }
    return false;
  }

  var CLASH_RULE = /is already registered|overlaps the (vault|output folder) of campaign/;

  function commitAdd(status, buttons) {
    buttons.forEach(function (b) { b.disabled = true; });
    status.textContent = '';
    var body = answersBody();
    body.configSha256 = S.server.configSha256;
    A.api('/api/campaigns/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      if (r.ok && r.body) {
        S.result = r.body;
        S.committed = true;
        S.failure = null;
        S.progress = [];
        go('added');
        return;
      }
      buttons.forEach(function (b) { b.disabled = false; });
      var res = r.body || {};
      if (refusalNote(status, r)) return;
      if (r.status === 400 && res.error === 'invalid' && res.field) {
        var back = FIELD_SCREEN[res.field] || res.field;
        S.failure = res.rule;
        var wrote = res.field === 'newVault' && /^stopped creating the vault|was created and is left as it is/.test(res.rule);
        if (wrote) {
          var vaultPath = S.res.newVault ? S.res.newVault.value : S.newvault;
          status.appendChild(note('err', 'warn', [h('p', null, 'Setup stopped partway. It did not add ' + S.name.trim() + ' to your campaigns, and nothing was removed. This is what it says it made:'), ruleLine(res.rule), (function () { var p = h('p'); add(p, ['To finish, start again with “I already have a vault” and pick ', code(vaultPath), '.']); return p; })()]));
        } else if (CLASH_RULE.test(res.rule || '')) {
          var ca = h('div', 'a1-actions');
          ca.classList.add('su-mt8');
          if (SCREENS.indexOf(back) >= 0 && back !== 'review') ca.appendChild(button('small', 'Go to ' + LABEL[back].toLowerCase(), 'arrow', function () { go(back); }));
          status.appendChild(note('err', 'warn', [(function () { var p = h('p'); p.appendChild(h('b', null, 'Someone registered a campaign that clashes with this one.')); p.appendChild(document.createTextNode(' It was free when you checked, but isn’t now. Nothing was added.')); return p; })(), ca, ruleLine(res.rule)]));
        } else {
          status.appendChild(note('err', 'warn', [h('p', null, 'Nothing was added. Go back and fix the ' + (FIELD_SCREEN[res.field] && res.field !== 'config' ? LABEL[back].toLowerCase() : res.field) + ' answer.'), ruleLine(res.rule)]));
          if (SCREENS.indexOf(back) >= 0 && back !== 'review') {
            var a = h('div', 'a1-actions');
            a.appendChild(button('small', 'Go to ' + LABEL[back].toLowerCase(), 'arrow', function () { go(back); }));
            status.appendChild(a);
          }
        }
      } else {
        status.appendChild(note('err', 'warn', [h('p', null, 'Adding could not finish. ' + (res.message || 'The panel answered with an unexpected error.'))]));
      }
    });
  }

  /** Switches the panel to the new campaign. withBuild keeps this page open and builds the first preview under it. */
  function switchTo(withBuild, status, buttons) {
    var name = S.name.trim();
    buttons.forEach(function (b) { b.disabled = true; });
    status.textContent = '';
    A.api('/api/campaigns/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) }).then(function (r) {
      if (r.ok && r.body && r.body.switched === true) {
        S.switched = true;
        if (withBuild) {
          // This page's own switch: point it at the campaign it is now on (app.js refuses a stale page).
          A.adopt(name);
          S.built = null;
          go('build');
        } else {
          location.assign('/#/overview');
        }
        return;
      }
      buttons.forEach(function (b) { b.disabled = false; });
      var body = r.body || {};
      if (refusalNote(status, r)) return;
      var retry = h('div', 'a1-actions');
      retry.classList.add('su-mt8');
      retry.appendChild(button('small', 'Try again', 'refresh', function () { switchTo(withBuild, status, buttons); }));
      status.appendChild(note('err', 'warn', [(function () { var p = h('p'); p.appendChild(h('b', null, 'Couldn’t switch.')); p.appendChild(document.createTextNode(' The panel stayed on ' + (S.server.campaign || 'its campaign') + '. ' + name + ' is still added.')); return p; })(), retry, ruleLine(body.message || 'The panel could not switch campaigns.')]));
    });
  }

  /** The screen after a successful add: switch to it, switch and build its first preview, or stay. */
  function screenAdded() {
    var name = S.name.trim();
    var current = S.server.campaign || 'the current campaign';
    var res = S.result || {};
    var wrap = h('div', 'su-ready');
    wrap.appendChild(h('div', 'a1-eyebrow', 'Added'));
    var h1 = h('h1', null, name + ' is added');
    h1.tabIndex = -1;
    wrap.appendChild(h1);
    var lede = h('p', 'a1-lede');
    var dflt = S.server.defaultCampaign;
    add(lede, [h('b', null, name), ' is in your campaigns now. The panel is still on ', h('b', null, current), res.isDefault ? '. ' + name + ' is now your default campaign, because none was set.' : dflt ? '. Your default is still ' + dflt + '.' : '.']);
    wrap.appendChild(lede);
    var locked = res.switchable === false;
    if (locked) {
      var reason = res.lockedReason || S.server.lockedReason || '';
      wrap.appendChild(note('', 'lock', [(function () { var p = h('p'); p.appendChild(h('b', null, 'Switching is off in this panel.')); p.appendChild(document.createTextNode(' ' + reason + ' ' + name + ' is in your list for next time.')); return p; })()]));
    }
    var status = h('div');
    status.id = 'su-switch-st';
    status.setAttribute('aria-live', 'polite');
    var acts = h('div', 'a1-actions am-acts');
    var buildBtn = button('primary big', 'Switch and build its first preview', 'play', function () { switchTo(true, status, [buildBtn, plainBtn]); });
    var plainBtn = button('big', 'Switch to ' + name, 'swap', function () { switchTo(false, status, [buildBtn, plainBtn]); });
    var stayBtn = button('ghost big', 'Stay on ' + current, null, function () { location.assign('/#/campaigns'); });
    if (locked) {
      buildBtn.disabled = true;
      plainBtn.disabled = true;
      buildBtn.setAttribute('aria-disabled', 'true');
      plainBtn.setAttribute('aria-disabled', 'true');
    }
    acts.appendChild(buildBtn);
    acts.appendChild(plainBtn);
    acts.appendChild(stayBtn);
    wrap.appendChild(status);
    wrap.appendChild(acts);
    wrap.appendChild(h('p', 'a1-fine', 'Switching changes what this tab shows. It doesn’t change your default.'));
    return wrap;
  }

  function secs(ms) {
    return (Math.round(ms / 100) / 10).toFixed(1) + ' s';
  }

  function progLine(kind, title, detail, ms) {
    var li = h('li', kind);
    if (kind === 'run') {
      var sp = h('span', 'spin');
      sp.setAttribute('aria-hidden', 'true');
      li.appendChild(sp);
    } else if (kind === 'ok') li.appendChild(icon('tick'));
    else if (kind === 'bad') li.appendChild(icon('x'));
    else li.appendChild(icon('more'));
    li.appendChild(h('b', null, title));
    li.appendChild(h('span', 't', ms === undefined ? '' : secs(ms)));
    if (detail) {
      var d = h('span', 'd');
      if (typeof detail === 'string') setText(d, detail);
      else d.appendChild(detail);
      li.appendChild(d);
    }
    return li;
  }

  function counts(envelope) {
    var f = (envelope && envelope.findings) || [];
    var n = { error: 0, warning: 0, info: 0 };
    f.forEach(function (x) { if (n[x.severity] !== undefined) n[x.severity]++; });
    return n.error + ' errors · ' + n.warning + ' warnings · ' + n.info + ' info';
  }

  function firstLine(text) {
    return String(text || '').split('\n')[0];
  }

  function progressList(lines, running) {
    var ul = h('ul', 'su-prog');
    var res = S.result || { created: [] };
    if (S.way === 'new' && res.vaultRoot) {
      var vd = h('span');
      add(vd, ['The gm-apprentice starter, a welcome page and ', code('NOTICE.txt'), ', in ', code(res.vaultRoot), res.vaultAncestors && res.vaultAncestors.length ? ' (and the folders above it)' : '']);
      ul.appendChild(progLine('ok', 'Created the new vault', vd, res.ms && res.ms.vault));
    }
    ul.appendChild(progLine('ok', res.created.length === 0 ? 'Nothing new to create' : 'Created ' + res.created.length + ' item' + (res.created.length === 1 ? '' : 's'), res.created.length ? code(res.created.join(', ') + ' in ' + joinPath(['_meta', 'scriptorium'])) : 'Every pack file already existed', res.ms && res.ms.pack));
    if (ADD) {
      ul.appendChild(progLine('ok', 'Added ' + S.name.trim(), res.isDefault ? 'Your default campaign' : S.server.defaultCampaign ? 'Your default stays ' + S.server.defaultCampaign : 'In your config', res.ms && res.ms.register));
      if (S.switched) ul.appendChild(progLine('ok', 'Switched the panel to ' + S.name.trim(), 'This tab now works on ' + S.name.trim()));
    } else {
      ul.appendChild(progLine('ok', 'Registered ' + S.name.trim(), res.isDefault ? 'Your default campaign' : 'In your config', res.ms && res.ms.register));
    }
    lines.forEach(function (l) { ul.appendChild(l); });
    if (running) ul.appendChild(progLine('run', running[0], running[1]));
    return ul;
  }

  function screenBuild() {
    var wrap = h('div', 'su-page');
    var head = h('header');
    head.appendChild(h('div', 'a1-eyebrow', (ADD ? 'Adding ' : 'Setting up ') + S.name.trim()));
    var h1 = h('h1', 'a1-h2', ADD ? 'Building its first preview' : 'Building your first preview');
    h1.tabIndex = -1;
    head.appendChild(h1);
    head.appendChild(h('p', 'a1-lede', 'Under a minute. You can leave this page open.'));
    wrap.appendChild(head);
    var host = h('div');
    host.setAttribute('aria-live', 'polite');
    wrap.appendChild(host);
    var lines = [];
    var draw = function (running) {
      host.textContent = '';
      host.appendChild(progressList(lines, running));
    };
    draw(['Checking your vault…', 'Reading every page against the leak rules.']);
    var t0 = performance.now();
    var t1 = 0;
    A.api('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (c) {
      var cb = c.body || {};
      if (c.ok && cb.envelope && cb.exitCode === 0) lines.push(progLine('ok', 'Check: clean', counts(cb.envelope), performance.now() - t0));
      else if (c.ok && cb.envelope) lines.push(progLine('bad', 'Check found problems', counts(cb.envelope), performance.now() - t0));
      else lines.push(progLine('bad', 'Check could not run', firstLine(cb.error || cb.human || 'The panel did not answer.')));
      S.checkExit = c.ok ? cb.exitCode : 1;
      t1 = performance.now();
      draw(['Building preview…', 'Into the panel’s own preview folder. Your output folder is filled the first time you build the site.']);
      return A.api('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }).then(function (p) {
      var pb = p.body || {};
      if (p.ok && pb.exitCode === 0) {
        lines.push(progLine('ok', 'Preview built', 'In the panel’s own preview folder', performance.now() - t1));
        S.built = 'ok';
      } else {
        lines.push(progLine('bad', 'Preview refused', firstLine(pb.human || pb.error || 'The build did not finish.'), performance.now() - t1));
        S.built = 'refused';
      }
      S.progress = lines;
      draw(null);
      setTimeout(function () { go('ready'); }, 600);
    });
    return wrap;
  }

  /** "Start writing in your vault": three plain steps, because the panel cannot open an editor. */
  function readyNext() {
    var root2 = (S.result && S.result.vaultRoot) || vaultValue();
    var sec = h('section', 'su-next');
    sec.setAttribute('aria-labelledby', 'su-next-h');
    var h2 = h('h2', 'a1-rule', 'Start writing in your vault');
    h2.id = 'su-next-h';
    sec.appendChild(h2);
    var ol = h('ol');
    var item = function (ico, kids) {
      var li = h('li');
      li.appendChild(icon(ico));
      var d = h('div');
      add(d, kids);
      li.appendChild(d);
      ol.appendChild(li);
      return d;
    };
    var d1 = item('folder', ['Open ', code(root2), ' in Obsidian, or any editor. ', h('span', null, 'The panel can’t open it for you.')]);
    var a = h('div', 'a1-actions');
    a.classList.add('su-mt8');
    var copy = button('small', 'Copy folder path', null, function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(root2).then(function () { setText(copy, 'Copied'); }, function () {});
    });
    a.appendChild(copy);
    d1.appendChild(a);
    item('pencil', ['Edit ', code(joinPath(['_Campaign', 'Welcome.md'])), '. ', (function () { var sp = h('span'); add(sp, ['Your next steps are in it, under ', code('## GM Notes'), ', which players never see.']); return sp; })()]);
    item('publish', ['Add sessions, characters and places. ', (function () { var sp = h('span'); add(sp, ['When a page is ready for players, tick it in ', code(joinPath(['_meta', 'publish-manifest.md'])), ' and build again.']); return sp; })()]);
    sec.appendChild(ol);
    return sec;
  }

  function screenReady() {
    var wrap = h('div', 'su-ready');
    var name = S.name.trim();
    var ok = S.built === 'ok';
    wrap.appendChild(h('div', 'a1-eyebrow', ADD ? 'Added' : 'Setup complete'));
    var h2 = h('h1', null, ADD ? (ok ? 'Its first preview is ready' : 'Added, but the preview didn’t build') : S.failure ? 'Registered, with a problem' : ok ? 'Your first preview is ready' : S.built === 'skipped' ? 'Your campaign is set up' : 'Your campaign is set up, but the preview didn’t build');
    h2.tabIndex = -1;
    wrap.appendChild(h2);
    var lede = h('p', 'a1-lede');
    if (S.failure) setText(lede, S.failure);
    else if (ADD && ok) add(lede, [h('b', null, name), ' is added and checked, and a preview of the player site is built. Only you can see it' + (isRemoteAdd() ? '.' : ', on this computer.')]);
    else if (ADD) add(lede, [h('b', null, name), ' is added, but the check or the preview reported problems. The panel shows them in full.']);
    else if (ok) add(lede, [h('b', null, name), ' is registered and checked, and a preview of the player site is built. Only you can see it, on this computer.']);
    else if (S.built === 'skipped') add(lede, [h('b', null, name), ' is registered. Run a check and a preview from the panel whenever you like.']);
    else add(lede, [h('b', null, name), ' is registered, but the check or the preview reported problems. The panel shows them in full.']);
    wrap.appendChild(lede);
    if (S.built !== 'skipped' && !S.failure) wrap.appendChild(progressList(S.progress, null));
    var acts = h('div', 'a1-actions');
    if (ok) {
      var open = h('a', 'a1-btn primary big');
      open.href = '/open-preview';
      open.target = '_blank';
      open.rel = 'noopener';
      open.appendChild(icon('ext'));
      open.appendChild(document.createTextNode('Open my preview'));
      acts.appendChild(open);
    }
    if (!S.failure) {
      var panel = button(ok ? 'big' : 'primary big', 'Go to my panel', 'arrow', function () { location.assign(ADD ? '/#/overview' : '/'); });
      acts.appendChild(panel);
    }
    if (S.way === 'new' && !S.failure && ok) wrap.appendChild(note('', 'info', [(function () { var pp = h('p'); pp.appendChild(h('b', null, 'Your new campaign has just a welcome page so far.')); pp.appendChild(document.createTextNode(' The preview shows the landing page with your title, and that one page.')); return pp; })()]));
    wrap.appendChild(acts);
    if (ADD && ok) {
      // ADR 0052, section 6: the welcome reads loopback-only state, so a remote browser is not promised it.
      if (isRemoteAdd()) wrap.appendChild(note('', 'info', [(function () { var pw = h('p'); pw.appendChild(h('b', null, 'The welcome shows in a browser on the PC.')); pw.appendChild(document.createTextNode(' Open the panel there the first time and it appears on ' + name + '’s Overview.')); return pw; })()]));
      else wrap.appendChild(h('p', 'a1-fine', 'Go to my panel opens ' + name + '’s Overview, with a short welcome the first time.'));
    }
    if (S.way === 'new' && !S.failure) {
      wrap.appendChild(readyNext());
      var gitLine = h('p', 'a1-fine');
      add(gitLine, ['Setup doesn’t run git for you. Run ', code('git init'), ' in the new vault afterwards, or point setup at an empty folder you’ve already made a git repo.']);
      wrap.appendChild(gitLine);
      return wrap;
    }
    var fine = h('p', 'a1-fine');
    var made = S.result && S.result.created ? S.result.created.length : 0;
    var words = ['nothing new', 'one new item', 'two new items', 'three new items', 'four new items'];
    add(fine, ['Commit your vault now: setup added ' + (words[made] || made + ' new items') + ' under ', code(joinPath(['_meta', 'scriptorium'])), '.']);
    wrap.appendChild(fine);
    return wrap;
  }

  // --- render ----------------------------------------------------------------------------------

  var BUILDERS = { start: screenStart, name: screenName, vault: screenVault, newfolder: screenNewFolder, output: screenOutput, title: screenTitle, system: screenSystem, theme: screenTheme, review: screenReview, added: screenAdded, build: screenBuild, ready: screenReady };

  function guard(cur) {
    // A deep link to a later screen without the earlier answers goes back to the first gap.
    if (cur === 'added' && !ADD) return 'start';
    if (cur === 'start' && !(ADD && S.committed)) return cur;
    // Add mode: once the campaign is added, the form is over; Back from the next screens lands here.
    if (ADD && S.committed && cur !== 'build' && cur !== 'ready') return 'added';
    if (cur === 'added' || cur === 'build' || cur === 'ready') return S.committed ? cur : 'start';
    // Each earlier screen that must hold a good answer before this one opens; the first gap wins.
    var ok = {
      name: S.res.name && S.res.name.state === 'ok',
      vault: S.res.vault && (S.res.vault.state === 'ok' || S.res.vault.state === 'warn'),
      newfolder: S.res.newVault && (S.res.newVault.state === 'ok' || S.res.newVault.state === 'warn'),
      output: S.res.output && (S.res.output.state === 'ok' || (S.res.output.state === 'warn' && S.outputConfirmed))
    };
    var o = order();
    var upto = o.indexOf(cur);
    if (upto < 0) return o.indexOf('name') >= 0 && !ok.name ? 'name' : 'start';
    var gaps = o.slice(0, upto).filter(function (k) { return ok[k] !== undefined && !ok[k]; });
    // title and the theme only need the screens that come before them to be good.
    return gaps.length ? gaps[0] : cur;
  }

  function render() {
    if (!S.server) return;
    if (!ADD && !S.server.active && !S.committed) {
      location.replace('/');
      return;
    }
    var want = currentScreen();
    var cur = guard(want);
    if (cur !== want) {
      location.replace('#' + cur);
      return;
    }
    root.textContent = '';
    var app = h('div', 'su');
    app.setAttribute('data-role', 'app');
    app.appendChild(topBar(cur));
    var layout = h('div', 'a1-layout');
    layout.appendChild(sidebar(cur));
    var body = h('div', 'a1-body');
    var main = h('main');
    main.setAttribute('data-role', 'main');
    if (ADD && !S.committed) main.appendChild(backLink());
    main.appendChild(BUILDERS[cur]());
    body.appendChild(main);
    layout.appendChild(body);
    app.appendChild(layout);
    root.appendChild(app);
    document.title = 'GM-Scriptorium setup';
    var h1 = main.querySelector('h1');
    if (h1) h1.focus();
    else {
      // Question screens whose heading arrives with the server's answer take focus then.
      var obs = new MutationObserver(function () {
        var late = main.querySelector('h1');
        if (late) {
          obs.disconnect();
          late.tabIndex = -1;
          late.focus();
        }
      });
      obs.observe(main, { childList: true, subtree: true });
    }
  }

  /** A tab the panel has moved on from (another tab switched): say so, and stop everything but Reload. */
  function showStale() {
    var s = A.stale();
    var main = root && root.querySelector('[data-role="main"]');
    if (!s || !main || main.querySelector('.cs-stale')) return;
    var banner = h('div', 'cs-stale');
    banner.setAttribute('role', 'alert');
    banner.appendChild(icon('warn'));
    var p = h('p');
    p.appendChild(h('b', null, 'This tab is out of date. Reload to continue.'));
    p.appendChild(document.createTextNode(' The panel is now on ' + (s.now || 'another campaign') + '.'));
    banner.appendChild(p);
    var reload = button('primary small', 'Reload', 'refresh', function () { location.reload(); });
    banner.appendChild(reload);
    main.insertBefore(banner, main.firstChild);
    Array.prototype.forEach.call(main.querySelectorAll('button.a1-btn'), function (b) {
      if (b !== reload) b.disabled = true;
    });
  }

  function boot() {
    if (!root) return;
    if (ADD) {
      // The campaign this page was loaded for is learned first (/api/session), so that every change
      // request after it, the folder picker's create included, names it (ADR 0050, section 4).
      A.api('/api/session').then(function () {
        return A.api('/api/campaigns/add/state');
      }).then(function (r) {
        if (!r.ok || !r.body) {
          root.textContent = '';
          var msg = r.body && r.body.message ? r.body.message : 'The panel did not answer. Is GM-Scriptorium still running?';
          var box = h('div', 'su');
          box.appendChild(note('err', 'warn', [h('p', null, 'Adding a campaign is not possible right now.'), ruleLine(msg)]));
          root.appendChild(box);
          return;
        }
        S.server = r.body;
        document.addEventListener('scriptorium:stale', showStale);
        window.addEventListener('hashchange', render);
        render();
      });
      return;
    }
    A.api('/api/setup/state').then(function (r) {
      if (!r.ok || !r.body) {
        root.textContent = 'The panel did not answer. Is GM-Scriptorium still running?';
        return;
      }
      S.server = r.body;
      window.addEventListener('hashchange', render);
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
