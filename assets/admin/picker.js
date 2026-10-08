'use strict';

/*
 * ADR 0049: the folder picker. An inline listbox that sits under a path field, never a modal. It is
 * a convenience for filling a text field: choosing a folder only puts its native absolute path in
 * the field and then calls the caller's own onChoose (which runs the field's existing server
 * check), so the picker never decides what is valid. Folders only: the server never names a file.
 *
 *   ScriptoriumAdmin.picker.attach(input, opts) -> { open(), close(), destroy() }
 *     opts.row          element the Browse button is appended to
 *     opts.host         element the panel is inserted after
 *     opts.label        accessible name stem, e.g. "the vault folder"
 *     opts.allowCreate  true shows New folder (the output field; a vault already exists)
 *     opts.onChoose(p)  required; called after the field holds p, the picker is closed and focus
 *                       is back on Browse
 *     opts.extra        optional { label, onSelect(path) }: a second action beside Choose
 *
 * Uses only A.api, A.el, A.setText and A.icon: no fetch, no markup strings, no inline styles.
 * Every server answer is drawn from textContent. The location box does two jobs: text that looks
 * like an absolute path waits for Enter or Go (a network path is never asked per keystroke); any
 * other text narrows the open folder, on the server.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var el = A.el;
  var setText = A.setText;
  var icon = A.icon;

  var FILTER_MS = 300;
  var counter = 0;

  function h(tag, cls, text) {
    var n = el(tag);
    if (cls) n.className = cls;
    if (text !== undefined) setText(n, text);
    return n;
  }
  function button(cls, label, ico, onClick) {
    var b = h('button', 'a1-btn ' + cls);
    b.type = 'button';
    if (ico) b.appendChild(icon(ico));
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }
  function pill(cls, text) {
    return h('span', 'a1-pill ' + cls, text);
  }
  function looksAbsolute(text) {
    return /^(\/|\\|[A-Za-z]:)/.test(text.trim());
  }
  function leaf(p) {
    var parts = String(p).split(/[\\/]/).filter(function (x) { return x !== ''; });
    return parts.length ? parts[parts.length - 1] : String(p);
  }
  function capital(s) {
    s = String(s || '');
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?]$/.test(s) ? s : s + '.';
  }
  function countText(n, more) {
    if (more) return n + '+ folders';
    return n === 0 ? 'no folders' : n === 1 ? '1 folder' : n + ' folders';
  }

  var CREATE_REFUSALS = {
    permission: 'You don’t have permission to make a folder here.',
    missing: 'That folder is no longer there.',
    'not-folder': 'That is not a folder.',
    link: 'Links can’t be used here. Pick the real folder.',
    'inside-config': 'That folder holds GM-Scriptorium’s own settings. Pick another place.',
    'inside-panel': 'That folder holds GM-Scriptorium’s own settings. Pick another place.',
    'inside-vault': 'That folder is inside a vault. Pick a place outside it.',
    'not-responding': 'That folder did not answer. Try again.',
    'checks-busy': 'The panel is busy checking something. Try again in a moment.',
    busy: 'Something else is running. Try again in a moment.'
  };
  var LIST_STATES = {
    link: 'Links can’t be opened here. Type the path into the field instead.',
    missing: 'That folder is not there.',
    'not-folder': 'That is not a folder.',
    permission: 'You don’t have permission to open this folder.',
    'not-responding': 'That folder did not answer. It may be on a drive or share that is not responding.',
    busy: 'The panel is busy checking something. Try again in a moment.'
  };

  function attach(input, opts) {
    var id = 'pk' + ++counter;
    var browse = button('pk-browse', 'Browse…', 'folder', function () { if (panel) close(true); else open(); });
    browse.setAttribute('aria-expanded', 'false');
    browse.setAttribute('aria-controls', id + '-panel');
    browse.setAttribute('aria-label', 'Browse for ' + opts.label);
    opts.row.appendChild(browse);

    var panel = null;
    var ui = {};
    var view = null; // { kind: 'roots'|'folder', path, parent, items, truncated, platform }
    var active = 0;
    var seq = 0;
    var filterTimer = null;
    var fresh = null; // name of a folder made in this open folder
    var hiddenOn = false;
    var lastClick = -1;

    function say(text) {
      setText(ui.live, text);
    }
    function note(text, bad) {
      ui.note.textContent = '';
      ui.note.hidden = !text;
      if (!text) return;
      ui.note.className = bad ? 'pk-err' : 'pk-note';
      if (bad) ui.note.appendChild(icon('warn'));
      ui.note.appendChild(h('span', null, text));
    }

    // --- building the panel ------------------------------------------------------------------

    function build() {
      var p = h('section', 'pk');
      p.id = id + '-panel';
      p.setAttribute('aria-labelledby', id + '-t');
      var head = h('div', 'pk-head');
      var title = h('h2', 'pk-title', 'Choose ' + opts.label);
      title.id = id + '-t';
      head.appendChild(title);
      ui.live = h('span', 'pk-live');
      ui.live.setAttribute('role', 'status');
      head.appendChild(ui.live);
      p.appendChild(head);

      var where = h('div', 'pk-where');
      ui.up = button('small ghost pk-up', 'Up', 'arrow', function () { goUp(); });
      ui.up.setAttribute('aria-label', 'Up to the parent folder');
      ui.path = h('span', 'pk-path');
      ui.refresh = button('small ghost', 'Refresh', 'refresh', function () { reload(true); });
      where.appendChild(ui.up);
      where.appendChild(ui.path);
      where.appendChild(ui.refresh);
      p.appendChild(where);

      var locWrap = h('div');
      var locLab = h('label', 'pk-lab', 'Location');
      locLab.setAttribute('for', id + '-loc');
      ui.loc = h('input', 'a1-in mono');
      ui.loc.type = 'text';
      ui.loc.id = id + '-loc';
      ui.loc.spellcheck = false;
      ui.loc.autocomplete = 'off';
      ui.loc.setAttribute('aria-describedby', id + '-loc-h');
      var locRow = h('div', 'pk-loc');
      locRow.appendChild(ui.loc);
      locRow.appendChild(button('small', 'Go', null, function () { submitLoc(); }));
      var locHint = h('p', 'a1-hint pk-hint', 'Type a full path and press Enter, or type part of a name to narrow the list.');
      locHint.id = id + '-loc-h';
      locWrap.appendChild(locLab);
      locWrap.appendChild(locRow);
      locWrap.appendChild(locHint);
      p.appendChild(locWrap);
      ui.loc.addEventListener('input', function () {
        clearTimeout(filterTimer);
        // A path-looking value waits for Enter or Go. Anything else is a server-side filter.
        if (looksAbsolute(ui.loc.value) || !view || view.kind !== 'folder') return;
        filterTimer = setTimeout(function () { load(view.path, false); }, FILTER_MS);
      });
      ui.loc.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitLoc();
        }
      });

      var tools = h('div', 'pk-tools');
      var lab = h('label', 'st-check');
      lab.setAttribute('for', id + '-hid');
      ui.hidden = h('input');
      ui.hidden.type = 'checkbox';
      ui.hidden.id = id + '-hid';
      ui.hidden.addEventListener('change', function () {
        hiddenOn = ui.hidden.checked;
        reload(false);
      });
      lab.appendChild(ui.hidden);
      lab.appendChild(document.createTextNode(' Show hidden folders'));
      tools.appendChild(lab);
      p.appendChild(tools);

      ui.list = h('ul', 'pk-list');
      ui.list.setAttribute('role', 'listbox');
      ui.list.setAttribute('aria-labelledby', id + '-t');
      ui.list.tabIndex = 0;
      ui.list.addEventListener('keydown', onListKey);
      p.appendChild(ui.list);
      ui.empty = h('p', 'pk-note');
      ui.empty.hidden = true;
      p.appendChild(ui.empty);
      ui.note = h('p', 'pk-note');
      ui.note.setAttribute('role', 'status');
      ui.note.hidden = true;
      p.appendChild(ui.note);

      ui.form = h('div', 'pk-new');
      ui.form.hidden = true;
      var nl = h('label', 'pk-lab', 'Name for the new folder');
      nl.setAttribute('for', id + '-nn');
      ui.nn = h('input', 'a1-in mono');
      ui.nn.type = 'text';
      ui.nn.id = id + '-nn';
      ui.nn.spellcheck = false;
      ui.nn.autocomplete = 'off';
      ui.nn.setAttribute('aria-describedby', id + '-nn-st');
      var nrow = h('div', 'pk-loc');
      nrow.appendChild(ui.nn);
      nrow.appendChild(button('primary small', 'Create folder', null, function () { create(); }));
      nrow.appendChild(button('ghost small', 'Cancel', null, function () { closeForm(true); }));
      ui.nnst = h('div');
      ui.nnst.id = id + '-nn-st';
      ui.nnst.setAttribute('aria-live', 'polite');
      ui.form.appendChild(nl);
      ui.form.appendChild(nrow);
      ui.form.appendChild(ui.nnst);
      ui.nn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          create();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeForm(true);
        }
      });
      p.appendChild(ui.form);

      var foot = h('div', 'pk-foot');
      if (opts.allowCreate) {
        ui.newBtn = button('small', 'New folder', 'plus', function () { openForm(); });
        foot.appendChild(ui.newBtn);
      }
      foot.appendChild(h('span', 'grow'));
      if (opts.extra) {
        ui.extra = button('small', opts.extra.label, null, function () {
          if (view && view.kind === 'folder') opts.extra.onSelect(view.path);
        });
        foot.appendChild(ui.extra);
      }
      ui.choose = button('primary small', 'Choose this folder', null, function () { choose(); });
      foot.appendChild(ui.choose);
      foot.appendChild(button('ghost small', 'Cancel', null, function () { close(true); }));
      p.appendChild(foot);

      p.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(true);
        }
      });
      return p;
    }

    // --- drawing a view ------------------------------------------------------------------------

    function itemsOf(data) {
      if (data.view === 'roots') {
        return data.roots
          .filter(function (r) { return r.state !== 'unchecked'; })
          .map(function (r) { return { name: r.name, path: r.path, state: r.state, root: true, home: r.name === 'Home' }; });
      }
      return data.entries.map(function (e) { return { name: e.name, path: e.path, link: e.link, hidden: e.hidden, unreadable: e.unreadable }; });
    }

    function draw(announce) {
      ui.list.textContent = '';
      lastClick = -1;
      var items = view.items;
      var isRoots = view.kind === 'roots';
      setText(ui.path, isRoots ? 'Places' : view.path);
      ui.up.disabled = isRoots;
      ui.choose.disabled = isRoots;
      if (ui.extra) ui.extra.disabled = isRoots;
      if (ui.newBtn) ui.newBtn.disabled = isRoots;
      ui.list.hidden = items.length === 0;
      ui.empty.hidden = items.length !== 0;
      setText(ui.empty, isRoots ? 'No places to show.' : 'No folders in here.');
      if (active >= items.length) active = Math.max(0, items.length - 1);
      items.forEach(function (it, i) {
        var li = h('li', 'pk-opt' + (it.link ? ' is-link' : '') + (it.hidden ? ' is-hidden' : '') + (it.unreadable || it.state === 'not-responding' ? ' is-bad' : ''));
        li.id = id + '-o' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === active ? 'true' : 'false');
        li.appendChild(icon(it.root ? (it.home ? 'home' : 'storage') : 'folder'));
        var nameBox = h('span', 'pk-name');
        nameBox.appendChild(document.createTextNode(it.name));
        if (it.link) nameBox.appendChild(document.createTextNode(' ')), nameBox.appendChild(pill('muted', 'link'));
        if (it.hidden) nameBox.appendChild(document.createTextNode(' ')), nameBox.appendChild(pill('muted', 'hidden'));
        if (it.unreadable) nameBox.appendChild(document.createTextNode(' ')), nameBox.appendChild(pill('rose', 'can’t read'));
        if (it.state === 'not-responding') {
          nameBox.appendChild(document.createTextNode(' '));
          nameBox.appendChild(pill('rose', 'not responding'));
          nameBox.appendChild(h('span', 'pk-sub', 'Did not answer. Press Refresh to try again.'));
        }
        if (!isRoots && fresh !== null && it.name === fresh) {
          nameBox.appendChild(document.createTextNode(' '));
          nameBox.appendChild(pill('sage', 'just created'));
        }
        if (it.home) nameBox.appendChild(h('span', 'pk-sub', it.path));
        li.appendChild(nameBox);
        li.addEventListener('click', function () {
          // A first click selects; a second click on the same row opens it (a tap on a phone).
          var again = lastClick === i && active === i;
          active = i;
          lastClick = i;
          mark();
          if (again) openItem(i);
        });
        li.addEventListener('dblclick', function () { openItem(i); });
        ui.list.appendChild(li);
      });
      mark();
      var skipped = '';
      if (isRoots && view.unchecked) skipped = view.unchecked;
      if (!ui.noteSticky) note(skipped, false);
      if (announce) say(announce);
    }

    function mark() {
      var opts2 = ui.list.children;
      for (var i = 0; i < opts2.length; i++) opts2[i].setAttribute('aria-selected', i === active ? 'true' : 'false');
      if (opts2[active]) {
        ui.list.setAttribute('aria-activedescendant', opts2[active].id);
        if (opts2[active].scrollIntoView) opts2[active].scrollIntoView({ block: 'nearest' });
      } else ui.list.removeAttribute('aria-activedescendant');
    }

    // --- talking to the server ------------------------------------------------------------------

    function problem(r) {
      if (r.body && r.body.message) return r.body.message;
      if (r.status === 400) return 'That path can’t be used.';
      return 'The panel did not answer. Is GM-Scriptorium still running?';
    }

    function showRoots(refresh) {
      var mine = ++seq;
      return A.api('/api/folders' + (refresh ? '?refresh=1' : '')).then(function (r) {
        if (mine !== seq) return;
        if (!r.ok || !r.body || r.body.view !== 'roots') {
          note(problem(r), true);
          return;
        }
        var b = r.body;
        var unchecked = b.roots.filter(function (x) { return x.state === 'unchecked'; });
        var stuck = b.roots.filter(function (x) { return x.state === 'not-responding'; });
        var text = '';
        if (unchecked.length) {
          var first = unchecked[0].name;
          var last = unchecked[unchecked.length - 1].name;
          text = stuck.length
            ? first + ' to ' + last + ' were not checked, because ' + stuck[stuck.length - 1].name + ' did not answer. Nothing else is held up.'
            : 'Some drives were not checked because the panel is busy. Press Refresh to try again.';
        }
        ui.noteSticky = false;
        fresh = null;
        view = { kind: 'roots', items: itemsOf(b), platform: b.platform, unchecked: text, home: b.home };
        active = 0;
        draw('Places, ' + view.items.length + ' places');
      });
    }

    /** Lists `path`. `narrow` is true when the filter box is being used by this call. */
    function load(path, resetFilter) {
      var mine = ++seq;
      var q = new URLSearchParams();
      q.set('path', path);
      var filter = resetFilter ? '' : (looksAbsolute(ui.loc.value) ? '' : ui.loc.value.trim());
      if (filter) q.set('filter', filter);
      if (hiddenOn) q.set('hidden', '1');
      return A.api('/api/folders?' + q.toString()).then(function (r) {
        if (mine !== seq) return;
        var b = r.body;
        if (!r.ok || !b) {
          note(problem(r), true);
          if (!view) showRoots(false);
          return;
        }
        if (b.state !== 'ok') {
          note(LIST_STATES[b.state] || 'That folder can’t be opened.', b.state !== 'link');
          say(LIST_STATES[b.state] || 'That folder can’t be opened.');
          if (!view) showRoots(false);
          return;
        }
        var samePlace = view && view.kind === 'folder' && view.path === b.path;
        if (!samePlace) fresh = null;
        if (resetFilter) ui.loc.value = '';
        ui.noteSticky = false;
        var keep = samePlace && view.items[active] ? view.items[active].name : null;
        view = { kind: 'folder', path: b.path, parent: b.parent, items: itemsOf(b), truncated: b.truncated };
        active = 0;
        if (keep !== null) {
          for (var i = 0; i < view.items.length; i++) if (view.items[i].name === keep) active = i;
        }
        draw(leaf(b.path) + (filter ? ', matching “' + filter + '”, ' : ', ') + countText(view.items.length, b.truncated));
        note(b.truncated ? 'Showing the first 500 folders. Type a name to narrow the list.' : '', false);
      });
    }

    function reload(refresh) {
      if (!view || view.kind === 'roots') return showRoots(refresh);
      return load(view.path, false);
    }

    function start() {
      var mine = ++seq;
      var value = input.value.trim();
      var q = value ? '?' + new URLSearchParams({ start: value }).toString() : '?start=';
      return A.api('/api/folders' + q).then(function (r) {
        if (mine !== seq) return;
        var b = r.body;
        if (!r.ok || !b || b.view !== 'start') {
          note(problem(r), true);
          return showRoots(false);
        }
        if (b.deferred) {
          // A network path is never asked until Enter or Go.
          ui.loc.value = value;
          return showRoots(false);
        }
        if (b.path) return load(b.path, true);
        return showRoots(false);
      });
    }

    // --- actions --------------------------------------------------------------------------------

    function openItem(i) {
      var it = view.items[i];
      if (!it) return;
      if (it.link) {
        note(LIST_STATES.link, false);
        say(LIST_STATES.link);
        ui.noteSticky = true;
        return;
      }
      if (it.state === 'not-responding') {
        say(it.name + ' did not answer. Press Refresh to try again.');
        return;
      }
      ui.noteSticky = false;
      ui.loc.value = '';
      load(it.path, true);
    }

    function goUp() {
      if (!view || view.kind !== 'folder') return;
      ui.noteSticky = false;
      if (view.parent) load(view.parent, true);
      else showRoots(false);
    }

    function submitLoc() {
      var text = ui.loc.value.trim();
      if (text === '') return reload(false);
      if (looksAbsolute(text)) {
        ui.noteSticky = false;
        return load(text, true);
      }
      clearTimeout(filterTimer);
      return view && view.kind === 'folder' ? load(view.path, false) : undefined;
    }

    function choose() {
      if (!view || view.kind !== 'folder') return;
      var p = view.path;
      input.value = p;
      close(true);
      opts.onChoose(p);
    }

    function openForm() {
      if (!view || view.kind !== 'folder') return;
      ui.form.hidden = false;
      ui.nn.value = '';
      ui.nn.classList.remove('bad');
      ui.nnst.textContent = '';
      ui.nnst.appendChild(h('p', 'a1-hint', 'It is made inside ' + view.path + ' as soon as you press Create folder.'));
      ui.nn.focus();
    }
    function closeForm(refocus) {
      ui.form.hidden = true;
      if (refocus && ui.newBtn) ui.newBtn.focus();
    }

    function create() {
      var name = ui.nn.value;
      var parent = view.path;
      var bad = function (text) {
        ui.nn.classList.add('bad');
        ui.nn.setAttribute('aria-invalid', 'true');
        ui.nnst.textContent = '';
        var p = h('p', 'pk-err');
        p.appendChild(icon('warn'));
        p.appendChild(h('span', null, text));
        ui.nnst.appendChild(p);
      };
      ui.nn.classList.remove('bad');
      ui.nn.removeAttribute('aria-invalid');
      A.api('/api/folders/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: parent, name: name }) }).then(function (r) {
        var b = r.body || {};
        if (r.ok && b.created) {
          ui.form.hidden = true;
          var made = leaf(b.path);
          return load(parent, false).then(function () {
            fresh = made;
            if (view && view.kind === 'folder') {
              for (var i = 0; i < view.items.length; i++) if (view.items[i].name === made) active = i;
              draw('Created “' + made + '”. ' + leaf(parent) + ', ' + countText(view.items.length, view.truncated));
            }
            ui.noteSticky = true;
            note('Made ' + b.path + '. Press Enter to open it, then Choose this folder.', false);
            ui.list.focus();
          });
        }
        if (r.status === 400 && b.message) return bad(capital(b.message));
        if (r.status === 409 && b.error === 'exists') return bad('A folder called “' + name + '” already exists here. Nothing was changed.');
        if (r.status === 409 && b.error === 'moved') return bad('The folder was made, but not where expected: ' + (b.path || '') + '.');
        if (r.status === 409 && CREATE_REFUSALS[b.error]) return bad(CREATE_REFUSALS[b.error]);
        return bad(b.message || 'The folder could not be made. Try again.');
      });
    }

    function onListKey(e) {
      if (!view) return;
      var n = view.items.length;
      if (e.key === 'ArrowDown') active = Math.min(n - 1, active + 1);
      else if (e.key === 'ArrowUp' && !e.altKey) active = Math.max(0, active - 1);
      else if (e.key === 'Home') active = 0;
      else if (e.key === 'End') active = Math.max(0, n - 1);
      else if (e.key === 'Enter') {
        e.preventDefault();
        openItem(active);
        return;
      } else if (e.key === 'Backspace' || (e.key === 'ArrowUp' && e.altKey)) {
        e.preventDefault();
        goUp();
        return;
      } else return;
      e.preventDefault();
      mark();
    }

    // --- open and close --------------------------------------------------------------------------

    function open() {
      if (panel) return;
      view = null;
      fresh = null;
      active = 0;
      ui = {};
      panel = build();
      opts.host.parentNode.insertBefore(panel, opts.host.nextSibling);
      browse.setAttribute('aria-expanded', 'true');
      ui.hidden.checked = hiddenOn;
      start().then(function () { if (panel) ui.list.hidden || ui.list.focus(); });
    }

    function close(refocus) {
      clearTimeout(filterTimer);
      seq++;
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      view = null;
      browse.setAttribute('aria-expanded', 'false');
      if (refocus) browse.focus();
    }

    function destroy() {
      close(false);
      if (browse.parentNode) browse.parentNode.removeChild(browse);
    }

    return { open: open, close: function () { close(true); }, destroy: destroy };
  }

  A.picker = { attach: attach };
})();
