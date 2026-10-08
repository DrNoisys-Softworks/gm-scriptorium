'use strict';

/*
 * ADR 0028: browser setup. The page loads app.js (api, el, setText), icons.js and this file only.
 * Everything the GM types is checked on the SERVER (GET /api/setup/check, the same functions
 * `init` uses); this file never decides validity, it only draws the answer and the shared rule
 * line under it. DOM is built with el()/setText() (textContent) only, never markup. The admin CSP
 * has form-action 'none', so every submit is preventDefault()ed. Screens are reached by hash
 * (#name, #vault, ...); the focus lands on each screen's h1; status regions are aria-live.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var el = A.el;
  var setText = A.setText;
  var icon = A.icon;

  var ORDER = ['name', 'vault', 'output', 'title', 'theme', 'review'];
  var LABEL = { name: 'Campaign name', vault: 'Vault folder', output: 'Output folder', title: 'Site title', theme: 'Theme', review: 'Review' };
  var QN = { name: 1, vault: 2, output: 3, title: 4, theme: 5 };
  var SCREENS = ['start'].concat(ORDER).concat(['build', 'ready']);
  var DEBOUNCE_MS = 300;
  var THEME_COPY = {
    plain: { scheme: 'light', text: 'No theme CSS. Your campaign’s own palette and overrides.css carry the look.' },
    haze: { scheme: 'dark', text: 'Smoky dark ground, brass headings, recaps on a parchment slip, IM Fell type.' },
    gloam: { scheme: 'dark', text: 'The default for a new campaign: a dark base with its own palette, ready to use as it is.' }
  };

  var S = {
    server: null,
    name: '', vault: '', output: '', outputTouched: false, outputConfirmed: false, title: '', theme: null,
    res: {}, // latest server answer per field
    committed: false, built: null, result: null, failure: null, progress: []
  };

  var root = document.querySelector('[data-role="setup-root"]');
  var seq = { name: 0, vault: 0, output: 0, title: 0, theme: 0 };
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
  function packDir() {
    return joinPath([S.vault, '_meta', 'scriptorium']);
  }

  // --- server calls -------------------------------------------------------------------------

  function checkUrl(field, value, commit) {
    var q = new URLSearchParams();
    q.set('field', field);
    if (value !== undefined && value !== null) q.set('value', value);
    q.set('commit', commit ? '1' : '0');
    q.set('name', S.name.trim());
    if (field === 'output' || field === 'title' || field === 'theme') q.set('vault', S.res.vault ? S.res.vault.value : S.vault);
    return '/api/setup/check?' + q.toString();
  }

  /** Asks the server; only the newest answer for a field is kept. @returns {Promise<object|null>} */
  function ask(field, value, commit) {
    var mine = ++seq[field];
    return A.api(checkUrl(field, value, commit)).then(function (r) {
      if (mine !== seq[field]) return null;
      if (!r.ok || !r.body) {
        S.res[field] = { field: field, state: 'unreachable', value: value, rule: 'The panel did not answer. Is GM-Scriptorium still running?', facts: { reason: 'panel' } };
      } else {
        S.res[field] = r.body;
      }
      return S.res[field];
    });
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
    var i = ORDER.indexOf(k);
    var c = cur === 'build' || cur === 'ready' ? ORDER.length : ORDER.indexOf(cur);
    if (cur === 'start') c = -1;
    return i < c ? 'done' : i === c ? 'cur' : 'todo';
  }
  function railValue(k) {
    if (k === 'name') return S.name.trim();
    if (k === 'vault') return S.res.vault ? S.res.vault.value : S.vault;
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
    side.appendChild(brand());
    var group = h('div', 'a1-ng');
    group.appendChild(h('div', 'a1-ng-label', 'Setup'));
    var list = h('ol', 'su-rail');
    var busy = cur === 'build' || cur === 'ready';
    ORDER.forEach(function (k) {
      var st = stepState(k, cur);
      var warn = st === 'done' && k === 'vault' && S.res.vault && S.res.vault.state === 'warn';
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
    var bound = h('span');
    bound.appendChild(icon('lock'));
    add(bound, [' Bound to ', code('127.0.0.1'), ' only']);
    foot.appendChild(bound);
    foot.appendChild(h('span', null, 'Files are written at the review. New folder makes its folder at once.'));
    side.appendChild(foot);
    return side;
  }

  function topBar(cur) {
    var qn = QN[cur];
    var label = cur === 'start' ? 'Getting started' : qn ? 'Question ' + qn + ' of 5' : cur === 'review' ? 'Review' : cur === 'build' ? 'Setting up' : 'Done';
    var pct = cur === 'start' ? 3 : qn ? qn * 16 : cur === 'review' ? 92 : 100;
    var mt = h('header', 'su-mt');
    var crest = h('div', 'a1-crest');
    crest.setAttribute('aria-hidden', 'true');
    crest.appendChild(h('span', null, 'GM'));
    mt.appendChild(crest);
    var grow = h('div', 'grow');
    var camp = h('div', 'a1-camp', 'GM-Scriptorium setup');
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

  function qHead(n, title, lede) {
    var head = h('header');
    head.appendChild(h('div', 'a1-eyebrow', 'Question ' + n + ' of 5'));
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

  function screenStart() {
    var wrap = h('div', 'su-page');
    var head = h('header', 'su-intro');
    head.appendChild(h('div', 'a1-eyebrow', 'Welcome to GM-Scriptorium'));
    var h1 = h('h1', 'a1-h2', 'Let’s set up your first campaign');
    h1.tabIndex = -1;
    head.appendChild(h1);
    var lede = h('p', 'a1-lede');
    add(lede, ['Five questions. They are the ones ', code('gm-scriptorium init'), ' asks in a terminal. Nothing in your vault changes until the last screen, and even then setup only adds new files under ', code(joinPath(['_meta', 'scriptorium'])), '.']);
    head.appendChild(lede);
    wrap.appendChild(head);
    var need = h('div', 'su-need');
    [['folder', 'Your vault folder', ['The gm-apprentice vault that holds ', code(joinPath(['_meta', 'vault-config.md'])), '.']],
      ['globe', 'A folder for the site', ['Outside the vault. We suggest one next to it.']],
      ['info', 'About two minutes', ['Then a first preview that only you can see.']]].forEach(function (c) {
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
    add(g, ['Prefer a terminal? Close this and run ', code('gm-scriptorium init'), '.']);
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
    } else {
      var kids = [h('p', null, ''), null];
      kids[0].appendChild(h('b', null, 'Use lowercase letters, digits and hyphens only.'));
      kids[0].appendChild(document.createTextNode(' Spaces and capitals belong in the site title, question 4.'));
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
    wrap.appendChild(qHead(1, 'What should we call this campaign?', 'A short name for commands and folder names. Lowercase letters, digits and hyphens. The title your players see comes later.'));
    var input = textInput('su-name', S.name, true);
    var fb = fieldBlock('su-name', 'Campaign name', input, 'su-name-st');
    wrap.appendChild(fb.field);
    wrap.appendChild(foot('start', 'Continue', function () { go('vault'); }));
    input.addEventListener('input', function () { onName(input); });
    nameStatusDraw(fb.status, input, S.res.name && S.name.trim() !== '' ? S.res.name : null);
    setTimeout(function () {
      setNext(Boolean(S.res.name && S.res.name.state === 'ok' && S.name.trim() !== ''));
    }, 0);
    return wrap;
  }

  function vaultDraw(status, input, r, extraBtn) {
    status.textContent = '';
    markInput(input, r ? r.state : null);
    if (!r) return;
    var f = r.facts || {};
    if (r.state === 'deferred') {
      status.appendChild(h('p', 'a1-hint', 'This looks like a network path. It is checked when you leave the box, so nothing is probed while you type.'));
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
      if (f.candidate) {
        var a2 = h('div', 'a1-actions');
        a2.classList.add('su-mt8');
        a2.appendChild(button('small', 'Use ' + f.candidate, null, function () {
          input.value = f.candidate;
          input.focus();
          onVault(input, false);
        }));
        kids[1] = a2;
      }
      kids.push(ruleLine(r.rule));
      extra.push(note('err', 'warn', kids));
    } else {
      rows = [['bad', 'Folder not found', code(r.value)], ['na', 'A gm-apprentice vault', 'Checked once the folder is found'], ['na', 'Where it lives', '']];
      var a3 = h('div', 'a1-actions');
      a3.classList.add('su-mt8');
      a3.appendChild(extraBtn());
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
    wrap.appendChild(qHead(2, 'Where is your campaign vault?', ['The folder that holds ', code(joinPath(['_meta', 'vault-config.md'])), '. It stays where it is. GM-Scriptorium reads it, and at the end of setup adds one small folder inside ', code('_meta'), '.']));
    var input = textInput('su-vault', S.vault, true);
    var fb = fieldBlock('su-vault', 'Vault folder', input, 'su-vault-st');
    wrap.appendChild(fb.field);
    // ADR 0049: Browse only fills the field; the field's own server check then runs as always.
    A.picker.attach(input, { row: fb.row, host: fb.status, label: 'the vault folder', allowCreate: false, onChoose: function () { onVault(input, true); } });
    wrap.appendChild(foot('name', 'Continue', function () {
      // A network path is only probed when the GM commits the field.
      if (S.res.vault && S.res.vault.state === 'deferred') onVault(input, true);
      else go('output');
    }));
    input.addEventListener('input', function () { onVault(input, false); });
    // Leaving the box commits the field: a network path is probed now (never per keystroke).
    input.addEventListener('blur', function () {
      if (input.value.trim() !== '' && document.body.contains(input)) onVault(input, true);
    });
    var recheck = function () { return button('small', 'Check again', 'refresh', function () { onVault(input, true); }); };
    if (S.res.vault && S.vault.trim() !== '') vaultDraw(fb.status, input, S.res.vault, recheck);
    setTimeout(function () {
      var r = S.res.vault;
      setNext(Boolean(r && (r.state === 'ok' || r.state === 'warn')), r && r.state === 'warn' ? 'Continue works; the warning stays on the review.' : '');
      if (r && r.state === 'deferred') setNext(true);
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
      status.appendChild(h('p', 'a1-hint', 'This looks like a network path. It is checked when you leave the box.'));
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
    wrap.appendChild(qHead(3, 'Where should the built site go?', 'Each build writes the player website here. It has to be outside your vault, so the site never ends up in your notes.'));
    var input = textInput('su-out', S.output, true);
    var fb = fieldBlock('su-out', 'Output folder', input, 'su-out-st');
    wrap.appendChild(fb.field);
    A.picker.attach(input, { row: fb.row, host: fb.status, label: 'the output folder', allowCreate: true, onChoose: function () { S.outputConfirmed = false; onOutput(input, true); } });
    var hint = h('p', 'a1-hint', 'Suggested: next to your vault, named after the campaign.');
    hint.id = 'su-out-hint';
    fb.field.insertBefore(hint, fb.status);
    wrap.appendChild(foot('vault', 'Continue', function () {
      if (S.res.output && S.res.output.state === 'deferred') onOutput(input, true);
      else go('title');
    }));
    input.addEventListener('input', function () { S.outputConfirmed = false; onOutput(input, false); });
    input.addEventListener('blur', function () {
      if (input.value.trim() !== '' && document.body.contains(input)) onOutput(input, true);
    });
    // The default comes from the server: ask once with an empty value, then fill the box.
    var seed = S.output === '' && !S.outputTouched;
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

  function screenTitle() {
    var wrap = h('div', 'su-q');
    wrap.appendChild(h('div'));
    var body = h('div', 'su-q');
    wrap.appendChild(body);
    ask('title', undefined, false).then(function (r0) {
      if (!r0) return;
      var f = r0.facts || {};
      wrap.removeChild(wrap.firstChild);
      if (f.readOnly) {
        wrap.insertBefore(qHead(4, 'What’s the site called?', 'Players see this at the top of every page.'), body);
        var ro = h('div', 'su-ro');
        ro.appendChild(h('span', 'su-lab', 'Already set in your campaign pack'));
        ro.appendChild(h('span', 'v', r0.value === null ? '(not set)' : r0.value));
        var hint = h('p', 'a1-hint');
        add(hint, ['From ', code(joinPath(['_meta', 'scriptorium', 'vault.config.json'])), '. Setup never edits a pack file that already exists. Change the title later under Title & tagline.']);
        ro.appendChild(hint);
        body.appendChild(ro);
        body.appendChild(foot('output', 'Continue', function () { go('theme'); }));
        setNext(true);
        return;
      }
      wrap.insertBefore(qHead(4, 'What’s the site called?', 'Players see this at the top of every page. Anything on one line.'), body);
      if (S.title === '' && f.default) S.title = f.default;
      var input = textInput('su-title', S.title, false);
      var fb = fieldBlock('su-title', 'Site title', input, 'su-title-st');
      var hint2 = h('p', 'a1-hint');
      add(hint2, ['Filled in from ', code('campaign:'), ' in ', code(joinPath(['_meta', 'vault-config.md'])), ' when it has one.']);
      fb.field.insertBefore(hint2, fb.status);
      body.appendChild(fb.field);
      body.appendChild(foot('output', 'Continue', function () { go('theme'); }));
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
      body.appendChild(qHead(5, 'Pick a look for the player site', 'Sketches of your landing page in each theme, using your title. You can switch any time under Theme.'));
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
      body.appendChild(foot('title', 'Continue', function () { go('review'); }));
      setNext(r0.state === 'ok');
    });
    return wrap;
  }

  function reviewRows() {
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

  function screenReview() {
    var wrap = h('div', 'su-page');
    var head = h('header');
    head.appendChild(h('div', 'a1-eyebrow', 'Last step'));
    var h1 = h('h1', 'a1-h2', 'Check your answers');
    h1.tabIndex = -1;
    head.appendChild(h1);
    head.appendChild(h('p', 'a1-lede', 'Setup writes your campaign’s files when you press a button below. A folder you made with New folder is already on your disk.'));
    wrap.appendChild(head);

    var slip = h('section', 'a1-slip inline');
    slip.setAttribute('aria-labelledby', 'su-rv');
    var seal = h('div', 'a1-seal', 'S');
    seal.setAttribute('aria-hidden', 'true');
    slip.appendChild(seal);
    slip.appendChild(h('div', 'cf-eyebrow', 'Review before setting up'));
    var title = h('h2', 'cf-title', 'Set up ' + S.name.trim());
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
    var packExists = S.res.vault && S.res.vault.facts && S.res.vault.facts.packExists;
    var ol = h('ol', 'su-do');
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
    add(li2, ['Register ', h('b', null, S.name.trim()), ' as your default campaign, in ', code(S.server.configPath), '.']);
    ol.appendChild(li2);
    ol.appendChild(h('li', null, 'Run a first check, then build a preview that only you can see.'));
    footer.appendChild(ol);
    if (S.res.vault && S.res.vault.facts && S.res.vault.facts.unc) {
      var cn = h('p', 'cf-note');
      cn.appendChild(h('b', null, 'Network share:'));
      cn.appendChild(document.createTextNode(' commit your vault first if you haven’t. The panel never commits for you.'));
      footer.appendChild(cn);
    }
    var status = h('div');
    status.id = 'su-commit-st';
    status.setAttribute('aria-live', 'polite');
    footer.appendChild(status);
    var btns = h('div', 'cf-btns');
    var nobuild = button('', 'Set up without building', null, function () { commit(false, status, [nobuild, buildBtn]); });
    var buildBtn = button('primary', 'Build my first preview', 'play', function () { commit(true, status, [nobuild, buildBtn]); });
    btns.appendChild(nobuild);
    btns.appendChild(buildBtn);
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
      vault: S.res.vault ? S.res.vault.value : S.vault,
      output: S.res.output ? S.res.output.value : S.output,
      outputConfirmed: S.outputConfirmed === true
    };
    var tr = S.res.title;
    if (!(tr && tr.facts && tr.facts.readOnly) && S.title.trim() !== '') body.title = S.title;
    var hr = S.res.theme;
    if (!(hr && hr.facts && hr.facts.readOnly) && S.theme) body.theme = S.theme;
    return body;
  }

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
        var back = body.field === 'config' ? 'review' : body.field;
        S.failure = body.rule;
        status.appendChild(note('err', 'warn', [h('p', null, 'Setup stopped before writing anything. Go back and fix the ' + body.field + ' answer.'), ruleLine(body.rule)]));
        if (SCREENS.indexOf(back) >= 0 && back !== 'review') {
          var a = h('div', 'a1-actions');
          a.appendChild(button('small', 'Go to ' + LABEL[back].toLowerCase(), 'arrow', function () { go(back); }));
          status.appendChild(a);
        }
      } else {
        status.appendChild(note('err', 'warn', [h('p', null, 'Setup could not finish. ' + (body.message || 'The panel answered with an unexpected error.'))]));
      }
    });
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
    ul.appendChild(progLine('ok', res.created.length === 0 ? 'Nothing new to create' : 'Created ' + res.created.length + ' item' + (res.created.length === 1 ? '' : 's'), res.created.length ? code(res.created.join(', ') + ' in ' + joinPath(['_meta', 'scriptorium'])) : 'Every pack file already existed', res.ms && res.ms.pack));
    ul.appendChild(progLine('ok', 'Registered ' + S.name.trim(), res.isDefault ? 'Your default campaign' : 'In your config', res.ms && res.ms.register));
    lines.forEach(function (l) { ul.appendChild(l); });
    if (running) ul.appendChild(progLine('run', running[0], running[1]));
    return ul;
  }

  function screenBuild() {
    var wrap = h('div', 'su-page');
    var head = h('header');
    head.appendChild(h('div', 'a1-eyebrow', 'Setting up ' + S.name.trim()));
    var h1 = h('h1', 'a1-h2', 'Building your first preview');
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

  function screenReady() {
    var wrap = h('div', 'su-ready');
    var name = S.name.trim();
    var ok = S.built === 'ok';
    wrap.appendChild(h('div', 'a1-eyebrow', 'Setup complete'));
    var h2 = h('h1', null, S.failure ? 'Registered, with a problem' : ok ? 'Your first preview is ready' : S.built === 'skipped' ? 'Your campaign is set up' : 'Your campaign is set up, but the preview didn’t build');
    h2.tabIndex = -1;
    wrap.appendChild(h2);
    var lede = h('p', 'a1-lede');
    if (S.failure) setText(lede, S.failure);
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
      var panel = button(ok ? 'big' : 'primary big', 'Go to my panel', 'arrow', function () { location.assign('/'); });
      acts.appendChild(panel);
    }
    wrap.appendChild(acts);
    var fine = h('p', 'a1-fine');
    var made = S.result && S.result.created ? S.result.created.length : 0;
    var words = ['nothing new', 'one new item', 'two new items', 'three new items', 'four new items'];
    add(fine, ['Commit your vault now: setup added ' + (words[made] || made + ' new items') + ' under ', code(joinPath(['_meta', 'scriptorium'])), '.']);
    wrap.appendChild(fine);
    return wrap;
  }

  // --- render ----------------------------------------------------------------------------------

  var BUILDERS = { start: screenStart, name: screenName, vault: screenVault, output: screenOutput, title: screenTitle, theme: screenTheme, review: screenReview, build: screenBuild, ready: screenReady };

  function guard(cur) {
    // A deep link to a later screen without the earlier answers goes back to the first gap.
    if (cur === 'start') return cur;
    if (cur === 'build' || cur === 'ready') return S.committed ? cur : 'start';
    var needs = { name: [], vault: ['name'], output: ['name', 'vault'], title: ['name', 'vault', 'output'], theme: ['name', 'vault', 'output'], review: ['name', 'vault', 'output'] };
    var ok = { name: S.res.name && S.res.name.state === 'ok', vault: S.res.vault && (S.res.vault.state === 'ok' || S.res.vault.state === 'warn'), output: S.res.output && (S.res.output.state === 'ok' || (S.res.output.state === 'warn' && S.outputConfirmed)) };
    var gaps = needs[cur].filter(function (k) { return !ok[k]; });
    return gaps.length ? gaps[0] : cur;
  }

  function render() {
    if (!S.server) return;
    if (!S.server.active && !S.committed) {
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

  function boot() {
    if (!root) return;
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
