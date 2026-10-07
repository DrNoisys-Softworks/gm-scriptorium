'use strict';

/*
 * V1e-7 (ADR 0039, SD-67). VR: the pure half (the VB/PV pattern, vocab.js:20-108,
 * sitepane.js:17-212) -- unit-testable under plain node, no DOM. The browser half
 * (ScriptoriumAdmin.variants) follows the guard: the theme strip, card regions (a live frame
 * plus page tabs per theme card), the full-size lightbox, the review's before/after slip shots,
 * the sequential build round, and the one shared busy-aware button helper.
 *
 * No iframe is created in this file: every frame comes from assets/admin/sitepane.js's
 * `sitePane.frame`/`sitePane.pointFrame`, the sole frame factory (security review chokepoint).
 */
(function () {
  var PV = typeof module === 'object' && module.exports ? require('./sitepane').PV : window.ScriptoriumAdmin.PV;

  // ===============================================================================================
  // VR: pure (above the guard)
  // ===============================================================================================

  var THEME_TABS = ['landing', 'character', 'timeline'];

  // Independent literal, equal to sitepane.js:125-129's SAVED_WORDS (drift-tested, not required
  // from sitepane.js, precisely so this pure section has no load-order dependency on it).
  var SAVED_WORDS = {
    'pack.toml': 'theme, images or words',
    'vault.config.json': 'the site title',
    'vault-config.md': 'the tagline or vault settings',
  };
  var COUNTER_ONLY_WORDS = 'other changes saved in the panel';

  var EVICTED_NOTE = 'Your site is too big to keep a preview in every theme at once, so the oldest were removed to save space.';

  var CARD_COPY = {
    none: 'Not built yet',
    building: 'Building this theme',
    stale: 'Built before your last save',
    missingPage: "This page isn't in your site.",
  };

  // V1e-8 (ADR 0039 addendum, SD-72). The vo2 example's own copy literals and state.
  var EXAMPLE_COPY = {
    noEdits: 'No unsaved changes, so this is what players see now.',
    none: 'Update example builds your saved site with these unsaved words, privately on this computer. The panel pauses while it builds.',
    outdated: 'This example is from before your latest edits. Update example to see them.',
    current: "Built HH:MM from your saved site plus this screen's unsaved edits.",
    fine: 'Click into any field and the example follows it.',
    nowEmptyHead: 'No preview built yet',
    nowEmptyText: 'Build preview to see what players see now.',
    missing: {
      timeline: 'This site has no Timeline page to show.',
      character: 'This site has no character page to show.',
      recap: 'This site has no session recap to show.',
    },
  };

  /**
   * @param {{built:boolean,stale:boolean}|null} item the vocab variants item (state.variants
   *   items, the id==='vocab' one)
   * @param {string|null} builtPayloadJson the payload JSON the item currently showing was built
   *   from (a module-level record kept by buildVocab, below), or null before any build this
   *   session
   * @param {string} payloadJson the CURRENT form's own JSON.stringify(buildPayload())
   * @returns {'no-edits'|'none'|'outdated'|'current'}
   */
  function exampleState(item, builtPayloadJson, payloadJson) {
    if (payloadJson === '{}') return 'no-edits';
    if (!item || !item.built) return 'none';
    if (builtPayloadJson !== payloadJson || item.stale === true) return 'outdated';
    return 'current';
  }

  /** @param {{items:Array}|null|undefined} info state.variants @returns {Array} items whose theme !== null */
  function themeItems(info) {
    return (info && info.items ? info.items : []).filter(function (it) {
      return it.theme !== null;
    });
  }

  /**
   * An exact `find` on `item.pages` (never an object/property lookup -- safe for any `role`
   * string, including `constructor`/`__proto__`).
   *
   * @param {{pages:Array<{role:string,rel:string}>}|null} item
   * @param {string} role
   * @returns {string|null}
   */
  function pageRel(item, role) {
    var pages = (item && item.pages) || [];
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].role === role) return pages[i].rel;
    }
    return null;
  }

  /**
   * @param {{built:boolean, builtAt:string}} item
   * @param {{active:boolean, current:string|null}|null} round
   * @param {string} name this card's theme name
   * @returns {'building'|'none'|'stale'|'fresh'}
   */
  function cardState(item, round, name) {
    if (round && round.active && round.current === name) return 'building';
    if (!item || !item.built) return 'none';
    return item.stale ? 'stale' : 'fresh';
  }

  /**
   * @param {{items:Array}|null|undefined} info state.variants
   * @param {{active:boolean, index:number, total:number, current:string|null}|null} round
   * @param {(iso:string)=>string} timeOf e.g. ScriptoriumAdmin.VW.timeOf
   * @param {boolean} packExists state.packToml.exists (Amendment A / DV-E76)
   * @returns {{state:string, text:string}}
   */
  function stripState(info, round, timeOf, packExists) {
    if (packExists === false) {
      return { state: 'no-pack', text: 'Save a theme first; that creates pack.toml. Theme previews need it.' };
    }
    if (round && round.active) {
      return {
        state: 'building',
        text: 'Building ' + round.current + ' (' + round.index + ' of ' + round.total + '). The panel pauses while each one builds.',
      };
    }

    var items = themeItems(info);
    var built = items.filter(function (it) {
      return it.built;
    });
    if (built.length === 0) {
      return {
        state: 'none',
        text: "Your own site, built once in each theme, shows on these cards. That's one build per theme, and the panel pauses while each one runs.",
      };
    }

    var stale = built.filter(function (it) {
      return it.stale;
    });
    if (stale.length > 0) {
      var oldest = built.reduce(function (a, b) {
        return a.builtAt < b.builtAt ? a : b;
      });
      var union = {};
      stale.forEach(function (it) {
        (it.savedSince || []).forEach(function (f) {
          union[f] = true;
        });
      });
      var keys = Object.keys(union);
      var words =
        keys.length > 0
          ? keys
              .map(function (f) {
                return Object.prototype.hasOwnProperty.call(SAVED_WORDS, f) ? SAVED_WORDS[f] : f;
              })
              .join(', ')
          : COUNTER_ONLY_WORDS;
      return { state: 'stale', text: 'Built ' + timeOf(oldest.builtAt) + '. Saved since: ' + words + '.' };
    }

    var missing = items.filter(function (it) {
      return !it.built;
    });
    if (missing.length > 0) {
      return { state: 'partial', text: "Some themes aren't built yet." };
    }

    var newest = built.reduce(function (a, b) {
      return a.builtAt > b.builtAt ? a : b;
    });
    return { state: 'ready', text: 'Built ' + timeOf(newest.builtAt) + ' from everything saved, privately on this computer.' };
  }

  /**
   * @param {{kind:string, message:string|undefined}} outcome ScriptoriumAdmin.VW.previewOutcome's shape
   * @returns {string}
   */
  function roundErrorText(outcome) {
    if (!outcome) return '';
    if (outcome.kind === 'refused-check') {
      return "Check found errors in your vault, so theme previews weren't built. Open Check to see them.";
    }
    if (outcome.kind === 'refused-scan') {
      return "The leak check stopped a preview build, so theme previews weren't built. Open Preview to see why.";
    }
    return outcome.message;
  }

  var VR = {
    THEME_TABS: THEME_TABS,
    SAVED_WORDS: SAVED_WORDS,
    COUNTER_ONLY_WORDS: COUNTER_ONLY_WORDS,
    EVICTED_NOTE: EVICTED_NOTE,
    CARD_COPY: CARD_COPY,
    themeItems: themeItems,
    pageRel: pageRel,
    cardState: cardState,
    stripState: stripState,
    roundErrorText: roundErrorText,
    // V1e-8 additions (SD-72):
    EXAMPLE_COPY: EXAMPLE_COPY,
    exampleState: exampleState,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { VR: VR };
    return;
  }

  // ===============================================================================================
  // Browser half: ScriptoriumAdmin.variants
  // ===============================================================================================

  var store = ScriptoriumAdmin.store;
  var el = ScriptoriumAdmin.el;
  var setText = ScriptoriumAdmin.setText;
  var icon = ScriptoriumAdmin.icon;
  var api = ScriptoriumAdmin.api;

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** Round state. Plain module-level mutable data, the sitepane.js `ov1LastRel`-style precedent. */
  var round = { active: false, index: 0, total: 0, current: null, evicted: [], error: null };

  /** This card's current page role, per theme name. Module map, default 'landing' when absent. */
  var cardPage = {};

  function findItem(items, name) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === name) return items[i];
    }
    return null;
  }

  function currentVariantsInfo() {
    var s = store.get();
    return (s.state && s.state.variants) || null;
  }

  function currentPackExists() {
    var s = store.get();
    return !!(s.state && s.state.packToml && s.state.packToml.exists);
  }

  // V1e-8 (ADR 0039 addendum, SD-72): the main preview's own freshness/pages, for vo2's "Now".
  function currentPreviewInfo() {
    var s = store.get();
    return (s.state && s.state.previewInfo) || null;
  }

  // -- Region refresh: each region re-renders itself in place (sitepane.js's registerMount /
  // refreshAllMounted pattern) -----------------------------------------------------------------

  var regions = [];

  function registerRegion(key, node, rebuild) {
    regions = regions.filter(function (r) {
      return r.node.isConnected && r.key !== key;
    });
    regions.push({ key: key, node: node, rebuild: rebuild });
  }

  function refreshRegions() {
    regions = regions.filter(function (r) {
      return r.node.isConnected;
    });
    regions.forEach(function (r) {
      r.rebuild();
    });
  }

  function regionSignature() {
    var info = currentVariantsInfo();
    var items = (info && info.items) || [];
    var itemSig = items
      .map(function (it) {
        return it.id + ':' + it.builtAt + ':' + it.stale;
      })
      .join(',');
    var roundSig = [round.active, round.index, round.current, round.evicted.join('|'), round.error].join(':');
    return itemSig + '||' + roundSig;
  }

  var lastSignature = null;

  /** A store-driven fallback refresh (e.g. a save elsewhere making a copy stale), independent of
   * the round loop's own direct refreshRegions() calls below. Page-tab clicks never go through
   * either path -- they move an existing frame in place. */
  store.subscribe(function () {
    var sig = regionSignature();
    if (sig !== lastSignature) {
      lastSignature = sig;
      refreshRegions();
    }
  });

  // -- The shared busy-aware button helper (the only place this file reads busy) ----------------

  function variantBtn(opts) {
    opts = opts || {};
    var btn = el('button');
    btn.type = 'button';
    btn.className = opts.className || 'a1-btn';
    btn.setAttribute('data-role', 'variant-build');
    if (opts.icon) btn.appendChild(icon(opts.icon));
    if (opts.label) btn.appendChild(document.createTextNode(opts.label));
    btn.disabled = store.isBusy();
    btn.addEventListener('click', function () {
      if (opts.onClick) opts.onClick();
    });
    return btn;
  }

  function reevaluateBusy() {
    var busy = store.isBusy();
    document.querySelectorAll('[data-role="variant-build"]').forEach(function (btn) {
      btn.disabled = busy;
    });
  }

  store.subscribe(function (next, prev) {
    if (next.busy !== prev.busy) reevaluateBusy();
  });

  // -- The theme strip ---------------------------------------------------------------------------

  function placeholderNode(spinning, iconName, text) {
    var ph = el('span');
    ph.className = 'th-ph';
    if (spinning) {
      var spinner = el('span');
      spinner.className = 'spin';
      spinner.setAttribute('aria-hidden', 'true');
      ph.appendChild(spinner);
    } else {
      ph.appendChild(icon(iconName));
    }
    var b = el('b');
    setText(b, text);
    ph.appendChild(b);
    return ph;
  }

  function renderStrip(wrap) {
    clear(wrap);
    var sr = VR.stripState(currentVariantsInfo(), round, ScriptoriumAdmin.VW.timeOf, currentPackExists());
    wrap.className = 'th-strip' + (sr.state === 'building' ? ' busy' : sr.state === 'stale' ? ' stale' : '');

    wrap.appendChild(icon(sr.state === 'stale' ? 'warn' : sr.state === 'building' ? 'refresh' : 'tick'));
    var textSpan = el('span');
    var b = el('b');
    setText(b, sr.text);
    textSpan.appendChild(b);
    wrap.appendChild(textSpan);

    if (sr.state !== 'no-pack') {
      wrap.appendChild(variantBtn({ label: 'Build theme previews', icon: 'play', className: 'a1-btn small', onClick: runThemeRound }));
    }

    if (round.active) {
      var prog = el('progress');
      prog.className = 'th-prog';
      prog.max = round.total;
      prog.value = Math.max(0, round.index - 1);
      wrap.appendChild(prog);
    }

    if (round.evicted && round.evicted.length > 0) {
      var ev = el('p');
      ev.className = 'a1-fine';
      setText(ev, VR.EVICTED_NOTE);
      wrap.appendChild(ev);
    }

    if (round.error) {
      var errP = el('p');
      errP.className = 'a1-fine';
      errP.setAttribute('role', 'alert');
      setText(errP, round.error);
      wrap.appendChild(errP);
    }

    var items = VR.themeItems(currentVariantsInfo());
    if (
      items.some(function (it) {
        return it.built;
      })
    ) {
      var fine = el('p');
      fine.className = 'a1-fine';
      setText(fine, PV.RESIDUAL_FINE_PRINT);
      wrap.appendChild(fine);
    }
  }

  function themeStrip() {
    var wrap = el('div');
    wrap.className = 'th-strip';
    function rebuild() {
      renderStrip(wrap);
    }
    rebuild();
    registerRegion('strip', wrap, rebuild);
    return wrap;
  }

  // -- Per-card regions: the live shot and the page tabs ------------------------------------------

  function cardShot(name) {
    var span = el('span');
    span.className = 'th-shot';
    function rebuild() {
      clear(span);
      var item = findItem(VR.themeItems(currentVariantsInfo()), name);
      var role = cardPage[name] || 'landing';
      var state = VR.cardState(item, round, name);

      if (item && item.built) {
        var rel = VR.pageRel(item, role);
        if (rel !== null) {
          var live = el('span');
          live.className = 'th-live';
          live.setAttribute('inert', '');
          live.setAttribute('aria-hidden', 'true');
          live.appendChild(ScriptoriumAdmin.sitePane.frame(rel, name + ' theme: ' + PV.ROLE_LABELS[role], name));
          span.appendChild(live);
          if (item.stale) {
            var staleSpan = el('span');
            staleSpan.className = 'th-stale';
            staleSpan.appendChild(icon('warn'));
            staleSpan.appendChild(document.createTextNode(VR.CARD_COPY.stale));
            span.appendChild(staleSpan);
          }
        } else {
          span.appendChild(placeholderNode(false, 'images', VR.CARD_COPY.missingPage));
        }
      } else {
        span.appendChild(placeholderNode(state === 'building', 'images', state === 'building' ? VR.CARD_COPY.building : VR.CARD_COPY.none));
      }
    }
    rebuild();
    registerRegion('shot:' + name, span, rebuild);
    return span;
  }

  function cardTabs(name) {
    var wrap = el('div');
    wrap.className = 'th-tabs';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Page on the ' + name + ' card');

    function rebuild() {
      clear(wrap);
      var item = findItem(VR.themeItems(currentVariantsInfo()), name);
      VR.THEME_TABS.forEach(function (role) {
        var btn = el('button');
        btn.type = 'button';
        btn.className = 'th-tab';
        var rel = item ? VR.pageRel(item, role) : null;
        btn.disabled = !item || !item.built || rel === null;
        var pressed = (cardPage[name] || 'landing') === role;
        btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        setText(btn, PV.ROLE_LABELS[role]);
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          cardPage[name] = role;
          // No rebuild: move the existing frame in place and flip the pressed states by hand.
          var card = wrap.parentNode;
          var frame = card ? card.querySelector('.th-live [data-role="preview-frame"]') : null;
          if (frame) ScriptoriumAdmin.sitePane.pointFrame(frame, rel, name);
          Array.prototype.forEach.call(wrap.querySelectorAll('.th-tab'), function (b, i) {
            b.setAttribute('aria-pressed', VR.THEME_TABS[i] === role ? 'true' : 'false');
          });
        });
        wrap.appendChild(btn);
      });
    }
    rebuild();
    registerRegion('tabs:' + name, wrap, rebuild);
    return wrap;
  }

  // -- The full-size lightbox: a native <dialog>, Escape, focus return ---------------------------

  var LIGHTBOX_ID = 'admin-th-lightbox';
  var lightboxTrigger = null;
  var lightboxState = null; // { name, role }

  function lightboxDialog() {
    var existing = document.getElementById(LIGHTBOX_ID);
    if (existing) return existing;
    var dialog = el('dialog');
    dialog.id = LIGHTBOX_ID;
    dialog.className = 'th-light';
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      closeFull();
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function renderFull() {
    var dialog = lightboxDialog();
    clear(dialog);
    if (!lightboxState) return;
    var name = lightboxState.name;
    var role = lightboxState.role;
    dialog.setAttribute('aria-label', name + ' full size');

    var item = findItem(VR.themeItems(currentVariantsInfo()), name);

    var head = el('div');
    head.className = 'th-lhead';

    var capWrap = el('div');
    var cap = el('span');
    cap.className = 'a1-cap';
    setText(cap, 'Full size');
    capWrap.appendChild(cap);
    var b = el('b');
    setText(b, name);
    capWrap.appendChild(b);
    head.appendChild(capWrap);

    var chips = el('div');
    chips.className = 'ov-chips';
    VR.THEME_TABS.forEach(function (r) {
      var chip = el('button');
      chip.type = 'button';
      chip.className = 'ov-chip';
      chip.setAttribute('aria-pressed', r === role ? 'true' : 'false');
      setText(chip, PV.ROLE_LABELS[r]);
      chip.addEventListener('click', function () {
        lightboxState.role = r;
        cardPage[name] = r;
        renderFull();
      });
      chips.appendChild(chip);
    });
    head.appendChild(chips);

    var rel = item && item.built ? VR.pageRel(item, role) : null;
    var s = store.get().state;
    var sess = store.get().session;
    var href = s && typeof s.previewPort === 'number' && rel !== null ? PV.previewSrc((sess && sess.access) || null, location.hostname, s.previewPort, rel, name) : null;
    if (href !== null) {
      var openLink = el('a');
      openLink.className = 'a1-btn small ghost';
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.href = href;
      openLink.appendChild(document.createTextNode('Open in a tab'));
      head.appendChild(openLink);
    }

    var closeBtn = el('button');
    closeBtn.type = 'button';
    closeBtn.className = 'a1-iconbtn';
    closeBtn.title = 'Close';
    closeBtn.appendChild(icon('x'));
    closeBtn.addEventListener('click', closeFull);
    head.appendChild(closeBtn);

    dialog.appendChild(head);

    var body = el('div');
    body.className = 'th-lbody';
    if (rel !== null) {
      body.appendChild(ScriptoriumAdmin.sitePane.frame(rel, name + ' theme: ' + PV.ROLE_LABELS[role], name));
    } else {
      var p = el('p');
      setText(p, 'Not built yet. Build theme previews first.');
      body.appendChild(p);
    }
    dialog.appendChild(body);
  }

  function openFull(name, trigger) {
    lightboxState = { name: name, role: cardPage[name] || 'landing' };
    lightboxTrigger = trigger || null;
    renderFull();
    var dialog = document.getElementById(LIGHTBOX_ID);
    if (dialog && !dialog.open) dialog.showModal();
  }

  function closeFull() {
    var dialog = document.getElementById(LIGHTBOX_ID);
    if (dialog && dialog.open) dialog.close();
    lightboxState = null;
    if (lightboxTrigger && typeof lightboxTrigger.focus === 'function' && lightboxTrigger.isConnected !== false) {
      lightboxTrigger.focus();
    }
    lightboxTrigger = null;
  }

  // -- The review's before/after slip shots -------------------------------------------------------

  function slipSideSpan(name, caption) {
    var span = el('span');
    var item = findItem(VR.themeItems(currentVariantsInfo()), name);
    var rel = item && item.built ? VR.pageRel(item, 'landing') : null;
    if (rel !== null) {
      var live = el('span');
      live.className = 'th-live mini';
      live.setAttribute('inert', '');
      live.setAttribute('aria-hidden', 'true');
      live.appendChild(ScriptoriumAdmin.sitePane.frame(rel, name + ' theme: landing page', name));
      span.appendChild(live);
    } else {
      span.appendChild(placeholderNode(false, 'images', 'Not built yet'));
    }
    var small = el('small');
    setText(small, caption);
    span.appendChild(small);
    return span;
  }

  function slipShots(currentName, selectedName) {
    var wrap = el('div');
    wrap.className = 'th-slipshots';
    wrap.appendChild(slipSideSpan(currentName, currentName + ', today'));
    var arrowSpan = el('span');
    arrowSpan.className = 'ar';
    arrowSpan.appendChild(icon('arrow'));
    wrap.appendChild(arrowSpan);
    wrap.appendChild(slipSideSpan(selectedName, selectedName + ', after saving'));
    return wrap;
  }

  // -- The sequential build round -------------------------------------------------------------

  /**
   * One `POST /api/variants/theme` per registry theme, in `state.themes` order, each awaited
   * before the next (never `Promise.all`) -- `busy` is held for the whole round, so every
   * run/save control stays disabled across the gaps between builds.
   */
  function runThemeRound() {
    var names = ((store.get().state && store.get().state.themes) || []).map(function (t) {
      return t.name;
    });
    round = { active: true, index: 0, total: names.length, current: null, evicted: [], error: null };
    store.set({ busy: 'build' });
    refreshRegions();
    lastSignature = regionSignature();

    var chain = Promise.resolve();
    names.forEach(function (name) {
      chain = chain.then(function () {
        round.index += 1;
        round.current = name;
        refreshRegions();
        lastSignature = regionSignature();
        return api('/api/variants/theme', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: name }),
        }).then(function (result) {
          var outcome = ScriptoriumAdmin.VW.previewOutcome(result);
          if (outcome.kind !== 'built') {
            round.error =
              result.status === 503 ? ScriptoriumAdmin.OC.mapOutcome(result, 'save').message : VR.roundErrorText(outcome);
            return Promise.reject(new Error('theme round stopped'));
          }
          if (result.body && result.body.evicted && result.body.evicted.length > 0) {
            round.evicted = round.evicted.concat(result.body.evicted);
          }
          return store.load();
        });
      });
    });

    return chain
      .catch(function () {
        // round.error is already set above; a network-level rejection (caught by api() itself as
        // status 0) still lands here via previewOutcome's own unreachable mapping.
      })
      .then(function () {
        store.set({ busy: null });
        round.active = false;
        refreshRegions();
        lastSignature = regionSignature();
        return store.load();
      });
  }

  // -- vo2: the Vocabulary "Live example" (ADR 0039 addendum, SD-72) -----------------------------

  var VOCAB_ID = 'vocab';

  /** Module-session (not per-rail-build): survives across buildForm re-renders, shared by every
   * open vo2 example this page session, same precedent as sitepane.js's ov1LastRel. */
  var vo2When = 'after';

  /** The payload vo2's last successful build this session was built from, `{builtAt,
   * payloadJson}`, or null before any build. Only trusted while the vocab item's own `builtAt`
   * still equals the one recorded here (see exampleState's call below): an outside rebuild (a
   * second tab, or eviction-then-rebuild) invalidates it without this module needing to notice
   * directly. */
  var vocabBuiltRecord = null;

  function vocabVariantItem() {
    var info = currentVariantsInfo();
    return findItem((info && info.items) || [], VOCAB_ID);
  }

  /**
   * @param {{node:HTMLElement, refresh:Function}} adapter the caller's own body/payloadJson/role/
   *   focus functions (vocab.js's vo2Adapter)
   * @returns {{node:HTMLElement, refresh:Function}}
   */
  function vocabExample(adapter) {
    var node = el('div');

    var whenWrap = el('div');
    whenWrap.className = 'vo2-when a1-seg';
    whenWrap.setAttribute('role', 'group');
    whenWrap.setAttribute('aria-label', 'Show');
    var nowBtn = el('button');
    nowBtn.type = 'button';
    setText(nowBtn, 'Now');
    var afterBtn = el('button');
    afterBtn.type = 'button';
    setText(afterBtn, 'After saving');
    nowBtn.addEventListener('click', function () {
      vo2When = 'now';
      refresh();
    });
    afterBtn.addEventListener('click', function () {
      vo2When = 'after';
      refresh();
    });
    whenWrap.appendChild(nowBtn);
    whenWrap.appendChild(afterBtn);
    node.appendChild(whenWrap);

    var capP = el('p');
    capP.className = 'vo2-cap';
    var capSpan = el('span');
    capSpan.className = 'a1-cap';
    capP.appendChild(capSpan);
    var focusSpan = el('span');
    capP.appendChild(focusSpan);
    node.appendChild(capP);

    var frameWrap = el('div');
    frameWrap.className = 'vo2-frame';
    node.appendChild(frameWrap);

    var pillWrap = el('span');
    pillWrap.className = 'a1-pill rose';
    pillWrap.hidden = true;
    setText(pillWrap, 'out of date');
    node.appendChild(pillWrap);

    var stateP = el('p');
    node.appendChild(stateP);
    var btnSlot = el('span');
    node.appendChild(btnSlot);
    // A real defect, found by this slice's own harness: destroying and recreating this button
    // on EVERY refresh() (including the 'change' a blurred, edited <input> fires) means a click
    // whose mousedown lands on the old node and whose mouseup lands on a brand-new one never
    // becomes a 'click' event at all -- the browser requires the same element for both. The
    // button is now created once and updated in place; only its label/class/hidden state change.
    var exampleBtn = null;
    var errP = el('p');
    errP.setAttribute('role', 'alert');
    errP.hidden = true;
    node.appendChild(errP);

    var fineP = el('p');
    fineP.className = 'a1-fine';
    setText(fineP, VR.EXAMPLE_COPY.fine);
    node.appendChild(fineP);

    // One frame element for this region's whole lifetime: refresh() redirects it (sitePane.
    // pointFrame) on a role or mode change, and recreates it only when the shown build's own
    // builtAt changes (frameSig below) -- X10's own target (no reload on a focus/keystroke
    // refresh that shows the same build).
    var frameEl = null;
    var frameSig = null;

    function showFrame(rel, variantId, builtAtKey, title) {
      var sig = (variantId || 'main') + ':' + builtAtKey;
      // X10 (a real defect, found by this slice's own DOM harness): removing and reinserting an
      // <iframe> -- even the SAME node, even to the SAME parent -- destroys its browsing context
      // and reloads it in every tested engine. So the reuse branch must NEVER touch the DOM at
      // all beyond pointFrame's own (idempotent) src update; only a genuinely NEW frame goes
      // through clear()+appendChild.
      if (frameEl && frameSig === sig && frameEl.parentNode === frameWrap) {
        ScriptoriumAdmin.sitePane.pointFrame(frameEl, rel, variantId);
        return;
      }
      clear(frameWrap);
      frameEl = ScriptoriumAdmin.sitePane.frame(rel, title, variantId);
      frameSig = sig;
      frameWrap.appendChild(frameEl);
    }

    function showNowEmpty() {
      frameEl = null;
      frameSig = null;
      clear(frameWrap);
      // A real defect, found by this slice's own axe pass: .vo2-frame carries the light "site
      // paper" background (it normally holds a live frame of the player site), so panel text
      // dropped straight into it inherited the panel's own light-on-dark colour and read at a
      // contrast ratio of 1.16. This placeholder gets its own opaque, panel-coloured surface
      // instead (the same idea as the theme cards' own .th-ph placeholder).
      var wrap = el('div');
      wrap.className = 'vo2-empty';
      var h3 = el('h3');
      setText(h3, VR.EXAMPLE_COPY.nowEmptyHead);
      wrap.appendChild(h3);
      var p = el('p');
      setText(p, VR.EXAMPLE_COPY.nowEmptyText);
      wrap.appendChild(p);
      wrap.appendChild(
        variantBtn({
          label: 'Build preview',
          icon: 'play',
          onClick: function () {
            ScriptoriumAdmin.runs.build();
          },
        }),
      );
      frameWrap.appendChild(wrap);
    }

    function showMissing(role) {
      frameEl = null;
      frameSig = null;
      clear(frameWrap);
      var wrap = el('div');
      wrap.className = 'vo2-empty';
      var p = el('p');
      setText(p, VR.EXAMPLE_COPY.missing[role]);
      wrap.appendChild(p);
      frameWrap.appendChild(wrap);
    }

    function refresh() {
      nowBtn.setAttribute('aria-pressed', vo2When === 'now' ? 'true' : 'false');
      afterBtn.setAttribute('aria-pressed', vo2When === 'after' ? 'true' : 'false');

      var role = adapter.role();
      var focus = adapter.focus();
      var caption = ScriptoriumAdmin.VB.EXAMPLE_CAPTIONS[role];
      setText(capSpan, caption);
      clear(focusSpan);
      if (focus.kind === 'label') {
        var code = el('code');
        setText(code, focus.key);
        focusSpan.appendChild(code);
        if (focus.before !== focus.after) {
          focusSpan.appendChild(document.createTextNode(': '));
          var beforeB = el('b');
          setText(beforeB, focus.before);
          focusSpan.appendChild(beforeB);
          focusSpan.appendChild(document.createTextNode(' becomes '));
          var afterB = el('b');
          setText(afterB, focus.after);
          focusSpan.appendChild(afterB);
        }
      } else {
        focusSpan.appendChild(document.createTextNode(focus.text));
      }

      var item = vocabVariantItem();
      var payloadJson = adapter.payloadJson();
      var builtPayloadJson =
        vocabBuiltRecord && item && item.builtAt === vocabBuiltRecord.builtAt ? vocabBuiltRecord.payloadJson : null;
      var st = VR.exampleState(item, builtPayloadJson, payloadJson);

      var previewInfo = currentPreviewInfo();
      var showVocab = vo2When === 'after' && st !== 'no-edits';

      // Every branch below sets this; only a built, outdated After example shows the pill.
      pillWrap.hidden = true;
      if (showVocab) {
        if (item && item.built) {
          var afterRel = pageRel(item, role);
          if (afterRel !== null) {
            showFrame(afterRel, VOCAB_ID, item.builtAt, 'After saving: ' + caption);
            pillWrap.hidden = st !== 'outdated';
          } else {
            showMissing(role);
          }
        } else if (!previewInfo || previewInfo.built !== true) {
          showNowEmpty();
        } else {
          showMissing(role);
        }
      } else {
        var nowRel = pageRel(previewInfo, role);
        if (nowRel !== null) {
          showFrame(nowRel, undefined, previewInfo.builtAt, 'Now: ' + caption);
        } else if (!previewInfo || previewInfo.built !== true) {
          showNowEmpty();
        } else {
          showMissing(role);
        }
        pillWrap.hidden = true;
      }

      clear(stateP);
      var stText =
        st === 'no-edits'
          ? VR.EXAMPLE_COPY.noEdits
          : st === 'none'
            ? VR.EXAMPLE_COPY.none
            : st === 'outdated'
              ? VR.EXAMPLE_COPY.outdated
              : VR.EXAMPLE_COPY.current.replace('HH:MM', ScriptoriumAdmin.VW.timeOf(item.builtAt));
      setText(stateP, stText);

      if (st === 'no-edits') {
        if (exampleBtn) exampleBtn.hidden = true;
      } else {
        if (!exampleBtn) {
          exampleBtn = variantBtn({
            label: 'Update example',
            icon: 'preview',
            onClick: function () {
              buildVocab(adapter).then(refresh);
            },
          });
          btnSlot.appendChild(exampleBtn);
        }
        exampleBtn.hidden = false;
        exampleBtn.className = st === 'none' || st === 'outdated' ? 'a1-btn primary' : 'a1-btn';
      }

      if (vocabLastError) {
        errP.hidden = false;
        setText(errP, vocabLastError);
      } else {
        errP.hidden = true;
        clear(errP);
      }
    }

    refresh();
    return { node: node, refresh: refresh };
  }

  /** The most recent failed buildVocab's outcome message, shown by every open vo2 example's own
   * refresh() (role=alert), or null once a build has succeeded or none has run yet this session. */
  var vocabLastError = null;

  /**
   * POST /api/variants/vocab from the vo2 rail's own Update example button. Never written: the
   * server's own dryRun:true literal is what makes that true (SD-70); this function only sends
   * the body and tracks what the shown example was built from.
   *
   * @param {{body:Function, payloadJson:Function}} adapter
   * @returns {Promise}
   */
  function buildVocab(adapter) {
    var body = adapter.body();
    var json = adapter.payloadJson();
    store.set({ busy: 'build' });
    return api('/api/variants/vocab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (result) {
        var outcome = ScriptoriumAdmin.VW.previewOutcome(result);
        if (outcome.kind === 'built') {
          vocabBuiltRecord = { builtAt: result.body.variant.builtAt, payloadJson: json };
          vocabLastError = null;
        } else {
          vocabLastError = ScriptoriumAdmin.OC.mapOutcome(result, 'save').message;
        }
      })
      .catch(function () {
        // A network-level rejection: api() itself already maps status 0 through
        // previewOutcome's own unreachable kind, so there is nothing else to set here.
        vocabLastError = ScriptoriumAdmin.OC.mapOutcome({ ok: false, status: 0, body: null }, 'save').message;
      })
      .then(function () {
        store.set({ busy: null });
        return store.load();
      });
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.variants = {
    themeStrip: themeStrip,
    cardShot: cardShot,
    cardTabs: cardTabs,
    openFull: openFull,
    slipShots: slipShots,
    vocabExample: vocabExample,
    buildVocab: buildVocab,
    runThemeRound: runThemeRound,
    variantBtn: variantBtn,
  };
})();
