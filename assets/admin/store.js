'use strict';

/*
 * Panel v2 V1a. ST: a tiny pure store (shared design 1.3), plus the browser singleton
 * ScriptoriumAdmin.store. stateFromResponse() is app.js's "tap": called on every api() response,
 * it returns /api/state's body (and only /api/state's) so the store mirrors it without V1a
 * adding any new request of its own.
 */
(function () {
  function createStore(initial) {
    var current = initial;
    var subscribers = [];

    function get() {
      return current;
    }

    function set(patch) {
      var prev = current;
      var next = Object.assign({}, current, patch);
      current = next;
      subscribers.slice().forEach(function (fn) {
        fn(next, prev);
      });
      return next;
    }

    function subscribe(fn) {
      subscribers.push(fn);
      return function unsubscribe() {
        var i = subscribers.indexOf(fn);
        if (i !== -1) subscribers.splice(i, 1);
      };
    }

    return { get: get, set: set, subscribe: subscribe };
  }

  /**
   * @param {string} pathAndQuery the request path, with query string if any
   * @param {string|undefined} method
   * @param {{ ok: boolean, status: number, body: any }} result
   * @returns {any|null} result.body, only for a successful GET (or method-unset) request to
   *   exactly /api/state or /api/state?..., with a non-null body; null otherwise.
   */
  function stateFromResponse(pathAndQuery, method, result) {
    if (typeof pathAndQuery !== 'string') return null;
    if (method !== undefined && method !== 'GET') return null;
    var isStatePath = pathAndQuery === '/api/state' || pathAndQuery.indexOf('/api/state?') === 0;
    if (!isStatePath) return null;
    if (!result || result.ok !== true) return null;
    if (result.body === null || result.body === undefined) return null;
    return result.body;
  }

  /*
   * V1b SD-3/interfaces (ST additions): pure helpers for the write screens' per-file base sha,
   * the tap's "full state" test, save-result application and the nav's pending-count badges.
   * Stub only: test/admin-store-v1b.test.js drives the real implementation in the C3 commit.
   */

  function fileShas(body) {
    var packToml = (body && body.packToml) || {};
    var vaultConfigJson = (body && body.vaultConfigJson) || {};
    var shas = {
      'pack.toml': packToml.exists ? packToml.sha256 : null,
      'vault.config.json': vaultConfigJson.exists ? vaultConfigJson.sha256 : null,
    };
    // V1e-1 (SD-7): only added when the response actually carries ?include=vaultconfig's own key,
    // so the frozen 2-key literals at admin-store-v1b.test.js stay green unedited.
    if (body && Object.prototype.hasOwnProperty.call(body, 'vaultConfigFile')) {
      var vcf = body.vaultConfigFile || {};
      shas['vault-config.md'] = vcf.exists ? vcf.sha256 : null;
    }
    return shas;
  }

  function isFullState(body) {
    return (
      !!body &&
      Object.prototype.hasOwnProperty.call(body, 'vocab') &&
      Object.prototype.hasOwnProperty.call(body, 'palette')
    );
  }

  function statePatch(body) {
    if (!isFullState(body)) return null;
    return { state: body, files: fileShas(body) };
  }

  var SHA256_RE = /^[0-9a-f]{64}$/;

  function applySaveResult(files, body) {
    var next = Object.assign({}, files);
    if (!body || body.ok !== true) return next;
    // V1e-1 (SD-7): exact equality only -- '../vault-config.md', 'vault-config.mdx' and
    // '_meta/vault-config.md' must never be accepted (E24: no startsWith/indexOf check).
    if (body.file !== 'pack.toml' && body.file !== 'vault.config.json' && body.file !== 'vault-config.md') return next;
    if (typeof body.sha256 !== 'string' || !SHA256_RE.test(body.sha256)) return next;
    next[body.file] = body.sha256;
    return next;
  }

  // V1e-2 (SD-10, SD-11): pure merge helper for the store's `prefs` object -- the optimistic-set
  // half of store.setPref, kept separate from the POST so it is unit-testable without a fetch.
  function withPref(prefs, key, value) {
    var next = Object.assign({}, prefs);
    next[key] = value;
    return next;
  }

  function withPending(pending, id, n) {
    var next = Object.assign({}, pending);
    if (n <= 0) {
      delete next[id];
    } else {
      next[id] = n;
    }
    return next;
  }

  function pendingTotal(pending) {
    var total = 0;
    Object.keys(pending || {}).forEach(function (id) {
      total += pending[id];
    });
    return total;
  }

  /*
   * V1b SD-8 (the busy contract): a pure predicate over the store's `busy` value, so the boolean
   * logic itself is unit-testable under plain node (the DOM wiring that reads and reacts to it
   * needs a live browser -- see the Playwright evidence in the QA gate record). Stub only: the
   * real implementation lands with the true-red test.
   */
  function isBusy(busy) {
    return busy !== null;
  }

  /*
   * V1c SD-5 (FR-20 busy): the busy-status line's text for a given store.busy value, or null
   * when there is nothing to show (busy === null, an unset value, or a value frame.js/views.js
   * never sets). An own-property-only lookup (mirrors outcome.js's BUSY_LABEL, M9 in the V1b
   * brief / M7 here): an object-lookup implementation would resolve 'constructor' to
   * Object.prototype.constructor, which is truthy.
   */
  var BUSY_LINES = {
    check: 'The panel pauses while a check runs.',
    build: 'The panel pauses while the preview build runs.',
  };

  function busyLine(busy) {
    return Object.prototype.hasOwnProperty.call(BUSY_LINES, busy) ? BUSY_LINES[busy] : null;
  }

  var ST = {
    createStore: createStore,
    stateFromResponse: stateFromResponse,
    fileShas: fileShas,
    isFullState: isFullState,
    statePatch: statePatch,
    applySaveResult: applySaveResult,
    withPref: withPref,
    withPending: withPending,
    pendingTotal: pendingTotal,
    isBusy: isBusy,
    busyLine: busyLine,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { ST: ST };
    return;
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.store = ST.createStore({
    session: null,
    state: null,
    route: null,
    sheetOpen: false,
    files: {},
    pending: {},
    busy: null,
    loadError: null,
    // V1e-2 (SD-10): the panel-layout preferences GET /api/prefs loads at boot, before frame.build
    // (app.js). null until that first GET resolves; frame.js's switcher build reads it via
    // NV.viewFor, which already falls back to PREF_DEFAULTS for a still-null prefs object.
    prefs: null,
    prefsPersisted: false,
    prefsNote: null,
    // V1e-3 (SD-20, SD-22): the current viewport class ('wide'|'laptop'|'phone'), set by
    // frame.build() before the first paint and kept live by wirePaneViewportListeners. null only
    // before frame.build() has ever run.
    viewport: null,
    // V1e-3 (SD-24): {screen, role} a screen produces when the focused field's page role changes,
    // for the ov2 split's "Follow what I'm editing" to act on. null when nothing is focused.
    followHint: null,
    // V1e-9 (SD-102): true while vc1's editing session is open (the switch is on). Never
    // persisted (FR-46): closure state only, reset to false on every page load.
    vcEditing: false,
  });
  window.ScriptoriumAdmin.ST = ST;

  // SD-3: the write screens' one GET /api/state?include=vocab,palette load. On a failed
  // response this sets loadError; a successful response's {state, files} patch is already
  // applied by app.js's tap (every api() response passes through ST.statePatch), so there is
  // nothing more to do here on success beyond clearing a previous loadError.
  window.ScriptoriumAdmin.store.load = function () {
    // V1e-1 (SD-7): vaultconfig appended alongside vocab and palette. V1e-3 (SD-19): previewinfo
    // appended last, after vaultconfig. V1e-9 (SD-99): vaultconfigeditor appended last, after
    // previewinfo. V1e-7 (SD-64): variants appended last, after vaultconfigeditor.
    return window.ScriptoriumAdmin.api('/api/state?include=vocab,palette,vaultconfig,previewinfo,vaultconfigeditor,variants').then(function (result) {
      if (!result.ok || !result.body) {
        window.ScriptoriumAdmin.store.set({ loadError: 'Could not load the panel state.' });
        return;
      }
      window.ScriptoriumAdmin.store.set({ loadError: null });
    });
  };

  // SD-6: dryBody's baseSha256, keyed by exactly the two file names ST.fileShas/applySaveResult
  // use. Read from store.files rather than re-deriving from store.state, so an immediate
  // applySaveResult() after a save is what the very next save reads (store.load()'s own
  // response can land later, per SS13's residual on out-of-order full-state reloads).
  window.ScriptoriumAdmin.store.baseSha = function (file) {
    var files = window.ScriptoriumAdmin.store.get().files || {};
    return Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null;
  };

  // SD-8: the busy contract's single shared helper. Every run/save control (pack.js, vocab.js,
  // images.js, slip.js) computes its own `disabled` as `ownState || store.isBusy()`. Nothing in
  // V1b ever sets `busy` (that is V1c's job, per FR-20's contract, Part 0 item 14 of the shared
  // design notes); this only reads it.
  window.ScriptoriumAdmin.store.isBusy = function () {
    return ST.isBusy(window.ScriptoriumAdmin.store.get().busy);
  };

  // V1e-2 (SD-10, SD-11): sets one preference. Optimistic: the store updates immediately (so the
  // switcher/edge tab/etc. feel instant), then POSTs. On success the server's own effective prefs
  // object replaces the optimistic guess (it is the same value unless another tab/process raced
  // it). On failure the optimistic choice is KEPT (D-15/FR-12: "it applies until the panel
  // closes"), with prefsNote set so the UI can say it wasn't saved.
  window.ScriptoriumAdmin.store.setPref = function (key, value) {
    var admin = window.ScriptoriumAdmin;
    var current = admin.store.get().prefs || admin.NV.PREF_DEFAULTS;
    admin.store.set({ prefs: admin.ST.withPref(current, key, value), prefsNote: null });
    return admin.api('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, value: value }) }).then(
      function (result) {
        if (result.ok && result.body) {
          admin.store.set({ prefs: result.body.prefs, prefsPersisted: true, prefsNote: null });
        } else {
          admin.store.set({ prefsNote: "This layout applies until the panel closes. It couldn't be saved on this computer." });
        }
      },
    );
  };

  // SD-3: beforeunload blocks while there are pending edits, except right after the slip's
  // deliberate Reload, which calls allowUnload() first.
  var unloadAllowed = false;
  window.ScriptoriumAdmin.store.allowUnload = function () {
    unloadAllowed = true;
  };
  window.addEventListener('beforeunload', function (ev) {
    if (unloadAllowed) return;
    if (ST.pendingTotal(window.ScriptoriumAdmin.store.get().pending) > 0) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
})();
