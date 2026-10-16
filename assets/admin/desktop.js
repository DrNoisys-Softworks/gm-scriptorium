'use strict';

/*
 * The desktop app's ports card (docs/decisions/0057-windows-desktop-app.md, section 8): "This PC's
 * addresses", on the Overview. views.js calls mount(ovRest) at the end of every Overview render. The
 * state comes from the server (GET /api/desktop) and is read once; later renders re-attach the card
 * from the cached answer. Outside the desktop app the server says so and no card is drawn. In a
 * remote mode the card is read-only, because the remote ports are set with `remote set`. Saving
 * posts the two ports to /api/desktop/ports; the server writes them and restarts the panel on them,
 * so this tab stops working and a new one opens. Nothing is kept in browser storage.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var el = A.el;
  var setText = A.setText;

  var PORT_RE = /^[0-9]{1,5}$/;
  var NOTE = 'Saving restarts GM-Scriptorium on the new ports and opens the panel there in a new tab. Bookmarks to the old address stop working.';
  var REMOTE_NOTE = 'Remote access uses its own ports. Change them with gm-scriptorium remote set.';

  var snap = null; // the last answer from the server, or null (not loaded)
  var pending = null;
  var slot = null;
  var editing = false;
  var values = { port: '', previewPort: '' };
  var problem = '';
  var busy = false;
  var focused = null; // the data-ctl of the control that last had focus inside the card, so a re-render of the Overview can give it back
  var saved = null; // { port, previewPort } once a save was accepted: the restart is under way

  function load() {
    if (pending) return pending;
    pending = A.api('/api/desktop').then(function (r) {
      snap = r.ok && r.body && typeof r.body.desktop === 'boolean' ? r.body : null;
      return snap;
    });
    return pending;
  }

  function code(text) {
    var c = el('code');
    setText(c, text);
    return c;
  }

  function row(label, url) {
    var div = el('div');
    var k = el('span');
    k.className = 'k';
    setText(k, label);
    div.appendChild(k);
    div.appendChild(code(url));
    return div;
  }

  function field(id, label, value, onInput) {
    var wrap = el('div');
    wrap.className = 'a1-field';
    var lab = el('label');
    lab.setAttribute('for', id);
    setText(lab, label);
    wrap.appendChild(lab);
    var input = el('input');
    input.id = id;
    input.type = 'text';
    input.className = 'a1-in mono';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('maxlength', '5');
    input.setAttribute('data-ctl', id);
    input.value = value;
    input.addEventListener('input', function () {
      onInput(input.value);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function fine(text) {
    var p = el('p');
    p.className = 'a1-fine';
    setText(p, text);
    return p;
  }

  /** @returns {string} the reason the typed ports cannot be saved, or '' */
  function check() {
    var a = values.port.trim();
    var b = values.previewPort.trim();
    if (!PORT_RE.test(a) || !PORT_RE.test(b)) return 'Ports are whole numbers from 1 to 65535.';
    if (Number(a) < 1 || Number(a) > 65535 || Number(b) < 1 || Number(b) > 65535) return 'Ports are whole numbers from 1 to 65535.';
    if (Number(a) === Number(b)) return 'The panel and the preview need different ports.';
    return '';
  }

  function save() {
    if (busy || saved) return;
    var why = check();
    if (why) {
      problem = why;
      paint('pt-a');
      return;
    }
    busy = true;
    problem = '';
    var payload = { port: Number(values.port.trim()), previewPort: Number(values.previewPort.trim()), configSha256: snap.configSha256 };
    A.api('/api/desktop/ports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) {
      busy = false;
      if (r.ok && r.body && r.body.ok === true) {
        saved = { port: payload.port, previewPort: payload.previewPort };
        paint('status');
        return;
      }
      problem = (r.body && r.body.message) || 'The ports could not be saved. Try again.';
      // Read the state again first, so the next try carries the file's current sha256.
      pending = null;
      load().then(function () {
        paint('save');
      });
    });
  }

  function buildCard() {
    var sec = el('section');
    sec.className = 'pt-card';
    sec.id = 'desktop-ports';
    sec.setAttribute('aria-labelledby', 'pt-h');
    sec.setAttribute('data-part', 'desktop-ports');

    var h2 = el('h2');
    h2.className = 'a1-rule';
    h2.id = 'pt-h';
    setText(h2, "This PC's addresses");
    sec.appendChild(h2);

    var rows = el('div');
    rows.className = 'pt-rows';
    rows.appendChild(row('Panel', snap.panelUrl));
    rows.appendChild(row('Preview', snap.previewUrl));
    sec.appendChild(rows);

    if (!snap.editable) {
      sec.appendChild(fine(REMOTE_NOTE));
      return sec;
    }

    if (saved) {
      var status = el('p');
      status.className = 'a1-fine';
      status.setAttribute('role', 'status');
      status.setAttribute('data-ctl', 'status');
      status.setAttribute('tabindex', '-1');
      setText(status, 'Saved. GM-Scriptorium is restarting on ports ' + saved.port + ' and ' + saved.previewPort + ', and a new tab opens there. You can close this one.');
      sec.appendChild(status);
      return sec;
    }

    if (!editing) {
      var actions = el('div');
      actions.className = 'a1-actions';
      var change = el('button');
      change.type = 'button';
      change.className = 'a1-btn ghost';
      change.setAttribute('data-ctl', 'change');
      setText(change, 'Change');
      change.addEventListener('click', function () {
        editing = true;
        values = { port: String(snap.port), previewPort: String(snap.previewPort) };
        problem = '';
        paint('pt-a');
      });
      actions.appendChild(change);
      sec.appendChild(actions);
      return sec;
    }

    var edit = el('div');
    edit.className = 'pt-edit';
    edit.appendChild(
      field('pt-a', 'Panel port', values.port, function (v) {
        values.port = v;
      }),
    );
    edit.appendChild(
      field('pt-b', 'Preview port', values.previewPort, function (v) {
        values.previewPort = v;
      }),
    );
    sec.appendChild(edit);
    sec.appendChild(fine(NOTE));

    if (problem) {
      var alert = el('p');
      alert.className = 'a1-fine';
      alert.setAttribute('role', 'alert');
      setText(alert, problem);
      sec.appendChild(alert);
    }

    var btns = el('div');
    btns.className = 'a1-actions';
    var go = el('button');
    go.type = 'button';
    go.className = 'a1-btn primary';
    go.setAttribute('data-ctl', 'save');
    go.appendChild(A.icon('refresh'));
    go.appendChild(document.createTextNode('Save and restart'));
    go.addEventListener('click', save);
    btns.appendChild(go);
    var cancel = el('button');
    cancel.type = 'button';
    cancel.className = 'a1-btn ghost';
    cancel.setAttribute('data-ctl', 'cancel');
    setText(cancel, 'Cancel');
    cancel.addEventListener('click', function () {
      editing = false;
      problem = '';
      paint('change');
    });
    btns.appendChild(cancel);
    sec.appendChild(btns);
    return sec;
  }

  /** Redraws the card in its slot and puts focus on the control named `focus`, when it exists. */
  function paint(focus) {
    if (!snap || snap.desktop !== true || !slot || !slot.isConnected) return;
    // Always the last thing on the Overview, below the Updates card, so filling it in late never moves a card the page has just scrolled to.
    if (slot.parentNode.lastElementChild !== slot) slot.parentNode.appendChild(slot);
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    var card = buildCard();
    slot.appendChild(card);
    if (focus) {
      var target = card.querySelector('[data-ctl="' + focus + '"]');
      if (target) target.focus();
    }
  }

  // Which control of the card last had focus. Focus anywhere else clears it.
  document.addEventListener('focusin', function (ev) {
    var t = ev.target;
    focused = slot && t && t.getAttribute && slot.contains(t) ? t.getAttribute('data-ctl') : null;
  });

  function mount(ovRest) {
    // The slot is placed at once, before any answer; it moves to the end when the card is drawn.
    slot = el('div');
    slot.setAttribute('data-part', 'desktop-slot');
    ovRest.appendChild(slot);
    var mine = slot;
    // The Overview was just drawn again: focus the card's control again only when the redraw left focus on the page itself.
    var again = focused && (!document.activeElement || document.activeElement === document.body) ? focused : undefined;
    if (snap) {
      paint(again);
      return;
    }
    load().then(function () {
      if (slot === mine) paint(again);
    });
  }

  A.desktop = { mount: mount };
})();
