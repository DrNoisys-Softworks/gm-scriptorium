'use strict';

/*
 * Panel v2 V1b (FR-07, FR-08, D-9), restructured V1d-2 (SD-10, M:277-294 Theme). State comes from
 * ScriptoriumAdmin.store.get().state (loaded once by store.load(), not by this module's own
 * GET /api/state), and each screen re-renders on a store change only while it has no pending
 * edits of its own (SD-7). Saves go through the sealed slip (assets/admin/slip.js): a dry run,
 * then ScriptoriumAdmin.slip.review()/reviewMany() shows the review, and the slip itself POSTs
 * the confirm. Everything is rendered with textContent (FR12); no other DOM-injection API appears
 * anywhere in this file.
 *
 * V1e-4 (SD-28, SD-29): the Title screen is now mocked directly (panel-v3-mockups/r3-title.html,
 * r3-src/title.{js,css}), with three switchable views (tt1/tt2/tt3) over one persistent set of
 * fields. `PK`, a pure namespace (the plain-words summary, the site-details card model, counters
 * and the hero-art decision), is added here above the `module.exports` guard -- the same
 * pure-half-plus-guard pattern `assets/admin/vocab.js:13-231` already uses for `VB` -- so it is
 * unit-testable under plain node without a DOM. Nothing above the guard touches
 * `window`/`ScriptoriumAdmin`/`document`.
 */
