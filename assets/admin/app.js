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
  function api(path, options) {
    var opts = Object.assign({ credentials: 'same-origin' }, options || {});
    var method = opts.method;
    return fetch(path, opts).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          var result = { ok: res.ok, status: res.status, body: body };
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

  window.ScriptoriumAdmin = { api: api, el: el, setText: setText, register: register };

  // Every script is `defer`, so every module has registered by the time DOMContentLoaded fires;
  // unconditional (no readyState check) is deliberate (shared design 1.1's boot note).
  document.addEventListener('DOMContentLoaded', boot);
})();
