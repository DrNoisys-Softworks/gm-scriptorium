'use strict';

/*
 * Panel v2 V1a. NV: the nav literal, the fragment router's pure grammar (parseFragment,
 * hrefFor), and the shared placeholder copy (shared design 1.2, 1.5). Pure: never touches
 * window/document above the module.exports guard (the VB pattern, vocab.js:20-108).
 *
 * parseFragment matches ^#\/([a-z][a-z-]*)(?:\/([a-z][a-z-]*))?$ and checks <screen> by EXACT
 * ARRAY membership (SCREEN_IDS.indexOf(...)), never an object/property lookup -- an object
 * lookup would resolve '#/constructor' to Object.prototype.constructor (risk area 4 / mutation
 * M3). Anything that doesn't match, or whose screen isn't a known id, falls back to
 * { screen: 'overview', sub: null }. No decoding, never throws; sub passes through unvalidated
 * (each screen validates its own sub).
 */
(function () {
  // V1d-1 SD-5: eyebrow/lede strings for frame.screenHeader (a1 port). Placeholders (soon:
  // true; issue #109) sit in the 'Coming later' group, carry a one-line plain-English lede of what
  // they will do (never a date), and their body says they are not built yet.
  // Overview keeps ownHeader (its hero is hand-built in views.js, per SD-5), so it carries no
  // eyebrow/lede of its own here.
  var NAV = [
    { id: 'overview', group: 'Site', label: 'Overview', short: 'Home', icon: 'home', soon: false, readOnly: false, ownHeader: true },
    {
      id: 'theme',
      group: 'Site',
      label: 'Theme',
      short: 'Theme',
      icon: 'theme',
      soon: false,
      readOnly: false,
      eyebrow: 'pack.toml · theme',
      lede: 'Your own site, built privately in each theme. Pick one, then review the change.',
    },
    {
      id: 'title',
      group: 'Site',
      label: 'Title & tagline',
      short: 'Title & tagline',
      icon: 'title',
      soon: false,
      readOnly: false,
      // V1e-1 (SD-7): the title comes from vault.config.json, the tagline from vault-config.md
      // (ADR 0033) -- two files, one screen.
      eyebrow: 'vault.config.json · vault-config.md',
      lede: 'The name and one-line tagline on your landing page. The name is saved in vault.config.json and the tagline in vault-config.md. The rest of both files is read-only here.',
    },
    {
      id: 'images',
      group: 'Site',
      label: 'Images',
      short: 'Images',
      icon: 'images',
      soon: false,
      readOnly: false,
      eyebrow: 'Your site’s art',
      lede: "The pictures your site can use, and which picture fills each spot. Change as many spots as you like; they're saved only when you review them. Uploads are saved as soon as they finish.",
    },
    {
      id: 'vocab',
      group: 'Words',
      label: 'Vocabulary',
      short: 'Vocab',
      icon: 'vocab',
      soon: false,
      readOnly: false,
      eyebrow: 'pack.toml · [labels] [timeline] [recaps]',
      lede: 'The words the player site uses, and the patterns it reads from your Timeline page. Leave a field empty to use the default.',
    },
    {
      id: 'check',
      group: 'Run',
      label: 'Check',
      short: 'Check',
      icon: 'check',
      soon: false,
      readOnly: false,
      eyebrow: 'check',
      lede: 'Runs the same checks as scriptorium check, against the vault as it is now.',
    },
    {
      id: 'preview',
      group: 'Run',
      label: 'Preview',
      short: 'Preview',
      icon: 'preview',
      soon: false,
      readOnly: false,
      eyebrow: 'preview',
      lede: 'Builds the site into a private preview on this machine. Nothing is published.',
    },
    {
      id: 'vault-config',
      group: 'Advanced',
      label: 'vault-config.md',
      short: 'vault-config.md',
      icon: 'file',
      soon: false,
      readOnly: false,
      guarded: true,
      eyebrow: '_meta/vault-config.md',
      lede: "Your vault's own settings note. gm-apprentice and GM-Scriptorium both read it: it sets the publish mode, what stays private, the site's look and the landing page.",
    },
    {
      id: 'remote',
      group: 'Setup',
      label: 'Remote access',
      short: 'Remote',
      icon: 'globe',
      soon: false,
      readOnly: false,
      eyebrow: 'Setup · remote access',
      lede: 'Where the panel can be used from. The panel can change your campaign files, so remote access always needs HTTPS and a password. This screen only shows the state; the commands that change it are listed below.',
    },
    {
      id: 'memory',
      group: 'Coming later',
      label: 'Memory',
      short: 'Memory',
      icon: 'memory',
      soon: true,
      readOnly: false,
      eyebrow: 'Roadmap, not built yet',
      lede: 'Keep a short, curated memory of your campaign (people, places and open threads) and review it before anything is saved.',
    },
    {
      id: 'publish',
      group: 'Coming later',
      label: 'Publish',
      short: 'Publish',
      icon: 'publish',
      soon: true,
      readOnly: false,
      eyebrow: 'Roadmap, not built yet',
      lede: 'Check a fresh build, then send it to your live site in a few guided steps, with a way to go back.',
    },
    {
      id: 'sessions',
      group: 'Coming later',
      label: 'Sessions',
      short: 'Sessions',
      icon: 'mic',
      soon: true,
      readOnly: false,
      eyebrow: 'Roadmap, not built yet',
      lede: 'Turn a session recording into a transcript and a draft recap that you review before it is filed.',
    },
    {
      id: 'ai',
      group: 'Coming later',
      label: 'AI console',
      short: 'AI console',
      icon: 'ai',
      soon: true,
      readOnly: false,
      eyebrow: 'Roadmap, not built yet',
      lede: 'Chat with an AI model using your own key, with only the campaign notes you choose to share.',
    },
    {
      id: 'storage',
      group: 'Coming later',
      label: 'Storage',
      short: 'Storage',
      icon: 'storage',
      soon: true,
      readOnly: false,
      eyebrow: 'Roadmap, not built yet',
      lede: 'Pick and see the places this campaign keeps its vault, art and site files.',
    },
  ];

  // V1e-2 (ADR 0033 SS7, SD-10, SD-11): the switcher's own options per screen, typed from the r3
  // mocks' OPTS[*].{id,name} (panel-v3-mockups/r3-src/{overview,title,images,vocab,vaultcfg}.js).
  // Keyed by nav screen id (the same ids NV.NAV already uses), never by the prefs key -- callers
  // that need the prefs key use 'view.' + screen id.
  var VIEWS = {
    overview: [
      { id: 'ov1', name: 'Docked preview' },
      { id: 'ov2', name: 'Split screen' },
      { id: 'ov3', name: 'Postcards' },
    ],
    title: [
      { id: 'tt1', name: 'Title card' },
      { id: 'tt2', name: 'Where it shows' },
      { id: 'tt3', name: 'Site details' },
    ],
    images: [
      { id: 'im1', name: 'Slot gallery' },
      { id: 'im2', name: 'On the page' },
      { id: 'im3', name: 'Library first' },
    ],
    vocab: [
      { id: 'vo1', name: 'How-to rail' },
      { id: 'vo2', name: 'Live example' },
      { id: 'vo3', name: 'Friendly rows' },
    ],
    'vault-config': [
      { id: 'vc1', name: 'Guarded dialog' },
      { id: 'vc2', name: 'Unlock and watch' },
      { id: 'vc3', name: 'Fields by risk' },
    ],
  };

  var VIEW_SCREEN_IDS = Object.keys(VIEWS);

  // V1e-3 (SD-20): the three viewport classes, this file's own copy (drift-tested against
  // src/admin/prefs.js's identical VIEWPORTS export, test/admin-v1e2-model.test.js).
  var VIEWPORTS = ['wide', 'laptop', 'phone'];

  // V1e-3 (SD-20): mirrors src/admin/prefs.js's PREF_SCHEMA defaults exactly (drift-tested,
  // test/admin-v1e2-model.test.js). 21 keys: each of the 5 screens x 3 viewport classes, plus
  // pane placement per laptop/phone, plus the 4 unchanged single-value keys. Each view default is
  // its mock's first (leftmost) option (D-15). Owner decision (2026-09-30): pane.place.laptop and
  // pane.place.phone both default to "below the content", overriding the Architect's own
  // drawer/sheet overlay default.
  var PREF_DEFAULTS = {
    'view.overview.wide': 'ov1',
    'view.overview.laptop': 'ov1',
    'view.overview.phone': 'ov1',
    'view.title.wide': 'tt1',
    'view.title.laptop': 'tt1',
    'view.title.phone': 'tt1',
    'view.images.wide': 'im1',
    'view.images.laptop': 'im1',
    'view.images.phone': 'im1',
    'view.vocab.wide': 'vo1',
    'view.vocab.laptop': 'vo1',
    'view.vocab.phone': 'vo1',
    'view.vault-config.wide': 'vc1',
    'view.vault-config.laptop': 'vc1',
    'view.vault-config.phone': 'vc1',
    'pane.place.laptop': 'below',
    'pane.place.phone': 'below',
    'pane.hidden': false,
    'rail.hidden': false,
    'ov2.follow': true,
    'preview.device': 'desktop',
  };

  /**
   * `'view.' + screen + '.' + viewport`, or null unless BOTH `screen` and `viewport` are exact
   * members of their own frozen id lists (never an object/property lookup on either candidate
   * value -- '#/constructor'-style strings can never resolve to anything but null here).
   *
   * @param {string} screen
   * @param {'wide'|'laptop'|'phone'} viewport
   * @returns {string|null}
   */
  function viewKey(screen, viewport) {
    if (VIEW_SCREEN_IDS.indexOf(screen) === -1) return null;
    if (VIEWPORTS.indexOf(viewport) === -1) return null;
    return 'view.' + screen + '.' + viewport;
  }

  /**
   * The view id to show for `screen` at `viewport`, from `prefs` (the store's current prefs
   * object, or null/undefined before it has loaded). Exact array membership against
   * VIEWS[screen] (never an object/property lookup on the candidate value) -- '#/constructor'-
   * style strings can never resolve to anything but "not found" here (risk area 4 / mutation P7).
   * An unknown viewport is treated as 'laptop'; an unknown screen gives null.
   *
   * @param {Record<string, unknown>|null|undefined} prefs
   * @param {string} screen
   * @param {string} [viewport]
   * @returns {string|null} a real view id for a known screen, else null
   */
  function viewFor(prefs, screen, viewport) {
    if (VIEW_SCREEN_IDS.indexOf(screen) === -1) return null;
    var vp = VIEWPORTS.indexOf(viewport) === -1 ? 'laptop' : viewport;
    var options = VIEWS[screen];
    var key = viewKey(screen, vp);
    var candidate = prefs && Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : undefined;
    for (var i = 0; i < options.length; i++) {
      if (options[i].id === candidate) return candidate;
    }
    return PREF_DEFAULTS[key];
  }

  /**
   * V1e-3 (SD-20, SD-21): the pane placement choice for laptop/phone -- always 'overlay' at wide
   * or for an unknown viewport (there is no below option at wide).
   *
   * @param {Record<string, unknown>|null|undefined} prefs
   * @param {'wide'|'laptop'|'phone'} viewport
   * @returns {'overlay'|'below'}
   */
  function placeFor(prefs, viewport) {
    if (viewport !== 'laptop' && viewport !== 'phone') return 'overlay';
    var key = 'pane.place.' + viewport;
    var candidate = prefs && Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : undefined;
    return candidate === 'overlay' || candidate === 'below' ? candidate : PREF_DEFAULTS[key];
  }

  // V1e-2 (SD-12): the pane slot's pure layout policy. viewportClass mirrors the a1 breakpoints
  // (admin.css: 699 collapses the sidebar; 1800 is the wide-only padding step) as named classes,
  // so paneLayout's own table reads by name rather than by bare numbers.
  var VIEWPORT_WIDE_MIN = 1800;
  var VIEWPORT_PHONE_MAX = 699;

  function viewportClass(width) {
    if (width >= VIEWPORT_WIDE_MIN) return 'wide';
    if (width <= VIEWPORT_PHONE_MAX) return 'phone';
    return 'laptop';
  }

  /**
   * A pane "spec" is `{ label, className, presentation:{wide,laptop,phone}, hideable, hiddenPref,
   * hiddenAs, belowable, ownTrigger, build }` (frame.js's ScriptoriumAdmin.pane.register
   * contract). Nothing here reads `build`; this function only decides layout.
   *
   * @param {'wide'|'laptop'|'phone'} viewport
   * @param {object|null} screenSpec the current screen's own registered spec, or null
   * @param {object|null} globalSpec the '*' (global) registered spec, or null
   * @param {Record<string, unknown>} prefs
   * @returns {{ dock: {owner:string,spec:object}|null, below: {owner:string,spec:object}|null, edges: Array<{owner:string,spec:object,action:string,pref?:string}>, overlay: {owner:string,spec:object,kind:string}|null, inline: {owner:string,spec:object}|null }}
   */
  function paneLayout(viewport, screenSpec, globalSpec, prefs) {
    prefs = prefs || {};
    var result = { dock: null, below: null, edges: [], overlay: null, inline: null };

    var winner = screenSpec || globalSpec;
    if (winner) {
      var owner = screenSpec ? 'screen' : 'global';
      var mode = winner.presentation ? winner.presentation[viewport] : null;

      if (mode === 'dock') {
        var hidden = !!(winner.hideable && winner.hiddenPref && prefs[winner.hiddenPref]);
        if (hidden) {
          if (winner.hiddenAs === 'edge') result.edges.push({ owner: owner, spec: winner, action: 'reveal' });
          // hiddenAs === 'none': hidden with no edge tab at all.
        } else {
          result.dock = { owner: owner, spec: winner };
        }
      } else if (mode === 'drawer' || mode === 'sheet') {
        // V1e-3 (SD-21): "below" -- opted into by the spec (belowable) and chosen by the person
        // (placeFor) -- replaces the overlay entirely: no dialog, no open edge.
        if (winner.belowable === true && placeFor(prefs, viewport) === 'below') {
          result.below = { owner: owner, spec: winner };
        } else {
          result.overlay = { owner: owner, spec: winner, kind: mode };
          // ownTrigger: the consumer draws its own trigger (e.g. sitepane's pane-head button, or
          // the phone top-bar slot), so the generic edge-tab "open" trigger is omitted. 'reveal'
          // edges (the hidden-dock case above) are a different action and are unaffected.
          if (winner.ownTrigger !== true) {
            result.edges.push({ owner: owner, spec: winner, action: 'open' });
          }
        }
      } else if (mode === 'inline') {
        result.inline = { owner: owner, spec: winner };
      }
      // null/undefined/anything else: nothing shows for this spec at this viewport.
    }

    // D-16: at wide, when a screen's own spec is winning and a DISTINCT global spec also docks
    // at wide, the global pane never disappears -- it collapses to a SWAP edge tab (V1e-3: a
    // "reveal" edge here would set the global's own hiddenPref, which does nothing, because the
    // global isn't hidden, it's merely outranked). Clicking swap sets the SCREEN spec's own
    // hiddenPref instead, so the screen's rail hides and the global preview takes its place. With
    // no hideable screen spec, there is deliberately no dead edge.
    if (viewport === 'wide' && screenSpec && globalSpec && screenSpec !== globalSpec) {
      var globalWideMode = globalSpec.presentation && globalSpec.presentation.wide;
      if (globalWideMode === 'dock') {
        if (screenSpec.hideable && screenSpec.hiddenPref) {
          result.edges.push({ owner: 'global', spec: globalSpec, action: 'swap', pref: screenSpec.hiddenPref });
        }
      }
    }

    return result;
  }

  /**
   * V1e-3 rework (Reviewer finding, 2026-09-30): the pure decision half of
   * frame.closeOverlay()'s focus-return fallback. `document.querySelector` on
   * `[data-pane-trigger="<owner>"]` returns the FIRST DOM match, not a focusable one -- at laptop
   * width there are two live elements with the same owner (the hero "Site preview" button and the
   * hidden phone top-bar "Preview" button), and the hidden one sorts first in document order.
   * `.focus()` on a hidden element is a silent no-op, so focus fell through to `<body>`.
   *
   * This function only decides WHICH index to focus, given plain descriptors -- it never touches
   * the DOM itself, so it is unit-testable under plain node with no fake DOM at all. The caller
   * builds `descriptors` from the real candidate elements, in the same order, and calls
   * `.focus()` on the chosen one itself.
   *
   * @param {Array<{connected: boolean, visible: boolean}|null|undefined>} descriptors
   * @returns {number} the index of the first candidate that is both connected and visible, else -1
   */
  function pickFocusTarget(descriptors) {
    for (var i = 0; i < descriptors.length; i++) {
      var d = descriptors[i];
      if (d && d.connected === true && d.visible === true) return i;
    }
    return -1;
  }

  // Issue #109: the five unbuilt screens sit together, last, under "Coming later". The Setup group
  // is back with the one built screen it holds (Remote access), just above it.
  var GROUP_ORDER = ['Site', 'Words', 'Run', 'Advanced', 'Setup', 'Coming later'];
  var ROADMAP_GROUP = 'Coming later';

  var BOTTOM_BAR = ['overview', 'vocab', 'check', 'preview'];

  var SOON_SENTENCE = 'Not built yet. It is on the roadmap, so nothing here does anything today.';
  var SOON_STATUS = 'Roadmap, not built yet';

  var SCREEN_IDS = NAV.map(function (n) {
    return n.id;
  });

  var FRAGMENT_RE = /^#\/([a-z][a-z-]*)(?:\/([a-z][a-z-]*))?$/;

  function ids() {
    return SCREEN_IDS.slice();
  }

  function item(id) {
    for (var i = 0; i < NAV.length; i++) {
      if (NAV[i].id === id) return NAV[i];
    }
    return null;
  }

  function parseFragment(hash) {
    if (typeof hash !== 'string') return { screen: 'overview', sub: null };
    var m = FRAGMENT_RE.exec(hash);
    if (!m) return { screen: 'overview', sub: null };
    var screen = m[1];
    // Exact array membership, never an object/property lookup (risk area 4, mutation M3).
    if (SCREEN_IDS.indexOf(screen) === -1) return { screen: 'overview', sub: null };
    return { screen: screen, sub: m[2] || null };
  }

  /**
   * Issue #109: like parseFragment, but a '#/...' fragment that names no screen (or is malformed)
   * resolves to { screen: 'notfound', sub: null } rather than silently becoming Overview. Empty
   * fragments ('', '#', '#/') and non-'#/' fragments (an in-page '#main' anchor) stay Overview.
   * 'notfound' is deliberately NOT in SCREEN_IDS/NAV: it is a frame state, not a nav screen.
   */
  function resolveRoute(hash) {
    var route = parseFragment(hash);
    if (typeof hash !== 'string' || hash.indexOf('#/') !== 0 || hash === '#/') return route;
    var m = FRAGMENT_RE.exec(hash);
    if (!m || SCREEN_IDS.indexOf(m[1]) === -1) return { screen: 'notfound', sub: null };
    return route;
  }

  function hrefFor(id, sub) {
    return '#/' + id + (sub ? '/' + sub : '');
  }

  /**
   * V1e-9 (SD-102, D-5): the Advanced group's guard marker, for the one `item.guarded` nav entry
   * (vault-config.md). A read-only campaign always shows "read-only", regardless of `editing`
   * (which can never become true there in the first place -- D-18).
   *
   * @param {boolean} writable
   * @param {boolean} editing
   * @returns {{cls: string, text: string}}
   */
  function guardMarker(writable, editing) {
    if (writable === false) return { cls: 'a1-ro', text: 'read-only' };
    if (editing === true) return { cls: 'a1-warnpill', text: 'editing' };
    return { cls: 'a1-warnpill', text: 'guarded' };
  }

  var NV = {
    NAV: NAV,
    GROUP_ORDER: GROUP_ORDER,
    ROADMAP_GROUP: ROADMAP_GROUP,
    resolveRoute: resolveRoute,
    guardMarker: guardMarker,
    BOTTOM_BAR: BOTTOM_BAR,
    SOON_SENTENCE: SOON_SENTENCE,
    SOON_STATUS: SOON_STATUS,
    ids: ids,
    item: item,
    parseFragment: parseFragment,
    hrefFor: hrefFor,
    // V1e-2 additions (SD-10, SD-11, SD-12).
    VIEWS: VIEWS,
    PREF_DEFAULTS: PREF_DEFAULTS,
    viewFor: viewFor,
    viewportClass: viewportClass,
    paneLayout: paneLayout,
    // V1e-3 additions (SD-20, SD-21).
    VIEWPORTS: VIEWPORTS,
    viewKey: viewKey,
    placeFor: placeFor,
    // V1e-3 rework (Reviewer finding, 2026-09-30): closeOverlay()'s focus-return fallback.
    pickFocusTarget: pickFocusTarget,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { NV: NV };
    return;
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.NV = NV;
})();
