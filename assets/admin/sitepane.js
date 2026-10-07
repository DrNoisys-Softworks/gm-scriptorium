'use strict';

/*
 * V1e-3 (SD-23, FR-15 to FR-19). The Overview's live preview: ov1 (docked pane / drawer / full-
 * screen sheet / below), ov2 (split screen / laptop+phone tabs), ov3 (postcard rail / strip /
 * lightbox). PV is the pure half (the VB pattern, vocab.js:20-108), above the module.exports
 * guard -- everything in it is unit-testable under plain node, with no DOM. The browser half
 * (ScriptoriumAdmin.sitePane) follows the guard.
 *
 * Security (SD-16, ADR 0035): every frame this file builds is built in this exact order --
 * createElement('iframe'), setAttribute('sandbox', PV.FRAME_SANDBOX), setAttribute
 * ('referrerpolicy', 'no-referrer'), loading = 'lazy', title, THEN src, then append -- so the
 * sandbox always applies before the first navigation. Every frame's src is built ONLY by
 * PV.frameSrc, on the preview origin, never an inline document written into the frame directly.
 * No message listener, no postMessage, no document.domain anywhere in this file.
 */
(function () {
  // ===============================================================================================
  // PV: pure (above the guard)
  // ===============================================================================================

  function isFramingHostname(hostname) {
    return hostname === '127.0.0.1' || hostname === 'localhost';
  }

  function isFramingPort(port) {
    return typeof port === 'number' && Number.isFinite(port) && Math.floor(port) === port && port >= 1 && port <= 65535;
  }

  var FORBIDDEN_REL_CHARS = ['\\', ':', '?', '#'];

  /**
   * @param {unknown} hostname exactly '127.0.0.1' or 'localhost'
   * @param {unknown} port an integer 1-65535
   * @param {unknown} rel non-empty, no leading '/', no '\', ':', '?' or '#', no '', '.' or '..'
   *   path segment
   * @returns {string|null}
   */
  function frameSrc(hostname, port, rel) {
    if (!isFramingHostname(hostname)) return null;
    if (!isFramingPort(port)) return null;
    if (typeof rel !== 'string' || rel.length === 0) return null;
    if (rel.charAt(0) === '/') return null;
    for (var i = 0; i < FORBIDDEN_REL_CHARS.length; i++) {
      if (rel.indexOf(FORBIDDEN_REL_CHARS[i]) !== -1) return null;
    }
    var segments = rel.split('/');
    for (var j = 0; j < segments.length; j++) {
      var seg = segments[j];
      if (seg === '' || seg === '.' || seg === '..') return null;
    }
    var encoded = segments
      .map(function (s) {
        return encodeURIComponent(s);
      })
      .join('/');
    return 'http://' + hostname + ':' + port + '/' + encoded;
  }

  // V1e-7 (ADR 0039, SD-66): a preview-copy address, under the reserved `/:variant/<id>/`
  // prefix. `frameSrc` above is the ONLY host/port/rel validation this performs -- `id` gets its
  // own narrow syntax check (never the loopback/port logic duplicated).
  var VARIANT_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

  /**
   * @param {unknown} hostname exactly '127.0.0.1' or 'localhost'
   * @param {unknown} port an integer 1-65535
   * @param {unknown} id a VARIANT_IDS member shape (lowercase, VARIANT_ID_RE)
   * @param {unknown} rel same contract as frameSrc's own `rel`
   * @returns {string|null}
   */
  function variantSrc(hostname, port, id, rel) {
    if (typeof id !== 'string' || !VARIANT_ID_RE.test(id)) return null;
    var plain = frameSrc(hostname, port, rel); // the ONLY host/port/rel validation
    if (plain === null) return null;
    var origin = 'http://' + hostname + ':' + port + '/';
    return origin + ':variant/' + id + '/' + plain.slice(origin.length);
  }

  var ROLE_LABELS = {
    landing: 'Landing page',
    recap: 'Latest recap',
    character: 'A character',
    timeline: 'Timeline',
    notfound: 'Not-found page',
  };

  var POSTCARD_ROLES = ['landing', 'recap', 'timeline'];

  /**
   * @param {Array<{role:string, rel:string, title:string}>} pages
   * @returns {Array<{rel:string, role:string, text:string}>}
   */
  function pageOptions(pages) {
    return (pages || []).map(function (p) {
      var text = Object.prototype.hasOwnProperty.call(ROLE_LABELS, p.role) ? ROLE_LABELS[p.role] : p.role;
      if ((p.role === 'recap' || p.role === 'character') && p.title) {
        text = text + ': ' + p.title;
      }
      return { rel: p.rel, role: p.role, text: text };
    });
  }

  /**
   * @param {'wide'|'laptop'|'phone'} viewport
   * @param {string} view the Overview's own current view id
   * @returns {{ screen: 'ov1'|'ov3'|null, global: 'ov2'|null }}
   */
  function registrationFor(viewport, view) {
    if (view === 'ov1') return { screen: 'ov1', global: null };
    if (view === 'ov3') return { screen: 'ov3', global: null };
    if (view === 'ov2') {
      if (viewport === 'wide') return { screen: null, global: 'ov2' };
      return { screen: null, global: null };
    }
    return { screen: null, global: null };
  }

  var FOLLOW_LANDING_SCREENS = ['overview', 'theme', 'title', 'vault-config'];
  var FOLLOW_VOCAB_ROLES = ['timeline', 'character', 'recap'];

  /**
   * SD-24: the follow map. A hint whose OWN screen isn't the current `screen` is ignored (never
   * read for its role) -- the role rules below only ever consult `hint.role` after confirming
   * `hint.screen === screen`.
   *
   * @param {string} screen the CURRENT screen id (the route the person is on)
   * @param {{screen:string, role:string}|null|undefined} hint store.followHint
   * @returns {string|null} a page role to follow, or null to stay on the current page
   */
  function followRole(screen, hint) {
    if (FOLLOW_LANDING_SCREENS.indexOf(screen) !== -1) return 'landing';
    var hintMatches = !!(hint && hint.screen === screen);
    if (screen === 'images') {
      if (hintMatches && hint.role === 'notfound') return 'notfound';
      return 'landing';
    }
    if (screen === 'vocab') {
      if (hintMatches && FOLLOW_VOCAB_ROLES.indexOf(hint.role) !== -1) return hint.role;
      return 'timeline';
    }
    return null;
  }

  var SAVED_WORDS = {
    'pack.toml': 'theme, images or words',
    'vault.config.json': 'the site title',
    'vault-config.md': 'the tagline or vault settings',
  };

  var COUNTER_ONLY_WORDS = 'other changes saved in the panel';

  var RESIDUAL_FINE_PRINT = "Edits to your vault's notes made outside the panel don't show as out of date here. Rebuild to be sure.";

  var STATUS_PILL_TEXT = { none: 'not built yet', fresh: 'up to date', stale: 'out of date' };

  /**
   * @param {{built:boolean, builtAt:string|null, stale:boolean|null, savedSince:string[], panelSavesSince:number}|null} info
   * @param {Array<{id:string, text:string}>} pendingLinks already-computed, e.g. VW.pendingLinks(store.get().pending, NV)
   * @param {(iso:string) => string} timeOf e.g. VW.timeOf
   * @returns {{state:'none'|'fresh'|'stale', text:string}}
   */
  function freshnessLine(info, pendingLinks, timeOf) {
    var suffix = '';
    if (pendingLinks && pendingLinks.length > 0) {
      suffix =
        ' Not in any build: ' +
        pendingLinks
          .map(function (l) {
            return l.text;
          })
          .join('; ') +
        '.';
    }
    if (!info || info.built !== true) {
      return { state: 'none', text: 'Nothing built yet.' };
    }
    var time = timeOf(info.builtAt);
    if (!info.stale) {
      return { state: 'fresh', text: 'Built ' + time + ' from everything saved.' + suffix };
    }
    var words;
    if (info.savedSince && info.savedSince.length > 0) {
      words = info.savedSince
        .map(function (f) {
          return Object.prototype.hasOwnProperty.call(SAVED_WORDS, f) ? SAVED_WORDS[f] : f;
        })
        .join(', ');
    } else {
      words = COUNTER_ONLY_WORDS;
    }
    return { state: 'stale', text: 'Built ' + time + '. Saved since: ' + words + '.' + suffix };
  }

  /**
   * V1e-3 rework (re-review finding, 2026-10-01): SD-23's three placement-button copy literals,
   * pulled out of the DOM-building `ov1PlacementBtn` so each one is independently unit-tested
   * with no DOM. The old inline ternary read `mode === 'sheet' ? '...drawer' : '...drawer'` --
   * both branches identical -- because `mode` is literally the string `'below'` whenever `place`
   * is `'below'` (frame.js always calls `spec.build(aside, 'below')` for the below-pane case, never
   * 'drawer'/'sheet'), so `mode` never actually carries the phone-vs-laptop distinction this needed.
   * `viewport` does, and is already resolved by the caller either way.
   *
   * @param {'below'|'overlay'|unknown} place
   * @param {'laptop'|'phone'} viewport
   * @returns {string}
   */
  function placementLabel(place, viewport) {
    if (place === 'below') {
      return viewport === 'phone' ? 'Show full screen' : 'Show as a drawer';
    }
    return 'Show below the Overview';
  }

  var PV = {
    FRAME_SANDBOX: 'allow-scripts allow-same-origin',
    ROLE_LABELS: ROLE_LABELS,
    POSTCARD_ROLES: POSTCARD_ROLES,
    STATUS_PILL_TEXT: STATUS_PILL_TEXT,
    RESIDUAL_FINE_PRINT: RESIDUAL_FINE_PRINT,
    frameSrc: frameSrc,
    variantSrc: variantSrc,
    pageOptions: pageOptions,
    registrationFor: registrationFor,
    followRole: followRole,
    freshnessLine: freshnessLine,
    placementLabel: placementLabel,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { PV: PV };
    return;
  }

  // ===============================================================================================
  // Browser half
  // ===============================================================================================

  var store = ScriptoriumAdmin.store;
  var NV = ScriptoriumAdmin.NV;
  var el = ScriptoriumAdmin.el;
  var setText = ScriptoriumAdmin.setText;
  var icon = ScriptoriumAdmin.icon;

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function currentState() {
    return store.get().state || null;
  }

  function currentPreviewInfo() {
    var s = currentState();
    return (s && s.previewInfo) || null;
  }

  function currentScreenId() {
    var route = store.get().route;
    return (route && route.screen) || 'overview';
  }

  function currentViewport() {
    return store.get().viewport || NV.viewportClass(window.innerWidth);
  }

  function currentOverviewView() {
    return ScriptoriumAdmin.views.current('overview') || 'ov1';
  }

  function pendingLinksNow() {
    var s = store.get();
    return ScriptoriumAdmin.VW.pendingLinks(s.pending, NV);
  }

  // -- Frames: the sole place any iframe is created (security review chokepoint) -----------------

  /**
   * @param {string} rel
   * @param {string} title
   * @param {string} [variantId] a VARIANT_IDS member (V1e-7, ADR 0039): when given, the frame
   *   addresses the preview-copy namespace instead of the main preview
   * @returns {HTMLIFrameElement}
   */
  function buildFrame(rel, title, variantId) {
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', PV.FRAME_SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.loading = 'lazy';
    frame.title = title;
    frame.className = 'ov-frame';
    frame.setAttribute('data-role', 'preview-frame');
    frame.setAttribute('data-page-rel', rel);
    if (variantId) frame.setAttribute('data-variant', variantId);
    var s = currentState();
    var previewPort = s && typeof s.previewPort === 'number' ? s.previewPort : null;
    var src =
      previewPort === null
        ? null
        : variantId
          ? PV.variantSrc(location.hostname, previewPort, variantId, rel)
          : PV.frameSrc(location.hostname, previewPort, rel);
    if (src) frame.src = src;
    return frame;
  }

  /** Points an already-built frame at a new page, only when it differs (avoids a needless reload). */
  function pointFrameAt(frame, rel, variantId) {
    if (!frame) return;
    var s = currentState();
    var previewPort = s && typeof s.previewPort === 'number' ? s.previewPort : null;
    if (previewPort === null) return;
    var src = variantId ? PV.variantSrc(location.hostname, previewPort, variantId, rel) : PV.frameSrc(location.hostname, previewPort, rel);
    if (!src) return;
    frame.setAttribute('data-page-rel', rel);
    if (variantId) frame.setAttribute('data-variant', variantId);
    if (frame.getAttribute('src') !== src) frame.src = src;
  }

  // -- Shared bits: freshness, status pill, empty state, rebuild button --------------------------

  function statusPillNode(state) {
    var pill = el('span');
    pill.className = 'a1-pill' + (state === 'stale' ? ' rose fill' : state === 'fresh' ? ' sage fill' : ' muted');
    pill.setAttribute('data-role', 'preview-pill');
    setText(pill, PV.STATUS_PILL_TEXT[state] || PV.STATUS_PILL_TEXT.none);
    return pill;
  }

  function freshnessNode() {
    var info = currentPreviewInfo();
    var line = PV.freshnessLine(info, pendingLinksNow(), ScriptoriumAdmin.VW.timeOf);
    var wrap = el('div');
    wrap.className = 'ov-fresh-line ov-fresh-' + line.state;
    wrap.setAttribute('data-role', 'preview-freshness');
    wrap.setAttribute('data-state', line.state);
    wrap.appendChild(icon(line.state === 'stale' ? 'warn' : line.state === 'fresh' ? 'tick' : 'preview'));
    var p = el('p');
    setText(p, line.text);
    wrap.appendChild(p);
    return wrap;
  }

  function residualFinePrint() {
    var p = el('p');
    p.className = 'a1-fine ov-residual';
    setText(p, PV.RESIDUAL_FINE_PRINT);
    return p;
  }

  /** Every Rebuild/Build control funnels through here (the busy contract's own count). */
  function buildRebuildBtn(opts) {
    opts = opts || {};
    var btn = el('button');
    btn.type = 'button';
    btn.className = opts.className || 'a1-btn';
    btn.setAttribute('data-role', 'preview-rebuild');
    btn.appendChild(icon(opts.icon || 'refresh'));
    // An empty string means icon-only (SD-23's ov1 head): give it an accessible name via
    // title/aria-label instead of a visible text node, rather than "" || 'Rebuild' silently
    // falling back to a visible label no design called for.
    var text = typeof opts.label === 'string' ? opts.label : 'Rebuild';
    if (text) {
      btn.appendChild(document.createTextNode(text));
    } else {
      btn.title = 'Rebuild the preview';
      btn.setAttribute('aria-label', 'Rebuild the preview');
    }
    btn.disabled = store.isBusy();
    btn.addEventListener('click', function () {
      ScriptoriumAdmin.runs.build();
    });
    return btn;
  }

  function emptyStateNode() {
    var wrap = el('div');
    wrap.className = 'ov-empty';
    var art = el('div');
    art.className = 'ov-empty-art';
    art.setAttribute('aria-hidden', 'true');
    art.appendChild(icon('preview'));
    wrap.appendChild(art);
    var h3 = el('h3');
    setText(h3, 'No preview built yet');
    wrap.appendChild(h3);
    var p = el('p');
    setText(p, "Build one and your player site shows up here, exactly as players would see it. It stays on this computer.");
    wrap.appendChild(p);
    wrap.appendChild(buildRebuildBtn({ className: 'a1-btn primary', icon: 'play', label: 'Build preview' }));
    return wrap;
  }

  function deviceToggle() {
    var wrap = el('span');
    wrap.className = 'ov-dev';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Preview width');
    ['desktop', 'phone'].forEach(function (v) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'a1-iconbtn';
      btn.setAttribute('data-role', 'preview-device');
      btn.setAttribute('data-v', v);
      var pressed = (store.get().prefs && store.get().prefs['preview.device']) === v;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      btn.title = v === 'desktop' ? 'Desktop width' : 'Phone width';
      btn.appendChild(icon(v));
      btn.addEventListener('click', function () {
        store.setPref('preview.device', v);
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  /** `<select class="a1-select">`, the browser strip and one frame, then the freshness line. */
  function browserBlock(initialRel, titlePrefix) {
    var info = currentPreviewInfo();
    var wrap = el('div');
    wrap.className = 'ov-browser-wrap';

    if (!info || info.built !== true) {
      wrap.appendChild(emptyStateNode());
      return { node: wrap, frame: null, addr: null };
    }

    var options = PV.pageOptions(info.pages);
    var rel = initialRel && options.some(function (o) { return o.rel === initialRel; }) ? initialRel : options.length ? options[0].rel : null;

    var browser = el('div');
    browser.className = 'ov-browser';
    var addr = el('div');
    addr.className = 'ov-addr';
    addr.appendChild(icon('lock'));
    var addrText = el('span');
    addrText.setAttribute('data-role', 'preview-addr');
    var s = currentState();
    var port = s ? s.previewPort : '';
    setText(addrText, rel ? location.hostname + ':' + port + '/' + rel : location.hostname + ':' + port + '/');
    addr.appendChild(addrText);
    var tag = el('span');
    tag.className = 'ov-addr-tag';
    setText(tag, 'preview');
    addr.appendChild(tag);
    browser.appendChild(addr);

    var scroll = el('div');
    scroll.className = 'ov-scroll';
    var frame = rel ? buildFrame(rel, (titlePrefix || 'Player site preview') + ': ' + rel) : null;
    if (frame) scroll.appendChild(frame);
    browser.appendChild(scroll);
    wrap.appendChild(browser);
    wrap.appendChild(freshnessNode());
    wrap.appendChild(residualFinePrint());

    return { node: wrap, frame: frame, addr: addrText, options: options, rel: rel };
  }

  // -- ov1: docked pane / drawer / full-screen sheet / below --------------------------------------

  /** SD-23's laptop trigger: only when the laptop view is ov1 and placement is overlay. */
  function heroControl() {
    if (currentViewport() !== 'laptop') return null;
    if (currentOverviewView() !== 'ov1') return null;
    var place = NV.placeFor(store.get().prefs, 'laptop');
    if (place !== 'overlay') return null;
    var btn = el('button');
    btn.type = 'button';
    btn.className = 'a1-btn small ghost';
    btn.setAttribute('data-pane-trigger', 'screen');
    btn.appendChild(icon('panel'));
    var label = document.createTextNode(' Site preview');
    btn.appendChild(label);
    var info = currentPreviewInfo();
    if (info && info.stale) {
      var dot = el('i');
      dot.className = 'a1-dot';
      dot.setAttribute('aria-label', 'out of date');
      btn.appendChild(dot);
    }
    btn.addEventListener('click', function () {
      ScriptoriumAdmin.pane.openOverlay('screen', btn);
    });
    return btn;
  }

  /** Re-runs heroControl() and refreshes the named slot views.js built for it -- needed because a
   * viewport or placement (prefs) change alone never triggers views.js's own state-driven
   * re-render of the hero. */
  function refreshHeroControl() {
    var slot = document.querySelector('[data-part="ov-hero-control"]');
    if (!slot) return;
    clear(slot);
    var control = heroControl();
    if (control) slot.appendChild(control);
  }

  function ov1PlacementBtn(mode) {
    var viewport = currentViewport();
    if (viewport !== 'laptop' && viewport !== 'phone') return null;
    var place = NV.placeFor(store.get().prefs, viewport);
    var btn = el('button');
    btn.type = 'button';
    btn.className = 'a1-btn small ghost';
    if (place === 'below') {
      btn.appendChild(icon(viewport === 'phone' ? 'x' : 'panel'));
      var label1 = document.createTextNode(' ' + PV.placementLabel(place, viewport));
      btn.appendChild(label1);
      btn.addEventListener('click', function () {
        store.setPref('pane.place.' + viewport, 'overlay');
      });
    } else {
      btn.appendChild(icon('panel'));
      var label2 = document.createTextNode(' ' + PV.placementLabel(place, viewport));
      btn.appendChild(label2);
      btn.addEventListener('click', function () {
        store.setPref('pane.place.' + viewport, 'below');
      });
    }
    return btn;
  }

  var ov1LastRel = null;

  function ov1Pane(mode) {
    var wrap = el('div');
    wrap.className = 'ov1-pane';

    var head = el('div');
    head.className = 'ov1-head';
    var titleWrap = el('div');
    titleWrap.className = 'ov1-title';
    var cap = el('span');
    cap.className = 'a1-cap';
    setText(cap, 'Player site');
    titleWrap.appendChild(cap);
    var info = currentPreviewInfo();
    var state = !info || info.built !== true ? 'none' : info.stale ? 'stale' : 'fresh';
    titleWrap.appendChild(statusPillNode(state));
    head.appendChild(titleWrap);

    var tools = el('div');
    tools.className = 'ov1-tools';
    if (mode !== 'sheet') tools.appendChild(deviceToggle());
    tools.appendChild(buildRebuildBtn({ className: 'a1-iconbtn', icon: 'refresh', label: '' }));
    var openLink = el('a');
    openLink.className = 'a1-iconbtn';
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    var s = currentState();
    openLink.href = s ? 'http://' + location.hostname + ':' + s.previewPort + '/' : '#';
    openLink.title = 'Open full size in a new tab';
    openLink.appendChild(icon('ext'));
    tools.appendChild(openLink);

    var closeBtn = el('button');
    closeBtn.type = 'button';
    closeBtn.className = 'a1-iconbtn';
    if (mode === 'dock' || mode === 'below') {
      closeBtn.title = 'Hide the preview';
      closeBtn.appendChild(icon('panel'));
      closeBtn.addEventListener('click', function () {
        store.setPref('pane.hidden', true);
      });
    } else {
      closeBtn.title = 'Close';
      closeBtn.appendChild(icon('x'));
      closeBtn.addEventListener('click', function () {
        ScriptoriumAdmin.pane.closeOverlay();
      });
    }
    tools.appendChild(closeBtn);
    head.appendChild(tools);
    wrap.appendChild(head);

    var placement = ov1PlacementBtn(mode);
    if (placement) {
      var placeRow = el('div');
      placeRow.className = 'ov1-place';
      placeRow.appendChild(placement);
      wrap.appendChild(placeRow);
    }

    var sub = el('div');
    sub.className = 'ov1-sub';
    var browser = browserBlock(ov1LastRel, 'Player site preview');
    if (browser.options && browser.options.length) {
      var selWrap = el('div');
      var selLabel = el('label');
      selLabel.className = 'visually-hidden';
      selLabel.setAttribute('for', 'ov1-page-' + mode);
      setText(selLabel, 'Page to preview');
      selWrap.appendChild(selLabel);
      var select = el('select');
      select.className = 'a1-select';
      select.id = 'ov1-page-' + mode;
      browser.options.forEach(function (opt) {
        var option = el('option');
        option.value = opt.rel;
        setText(option, opt.text);
        if (opt.rel === browser.rel) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', function () {
        ov1LastRel = select.value;
        pointFrameAt(browser.frame, select.value);
        if (browser.addr) {
          var st = currentState();
          setText(browser.addr, location.hostname + ':' + (st ? st.previewPort : '') + '/' + select.value);
        }
      });
      selWrap.appendChild(select);
      sub.appendChild(selWrap);
    }
    wrap.appendChild(sub);
    wrap.appendChild(browser.node);

    return wrap;
  }

  // -- Rebuild tracking: a freshly COMPLETED build must refresh every currently-mounted preview
  // surface's own content (an empty-state placeholder becoming a real frame, or a stale frame
  // showing the new build) -- but renderSlot()'s own idempotence (SD-22) must still stand: a
  // route change, or any OTHER unrelated store churn, must never re-invoke these. Every build()
  // below self-registers a same-shaped "rebuild myself in place" closure here; the central
  // subscription (wireCentralSubscription) calls refreshAllMounted() only when previewInfo's own
  // builtAt actually changes.
  var mountedRegions = [];

  function registerMount(container, rebuild) {
    mountedRegions = mountedRegions.filter(function (r) {
      return r.container.isConnected && r.container !== container;
    });
    mountedRegions.push({ container: container, rebuild: rebuild });
  }

  function refreshAllMounted() {
    mountedRegions = mountedRegions.filter(function (r) {
      return r.container.isConnected;
    });
    mountedRegions.forEach(function (r) {
      r.rebuild();
    });
  }

  var OV1 = {
    label: 'Player site preview',
    className: 'ov1-dock',
    presentation: { wide: 'dock', laptop: 'drawer', phone: 'sheet' },
    hideable: true,
    hiddenPref: 'pane.hidden',
    hiddenAs: 'edge',
    belowable: true,
    ownTrigger: true,
    build: function (container, mode) {
      function run() {
        clear(container);
        container.appendChild(ov1Pane(mode));
      }
      run();
      registerMount(container, run);
    },
  };

  // -- ov2: split screen / laptop+phone tabs -------------------------------------------------------

  var ov2CurrentRel = null;

  function ov2FollowCheckbox() {
    var label = el('label');
    label.className = 'st-check ov2-follow';
    var input = el('input');
    input.type = 'checkbox';
    input.id = 'ov2-follow';
    input.checked = !!(store.get().prefs && store.get().prefs['ov2.follow']);
    input.addEventListener('change', function () {
      store.setPref('ov2.follow', input.checked);
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(" Follow what I'm editing"));
    return label;
  }

  function pageChips(options, current, onPick) {
    var chips = el('div');
    chips.className = 'ov-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Page to preview');
    options.forEach(function (opt) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'ov-chip';
      btn.setAttribute('aria-pressed', opt.rel === current ? 'true' : 'false');
      setText(btn, opt.text);
      btn.addEventListener('click', function () {
        onPick(opt.rel);
      });
      chips.appendChild(btn);
    });
    return chips;
  }

  function ov2Preview(includeFollow) {
    var wrap = el('div');
    wrap.className = 'ov2-preview';

    var bar = el('div');
    bar.className = 'ov2-bar';
    var browser = browserBlock(ov2CurrentRel, 'Player site preview');
    if (browser.options && browser.options.length) {
      bar.appendChild(
        pageChips(browser.options, browser.rel, function (rel) {
          ov2CurrentRel = rel;
          pointFrameAt(browser.frame, rel);
        }),
      );
    }
    var barTools = el('div');
    barTools.className = 'ov2-tools';
    if (currentViewport() !== 'phone') barTools.appendChild(deviceToggle());
    barTools.appendChild(buildRebuildBtn({ className: 'a1-btn small', icon: 'refresh', label: 'Rebuild' }));
    var openBtn = el('a');
    openBtn.className = 'a1-btn small ghost';
    openBtn.target = '_blank';
    openBtn.rel = 'noopener noreferrer';
    var s = currentState();
    openBtn.href = s ? 'http://' + location.hostname + ':' + s.previewPort + '/' : '#';
    openBtn.appendChild(icon('ext'));
    openBtn.appendChild(document.createTextNode('Open'));
    barTools.appendChild(openBtn);
    bar.appendChild(barTools);
    wrap.appendChild(bar);

    var state = el('div');
    state.className = 'ov2-state';
    var info = currentPreviewInfo();
    var pillState = !info || info.built !== true ? 'none' : info.stale ? 'stale' : 'fresh';
    state.appendChild(statusPillNode(pillState));
    var line = PV.freshnessLine(info, pendingLinksNow(), ScriptoriumAdmin.VW.timeOf);
    var lineText = el('span');
    setText(lineText, line.text);
    state.appendChild(lineText);
    if (includeFollow) state.appendChild(ov2FollowCheckbox());
    wrap.appendChild(state);

    wrap.appendChild(browser.node);
    return wrap;
  }

  var OV2 = {
    label: 'Player site preview',
    className: 'ov2-split',
    presentation: { wide: 'dock', laptop: 'inline', phone: 'inline' },
    hideable: false,
    hiddenPref: null,
    hiddenAs: 'none',
    build: function (container, mode) {
      function run() {
        clear(container);
        var head = el('div');
        head.className = 'ov2-splithead';
        var cap = el('span');
        cap.className = 'a1-cap';
        setText(cap, 'Player site');
        head.appendChild(cap);
        var meta = el('span');
        meta.className = 'a1-meta';
        setText(meta, 'what players would see from the last build');
        head.appendChild(meta);
        container.appendChild(head);
        container.appendChild(ov2Preview(true));
      }
      run();
      registerMount(container, run);
    },
  };

  // -- ov3: postcard rail / strip / lightbox -------------------------------------------------------

  var ov3LightRole = null;

  function postcardNode(page, inRow) {
    var btn = el('button');
    btn.type = 'button';
    btn.className = 'ov3-card' + (inRow ? ' in-row' : '');
    var info = currentPreviewInfo();
    var built = info && info.built === true;
    btn.disabled = !built;
    btn.addEventListener('click', function () {
      openLightbox(page.role);
    });

    var imgWrap = el('span');
    imgWrap.className = 'ov3-img';
    imgWrap.setAttribute('aria-hidden', 'true');
    imgWrap.setAttribute('inert', '');
    if (built) {
      var frame = buildFrame(page.rel, page.text + ' thumbnail');
      frame.className = 'ov-frame ov3-thumb';
      frame.tabIndex = -1;
      imgWrap.appendChild(frame);
    } else {
      var blank = el('span');
      blank.className = 'ov3-blank';
      setText(blank, 'not built');
      imgWrap.appendChild(blank);
    }
    btn.appendChild(imgWrap);

    var cap = el('span');
    cap.className = 'ov3-cap';
    var b = el('b');
    setText(b, page.text);
    cap.appendChild(b);
    if (info && info.stale) {
      var dot = el('i');
      dot.className = 'a1-dot';
      dot.title = 'Saved after the build';
      cap.appendChild(dot);
    }
    btn.appendChild(cap);
    return btn;
  }

  /** @returns {Array<{rel:string, role:string, text:string}>} postcard-shaped entries, from
   * PV.pageOptions so the caption text matches every other page picker (label plus ": title"). */
  function ov3PostcardPages() {
    var info = currentPreviewInfo();
    var options = PV.pageOptions(info && info.pages);
    return PV.POSTCARD_ROLES.map(function (role) {
      return options.find(function (p) {
        return p.role === role;
      });
    }).filter(function (p) {
      return !!p;
    });
  }

  function ov3Head() {
    var head = el('div');
    head.className = 'ov3-head';
    var cap = el('span');
    cap.className = 'a1-cap';
    setText(cap, 'Your site right now');
    head.appendChild(cap);
    var info = currentPreviewInfo();
    var state = !info || info.built !== true ? 'none' : info.stale ? 'stale' : 'fresh';
    head.appendChild(statusPillNode(state));
    return head;
  }

  function ov3Foot() {
    var p = el('p');
    p.className = 'a1-fine';
    var info = currentPreviewInfo();
    var line = PV.freshnessLine(info, pendingLinksNow(), ScriptoriumAdmin.VW.timeOf);
    setText(p, line.text);
    if (line.state === 'stale' || line.state === 'none') {
      p.appendChild(document.createTextNode(' '));
      p.appendChild(buildRebuildBtn({ className: 'a1-link', icon: 'refresh', label: line.state === 'none' ? 'Build preview' : 'Rebuild' }));
    }
    return p;
  }

  var OV3 = {
    label: 'Snapshots of the player site',
    className: 'ov3-rail',
    presentation: { wide: 'dock', laptop: 'inline', phone: 'inline' },
    hideable: false,
    hiddenPref: null,
    hiddenAs: 'none',
    build: function (container, mode) {
      function run() {
        clear(container);
        container.appendChild(ov3Head());
        var stack = el('div');
        stack.className = 'ov3-stack';
        ov3PostcardPages().forEach(function (p) {
          stack.appendChild(postcardNode(p, false));
        });
        container.appendChild(stack);
        container.appendChild(ov3Foot());
      }
      run();
      registerMount(container, run);
    },
  };

  function ov3StripContent() {
    var section = el('section');
    section.className = 'ov3-strip';
    section.appendChild(ov3Head());
    var row = el('div');
    row.className = 'ov3-row';
    ov3PostcardPages().forEach(function (p) {
      row.appendChild(postcardNode(p, true));
    });
    section.appendChild(row);
    section.appendChild(ov3Foot());
    return section;
  }

  // -- ov3 lightbox: a native <dialog>, arrows, Rebuild when stale, Escape, focus return ----------

  var LIGHTBOX_ID = 'admin-ov3-lightbox';
  var lightboxTrigger = null;

  function lightboxDialog() {
    var existing = document.getElementById(LIGHTBOX_ID);
    if (existing) return existing;
    var dialog = el('dialog');
    dialog.id = LIGHTBOX_ID;
    dialog.className = 'ov3-light';
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      closeLightbox();
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function lightboxRoles() {
    return ov3PostcardPages().map(function (p) {
      return p.role;
    });
  }

  function renderLightbox() {
    var dialog = lightboxDialog();
    clear(dialog);
    var roles = lightboxRoles();
    var idx = Math.max(0, roles.indexOf(ov3LightRole));
    var pages = ov3PostcardPages();
    var page = pages[idx];
    if (!page) return;

    var head = el('div');
    head.className = 'ov3-lhead';
    var prevBtn = el('button');
    prevBtn.type = 'button';
    prevBtn.className = 'a1-iconbtn ov3-lprev';
    prevBtn.title = 'Previous page';
    prevBtn.appendChild(icon('chev'));
    prevBtn.addEventListener('click', function () {
      stepLightbox(-1);
    });
    head.appendChild(prevBtn);

    var titleWrap = el('div');
    titleWrap.className = 'ov3-ltitle';
    var capSpan = el('span');
    capSpan.className = 'a1-cap';
    setText(capSpan, idx + 1 + ' of ' + pages.length);
    titleWrap.appendChild(capSpan);
    var b = el('b');
    setText(b, page.text || PV.ROLE_LABELS[page.role]);
    titleWrap.appendChild(b);
    head.appendChild(titleWrap);

    var nextBtn = el('button');
    nextBtn.type = 'button';
    nextBtn.className = 'a1-iconbtn';
    nextBtn.title = 'Next page';
    nextBtn.appendChild(icon('chev'));
    nextBtn.addEventListener('click', function () {
      stepLightbox(1);
    });
    head.appendChild(nextBtn);

    var sp = el('span');
    sp.className = 'ov3-lsp';
    head.appendChild(sp);

    var info = currentPreviewInfo();
    var state = !info || info.built !== true ? 'none' : info.stale ? 'stale' : 'fresh';
    head.appendChild(statusPillNode(state));
    if (state === 'stale') head.appendChild(buildRebuildBtn({ className: 'a1-btn small', icon: 'refresh', label: 'Rebuild' }));

    var openBtn = el('a');
    openBtn.className = 'a1-btn small ghost';
    openBtn.target = '_blank';
    openBtn.rel = 'noopener noreferrer';
    var s = currentState();
    openBtn.href = s ? 'http://' + location.hostname + ':' + s.previewPort + '/' + page.rel : '#';
    openBtn.appendChild(icon('ext'));
    openBtn.appendChild(document.createTextNode('Open in a tab'));
    head.appendChild(openBtn);

    var closeBtn = el('button');
    closeBtn.type = 'button';
    closeBtn.className = 'a1-iconbtn';
    closeBtn.title = 'Close';
    closeBtn.appendChild(icon('x'));
    closeBtn.addEventListener('click', closeLightbox);
    head.appendChild(closeBtn);

    dialog.appendChild(head);
    var browser = browserBlock(page.rel, page.text);
    dialog.appendChild(browser.node);
  }

  function openLightbox(role) {
    var pages = ov3PostcardPages();
    if (!pages.some(function (p) { return p.role === role; })) return;
    ov3LightRole = role;
    lightboxTrigger = document.activeElement;
    renderLightbox();
    var dialog = document.getElementById(LIGHTBOX_ID);
    if (dialog && !dialog.open) dialog.showModal();
  }

  function stepLightbox(delta) {
    var roles = lightboxRoles();
    if (roles.length === 0) return;
    var idx = Math.max(0, roles.indexOf(ov3LightRole));
    ov3LightRole = roles[(idx + delta + roles.length) % roles.length];
    renderLightbox();
  }

  function closeLightbox() {
    var dialog = document.getElementById(LIGHTBOX_ID);
    if (dialog && dialog.open) dialog.close();
    ov3LightRole = null;
    if (lightboxTrigger && typeof lightboxTrigger.focus === 'function' && lightboxTrigger.isConnected !== false) {
      lightboxTrigger.focus();
    }
    lightboxTrigger = null;
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var dialog = document.getElementById(LIGHTBOX_ID);
    if (dialog && dialog.open) closeLightbox();
  });

  // -- Registration sync: register/unregister OV1/OV2/OV3 per registrationFor --------------------

  var registeredScreenSpec = null;
  var registeredGlobalSpec = null;

  function syncRegistration() {
    var reg = PV.registrationFor(currentViewport(), currentOverviewView());
    var wantScreen = reg.screen === 'ov1' ? OV1 : reg.screen === 'ov3' ? OV3 : null;
    var wantGlobal = reg.global === 'ov2' ? OV2 : null;

    if (wantScreen !== registeredScreenSpec) {
      if (wantScreen) ScriptoriumAdmin.pane.register('overview', wantScreen);
      else ScriptoriumAdmin.pane.unregister('overview');
      registeredScreenSpec = wantScreen;
    }
    if (wantGlobal !== registeredGlobalSpec) {
      if (wantGlobal) ScriptoriumAdmin.pane.register('*', wantGlobal);
      else ScriptoriumAdmin.pane.unregister('*');
      registeredGlobalSpec = wantGlobal;
    }
  }

  // -- ov2/ov3 inline (laptop/phone), managed directly in the persistent ov-tabs/ov-site/ov-strip
  // slots (never through the pane system, per SD-23) -----------------------------------------------

  var slotsRef = null;
  var ov2Tab = 'backstage';
  var inlineOv2Active = false;

  function setOvOnSite(active) {
    var mount = ScriptoriumAdmin.mount('overview');
    if (mount) mount.classList.toggle('ov-on-site', !!active);
  }

  function renderOv2Tabs() {
    if (!slotsRef || !slotsRef.tabs) return;
    clear(slotsRef.tabs);
    var tabs = el('div');
    tabs.className = 'a1-subtabs ov2-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Overview');
    [
      ['backstage', 'Backstage'],
      ['site', 'Player site'],
    ].forEach(function (pair) {
      var btn = el('button');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.className = 'a1-subtab';
      btn.setAttribute('aria-selected', ov2Tab === pair[0] ? 'true' : 'false');
      setText(btn, pair[1]);
      if (pair[0] === 'site') {
        var info = currentPreviewInfo();
        if (info && info.stale) {
          var dot = el('i');
          dot.className = 'a1-dot';
          dot.setAttribute('aria-label', 'out of date');
          btn.appendChild(dot);
        }
      }
      btn.addEventListener('click', function () {
        ov2Tab = pair[0];
        setOvOnSite(ov2Tab === 'site');
        renderOv2Tabs();
        renderOv2Site();
      });
      tabs.appendChild(btn);
    });
    slotsRef.tabs.appendChild(tabs);
  }

  function renderOv2Site() {
    if (!slotsRef || !slotsRef.site) return;
    clear(slotsRef.site);
    if (ov2Tab !== 'site') {
      slotsRef.site.hidden = true;
      return;
    }
    slotsRef.site.hidden = false;
    var pane = el('div');
    pane.className = 'ov2-tabpane';
    pane.appendChild(ov2Preview(false));
    slotsRef.site.appendChild(pane);
    registerMount(slotsRef.site, renderOv2Site);
  }

  function renderOv3StripSlot() {
    if (!slotsRef || !slotsRef.strip) return;
    clear(slotsRef.strip);
    slotsRef.strip.appendChild(ov3StripContent());
    registerMount(slotsRef.strip, renderOv3StripSlot);
  }

  function syncInline() {
    if (!slotsRef) return;
    var viewport = currentViewport();
    var view = currentOverviewView();

    var wantOv2Inline = (viewport === 'laptop' || viewport === 'phone') && view === 'ov2';
    if (wantOv2Inline) {
      if (!inlineOv2Active) {
        ov2Tab = 'backstage';
        setOvOnSite(false);
      }
      inlineOv2Active = true;
      slotsRef.tabs.hidden = false;
      renderOv2Tabs();
      renderOv2Site();
    } else {
      if (inlineOv2Active) setOvOnSite(false);
      inlineOv2Active = false;
      clear(slotsRef.tabs);
      slotsRef.tabs.hidden = true;
      clear(slotsRef.site);
      slotsRef.site.hidden = true;
    }

    var wantOv3Strip = (viewport === 'laptop' || viewport === 'phone') && view === 'ov3';
    if (wantOv3Strip) {
      slotsRef.strip.hidden = false;
      renderOv3StripSlot();
    } else {
      clear(slotsRef.strip);
      slotsRef.strip.hidden = true;
    }
  }

  // -- Follow (SD-24): ov2.follow, only meaningful while ov2 is the live global (wide) pane ------

  function applyFollow() {
    if (registeredGlobalSpec !== OV2) return;
    var follow = store.get().prefs && store.get().prefs['ov2.follow'];
    if (!follow) return;
    var role = PV.followRole(currentScreenId(), store.get().followHint);
    if (!role) return;
    var info = currentPreviewInfo();
    var page = info && info.pages ? info.pages.find(function (p) { return p.role === role; }) : null;
    if (!page || page.rel === ov2CurrentRel) return;
    ov2CurrentRel = page.rel;
    var frame = document.querySelector('[data-role="pane"] .ov2-preview [data-role="preview-frame"]');
    pointFrameAt(frame, page.rel);
  }

  // -- Central, single subscription: busy re-evaluation and a fresh-build refresh -----------------

  var lastKnownBuiltAt = null;

  function reevaluateBusy() {
    var busy = store.isBusy();
    document.querySelectorAll('[data-role="preview-rebuild"]').forEach(function (btn) {
      btn.disabled = busy;
    });
  }

  function wireCentralSubscription() {
    store.subscribe(function (next, prev) {
      if (next.busy !== prev.busy) reevaluateBusy();

      var info = (next.state && next.state.previewInfo) || null;
      var builtAt = info ? info.builtAt : null;
      if (builtAt !== lastKnownBuiltAt) {
        lastKnownBuiltAt = builtAt;
        // A build just completed (or the page loaded with an already-built preview): every
        // currently-mounted preview surface rebuilds its OWN content in place -- an empty-state
        // placeholder becomes a real frame, or a stale frame's src moves to the new build. A
        // route change or any other unrelated store churn never reaches this branch (P20).
        refreshAllMounted();
      }

      if (next.viewport !== prev.viewport || next.prefs !== prev.prefs) {
        syncRegistration();
        syncInline();
        refreshHeroControl();
      }
      if (next.route !== prev.route || next.followHint !== prev.followHint) {
        applyFollow();
      }
    });
  }

  // -- Public API -----------------------------------------------------------------------------------

  function init(slots) {
    slotsRef = slots;
    wireCentralSubscription();
    syncRegistration();
    syncInline();

    // Phone trigger: "Preview" in frame.topBarSlot(), under the same rules as heroControl().
    var topSlot = ScriptoriumAdmin.frame.topBarSlot();
    if (topSlot) {
      var phoneBtn = el('button');
      phoneBtn.type = 'button';
      phoneBtn.className = 'a1-btn small';
      phoneBtn.setAttribute('data-pane-trigger', 'screen');
      phoneBtn.appendChild(icon('preview'));
      phoneBtn.appendChild(document.createTextNode(' Preview'));
      phoneBtn.hidden = true;
      phoneBtn.addEventListener('click', function () {
        ScriptoriumAdmin.pane.openOverlay('screen', phoneBtn);
      });
      topSlot.appendChild(phoneBtn);
      store.subscribe(function () {
        var show = currentViewport() === 'phone' && currentScreenId() === 'overview' && currentOverviewView() === 'ov1' && NV.placeFor(store.get().prefs, 'phone') === 'overlay';
        phoneBtn.hidden = !show;
      });
    }
  }

  window.ScriptoriumAdmin.sitePane = { init: init, heroControl: heroControl, frame: buildFrame, pointFrame: pointFrameAt };
  // V1e-7 (SD-66): assets/admin/variants.js's browser half builds variant-addressed frames
  // through this same chokepoint; it needs PV.variantSrc (and frameSrc, for symmetry) without
  // creating any iframe of its own.
  window.ScriptoriumAdmin.PV = PV;
})();