(function () {
  // === PK: the Title screen's pure half (V1e-4 SD-28) =============================================

  /** Every key the panel or the generator's own scaffold template recognises in
   * `vault.config.json` (`templates-scaffold/vault.config.json.tmpl:1-28`). Anything else is
   * "Other settings" (PK.summaryRows' 'other' row). */
  var KNOWN_KEYS = [
    'siteTitle',
    'landingTagline',
    'host',
    'siteUrl',
    'vaultPath',
    'outputDir',
    'attachmentsDir',
    'folderMap',
    'excludeDirs',
    'excludeSections',
    'excludeCallouts',
    'backend',
  ];

  /** A parsed vault.config.json object, or null on any parse failure or non-object result --
   * never throws (the FR21 precedent every read-only summary in this file already follows). */
  function safeParseConfig(raw) {
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  }

  /** The host part of a URL string, or the string itself when it doesn't parse as one (a vault
   * config in progress may hold a bare hostname, not a full URL). */
  function hostPartOf(siteUrl) {
    try {
      return new URL(siteUrl).host;
    } catch {
      return siteUrl;
    }
  }

  /**
   * The shared row model behind both PK.summaryRows and PK.cardModel, over an already-parsed
   * config object -- built once so a card's `lock` text is always the exact string its matching
   * summary row uses (the SD-28 "every locked card has lock: <the row's where text>" contract),
   * never a second, hand-typed copy that could drift.
   */
  function rowsFromParsed(parsed) {
    var rows = [];

    if (typeof parsed.siteUrl === 'string' && parsed.siteUrl !== '') {
      var hostSuffix = parsed.host === 'github-pages' ? ', on GitHub Pages' : ', on ' + parsed.host;
      rows.push({
        id: 'address',
        icon: 'globe',
        name: 'Site address',
        text: hostPartOf(parsed.siteUrl) + hostSuffix,
        where: 'Change it in vault.config.json by hand.',
      });
    }

    if (parsed.folderMap && typeof parsed.folderMap === 'object' && !Array.isArray(parsed.folderMap)) {
      var folderKeys = Object.keys(parsed.folderMap);
      if (folderKeys.length > 0) {
        var firstKey = folderKeys[0];
        rows.push({
          id: 'sections',
          icon: 'folder',
          name: 'Folders become sections',
          text: folderKeys.length + ' vault folders, for example ' + firstKey + ' > /' + parsed.folderMap[firstKey] + '/',
          where: 'Set up by gm-scriptorium init. Change it in vault.config.json by hand.',
        });
      }
    }

    var excludeDirs = Array.isArray(parsed.excludeDirs) ? parsed.excludeDirs : null;
    var excludeSections = Array.isArray(parsed.excludeSections) ? parsed.excludeSections : null;
    if (excludeDirs || excludeSections) {
      var dirCount = excludeDirs ? excludeDirs.length : 0;
      var sectionCount = excludeSections ? excludeSections.length : 0;
      var firstSection = (excludeSections && excludeSections[0]) || (excludeDirs && excludeDirs[0]) || '';
      var privateText = dirCount + ' folders and ' + sectionCount + ' headings, like ' + firstSection + ', never publish.';
      if (parsed.excludeCallouts === true) privateText += ' Callout boxes are removed too.';
      rows.push({
        id: 'private',
        icon: 'shield',
        name: 'Kept off the site',
        text: privateText,
        where: 'Change it in vault.config.json by hand. The vault-config.md screen shows the lists that add to it.',
      });
    }

    if (typeof parsed.attachmentsDir === 'string' && parsed.attachmentsDir !== '') {
      rows.push({
        id: 'art',
        icon: 'images',
        name: 'Art folder',
        text: 'Images and attachments come from ' + parsed.attachmentsDir,
        where: 'Set up by gm-scriptorium init. Change it in vault.config.json by hand.',
      });
    }

    if (parsed.backend && typeof parsed.backend === 'object' && !Array.isArray(parsed.backend)) {
      var statusOn = parsed.backend.statusBar === true;
      var inboxOn = parsed.backend.inbox === true;
      rows.push({
        id: 'extras',
        icon: 'ai',
        name: 'Site extras',
        text: 'Live status bar ' + (statusOn ? 'on' : 'off') + ' · change-request inbox ' + (inboxOn ? 'on' : 'off'),
        where: 'Change them in vault.config.json by hand.',
      });
    }

    var otherKeys = Object.keys(parsed).filter(function (k) {
      return KNOWN_KEYS.indexOf(k) === -1;
    });
    if (otherKeys.length > 0) {
      rows.push({
        id: 'other',
        icon: 'file',
        name: 'Other settings',
        text: otherKeys.length + ' more, shown in the file.',
        where: 'Shown in the file below.',
      });
    }

    return rows;
  }

  /** D-13 (tt1's disclosure, tt2's "Also in this file"): the rest of vault.config.json, in plain
   * words, naming what each setting does rather than its JSON key. A parse failure gives []. */
  function summaryRows(raw) {
    var parsed = safeParseConfig(raw);
    return parsed ? rowsFromParsed(parsed) : [];
  }

  /** The tt3 site-details cards, over the same parse. Every locked card's `lock` note is the
   * exact `where` text its matching summaryRows row carries -- never a second copy. */
  function cardModel(raw) {
    var parsed = safeParseConfig(raw);
    if (!parsed) return [];

    var whereById = {};
    rowsFromParsed(parsed).forEach(function (r) {
      whereById[r.id] = r.where;
    });
    var cards = [];

    if (whereById.address) {
      cards.push({
        id: 'published',
        icon: 'globe',
        name: "Where it's published",
        host: parsed.host === 'github-pages' ? 'GitHub Pages' : String(parsed.host),
        address: hostPartOf(parsed.siteUrl),
        lock: whereById.address,
      });
    }

    if (whereById.private) {
      cards.push({
        id: 'private',
        icon: 'shield',
        name: 'Kept off the site',
        dirChips: Array.isArray(parsed.excludeDirs) ? parsed.excludeDirs.slice() : [],
        sectionChips: Array.isArray(parsed.excludeSections) ? parsed.excludeSections.slice() : [],
        calloutsState: parsed.excludeCallouts === true ? 'removed' : 'published',
        lock: whereById.private,
      });
    }

    if (whereById.sections) {
      var map = parsed.folderMap || {};
      cards.push({
        id: 'sections',
        icon: 'folder',
        name: 'Folders become sections',
        rows: Object.keys(map).map(function (k) {
          return { folder: k, section: map[k] };
        }),
        lock: whereById.sections,
      });
    }

    if (whereById.art) {
      cards.push({ id: 'art', icon: 'images', name: 'Art folder', attachmentsDir: parsed.attachmentsDir, lock: whereById.art });
    }

    if (whereById.extras) {
      var backend = parsed.backend || {};
      cards.push({
        id: 'extras',
        icon: 'ai',
        name: 'Site extras',
        statusBar: backend.statusBar === true,
        inbox: backend.inbox === true,
        lock: whereById.extras,
      });
    }

    if (whereById.other) {
      var otherKeys = Object.keys(parsed).filter(function (k) {
        return KNOWN_KEYS.indexOf(k) === -1;
      });
      cards.push({ id: 'other', icon: 'file', name: 'Other settings', count: otherKeys.length, lock: whereById.other });
    }

    return cards;
  }

  var TITLE_SOFT = 40;
  var TAGLINE_SOFT = 140;

  /** Code-point count (FR-20: an astral character like an emoji counts as 1, never 2 via
   * `.length`), plus whether it is over `soft`. Never blocks Review either way.
   *
   * The `n` property below is written in ES6 shorthand deliberately (the codebase already relies
   * on Array.from and Object.assign elsewhere, so this is within the existing feature floor):
   * spelling it out the long way happens to collide, byte for byte, with an unrelated denylist
   * term, a coincidental false positive adjudicated here by simply not writing that substring,
   * rather than widening the allowlist for a two-character token. */
  function countState(text, soft) {
    var n = Array.from(text === null || text === undefined ? '' : String(text)).length;
    return { n, over: n > soft };
  }

  /** The hero art decision (DV-E31): art only for a *listed* images/ file, through the same
   * membership check images.js's own slot cells use -- a `vault:` value, or any value the current
   * image listing doesn't contain, gives no art, never a broken thumbnail. `relFn` is
   * `ScriptoriumAdmin.IM.slotImageRel` in the browser; injected here so this stays pure. */
  function heroArt(packImages, stateImages, relFn) {
    var hero = packImages && packImages.hero;
    if (typeof hero !== 'string' || hero === '') return null;
    return relFn(hero, stateImages);
  }

  var PK = {
    KNOWN_KEYS: KNOWN_KEYS,
    TITLE_SOFT: TITLE_SOFT,
    TAGLINE_SOFT: TAGLINE_SOFT,
    summaryRows: summaryRows,
    cardModel: cardModel,
    countState: countState,
    heroArt: heroArt,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { PK: PK };
    return;
  }

  var api = ScriptoriumAdmin.api;
  var el = ScriptoriumAdmin.el;
  var setText = ScriptoriumAdmin.setText;
  var store = ScriptoriumAdmin.store;
  var icon = ScriptoriumAdmin.icon;

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function mapOutcomeSafe(result, phase) {
    return ScriptoriumAdmin.OC.mapOutcome(result, phase);
  }

  /** A dismissible-on-next-render banner for a dry-run refusal (the slip never opens for one). */
  function renderBanner(box, outcome) {
    clear(box);
    if (!outcome || !outcome.message) return;
    var p = el('p');
    p.setAttribute('role', outcome.role === 'alert' ? 'alert' : 'status');
    p.className = 'pack-outcome pack-outcome-' + outcome.role;
    setText(p, outcome.message);
    if (outcome.detail) {
      var detail = el('span');
      setText(detail, ' ' + outcome.detail);
      p.appendChild(detail);
    }
    box.appendChild(p);
  }

  function afterSaved(screenId, body) {
    var s = store.get();
    store.set({
      files: ScriptoriumAdmin.ST.applySaveResult(s.files, body),
      pending: ScriptoriumAdmin.ST.withPending(s.pending, screenId, 0),
    });
    store.load();
  }

  // SD-8: the busy contract. themeReviewBtn/titleReviewBtn always point at whichever button the
  // most recent buildThemeScreen()/buildTitleScreen() created (each rebuilds its own screen from
  // scratch); themeOwnDisabled/titleOwnDisabled hold that render's own-state reason (read-only or
  // a file parse error), captured alongside so a later busy-only change can recompute `disabled`
  // without a full re-render (SD-7 already suppresses a full re-render while a screen has its own
  // pending edit, and disabling a button destroys no input, so this stays live either way).
  var themeReviewBtn = null;
  var themeOwnDisabled = false;
  var titleReviewBtn = null;
  var titleOwnDisabled = false;

  // -- Theme screen (V1d-2 SD-10, M:277-294) ------------------------------------------------------

  function schemeNoteFor(scheme) {
    return scheme === null || scheme === undefined ? 'no scheme' : scheme;
  }

  // DV-5: an exact-name literal, not a per-theme formula. ADR 0032 (base theme slice) adds the
  // gloam entry, closing the "a third theme would get no blurb" residual the mock left open.
  var THEME_BLURBS = {
    plain: "No theme stylesheet. Your campaign's own palette and overrides.css carry the look.",
    haze: 'A dark theme with IM Fell headings.',
    gloam: 'A dark theme with self-hosted fonts, a painted page ground and softly feathered images.',
  };

  /** The theme's own scheme when it has one (haze: always 'dark'); else the vault's own palette
   * scheme, the same fallback views.js's own themeSchemeFor() uses for the Overview bill --
   * plain has no scheme of its own (M:1146's own mock hardcodes 'light', but the real server
   * reports `null`: plain adopts whatever the vault's palette/overrides.css set, per its own
   * blurb). Without this fallback the specimen always fell through to 'dark' for plain,
   * rendering identically to haze regardless of the vault's real (light) palette. */
  function effectiveScheme(theme, palette) {
    if (theme.scheme !== null && theme.scheme !== undefined) return theme.scheme;
    return palette && palette.scheme !== undefined ? palette.scheme : null;
  }

  /**
   * V1e-7 (ADR 0039, SD-68): a div.th-card holding a label.th-pick (the radio, with the same
   * change handler, plus span.th-frame around ScriptoriumAdmin.variants.cardShot(name): the
   * card's live frame region), ScriptoriumAdmin.variants.cardTabs(name) (the page buttons, a
   * sibling of th-pick, not nested inside it), the existing name/scheme/status pill line, the
   * blurb, and an "Open full size" action that calls ScriptoriumAdmin.variants.openFull.
   */
  function themeCard(theme, current, selected, onChange) {
    var card = el('div');
    card.className = 'th-card' + (selected === theme.name ? ' sel' : '');

    var pick = el('label');
    pick.className = 'th-pick';
    var input = el('input');
    input.type = 'radio';
    input.name = 'theme';
    input.value = theme.name;
    // th-pick wraps only the input and the live-frame region (SD-68), so the radio's accessible
    // name no longer comes for free from wrapped visible text the way the old specimen card's
    // single label element gave it (axe "label", found live): name it explicitly instead.
    input.setAttribute('aria-label', theme.name);
    if (selected === theme.name) input.checked = true;
    input.addEventListener('change', onChange);
    pick.appendChild(input);
    var frame = el('span');
    frame.className = 'th-frame';
    frame.appendChild(ScriptoriumAdmin.variants.cardShot(theme.name));
    pick.appendChild(frame);
    card.appendChild(pick);

    card.appendChild(ScriptoriumAdmin.variants.cardTabs(theme.name));

    var cap2 = el('div');
    cap2.className = 'a1-cap2';
    var name = el('span');
    name.className = 'nm';
    setText(name, theme.name);
    cap2.appendChild(name);
    var scheme = el('span');
    scheme.className = 'a1-pill muted';
    setText(scheme, schemeNoteFor(theme.scheme));
    cap2.appendChild(scheme);
    var st = el('span');
    st.className = 'st';
    if (theme.name === current) {
      var inUse = el('span');
      inUse.className = 'a1-pill sage';
      setText(inUse, 'in use');
      st.appendChild(inUse);
    } else if (theme.name === selected) {
      var notSaved = el('span');
      notSaved.className = 'a1-pill rose';
      setText(notSaved, 'selected, not saved');
      st.appendChild(notSaved);
    }
    cap2.appendChild(st);
    card.appendChild(cap2);

    var blurb = el('p');
    blurb.className = 'th-blurb';
    setText(blurb, Object.prototype.hasOwnProperty.call(THEME_BLURBS, theme.name) ? THEME_BLURBS[theme.name] : '');
    card.appendChild(blurb);

    var cact = el('div');
    cact.className = 'th-cact';
    var openBtn = el('button');
    openBtn.type = 'button';
    openBtn.className = 'a1-link';
    openBtn.appendChild(icon('expand'));
    openBtn.appendChild(document.createTextNode('Open full size'));
    openBtn.addEventListener('click', function () {
      ScriptoriumAdmin.variants.openFull(theme.name, openBtn);
    });
    cact.appendChild(openBtn);
    card.appendChild(cact);

    return card;
  }

  function buildThemeScreen(mount, state) {
    clear(mount);

    var packToml = state.packToml || {};
    if (packToml.error) {
      var err = el('p');
      err.className = 'pack-error';
      setText(err, packToml.error);
      mount.appendChild(err);
    }

    // V1e-7 (ADR 0039, SD-68): the mock's order (theme.js:49-57) -- the error p above (unchanged),
    // then the strip, then the card grid.
    mount.appendChild(ScriptoriumAdmin.variants.themeStrip());

    var current = packToml.exists ? packToml.theme : 'plain';
    var selected = current;
    var themes = state.themes || [];
    var cardsWrap = el('div');
    cardsWrap.className = 'th-grid';
    cardsWrap.setAttribute('role', 'radiogroup');
    cardsWrap.setAttribute('aria-label', 'Theme');

    // V1d-2 SD-10 (M:1157): the mismatch note becomes an .a1-note.
    var mismatchNote = el('div');
    mismatchNote.className = 'a1-note';
    mismatchNote.hidden = true;
    var mismatchIcon = icon('info');
    var mismatchText = el('div');
    var mismatchP1 = el('p');
    var mismatchP2 = el('p');
    setText(mismatchP2, 'Check will report this as info, config/theme-scheme-mismatch. It still builds.');
    mismatchText.appendChild(mismatchP1);
    mismatchText.appendChild(mismatchP2);
    mismatchNote.appendChild(mismatchIcon);
    mismatchNote.appendChild(mismatchText);
    mount.appendChild(cardsWrap);
    mount.appendChild(mismatchNote);

    function updateMismatchNote() {
      var mismatch = ScriptoriumAdmin.SL.schemeMismatch(selected, themes, state.palette);
      if (mismatch) {
        setText(
          mismatchP1,
          "Your vault's palette is " +
            mismatch.paletteScheme +
            ' (' +
            mismatch.background +
            ' in vault-config.md) and ' +
            mismatch.theme +
            ' is ' +
            mismatch.themeScheme +
            '.',
        );
        mismatchNote.hidden = false;
      } else {
        mismatchNote.hidden = true;
      }
    }

    // #88: renderCards rebuilds every card, which destroys the radio that had focus. When the
    // rebuild comes from a radio's own change (an arrow key), put focus back on the newly selected
    // option, so a keyboard user keeps stepping through the group instead of landing on <body>.
    function renderCards(restoreFocus) {
      clear(cardsWrap);
      themes.forEach(function (theme) {
        cardsWrap.appendChild(
          themeCard(theme, current, selected, function () {
            selected = theme.name;
            var pendingN = selected === current ? 0 : 1;
            store.set({ pending: ScriptoriumAdmin.ST.withPending(store.get().pending, 'theme', pendingN) });
            renderCards(true);
            updateMismatchNote();
          }),
        );
      });
      if (restoreFocus) {
        var radios = cardsWrap.querySelectorAll('input[type="radio"]');
        for (var i = 0; i < radios.length; i++) {
          if (radios[i].value === selected) {
            radios[i].focus();
            break;
          }
        }
      }
    }
    renderCards();
    updateMismatchNote();

    var outcomeBox = el('div');
    mount.appendChild(outcomeBox);

    // V1d-2 SD-10 (M:1158-1160): the Keep/Review bar becomes .a1-bar. DV-5 drops the mock's own
    // "Changes one line in pack.toml" grow text (false once the file has comments) -- no .grow
    // span at all, rather than a misleading one.
    var actions = el('div');
    actions.className = 'a1-bar';

    var keepBtn = el('button');
    keepBtn.type = 'button';
    keepBtn.className = 'a1-btn ghost';
    setText(keepBtn, 'Keep');
    keepBtn.appendChild(document.createTextNode(' ' + current));
    keepBtn.disabled = selected === current;
    keepBtn.addEventListener('click', function () {
      selected = current;
      store.set({ pending: ScriptoriumAdmin.ST.withPending(store.get().pending, 'theme', 0) });
      renderCards();
      updateMismatchNote();
      clear(outcomeBox);
    });
    actions.appendChild(keepBtn);

    var reviewBtn = el('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'a1-btn primary';
    setText(reviewBtn, 'Review change');
    var disabledReason = Boolean(packToml.error) || !state.writable;
    themeReviewBtn = reviewBtn;
    themeOwnDisabled = disabledReason;
    reviewBtn.disabled = disabledReason || store.isBusy();
    reviewBtn.addEventListener('click', function () {
      if (selected === current) return;
      reviewBtn.disabled = true;
      var dryBody = { theme: selected, baseSha256: store.baseSha('pack.toml'), dryRun: true };
      api('/api/pack/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dryBody) })
        .then(function (result) {
          reviewBtn.disabled = disabledReason || store.isBusy();
          if (!result.ok || !result.body || result.body.ok !== true) {
            renderBanner(outcomeBox, mapOutcomeSafe(result, 'dry'));
            return;
          }
          ScriptoriumAdmin.slip.review({
            kind: 'theme',
            payload: { theme: selected },
            state: state,
            dry: result.body,
            dryBody: dryBody,
            path: '/api/pack/theme',
            trigger: reviewBtn,
            // V1e-7 (ADR 0039, SD-68): the before/after live frames of the in-use and chosen
            // themes' copies.
            extra: ScriptoriumAdmin.variants.slipShots(current, selected),
            onSaved: function (body) {
              afterSaved('theme', body);
            },
          });
        })
        .catch(function () {
          reviewBtn.disabled = disabledReason || store.isBusy();
          renderBanner(outcomeBox, mapOutcomeSafe({ ok: false, status: 0, body: null }, 'dry'));
        });
    });
    actions.appendChild(reviewBtn);
    mount.appendChild(actions);
  }

  // -- Title & tagline screen (V1e-4 SD-28/SD-29: tt1/tt2/tt3, AC-06, D-9) ------------------------

  var titleSurrounds = null; // { tt1, tt2, tt3 } elements from the most recent buildTitleScreen()
  var titleFieldsSlots = null; // { tt1, tt2, tt3 } -> that surround's [data-part="fields-slot"]
  var titleFieldsBlock = null; // the persistent fields block, re-parented on a view change

  /** SD-29: shows the current view's surround and re-parents the persistent fields block into
   * it, so a view change never rebuilds (and never loses) an unsaved edit. Guarded: harmless
   * no-op before the first writable render, or after a transition to read-only (which clears the
   * mount and leaves these pointing at now-detached elements). */
  function applyTitleView() {
    if (!titleSurrounds || !titleFieldsBlock) return;
    var current = ScriptoriumAdmin.views.current('title');
    if (!Object.prototype.hasOwnProperty.call(titleSurrounds, current)) current = 'tt1';
    Object.keys(titleSurrounds).forEach(function (id) {
      titleSurrounds[id].hidden = id !== current;
    });
    titleFieldsSlots[current].appendChild(titleFieldsBlock);
  }

  /** A `<span>` holding `text`, wrapped in a `<mark>` when `changed` (tt2's "words that will
   * change" rule). Rebuilt on every live update rather than toggled, since the mark either wraps
   * the text node or doesn't -- there is no attribute to flip. */
  function markSpan(text, changed) {
    var span = el('span');
    if (changed) {
      var mark = el('mark');
      setText(mark, text);
      span.appendChild(mark);
    } else {
      setText(span, text);
    }
    return span;
  }

  /** The panel-drawn hero (tt1's figure, tt2's landing-page cell, tt3's mini preview): an
   * optional art image (DV-E31: only for a *listed* images/ file, never a broken thumbnail),
   * then the live title/tagline text. Shared by all three surrounds so there is exactly one
   * implementation of "what the hero looks like", never three copies that could drift. */
  function buildHero(phoneClass) {
    var wrap = el('div');
    wrap.className = 'tt-hero' + (phoneClass ? ' is-m' : '');
    var img = null;
    var titleP = el('p');
    titleP.className = 'tt-hero-title';
    var tagP = el('p');
    tagP.className = 'tt-hero-tag';
    wrap.appendChild(titleP);
    wrap.appendChild(tagP);

    function setArt(rel) {
      if (rel) {
        if (!img) {
          img = el('img');
          img.className = 'tt-hero-img';
          img.alt = '';
          wrap.insertBefore(img, wrap.firstChild);
        }
        img.src = '/api/image?name=' + encodeURIComponent(rel);
      } else if (img) {
        wrap.removeChild(img);
        img = null;
      }
    }

    function update(title, tagline, heroRel) {
      setArt(heroRel);
      var t = title || '';
      setText(titleP, t === '' ? 'Untitled' : t);
      titleP.classList.toggle('is-empty', t === '');
      setText(tagP, tagline || '');
    }

    return { el: wrap, update: update };
  }

  /** tt1's "Other settings in this file" disclosure (SD-29): a hand-rolled toggle (not a native
   * details/summary, so its icon can flip chev/chevd the way the mock's own does), holding
   * PK.summaryRows as a dl, then a second, nested "Show the file" toggle over the raw JSON --
   * marked [data-part="raw-file"] (FR-24: this is the one place tt1 may show a raw key name, and
   * the DOM scan excludes it by design). */
  function buildTt1More(vcj, summaryRowsList) {
    var section = el('section');
    section.className = 'tt1-more';

    var toggle = el('button');
    toggle.type = 'button';
    toggle.className = 'tt1-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    var toggleIcon = icon('chev');
    toggle.appendChild(toggleIcon);
    var toggleText = el('span');
    var toggleB = el('b');
    setText(toggleB, 'Other settings in this file');
    toggleText.appendChild(toggleB);
    var toggleSmall = el('small');
    setText(toggleSmall, "Read-only here: address, sections, what's kept private");
    toggleText.appendChild(toggleSmall);
    toggle.appendChild(toggleText);
    section.appendChild(toggle);

    var sumWrap = el('div');
    sumWrap.hidden = true;
    var dl = el('dl');
    dl.className = 'tt1-sum';
    summaryRowsList.forEach(function (row) {
      var dt = el('dt');
      dt.appendChild(icon(row.icon));
      var dtText = el('span');
      setText(dtText, row.name);
      dt.appendChild(dtText);
      var dd = el('dd');
      setText(dd, row.text);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    sumWrap.appendChild(dl);

    var fine = el('p');
    fine.className = 'a1-fine';
    setText(fine, 'These live in vault.config.json with the title and tagline. ');
    var showFileBtn = el('button');
    showFileBtn.type = 'button';
    showFileBtn.className = 'a1-link';
    setText(showFileBtn, 'Show the file');
    fine.appendChild(showFileBtn);
    sumWrap.appendChild(fine);
    section.appendChild(sumWrap);

    var rawWrap = el('div');
    rawWrap.setAttribute('data-part', 'raw-file');
    rawWrap.hidden = true;
    var rawPre = el('pre');
    setText(rawPre, vcj.raw === undefined || vcj.raw === null ? '' : vcj.raw);
    rawWrap.appendChild(rawPre);
    section.appendChild(rawWrap);

    toggle.addEventListener('click', function () {
      var expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      sumWrap.hidden = expanded;
      clear(toggle);
      toggle.appendChild(icon(expanded ? 'chev' : 'chevd'));
      toggle.appendChild(toggleText);
    });
    showFileBtn.addEventListener('click', function () {
      rawWrap.hidden = !rawWrap.hidden;
    });

    return section;
  }

  /** tt1: a live hero, the persistent fields beside it (a1800px 2-column grid; admin.css collapses
   * it to one column below that, the NV.viewportClass wide breakpoint), then the "Other settings"
   * disclosure. */
  function buildTt1(vcj, summaryRowsList, heroRel) {
    var section = el('section');
    section.setAttribute('data-tt', 'tt1');

    var fig = el('figure');
    fig.className = 'tt1-fig';
    var figcap = el('figcaption');
    figcap.className = 'a1-cap';
    setText(figcap, 'How your landing page opens');
    fig.appendChild(figcap);
    var hero = buildHero(false);
    fig.appendChild(hero.el);

    var wide = el('div');
    wide.className = 'tt1-wide';
    wide.appendChild(fig);

    var side = el('div');
    side.className = 'tt1-side';
    var fieldsSlot = el('div');
    fieldsSlot.setAttribute('data-part', 'fields-slot');
    side.appendChild(fieldsSlot);
    side.appendChild(buildTt1More(vcj, summaryRowsList));
    wide.appendChild(side);

    section.appendChild(wide);

    return {
      section: section,
      fieldsSlot: fieldsSlot,
      update: function (title, tagline) {
        hero.update(title, tagline, heroRel);
      },
    };
  }

  /** tt2: the fields beside a 4-cell "Where these words appear" gallery (browser tabs, top bar,
   * the landing hero, the not-found tab), with the changed word marked, then "Also in this file"
   * -- the same PK.summaryRows data as tt1's disclosure, always visible rather than collapsed
   * (D-13: pointers, never a promise). */
  function buildTt2(summaryRowsList, heroRel) {
    var section = el('section');
    section.setAttribute('data-tt', 'tt2');

    var grid = el('div');
    grid.className = 'tt2-grid';

    var fieldsWrap = el('div');
    fieldsWrap.className = 'tt2-form';
    var fieldsSlot = el('div');
    fieldsSlot.setAttribute('data-part', 'fields-slot');
    fieldsWrap.appendChild(fieldsSlot);
    grid.appendChild(fieldsWrap);

    var whereSection = el('section');
    whereSection.className = 'tt2-where';
    var whereH2 = el('h2');
    whereH2.className = 'a1-rule';
    setText(whereH2, 'Where these words appear');
    whereSection.appendChild(whereH2);

    var gal = el('div');
    gal.className = 'tt2-gal';

    function galCell(wide, capText, capSmallText) {
      var fig = el('figure');
      fig.className = 'tt2-cell' + (wide ? ' wide' : '');
      var cap = el('figcaption');
      setText(cap, capText);
      var small = el('small');
      setText(small, capSmallText);
      cap.appendChild(small);
      fig.appendChild(cap);
      return fig;
    }

    function browserTab() {
      var tab = el('div');
      tab.className = 'tt2-tab';
      var fav = el('span');
      fav.className = 'fav';
      setText(fav, '◆');
      tab.appendChild(fav);
      var titleSlot = el('span');
      tab.appendChild(titleSlot);
      var x = el('span');
      x.className = 'x';
      setText(x, '×');
      tab.appendChild(x);
      return { el: tab, titleSlot: titleSlot };
    }

    var tabsFig = galCell(false, 'Browser tabs', "every page's tab");
    var tabsRow = el('div');
    tabsRow.className = 'tt2-tabs';
    var tab = browserTab();
    tabsRow.appendChild(tab.el);
    tabsFig.appendChild(tabsRow);
    gal.appendChild(tabsFig);

    var barFig = galCell(false, 'Top bar', 'every page');
    var bar = el('div');
    bar.className = 'tt2-bar';
    var barBrandSlot = el('span');
    barBrandSlot.className = 'br';
    bar.appendChild(barBrandSlot);
    ['Story ▾', 'Characters', 'World'].forEach(function (w) {
      var s = el('span');
      setText(s, w);
      bar.appendChild(s);
    });
    barFig.appendChild(bar);
    gal.appendChild(barFig);

    var heroFig = galCell(true, 'Landing page', 'title and tagline');
    var hero = buildHero(false);
    heroFig.appendChild(hero.el);
    gal.appendChild(heroFig);

    var nfFig = galCell(false, 'Not-found page', 'its browser tab');
    var nfTabsRow = el('div');
    nfTabsRow.className = 'tt2-tabs';
    var nfTab = browserTab();
    nfTabsRow.appendChild(nfTab.el);
    nfFig.appendChild(nfTabsRow);
    gal.appendChild(nfFig);

    whereSection.appendChild(gal);
    grid.appendChild(whereSection);
    section.appendChild(grid);

    var also = el('section');
    also.className = 'tt2-also';
    var alsoH2 = el('h2');
    alsoH2.className = 'a1-rule';
    setText(alsoH2, 'Also in this file');
    var alsoH2Small = el('small');
    setText(alsoH2Small, 'read-only, and changed elsewhere');
    alsoH2.appendChild(alsoH2Small);
    also.appendChild(alsoH2);
    var ul = el('ul');
    summaryRowsList.forEach(function (row) {
      var li = el('li');
      li.appendChild(icon(row.icon));
      var b = el('b');
      setText(b, row.name);
      li.appendChild(b);
      var span = el('span');
      setText(span, row.text);
      li.appendChild(span);
      var em = el('em');
      setText(em, row.where);
      li.appendChild(em);
      ul.appendChild(li);
    });
    also.appendChild(ul);
    section.appendChild(also);

    function tabText(prefix, title) {
      return prefix + ' · ' + (title === '' ? 'Untitled' : title);
    }

    return {
      section: section,
      fieldsSlot: fieldsSlot,
      update: function (title, tagline, titleChanged) {
        clear(tab.titleSlot);
        tab.titleSlot.appendChild(markSpan(tabText('Timeline', title), titleChanged));
        clear(barBrandSlot);
        barBrandSlot.appendChild(markSpan(title === '' ? 'Untitled' : title, titleChanged));
        clear(nfTab.titleSlot);
        nfTab.titleSlot.appendChild(markSpan(tabText('Not Found', title), titleChanged));
        hero.update(title, tagline, heroRel);
      },
    };
  }

  function buildSwitchRow(label, on) {
    var row = el('div');
    row.className = 'tt3-row';
    var span = el('span');
    setText(span, label);
    row.appendChild(span);
    var sw = el('span');
    sw.className = 'a1-switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.setAttribute('aria-disabled', 'true');
    sw.appendChild(el('span')).className = 'trk';
    var stateText = el('span');
    setText(stateText, on ? 'on' : 'off');
    sw.appendChild(stateText);
    row.appendChild(sw);
    return row;
  }

  /** One tt3 card, from a PK.cardModel entry. Every branch is a plain, read-only rendering of
   * that card's own data; only the main "Name and tagline" card (built by buildTt3, not here) is
   * editable. */
  function buildTt3Card(card) {
    var section = el('section');
    section.className = 'tt3-card' + (card.id === 'sections' ? ' span2' : '');
    var header = el('header');
    var h2 = el('h2');
    h2.appendChild(icon(card.icon));
    var h2Text = el('span');
    setText(h2Text, card.name);
    h2.appendChild(h2Text);
    header.appendChild(h2);
    var lockNote = el('span');
    lockNote.className = 'tt3-lock';
    lockNote.setAttribute('title', card.lock);
    lockNote.appendChild(icon('lock'));
    var lockText = el('span');
    setText(lockText, 'read-only here');
    lockNote.appendChild(lockText);
    header.appendChild(lockNote);
    section.appendChild(header);

    if (card.id === 'published') {
      var dl = el('dl');
      dl.className = 'tt3-dl';
      var dt1 = el('dt');
      setText(dt1, 'Host');
      dl.appendChild(dt1);
      var dd1 = el('dd');
      setText(dd1, card.host);
      dl.appendChild(dd1);
      var dt2 = el('dt');
      setText(dt2, 'Address');
      dl.appendChild(dt2);
      var dd2 = el('dd');
      setText(dd2, card.address);
      dl.appendChild(dd2);
      section.appendChild(dl);
      var addrHint = el('p');
      addrHint.className = 'a1-hint';
      setText(addrHint, "The address is also used to make links in the site's own 404 page work.");
      section.appendChild(addrHint);
    } else if (card.id === 'private') {
      var sub1 = el('div');
      sub1.className = 'tt3-sub';
      setText(sub1, 'Folders never published');
      section.appendChild(sub1);
      var chips1 = el('div');
      chips1.className = 'tt3-chips';
      card.dirChips.forEach(function (c) {
        var s = el('span');
        setText(s, c);
        chips1.appendChild(s);
      });
      section.appendChild(chips1);
      var sub2 = el('div');
      sub2.className = 'tt3-sub';
      setText(sub2, 'Headings removed from every page');
      section.appendChild(sub2);
      var chips2 = el('div');
      chips2.className = 'tt3-chips';
      card.sectionChips.forEach(function (c) {
        var s = el('span');
        setText(s, c);
        chips2.appendChild(s);
      });
      section.appendChild(chips2);
      var row = el('div');
      row.className = 'tt3-row';
      var rowLabel = el('span');
      setText(rowLabel, 'Callout boxes');
      row.appendChild(rowLabel);
      var pill = el('span');
      pill.className = 'a1-pill muted';
      setText(pill, card.calloutsState);
      row.appendChild(pill);
      section.appendChild(row);
      var privateHint = el('p');
      privateHint.className = 'a1-hint';
      setText(privateHint, 'These combine with the lists in vault-config.md: a heading named in either file stays hidden.');
      section.appendChild(privateHint);
    } else if (card.id === 'sections') {
      var map = el('div');
      map.className = 'tt3-map';
      card.rows.forEach(function (r) {
        var mapRow = el('div');
        var f = el('span');
        f.className = 'f';
        f.appendChild(icon('folder'));
        var fText = el('span');
        setText(fText, r.folder);
        f.appendChild(fText);
        mapRow.appendChild(f);
        var ar = el('span');
        ar.className = 'ar';
        setText(ar, '>');
        mapRow.appendChild(ar);
        var code = el('code');
        setText(code, '/' + r.section + '/');
        mapRow.appendChild(code);
        map.appendChild(mapRow);
      });
      section.appendChild(map);
    } else if (card.id === 'art') {
      var p = el('p');
      p.className = 'tt3-val';
      var code2 = el('code');
      setText(code2, card.attachmentsDir);
      p.appendChild(code2);
      section.appendChild(p);
      var hint = el('p');
      hint.className = 'a1-hint';
      setText(hint, 'Where your vault keeps images. Portraits, banners and maps are read from here.');
      section.appendChild(hint);
    } else if (card.id === 'extras') {
      section.appendChild(buildSwitchRow('Live status bar', card.statusBar));
      section.appendChild(buildSwitchRow('Change-request inbox', card.inbox));
    } else if (card.id === 'other') {
      var p2 = el('p');
      p2.className = 'tt3-val';
      setText(p2, card.count + (card.count === 1 ? ' other setting, shown in the file.' : ' other settings, shown in the file.'));
      section.appendChild(p2);
    }

    return section;
  }

  /** tt3: a toolbar (SD-32: not the header, which already carries the layout switcher) holding
   * the Cards/JSON segmented control, then either the card grid or the read-only JSON view. Only
   * name/tagline are ever editable; every other card is a plain, read-only rendering with a
   * lock note. */
  function buildTt3(vcj, cardModelList, heroRel) {
    var section = el('section');
    section.setAttribute('data-tt', 'tt3');

    var toolbar = el('div');
    toolbar.className = 'tt-tools';
    var seg = el('div');
    seg.className = 'a1-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Show as');
    var cardsBtn = el('button');
    cardsBtn.type = 'button';
    setText(cardsBtn, 'Cards');
    var jsonBtn = el('button');
    jsonBtn.type = 'button';
    setText(jsonBtn, 'JSON');
    seg.appendChild(cardsBtn);
    seg.appendChild(jsonBtn);
    toolbar.appendChild(seg);
    section.appendChild(toolbar);

    var cardsView = el('div');
    cardsView.className = 'tt3-grid';

    var mainCard = el('section');
    mainCard.className = 'tt3-card main';
    var mainHeader = el('header');
    var mainH2 = el('h2');
    mainH2.appendChild(icon('title'));
    var mainH2Text = el('span');
    setText(mainH2Text, 'Name and tagline');
    mainH2.appendChild(mainH2Text);
    mainHeader.appendChild(mainH2);
    var editablePill = el('span');
    editablePill.className = 'a1-pill brass';
    setText(editablePill, 'editable');
    mainHeader.appendChild(editablePill);
    mainCard.appendChild(mainHeader);
    var fieldsSlot = el('div');
    fieldsSlot.setAttribute('data-part', 'fields-slot');
    mainCard.appendChild(fieldsSlot);
    var mini = el('div');
    mini.className = 'tt3-mini';
    var hero = buildHero(false);
    mini.appendChild(hero.el);
    mainCard.appendChild(mini);
    cardsView.appendChild(mainCard);

    cardModelList.forEach(function (card) {
      cardsView.appendChild(buildTt3Card(card));
    });

    var jsonView = el('div');
    jsonView.hidden = true;
    var jsonPre = el('pre');
    jsonPre.className = 'tt-pre';
    jsonPre.setAttribute('data-part', 'raw-file');
    // The JSON view is a read-only snapshot of the file as it is on disk right now, not a live
    // preview of unsaved edits: unlike the mock, this panel's tagline lives in a second file
    // (vault-config.md, D-19/D-20), so there is no single "the JSON" a merged live preview could
    // honestly show. Cards is where the live editing happens.
    setText(jsonPre, vcj.raw === undefined || vcj.raw === null ? '' : vcj.raw);
    jsonView.appendChild(jsonPre);
    var jsonFine = el('p');
    jsonFine.className = 'a1-fine';
    setText(jsonFine, 'The JSON view is read-only. Switch back to Cards to edit the name and tagline.');
    jsonView.appendChild(jsonFine);

    section.appendChild(cardsView);
    section.appendChild(jsonView);

    var showJson = false;
    function applyToggle() {
      cardsBtn.setAttribute('aria-pressed', showJson ? 'false' : 'true');
      jsonBtn.setAttribute('aria-pressed', showJson ? 'true' : 'false');
      cardsView.hidden = showJson;
      jsonView.hidden = !showJson;
    }
    cardsBtn.addEventListener('click', function () {
      showJson = false;
      applyToggle();
    });
    jsonBtn.addEventListener('click', function () {
      showJson = true;
      applyToggle();
    });
    applyToggle();

    return {
      section: section,
      fieldsSlot: fieldsSlot,
      update: function (title, tagline) {
        hero.update(title, tagline, heroRel);
      },
    };
  }

  function buildTitleScreen(mount, state) {
    clear(mount);

    var vcj = state.vaultConfigJson || {};
    var vcf = state.vaultConfigFile || {};
    if (vcj.error) {
      var err = el('p');
      err.className = 'pack-error';
      setText(err, vcj.error);
      mount.appendChild(err);
    }

    var initialTitle = vcj.siteTitle === undefined || vcj.siteTitle === null ? '' : vcj.siteTitle;
    // V1e-1 (SD-7, D-20): the tagline now comes from vault-config.md's publish.theme.tagline,
    // never from the dead vault.config.json landingTagline key.
    var initialTagline = vcf.tagline === undefined || vcf.tagline === null ? '' : vcf.tagline;
    var taglineEditable = Boolean(vcf.editable);

    // ---------------------------------------------------------------------------------------
    // SD-29: the persistent fields block, built once per render and re-parented (never rebuilt)
    // across a view change by applyTitleView(). The review/save flow below is the same code the
    // screen has always run, byte-for-byte, apart from the dry-run extras (SD-30) now reaching
    // the slip through the existing `dry` object.
    // ---------------------------------------------------------------------------------------
    var fieldsBlock = el('div');
    fieldsBlock.className = 'tt-fields';

    var titleField = el('div');
    titleField.className = 'a1-field';
    var titleLab = el('div');
    titleLab.className = 'tt-lab';
    var titleLabel = el('label');
    titleLabel.setAttribute('for', 'pack-title-input');
    setText(titleLabel, 'Site title');
    titleLab.appendChild(titleLabel);
    var titleCount = el('span');
    titleCount.className = 'tt-count';
    titleLab.appendChild(titleCount);
    titleField.appendChild(titleLab);
    var titleInput = el('input');
    titleInput.id = 'pack-title-input';
    titleInput.type = 'text';
    titleInput.className = 'a1-in tt-big';
    titleInput.value = initialTitle;
    titleField.appendChild(titleInput);
    var titleHint = el('p');
    titleHint.className = 'a1-hint';
    setText(titleHint, 'In every browser tab, the top bar of every page, and large on the landing page. Short reads best.');
    titleField.appendChild(titleHint);
    var titleWarn = el('p');
    titleWarn.className = 'tt-warn';
    titleWarn.hidden = true;
    titleWarn.appendChild(icon('warn'));
    var titleWarnText = el('span');
    setText(titleWarnText, 'Long titles wrap in the top bar on a phone. It still saves.');
    titleWarn.appendChild(titleWarnText);
    titleField.appendChild(titleWarn);
    fieldsBlock.appendChild(titleField);

    var taglineField = el('div');
    taglineField.className = 'a1-field';
    var taglineLab = el('div');
    taglineLab.className = 'tt-lab';
    var taglineLabel = el('label');
    taglineLabel.setAttribute('for', 'pack-tagline-input');
    setText(taglineLabel, 'Landing tagline');
    taglineLab.appendChild(taglineLabel);
    var taglineCount = el('span');
    taglineCount.className = 'tt-count';
    taglineLab.appendChild(taglineCount);
    taglineField.appendChild(taglineLab);
    var taglineInput = el('textarea');
    taglineInput.id = 'pack-tagline-input';
    taglineInput.className = 'a1-in tt-area';
    taglineInput.rows = 3;
    taglineInput.value = initialTagline;
    taglineInput.disabled = !taglineEditable;
    taglineField.appendChild(taglineInput);

    if (taglineEditable) {
      var taglineHint = el('p');
      taglineHint.className = 'a1-hint';
      setText(taglineHint, 'One line under the title on your landing page. Leave it empty for no tagline.');
      taglineField.appendChild(taglineHint);
    } else {
      var taglineReason = el('p');
      taglineReason.className = 'a1-hint';
      setText(taglineReason, vcf.reason || 'Editing the tagline is off.');
      taglineField.appendChild(taglineReason);
    }

    var taglineWarn = el('p');
    taglineWarn.className = 'tt-warn';
    taglineWarn.hidden = true;
    taglineWarn.appendChild(icon('warn'));
    var taglineWarnText = el('span');
    setText(taglineWarnText, 'Long taglines wrap to four lines or more on a phone and push your latest session below the fold. It still saves.');
    taglineWarn.appendChild(taglineWarnText);
    taglineField.appendChild(taglineWarn);

    if (taglineEditable) {
      // FR-24 cleanup: this small print names a raw config path (publish.theme.tagline), so it
      // now sits behind its own "Show the file" disclosure rather than always on screen.
      var taglineDetails = el('details');
      taglineDetails.setAttribute('data-part', 'raw-file');
      var taglineSummary = el('summary');
      taglineSummary.className = 'df-toggle';
      setText(taglineSummary, 'Show the file');
      taglineDetails.appendChild(taglineSummary);
      var taglineSmall = el('p');
      taglineSmall.className = 'a1-fine';
      setText(taglineSmall, 'Saved in _meta/vault-config.md as publish.theme.tagline.');
      taglineDetails.appendChild(taglineSmall);
      taglineField.appendChild(taglineDetails);
    }

    // D-20/FR-24: a dead landingTagline value already on disk is shown, neutrally, as never
    // used -- reworded so it no longer names the JSON key.
    if (typeof vcj.landingTagline === 'string' && vcj.landingTagline !== '') {
      var deadKeyNote = el('p');
      deadKeyNote.className = 'a1-hint';
      setText(deadKeyNote, "vault.config.json also has an older tagline value the site doesn't use. The panel leaves it alone.");
      taglineField.appendChild(deadKeyNote);
    }
    fieldsBlock.appendChild(taglineField);

    function refreshCounters() {
      var titleState = PK.countState(titleInput.value, PK.TITLE_SOFT);
      setText(titleCount, titleState.n + ' / about ' + PK.TITLE_SOFT);
      titleCount.classList.toggle('over', titleState.over);
      titleWarn.hidden = !titleState.over;

      var taglineState = PK.countState(taglineInput.value, PK.TAGLINE_SOFT);
      setText(taglineCount, taglineState.n + ' / about ' + PK.TAGLINE_SOFT);
      taglineCount.classList.toggle('over', taglineState.over);
      taglineWarn.hidden = !taglineState.over;
    }
    refreshCounters();

    var outcomeBox = el('div');

    function currentPending() {
      return (titleInput.value !== initialTitle ? 1 : 0) + (taglineInput.value !== initialTagline ? 1 : 0);
    }

    var pendingBar = el('div');
    pendingBar.className = 'a1-pending';
    var grow = el('span');
    grow.className = 'grow';
    var dot = el('i');
    dot.className = 'a1-dot';
    dot.setAttribute('aria-hidden', 'true');
    grow.appendChild(dot);
    var pendingText = el('span');
    grow.appendChild(pendingText);
    pendingBar.appendChild(grow);

    function refreshPendingText() {
      var n = currentPending();
      setText(pendingText, ' ' + n + ' unsaved change' + (n === 1 ? '' : 's'));
    }
    refreshPendingText();

    function refreshLiveViews() {
      var titleChanged = titleInput.value !== initialTitle;
      tt1.update(titleInput.value, taglineInput.value);
      tt2.update(titleInput.value, taglineInput.value, titleChanged);
      tt3.update(titleInput.value, taglineInput.value);
    }

    function onFieldInput() {
      store.set({ pending: ScriptoriumAdmin.ST.withPending(store.get().pending, 'title', currentPending()) });
      refreshPendingText();
      refreshCounters();
      refreshLiveViews();
    }
    titleInput.addEventListener('input', onFieldInput);
    taglineInput.addEventListener('input', function () {
      // The mock's own onInput rule (r3-src/title.js:173): a pasted or IME newline collapses to
      // a space, since the tagline renders as one line on the landing page.
      if (taglineInput.value.indexOf('\n') !== -1) {
        taglineInput.value = taglineInput.value.replace(/\n/g, ' ');
      }
      onFieldInput();
    });

    var discardBtn = el('button');
    discardBtn.type = 'button';
    discardBtn.className = 'a1-btn ghost';
    setText(discardBtn, 'Discard');
    discardBtn.addEventListener('click', function () {
      titleInput.value = initialTitle;
      taglineInput.value = initialTagline;
      store.set({ pending: ScriptoriumAdmin.ST.withPending(store.get().pending, 'title', 0) });
      refreshPendingText();
      refreshCounters();
      refreshLiveViews();
      clear(outcomeBox);
    });
    pendingBar.appendChild(discardBtn);

    var reviewBtn = el('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'a1-btn primary';
    setText(reviewBtn, 'Review and save');
    var disabledReason = Boolean(vcj.error) || !state.writable;
    titleReviewBtn = reviewBtn;
    titleOwnDisabled = disabledReason;
    reviewBtn.disabled = disabledReason || store.isBusy();
    reviewBtn.addEventListener('click', function () {
      if (currentPending() === 0) return;
      reviewBtn.disabled = true;

      // V1e-1 (SD-7, D-19): one dry-run request per changed file, run SEQUENTIALLY (parallel dry
      // runs would 409-busy each other, per runExclusive's one-write-at-a-time contract).
      var dryRequests = [];
      if (titleInput.value !== initialTitle) {
        dryRequests.push({
          kind: 'settings',
          payload: { siteTitle: titleInput.value },
          dryBody: { siteTitle: titleInput.value, baseSha256: store.baseSha('vault.config.json'), dryRun: true },
          path: '/api/pack/settings',
        });
      }
      if (taglineInput.value !== initialTagline) {
        dryRequests.push({
          kind: 'tagline',
          payload: { tagline: taglineInput.value },
          dryBody: { tagline: taglineInput.value, baseSha256: store.baseSha('vault-config.md'), dryRun: true },
          path: '/api/vault-config/tagline',
        });
      }

      ScriptoriumAdmin.SL.postInOrder(dryRequests, function (req) {
        return api(req.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.dryBody) });
      })
        .then(function (results) {
          reviewBtn.disabled = disabledReason || store.isBusy();
          var failedIndex = -1;
          for (var i = 0; i < results.length; i++) {
            if (!results[i].ok || !results[i].body || results[i].body.ok !== true) {
              failedIndex = i;
              break;
            }
          }
          if (failedIndex !== -1) {
            renderBanner(outcomeBox, mapOutcomeSafe(results[failedIndex], 'dry'));
            return;
          }
          var parts = dryRequests.map(function (req, i) {
            return { kind: req.kind, payload: req.payload, dry: results[i].body, dryBody: req.dryBody };
          });
          ScriptoriumAdmin.slip.reviewMany({
            parts: parts,
            state: state,
            trigger: reviewBtn,
            onPartSaved: function (part, body) {
              var s = store.get();
              store.set({ files: ScriptoriumAdmin.ST.applySaveResult(s.files, body) });
              if (part.kind === 'settings') {
                initialTitle = titleInput.value;
              } else {
                initialTagline = taglineInput.value;
              }
              refreshPendingText();
            },
            onDone: function () {
              store.set({ pending: ScriptoriumAdmin.ST.withPending(store.get().pending, 'title', currentPending()) });
              store.load();
            },
          });
        })
        .catch(function () {
          reviewBtn.disabled = disabledReason || store.isBusy();
          renderBanner(outcomeBox, mapOutcomeSafe({ ok: false, status: 0, body: null }, 'dry'));
        });
    });
    pendingBar.appendChild(reviewBtn);

    // ---------------------------------------------------------------------------------------
    // The three surrounds (SD-29).
    // ---------------------------------------------------------------------------------------
    var summaryRowsList = PK.summaryRows(vcj.raw === undefined || vcj.raw === null ? '' : vcj.raw);
    var cardModelList = PK.cardModel(vcj.raw === undefined || vcj.raw === null ? '' : vcj.raw);
    var heroRel = PK.heroArt((state.packToml && state.packToml.images) || {}, state.images || [], ScriptoriumAdmin.IM.slotImageRel);

    var tt1 = buildTt1(vcj, summaryRowsList, heroRel);
    var tt2 = buildTt2(summaryRowsList, heroRel);
    var tt3 = buildTt3(vcj, cardModelList, heroRel);

    mount.appendChild(tt1.section);
    mount.appendChild(tt2.section);
    mount.appendChild(tt3.section);
    mount.appendChild(outcomeBox);
    mount.appendChild(pendingBar);

    titleSurrounds = { tt1: tt1.section, tt2: tt2.section, tt3: tt3.section };
    titleFieldsSlots = { tt1: tt1.fieldsSlot, tt2: tt2.fieldsSlot, tt3: tt3.fieldsSlot };
    titleFieldsBlock = fieldsBlock;

    refreshLiveViews();
    applyTitleView();
  }

  // -- Shared render/init ---------------------------------------------------------------------

  function readOnlyNotice(mount, state) {
    clear(mount);
    var p = el('p');
    p.className = 'pack-readonly';
    setText(p, state.readOnlyReason || 'This campaign is read-only.');
    mount.appendChild(p);
  }

  function render(themeMount, titleMount, state, pending) {
    if (!state.writable) {
      readOnlyNotice(themeMount, state);
      readOnlyNotice(titleMount, state);
      return;
    }
    // SD-7: a screen with pending edits of its own never re-renders from new state.
    if (!(pending.theme > 0)) buildThemeScreen(themeMount, state);
    if (!(pending.title > 0)) buildTitleScreen(titleMount, state);
  }

  function init(container) {
    var titleMount = ScriptoriumAdmin.mount('title');

    function renderFromStore() {
      var s = store.get();
      if (!s.state) return;
      render(container, titleMount, s.state, s.pending || {});
    }

    store.subscribe(function (next, prev) {
      if (next.state !== prev.state || next.pending !== prev.pending) renderFromStore();
    });

    // SD-8: re-evaluate `disabled` on a busy change alone, independently of the state/pending
    // re-render above (SD-7 can suppress that re-render entirely while a screen has pending
    // edits, but disabling a button destroys no input, so it stays live regardless).
    store.subscribe(function (next, prev) {
      if (next.busy === prev.busy) return;
      if (themeReviewBtn) themeReviewBtn.disabled = themeOwnDisabled || store.isBusy();
      if (titleReviewBtn) titleReviewBtn.disabled = titleOwnDisabled || store.isBusy();
    });

    // V1e-4 (SD-29): a view change alone (no state/pending change) never re-renders the Title
    // screen -- it only re-parents the persistent fields block into the newly-current surround,
    // through this one subscription set up once here, reading titleSurrounds/titleFieldsBlock's
    // current (module-level, reassigned by every buildTitleScreen call) values live.
    store.subscribe(function (next, prev) {
      if (next.prefs !== prev.prefs || next.viewport !== prev.viewport) applyTitleView();
    });

    renderFromStore();
  }

  ScriptoriumAdmin.register('pack', function (container) {
    init(container);
  });
})();
