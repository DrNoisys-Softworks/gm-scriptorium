'use strict';

/*
 * Phase 8 slice S1, extended by panel v2 V1a. The panel shell: a tiny namespace other panel
 * scripts (store, icons, nav, frame, views, pack, vocab, images) register against. Text only,
 * never markup: setText() always goes through textContent (FR12).
 *
 * api() is the only fetch() in the admin panel (structural rule, shared design 1.5) and is now
 * also the store's single "tap": every response is passed to ST.stateFromResponse(), and when
 * that returns non-null (only ever a successful GET /api/state.../api/state?...), the store
 * mirrors it. This is the only way /api/state data enters the store; V1a adds no new request.
 * ST/store are read from window.ScriptoriumAdmin lazily (at call time, not at module-definition
 * time): this file executes first in script order (app, store, icons, nav, frame, ...), so
 * store.js has not run yet when this IIFE itself runs, but api() is only ever CALLED later, once
 * every deferred script has executed.
 */
(function () {
  /*
   * ADR 0050 section 4: the campaign this page was loaded for (the first good /api/session), sent
   * on every change request so the server can refuse a tab that is out of date. Once the server
   * has said the panel moved on (a 409 campaign-changed, or a GET that names another campaign),
   * the page is stale: a banner asks for a reload (campaigns.js listens for the event below), and
   * every later change request is answered here with a 409 and never sent.
   */
  var pageCampaign = null;
  var stale = null;

  function markStale(was, now) {
    if (stale) return;
    stale = { was: was, now: typeof now === 'string' ? now : null };
    document.dispatchEvent(new CustomEvent('scriptorium:stale', { detail: stale }));
  }

  /**
   * ADR 0052: the add page switches the panel itself (POST /api/campaigns/switch) and stays open to
   * build the new campaign's first preview. After that page's OWN successful switch it points itself
   * at the campaign it is now on, so the change requests that follow carry the right header and the
   * next read does not mark the page stale. A page that is already stale is never re-pointed: it
   * cannot be made current without a reload.
   *
   * @param {string} name
   * @returns {boolean} whether the page was re-pointed
   */
  function adopt(name) {
    if (stale || typeof name !== 'string') return false;
    pageCampaign = name;
    return true;
  }

  function isChange(method) {
    var m = String(method || 'GET').toUpperCase();
    return m !== 'GET' && m !== 'HEAD';
  }

  function isCampaignRead(path) {
    return path === '/api/session' || path === '/api/state' || path.indexOf('/api/state?') === 0;
  }

  function api(path, options) {
    var opts = Object.assign({ credentials: 'same-origin' }, options || {});
    var method = opts.method;
    if (isChange(method)) {
      if (stale) {
        return Promise.resolve({
          ok: false,
          status: 409,
          body: { error: 'campaign-changed', campaign: stale.now, message: 'This tab is out of date. Reload to continue.' },
        });
      }
      if (pageCampaign !== null) {
        opts.headers = Object.assign({}, opts.headers, { 'X-Scriptorium-Campaign': encodeURIComponent(pageCampaign) });
      }
    }
    return fetch(path, opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          var result = { ok: res.ok, status: res.status, body: body };
          if (res.ok && !isChange(method) && isCampaignRead(path) && body && typeof body.campaign === 'string') {
            if (pageCampaign === null && path === '/api/session') pageCampaign = body.campaign;
            else if (pageCampaign !== null && body.campaign !== pageCampaign) markStale(pageCampaign, body.campaign);
          } else if (res.status === 409 && body && body.error === 'campaign-changed') {
            markStale(pageCampaign, body.campaign);
          }
          var admin = window.ScriptoriumAdmin;
          if (admin && admin.ST && admin.store) {
            var state = admin.ST.stateFromResponse(path, method, result);
            if (state !== null) {
              // V1b SD-2: the tap takes full state only -- a body without both vocab and
              // palette (e.g. views.js's legacy plain /api/state reload after a preview build)
              // changes nothing, so it never wipes what the write screens already loaded.
              var patch = admin.ST.statePatch(state);
              if (patch) admin.store.set(patch);
            }
          }
          return result;
        });
    });
  }

  function el(tag) {
    return document.createElement(tag);
  }

  function setText(node, text) {
    node.textContent = text === undefined || text === null ? '' : String(text);
  }

  var sections = {};

  function register(section, init) {
    sections[section] = init;
  }

  function initSections(state) {
    Object.keys(sections).forEach(function (name) {
      var container = document.querySelector('[data-section="' + name + '"]');
      if (container) sections[name](container, state);
    });
  }

  /*
   * Boot sequence (shared design 1.1, extended V1e-2 SD-11): session, then the store's session
   * key, then GET /api/prefs (its result seeds the store's `prefs` before the frame's switchers
   * ever build, so they render already-pressed rather than flashing to the default first), then
   * the frame is built around <main> and its router starts, then the existing per-section init
   * runs -- by now every [data-section] element has already been moved into its home screen's
   * mount.
   */
  function boot() {
    // V1.5a: the sign-in page loads this file for api() alone. It has no session yet, so booting
    // here would only produce a console 403.
    if (document.body.getAttribute('data-page') === 'signin') return;
    // ADR 0028: browser setup loads this file for api() and el() alone, and drives its own page.
    if (document.body.getAttribute('data-page') === 'setup') return;
    api('/api/session').then(function (result) {
      if (!result.ok || !result.body) return;
      var session = result.body;
      var admin = window.ScriptoriumAdmin;
      admin.store.set({ session: session });
      api('/api/prefs').then(function (prefsResult) {
        var ok = prefsResult.ok && !!prefsResult.body;
        admin.store.set({
          prefs: ok ? prefsResult.body.prefs : admin.NV.PREF_DEFAULTS,
          prefsPersisted: ok ? prefsResult.body.persisted : false,
        });
        admin.frame.build(session);
        admin.frame.start();
        initSections(session);
        admin.store.load();
      });
    });
  }

  window.ScriptoriumAdmin = {
    api: api,
    el: el,
    setText: setText,
    register: register,
    adopt: adopt,
    /** The stale state ({ was, now }), or null while this page still matches the panel. */
    stale: function () {
      return stale;
    },
  };

  // Every script is `defer`, so every module has registered by the time DOMContentLoaded fires;
  // unconditional (no readyState check) is deliberate (shared design 1.1's boot note).
  document.addEventListener('DOMContentLoaded', boot);
})();
