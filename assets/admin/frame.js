'use strict';

/*
 * Panel v2 V1a. Browser only. Builds the sidebar, n1 top bar, bottom bar and sheet around the
 * existing <main data-role="main">, moves the four legacy [data-section] elements into their
 * home screens (shared design 1.4), builds the placeholder screens from NV data (SD-7), and owns
 * the #/<id> fragment router (1.2, SD-5). Defines ScriptoriumAdmin.frame = { build(session),
 * start() } and ScriptoriumAdmin.mount(screenId). Every string is written with textContent
 * (FR12); every element is built with createElement/createElementNS, never markup.
 */
(function () {
  var NV = ScriptoriumAdmin.NV;
  var ST = ScriptoriumAdmin.ST;
  var store = ScriptoriumAdmin.store;
  var icon = ScriptoriumAdmin.icon;

  // The four existing [data-section] elements move whole into their home screen's mount
  // (shared design 1.4). Nothing else about them changes: same requests, payloads, text.
  var SECTION_TO_SCREEN = { views: 'overview', pack: 'theme', vocab: 'vocab', images: 'images' };
  var SHEET_ID = 'admin-nav-sheet';

  var mounts = {};
  var screens = {};
  var firstShow = true;

  function el(tag) {
    return document.createElement(tag);
  }

  function setText(node, text) {
    node.textContent = text === undefined || text === null ? '' : String(text);
  }

  // V1c SD-7: a title line (siteTitle, falling back to the bare campaign name) plus a sub-line
  // "campaign <name>" (v1-restyle-lead-requirements-2026-09-29.md:43's FR-01 wording). The two
  // lines are deliberately independent of each other -- the sub-line always shows "campaign
  // <name>" whenever a campaign is known, even when the title line already used it as its own
  // fallback -- so it never has to guess whether the title line's text WAS the campaign name.
  function brandTitleText(session, state) {
    var siteTitle = state && state.vaultConfigJson && state.vaultConfigJson.siteTitle;
    if (siteTitle) return siteTitle;
    return (session && session.campaign) || '';
  }

  // V1d-1 SD-7: the "Backstage · campaign " label is now static markup (buildBrand), so this
  // returns just the bare campaign name for the trailing <code> element.
  function brandCampaignText(session) {
    return (session && session.campaign) || '';
  }

  /**
   * V1d-1 SD-7 (M:214-218): the crest (a rotated square, "GM" counter-rotated inside), the
   * campaign name, and -- on the sidebar copy only -- a sub-line "Backstage · campaign <name>".
   * `opts.compact` (the n1 top bar copy, M:1099-1106) drops the sub-line entirely; it still gets
   * an (empty, hidden) [data-part="campaign"] node so updateBrand()'s querySelectorAll loop
   * doesn't need to special-case which copies carry a sub-line.
   */
  function buildBrand(opts) {
    opts = opts || {};
    var wrap = el('div');
    wrap.className = 'a1-brand';
    wrap.setAttribute('data-role', 'brand-title');
    var crest = el('div');
    crest.className = 'a1-crest';
    crest.setAttribute('aria-hidden', 'true');
    var crestSpan = el('span');
    setText(crestSpan, 'GM');
    crest.appendChild(crestSpan);
    wrap.appendChild(crest);
    var lines = el('div');
    var name = el('div');
    name.className = 'a1-camp';
    name.setAttribute('data-part', 'name');
    lines.appendChild(name);
    var sub = el('div');
    sub.className = 'a1-sub';
    if (opts.compact) {
      sub.hidden = true;
      var hiddenCode = el('code');
      hiddenCode.setAttribute('data-part', 'campaign');
      sub.appendChild(hiddenCode);
    } else {
      var subLabel = el('span');
      setText(subLabel, 'Backstage · campaign ');
      sub.appendChild(subLabel);
      var subCode = el('code');
      subCode.setAttribute('data-part', 'campaign');
      sub.appendChild(subCode);
    }
    lines.appendChild(sub);
    wrap.appendChild(lines);
    return wrap;
  }

  function updateBrand(session, state) {
    var nameNodes = document.querySelectorAll('[data-role="brand-title"] [data-part="name"]');
    for (var i = 0; i < nameNodes.length; i++) setText(nameNodes[i], brandTitleText(session, state));
    var campaignNodes = document.querySelectorAll('[data-role="brand-title"] [data-part="campaign"]');
    for (var j = 0; j < campaignNodes.length; j++) setText(campaignNodes[j], brandCampaignText(session));
  }

  /**
   * One nav control. `short` true renders the n1 bottom-bar's short label instead of the full
   * one. V1d-1 SD-7 (M:221-228): default class is `.a1-ni` (the sidebar/sheet item); the bottom
   * bar passes its own `.mbi` class instead (mock's mobileBottom() is a wholly separate class
   * from a1Nav()'s `.a1-ni`, never both on the same element). Markers move into a single
   * `<span class="end">` wrapper: pending first (as `.a1-dot`, matching the mock's own marker),
   * then read-only/soon (both rendered with `.a1-ro`, per the mock's single "read-only" style
   * reused for "soon" -- there is no separate mock class for it). `.is-soon` on the anchor itself
   * makes soon items recede (SD-7's last bullet); readOnly items get no such dimming.
   */
  function navLink(item, opts) {
    opts = opts || {};
    var a = el('a');
    a.href = NV.hrefFor(item.id);
    a.setAttribute('data-nav', item.id);
    a.className = opts.className || 'a1-ni';
    if (item.soon) a.classList.add('is-soon');
    a.appendChild(icon(item.icon));
    var label = el('span');
    setText(label, opts.short ? item.short : item.label);
    a.appendChild(label);

    var end = el('span');
    end.className = 'end';

    // V1c SD-7: the visible read-only marker (frame.js:60-77's carried-forward gap -- only the
    // "Read-only" group heading said it; vault-config.md's own nav item never did).
    if (item.readOnly) {
      var readOnly = el('span');
      readOnly.className = 'a1-ro';
      setText(readOnly, 'read-only');
      end.appendChild(readOnly);
    }
    if (item.soon) {
      var soon = el('span');
      soon.className = 'a1-ro';
      setText(soon, 'later');
      end.appendChild(soon);
    }
    // V1e-9 (SD-102, D-5): the Advanced group's guard marker (vault-config.md). Built empty here;
    // updateNavGuard fills in the class and text on every copy.
    if (item.guarded) {
      var guard = el('span');
      guard.setAttribute('data-part', 'guard');
      end.appendChild(guard);
    }
    // V1b: a hidden pending-changes badge, updated from store.pending (updateNavPending below)
    // across all three nav copies (side, bottom bar, sheet) -- every navLink() call gets one.
    var pending = el('span');
    pending.className = 'nav-pending';
    pending.setAttribute('data-part', 'pending');
    pending.hidden = true;
    var dot = el('span');
    dot.className = 'a1-dot';
    dot.setAttribute('aria-hidden', 'true');
    pending.appendChild(dot);
    var pendingText = el('span');
    pendingText.className = 'visually-hidden';
    pendingText.setAttribute('data-part', 'pending-text');
    pending.appendChild(pendingText);
    end.appendChild(pending);

    a.appendChild(end);
    return a;
  }

  /** V1e-9 (SD-102): sets the class and text on every [data-part="guard"] copy (sidebar, bottom
   * bar, sheet). Only one nav item is ever `guarded` (vault-config.md), so this global update is
   * exact: it never needs a per-item lookup. */
  function updateNavGuard(writable, editing) {
    var marker = NV.guardMarker(writable, editing);
    var marks = document.querySelectorAll('[data-part="guard"]');
    for (var i = 0; i < marks.length; i++) {
      marks[i].className = marker.cls;
      setText(marks[i], marker.text);
    }
  }

  /** Updates every [data-nav] link's pending badge from `pendingMap` (store.pending). */
  function updateNavPending(pendingMap) {
    var links = document.querySelectorAll('[data-nav]');
    for (var i = 0; i < links.length; i++) {
      var id = links[i].getAttribute('data-nav');
      var n = (pendingMap && pendingMap[id]) || 0;
      var marker = links[i].querySelector('[data-part="pending"]');
      if (!marker) continue;
      marker.hidden = n <= 0;
      var text = marker.querySelector('[data-part="pending-text"]');
      if (text) setText(text, n + ' unsaved changes');
    }
  }

  /**
   * The full FR-01 nav (all groups, all items): used for both the sidebar and the sheet.
   * V1d-1 SD-7 (M:219-220): each group is a `.a1-ng` wrapper; its label stays a `div` (never an
   * `h2`, to keep heading order clean -- the page's only headings are the a1-h2 screen title and
   * whatever the screen body itself adds) but is styled identically to the mock's `.a1-ng h2`
   * via the dedicated `.a1-ng-label` rule.
   */
  function buildNavList() {
    var wrap = el('div');
    wrap.className = 'a1-nav';
    NV.GROUP_ORDER.forEach(function (group) {
      var items = NV.NAV.filter(function (n) {
        return n.group === group;
      });
      if (items.length === 0) return;
      var groupWrap = el('div');
      groupWrap.className = 'a1-ng';
      // Issue #109: the roadmap group is announced as a named group (a screen reader says
      // "Coming later, not built yet, group") and styled quieter (.is-roadmap); its links stay
      // ordinary, reachable links.
      if (group === NV.ROADMAP_GROUP) {
        groupWrap.classList.add('is-roadmap');
        groupWrap.setAttribute('role', 'group');
        groupWrap.setAttribute('aria-label', group + ', not built yet');
      }
      var groupLabel = el('div');
      groupLabel.className = 'a1-ng-label';
      setText(groupLabel, group);
      groupWrap.appendChild(groupLabel);
      var list = el('ul');
      list.className = 'nav-list';
      items.forEach(function (item) {
        var li = el('li');
        li.appendChild(navLink(item));
        list.appendChild(li);
      });
      groupWrap.appendChild(list);
      wrap.appendChild(groupWrap);
    });
    return wrap;
  }

  /** V1d-1 SD-7 (M:229-230, M:1223): a lock icon then "Bound to <code>127.0.0.1</code> only",
   * and "Preview on <code>:<port></code>, with a GM link back here". */
  function buildSideFooter(session) {
    var footer = el('footer');
    footer.className = 'a1-sidefoot';

    var boundLine = el('span');
    boundLine.appendChild(icon('lock'));
    var boundLabel = el('span');
    setText(boundLabel, ' Bound to ');
    boundLine.appendChild(boundLabel);
    var boundCode = el('code');
    setText(boundCode, '127.0.0.1');
    boundLine.appendChild(boundCode);
    var boundSuffix = el('span');
    setText(boundSuffix, ' only');
    boundLine.appendChild(boundSuffix);
    footer.appendChild(boundLine);

    var previewLine = el('span');
    var previewLabel = el('span');
    setText(previewLabel, 'Preview on ');
    previewLine.appendChild(previewLabel);
    var previewCode = el('code');
    setText(previewCode, ':' + (session && session.previewPort));
    previewLine.appendChild(previewCode);
    var previewSuffix = el('span');
    setText(previewSuffix, ', with a GM link back here');
    previewLine.appendChild(previewSuffix);
    footer.appendChild(previewLine);

    return footer;
  }

  function buildSide(session) {
    var side = el('nav');
    side.setAttribute('data-role', 'side');
    side.className = 'a1-side';
    side.setAttribute('aria-label', 'Admin panel navigation');
    side.appendChild(buildBrand());
    side.appendChild(buildNavList());
    side.appendChild(buildSideFooter(session));
    return side;
  }

  /**
   * V1d-1 SD-7: the n1 top bar at 390 (M:363-367, M:1099-1106). A landmark `<header>` (one of
   * the "three landmark changes" that close the axe `region` finding, F9) holding the compact
   * brand (crest + title only, no sub-line) plus the current section label.
   */
  function buildTopBar() {
    var bar = el('header');
    bar.setAttribute('data-role', 'top-bar');
    var idWrap = el('div');
    idWrap.className = 'mt-id';
    idWrap.appendChild(buildBrand({ compact: true }));
    bar.appendChild(idWrap);
    var current = el('span');
    current.className = 'mt-cur';
    current.setAttribute('data-role', 'current-label');
    bar.appendChild(current);
    // V1e-3 (SD-22): a slot a screen can append its own control into (ov1's phone "Preview"
    // trigger), so it sits in the n1 top bar rather than needing its own new frame.js chrome.
    var extra = el('div');
    extra.setAttribute('data-role', 'top-bar-extra');
    extra.className = 'mt-x';
    bar.appendChild(extra);
    return bar;
  }

  /** V1e-3 (SD-22): the top-bar-extra slot node, or null before build() has run. */
  function topBarSlot() {
    return document.querySelector('[data-role="top-bar-extra"]');
  }

  /** V1d-1 SD-7: the n1 bottom bar (M:372-377), now a landmark `<nav>` (F9). DV-1: our
   * destinations (NV.BOTTOM_BAR) plus a "More" trigger, not the mock's fixed five with no More. */
  function buildBottomBar() {
    var bar = el('nav');
    bar.setAttribute('data-role', 'bottom-bar');
    bar.setAttribute('aria-label', 'Sections');
    NV.BOTTOM_BAR.forEach(function (id) {
      var item = NV.item(id);
      if (!item) return;
      bar.appendChild(navLink(item, { className: 'mbi', short: true }));
    });
    var more = el('button');
    more.type = 'button';
    more.className = 'mbi';
    more.setAttribute('data-role', 'more');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-controls', SHEET_ID);
    more.appendChild(icon('more'));
    var label = el('span');
    setText(label, 'More');
    more.appendChild(label);
    bar.appendChild(more);
    return bar;
  }

  /** V1d-1 SD-7: the "More" overflow sheet, now a landmark `<nav>` (F9, the third of the three
   * landmark changes). */
  function buildSheet() {
    var sheet = el('nav');
    sheet.id = SHEET_ID;
    sheet.setAttribute('data-role', 'sheet');
    sheet.setAttribute('aria-label', 'All sections');
    sheet.hidden = true;
    sheet.appendChild(buildNavList());
    return sheet;
  }

  /**
   * V1e-2 (SD-11): one `.a1-seg` view switcher for `screenId`, or null when NV.VIEWS has no
   * options for it. Built ONCE per screen and never rebuilt (risk area: rebuilding it on every
   * store change would drop focus mid-click) -- updateSwitchers() below is the only thing that
   * ever touches it again, and it only ever sets attributes/text on the same nodes.
   */
  function buildSwitcher(screenId) {
    var options = NV.VIEWS[screenId];
    if (!options) return null;
    var seg = el('div');
    seg.className = 'a1-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Layout');
    seg.setAttribute('data-switcher', screenId);
    options.forEach(function (opt) {
      var btn = el('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('data-view-opt', opt.id);
      var label = el('span');
      setText(label, opt.name);
      btn.appendChild(label);
      btn.addEventListener('click', function () {
        var key = NV.viewKey(screenId, currentViewport());
        if (key) store.setPref(key, opt.id);
      });
      seg.appendChild(btn);
    });
    // A visually-hidden live region: setPref's failure note ("couldn't be saved on this
    // computer") is announced without moving focus or adding visible chrome to every screen.
    var note = el('span');
    note.className = 'visually-hidden';
    note.setAttribute('role', 'status');
    note.setAttribute('data-part', 'prefs-note');
    seg.appendChild(note);
    return seg;
  }

  /**
   * Applies the current `prefs`/`prefsNote` to every already-built switcher in the DOM (never
   * rebuilds one): aria-pressed on its buttons, the prefs-note live region's text, and
   * data-view on the switcher's own screen <section> (so screen-scoped CSS/JS can key off it
   * later, per SD-11).
   */
  function currentViewport() {
    return store.get().viewport || NV.viewportClass(window.innerWidth);
  }

  function updateSwitchers(prefs, prefsNote) {
    var viewport = currentViewport();
    var segs = document.querySelectorAll('[data-switcher]');
    for (var i = 0; i < segs.length; i++) {
      var screenId = segs[i].getAttribute('data-switcher');
      var current = NV.viewFor(prefs, screenId, viewport);
      var buttons = segs[i].querySelectorAll('[data-view-opt]');
      for (var j = 0; j < buttons.length; j++) {
        var pressed = buttons[j].getAttribute('data-view-opt') === current;
        buttons[j].setAttribute('aria-pressed', pressed ? 'true' : 'false');
      }
      var note = segs[i].querySelector('[data-part="prefs-note"]');
      if (note) setText(note, prefsNote || '');
      var screen = screens[screenId];
      if (screen && current) screen.setAttribute('data-view', current);
    }
  }

  /** V1d-1 SD-5, restructured V1e-2 (SD-11): eyebrow (item.eyebrow, falling back to item.group
   * defensively), an `h1.a1-h2`, and -- only when the item carries one -- an `.a1-lede`
   * paragraph, inside a `.r3-head-t` wrapper. The whole thing sits in an `.r3-head` row, with the
   * screen's view switcher (if NV.VIEWS has one for it) as that row's second child. */
  function screenHeader(item) {
    var header = el('header');
    header.className = 'r3-head';
    var titleWrap = el('div');
    titleWrap.className = 'r3-head-t';
    var eyebrow = el('p');
    eyebrow.className = 'a1-eyebrow';
    setText(eyebrow, item.eyebrow || item.group);
    titleWrap.appendChild(eyebrow);
    var h1 = el('h1');
    h1.className = 'a1-h2';
    h1.tabIndex = -1;
    setText(h1, item.label);
    titleWrap.appendChild(h1);
    if (item.lede) {
      var lede = el('p');
      lede.className = 'a1-lede';
      setText(lede, item.lede);
      titleWrap.appendChild(lede);
    }
    header.appendChild(titleWrap);
    var switcher = buildSwitcher(item.id);
    if (switcher) header.appendChild(switcher);
    return header;
  }

  /** SD-7: placeholder content, built entirely from NV data. The eyebrow above (screenHeader)
   * already shows NV.SOON_STATUS, so the body carries only the sentence -- no redundant second
   * "not in this version yet" chip. */
  function buildPlaceholder(item, mount) {
    var sentence = el('p');
    sentence.className = 'a1-lede';
    sentence.setAttribute('data-role', 'roadmap-note');
    setText(sentence, NV.SOON_SENTENCE);
    mount.appendChild(sentence);

    if (item.id === 'publish') {
      var link = el('a');
      link.className = 'a1-link';
      link.href = NV.hrefFor('preview');
      setText(link, 'Build a preview');
      mount.appendChild(link);
    }
  }

  /** Issue #109: the "Page not found" state an unknown #/route shows instead of Overview. */
  function buildNotFound(main) {
    var screen = el('section');
    screen.setAttribute('data-screen', 'notfound');
    screen.hidden = true;
    var header = el('header');
    header.className = 'r3-head';
    var wrap = el('div');
    wrap.className = 'r3-head-t';
    var h1 = el('h1');
    h1.className = 'a1-h2';
    h1.tabIndex = -1;
    setText(h1, 'Page not found');
    wrap.appendChild(h1);
    var lede = el('p');
    lede.className = 'a1-lede';
    setText(lede, 'There is no page at this address in the admin panel.');
    wrap.appendChild(lede);
    header.appendChild(wrap);
    screen.appendChild(header);
    var link = el('a');
    link.className = 'a1-link';
    link.setAttribute('data-role', 'notfound-home');
    link.href = NV.hrefFor('overview');
    setText(link, 'Back to Overview');
    screen.appendChild(link);
    main.appendChild(screen);
    screens.notfound = screen;
  }

  function buildScreens() {
    var main = document.querySelector('[data-role="main"]');
    var existing = {};
    Object.keys(SECTION_TO_SCREEN).forEach(function (section) {
      existing[section] = document.querySelector('[data-section="' + section + '"]');
    });

    NV.NAV.forEach(function (item) {
      var screen = el('section');
      screen.setAttribute('data-screen', item.id);
      screen.hidden = true;
      // V1c SD-2: Overview supplies its own h1 (the site title) via its hero, so the frame's
      // generic screenHeader (eyebrow + h1 = the nav label) is skipped for it -- otherwise the
      // screen would carry two h1s (M5: axe page-has-heading-one/heading-order).
      if (!item.ownHeader) {
        screen.appendChild(screenHeader(item));
      } else {
        // V1e-2 (SD-11): Overview still gets a switcher -- a standalone `.r3-head` row holding
        // only it, above the mount (never inside views.js's own re-rendered hero container, so a
        // hero re-render can never carry the switcher's focused button away with it).
        var switcher = buildSwitcher(item.id);
        if (switcher) {
          var switcherRow = el('header');
          switcherRow.className = 'r3-head';
          switcherRow.setAttribute('data-role', 'overview-switcher-row');
          switcherRow.appendChild(switcher);
          screen.appendChild(switcherRow);
        }
      }
      var mount = el('div');
      mount.setAttribute('data-mount', item.id);
      screen.appendChild(mount);
      main.appendChild(screen);
      screens[item.id] = screen;
      mounts[item.id] = mount;

      if (item.soon) buildPlaceholder(item, mount);
    });

    buildNotFound(main);

    Object.keys(SECTION_TO_SCREEN).forEach(function (section) {
      var node = existing[section];
      var screenId = SECTION_TO_SCREEN[section];
      if (node && mounts[screenId]) mounts[screenId].appendChild(node);
    });
  }

  function mount(screenId) {
    return mounts[screenId];
  }

  function setSheetOpen(open) {
    var sheet = document.querySelector('[data-role="sheet"]');
    var more = document.querySelector('[data-role="more"]');
    if (!sheet || !more) return;
    sheet.hidden = !open;
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
    store.set({ sheetOpen: open });
  }

  function updateNavCurrent(screenId) {
    var links = document.querySelectorAll('[data-nav]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-nav') === screenId) {
        links[i].setAttribute('aria-current', 'page');
      } else {
        links[i].removeAttribute('aria-current');
      }
    }
  }

  /** show() never makes a request (FR02/FR04): every screen already exists in the DOM. */
  function show(route) {
    // Issue #109: 'notfound' is a frame state, not a nav item.
    var item = route.screen === 'notfound' ? { id: 'notfound', label: 'Page not found' } : NV.item(route.screen) || NV.item('overview');

    Object.keys(screens).forEach(function (id) {
      screens[id].hidden = id !== item.id;
    });
    updateNavCurrent(item.id);

    var label = document.querySelector('[data-role="current-label"]');
    if (label) setText(label, item.label);
    document.title = item.label + ' · Scriptorium admin panel';

    setSheetOpen(false);

    if (!firstShow) {
      var h1 = screens[item.id] && screens[item.id].querySelector('h1');
      if (h1) h1.focus();
    }
    firstShow = false;
  }

  function onHashChange() {
    var route = NV.resolveRoute(location.hash);
    store.set({ route: route });
    show(route);
  }

  function wireMore() {
    var more = document.querySelector('[data-role="more"]');
    if (!more) return;
    more.addEventListener('click', function () {
      var sheet = document.querySelector('[data-role="sheet"]');
      setSheetOpen(sheet ? sheet.hidden : true);
    });
  }

  /** SD-8: a disclosure, not a modal -- Escape closes it and returns focus to More. */
  function wireEscape() {
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var sheet = document.querySelector('[data-role="sheet"]');
      if (!sheet || sheet.hidden) return;
      setSheetOpen(false);
      var more = document.querySelector('[data-role="more"]');
      if (more) more.focus();
    });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** Not mocked (read-only states are one of the states shell.src.html never draws), so it gets
   * the same visual language rather than a literal port: an `.a1-note` with the info icon. */
  function buildReadOnlyBanner(session) {
    var reason = el('div');
    reason.className = 'a1-note';
    reason.setAttribute('data-role', 'read-only-reason');
    reason.hidden = true;
    if (session && session.writable === false) {
      reason.appendChild(icon('info'));
      var p = el('p');
      setText(p, session.readOnlyReason || '');
      reason.appendChild(p);
      reason.hidden = false;
    }
    return reason;
  }

  // V1c SD-5 (FR-20 busy): a role="status" line above the screens, showing ST.busyLine(busy).
  // null (nothing set, or a value the panel never uses) hides the element and clears its text.
  // V1d-1 DV-13: styled like the mock's `.a1-busy` (M:224), including its `.spin` marker
  // (M:1121's own busy markup) whenever a line is showing.
  function buildBusyStatus() {
    var status = el('p');
    status.className = 'a1-busy';
    status.setAttribute('data-role', 'busy-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    return status;
  }

  function updateBusyStatus(busy) {
    var status = document.querySelector('[data-role="busy-status"]');
    if (!status) return;
    var line = ST.busyLine(busy);
    clear(status);
    if (line) {
      var spin = el('span');
      spin.className = 'spin';
      spin.setAttribute('aria-hidden', 'true');
      status.appendChild(spin);
      var text = el('span');
      setText(text, line);
      status.appendChild(text);
    }
    status.hidden = !line;
  }

  // ===========================================================================================
  // V1e-2 (SD-12): the right-hand pane slot. `ScriptoriumAdmin.pane` is the public API
  // (register/unregister/openOverlay/closeOverlay/layout); everything else here is internal
  // rendering, driven by the pure NV.paneLayout policy. Nothing registers a real pane in this
  // slice (SD-12's own note) -- the first consumer is V1e-3.
  // ===========================================================================================

  var paneSpecs = {};
  // { owner, trigger, kind } while a drawer/sheet overlay is open; null otherwise.
  var openOverlayInfo = null;

  function currentScreenId() {
    var route = store.get().route;
    return (route && route.screen) || 'overview';
  }

  /** Recomputes (never renders) the pure result for right now: current screen, viewport, prefs. */
  function computePaneLayout() {
    var screenId = currentScreenId();
    var screenSpec = paneSpecs[screenId] || null;
    var globalSpec = paneSpecs['*'] || null;
    // V1e-3 (SD-22): viewport now lives in the store (set by build() and the resize listener
    // below); the direct window.innerWidth read is only a defensive fallback for before the
    // store's first viewport is set.
    var viewport = store.get().viewport || NV.viewportClass(window.innerWidth);
    var prefs = store.get().prefs || NV.PREF_DEFAULTS;
    return { screenId: screenId, viewport: viewport, result: NV.paneLayout(viewport, screenSpec, globalSpec, prefs) };
  }

  // V1e-3 (SD-22): the last (owner, spec object, mode) actually rendered into the pane slot, so
  // an unchanged triple is a no-op -- an idempotence guard against Overview's own full re-render
  // on every store change (risk area 2: a frame placed inside a rebuilt container reloads).
  var lastSlotRender = null;

  /** Handles result.dock (mode 'dock') or result.below (mode 'below'); result.js:frame.build */
  function renderSlot(computed) {
    var aside = document.querySelector('[data-role="pane"]');
    var body = document.querySelector('[data-role="body"]');
    if (!aside) return;
    var below = computed.result.below;
    var slot = computed.result.dock || below;
    var mode = below ? 'below' : 'dock';

    if (!slot) {
      lastSlotRender = null;
      aside.hidden = true;
      clear(aside);
      aside.removeAttribute('aria-label');
      aside.className = 'a1-pane';
      if (body) {
        body.classList.remove('has-dock');
        body.classList.remove('has-below');
      }
      return;
    }

    if (body) {
      body.classList.toggle('has-dock', mode === 'dock');
      body.classList.toggle('has-below', mode === 'below');
    }

    if (lastSlotRender && lastSlotRender.owner === slot.owner && lastSlotRender.spec === slot.spec && lastSlotRender.mode === mode) {
      aside.hidden = false;
      return; // idempotent: the same (owner, spec, mode) triple is already rendered.
    }

    aside.hidden = false;
    aside.className = 'a1-pane' + (slot.spec.className ? ' ' + slot.spec.className : '') + (mode === 'below' ? ' is-below' : '');
    aside.setAttribute('aria-label', slot.spec.label || '');
    clear(aside);
    if (typeof slot.spec.build === 'function') slot.spec.build(aside, mode);
    lastSlotRender = { owner: slot.owner, spec: slot.spec, mode: mode };
  }

  function renderEdges(computed) {
    var col = document.querySelector('[data-role="pane-edges"]');
    if (!col) return;
    clear(col);
    computed.result.edges.forEach(function (entry) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'a1-edge';
      btn.setAttribute('aria-label', 'Show ' + (entry.spec.label || ''));
      // V1e-3 (SD-22): every edge button names its own owner, so closeOverlay() can fall back to
      // "the first trigger for this owner" when the original trigger element has been re-rendered
      // away (risk area 7: focus loss when a trigger re-renders while its overlay is open).
      btn.setAttribute('data-pane-trigger', entry.owner);
      btn.appendChild(icon('preview'));
      var label = el('span');
      setText(label, entry.spec.label || '');
      btn.appendChild(label);
      btn.addEventListener('click', function () {
        if (entry.action === 'reveal' && entry.spec.hiddenPref) {
          store.setPref(entry.spec.hiddenPref, false);
        } else if (entry.action === 'swap' && entry.pref) {
          // D-16 swap (V1e-3): the screen's own rail hides, so the global preview (already
          // docked at wide) takes its place -- never the global's own (do-nothing) pref.
          store.setPref(entry.pref, true);
        } else if (entry.action === 'open') {
          openOverlay(entry.owner, btn);
        }
      });
      col.appendChild(btn);
    });
    col.hidden = computed.result.edges.length === 0;
  }

  var OVERLAY_IDS = { drawer: 'admin-pane-drawer', sheet: 'admin-pane-sheet' };

  /** One native `<dialog>` per kind, built once and reused (slip.js's own dialog precedent). */
  function overlayDialog(kind) {
    var id = OVERLAY_IDS[kind];
    var existing = document.getElementById(id);
    if (existing) return existing;
    var dialog = el('dialog');
    dialog.id = id;
    dialog.className = kind === 'sheet' ? 'a1-sheetfull' : 'a1-drawer';
    var body = el('div');
    body.className = 'pane-overlay-body';
    body.setAttribute('data-part', 'body');
    dialog.appendChild(body);
    document.body.appendChild(dialog);
    // Escape fires 'cancel' before the dialog closes itself; intercepted so closeOverlay() runs
    // its own bookkeeping (openOverlayInfo, focus return) exactly once, the same way slip.js's
    // own dialog does.
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      closeOverlay();
    });
    return dialog;
  }

  /** Opens `owner`'s overlay, if the current viewport's paneLayout result actually has one for
   * it (a stale click on an edge tab built for a since-changed layout is simply a no-op). */
  function openOverlay(owner, trigger) {
    var computed = computePaneLayout();
    var ov = computed.result.overlay;
    if (!ov || ov.owner !== owner) return;
    var dialog = overlayDialog(ov.kind);
    var body = dialog.querySelector('[data-part="body"]');
    clear(body);
    if (typeof ov.spec.build === 'function') ov.spec.build(body, ov.kind);
    dialog.setAttribute('aria-label', ov.spec.label || '');
    openOverlayInfo = { owner: owner, trigger: trigger || null, kind: ov.kind };
    if (!dialog.open) dialog.showModal();
  }

  /** True when `el` is actually on-screen and focusable, not merely present in the document --
   * `hidden` (sitepane's phone top-bar trigger carries this whenever it isn't the live one) and
   * any ancestor's `display: none` both leave `offsetParent` null. */
  function isElementVisible(el) {
    return !!el && !el.hidden && el.offsetParent !== null;
  }

  /**
   * V1e-3 (SD-22, risk area 7), reworked (Reviewer finding, 2026-09-30): returns focus to the
   * saved trigger, UNLESS it has been removed from the document (e.g. a hero re-render mid-
   * drawer, such as a Build completing) or is no longer visible, in which case it falls back to
   * the first live, VISIBLE `[data-pane-trigger="<owner>"]` -- never just the first DOM match.
   * More than one trigger can carry the same owner at once (sitepane's hero "Site preview"
   * button and its phone top-bar "Preview" button both use `data-pane-trigger="screen"`, and only
   * one is ever visible for a given viewport); a plain `querySelector` picked whichever sorted
   * first in the DOM regardless of whether it was the hidden one, and `.focus()` on a hidden
   * element is a silent no-op, so focus fell through to `<body>`. The actual choice is delegated
   * to `NV.pickFocusTarget`, a pure function over plain {connected, visible} descriptors, so the
   * decision itself is unit-testable without a real DOM; this function only builds the
   * descriptors and calls `.focus()` on whichever real element it picks.
   */
  function closeOverlay() {
    if (!openOverlayInfo) return;
    var dialog = document.getElementById(OVERLAY_IDS[openOverlayInfo.kind]);
    if (dialog && dialog.open) dialog.close();
    var trigger = openOverlayInfo.trigger;
    var owner = openOverlayInfo.owner;
    openOverlayInfo = null;

    var candidates = [];
    if (trigger) candidates.push(trigger);
    var fallbackNodes = document.querySelectorAll('[data-pane-trigger="' + owner + '"]');
    for (var i = 0; i < fallbackNodes.length; i++) candidates.push(fallbackNodes[i]);

    var descriptors = candidates.map(function (el) {
      return { connected: el.isConnected !== false, visible: isElementVisible(el) };
    });
    var idx = NV.pickFocusTarget(descriptors);
    if (idx !== -1 && typeof candidates[idx].focus === 'function') candidates[idx].focus();
  }

  /**
   * Recomputes AND re-renders the pane slot for right now, then returns the same pure result
   * NV.paneLayout produced (so a future screen's own render code can ask "am I inline right
   * now?" without duplicating the computation). Idempotent: safe to call as often as needed.
   * Triggers, per SD-12: a prefs change, a route change, register()/unregister(), and the
   * 1800px/699px breakpoints changing (wired below in wirePaneViewportListeners).
   */
  function layout() {
    var computed = computePaneLayout();
    // V1e-2 (SD-13): the 1180px content cap applies only with nothing docked. renderSlot() itself
    // toggles .has-dock/.has-below on [data-role="body"] (V1e-3, SD-22).
    renderSlot(computed);
    renderEdges(computed);
    if (openOverlayInfo) {
      var ov = computed.result.overlay;
      if (!ov || ov.owner !== openOverlayInfo.owner || ov.kind !== openOverlayInfo.kind) closeOverlay();
    }
    return computed.result;
  }

  function register(owner, spec) {
    paneSpecs[owner] = spec;
    layout();
  }

  function unregister(owner) {
    delete paneSpecs[owner];
    if (openOverlayInfo && openOverlayInfo.owner === owner) closeOverlay();
    layout();
  }

  function wirePaneViewportListeners() {
    var wideQuery = window.matchMedia('(min-width: 1800px)');
    var phoneQuery = window.matchMedia('(max-width: 699px)');
    // V1e-3 (SD-22): sets store.viewport rather than calling layout() directly -- the store
    // subscription below (in build()) reacts to a viewport change the same way it reacts to a
    // prefs change (updateSwitchers, then layout()), so there is exactly one place that decides
    // "viewport changed, now what".
    function onChange() {
      store.set({ viewport: NV.viewportClass(window.innerWidth) });
    }
    if (wideQuery.addEventListener) {
      wideQuery.addEventListener('change', onChange);
      phoneQuery.addEventListener('change', onChange);
    } else if (wideQuery.addListener) {
      // Older engines only: addListener is deprecated, but it is the only API they have.
      wideQuery.addListener(onChange);
      phoneQuery.addListener(onChange);
    }
  }

  function build(session) {
    var app = document.querySelector('[data-role="app"]');
    var main = document.querySelector('[data-role="main"]');
    if (!app || !main) return;

    // V1d-1 SD-7 (M:212): .a1-layout wraps the sidebar and main, matching the mock's own grid
    // (fixes a clipped-sidebar-background/footer bug the earlier fixed-position sidebar had on
    // any page taller than one viewport).
    var layoutEl = el('div');
    layoutEl.className = 'a1-layout';
    app.insertBefore(layoutEl, main);
    var side = buildSide(session);
    layoutEl.appendChild(side);

    // V1e-2 (SD-12): .a1-body wraps main plus the pane slot (a docked <aside>, and a column for
    // edge tabs) inside .a1-layout.
    var body = el('div');
    body.className = 'a1-body';
    body.setAttribute('data-role', 'body');
    body.appendChild(main);
    var pane = el('aside');
    pane.setAttribute('data-role', 'pane');
    pane.className = 'a1-pane';
    pane.hidden = true;
    body.appendChild(pane);
    var paneEdges = el('div');
    paneEdges.setAttribute('data-role', 'pane-edges');
    paneEdges.className = 'a1-pane-edges';
    paneEdges.hidden = true;
    body.appendChild(paneEdges);
    layoutEl.appendChild(body);

    var topBar = buildTopBar();
    app.insertBefore(topBar, layoutEl);

    var readOnlyBanner = buildReadOnlyBanner(session);
    main.insertBefore(readOnlyBanner, main.firstChild);
    main.insertBefore(buildBusyStatus(), readOnlyBanner.nextSibling);

    buildScreens();

    var bottomBar = buildBottomBar();
    app.appendChild(bottomBar);
    // The sheet comes after the bar in the DOM (SD-8), so Tab goes from More into the sheet.
    var sheet = buildSheet();
    app.appendChild(sheet);

    // V1e-3 (SD-22): the viewport lands in the store BEFORE the first updateSwitchers/layout, so
    // that first paint already reads the right class -- never a flash of the wrong one.
    store.set({ viewport: NV.viewportClass(window.innerWidth) });

    updateBrand(session, null);
    updateNavPending(store.get().pending);
    updateBusyStatus(store.get().busy);
    updateNavGuard(session.writable, store.get().vcEditing);
    // V1e-2 (SD-10, SD-11, SD-12): the switchers and the pane both read the store's prefs, which
    // app.js's boot sequence already loaded before calling build() -- so this first paint is
    // already correct, never a flash of the wrong option.
    updateSwitchers(store.get().prefs, store.get().prefsNote);
    layout();
    store.subscribe(function (next, prev) {
      updateBrand(session, next.state);
      if (next.pending !== prev.pending) updateNavPending(next.pending);
      if (next.busy !== prev.busy) updateBusyStatus(next.busy);
      if (next.vcEditing !== prev.vcEditing) updateNavGuard(session.writable, next.vcEditing);
      // V1e-3 (SD-22): a viewport change is treated exactly like a prefs change -- the switchers
      // and the pane both key off the current class.
      if (next.prefs !== prev.prefs || next.prefsNote !== prev.prefsNote || next.viewport !== prev.viewport) {
        updateSwitchers(next.prefs, next.prefsNote);
        layout();
      } else if (next.route !== prev.route) {
        layout();
      }
    });
    wirePaneViewportListeners();

    wireMore();
    wireEscape();
  }

  function start() {
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
  }

  /** SD-11, extended V1e-3 (SD-22): for later slices' own render code to read "which view is
   * chosen for this screen right now" without reaching into the store directly. Signature is
   * UNCHANGED (V1e-4/V1e-6 depend on it): it reads the current viewport class from the store
   * itself, the same way updateSwitchers()/buildSwitcher() do. */
  function viewsCurrent(screenId) {
    return NV.viewFor(store.get().prefs, screenId, currentViewport());
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.frame = { build: build, start: start, topBarSlot: topBarSlot };
  window.ScriptoriumAdmin.mount = mount;
  // V1e-2 (SD-12): register(owner, spec) / unregister(owner) / openOverlay(owner, trigger) /
  // closeOverlay() / layout(). Nothing registers a pane in this slice -- see SD-12's own note.
  window.ScriptoriumAdmin.pane = { register: register, unregister: unregister, openOverlay: openOverlay, closeOverlay: closeOverlay, layout: layout };
  window.ScriptoriumAdmin.views = { current: viewsCurrent };
})();
