'use strict';

/*
 * The panel's update notice (docs/decisions/0028-installer-and-first-run.md, addendum "The update
 * notice"): the Overview banner ("GM-Scriptorium X is available") and the Updates card at the bottom
 * of the Overview, which holds the off switch and the Stable/Beta channel. views.js calls
 * mount(ovHero, ovRest) at the end of every Overview render. The state comes from the server
 * (GET /api/update) and is read once; later renders re-attach the banner and card from the cached
 * answer, and the setting replies carry the fresh state. Nothing is kept in browser storage, and the
 * browser never talks to GitHub: the server checks, and the notes link is built there from the tag.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var el = A.el;
  var setText = A.setText;

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var POLL_MS = 2000;
  var POLL_MAX = 20;

  var snap = null; // the last answer from the server, or null (not loaded, or no notice in this mode)
  var pending = null;
  var slots = { hero: null, rest: null };
  var busy = false;
  var justOn = false;
  var problem = '';
  var polls = 0;
  var pollTimer = null;
  var landing = false; // the tray's "Check for updates" asked to land on the card (S5): land on it once, when it is drawn and the web fonts are in
  var moved = false; // the GM scrolled, pointed, touched or typed since land(), so the landing does nothing
  var MOVES = ['pointerdown', 'wheel', 'touchstart', 'keydown'];

  function noteMove() {
    moved = true;
  }

  function watchMoves(on) {
    MOVES.forEach(function (type) {
      if (on) window.addEventListener(type, noteMove, { capture: true, passive: true });
      else window.removeEventListener(type, noteMove, { capture: true });
    });
  }

  /** True under the desktop app (the session says so), where the command line is not on PATH by default. */
  function isDesktop() {
    var s = A.store && A.store.get().session;
    return !!s && s.desktop === true;
  }

  /** @returns {string} "today at 9:14 am" for the same local day as nowMs, else "on 10 Oct 2026" */
  function whenText(ms, nowMs) {
    var d = new Date(ms);
    var n = new Date(nowMs);
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
      var h = d.getHours();
      var m = d.getMinutes();
      var h12 = h % 12 === 0 ? 12 : h % 12;
      return 'today at ' + h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'am' : 'pm');
    }
    return 'on ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function take(body, configPathFallback) {
    var next = {};
    Object.keys(body).forEach(function (k) {
      next[k] = body[k];
    });
    if (next.configPath === undefined && snap) next.configPath = snap.configPath;
    if (next.configSha256 === undefined && snap) next.configSha256 = snap.configSha256;
    if (configPathFallback !== undefined && next.configPath === undefined) next.configPath = configPathFallback;
    return next;
  }

  function load() {
    if (pending) return pending;
    pending = A.api('/api/update').then(function (r) {
      snap = r.ok && r.body && typeof r.body.setting === 'string' ? r.body : null;
      return snap;
    });
    return pending;
  }

  function code(text) {
    var c = el('code');
    setText(c, text);
    return c;
  }

  function span(text) {
    var s = el('span');
    setText(s, text);
    return s;
  }

  function add(parent, parts) {
    parts.forEach(function (p) {
      parent.appendChild(typeof p === 'string' ? document.createTextNode(p) : p);
    });
    return parent;
  }

  function focusCard() {
    var card = document.getElementById('updates');
    if (!card) return;
    // The card keeps room above it (scroll-margin-top in admin.css), so the top edge never sits on the window's edge or under
    // the narrow top bar. A card that cannot be centred with that room is shown from its top, and focus() never scrolls it away again.
    card.scrollIntoView({ block: card.getBoundingClientRect().height + (parseFloat(window.getComputedStyle(card).scrollMarginTop) || 0) > window.innerHeight ? 'start' : 'center' });
    var sw = card.querySelector('[data-ctl="switch"]');
    if (sw) sw.focus({ preventScroll: true });
  }

  /**
   * The landing, once. The web fonts change the card's height as they arrive, and the scroll position
   * is worked out from the height the card has at that moment, so it waits for them. It does nothing
   * if the GM has scrolled, pointed, touched or typed meanwhile, or has put focus anywhere.
   */
  function landOnce() {
    var ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(null, function () {}).then(function () {
      var elsewhere = document.activeElement && document.activeElement !== document.body;
      var gone = moved || elsewhere;
      watchMoves(false);
      if (!gone) focusCard();
    });
  }

  // -- the banner ---------------------------------------------------------------------------------

  function buildBanner() {
    var sec = el('section');
    sec.className = 'upd';
    sec.setAttribute('role', 'status');
    sec.setAttribute('aria-labelledby', 'upd-t');
    sec.setAttribute('data-part', 'update-notice');
    sec.appendChild(A.icon('refresh'));

    var grow = el('div');
    grow.className = 'grow';
    var b = el('b');
    b.id = 'upd-t';
    setText(b, 'GM-Scriptorium ' + snap.latest + ' is available' + (snap.beta ? ' (beta)' : ''));
    grow.appendChild(b);

    var have = el('span');
    var notes = el('a');
    notes.className = 'a1-link';
    notes.href = snap.notesUrl;
    notes.target = '_blank';
    notes.rel = 'noopener noreferrer';
    add(notes, ['What’s new ', A.icon('ext')]);
    add(have, ['You have ' + snap.current + '. ', notes]);
    grow.appendChild(have);

    if (isDesktop()) {
      grow.appendChild(add(el('span'), ['To update, run the new installer, or choose Open command line (Advanced) from the tray menu and run ', code('gm-scriptorium update'), '.']));
    } else {
      grow.appendChild(add(el('span'), ['To update, run the new installer, or ', code('gm-scriptorium update'), '.']));
    }

    var fine = el('span');
    fine.className = 'upd-fine';
    var off = el('a');
    off.className = 'a1-link';
    off.href = '#updates';
    setText(off, 'Turn off update checks');
    off.addEventListener('click', function (ev) {
      ev.preventDefault();
      focusCard();
    });
    add(fine, ['Not now hides this until a newer version comes out on your channel. ', off]);
    grow.appendChild(fine);
    sec.appendChild(grow);

    var btns = el('div');
    btns.className = 'upd-btns';
    var notNow = el('button');
    notNow.type = 'button';
    notNow.className = 'a1-btn ghost small';
    setText(notNow, 'Not now');
    notNow.addEventListener('click', function () {
      if (busy) return;
      busy = true;
      notNow.disabled = true;
      A.api('/api/update/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: snap.latestTag }) }).then(function (r) {
        busy = false;
        if (r.ok) {
          snap = take(snap);
          snap.dismissed = true;
          paint();
        } else {
          notNow.disabled = false;
        }
      });
    });
    btns.appendChild(notNow);
    sec.appendChild(btns);
    return sec;
  }

  // -- the card -----------------------------------------------------------------------------------

  function option(name, value, title, hint, checked, disabled, onPick) {
    var label = el('label');
    label.className = 'upd-opt';
    var input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    input.disabled = disabled;
    input.setAttribute('data-ctl', 'channel-' + value);
    input.addEventListener('change', function () {
      if (input.checked) onPick(value);
    });
    label.appendChild(input);
    var b = el('b');
    setText(b, title);
    label.appendChild(b);
    var small = el('small');
    setText(small, hint);
    label.appendChild(small);
    return label;
  }

  function cap(channel) {
    return channel === 'beta' ? 'Beta' : 'Stable';
  }

  function channelCaption(s, locked) {
    var p = el('p');
    p.className = 'a1-fine';
    var sentence;
    if (locked) sentence = 'Both choices are locked until the file is fixed.';
    else if (s.channelSaved) sentence = 'You chose ' + cap(s.channel) + '.';
    else sentence = 'You are running ' + s.current + ', a ' + (s.prereleaseBuild ? 'prerelease' : 'stable') + ' build, so ' + cap(s.channel) + ' is selected for you.';
    add(p, ['Default: Stable on a stable build, Beta on a prerelease build. ' + sentence + ' Saved as ', code('[update] channel'), ' in ', code('config.toml'), '.']);
    return p;
  }

  function statusLine(s) {
    var icon = 'clock';
    var text = null;
    var part = null;
    var when = s.lastSuccessMs === null || s.lastSuccessMs === undefined ? null : whenText(s.lastSuccessMs, Date.now());
    if (s.setting !== 'on') {
      text = 'Update checks are off.' + (s.setting === 'off' && when ? ' Last checked ' + when + '.' : '');
    } else if (justOn) {
      text = 'Update checks are on. The next check is tomorrow.';
    } else if (s.state === 'failed') {
      icon = 'cloudoff';
      part = 'update-quiet';
      text = 'Couldn’t check for updates just now. GM-Scriptorium will try again tomorrow.';
    } else if (s.state === 'available' && when) {
      text = 'Last checked ' + when + '. A newer version, ' + s.latest + ', was found.';
    } else if (s.state === 'current' && when) {
      text = 'Last checked ' + when + '. You have the newest version on your channel.';
    }
    if (text === null) return null;
    var div = el('div');
    div.className = 'upd-status';
    if (part) div.setAttribute('data-part', part);
    div.appendChild(A.icon(icon));
    div.appendChild(span(text));
    return div;
  }

  function privacyNote(s) {
    var note = el('div');
    note.className = 'cs-msg is-info';
    note.setAttribute('role', 'note');
    var body = el('div');
    if (s.setting === 'unreadable') {
      note.appendChild(A.icon('info'));
      body.appendChild(add(el('p'), ['Your settings file has an ', code('[update]'), ' entry (', code('check'), ' or ', code('channel'), ') that this version can’t read, so update checks are off and the channel is locked. Nothing is sent to GitHub.']));
      body.appendChild(add(el('p'), ['To switch them back on, set ', code('check = true'), ' and ', code('channel'), ' to stable or beta under ', code('[update]'), ' in ', code(s.configPath || 'config.toml'), ', then restart GM-Scriptorium.']));
    } else {
      note.appendChild(A.icon('shield'));
      if (s.setting === 'on') {
        var on = el('p');
        add(on, [(function () { var b = el('b'); setText(b, 'Privacy.'); return b; })(), ' When this is on, GM-Scriptorium asks GitHub about once a day whether a newer version is out, and once more when you change the channel. If a check fails it tries again the next time it starts. GitHub can see this computer’s internet address, the version you run, and the time. It never sees your campaigns, your files or your settings. A notice only appears when there is a newer release on your channel.']);
        body.appendChild(on);
      } else {
        if (isDesktop()) {
          body.appendChild(add(el('p'), ['When this is off, GM-Scriptorium makes no internet requests on its own. You can still update whenever you like: choose Open command line (Advanced) from the tray menu and run ', code('gm-scriptorium update'), '.']));
        } else {
          body.appendChild(add(el('p'), ['When this is off, GM-Scriptorium makes no internet requests on its own. You can still run ', code('gm-scriptorium update'), ' whenever you like.']));
        }
      }
      body.appendChild(add(el('p'), ['Saved as ', code('[update] check = ' + (s.setting === 'on' ? 'true' : 'false')), ' in ', code(s.configPath || 'config.toml'), '. Turning it off takes effect straight away.']));
    }
    note.appendChild(body);
    return note;
  }

  function post(payload) {
    if (busy) return;
    busy = true;
    problem = '';
    var wasOff = snap.setting !== 'on';
    var previous = snap;
    payload.configSha256 = snap.configSha256;
    A.api('/api/update/setting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) {
      busy = false;
      if (r.ok && r.body && r.body.update) {
        var next = take(r.body.update, snap.configPath);
        next.configSha256 = r.body.configSha256;
        snap = next;
        justOn = payload.check === true && wasOff;
        if (payload.check === false) justOn = false;
        if (payload.channel !== undefined) justOn = false;
        schedulePoll(true);
      } else {
        problem = (r.body && r.body.message) || 'The setting could not be saved. Try again.';
        // Read the state again first, so the next try carries the file's current sha256.
        pending = null;
        load().then(function () {
          if (!snap) snap = previous;
          paint();
        });
        return;
      }
      paint();
    });
  }

  function buildCard() {
    var s = snap;
    var locked = s.setting === 'unreadable';
    var on = s.setting === 'on';
    var sec = el('section');
    sec.className = 'upd-card';
    sec.id = 'updates';
    sec.setAttribute('aria-labelledby', 'upd-h');
    sec.setAttribute('data-part', 'update-setting');

    var h2 = el('h2');
    h2.className = 'a1-rule';
    h2.id = 'upd-h';
    setText(h2, 'Updates');
    sec.appendChild(h2);

    var row = el('div');
    row.className = 'upd-row';
    var sw = el('button');
    sw.type = 'button';
    sw.className = 'a1-switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.setAttribute('aria-label', 'Check for updates once a day');
    sw.setAttribute('data-ctl', 'switch');
    if (locked) sw.setAttribute('aria-disabled', 'true');
    var trk = el('span');
    trk.className = 'trk';
    sw.appendChild(trk);
    sw.appendChild(span('Check for updates once a day'));
    sw.addEventListener('click', function () {
      if (locked || busy) return;
      post({ check: !on });
    });
    row.appendChild(sw);
    sec.appendChild(row);

    var fs = el('fieldset');
    fs.className = 'upd-chan';
    fs.setAttribute('data-part', 'update-channel');
    var legend = el('legend');
    setText(legend, 'Update channel');
    fs.appendChild(legend);
    var opts = el('div');
    opts.className = 'upd-opts';
    var off = !on;
    var pick = function (value) {
      if (busy || value === s.channel) return;
      post({ channel: value });
    };
    opts.appendChild(option('upd-channel', 'stable', 'Stable', 'Full releases only. Recommended for most GMs.', s.channel === 'stable', off, pick));
    opts.appendChild(option('upd-channel', 'beta', 'Beta', 'Also try prereleases early. Expect rough edges.', s.channel === 'beta', off, pick));
    fs.appendChild(opts);
    fs.appendChild(channelCaption(s, locked));
    sec.appendChild(fs);

    var fine = el('p');
    fine.className = 'a1-fine upd-priv';
    setText(fine, 'GM-Scriptorium only tells you about updates. It never installs one by itself.');
    sec.appendChild(fine);

    if (problem) {
      var alert = el('p');
      alert.className = 'a1-fine';
      alert.setAttribute('role', 'alert');
      setText(alert, problem);
      sec.appendChild(alert);
    }

    var status = statusLine(s);
    if (status) sec.appendChild(status);
    sec.appendChild(privacyNote(s));
    return sec;
  }

  // -- placing it ---------------------------------------------------------------------------------

  function paint() {
    if (!snap) return;
    var active = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-ctl') : null;
    var hero = slots.hero;
    var rest = slots.rest;
    if (hero && hero.isConnected) {
      var oldBanner = hero.querySelector('[data-part="update-notice"]');
      if (oldBanner) oldBanner.parentNode.removeChild(oldBanner);
      if (snap.setting === 'on' && snap.state === 'available' && !snap.dismissed) {
        var before = hero.querySelector('header.a1-hero');
        var banner = buildBanner();
        if (before) before.parentNode.insertBefore(banner, before);
        else hero.insertBefore(banner, hero.firstChild);
      }
    }
    if (rest && rest.isConnected) {
      var oldCard = rest.querySelector('[data-part="update-setting"]');
      if (oldCard) oldCard.parentNode.removeChild(oldCard);
      rest.appendChild(buildCard());
      if (landing) {
        landing = false;
        landOnce();
      }
      if (active) {
        var again = rest.querySelector('[data-ctl="' + active + '"]');
        if (again && !again.disabled) again.focus();
      }
    }
  }

  // While a check is in flight (the first one after launch, or the one a channel change starts) the
  // answer is polled for, so the banner appears without a reload.
  function schedulePoll(reset) {
    if (reset) polls = 0;
    if (pollTimer !== null || !snap || snap.state !== 'checking' || polls >= POLL_MAX) return;
    pollTimer = setTimeout(function () {
      pollTimer = null;
      polls++;
      A.api('/api/update').then(function (r) {
        if (r.ok && r.body && typeof r.body.setting === 'string') {
          snap = r.body;
          paint();
        }
        schedulePoll(false);
      });
    }, POLL_MS);
  }

  function mount(ovHero, ovRest) {
    slots.hero = ovHero;
    slots.rest = ovRest;
    if (snap) {
      paint();
      return;
    }
    load().then(function () {
      paint();
      schedulePoll(true);
    });
  }

  /** Called once at boot when the session carries the "updates" landing. */
  function land() {
    landing = true;
    moved = false;
    watchMoves(true);
  }

  A.updates = { mount: mount, whenText: whenText, land: land };
})();
