'use strict';

/*
 * ADR 0028, section 5: the one-time Overview welcome (FR-23). views.js calls mount(slot) at the top
 * of renderOverview; the answer comes from the server (GET /api/setup/state: `welcome` is true only
 * for a campaign that browser setup created and nobody has dismissed), so it survives a reload and
 * never lives in browser storage. mount() is called on every Overview render, so the state is read
 * once and the banner is (re)attached to whichever slot is current, after that render has finished.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var el = A.el;
  var setText = A.setText;

  var shown = null; // null until the server has answered, then true or false
  var pending = null;
  var campaign = '';

  function load() {
    if (pending) return pending;
    pending = A.api('/api/setup/state').then(function (r) {
      shown = Boolean(r.ok && r.body && r.body.welcome === true);
      campaign = (r.ok && r.body && r.body.campaign) || '';
      return shown;
    });
    return pending;
  }

  function item(iconName, strong, rest) {
    var li = el('li');
    li.appendChild(A.icon(iconName));
    var d = el('div');
    var b = el('b');
    setText(b, strong);
    d.appendChild(b);
    var sp = el('span');
    setText(sp, ' ' + rest);
    d.appendChild(sp);
    li.appendChild(d);
    return li;
  }

  function build() {
    var sec = el('section');
    sec.className = 'wel';
    sec.setAttribute('data-part', 'welcome');
    sec.setAttribute('aria-labelledby', 'wel-h');
    var left = el('div');
    var eyebrow = el('div');
    eyebrow.className = 'a1-eyebrow';
    setText(eyebrow, 'Welcome to Backstage');
    left.appendChild(eyebrow);
    var h2 = el('h2');
    h2.id = 'wel-h';
    setText(h2, campaign + ' is set up.');
    left.appendChild(h2);
    var p = el('p');
    setText(p, 'This is your panel. It runs on this computer while GM-Scriptorium is open. Three good next steps:');
    left.appendChild(p);
    var ol = el('ol');
    ol.appendChild(item('preview', 'Look at your preview.', 'Only you can see it.'));
    ol.appendChild(item('archive', 'Commit your vault.', 'Setup added files under _meta/scriptorium/.'));
    ol.appendChild(item('publish', 'When it’s ready for players,', 'Preview & publish walks you through it.'));
    left.appendChild(ol);
    sec.appendChild(left);
    var x = el('button');
    x.type = 'button';
    x.className = 'x';
    x.setAttribute('aria-label', 'Dismiss the welcome');
    x.appendChild(A.icon('x'));
    x.addEventListener('click', function () {
      x.disabled = true;
      A.api('/api/welcome/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (r) {
        if (r.ok) {
          shown = false;
          if (sec.parentNode) sec.parentNode.removeChild(sec);
        } else {
          x.disabled = false;
        }
      });
    });
    sec.appendChild(x);
    return sec;
  }

  function mount(slot) {
    load().then(function () {
      if (!shown || !slot || !slot.isConnected) return;
      var old = slot.querySelector('[data-part="welcome"]');
      if (old) old.parentNode.removeChild(old);
      slot.insertBefore(build(), slot.firstChild);
    });
  }

  A.welcome = { mount: mount };
})();
