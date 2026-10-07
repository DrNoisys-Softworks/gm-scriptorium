'use strict';

/*
 * Phase 8 slice S5 (FR26, FR27, Structural decision 6). Upload form on top of raw-body
 * POST /api/images/upload?name= (SD-1), and the six image slots on top of POST /api/pack/slots,
 * which reuses S3's runSave two-click dry-run/confirm pattern (assets/admin/pack.js) exactly.
 *
 * SLOT_NAMES is a literal copy of src/build/themes.js's own registry order (Structural decision 6:
 * this file never requires product source), with test/admin-slots.test.js's own drift test
 * extracting this exact literal from this file's source and deep-equalling it against
 * src/build/themes.js's SLOT_NAMES so the two can never silently diverge.
 */
var SLOT_NAMES = ['hero', 'ground', 'paper', 'crest-frame', 'portrait', '404'];

(function () {
  /*
   * V1b SD-12 (D-10 option (c), owner-approved convention sizes): IM, a pure namespace for the
   * per-slot image guidance. SLOT_GUIDE is a recommended convention, typed from the approved
   * table -- no entry carries a file:line source (Part 1 of
   * docs/agent-runs/v1bc-notes-and-d10-2026-09-29.md). ADR 0032 (base theme slice) adds the
   * gloam theme, which draws four of the six slots (BUILT_IN_SLOT_DRAWERS below); crest-frame
   * and portrait still apply only once a campaign's own overrides.css reads them.
   */
  var GUIDE_LABEL = 'Recommended convention';
  var GUIDE_NOTE = "This is the size to prepare art at, whether a built-in theme or your own overrides.css draws the slot.";
  var HERO_CROP_NOTE =
    'If your overrides.css uses it as the landing banner, plain shows about a 3.2:1 band of it and haze about 1.7:1 on a wide screen.';
  var WARN = { minScale: 0.75, aspect: 1.25 };
  var SLOT_GUIDE = [
    { slot: 'hero', w: 2400, h: 1350, ratio: '16:9', behaviour: 'Cover; keep the subject in the middle band.' },
    { slot: 'ground', w: 2560, h: 1440, ratio: '16:9', behaviour: 'Fixed page background, cover.' },
    { slot: 'paper', w: 1024, h: 1024, ratio: '1:1', behaviour: 'Seamless tile.', tile: true },
    { slot: 'crest-frame', w: 512, h: 512, ratio: '1:1', behaviour: 'Transparent PNG or WebP.', alpha: true },
    { slot: 'portrait', w: 900, h: 1200, ratio: '3:4', behaviour: 'Cover.' },
    { slot: '404', w: 1600, h: 900, ratio: '16:9', behaviour: 'Cover.' },
  ];

  /**
   * Owner feedback (2026-09-30, mid-V1d-2): "hero" alone doesn't say what it's for. Purpose text
   * per slot, sourced only from what's actually documented -- ADR 0019's own worked example
   * (`docs/decisions/0019-themes-image-slots-and-asset-step.md`, section "The permitted diff", the "ground" slot wired
   * in as `background-image: var(--sc-img-ground)`), the slot's own name (the registry literal in
   * `src/build/themes.js`, self-describing by convention), and SLOT_GUIDE's own `behaviour`/`tile`/
   * `alpha` fields above (already-approved product copy, not new invention). `diagram` names one of
   * DIAGRAM_KINDS below (the schematic placement sketch, reusing the Theme specimen's idiom: DOM
   * and CSS only, tokens only, no images).
   *
   * BUILT_IN_SLOT_DRAWERS is a literal fact, not a live check: it names, per slot, which
   * built-in themes' theme.json `slots` array includes it -- today only gloam
   * (`assets/themes/gloam/theme.json`'s `"slots": ["hero", "ground", "paper", "404"]`); `plain`
   * (`dir: null`, so `loadTheme` always returns `slots: []`) and haze (`"slots": []`) draw none.
   * `/api/state` exposes no theme's `slots` array (DV: a live "does the ACTIVE theme draw this
   * slot" check would need a new field there; not added, per the owner's own "don't add a server
   * route" instruction -- this stays a static, independently-verified fact instead, with its own
   * drift risk noted here rather than silently assumed). `drawersFor` is own-property lookup
   * only, so an unknown or inherited slot name (e.g. "constructor") gives `[]`, never a match.
   */
  var BUILT_IN_SLOT_DRAWERS = { hero: ['gloam'], ground: ['gloam'], paper: ['gloam'], '404': ['gloam'] };

  function drawersFor(slot) {
    return Object.prototype.hasOwnProperty.call(BUILT_IN_SLOT_DRAWERS, slot) ? BUILT_IN_SLOT_DRAWERS[slot] : [];
  }
  /**
   * V1e-5 (SD-54, FR-26): the Images screen's own truthful descriptions, replacing the prose
   * above. Each `diagram` is UNCHANGED from the previous slice -- only `text` moves.
   */
  var SLOT_PURPOSE = {
    hero: {
      text: 'A wide picture meant for the top of your landing page.',
      diagram: 'hero',
    },
    ground: {
      text: 'A picture fixed behind your pages, showing around the edges of the text.',
      diagram: 'ground',
    },
    paper: {
      text: 'A small image repeated behind text and cards, like paper grain.',
      diagram: 'paper',
    },
    'crest-frame': {
      text: 'A decorative border for faction crests and emblems.',
      diagram: 'crest',
    },
    portrait: {
      text: 'An upright character portrait.',
      diagram: 'portrait',
    },
    '404': {
      text: 'The picture on the page players land on when a link goes nowhere.',
      diagram: 'notfound',
    },
  };

  /**
   * The text after 'images/' if and only if `value` starts with exactly that prefix (not
   * 'imagesx/', a string-prefix sibling) and the rest is a member of `images` (this membership
   * check is what makes 'images/../pack.toml', 'images/..', 'images/' and 'images' all give
   * null: none of those "rest" values can ever legitimately be a listed image, since `images`
   * only ever holds real filenames under images/ -- there is no separate path-traversal check
   * to keep in sync).
   */
  function slotImageRel(value, images) {
    if (typeof value !== 'string' || value.indexOf('images/') !== 0) return null;
    var rest = value.slice('images/'.length);
    return Array.isArray(images) && images.indexOf(rest) !== -1 ? rest : null;
  }

  function guideFor(slot) {
    for (var i = 0; i < SLOT_GUIDE.length; i++) {
      if (SLOT_GUIDE[i].slot === slot) return SLOT_GUIDE[i];
    }
    return null;
  }

  function formatRatio(r) {
    return r.toFixed(2);
  }

  /** D-10 (c): soft warnings against a recommended convention, never blocking. Never throws. */
  function sizeAdvice(guide, dims, name) {
    if (!dims || !guide) {
      return [{ level: 'info', text: 'Size not checked.' }];
    }

    var out = [
      {
        level: 'info',
        text: 'Measured ' + dims.w + ' × ' + dims.h + ' px; recommended convention ' + guide.w + ' × ' + guide.h + ' px (' + guide.ratio + ').',
      },
    ];

    if (dims.w < guide.w * WARN.minScale || dims.h < guide.h * WARN.minScale) {
      out.push({
        level: 'warn',
        text: guide.tile
          ? 'Smaller than the recommended tile; the pattern repeats more often.'
          : 'Smaller than the recommended size; it may look soft when enlarged.',
      });
    }

    var g = guide.w / guide.h;
    var r = dims.w / dims.h;
    if (r < g / WARN.aspect || r > g * WARN.aspect) {
      out.push({ level: 'warn', text: 'Its shape (' + formatRatio(r) + ':1) is far from the recommended ' + guide.ratio + '.' });
    }

    if (guide.alpha && typeof name === 'string' && /\.jpe?g$/i.test(name)) {
      out.push({ level: 'warn', text: "JPEG has no transparency; this slot's convention is PNG or WebP." });
    }

    return out;
  }

  function purposeFor(slot) {
    return Object.prototype.hasOwnProperty.call(SLOT_PURPOSE, slot) ? SLOT_PURPOSE[slot] : null;
  }

  // --- V1e-5 additions (SD-54, FR-25, FR-26) ----------------------------------------------------

  /** FR-25 (frozen): the panel's own name for each slot; the code name stays as small print. */
  var FRIENDLY_NAMES = {
    hero: 'Landing banner',
    ground: 'Page backdrop',
    paper: 'Paper texture',
    'crest-frame': 'Emblem frame',
    portrait: 'Character portrait',
    '404': 'Not-found page',
  };

  function friendlyName(slot) {
    return Object.prototype.hasOwnProperty.call(FRIENDLY_NAMES, slot) ? FRIENDLY_NAMES[slot] : null;
  }

  var SLOT_TIPS = {
    hero: 'Keep the subject in the middle band; the edges get cropped.',
    ground: 'Keep it quiet; text never sits on it directly.',
    paper: 'It repeats, so the edges must meet seamlessly.',
    'crest-frame': 'Needs a see-through middle: PNG or WebP, not JPEG.',
    portrait: 'Prepare it as a 3:4 upright picture.',
    '404': 'Cropped to fill a wide band.',
  };

  function tipFor(slot) {
    return Object.prototype.hasOwnProperty.call(SLOT_TIPS, slot) ? SLOT_TIPS[slot] : null;
  }

  var RATIO_CLASS = { hero: 'r-16x9', ground: 'r-16x9', paper: 'r-1x1', 'crest-frame': 'r-1x1', portrait: 'r-3x4', '404': 'r-16x9' };

  function ratioClassFor(slot) {
    return Object.prototype.hasOwnProperty.call(RATIO_CLASS, slot) ? RATIO_CLASS[slot] : null;
  }

  /** `drawersFor(slot)` already names which themes draw it; this is just the own-property test. */
  function drawnBy(slot, theme) {
    return drawersFor(slot).indexOf(theme) !== -1;
  }

  /** A per-theme, per-slot exception to the generic draw line (FR-26: gloam's hero note). */
  var DRAW_NOTES = {
    gloam: { hero: 'Your theme, gloam, uses it only on the not-found page, when Not-found page is empty.' },
  };

  /**
   * FR-26: the per-slot "does the theme draw it" line. `themeNames` is the live list of theme
   * names the current /api/state actually knows about (so a pack.toml error, which gives
   * `theme: null`, falls through to the first branch rather than a false "doesn't draw it").
   */
  function drawLine(slot, theme, themeNames) {
    if (!Array.isArray(themeNames) || themeNames.indexOf(theme) === -1) {
      return 'Your overrides.css can draw it.';
    }
    if (drawnBy(slot, theme)) {
      if (Object.prototype.hasOwnProperty.call(DRAW_NOTES, theme) && Object.prototype.hasOwnProperty.call(DRAW_NOTES[theme], slot)) {
        return DRAW_NOTES[theme][slot];
      }
      return 'Your theme, ' + theme + ', draws it.';
    }
    if (drawersFor(slot).length === 0) {
      return 'No built-in theme draws it; your overrides.css can.';
    }
    return 'Your theme, ' + theme + ", doesn't draw it. Your overrides.css can.";
  }

  var THEME_NOTE_TAIL =
    'Everything in images/ is published with the site, used or not. Art from your vault that a spot uses is copied into the site too.';

  /** FR-26: replaces the mock's "plain and haze don't draw" note with a theme-aware pair. */
  function themeNote(theme, themeNames) {
    if (!Array.isArray(themeNames) || themeNames.indexOf(theme) === -1) {
      return ['Your overrides.css can draw any of these spots.', THEME_NOTE_TAIL];
    }
    var drawn = SLOT_NAMES.filter(function (slot) {
      return drawnBy(slot, theme);
    });
    if (drawn.length === 0) {
      return ["Your theme, " + theme + ", doesn't draw any of these spots. Your overrides.css can draw any of them.", THEME_NOTE_TAIL];
    }
    var names = drawn
      .map(function (slot) {
        return friendlyName(slot);
      })
      .join(', ');
    return ['Your theme, ' + theme + ', draws ' + drawn.length + ' of these spots: ' + names + '. Your overrides.css can draw any of them.', THEME_NOTE_TAIL];
  }

  /** Mirrors slotImageRel: the text after exactly 'vault:', iff it is an exact member of `rels`. */
  function vaultArtRel(value, rels) {
    if (typeof value !== 'string' || value.indexOf('vault:') !== 0) return null;
    var rest = value.slice('vault:'.length);
    return Array.isArray(rels) && rels.indexOf(rest) !== -1 ? rest : null;
  }

  function imageSrc(rel) {
    return '/api/image?name=' + encodeURIComponent(rel);
  }

  function vaultArtSrc(rel) {
    return '/api/vault-art/file?name=' + encodeURIComponent(rel);
  }

  /** FR-28: a value outside the listed vault folder (or any other shape) keeps the path card. */
  function thumbFor(value, images, vaultRels) {
    if (!value) return { kind: 'empty' };
    var upRel = slotImageRel(value, images);
    if (upRel !== null) return { kind: 'img', src: imageSrc(upRel), from: 'up' };
    var vRel = vaultArtRel(value, vaultRels);
    if (vRel !== null) return { kind: 'img', src: vaultArtSrc(vRel), from: 'vault' };
    return { kind: 'path' };
  }

  function displayName(value) {
    var s = value || '';
    var rest = s.indexOf('vault:') === 0 ? s.slice('vault:'.length) : s.indexOf('images/') === 0 ? s.slice('images/'.length) : s;
    var idx = rest.lastIndexOf('/');
    return idx === -1 ? rest : rest.slice(idx + 1);
  }

  function fromLabel(value) {
    if (!value) return '';
    return typeof value === 'string' && value.indexOf('vault:') === 0 ? 'from your vault' : 'uploaded';
  }

  // --- The pending model (SD-54): `saved` is state.packToml.images; `pend` is slot -> string|null

  function currentValue(pend, saved, slot) {
    if (Object.prototype.hasOwnProperty.call(pend, slot)) return pend[slot];
    return Object.prototype.hasOwnProperty.call(saved, slot) ? saved[slot] : null;
  }

  /** The mock's own setSlot: a copy of `pend`, deleting `slot` when `value` matches the saved
   * baseline (treating an absent saved value as null), else setting it, even to null (a clear). */
  function withPend(pend, saved, slot, value) {
    var next = {};
    Object.keys(pend).forEach(function (key) {
      next[key] = pend[key];
    });
    var savedValue = Object.prototype.hasOwnProperty.call(saved, slot) ? saved[slot] : null;
    if (value === (savedValue || null)) {
      delete next[slot];
    } else {
      next[slot] = value;
    }
    return next;
  }

  function pendKeys(pend, saved) {
    return SLOT_NAMES.filter(function (slot) {
      if (!Object.prototype.hasOwnProperty.call(pend, slot)) return false;
      var savedValue = Object.prototype.hasOwnProperty.call(saved, slot) ? saved[slot] : null;
      return pend[slot] !== (savedValue || null);
    });
  }

  function slotsPayload(pend, saved) {
    var out = {};
    pendKeys(pend, saved).forEach(function (slot) {
      out[slot] = pend[slot];
    });
    return out;
  }

  function usedBy(value, pend, saved) {
    return SLOT_NAMES.filter(function (slot) {
      return currentValue(pend, saved, slot) === value;
    });
  }

  function statusFor(pend, saved, slot) {
    if (pendKeys(pend, saved).indexOf(slot) !== -1) return 'unsaved';
    return currentValue(pend, saved, slot) ? 'set' : 'empty';
  }

  // --- Fit (SD-54): ported from the mock's own fitScore (r3-src/images.js:72-78) --------------

  function fitScore(guide, dims, name) {
    if (!dims) return 1;
    var g = guide.w / guide.h;
    var r = dims.w / dims.h;
    var sc = 3 - Math.abs(Math.log(r / g)) * 4;
    if (guide.alpha && typeof name === 'string' && /\.jpe?g$/i.test(name)) sc -= 3;
    if (dims.w < guide.w * WARN.minScale || dims.h < guide.h * WARN.minScale) sc -= 1;
    return sc;
  }

  function bestSlotsFor(dims, name) {
    var scored = SLOT_NAMES.map(function (slot, i) {
      return { slot: slot, i: i, score: fitScore(guideFor(slot), dims, name) };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.i - b.i;
    });
    return scored.slice(0, 2).map(function (s) {
      return s.slot;
    });
  }

  function followRoleFor(slot) {
    return slot === '404' ? 'notfound' : 'landing';
  }

  var IM = {
    SLOT_GUIDE: SLOT_GUIDE,
    SLOT_PURPOSE: SLOT_PURPOSE,
    BUILT_IN_SLOT_DRAWERS: BUILT_IN_SLOT_DRAWERS,
    drawersFor: drawersFor,
    GUIDE_LABEL: GUIDE_LABEL,
    GUIDE_NOTE: GUIDE_NOTE,
    HERO_CROP_NOTE: HERO_CROP_NOTE,
    WARN: WARN,
    slotImageRel: slotImageRel,
    guideFor: guideFor,
    purposeFor: purposeFor,
    sizeAdvice: sizeAdvice,
    // V1e-5 additions (SD-54).
    FRIENDLY_NAMES: FRIENDLY_NAMES,
    friendlyName: friendlyName,
    SLOT_TIPS: SLOT_TIPS,
    tipFor: tipFor,
    RATIO_CLASS: RATIO_CLASS,
    ratioClassFor: ratioClassFor,
    drawnBy: drawnBy,
    DRAW_NOTES: DRAW_NOTES,
    drawLine: drawLine,
    themeNote: themeNote,
    vaultArtRel: vaultArtRel,
    imageSrc: imageSrc,
    vaultArtSrc: vaultArtSrc,
    thumbFor: thumbFor,
    displayName: displayName,
    fromLabel: fromLabel,
    currentValue: currentValue,
    withPend: withPend,
    pendKeys: pendKeys,
    slotsPayload: slotsPayload,
    usedBy: usedBy,
    statusFor: statusFor,
    fitScore: fitScore,
    bestSlotsFor: bestSlotsFor,
    followRoleFor: followRoleFor,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { IM: IM, SLOT_NAMES: SLOT_NAMES };
    return;
  }

  // V1c deviation (flagged in the Engineer report, justified there): the other three V1b pure
  // namespaces each publish themselves this same way (diff.js:126, outcome.js:123, slip.js:317)
  // so a sibling module can read them after boot; IM never got the equivalent line, which the
  // V1c interfaces (views.js's slotCells: "the browser passes ScriptoriumAdmin.IM.slotImageRel")
  // assume exists. Purely additive -- nothing here changes, only becomes reachable from outside.
  window.ScriptoriumAdmin.IM = IM;

  var api = ScriptoriumAdmin.api;
  var el = ScriptoriumAdmin.el;
  var setText = ScriptoriumAdmin.setText;
  var store = ScriptoriumAdmin.store;
  var icon = ScriptoriumAdmin.icon;

  /*
   * V1e-5 (SD-55 to SD-57): the Images screen's DOM half, rewritten as three switchable layouts
   * (im1/im2/im3) over one set of module-state pending edits, ported from
   * docs/agent-runs/panel-v3-mockups/r3-src/images.js (markup) and images.css (classes). Every
   * node is built with el/setText/icon, never a markup string (NFR-01).
   */

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function mapOutcomeSafe(result, phase) {
    return ScriptoriumAdmin.OC.mapOutcome(result, phase);
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** im2's crest zone watermark (the mock's own img.sig): a fixed, invented, generic sigil --
   * never a real campaign crest -- shown regardless of whether the crest-frame slot has a value,
   * to sketch what the frame would hold. An inline SVG built the same way icons.js's own icon()/
   * glyph() already do (createElementNS, never a markup string -- NFR-01), not an <img>: the
   * admin CSP's own `img-src 'self'` would silently refuse a data: URI image, and this is not a
   * new admin asset (SD-53) either. */
  function sigilEl() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sig');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    [
      ['path', { d: 'M32 4 56 14v18c0 16-10 26-24 30C18 58 8 48 8 32V14Z' }],
      ['path', { d: 'M32 18v28M20 32h24' }],
    ].forEach(function (entry) {
      var node = document.createElementNS(SVG_NS, entry[0]);
      Object.keys(entry[1]).forEach(function (attr) {
        node.setAttribute(attr, entry[1][attr]);
      });
      svg.appendChild(node);
    });
    return svg;
  }

  // --- Module state (SD-55) ------------------------------------------------------------------

  var pend = {}; // survives every re-render and view switch
  var ui = { pickSlot: null, pickTab: 'up', pickSel: null, typedPath: '', sel: 'hero', libSel: null, libFilter: 'all', mtab: 'slots', libShown: 120 };
  var vaultArt = null; // the last GET /api/vault-art response, or null before the first fetch
  var dimsCache = {}; // src -> {w,h}|null
  var uploading = false;
  var renderDeferred = false;
  var currentContainer = null;
  // The last upload batch's own "<name>: saved"/refusal lines, kept in module state (not just
  // the DOM) so they survive the re-render store.load() triggers once the fresh state lands --
  // without this, the status list is built, then wiped by that re-render before a GM has any
  // real chance to read it (found live). Reset only when a NEW batch starts.
  var lastUploadStatus = [];

  function savedImages(state) {
    return (state.packToml && state.packToml.images) || {};
  }

  function vaultRels() {
    return vaultArt && vaultArt.entries ? vaultArt.entries.map(function (e) { return e.rel; }) : [];
  }

  function usableVaultEntries() {
    return vaultArt && vaultArt.entries ? vaultArt.entries.filter(function (e) { return e.usable; }) : [];
  }

  // --- Focus restore (SD-55) --------------------------------------------------------------------

  function activeFocusKey(container) {
    var active = document.activeElement;
    if (active && container.contains(active) && active.hasAttribute('data-focus-key')) {
      return active.getAttribute('data-focus-key');
    }
    return null;
  }

  function focusByKey(container, key) {
    if (!key) return false;
    var target = container.querySelector('[data-focus-key="' + key + '"]');
    if (target) {
      target.focus();
      return true;
    }
    return false;
  }

  /** The slot named by a `<action>:<slot>` focus key (pick:/remove:/undo:/chip:/use:/mk:), or
   * null for a non-slot key (tab:/filter:/tile:/discard/review/more/lookagain/upload) or no key
   * at all. Own-property lookup against SLOT_NAMES only, never a bare truthy check. */
  function slotFromFocusKey(key) {
    if (typeof key !== 'string') return null;
    var idx = key.indexOf(':');
    if (idx === -1) return null;
    var slot = key.slice(idx + 1);
    return SLOT_NAMES.indexOf(slot) !== -1 ? slot : null;
  }

  function restoreFocus(container, key, fallbackSlot, fallbackPrefix) {
    if (document.getElementById('admin-slip') && document.getElementById('admin-slip').open) return;
    if (focusByKey(container, key)) return;
    if (fallbackSlot && focusByKey(container, fallbackPrefix + ':' + fallbackSlot)) return;
    var h1 = container.querySelector('h1');
    if (h1) h1.focus ? h1.focus() : null;
  }

  // --- Pending/nav wiring (SD-55) -----------------------------------------------------------

  function setPend(next, state) {
    pend = next;
    store.set({ pending: ScriptoriumAdmin.ST.withPending(store.get().pending, 'images', IM.pendKeys(pend, savedImages(state)).length) });
    scheduleRender();
  }

  function discardPend(state) {
    setPend({}, state);
  }

  function afterSaved(screenId, body) {
    var s = store.get();
    store.set({
      files: ScriptoriumAdmin.ST.applySaveResult(s.files, body),
      pending: ScriptoriumAdmin.ST.withPending(s.pending, screenId, 0),
    });
    store.load();
  }

  // --- Follow (FR-19, SD-55) --------------------------------------------------------------------

  function setFollow(slot) {
    var role = IM.followRoleFor(slot);
    var current = store.get().followHint;
    if (current && current.screen === 'images' && current.role === role) return;
    store.set({ followHint: { screen: 'images', role: role } });
  }

  // --- Measurement -----------------------------------------------------------------------------

  function isSvgName(name) {
    return typeof name === 'string' && /\.svg$/i.test(name);
  }

  function measureSrc(src) {
    if (Object.prototype.hasOwnProperty.call(dimsCache, src)) return Promise.resolve(dimsCache[src]);
    if (isSvgName(src)) {
      dimsCache[src] = null;
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var dims = { w: img.naturalWidth, h: img.naturalHeight };
        dimsCache[src] = dims;
        resolve(dims);
      };
      img.onerror = function () {
        dimsCache[src] = null;
        resolve(null);
      };
      img.src = src;
    });
  }

  function measureImageRel(rel) {
    return measureSrc(IM.imageSrc(rel));
  }

  function measureVaultRel(rel) {
    return measureSrc(IM.vaultArtSrc(rel));
  }

  /** Resolves `{w,h}|null` for a slot's pending/saved VALUE (not a bare rel): an images/ value
   * measures through /api/image, a vault: value through /api/vault-art/file, anything else
   * (an outside-the-folder vault: value, or no value) is never measured. */
  function measureValue(value, images) {
    if (typeof value !== 'string' || value === '') return Promise.resolve(null);
    var upRel = IM.slotImageRel(value, images);
    if (upRel !== null) return measureImageRel(upRel);
    var vRel = IM.vaultArtRel(value, vaultRels());
    if (vRel !== null) return measureVaultRel(vRel);
    return Promise.resolve(null);
  }

  // --- Common builders (SD-56) -------------------------------------------------------------------

  /** SD-57: every local (never-POSTing) edit control is built through this one helper, whose body
   * never mentions isBusy -- Choose/Change/Remove/Undo/Use/the tiles/Discard all stay enabled
   * while the panel is busy with something else, because none of them send a request of their own. */
  function localEditButton(text, className, onClick) {
    var btn = el('button');
    btn.type = 'button';
    btn.className = className;
    setText(btn, text);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function statusPillEl(status) {
    var span = el('span');
    span.className = 'a1-pill ' + (status === 'unsaved' ? 'rose' : status === 'set' ? 'sage' : 'muted');
    setText(span, status);
    return span;
  }

  function drawLineEl(slot, state) {
    var p = el('p');
    p.className = 'a1-hint im-draw';
    var theme = state.packToml && state.packToml.theme;
    var themeNames = (state.themes || []).map(function (t) {
      return t.name;
    });
    setText(p, IM.drawLine(slot, theme, themeNames));
    return p;
  }

  function themeNoteEl(state) {
    var theme = state.packToml && state.packToml.theme;
    var themeNames = (state.themes || []).map(function (t) {
      return t.name;
    });
    var lines = IM.themeNote(theme, themeNames);
    var wrap = el('div');
    wrap.className = 'a1-note';
    wrap.appendChild(icon('info'));
    var text = el('div');
    lines.forEach(function (line) {
      var p = el('p');
      setText(p, line);
      text.appendChild(p);
    });
    wrap.appendChild(text);
    return wrap;
  }

  /** The `.im-well.<ratio>` thumb: an `<img>` for a real thumb, an empty button, or (FR-28) a
   * `{kind:'path'}` card for a value outside the listed folder. Never a background-image (NFR-01). */
  function wellEl(thumb, ratioClass, extraClass, onEmptyClick, emptyFocusKey) {
    if (thumb.kind === 'img') {
      var img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = thumb.src;
      var wrap = el('span');
      wrap.className = 'im-well ' + ratioClass + (extraClass ? ' ' + extraClass : '');
      wrap.appendChild(img);
      return wrap;
    }
    if (thumb.kind === 'path') {
      var pathWrap = el('span');
      pathWrap.className = 'im-well ' + ratioClass + (extraClass ? ' ' + extraClass : '') + ' path';
      pathWrap.appendChild(icon('file'));
      var label = el('span');
      setText(label, 'vault file');
      pathWrap.appendChild(label);
      return pathWrap;
    }
    if (onEmptyClick) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'im-well empty ' + ratioClass + (extraClass ? ' ' + extraClass : '');
      if (emptyFocusKey) btn.setAttribute('data-focus-key', emptyFocusKey);
      btn.appendChild(icon('plus'));
      var text = el('span');
      setText(text, 'Choose art');
      btn.appendChild(text);
      btn.addEventListener('click', onEmptyClick);
      return btn;
    }
    var span = el('span');
    span.className = 'im-well empty ' + ratioClass + (extraClass ? ' ' + extraClass : '');
    var innerSpan = el('span');
    setText(innerSpan, 'Empty');
    span.appendChild(innerSpan);
    return span;
  }

  function tileGridEl(thumb) {
    var grid = el('span');
    grid.className = 'im-well r-1x1 im-tilegrid';
    if (thumb.kind === 'img') {
      for (var i = 0; i < 9; i++) {
        var img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = thumb.src;
        grid.appendChild(img);
      }
    }
    return grid;
  }

  function sizeLineEl(slot) {
    var guide = IM.guideFor(slot);
    var p = el('p');
    p.className = 'im1-size';
    p.appendChild(icon('frame'));
    var span = el('span');
    var b = el('b');
    setText(b, guide.w + ' × ' + guide.h);
    span.appendChild(document.createTextNode('Best at '));
    span.appendChild(b);
    span.appendChild(document.createTextNode(' · ' + guide.ratio + '. ' + IM.tipFor(slot)));
    p.appendChild(span);
    return p;
  }

  function adviceListEl(advice) {
    var ul = el('ul');
    ul.className = 'im-adv';
    advice.forEach(function (a) {
      var li = el('li');
      li.className = a.level;
      li.appendChild(icon(a.level === 'warn' ? 'warn' : a.level === 'ok' ? 'tick' : 'info'));
      var span = el('span');
      setText(span, a.text);
      li.appendChild(span);
      ul.appendChild(li);
    });
    return ul;
  }

  function fileLineEl(value, fromLabelText) {
    var wrap = el('div');
    wrap.className = 'im1-file';
    if (value) {
      var span = el('span');
      setText(span, IM.displayName(value));
      wrap.appendChild(span);
      var small = el('small');
      setText(small, fromLabelText);
      wrap.appendChild(small);
    } else {
      var none = el('span');
      none.className = 'a1-none';
      setText(none, 'Nothing chosen');
      wrap.appendChild(none);
    }
    return wrap;
  }

  // --- Upload zone (SD-56) --------------------------------------------------------------------

  function uploadZone(compact, state) {
    var zone = el('div');
    zone.className = 'im-drop' + (compact ? ' compact' : '');
    zone.appendChild(icon('upload'));
    var text = el('div');
    var b = el('b');
    setText(b, 'Add art');
    text.appendChild(b);
    var span = el('span');
    setText(span, 'Drop images here or ');
    // SD-56/SD-57: the mock's own "choose files" link, named `uploadBtn` -- the one busy-
    // sensitive local control in this file, tracked by `currentUploadBtn` for the busy-only
    // subscription in init() below.
    var uploadBtn = el('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'a1-link';
    uploadBtn.setAttribute('data-focus-key', 'upload');
    setText(uploadBtn, 'choose files');
    currentUploadBtn = uploadBtn;
    uploadBtn.disabled = store.isBusy();
    span.appendChild(uploadBtn);
    span.appendChild(document.createTextNode('. JPG, PNG, WebP, GIF, SVG or AVIF, up to 10 MiB each.'));
    text.appendChild(span);
    zone.appendChild(text);

    var fileInput = el('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = '.jpg,.jpeg,.png,.webp,.gif,.svg,.avif';
    fileInput.className = 'visually-hidden';
    fileInput.tabIndex = -1;
    fileInput.setAttribute('aria-label', 'Choose files to upload');
    zone.appendChild(fileInput);

    // axe aria-allowed-role (minor, best-practice): role="status" is not an allowed override on
    // a <ul> (its own implicit role is "list"); the live region lives on a wrapping <div>
    // instead, with the <ul> itself carrying no role of its own.
    var statusWrap = el('div');
    statusWrap.setAttribute('role', 'status');
    var status = el('ul');
    // Re-populate from the last batch's own lines (module state), so a re-render triggered by
    // this same upload's own store.load() doesn't wipe feedback the GM hasn't read yet.
    lastUploadStatus.forEach(function (line) {
      var li = el('li');
      setText(li, line);
      status.appendChild(li);
    });
    statusWrap.appendChild(status);
    zone.appendChild(statusWrap);

    uploadBtn.addEventListener('click', function () {
      fileInput.click();
    });

    function ignoreWhileBusy(ev) {
      if (store.isBusy() || uploading) {
        ev.preventDefault();
        return true;
      }
      return false;
    }

    zone.addEventListener('dragover', function (ev) {
      if (ignoreWhileBusy(ev)) return;
      ev.preventDefault();
      zone.classList.add('on');
    });
    zone.addEventListener('dragleave', function (ev) {
      if (ignoreWhileBusy(ev)) return;
      zone.classList.remove('on');
    });
    zone.addEventListener('drop', function (ev) {
      if (ignoreWhileBusy(ev)) return;
      ev.preventDefault();
      zone.classList.remove('on');
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) uploadFiles(files, status, zone, uploadBtn);
    });

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length) uploadFiles(fileInput.files, status, zone, uploadBtn);
      fileInput.value = '';
    });

    return zone;
  }

  /** FR-29: files upload sequentially, exactly PARENT's request shape; a refused file never
   * stops the rest. `afterSaved` is deliberately NOT called -- see the module doc. */
  function uploadFiles(fileList, statusEl, zoneEl, uploadBtn) {
    var files = Array.prototype.slice.call(fileList);
    uploading = true;
    uploadBtn.disabled = true;
    zoneEl.classList.add('on');
    clear(statusEl);
    lastUploadStatus = [];
    var bEl = zoneEl.querySelector('b');

    function uploadOne(file, i) {
      if (bEl) setText(bEl, 'Uploading ' + file.name + ' (' + (i + 1) + ' of ' + files.length + ')…');
      return api('/api/images/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      }).then(
        function (result) {
          var line;
          if (result.ok && result.body && result.body.ok === true) {
            line = file.name + ': saved';
          } else {
            var outcome = mapOutcomeSafe(result, 'save');
            line = file.name + ': ' + (outcome.message || 'not saved');
          }
          lastUploadStatus.push(line);
          var li = el('li');
          setText(li, line);
          statusEl.appendChild(li);
        },
        function () {
          var line = file.name + ': not saved';
          lastUploadStatus.push(line);
          var li = el('li');
          setText(li, line);
          statusEl.appendChild(li);
        },
      );
    }

    files
      .reduce(function (chain, file, i) {
        return chain.then(function () {
          return uploadOne(file, i);
        });
      }, Promise.resolve())
      .then(function () {
        uploading = false;
        zoneEl.classList.remove('on');
        if (bEl) setText(bEl, 'Add art');
        uploadBtn.disabled = store.isBusy();
        // No immediate scheduleRender() here: store.load() itself triggers a re-render once the
        // fresh state actually lands (the state-changed subscriber in init()). Calling
        // scheduleRender() synchronously, before that fetch resolves, would clear the status
        // list's own "<name>: saved" lines using the SAME stale state -- destroying the one
        // piece of feedback SD-56 exists to show, for no benefit (found live: the status list
        // never stayed on screen long enough to read).
        store.load();
      })
      .catch(function () {
        uploading = false;
        zoneEl.classList.remove('on');
        uploadBtn.disabled = store.isBusy();
        scheduleRender();
      });
  }

  // --- Pending bar (SD-56) --------------------------------------------------------------------

  function pendingBarEl(state) {
    var saved = savedImages(state);
    var keys = IM.pendKeys(pend, saved);
    var bar = el('div');
    bar.className = 'a1-pending' + (keys.length ? '' : ' lock');
    var grow = el('span');
    grow.className = 'grow';
    if (keys.length) {
      var dot = el('i');
      dot.className = 'a1-dot';
      grow.appendChild(dot);
      var span = el('span');
      setText(
        span,
        ' ' +
          keys.length +
          ' unsaved change' +
          (keys.length === 1 ? '' : 's') +
          ': ' +
          keys
            .map(function (k) {
              return IM.friendlyName(k);
            })
            .join(', '),
      );
      grow.appendChild(span);
    } else {
      grow.appendChild(icon('tick'));
      var saved2 = el('span');
      setText(saved2, 'Saved. Nothing to review.');
      grow.appendChild(saved2);
    }
    bar.appendChild(grow);

    var discardBtn = localEditButton('Discard', 'a1-btn ghost', function () {
      discardPend(state);
    });
    discardBtn.setAttribute('data-focus-key', 'discard');
    discardBtn.disabled = keys.length === 0;
    bar.appendChild(discardBtn);

    var reviewBtn = el('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'a1-btn primary';
    reviewBtn.setAttribute('data-focus-key', 'review');
    setText(reviewBtn, 'Review and save');
    var disabledReason = !state.packToml.exists || IM.pendKeys(pend, saved).length === 0;
    imagesOwnDisabled = disabledReason;
    reviewBtn.disabled = disabledReason || store.isBusy();
    imagesReviewBtn = reviewBtn;
    reviewBtn.addEventListener('click', function () {
      reviewBtn.disabled = true;
      reviewAndSave(state, reviewBtn, disabledReason);
    });
    bar.appendChild(reviewBtn);

    return bar;
  }

  // SD-57: the busy contract. These are the ONLY two controls whose disabled depends on isBusy.
  var currentUploadBtn = null;
  var imagesReviewBtn = null;
  var imagesOwnDisabled = false;

  // --- Review and save (SD-55) -----------------------------------------------------------------

  function reviewAndSave(state, reviewBtn, disabledReason) {
    var saved = savedImages(state);
    var payload = IM.slotsPayload(pend, saved);
    var dryBody = { slots: payload, baseSha256: store.baseSha('pack.toml'), dryRun: true };

    var pendingSlots = IM.pendKeys(pend, saved);
    var measurements = pendingSlots.map(function (slot) {
      return measureValue(pend[slot], state.images || []).then(function (dims) {
        return { slot: slot, dims: dims };
      });
    });

    Promise.all(measurements).then(function (results) {
      var advice = [];
      results.forEach(function (r) {
        if (!pend[r.slot]) return;
        var guide = IM.guideFor(r.slot);
        var name = IM.displayName(pend[r.slot]);
        IM.sizeAdvice(guide, r.dims, name)
          .filter(function (a) {
            return a.level === 'warn';
          })
          .forEach(function (a) {
            advice.push({ level: a.level, text: IM.friendlyName(r.slot) + ': ' + a.text });
          });
      });

      api('/api/pack/slots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dryBody) })
        .then(function (result) {
          reviewBtn.disabled = disabledReason || store.isBusy();
          if (!result.ok || !result.body || result.body.ok !== true) {
            renderDryFailure(mapOutcomeSafe(result, 'dry'));
            return;
          }
          ScriptoriumAdmin.slip.review({
            kind: 'slots',
            payload: { slots: payload },
            state: state,
            dry: result.body,
            dryBody: dryBody,
            advice: advice,
            path: '/api/pack/slots',
            trigger: reviewBtn,
            onSaved: function (body) {
              pend = {};
              afterSaved('images', body);
            },
          });
        })
        .catch(function () {
          reviewBtn.disabled = disabledReason || store.isBusy();
          renderDryFailure(mapOutcomeSafe({ ok: false, status: 0, body: null }, 'dry'));
        });
    });
  }

  function renderDryFailure(outcome) {
    if (!currentContainer) return;
    var existing = currentContainer.querySelector('.images-outcome');
    if (existing) existing.parentNode.removeChild(existing);
    if (!outcome || !outcome.message) return;
    var p = el('p');
    p.className = 'images-outcome';
    p.setAttribute('role', outcome.role === 'alert' ? 'alert' : 'status');
    setText(p, outcome.message);
    currentContainer.insertBefore(p, currentContainer.firstChild);
  }

  // --- The picker (im1, SD-56) ------------------------------------------------------------------

  function openPicker(slot, state) {
    ui.pickSlot = slot;
    var saved = savedImages(state);
    var current = IM.currentValue(pend, saved, slot);
    ui.pickSel = current || null;
    ui.pickTab = current && typeof current === 'string' && current.indexOf('vault:') === 0 ? 'vault' : 'up';
    renderPicker(state);
  }

  function closePicker() {
    ui.pickSlot = null;
    var dialog = document.getElementById('im-picker');
    if (dialog && dialog.open) dialog.close();
    if (renderDeferred) {
      renderDeferred = false;
      scheduleRender();
    }
  }

  function pickerDialogEl() {
    var dialog = document.getElementById('im-picker');
    if (dialog) return dialog;
    dialog = el('dialog');
    dialog.id = 'im-picker';
    dialog.className = 'im-picker';
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      closePicker();
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function renderPicker(state) {
    var slot = ui.pickSlot;
    if (!slot) return;
    var guide = IM.guideFor(slot);
    var dialog = pickerDialogEl();
    clear(dialog);

    var titleId = 'im-picker-title';
    dialog.setAttribute('aria-labelledby', titleId);

    var head = el('header');
    head.className = 'im-pk-head';
    var headText = el('div');
    var cap = el('div');
    cap.className = 'a1-cap';
    setText(cap, 'Choose art for');
    headText.appendChild(cap);
    var h2 = el('h2');
    h2.id = titleId;
    setText(h2, IM.friendlyName(slot) + ' ');
    var code = el('code');
    setText(code, slot);
    h2.appendChild(code);
    headText.appendChild(h2);
    head.appendChild(headText);
    var closeBtn = localEditButton('', 'a1-iconbtn', closePicker);
    closeBtn.setAttribute('title', 'Close');
    closeBtn.appendChild(icon('x'));
    head.appendChild(closeBtn);
    dialog.appendChild(head);

    var body = el('div');
    body.className = 'im-pk-body';

    // -- Library side --
    var lib = el('div');
    lib.className = 'im-pk-lib';
    var upEntries = (state.images || []).map(function (rel) {
      return { kind: 'up', rel: rel };
    });
    var vaultEntries = usableVaultEntries().concat((vaultArt ? vaultArt.entries.filter(function (e) { return !e.usable; }) : []));
    var tabs = el('div');
    tabs.className = 'a1-subtabs';
    tabs.setAttribute('role', 'tablist');
    var tabIds = ['up', 'vault'];
    var tabButtons = {};
    function selectTab(id) {
      ui.pickTab = id;
      renderPicker(state);
      if (tabButtons[id]) tabButtons[id].focus();
    }
    tabIds.forEach(function (id) {
      var btn = el('button');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.className = 'a1-subtab';
      btn.setAttribute('aria-selected', String(ui.pickTab === id));
      btn.setAttribute('data-focus-key', 'tab:' + id);
      setText(btn, (id === 'up' ? 'Uploaded ' : 'From your vault '));
      var small = el('small');
      setText(small, String(id === 'up' ? upEntries.length : vaultEntries.length));
      btn.appendChild(small);
      btn.addEventListener('click', function () {
        selectTab(id);
      });
      tabButtons[id] = btn;
      tabs.appendChild(btn);
    });
    tabs.addEventListener('keydown', function (ev) {
      var idx = tabIds.indexOf(ui.pickTab);
      var next = null;
      if (ev.key === 'ArrowRight') next = (idx + 1) % tabIds.length;
      else if (ev.key === 'ArrowLeft') next = (idx - 1 + tabIds.length) % tabIds.length;
      if (next !== null) {
        ev.preventDefault();
        selectTab(tabIds[next]);
      }
    });
    lib.appendChild(tabs);

    var grid = el('div');
    grid.className = 'im-pk-grid';

    function tileFor(src, label, dims, selected, disabled, onClick) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'im-tile';
      btn.setAttribute('aria-pressed', String(selected));
      if (disabled) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', onClick);
      }
      btn.appendChild(wellEl({ kind: 'img', src: src }, 'r-1x1'));
      var b = el('b');
      setText(b, label);
      btn.appendChild(b);
      var small = el('small');
      setText(small, dims ? dims.w + ' × ' + dims.h : disabled ? 'In an excluded folder' : 'drawn art');
      btn.appendChild(small);
      return btn;
    }

    if (ui.pickTab === 'up') {
      upEntries.forEach(function (e) {
        var src = IM.imageSrc(e.rel);
        measureImageRel(e.rel); // warms dimsCache; thumbnails re-render on load via <img> itself
        var selected = ui.pickSel === 'images/' + e.rel;
        grid.appendChild(
          tileFor(src, e.rel, dimsCache[src], selected, false, function () {
            ui.pickSel = 'images/' + e.rel;
            renderPicker(state);
          }),
        );
      });
    } else {
      vaultEntries.forEach(function (e) {
        var src = IM.vaultArtSrc(e.rel);
        if (e.usable) measureVaultRel(e.rel);
        var selected = ui.pickSel === 'vault:' + e.rel;
        grid.appendChild(
          tileFor(src, e.name, e.usable ? dimsCache[src] : null, selected, !e.usable, function () {
            ui.pickSel = 'vault:' + e.rel;
            renderPicker(state);
          }),
        );
      });
    }
    lib.appendChild(grid);

    if (ui.pickTab === 'up') {
      lib.appendChild(uploadZone(true, state));
    } else {
      var fine = el('p');
      fine.className = 'a1-fine';
      var folderName = (vaultArt && vaultArt.folder) || '_attachments';
      setText(fine, 'Art already in ' + folderName + '. It stays where it is in your vault; the spot points at it.');
      lib.appendChild(fine);

      var stateLineText = vaultListingStateLine();
      if (stateLineText) {
        var stateLine = el('p');
        stateLine.className = 'a1-fine';
        setText(stateLine, stateLineText);
        lib.appendChild(stateLine);
      }

      var lookAgain = localEditButton('Look again', 'a1-btn small ghost', function () {
        fetchVaultArt(state, true);
      });
      lib.appendChild(lookAgain);

      if (vaultArt && vaultArt.truncated) {
        var trunc = el('p');
        trunc.className = 'a1-fine';
        setText(trunc, 'Showing the first 2000 pictures in ' + folderName + '. To use one that isn’t shown, type its path below.');
        lib.appendChild(trunc);
      }

      var typedLabel = el('label');
      var typedText = el('span');
      setText(typedText, 'Or type a path inside your vault');
      typedLabel.appendChild(typedText);
      var typedInput = el('input');
      typedInput.type = 'text';
      typedInput.className = 'a1-in';
      typedInput.placeholder = 'vault:<path>';
      typedInput.value = ui.typedPath;
      typedInput.addEventListener('input', function () {
        ui.typedPath = typedInput.value;
      });
      typedLabel.appendChild(typedInput);
      lib.appendChild(typedLabel);
      var useTyped = localEditButton('Use this path', 'a1-btn small', function () {
        ui.pickSel = typedInput.value;
        renderPicker(state);
      });
      lib.appendChild(useTyped);
    }

    body.appendChild(lib);

    // -- Fit side --
    var fit = el('div');
    fit.className = 'im-pk-fit';
    var fitCap = el('div');
    fitCap.className = 'a1-cap';
    setText(fitCap, 'How it fits');
    fit.appendChild(fitCap);

    if (ui.pickSel) {
      var selSrc = ui.pickSel.indexOf('vault:') === 0 ? IM.vaultArtSrc(ui.pickSel.slice('vault:'.length)) : IM.imageSrc(ui.pickSel.replace(/^images\//, ''));
      var selThumb = { kind: 'img', src: selSrc };
      fit.appendChild(wellEl(selThumb, IM.ratioClassFor(slot), 'fit' + (guide.tile ? ' tile' : '')));
      var caption = el('p');
      caption.className = 'im-pk-cap';
      setText(caption, 'Cropped to ' + guide.ratio + (guide.tile ? ', repeated' : '') + '. Recommended ' + guide.w + ' × ' + guide.h + ' px.');
      fit.appendChild(caption);
      var dims = dimsCache[selSrc];
      fit.appendChild(adviceListEl(IM.sizeAdvice(guide, dims, ui.pickSel)));
    } else {
      var empty = el('div');
      empty.className = 'im-well empty';
      var span = el('span');
      setText(span, 'Pick an image');
      empty.appendChild(span);
      fit.appendChild(empty);
    }

    var btns = el('div');
    btns.className = 'im-pk-btns';
    btns.appendChild(localEditButton('Cancel', 'a1-btn ghost', closePicker));
    var useBtn = localEditButton('Use for ' + IM.friendlyName(slot), 'a1-btn primary', function () {
      setPend(IM.withPend(pend, savedImages(state), slot, ui.pickSel), state);
      closePicker();
    });
    useBtn.disabled = !ui.pickSel;
    btns.appendChild(useBtn);
    fit.appendChild(btns);
    body.appendChild(fit);

    dialog.appendChild(body);

    if (!dialog.open) {
      renderDeferred = false;
      dialog.showModal();
    }
  }

  function vaultListingStateLine() {
    var folder = (vaultArt && vaultArt.folder) || '_attachments';
    if (!vaultArt) return 'Looking…';
    if (vaultArt.status === 'missing') return "There's no " + folder + " folder in your vault yet, so there's no vault art to choose.";
    if (vaultArt.status === 'unavailable') return vaultArt.reason;
    if (vaultArt.entries.length === 0) return 'No pictures in ' + folder + ' yet.';
    return '';
  }

  // --- Vault art listing fetch (SD-55) ---------------------------------------------------------

  function fetchVaultArt(state, refresh) {
    if (vaultArt !== null && !refresh) return;
    api('/api/vault-art').then(function (result) {
      if (result.ok && result.body) {
        vaultArt = result.body;
        scheduleRender();
        if (ui.pickSlot) renderPicker(state);
      }
    });
  }

  // --- im1: slot gallery (SD-56) ------------------------------------------------------------

  function im1Card(slot, state, locked) {
    var saved = savedImages(state);
    var value = IM.currentValue(pend, saved, slot);
    var isPend = IM.pendKeys(pend, saved).indexOf(slot) !== -1;
    var thumb = IM.thumbFor(value, state.images || [], vaultRels());
    var guide = IM.guideFor(slot);

    var card = el('article');
    card.className = 'im1-card' + (isPend ? ' is-pend' : '') + (thumb.kind === 'empty' ? ' is-empty' : '');
    card.setAttribute('data-slot', slot);

    var header = el('header');
    var headText = el('div');
    var h3 = el('h3');
    setText(h3, IM.friendlyName(slot));
    headText.appendChild(h3);
    var code = el('code');
    setText(code, slot);
    headText.appendChild(code);
    header.appendChild(headText);
    header.appendChild(statusPillEl(IM.statusFor(pend, saved, slot)));
    card.appendChild(header);

    var well = el('div');
    well.className = 'im1-well';
    well.appendChild(
      wellEl(
        thumb,
        IM.ratioClassFor(slot),
        null,
        function () {
          openPicker(slot, state);
        },
        'pick:' + slot,
      ),
    );
    card.appendChild(well);

    card.appendChild(fileLineEl(value, IM.fromLabel(value)));

    var what = el('div');
    what.className = 'im1-what';
    var place = el('div');
    place.className = 'im-place';
    place.setAttribute('aria-hidden', 'true');
    what.appendChild(place);
    var p = el('p');
    setText(p, IM.purposeFor(slot).text);
    what.appendChild(p);
    card.appendChild(what);

    card.appendChild(drawLineEl(slot, state));
    card.appendChild(sizeLineEl(slot));

    if (isPend && value) {
      measureValue(value, state.images || []).then(function (dims) {
        var advice = IM.sizeAdvice(guide, dims, IM.displayName(value)).filter(function (a) {
          return a.level === 'warn';
        });
        if (advice.length) {
          var existing = card.querySelector('.im-adv');
          if (!existing && card.isConnected) card.insertBefore(adviceListEl(advice), card.querySelector('.im1-btns'));
        }
      });
    }

    var btns = el('div');
    btns.className = 'im1-btns';
    var changeBtn = localEditButton(thumb.kind === 'empty' ? 'Choose' : 'Change', 'a1-btn small', function () {
      openPicker(slot, state);
    });
    changeBtn.setAttribute('data-focus-key', 'pick:' + slot);
    changeBtn.insertBefore(icon('swap'), changeBtn.firstChild);
    changeBtn.disabled = locked;
    btns.appendChild(changeBtn);
    if (thumb.kind !== 'empty') {
      var removeBtn = localEditButton('Remove', 'a1-btn small ghost', function () {
        setFollow(slot);
        setPend(IM.withPend(pend, saved, slot, null), state);
      });
      removeBtn.setAttribute('data-focus-key', 'remove:' + slot);
      removeBtn.disabled = locked;
      btns.appendChild(removeBtn);
    }
    if (isPend) {
      var undoBtn = localEditButton('Undo', 'a1-link im1-undo', function () {
        var next = {};
        Object.keys(pend).forEach(function (k) {
          if (k !== slot) next[k] = pend[k];
        });
        setPend(next, state);
      });
      undoBtn.setAttribute('data-focus-key', 'undo:' + slot);
      btns.appendChild(undoBtn);
    }
    card.appendChild(btns);

    card.addEventListener('focusin', function () {
      setFollow(slot);
    });

    return card;
  }

  function im1View(container, state, locked) {
    container.appendChild(themeNoteEl(state));
    container.appendChild(uploadZone(false, state));

    var section = el('section');
    var heading = el('h2');
    heading.className = 'a1-rule';
    setText(heading, 'Where your art goes ');
    var small = el('small');
    setText(small, '6 spots');
    heading.appendChild(small);
    section.appendChild(heading);
    var grid = el('div');
    grid.className = 'im1-grid';
    SLOT_NAMES.forEach(function (slot) {
      grid.appendChild(im1Card(slot, state, locked));
    });
    section.appendChild(grid);
    container.appendChild(section);

    var upSection = el('section');
    var upHeading = el('h2');
    upHeading.className = 'a1-rule';
    setText(upHeading, 'Uploaded ');
    var upSmall = el('small');
    var images = state.images || [];
    setText(upSmall, images.length + ' file(s) in images/');
    upHeading.appendChild(upSmall);
    upSection.appendChild(upHeading);
    var upGrid = el('div');
    upGrid.className = 'im1-uploads';
    images.forEach(function (rel) {
      var up = el('div');
      up.className = 'im1-up';
      up.appendChild(wellEl({ kind: 'img', src: IM.imageSrc(rel) }, 'r-1x1'));
      var b = el('b');
      setText(b, rel);
      up.appendChild(b);
      var small2 = el('small');
      var used = IM.usedBy('images/' + rel, pend, savedImages(state));
      var src = IM.imageSrc(rel);
      measureImageRel(rel).then(function (dims) {
        if (small2.isConnected) {
          setText(
            small2,
            (dims ? dims.w + ' × ' + dims.h : '') +
              (used.length ? ' · ' + used.map(IM.friendlyName).join(', ') : ' · not used yet'),
          );
        }
      });
      setText(small2, used.length ? '· ' + used.map(IM.friendlyName).join(', ') : '· not used yet');
      up.appendChild(small2);
      upGrid.appendChild(up);
    });
    upSection.appendChild(upGrid);
    container.appendChild(upSection);

    container.appendChild(pendingBarEl(state));

    if (ui.pickSlot) renderPicker(state);
  }

  // --- im2: on the page (SD-56) ---------------------------------------------------------------

  function im2View(container, state, locked) {
    var saved = savedImages(state);

    var chips = el('div');
    chips.className = 'im2-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Spots');
    SLOT_NAMES.forEach(function (slot, i) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'ov-chip';
      btn.setAttribute('data-slot', slot);
      btn.setAttribute('aria-pressed', String(ui.sel === slot));
      var n = el('span');
      n.className = 'n';
      setText(n, String(i + 1));
      btn.appendChild(n);
      btn.appendChild(document.createTextNode(IM.friendlyName(slot)));
      if (IM.pendKeys(pend, saved).indexOf(slot) !== -1) {
        var dot = el('i');
        dot.className = 'a1-dot';
        btn.appendChild(dot);
      }
      btn.addEventListener('click', function () {
        ui.sel = slot;
        setFollow(slot);
        scheduleRender();
      });
      chips.appendChild(btn);
    });
    container.appendChild(chips);

    var grid = el('div');
    grid.className = 'im2-grid';

    var maps = el('div');
    maps.className = 'im2-maps';
    var fig = el('figure');
    fig.className = 'im2-fig';
    var figcap = el('figcaption');
    figcap.className = 'a1-cap';
    setText(figcap, 'A typical page');
    fig.appendChild(figcap);

    /** The shared zone-content builder: the slot's own art (or the im1/im3 empty state never
     * shows here -- im2's zones are never pickers, just a schematic), plus the fixed decorative
     * chrome the mock's own page drawing carries regardless of slot value. */
    function zoneContentEl(zone, slot) {
      var zoneValue = IM.currentValue(pend, saved, slot);
      var zoneThumb = IM.thumbFor(zoneValue, state.images || [], vaultRels());
      if (zoneThumb.kind === 'img') {
        if (slot === 'paper') {
          zone.appendChild(tileGridEl(zoneThumb));
        } else {
          var zoneImg = el('img');
          zoneImg.alt = '';
          zoneImg.loading = 'lazy';
          zoneImg.decoding = 'async';
          zoneImg.src = zoneThumb.src;
          zone.appendChild(zoneImg);
        }
      }
      return zoneValue;
    }

    function markerEl(slot, i, n) {
      var mk = el('button');
      mk.type = 'button';
      mk.className = 'im2-mk mk-' + slot + (ui.sel === slot ? ' is-sel' : '') + (IM.pendKeys(pend, saved).indexOf(slot) !== -1 ? ' is-pend' : '');
      mk.setAttribute('data-slot', slot);
      mk.setAttribute('title', IM.friendlyName(slot));
      mk.setAttribute('aria-label', n + ': ' + IM.friendlyName(slot));
      setText(mk, String(n));
      mk.addEventListener('click', function () {
        ui.sel = slot;
        setFollow(slot);
        scheduleRender();
      });
      return mk;
    }

    var siteTitle = (state.vaultConfigJson && state.vaultConfigJson.siteTitle) || '';

    var page = el('div');
    page.className = 'im2-page';

    // The ground zone: full-bleed background, behind everything else.
    var groundZone = el('div');
    var groundValue = zoneContentEl(groundZone, 'ground');
    groundZone.className = 'im2-z ground' + (ui.sel === 'ground' ? ' is-sel' : '') + (groundValue ? '' : ' is-empty');
    groundZone.setAttribute('aria-hidden', 'true');
    page.appendChild(groundZone);

    // The nav bar: decorative chrome, the same on every save (the mock's own "Story / Characters
    // / World" placeholder), carrying the real site title via the one real field it has.
    var nav = el('div');
    nav.className = 'im2-nav';
    nav.setAttribute('aria-hidden', 'true');
    setText(nav, siteTitle);
    var navSpan = el('span');
    setText(navSpan, 'Story ▾ · Characters · World');
    nav.appendChild(navSpan);
    page.appendChild(nav);

    // The hero zone.
    var heroZone = el('div');
    var heroValue = zoneContentEl(heroZone, 'hero');
    heroZone.className = 'im2-z hero' + (ui.sel === 'hero' ? ' is-sel' : '') + (heroValue ? '' : ' is-empty');
    heroZone.setAttribute('aria-hidden', 'true');
    var heroB = el('b');
    setText(heroB, siteTitle);
    heroZone.appendChild(heroB);
    page.appendChild(heroZone);

    // .im2-col: the paper zone (main column) beside the crest and portrait side columns.
    var col = el('div');
    col.className = 'im2-col';
    col.setAttribute('aria-hidden', 'true');

    var paperZone = el('div');
    var paperValue = zoneContentEl(paperZone, 'paper');
    paperZone.className = 'im2-z paper' + (ui.sel === 'paper' ? ' is-sel' : '') + (paperValue ? '' : ' is-empty');
    // Decorative text-line placeholders, always shown over the paper texture (the mock's own
    // fixed five-line block), representing body text -- never the slot's own content.
    [false, false, true, false, true].forEach(function (short) {
      var line = el('i');
      if (short) line.className = 's';
      paperZone.appendChild(line);
    });
    col.appendChild(paperZone);

    var crestSide = el('div');
    crestSide.className = 'im2-side';
    var crestZone = el('div');
    var crestValue = zoneContentEl(crestZone, 'crest-frame');
    crestZone.className = 'im2-z crest' + (ui.sel === 'crest-frame' ? ' is-sel' : '') + (crestValue ? '' : ' is-empty');
    // The sigil watermark: a fixed decorative placeholder, shown regardless of whether the slot
    // itself has a value, illustrating what the frame would hold (the mock's own img.sig).
    crestZone.appendChild(sigilEl());
    crestSide.appendChild(crestZone);
    var crestLabel = el('small');
    setText(crestLabel, 'A faction crest');
    crestSide.appendChild(crestLabel);
    col.appendChild(crestSide);

    var portraitSide = el('div');
    portraitSide.className = 'im2-side';
    var portraitZone = el('div');
    var portraitValue = zoneContentEl(portraitZone, 'portrait');
    portraitZone.className = 'im2-z portrait' + (ui.sel === 'portrait' ? ' is-sel' : '') + (portraitValue ? '' : ' is-empty');
    if (!portraitValue) {
      var portraitQ = el('span');
      setText(portraitQ, '?');
      portraitZone.appendChild(portraitQ);
    }
    portraitSide.appendChild(portraitZone);
    var portraitLabel = el('small');
    setText(portraitLabel, 'A character portrait');
    portraitSide.appendChild(portraitLabel);
    col.appendChild(portraitSide);

    page.appendChild(col);

    // The five markers (404 gets its own not-found drawing below), absolutely positioned by
    // their own .mk-<slot> class -- decoupled from where their zone sits in the DOM.
    SLOT_NAMES.filter(function (s) {
      return s !== '404';
    }).forEach(function (slot, i) {
      page.appendChild(markerEl(slot, i, i + 1));
    });
    fig.appendChild(page);
    maps.appendChild(fig);

    var nfFig = el('figure');
    nfFig.className = 'im2-fig sm';
    var nfCap = el('figcaption');
    nfCap.className = 'a1-cap';
    setText(nfCap, 'The not-found page');
    nfFig.appendChild(nfCap);
    var nf = el('div');
    nf.className = 'im2-404';
    var nfValue = IM.currentValue(pend, saved, '404');
    var nfThumb = IM.thumbFor(nfValue, state.images || [], vaultRels());
    var nfZone = el('div');
    nfZone.className = 'im2-z nf' + (ui.sel === '404' ? ' is-sel' : '') + (nfValue ? '' : ' is-empty');
    nfZone.setAttribute('aria-hidden', 'true');
    if (nfThumb.kind === 'img') {
      var nfImg = el('img');
      nfImg.alt = '';
      nfImg.loading = 'lazy';
      nfImg.decoding = 'async';
      nfImg.src = nfThumb.src;
      nfZone.appendChild(nfImg);
    }
    var nfB = el('b');
    setText(nfB, 'Page not found');
    nfZone.appendChild(nfB);
    nf.appendChild(nfZone);
    var nfMk = el('button');
    nfMk.type = 'button';
    nfMk.className = 'im2-mk mk-404' + (ui.sel === '404' ? ' is-sel' : '') + (IM.pendKeys(pend, saved).indexOf('404') !== -1 ? ' is-pend' : '');
    nfMk.setAttribute('data-slot', '404');
    nfMk.setAttribute('title', IM.friendlyName('404'));
    nfMk.setAttribute('aria-label', '6: ' + IM.friendlyName('404'));
    setText(nfMk, '6');
    nfMk.addEventListener('click', function () {
      ui.sel = '404';
      setFollow('404');
      scheduleRender();
    });
    nf.appendChild(nfMk);
    nfFig.appendChild(nf);
    maps.appendChild(nfFig);
    grid.appendChild(maps);

    // -- Inspector --
    var insp = el('aside');
    insp.className = 'im2-insp';
    insp.setAttribute('data-slot', ui.sel);
    var inspHeader = el('header');
    var inspText = el('div');
    var inspCap = el('div');
    inspCap.className = 'a1-cap';
    setText(inspCap, 'Spot ' + (SLOT_NAMES.indexOf(ui.sel) + 1) + ' of 6');
    inspText.appendChild(inspCap);
    var inspH2 = el('h2');
    setText(inspH2, IM.friendlyName(ui.sel));
    inspText.appendChild(inspH2);
    var inspCode = el('code');
    setText(inspCode, ui.sel);
    inspText.appendChild(inspCode);
    inspHeader.appendChild(inspText);
    inspHeader.appendChild(statusPillEl(IM.statusFor(pend, saved, ui.sel)));
    insp.appendChild(inspHeader);

    var inspD = el('p');
    inspD.className = 'im2-d';
    setText(inspD, IM.purposeFor(ui.sel).text);
    insp.appendChild(inspD);

    insp.appendChild(drawLineEl(ui.sel, state));

    var inspValue = IM.currentValue(pend, saved, ui.sel);
    var inspThumb = IM.thumbFor(inspValue, state.images || [], vaultRels());
    insp.appendChild(wellEl(inspThumb, IM.ratioClassFor(ui.sel), 'big'));
    insp.appendChild(fileLineEl(inspValue, IM.fromLabel(inspValue)));

    var guide = IM.guideFor(ui.sel);
    measureValue(inspValue, state.images || []).then(function (dims) {
      if (!insp.isConnected) return;
      var existing = insp.querySelector('.im-adv');
      if (existing) existing.parentNode.removeChild(existing);
      var advice = IM.sizeAdvice(guide, dims, IM.displayName(inspValue));
      insp.insertBefore(adviceListEl(advice), insp.querySelector('.im1-size'));
    });

    insp.appendChild(sizeLineEl(ui.sel));

    var choose = el('div');
    choose.className = 'im2-choose';
    var chooseCap = el('div');
    chooseCap.className = 'a1-cap';
    setText(chooseCap, 'Choose from your art ');
    var chooseSmall = el('small');
    setText(chooseSmall, 'best fits first');
    chooseCap.appendChild(chooseSmall);
    choose.appendChild(chooseCap);

    var strip = el('div');
    strip.className = 'im2-strip';
    var upItems = (state.images || []).map(function (rel) {
      return { value: 'images/' + rel, rel: rel, from: 'up' };
    });
    var vaultItems = usableVaultEntries().map(function (e) {
      return { value: 'vault:' + e.rel, rel: e.rel, from: 'vault' };
    });
    var allItems = upItems.concat(vaultItems);
    allItems.slice(0, 24).forEach(function (item) {
      var src = item.from === 'up' ? IM.imageSrc(item.rel) : IM.vaultArtSrc(item.rel);
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'im-tile sm';
      btn.setAttribute('aria-pressed', String(inspValue === item.value));
      btn.setAttribute('title', item.rel);
      btn.appendChild(wellEl({ kind: 'img', src: src }, 'r-1x1'));
      var small = el('small');
      setText(small, item.rel);
      btn.appendChild(small);
      btn.addEventListener('click', function () {
        setPend(IM.withPend(pend, saved, ui.sel, item.value), state);
      });
      strip.appendChild(btn);
    });
    choose.appendChild(strip);
    insp.appendChild(choose);

    var inspBtns = el('div');
    inspBtns.className = 'im1-btns';
    var uploadNewBtn = localEditButton('Upload new', 'a1-btn small', function () {
      var hidden = container.querySelector('.im-drop input[type=file]');
      if (hidden) hidden.click();
    });
    uploadNewBtn.insertBefore(icon('upload'), uploadNewBtn.firstChild);
    uploadNewBtn.setAttribute('data-focus-key', 'mk:' + ui.sel);
    inspBtns.appendChild(uploadNewBtn);
    if (inspThumb.kind !== 'empty') {
      var removeBtn = localEditButton('Remove', 'a1-btn small ghost', function () {
        setPend(IM.withPend(pend, saved, ui.sel, null), state);
      });
      removeBtn.setAttribute('data-focus-key', 'remove:' + ui.sel);
      inspBtns.appendChild(removeBtn);
    }
    if (IM.pendKeys(pend, saved).indexOf(ui.sel) !== -1) {
      var undoBtn = localEditButton('Undo', 'a1-link im1-undo', function () {
        var next = {};
        Object.keys(pend).forEach(function (k) {
          if (k !== ui.sel) next[k] = pend[k];
        });
        setPend(next, state);
      });
      undoBtn.setAttribute('data-focus-key', 'undo:' + ui.sel);
      inspBtns.appendChild(undoBtn);
    }
    insp.appendChild(inspBtns);

    grid.appendChild(insp);
    container.appendChild(grid);

    container.appendChild(themeNoteEl(state));
    container.appendChild(pendingBarEl(state));
    container.appendChild(uploadZone(true, state));
  }

  // --- im3: library first (SD-56) --------------------------------------------------------------

  function im3LibItems(state) {
    var upItems = (state.images || []).map(function (rel) {
      return { value: 'images/' + rel, rel: rel, name: rel, from: 'up' };
    });
    var vaultItems = usableVaultEntries().map(function (e) {
      return { value: 'vault:' + e.rel, rel: e.rel, name: e.name, from: 'vault' };
    });
    var all = upItems.concat(vaultItems);
    if (ui.libFilter === 'all') return all;
    return all.filter(function (it) {
      return it.from === ui.libFilter;
    });
  }

  function im3LibView(container, state) {
    var saved = savedImages(state);
    var section = el('section');
    section.className = 'im3-lib';

    var head = el('div');
    head.className = 'im3-libhead';
    var h2 = el('h2');
    h2.className = 'a1-rule';
    setText(h2, 'Your art ');
    var small = el('small');
    var totalCount = (state.images || []).length + usableVaultEntries().length;
    setText(small, totalCount + ' images');
    h2.appendChild(small);
    head.appendChild(h2);

    var seg = el('div');
    seg.className = 'a1-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Show');
    [
      ['all', 'All'],
      ['up', 'Uploaded'],
      ['vault', 'In your vault'],
    ].forEach(function (pair) {
      var btn = localEditButton(pair[1], '', function () {
        ui.libFilter = pair[0];
        scheduleRender();
      });
      btn.setAttribute('aria-pressed', String(ui.libFilter === pair[0]));
      seg.appendChild(btn);
    });
    head.appendChild(seg);
    section.appendChild(head);

    section.appendChild(uploadZone(true, state));

    var items = im3LibItems(state);
    var selItem = items.filter(function (it) {
      return it.value === ui.libSel;
    })[0];

    if (selItem) {
      var selbar = el('div');
      selbar.className = 'im3-selbar';
      var src = selItem.from === 'up' ? IM.imageSrc(selItem.rel) : IM.vaultArtSrc(selItem.rel);
      selbar.appendChild(wellEl({ kind: 'img', src: src }, 'r-1x1'));
      var textWrap = el('div');
      var b = el('b');
      setText(b, selItem.name);
      textWrap.appendChild(b);
      var smallDims = el('small');
      var dims = dimsCache[src];
      setText(smallDims, (dims ? dims.w + ' × ' + dims.h + ' px' : 'drawn art') + ' · ' + IM.fromLabel(selItem.value));
      textWrap.appendChild(smallDims);
      var span = el('span');
      var best = IM.bestSlotsFor(dims, selItem.name).map(IM.friendlyName);
      setText(span, 'Fits best as ' + best.join(' or ') + '. Choose a spot on the right.');
      textWrap.appendChild(span);
      selbar.appendChild(textWrap);
      var clearBtn = localEditButton('', 'a1-iconbtn', function () {
        ui.libSel = null;
        scheduleRender();
      });
      clearBtn.setAttribute('title', 'Clear selection');
      clearBtn.appendChild(icon('x'));
      selbar.appendChild(clearBtn);
      section.appendChild(selbar);
    } else {
      var fine = el('p');
      fine.className = 'a1-fine';
      setText(fine, 'Pick an image to place it.');
      section.appendChild(fine);
    }

    var grid = el('div');
    grid.className = 'im3-grid';
    items.slice(0, ui.libShown).forEach(function (it) {
      var src = it.from === 'up' ? IM.imageSrc(it.rel) : IM.vaultArtSrc(it.rel);
      if (it.from === 'up') measureImageRel(it.rel);
      else measureVaultRel(it.rel);
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'im-tile';
      btn.setAttribute('aria-pressed', String(ui.libSel === it.value));
      btn.appendChild(wellEl({ kind: 'img', src: src }, 'r-4x3'));
      var b = el('b');
      setText(b, it.name);
      btn.appendChild(b);
      var smallText = el('small');
      var d = dimsCache[src];
      setText(smallText, d ? d.w + ' × ' + d.h : 'drawn art');
      btn.appendChild(smallText);
      var used = IM.usedBy(it.value, pend, saved);
      if (used.length) {
        var usedSpan = el('span');
        usedSpan.className = 'im3-used';
        setText(usedSpan, used.map(IM.friendlyName).join(', '));
        btn.appendChild(usedSpan);
      }
      btn.addEventListener('click', function () {
        ui.libSel = it.value;
        if (ScriptoriumAdmin.views && store.get().viewport === 'phone') ui.mtab = 'slots';
        scheduleRender();
      });
      grid.appendChild(btn);
    });
    section.appendChild(grid);

    if (ui.libFilter === 'vault' || ui.libFilter === 'all') {
      var lookAgain = localEditButton('Look again', 'a1-btn small ghost', function () {
        fetchVaultArt(state, true);
      });
      lookAgain.setAttribute('data-focus-key', 'lookagain');
      section.appendChild(lookAgain);
    }

    return section;
  }

  function im3SlotsView(container, state) {
    var saved = savedImages(state);
    var selItem = im3LibItems(state).filter(function (it) {
      return it.value === ui.libSel;
    })[0];

    var section = el('section');
    section.className = 'im3-slots';
    var h2 = el('h2');
    h2.className = 'a1-rule';
    setText(h2, 'Spots on your site ');
    var small = el('small');
    setText(small, '6');
    h2.appendChild(small);
    section.appendChild(h2);

    var list = el('div');
    list.className = 'im3-list';
    SLOT_NAMES.forEach(function (slot) {
      var value = IM.currentValue(pend, saved, slot);
      var thumb = IM.thumbFor(value, state.images || [], vaultRels());
      var isPend = IM.pendKeys(pend, saved).indexOf(slot) !== -1;
      var row = el('div');
      row.className = 'im3-row' + (isPend ? ' is-pend' : '') + (selItem ? ' is-target' : '');
      row.setAttribute('data-slot', slot);
      row.appendChild(wellEl(thumb, 'r-1x1'));

      var mid = el('div');
      mid.className = 'im3-mid';
      var nameRow = el('div');
      nameRow.className = 'im3-name';
      var b = el('b');
      setText(b, IM.friendlyName(slot));
      nameRow.appendChild(b);
      var code = el('code');
      setText(code, slot);
      nameRow.appendChild(code);
      nameRow.appendChild(statusPillEl(IM.statusFor(pend, saved, slot)));
      mid.appendChild(nameRow);
      var smallText = el('small');
      setText(smallText, value ? IM.displayName(value) : IM.purposeFor(slot).text);
      mid.appendChild(smallText);

      var guide = IM.guideFor(slot);
      if (selItem) {
        var dims = dimsCache[selItem.from === 'up' ? IM.imageSrc(selItem.rel) : IM.vaultArtSrc(selItem.rel)];
        var advice = IM.sizeAdvice(guide, dims, selItem.name);
        var warn = advice.filter(function (a) {
          return a.level === 'warn';
        });
        var fitEl = el('span');
        fitEl.className = 'im3-fit ' + (warn.length ? 'warn' : 'ok');
        fitEl.appendChild(icon(warn.length ? 'warn' : 'tick'));
        var fitText = document.createTextNode(warn.length ? warn[0].text : 'Fits well');
        fitEl.appendChild(fitText);
        mid.appendChild(fitEl);
      } else {
        var szEl = el('span');
        szEl.className = 'im3-sz';
        setText(szEl, guide.ratio + ' · best ' + guide.w + ' × ' + guide.h);
        mid.appendChild(szEl);
      }
      // SD-56: im3's own draw line is rendered as a `small`, not the shared `p.im-draw`.
      var drawSmall = el('small');
      var theme = state.packToml && state.packToml.theme;
      var themeNames = (state.themes || []).map(function (t) {
        return t.name;
      });
      setText(drawSmall, IM.drawLine(slot, theme, themeNames));
      mid.appendChild(drawSmall);
      row.appendChild(mid);

      if (selItem) {
        var inUse = value === selItem.value;
        var useBtn = localEditButton(inUse ? 'In use' : 'Use here', 'a1-btn small' + (inUse ? '' : ' primary'), function () {
          setFollow(slot);
          setPend(IM.withPend(pend, saved, slot, selItem.value), state);
          ui.libSel = null;
        });
        useBtn.disabled = inUse;
        useBtn.setAttribute('data-focus-key', 'use:' + slot);
        row.appendChild(useBtn);
      } else if (thumb.kind !== 'empty') {
        var removeBtn = localEditButton('Remove', 'a1-btn small ghost', function () {
          setFollow(slot);
          setPend(IM.withPend(pend, saved, slot, null), state);
        });
        removeBtn.setAttribute('data-focus-key', 'remove:' + slot);
        row.appendChild(removeBtn);
      }

      row.addEventListener('focusin', function () {
        setFollow(slot);
      });
      list.appendChild(row);
    });
    section.appendChild(list);
    return section;
  }

  function im3View(container, state) {
    var viewport = store.get().viewport;
    if (viewport === 'phone') {
      var tabs = el('div');
      tabs.className = 'a1-subtabs';
      tabs.setAttribute('role', 'tablist');
      var slotsBtn = el('button');
      slotsBtn.type = 'button';
      slotsBtn.setAttribute('role', 'tab');
      slotsBtn.className = 'a1-subtab';
      slotsBtn.setAttribute('aria-selected', String(ui.mtab === 'slots'));
      slotsBtn.setAttribute('data-focus-key', 'tab:slots');
      setText(slotsBtn, 'Spots ');
      var slotsSmall = el('small');
      setText(slotsSmall, '6');
      slotsBtn.appendChild(slotsSmall);
      slotsBtn.addEventListener('click', function () {
        ui.mtab = 'slots';
        scheduleRender();
      });
      var artBtn = el('button');
      artBtn.type = 'button';
      artBtn.setAttribute('role', 'tab');
      artBtn.className = 'a1-subtab';
      artBtn.setAttribute('aria-selected', String(ui.mtab === 'lib'));
      artBtn.setAttribute('data-focus-key', 'tab:lib');
      setText(artBtn, 'Your art ');
      var artSmall = el('small');
      setText(artSmall, String(im3LibItems(state).length));
      artBtn.appendChild(artSmall);
      artBtn.addEventListener('click', function () {
        ui.mtab = 'lib';
        scheduleRender();
      });
      tabs.appendChild(slotsBtn);
      tabs.appendChild(artBtn);
      // The vocab.js tab pattern (setActiveTab's own ArrowLeft/ArrowRight handler): found live,
      // missing here -- only the picker's own .a1-subtabs had it.
      var mtabIds = ['slots', 'lib'];
      tabs.addEventListener('keydown', function (ev) {
        var idx = mtabIds.indexOf(ui.mtab);
        var next = null;
        if (ev.key === 'ArrowRight') next = (idx + 1) % mtabIds.length;
        else if (ev.key === 'ArrowLeft') next = (idx - 1 + mtabIds.length) % mtabIds.length;
        if (next !== null) {
          ev.preventDefault();
          ui.mtab = mtabIds[next];
          scheduleRender(); // synchronous: the DOM below is already rebuilt once this returns
          var key = 'tab:' + mtabIds[next];
          var btn = container.querySelector('[data-focus-key="' + key + '"]');
          if (btn) btn.focus();
        }
      });
      container.appendChild(tabs);

      if (ui.mtab === 'lib') {
        container.appendChild(im3LibView(container, state));
      } else {
        container.appendChild(im3SlotsView(container, state));
      }
    } else {
      var panes = el('div');
      panes.className = 'im3-panes';
      panes.appendChild(im3LibView(container, state));
      panes.appendChild(im3SlotsView(container, state));
      container.appendChild(panes);
    }

    container.appendChild(themeNoteEl(state));
    container.appendChild(pendingBarEl(state));
  }

  // -- Shared render/init (SD-55) ---------------------------------------------------------------

  function render(container, state) {
    if (document.getElementById('admin-slip') && document.getElementById('admin-slip').open) {
      renderDeferred = true;
      return;
    }
    var pickerOpen = document.getElementById('im-picker') && document.getElementById('im-picker').open;
    if (pickerOpen) {
      renderDeferred = true;
      return;
    }

    var focusKey = activeFocusKey(container);
    clear(container);
    currentContainer = container;

    if (!state.writable) {
      var reason = el('p');
      reason.className = 'images-readonly';
      setText(reason, state.readOnlyReason || 'This campaign is read-only.');
      container.appendChild(reason);
      return;
    }

    fetchVaultArt(state, false);

    var locked = !state.packToml || !state.packToml.exists;
    if (locked) {
      var note = el('div');
      note.className = 'a1-note';
      note.appendChild(icon('info'));
      var p = el('p');
      setText(p, 'Save a theme first; that creates pack.toml.');
      note.appendChild(p);
      container.appendChild(note);
    }

    var view = (ScriptoriumAdmin.views && ScriptoriumAdmin.views.current('images')) || 'im1';
    if (['im1', 'im2', 'im3'].indexOf(view) === -1) view = 'im1';
    container.className = view;

    if (view === 'im1') im1View(container, state, locked);
    else if (view === 'im2') im2View(container, state, locked);
    else im3View(container, state, locked);

    var fallbackPrefix = view === 'im2' ? 'mk' : 'pick';
    // The slot just acted on (found live: Remove's own control disappears once a slot is
    // cleared, so the "same key" lookup above always misses for Remove -- the fallback must
    // target THAT slot's pick:<slot>, not always the first one).
    var keySlot = slotFromFocusKey(focusKey);
    var fallbackSlot = view === 'im2' ? ui.sel : keySlot || SLOT_NAMES[0];
    restoreFocus(container, focusKey, fallbackSlot, fallbackPrefix);
  }

  function scheduleRender() {
    if (!currentContainer) return;
    var s = store.get();
    if (!s.state) return;
    render(currentContainer, s.state);
  }

  function init(container) {
    currentContainer = container;

    store.subscribe(function (next, prev) {
      if (next.state !== prev.state || next.prefs !== prev.prefs || next.viewport !== prev.viewport) {
        scheduleRender();
      }
    });

    // SD-57: the busy contract. Only Choose files (uploadBtn-equivalent, the upload zone's own
    // file input trigger has no single button here -- the review button is the one POSTing
    // control besides upload) and Review and save obey busy; every local edit control is built
    // through localEditButton above, whose body never mentions isBusy.
    store.subscribe(function (next, prev) {
      if (next.busy === prev.busy) return;
      if (currentUploadBtn) currentUploadBtn.disabled = store.isBusy();
      if (imagesReviewBtn) imagesReviewBtn.disabled = imagesOwnDisabled || store.isBusy();
    });

    scheduleRender();
  }

  ScriptoriumAdmin.register('images', function (container) {
    init(container);
  });
})();
