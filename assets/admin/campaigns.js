'use strict';

/*
 * ADR 0050: several campaigns in one panel. Three things live here: the campaign switcher (the
 * crest and name at the top of the side bar, and of the top bar at 390 wide, become its trigger),
 * the Campaigns screen (set as default, remove from GM-Scriptorium) and the banner a tab shows
 * when the panel has moved to another campaign. Browser only. Every string is written with
 * textContent, every element is built with createElement (FR12); the only request path is
 * ScriptoriumAdmin.api().
 *
 * What the server decides stays the server's: a failed switch shows the server's own message, and
 * a change that carries a stale config sha is refused there. This file only asks. The unsaved
 * changes check reads the same pending-edits count the nav's dots and the leave-the-page guard
 * already read (store.pending), so any form that reports its edits there is covered.
 */
(function () {
  var A = window.ScriptoriumAdmin;
  var el = A.el;
  var setText = A.setText;

  var data = null; // { campaigns, configSha256, switchable, lockedReason } once the server has answered
  var loadError = null;
  var failed = null; // { name, message } from the last refused switch
  var busyName = null; // the campaign a switch is waiting on
  var flash = null; // one line after set as default or remove
  var screenMessage = null; // a refusal from set as default or remove
  var switchers = []; // { wrap, trigger, pop, chevHolder }

  function store() {
    return A.store;
  }

  function currentCampaign() {
    var s = store() && store().get().session;
    return (s && s.campaign) || '';
  }

  function pendingCount() {
    var s = store().get();
    return A.ST.pendingTotal(s.pending || {});
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function add(parent, tag, className, text) {
    var n = el(tag);
    if (className) n.className = className;
    if (text !== undefined) setText(n, text);
    parent.appendChild(n);
    return n;
  }

  function pill(parent, kind, text) {
    return add(parent, 'span', 'a1-pill ' + kind, text);
  }

  // ---------------------------------------------------------------------------------------------
  // data
  // ---------------------------------------------------------------------------------------------

  function load() {
    return A.api('/api/campaigns').then(function (r) {
      if (r.ok && r.body && Array.isArray(r.body.campaigns)) {
        data = r.body;
        loadError = null;
      } else {
        loadError = (r.body && r.body.message) || 'The campaign list could not be read.';
      }
      renderAll();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // the confirm dialogs (one shape for "remove" and for "unsaved changes")
  // ---------------------------------------------------------------------------------------------

  /**
   * @param {{ title: string, lead: string, extra?: string, cancel: string, go: string, danger?: boolean, icon?: string }} spec
   * @returns {Promise<boolean>}
   */
  function confirmDialog(spec) {
    return new Promise(function (resolve) {
      var dialog = el('dialog');
      dialog.className = 'cs-dialog';
      dialog.setAttribute('aria-labelledby', 'cs-dt');
      dialog.setAttribute('aria-describedby', 'cs-dd');
      var body = add(dialog, 'div', 'cs-dbody');
      var h2 = add(body, 'h2', '', spec.title);
      h2.id = 'cs-dt';
      var lead = add(body, 'p', 'lead', spec.lead);
      lead.id = 'cs-dd';
      if (spec.extra) add(body, 'p', '', spec.extra);
      var btns = add(body, 'div', 'cs-dbtns');
      var cancel = add(btns, 'button', 'a1-btn', spec.cancel);
      cancel.type = 'button';
      var go = el('button');
      go.type = 'button';
      go.className = spec.danger ? 'a1-btn danger' : 'a1-btn';
      if (spec.icon) go.appendChild(A.icon(spec.icon));
      go.appendChild(document.createTextNode(spec.go));
      btns.appendChild(go);
      var answer = false;
      var back = document.activeElement;
      cancel.addEventListener('click', function () {
        dialog.close();
      });
      go.addEventListener('click', function () {
        answer = true;
        dialog.close();
      });
      dialog.addEventListener('close', function () {
        if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
        if (back && back.isConnected && typeof back.focus === 'function') back.focus();
        resolve(answer);
      });
      document.body.appendChild(dialog);
      dialog.showModal();
      cancel.focus();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // the switcher
  // ---------------------------------------------------------------------------------------------

  function lockedReason() {
    return data && data.switchable === false ? data.lockedReason || '' : '';
  }

  function messageBlock(parent, kind, iconName, text, id) {
    var box = add(parent, 'div', 'cs-msg' + (kind ? ' ' + kind : ''));
    if (id) box.id = id;
    if (kind !== 'is-lock' && kind !== 'is-info') box.setAttribute('role', 'alert');
    else if (kind === 'is-info') box.setAttribute('role', 'status');
    box.appendChild(A.icon(iconName));
    add(box, 'p', '', text);
    return box;
  }

  function renderPop(sw) {
    var pop = sw.pop;
    clear(pop);
    add(pop, 'div', 'cs-pop-h', 'Campaigns');
    var reason = lockedReason();
    if (reason) messageBlock(pop, 'is-lock', 'lock', reason, 'cs-lock-' + sw.which);
    if (!data) {
      if (loadError) messageBlock(pop, '', 'warn', loadError);
      else add(pop, 'div', 'cs-pop-h', 'Loading…');
    } else {
      var list = add(pop, 'ul', 'cs-list');
      data.campaigns.forEach(function (c) {
        var li = add(list, 'li');
        var row = el('button');
        row.type = 'button';
        row.setAttribute('data-campaign', c.name);
        var cls = 'cs-row';
        if (failed && failed.name === c.name) {
          cls += ' is-failed';
          row.setAttribute('aria-describedby', 'cs-fail');
        }
        if (busyName === c.name) cls += ' is-busy';
        row.className = cls;
        var name = add(row, 'span', 'cs-name', c.name);
        name.title = c.name;
        var tags = add(row, 'span', 'cs-tags');
        if (c.isDefault) pill(tags, 'brass', 'Default');
        if (c.readOnly) pill(tags, 'muted', 'Read-only');
        if (c.active) {
          row.setAttribute('aria-current', 'true');
          var tick = A.icon('tick');
          tick.setAttribute('class', 'ico cs-tick');
          row.appendChild(tick);
          add(row, 'span', 'visually-hidden', 'current campaign');
        } else if (reason) {
          row.setAttribute('aria-disabled', 'true');
        } else if (busyName === c.name) {
          var spin = add(row, 'span', 'cs-spin');
          spin.setAttribute('role', 'status');
          spin.setAttribute('aria-label', 'Looking for the vault');
        }
        row.addEventListener('click', function () {
          if (c.active || reason || busyName) return;
          chooseCampaign(c.name);
        });
        li.appendChild(row);
      });
    }
    if (busyName) {
      messageBlock(pop, 'is-info', 'info', 'Looking for the vault of "' + busyName + '". The panel stays on "' + currentCampaign() + '" until it answers.');
    }
    if (failed) messageBlock(pop, '', 'warn', failed.message, 'cs-fail');
    var foot = add(pop, 'div', 'cs-foot');
    var manage = add(foot, 'a', '', 'Manage campaigns');
    manage.href = A.NV.hrefFor('campaigns');
    manage.addEventListener('click', function () {
      closeAll(false);
    });
  }

  function renderTrigger(sw) {
    var locked = Boolean(lockedReason());
    if (locked) sw.trigger.setAttribute('aria-disabled', 'true');
    else sw.trigger.removeAttribute('aria-disabled');
    clear(sw.chevHolder);
    var icon = A.icon(locked ? 'lock' : 'chevd');
    icon.setAttribute('class', 'ico cs-chev');
    sw.chevHolder.appendChild(icon);
    setText(sw.hint, locked ? ', switching is off' : ', switch campaign');
    if (locked) sw.trigger.setAttribute('aria-describedby', 'cs-lock-' + sw.which);
    else sw.trigger.removeAttribute('aria-describedby');
  }

  function closeAll(refocus) {
    switchers.forEach(function (sw) {
      if (sw.pop.hidden) return;
      sw.pop.hidden = true;
      sw.trigger.setAttribute('aria-expanded', 'false');
      if (refocus) sw.trigger.focus();
    });
  }

  function toggle(sw) {
    if (!sw.pop.hidden) {
      closeAll(false);
      return;
    }
    closeAll(false);
    sw.pop.hidden = false;
    sw.trigger.setAttribute('aria-expanded', 'true');
    renderPop(sw);
    load();
  }

  function wrapBrand(brand, which) {
    var wrap = el('div');
    wrap.className = 'cs-wrap';
    brand.parentNode.insertBefore(wrap, brand);
    var trigger = el('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    var popId = 'cs-pop-' + which;
    trigger.setAttribute('aria-controls', popId);
    trigger.appendChild(brand);
    var hint = add(trigger, 'span', 'visually-hidden', ', switch campaign');
    var chevHolder = add(trigger, 'span', 'cs-chevwrap');
    wrap.appendChild(trigger);
    var pop = el('div');
    pop.className = 'cs-pop';
    pop.id = popId;
    pop.hidden = true;
    pop.setAttribute('role', 'group');
    pop.setAttribute('aria-label', 'Campaigns');
    wrap.appendChild(pop);
    var sw = { wrap: wrap, trigger: trigger, pop: pop, chevHolder: chevHolder, hint: hint, which: which };
    trigger.addEventListener('click', function () {
      toggle(sw);
    });
    switchers.push(sw);
    renderTrigger(sw);
    return sw;
  }

  function chooseCampaign(name) {
    if (pendingCount() > 0) {
      confirmDialog({
        title: 'Switch campaigns?',
        lead: 'You have unsaved changes on this page. Switch anyway?',
        cancel: 'Stay',
        go: 'Switch',
      }).then(function (ok) {
        if (ok) doSwitch(name);
      });
      return;
    }
    doSwitch(name);
  }

  function refusalText(r) {
    var b = r.body || {};
    if (typeof b.message === 'string' && b.message) return b.message;
    if (b.error === 'busy') return 'The panel is busy with another task. Try again in a moment.';
    return 'The panel could not switch campaigns.';
  }

  function doSwitch(name) {
    failed = null;
    busyName = name;
    renderAll();
    A.api('/api/campaigns/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).then(function (r) {
      busyName = null;
      if (r.ok && r.body && r.body.switched === true) {
        // Nothing of the old campaign may stay on screen: land on the Overview, freshly loaded.
        history.replaceState(null, '', location.pathname + location.search + '#/overview');
        location.reload();
        return;
      }
      if (r.status === 409 && r.body && r.body.error === 'campaign-changed') {
        renderAll();
        return;
      }
      failed = { name: name, message: refusalText(r) };
      renderAll();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // the Campaigns screen
  // ---------------------------------------------------------------------------------------------

  function pathLine(dl, label, value) {
    add(dl, 'dt', '', label);
    var dd = add(dl, 'dd');
    if (value) add(dd, 'code', '', value);
    else add(dd, 'span', 'cs-none', 'not set');
  }

  function actButton(parent, act, label, iconName, extraClass) {
    var b = el('button');
    b.type = 'button';
    b.className = 'a1-btn small' + (extraClass ? ' ' + extraClass : '');
    b.setAttribute('data-act', act);
    if (iconName) b.appendChild(A.icon(iconName));
    b.appendChild(document.createTextNode(label));
    parent.appendChild(b);
    return b;
  }

  function renderScreen() {
    var mount = A.mount && A.mount('campaigns');
    if (!mount) return;
    clear(mount);
    var root = add(mount, 'section');
    root.setAttribute('data-part', 'campaigns');
    var reason = lockedReason();
    if (reason) messageBlock(root, 'is-lock', 'lock', reason).classList.add('cs-top');
    if (screenMessage) messageBlock(root, '', 'warn', screenMessage).classList.add('cs-top');
    if (failed && !busyName) messageBlock(root, '', 'warn', failed.message).classList.add('cs-top');
    if (flash) {
      var f = add(root, 'div', 'cs-flash');
      f.setAttribute('role', 'status');
      f.appendChild(A.icon('tick'));
      add(f, 'span', '', flash);
    }
    if (!data) {
      add(root, 'p', 'cs-fine', loadError || 'Loading…');
      return;
    }
    var list = add(root, 'ul', 'cs-cards');
    list.setAttribute('aria-label', 'Campaigns');
    data.campaigns.forEach(function (c) {
      var li = add(list, 'li', 'cs-card' + (c.active ? ' is-active' : ''));
      li.setAttribute('data-campaign', c.name);
      var head = add(li, 'div', 'cs-card-main');
      add(head, 'div', 'cs-card-name', c.name);
      var tags = add(head, 'div', 'cs-card-tags');
      if (c.active) pill(tags, 'sage', 'Active');
      if (c.isDefault) pill(tags, 'brass', 'Default');
      if (c.readOnly) pill(tags, 'muted', 'Read-only');
      var dl = add(head, 'dl', 'cs-paths');
      pathLine(dl, 'Vault', c.vault);
      pathLine(dl, 'Output', c.output);
      var acts = add(li, 'div', 'cs-card-act');
      if (!c.active) {
        var sw = actButton(acts, 'switch', 'Switch to', 'swap');
        if (reason || busyName) {
          sw.disabled = true;
          sw.setAttribute('aria-disabled', 'true');
        }
        sw.addEventListener('click', function () {
          chooseCampaign(c.name);
        });
      }
      if (c.isDefault) {
        var d = actButton(acts, 'default', 'Default campaign', 'tick', 'ghost');
        d.disabled = true;
        d.setAttribute('aria-disabled', 'true');
      } else {
        var dflt = actButton(acts, 'default', 'Set as default', null, 'ghost');
        dflt.addEventListener('click', function () {
          setDefault(c.name);
        });
      }
      var rm = actButton(acts, 'remove', 'Remove from GM-Scriptorium', 'trash', 'cs-remove');
      if (c.active) {
        rm.disabled = true;
        rm.setAttribute('aria-disabled', 'true');
        rm.setAttribute('aria-describedby', 'cs-why');
        var why = add(li, 'p', 'cs-hint is-right', 'Switch to another campaign first.');
        why.id = 'cs-why';
      } else {
        rm.addEventListener('click', function () {
          askRemove(c);
        });
      }
    });
    add(root, 'p', 'cs-fine', 'The campaign marked Default is the one GM-Scriptorium opens when you do not name one.');
  }

  function afterWrite(r, okFlash) {
    if (r.ok && r.body && r.body.ok === true) {
      flash = okFlash;
      screenMessage = null;
    } else {
      flash = null;
      screenMessage = refusalText(r);
    }
    return load();
  }

  function setDefault(name) {
    A.api('/api/campaigns/default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, configSha256: data.configSha256 }),
    }).then(function (r) {
      afterWrite(r, 'Default campaign is now "' + name + '". The panel is still on "' + currentCampaign() + '".');
    });
  }

  function askRemove(c) {
    confirmDialog({
      title: 'Remove "' + c.name + '" from GM-Scriptorium?',
      lead: "This only takes it off GM-Scriptorium's list. The vault, pack, output and backups stay where they are.",
      extra: c.isDefault ? 'It is the default campaign, so GM-Scriptorium will have no default until you set one.' : '',
      cancel: 'Cancel',
      go: 'Remove from GM-Scriptorium',
      danger: true,
      icon: 'trash',
    }).then(function (ok) {
      if (!ok) return;
      A.api('/api/campaigns/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name, configSha256: data.configSha256 }),
      }).then(function (r) {
        afterWrite(r, 'Removed "' + c.name + "\" from GM-Scriptorium's list. Nothing on disk was touched.");
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // a tab that is out of date
  // ---------------------------------------------------------------------------------------------

  function showStale() {
    var s = A.stale();
    var main = document.querySelector('[data-role="main"]');
    if (!s || !main || main.querySelector('.cs-stale')) return;
    document.body.setAttribute('data-stale', '');
    var banner = el('div');
    banner.className = 'cs-stale';
    banner.setAttribute('role', 'alert');
    banner.appendChild(A.icon('warn'));
    var p = add(banner, 'p');
    p.appendChild(document.createTextNode('This tab was showing '));
    add(p, 'b', '', s.was || 'another campaign');
    p.appendChild(document.createTextNode('. The panel is now on '));
    add(p, 'b', '', s.now || 'another campaign');
    p.appendChild(document.createTextNode('. Reload to continue.'));
    var reload = el('button');
    reload.type = 'button';
    reload.className = 'a1-btn primary small';
    reload.setAttribute('data-cs-reload', '');
    reload.appendChild(A.icon('refresh'));
    reload.appendChild(document.createTextNode('Reload'));
    reload.addEventListener('click', function () {
      location.reload();
    });
    banner.appendChild(reload);
    main.insertBefore(banner, main.firstChild);
    // Nothing that would change or build anything can be pressed until the tab is reloaded.
    var buttons = main.querySelectorAll('button, a.a1-btn');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i] === reload) continue;
      if (buttons[i].tagName === 'BUTTON') buttons[i].disabled = true;
      buttons[i].setAttribute('aria-disabled', 'true');
    }
    closeAll(false);
  }

  document.addEventListener('scriptorium:stale', showStale);

  // ---------------------------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------------------------

  function renderAll() {
    switchers.forEach(function (sw) {
      renderTrigger(sw);
      if (!sw.pop.hidden) renderPop(sw);
    });
    renderScreen();
  }

  function mount() {
    var brands = document.querySelectorAll('[data-role="brand-title"]');
    for (var i = 0; i < brands.length; i++) {
      wrapBrand(brands[i], brands[i].closest('[data-role="top-bar"]') ? 'top' : 'side');
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (document.querySelector('dialog.cs-dialog[open]')) return;
      var any = switchers.some(function (sw) {
        return !sw.pop.hidden;
      });
      if (any) closeAll(true);
    });
    document.addEventListener('click', function (ev) {
      // composedPath() is fixed when the click starts, so a row that a click handler has already
      // re-rendered away still counts as inside the switcher.
      var path = ev.composedPath();
      switchers.forEach(function (sw) {
        if (!sw.pop.hidden && path.indexOf(sw.wrap) === -1) closeAll(false);
      });
    });
    store().subscribe(function (next, prev) {
      if (next.route !== prev.route && next.route && next.route.screen === 'campaigns') {
        flash = null;
        screenMessage = null;
        load();
      }
    });
    load();
    showStale();
  }

  A.campaigns = { mount: mount, reload: load };
})();
