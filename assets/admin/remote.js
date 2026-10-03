'use strict';

/*
 * V1.5a (docs/decisions/0029-remote-access.md section 9; engineering brief SD-a12): the read-only
 * Setup > Remote access screen. RA is the pure half, above the node guard (the VB pattern in
 * vocab.js): the words and shapes the screen shows, all tested under plain node
 * (test/admin-remote-model.test.js). The browser half below builds the DOM with textContent only.
 *
 * It is READ-ONLY: every change is made with the scriptorium remote command, whose commands this
 * screen shows in place of Change / Turn on / Turn off. Its only actions are the two sign-outs.
 *
 * No request on navigation (ADR 0022 section 13): the screen fetches /api/remote once at boot and
 * again only from its own Refresh button.
 */
(function () {
  var MODE_LABEL = {
    local: 'This computer only',
    ssh: 'SSH tunnel',
    tailscale: 'Over Tailscale',
    proxy: 'Behind your reverse proxy',
    direct: 'Direct, own certificate',
  };

  /** Own-property lookup: '__proto__', 'constructor' and the like give 'Unknown mode', never a function. */
  function modeLabel(mode) {
    return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODE_LABEL, mode) ? MODE_LABEL[mode] : 'Unknown mode';
  }

  function utc(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  /** @param {{ mode?: string, https?: { by?: string, hop?: string|null } }} view @returns {string} */
  function httpsLine(view) {
    var by = view && view.https ? view.https.by : 'none';
    var hop = view && view.https ? view.https.hop : null;
    if (by === 'ssh') return 'HTTPS: not needed, the SSH tunnel encrypts the traffic.';
    if (by === 'tailscale') return "HTTPS: by tailscale serve. Your tailnet's access rules decide which devices can reach the sign-in page.";
    if (by === 'proxy') {
      return hop === 'tls'
        ? 'HTTPS: by your proxy, and the hop from the proxy to GM-Scriptorium is encrypted too.'
        : 'HTTPS: by your proxy. The hop from the proxy to GM-Scriptorium is plain HTTP, so keep the two on a network you trust.';
    }
    if (by === 'panel') return 'HTTPS: by GM-Scriptorium itself.';
    return 'HTTPS: not needed on this computer.';
  }

  /** @param {{ mode?: string, listening?: { hosts?: string[], adminPort?: number, previewPort?: number } }} view @returns {string} */
  function listeningLine(view) {
    var l = view && view.listening;
    if (!l || !l.hosts || view.mode === 'local') return 'Listening on 127.0.0.1 only, so only this computer can reach it.';
    return 'Listening on ' + l.hosts.join(' and ') + ', ports ' + l.adminPort + ' (panel) and ' + l.previewPort + ' (preview).';
  }

  /** @param {{ active?: boolean, until?: number|null, recentFailures?: number, refused?: number }} lockout @returns {string} */
  function lockoutLine(lockout) {
    if (lockout && lockout.active) {
      var n = lockout.refused || 0;
      return 'Remote sign-in is paused until ' + utc(lockout.until) + ' after five wrong passwords. ' + n + (n === 1 ? ' attempt has' : ' attempts have') + ' been turned away. The one-time link on this machine still works.';
    }
    var f = (lockout && lockout.recentFailures) || 0;
    return f === 0
      ? 'Remote sign-in is open. Five wrong passwords in ten minutes would pause it for fifteen.'
      : 'Remote sign-in is open. ' + f + (f === 1 ? ' wrong password' : ' wrong passwords') + ' in the last ten minutes; five would pause it for fifteen.';
  }

  /**
   * @param {object[]} entries audit entries, newest first
   * @returns {{ how: string, from: string, when: string, result: string }[]} sign-in rows only. There is no "Who"
   *   column: the log cannot know who.
   */
  function signinRows(entries) {
    var rows = [];
    (entries || []).forEach(function (e) {
      if (!e || e.event !== 'signin') return;
      rows.push({
        how: e.method === 'token' ? 'One-time link' : 'Panel password',
        from: e.via === 'loopback' ? 'This machine (or an SSH tunnel)' : e.from || 'unknown address',
        when: typeof e.t === 'string' ? e.t.slice(0, 16).replace('T', ' ') + ' UTC' : '',
        result: e.result === 'ok' ? 'signed in' : e.result === 'refused' ? 'refused' : 'error',
      });
    });
    return rows;
  }

  function refusedOnly(rows) {
    return (rows || []).filter(function (r) {
      return r.result === 'refused';
    });
  }

  /** @param {string} mode @returns {{ label: string, command: string }[]} */
  function cliCommands(mode) {
    var set;
    if (mode === 'ssh') set = 'scriptorium remote set --mode ssh --port 7400 --preview-port 7401';
    else if (mode === 'tailscale') {
      set = 'scriptorium remote set --mode tailscale --admin-url https://panel-host.example-tailnet.ts.net --preview-url https://panel-host.example-tailnet.ts.net:8443 --port 7400 --preview-port 7401';
    } else {
      set =
        'scriptorium remote set --mode proxy --admin-url https://scriptorium.home.arpa --preview-url https://preview.scriptorium.home.arpa --bind 192.0.2.42 --trusted-proxy 198.51.100.20 --port 7400 --preview-port 7401';
    }
    return [
      { label: 'Turn on or change', command: set },
      { label: 'Turn off', command: 'scriptorium remote off' },
      { label: 'Set or change the password', command: 'scriptorium remote password' },
      { label: 'Sign out every device', command: 'scriptorium remote signout-all' },
    ];
  }

  /** The note about --config, shown when the panel knows which config it was started with. */
  function configNote(view) {
    return view && typeof view.configPath === 'string' && view.configPath
      ? 'This panel is using the config at ' + view.configPath + '. If you started it with --config, add the same --config <path> to each command.'
      : '';
  }

  /** @returns {{ label: string, text: string, bad: boolean }[]} the health items */
  function healthItems(view) {
    var v = view || {};
    var items = [{ label: 'HTTPS', text: httpsLine(v), bad: false }];
    var pw = v.password || {};
    items.push({ label: 'Password', text: pw.set ? 'Set ' + String(pw.setAt || '').slice(0, 10) : v.mode === 'local' || v.mode === 'ssh' ? 'Not needed in this mode' : 'Not set', bad: !pw.set && v.mode !== 'local' && v.mode !== 'ssh' });
    items.push({ label: 'Listening', text: listeningLine(v), bad: false });
    var audit = v.audit || { ok: true };
    items.push({
      label: 'Audit log',
      text: audit.ok ? 'Writing to ' + (audit.file || 'the audit log') + '.' : 'Cannot write (' + ((audit.lastError && audit.lastError.message) || 'unknown error') + '). Changes from other devices are paused until it can.',
      bad: !audit.ok,
    });
    var loose = (v.files && v.files.looseModes) || [];
    items.push({ label: 'File permissions', text: loose.length === 0 ? 'Private to your user.' : 'Other users on this machine can read: ' + loose.join(', '), bad: loose.length > 0 });
    return items;
  }

  /** @returns {{ label: string, value: string }[]} */
  function addressRows(view) {
    var v = view || {};
    var a = v.addresses || {};
    var rows = [];
    if (a.admin) rows.push({ label: 'Admin panel', value: a.admin });
    if (a.preview) rows.push({ label: 'Preview', value: a.preview });
    if (a.adminLoopback) rows.push({ label: 'On this machine', value: a.adminLoopback + ' (use the one-time link printed when it starts)' });
    return rows;
  }

  var RA = {
    MODE_LABEL: MODE_LABEL,
    modeLabel: modeLabel,
    httpsLine: httpsLine,
    listeningLine: listeningLine,
    lockoutLine: lockoutLine,
    signinRows: signinRows,
    refusedOnly: refusedOnly,
    cliCommands: cliCommands,
    configNote: configNote,
    healthItems: healthItems,
    addressRows: addressRows,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { RA: RA };
    return;
  }

  // ---- browser half ---------------------------------------------------------------------

  var A = window.ScriptoriumAdmin;

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function text(tag, className, value) {
    var node = el(tag, className);
    A.setText(node, value);
    return node;
  }

  function button(label, className) {
    var b = el('button', className);
    b.type = 'button';
    A.setText(b, label);
    return b;
  }

  function init(container) {
    var root = el('div', 'rm-root');
    container.appendChild(root);
    var view = null;
    var filterRefused = false;
    var statusLine = el('p', 'rm-status');
    statusLine.setAttribute('role', 'status');

    function setStatus(msg) {
      A.setText(statusLine, msg);
    }

    function table(rows, caption) {
      var wrap = el('div', 'rm-tw');
      var t = el('table', 'rm-table');
      var cap = el('caption', 'rm-sr');
      A.setText(cap, caption);
      t.appendChild(cap);
      var head = el('tr');
      ['How', 'From', 'When', 'Result'].forEach(function (h) {
        var th = el('th');
        th.scope = 'col';
        A.setText(th, h);
        head.appendChild(th);
      });
      var thead = el('thead');
      thead.appendChild(head);
      t.appendChild(thead);
      var body = el('tbody');
      if (rows.length === 0) {
        var empty = el('tr');
        var td = el('td');
        td.colSpan = 4;
        A.setText(td, 'Nothing to show.');
        empty.appendChild(td);
        body.appendChild(empty);
      }
      rows.forEach(function (r) {
        var tr = el('tr');
        [r.how, r.from, r.when].forEach(function (cell) {
          tr.appendChild(text('td', '', cell));
        });
        var res = el('td');
        res.appendChild(text('span', r.result === 'refused' ? 'rm-pill err' : r.result === 'error' ? 'rm-pill warn' : 'rm-pill ok', r.result));
        tr.appendChild(res);
        body.appendChild(tr);
      });
      t.appendChild(body);
      wrap.appendChild(t);
      return wrap;
    }

    function signOut(path) {
      return function () {
        setStatus('Signing out...');
        A.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (res) {
          if (!res.ok) {
            setStatus('Could not sign out (' + res.status + ').');
            return;
          }
          if (view && view.requestKind === 'remote') {
            location.replace('/');
            return;
          }
          var n = res.body && typeof res.body.signedOut === 'number' ? res.body.signedOut : null;
          setStatus(n === null ? 'Signed out.' : 'Signed out ' + n + (n === 1 ? ' remote device.' : ' remote devices.'));
          load();
        });
      };
    }

    function render() {
      while (root.firstChild) root.removeChild(root.firstChild);
      if (view === null) {
        root.appendChild(text('p', 'a1-lede', 'Loading...'));
        return;
      }
      var on = view.mode !== 'local';

      var mode = el('section', 'rm-mode');
      mode.setAttribute('aria-labelledby', 'rm-mode-h');
      var modeHead = text('h2', 'a1-rule', 'Current mode');
      modeHead.id = 'rm-mode-h';
      mode.appendChild(modeHead);
      mode.appendChild(text('p', 'rm-modename', RA.modeLabel(view.mode) + (on ? '' : ': remote access is off')));
      if (!on) mode.appendChild(text('p', 'a1-lede', 'The panel answers only on this computer. To use it from another device, turn remote access on from the command line (see below).'));
      var addrs = el('dl', 'rm-addrs');
      RA.addressRows(view).forEach(function (r) {
        addrs.appendChild(text('dt', '', r.label));
        addrs.appendChild(text('dd', '', r.value));
      });
      mode.appendChild(addrs);
      var health = el('ul', 'rm-health');
      RA.healthItems(view).forEach(function (h) {
        var li = el('li', h.bad ? 'rm-hl bad' : 'rm-hl');
        li.appendChild(text('strong', '', h.label + ': '));
        li.appendChild(document.createTextNode(h.text));
        health.appendChild(li);
      });
      mode.appendChild(health);
      mode.appendChild(text('p', 'rm-lockout', RA.lockoutLine(view.lockout)));
      mode.appendChild(text('p', 'rm-count', view.sessions.active + (view.sessions.active === 1 ? ' remote device is signed in.' : ' remote devices are signed in.')));
      root.appendChild(mode);

      var recent = el('section', 'rm-recent');
      recent.setAttribute('aria-labelledby', 'rm-recent-h');
      var recentHead = text('h2', 'a1-rule', 'Recent sign-ins');
      recentHead.id = 'rm-recent-h';
      recent.appendChild(recentHead);
      recent.appendChild(table(RA.signinRows(view.recentSignins), 'Sign-ins in the last 7 days'));
      root.appendChild(recent);

      var log = el('section', 'rm-log');
      log.setAttribute('aria-labelledby', 'rm-log-h');
      var logHead = text('h2', 'a1-rule', 'Full log');
      logHead.id = 'rm-log-h';
      log.appendChild(logHead);
      var label = el('label', 'rm-check');
      var box = el('input');
      box.type = 'checkbox';
      box.checked = filterRefused;
      box.addEventListener('change', function () {
        filterRefused = box.checked;
        render();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(' Refused only'));
      log.appendChild(label);
      var rows = RA.signinRows(view.log);
      log.appendChild(table(filterRefused ? RA.refusedOnly(rows) : rows, 'Every recorded sign-in'));
      if (view.truncated) log.appendChild(text('p', 'rm-note', 'Only the newest 2000 entries are shown.'));
      log.appendChild(text('p', 'rm-note', 'Every sign-in attempt is kept for 90 days beside your config. Never passwords, one-time links or cookies.'));
      root.appendChild(log);

      var cli = el('section', 'rm-cli');
      cli.setAttribute('aria-labelledby', 'rm-cli-h');
      var cliHead = text('h2', 'a1-rule', 'Change these from the command line');
      cliHead.id = 'rm-cli-h';
      cli.appendChild(cliHead);
      var list = el('dl', 'rm-cmds');
      RA.cliCommands(view.mode).forEach(function (c) {
        list.appendChild(text('dt', '', c.label));
        list.appendChild(text('dd', 'rm-cmd', c.command));
      });
      cli.appendChild(list);
      var note = RA.configNote(view);
      if (note) cli.appendChild(text('p', 'rm-note', note));
      root.appendChild(cli);

      var actions = el('div', 'a1-actions rm-actions');
      var all = button('Sign out every device', 'a1-btn ghost');
      all.addEventListener('click', signOut('/api/remote/signout-all'));
      actions.appendChild(all);
      if (view.requestKind === 'remote') {
        var one = button('Sign out this device', 'a1-btn ghost');
        one.addEventListener('click', signOut('/api/remote/signout'));
        actions.appendChild(one);
      }
      var refresh = button('Refresh', 'a1-btn ghost');
      refresh.addEventListener('click', function () {
        setStatus('Refreshing...');
        load();
      });
      actions.appendChild(refresh);
      root.appendChild(actions);
      root.appendChild(statusLine);
    }

    function load() {
      A.api('/api/remote').then(function (res) {
        if (!res.ok || !res.body) {
          setStatus('Could not load remote access (' + res.status + ').');
          return;
        }
        view = res.body;
        render();
        setStatus('');
      });
    }

    render();
    load();
  }

  A.register('remote', init);
  A.RA = RA;
})();
