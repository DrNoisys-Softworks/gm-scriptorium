'use strict';

/*
 * Panel v2 V1c (FR-06, FR-14, FR-15, FR-16, FR-17, FR-20). views.js is rebuilt in place (SD-1):
 * it owns Overview, Check, Preview and vault-config.md, reading from the store (never its own
 * /api/state fetch) and calling store.load() after a preview build. VW is the pure half (the VB
 * pattern, vocab.js:20-108), above the node module.exports guard; the browser half -- the four
 * screens' DOM, wired to store.subscribe and store.isBusy() the same way pack.js/vocab.js/
 * images.js already are -- follows the guard. Every string is written with setText()
 * (textContent), never markup (FR12/risk area 4): finding messages, paths, vault-config.md text
 * and the site title are all vault-derived and go through textContent only.
 *
 * C1 stub: VW's shape is present with placeholder bodies (obviously wrong constants, not
 * crashes) so test/admin-views-model.test.js can go red against real assertions in C2, then the
 * pure implementations land there. The browser half below is still the V1a/V1b legacy code
 * unchanged; C3 replaces it with the real four-screen DOM.
 */
(function () {
  // -- VW: pure (SD-1, interfaces) --------------------------------------------------------------

  // outcome.js loads before views.js in script order (index.html), so this top-level capture is
  // safe in the browser too -- the same pattern slip.js uses for DF (slip.js:12). IM/SLOT_NAMES
  // are deliberately NOT captured here: images.js loads AFTER views.js, so a top-level
  // window.ScriptoriumAdmin.IM read at parse time would be undefined forever (app.js's own "read
  // ScriptoriumAdmin lazily" note). slotCells takes relFn injected instead (interfaces: "the
  // browser passes ScriptoriumAdmin.IM.slotImageRel", read at call time, well after boot); its
  // own SLOT_NAMES-order literal is independent, with a drift test against images.js's real copy.
  var OC = typeof module === 'object' && module.exports ? require('./outcome').OC : window.ScriptoriumAdmin.OC;

  // Independent literal, matching images.js:13's SLOT_NAMES exactly (drift-tested, not required
  // from images.js, precisely so this pure section has no load-order dependency on it).
  var SLOT_NAMES = ['hero', 'ground', 'paper', 'crest-frame', 'portrait', '404'];

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** Local HH:MM, or '' for an invalid/missing input. Never throws. */
  function timeOf(iso) {
    if (typeof iso !== 'string' || iso === '') return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /**
   * SD-4/interfaces. Engineer-interpreted residual: "N errors · N warnings" is the brief's own
   * literal template (no singular/plural distinction pinned), so it is reproduced as-is rather
   * than invented; the same for "N info · HH:MM" in `meta`.
   */
  function billCheck(lastCheck) {
    if (!lastCheck) return { text: 'Not run in this tab yet', meta: '' };
    var counts = lastCheck.counts || { error: 0, warn: 0, info: 0 };
    var text = counts.error + counts.warn === 0 ? 'Clean' : counts.error + ' errors · ' + counts.warn + ' warnings';
    // V1d-1 SD-9: the mock (M:1136) shows all three counts in the meta line, even when text
    // already says "Clean" -- the text itself is unchanged.
    var meta = counts.error + ' errors · ' + counts.warn + ' warnings · ' + counts.info + ' info · ' + timeOf(lastCheck.generatedAt);
    return { text: text, meta: meta };
  }

  /**
   * SD-4/interfaces. "This tab's build" is identified by `lastPreview` carrying a numeric
   * pagesWritten -- a refusal (SD-4's shape always has `pagesWritten: null` on a refusal, per
   * src/cli/build.js:154,201,233) never counts as "this tab's build" for the Overview bill, and
   * falls through to `previewBuilt` (the server-reported preview.built flag) instead.
   */
  function billPreview(lastPreview, previewBuilt) {
    if (lastPreview && typeof lastPreview.pagesWritten === 'number') {
      return { text: lastPreview.pagesWritten + ' files', meta: 'built ' + timeOf(lastPreview.generatedAt), showLink: true };
    }
    if (previewBuilt) {
      return { text: 'A preview is built', meta: '', showLink: true };
    }
    return { text: 'Not run in this tab yet', meta: '', showLink: false };
  }

  /**
   * SD-6: a non-(200 envelope)/(200 error) response (409 busy, a network abort, or anything
   * else) delegates to OC.mapOutcome for its message, so the busy/unreachable/unexpected-status
   * text has exactly one source of truth across the whole panel. Never throws.
   */
  function checkOutcome(result) {
    var body = result && result.body;
    if (result && result.status === 200 && body && body.envelope) {
      return { kind: 'ok', counts: body.envelope.counts, findings: body.envelope.findings, generatedAt: body.envelope.generatedAt, message: undefined };
    }
    if (result && result.status === 200 && body && body.error !== undefined) {
      return { kind: 'error', counts: null, findings: [], generatedAt: null, message: body.error };
    }
    var oc = OC.mapOutcome(result, 'save');
    return { kind: oc.kind === 'busy' ? 'busy' : 'unknown', counts: null, findings: [], generatedAt: null, message: oc.message };
  }

  /**
   * SD-6/interfaces. envelope.refusedByScan is checked BEFORE the generic envelope.refused
   * branch (M6): a scan refusal is also a `refused: true` envelope, so checking `refused` alone
   * would misclassify it as `refused-check` and read the (on a scan refusal, unrelated)
   * check.findings instead of outputScanFindings.
   */
  function previewOutcome(result) {
    var body = result && result.body;
    if (result && result.status === 200 && body && body.envelope) {
      var env = body.envelope;
      if (env.ok === true) {
        return { kind: 'built', pagesWritten: env.pagesWritten, generatedAt: env.generatedAt, findings: [], human: body.human, message: undefined };
      }
      if (env.refusedByScan === true) {
        return {
          kind: 'refused-scan',
          pagesWritten: env.pagesWritten,
          generatedAt: env.generatedAt,
          findings: env.outputScanFindings || [],
          human: body.human,
          message: env.error,
        };
      }
      if (env.refused === true) {
        return {
          kind: 'refused-check',
          pagesWritten: env.pagesWritten,
          generatedAt: env.generatedAt,
          findings: (env.check && env.check.findings) || [],
          human: body.human,
          message: env.error,
        };
      }
      return { kind: 'failed', pagesWritten: env.pagesWritten, generatedAt: env.generatedAt, findings: [], human: body.human, message: env.error };
    }
    if (result && result.status === 200 && body && body.error !== undefined) {
      return { kind: 'error', pagesWritten: null, generatedAt: null, findings: [], human: undefined, message: body.error };
    }
    var oc = OC.mapOutcome(result, 'save');
    return { kind: oc.kind === 'busy' ? 'busy' : 'unknown', pagesWritten: null, generatedAt: null, findings: [], human: undefined, message: oc.message };
  }

  /** A finding row per interfaces: {severity, id, path, message}, defaulting a missing path. */
  function findingRows(findings) {
    return (findings || []).map(function (f) {
      return { severity: f.severity, id: f.id, path: f.path || '', message: f.message };
    });
  }

  function countWord(n, singular, plural) {
    return n + ' ' + (n === 1 ? singular : plural);
  }

  /**
   * Interfaces: "mechanical text from custom label count, custom kind count or 'built-in
   * kinds'". Engineer-interpreted residual (no literal text pinned beyond that description,
   * CLAUDE.md's testing-standards precedent): custom label count always shows as a count; the
   * kinds half shows a count only when [timeline] declares a kinds array on disk, else the fixed
   * "built-in kinds" phrase (mirrors VB.tabCounts' own on-disk-else-default rule, vocab.js:177).
   */
  function wordsSummary(vocab) {
    var tables = (vocab && vocab.tables) || null;
    var labels = (tables && tables.labels) || null;
    var labelCount = labels ? Object.keys(labels).length : 0;
    var timeline = (tables && tables.timeline) || null;
    var kinds = timeline && Array.isArray(timeline.kinds) ? timeline.kinds : null;
    var labelText = countWord(labelCount, 'custom label', 'custom labels');
    var kindText = kinds ? countWord(kinds.length, 'custom kind', 'custom kinds') : 'built-in kinds';
    return labelText + ', ' + kindText;
  }

  /**
   * Interfaces: six {slot, kind, rel, value} cells in SLOT_NAMES order. `relFn` is injected
   * (risk area 5/6: the browser passes ScriptoriumAdmin.IM.slotImageRel, read lazily at render
   * time -- see the top-of-file note on why IM itself is never captured here). A falsy value is
   * 'empty'; otherwise relFn decides 'thumb' (a listed images/ file) vs 'path' (anything else,
   * including a vault: value, an unlisted images/ file, or a string-prefix/ancestor-direction
   * near-miss like 'imagesx/x.png' or 'images/../pack.toml' -- M1).
   */
  function slotCells(state, relFn) {
    var images = (state.packToml && state.packToml.images) || {};
    return SLOT_NAMES.map(function (slot) {
      var value = Object.prototype.hasOwnProperty.call(images, slot) ? images[slot] : '';
      if (!value) return { slot: slot, kind: 'empty', rel: null, value: value || '' };
      var rel = relFn(value, state.images || []);
      if (rel !== null) return { slot: slot, kind: 'thumb', rel: rel, value: value };
      return { slot: slot, kind: 'path', rel: null, value: value };
    });
  }

  // V1d-1 SD-9. NUMBER_WORDS is an independent literal ("one" to "ten"); anything outside that
  // range renders as digits.
  var NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

  function numberWord(n) {
    if (typeof n === 'number' && n >= 0 && n <= 10 && Math.floor(n) === n) return NUMBER_WORDS[n];
    return String(n);
  }

  // Independent literal, matching src/build/labels.js's DEFAULT_KINDS.length (5) exactly --
  // SLOT_NAMES above takes the same "independent literal, drift risk noted" approach rather than
  // requiring a src/ module into this browser-loadable file. Used only when the vocab payload
  // supplies no defaults fixture of its own (the real server response always does, per
  // vocab.js:435's own `vocab.defaults || {...}` fallback pattern).
  var DEFAULT_KINDS_COUNT = 5;

  /**
   * SD-9/interfaces. `quoted` is at most 3 label VALUES (not keys), in tables.labels insertion
   * order (Object.keys() order for string keys, which is the sequence the labels were parsed in).
   * kindsOwn mirrors vocab.js:602's on-disk-else-defaults split: true only when
   * tables.timeline.kinds is a real array on disk. kindsCount reads the on-disk length when
   * kindsOwn, else the vocab payload's own defaults.timeline.kinds length (vocab.js:435's
   * pattern), else the DEFAULT_KINDS_COUNT literal as a last resort (a payload that omits
   * defaults entirely never reaches the panel in practice, but wordsParts must never throw).
   */
  function wordsParts(vocab) {
    var v = vocab || {};
    var tables = v.tables || {};
    var labels = tables.labels || {};
    var labelKeys = Object.keys(labels);
    var quoted = labelKeys.slice(0, 3).map(function (k) {
      return labels[k];
    });
    var timeline = tables.timeline || {};
    var onDiskKinds = Array.isArray(timeline.kinds) ? timeline.kinds : null;
    var defaults = v.defaults || {};
    var defaultKinds = defaults.timeline && Array.isArray(defaults.timeline.kinds) ? defaults.timeline.kinds : null;
    var kindsOwn = onDiskKinds !== null;
    var kindsCount = kindsOwn ? onDiskKinds.length : defaultKinds ? defaultKinds.length : DEFAULT_KINDS_COUNT;
    return { labelCount: labelKeys.length, quoted: quoted, more: labelKeys.length > 3, kindsOwn: kindsOwn, kindsCount: kindsCount };
  }

  /**
   * SD-9/interfaces. Exact-name equality (M6/F6: never a string-prefix check -- "plainer" must
   * never be treated as a match for "plain"). `themeNames` is an array of plain theme-name
   * strings; the browser call site passes state.themes.map(t => t.name).
   */
  function themeNudge(themeNames, current) {
    var others = (themeNames || []).filter(function (name) {
      return name !== current;
    });
    if (others.length === 0) return null;
    if (others.length === 1) return { text: 'Try ' + others[0] };
    return { text: 'Change theme' };
  }

  /** SD-9/interfaces. F7: the LAST slash, not the first -- 'vault:_attachments/campaign/x.svg'
   * must shorten to '…/x.svg', not '…/campaign/x.svg'. No slash at all: value unchanged. */
  function shortPath(value) {
    var s = value || '';
    var idx = s.lastIndexOf('/');
    if (idx === -1) return s;
    return '…/' + s.slice(idx + 1);
  }

  /**
   * SD-9/interfaces. NAV order (never the pending map's own key order), count > 0 only. An id in
   * `pending` that nav.item() doesn't recognise is skipped automatically -- this iterates
   * nav.ids(), never Object.keys(pending).
   */
  function pendingLinks(pending, nav) {
    var map = pending || {};
    var ids = nav && typeof nav.ids === 'function' ? nav.ids() : [];
    var out = [];
    ids.forEach(function (id) {
      var n = map[id] || 0;
      if (n <= 0) return;
      var item = nav.item(id);
      var label = item ? item.label : id;
      out.push({ id: id, text: n + ' unsaved change' + (n === 1 ? '' : 's') + ' in ' + label });
    });
    return out;
  }

  var VW = {
    timeOf: timeOf,
    billCheck: billCheck,
    billPreview: billPreview,
    checkOutcome: checkOutcome,
    previewOutcome: previewOutcome,
    findingRows: findingRows,
    wordsSummary: wordsSummary,
    numberWord: numberWord,
    wordsParts: wordsParts,
    themeNudge: themeNudge,
    shortPath: shortPath,
    pendingLinks: pendingLinks,
    slotCells: slotCells,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { VW: VW };
    return;
  }

  // -- Browser: Overview, Check, Preview, vault-config.md ---------------------------------------
  //
  // SD-1: this module reads store.get().state (loaded once by store.load(), risk area 6) and
  // never fetches /api/state itself. Two run actions (Run check / Build preview) each appear on
  // two screens (Overview's own actions, and the dedicated Check/Preview screen); both instances
  // call the same shared runCheck()/runBuildPreview() below. All four screens re-render on every
  // relevant store change (state/busy/pending/lastCheck/lastPreview) rather than only when their
  // own screen has no pending edits (SD-7's re-render suppression): none of these four screens
  // has any typed/selected input of its own to lose on a re-render, so there is nothing SD-7
  // needs to protect here, and a plain full re-render also gives SD-8's "controls re-evaluate on
  // store changes" for free -- every button's `disabled` is simply computed fresh, from
  // store.isBusy(), at the moment it is (re)built.

  var api = ScriptoriumAdmin.api;
  var el = ScriptoriumAdmin.el;
  var setText = ScriptoriumAdmin.setText;
  var icon = ScriptoriumAdmin.icon;

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // -- Shared read helpers (risk area 6: no /api/state fetch; everything below reads `state`,
  // the store's already-loaded snapshot) --------------------------------------------------------

  function currentThemeName(state) {
    var packToml = state.packToml || {};
    return packToml.exists ? packToml.theme : 'plain';
  }

  /** SD-4/screens: "the theme's scheme, or else palette.scheme". Exact-name array find. */
  function themeSchemeFor(state) {
    var name = currentThemeName(state);
    var themes = state.themes || [];
    var found = null;
    for (var i = 0; i < themes.length; i++) {
      if (themes[i].name === name) {
        found = themes[i];
        break;
      }
    }
    if (found && found.scheme !== null && found.scheme !== undefined) return found.scheme;
    return state.palette && state.palette.scheme !== undefined ? state.palette.scheme : null;
  }

  // V1d-1 SD-8: info -> seal, warn -> rose, error -> error (the mock's own severity-to-pill
  // colour choice, M:1134's example is an info finding shown as a1-pill.seal).
  var SEVERITY_PILL = { info: 'seal', warn: 'rose', error: 'error' };

  function severityPillClass(sev) {
    return 'a1-pill ' + (SEVERITY_PILL[sev] || 'muted');
  }

  /** V1d-1 SD-8: findings as `ul.a1-find` (M:265-266), not a table -- a severity pill, a `code`
   * id, and a `p` with the message, plus the path (DV-8, FR-14: the mock's own example finding
   * carries no path, but ours are vault-derived and the panel shows them). */
  function buildFindingsList(findings) {
    var rows = VW.findingRows(findings);
    var list = el('ul');
    list.className = 'a1-find';
    rows.forEach(function (row) {
      var li = el('li');
      var pill = el('span');
      pill.className = severityPillClass(row.severity);
      setText(pill, row.severity);
      li.appendChild(pill);
      var code = el('code');
      setText(code, row.id);
      li.appendChild(code);
      var p = el('p');
      setText(p, row.path ? row.message + ' (' + row.path + ')' : row.message);
      li.appendChild(p);
      list.appendChild(li);
    });
    return list;
  }

  /** `text` defaults to "Open preview" (the a1-actions button); Overview's bill uses the
   * host:port address itself as the link text instead (M:1131). */
  function openPreviewLink(state, text) {
    var a = el('a');
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // V1.5a (SD-doc section 10): no client-built URL. The admin-origin /open-preview decides, per
    // request kind, where to go (loopback: the preview port, as before; remote: a one-time hand-off).
    a.href = '/open-preview';
    setText(a, text || 'Open preview');
    return a;
  }

  function spinSpan() {
    var spin = el('span');
    spin.className = 'spin';
    spin.setAttribute('aria-hidden', 'true');
    return spin;
  }

  // -- Actions: Run check / Build preview (FR-20 busy) -------------------------------------------
  //
  // lastCheckOutcome/lastPreviewOutcome are module-local, NOT store keys: they hold whichever
  // VW.checkOutcome()/previewOutcome() kind the most recent attempt in this tab produced (ok,
  // error, busy, unknown, or -- for preview -- built/refused-check/refused-scan/failed), driving
  // the Check/Preview screens' own outcome display. store.lastCheck/lastPreview (SD-4's literal
  // shape) are set ONLY on a successful run, since that is the shape VW.billCheck/billPreview
  // (and so Overview's bill) expect.

  var lastCheckOutcome = null;
  var lastPreviewOutcome = null;

  /** SD-5: sets busy before the POST, clears it on every path (success, a mapped failure, and a
   * rejected fetch/network abort -- app.js's api() has no catch of its own, risk area per V1b
   * Part 0 item 12), so `busy` can never get stuck (M4). */
  function runCheck() {
    ScriptoriumAdmin.store.set({ busy: 'check' });
    return api('/api/check', { method: 'POST' })
      .then(function (result) {
        var outcome = VW.checkOutcome(result);
        lastCheckOutcome = outcome;
        var patch = { busy: null };
        if (outcome.kind === 'ok') {
          patch.lastCheck = {
            exitCode: result.body && result.body.exitCode,
            counts: outcome.counts,
            findings: outcome.findings,
            generatedAt: outcome.generatedAt,
          };
        }
        ScriptoriumAdmin.store.set(patch);
      })
      .catch(function () {
        lastCheckOutcome = VW.checkOutcome({ ok: false, status: 0, body: null });
        ScriptoriumAdmin.store.set({ busy: null });
      });
  }

  /** SD-1/SD-5: calls store.load() after every attempt (matching the legacy loadState() call,
   * unconditional on outcome), so a successful build's preview.built/generatedAt reach the
   * Overview bill even in another tab that never ran this build itself. */
  function runBuildPreview() {
    ScriptoriumAdmin.store.set({ busy: 'build' });
    return api('/api/preview', { method: 'POST' })
      .then(function (result) {
        var outcome = VW.previewOutcome(result);
        lastPreviewOutcome = outcome;
        var patch = { busy: null };
        if (outcome.kind === 'built') {
          patch.lastPreview = {
            exitCode: result.body && result.body.exitCode,
            pagesWritten: outcome.pagesWritten,
            generatedAt: outcome.generatedAt,
            refused: false,
            findings: [],
            human: outcome.human,
          };
        }
        ScriptoriumAdmin.store.set(patch);
        return ScriptoriumAdmin.store.load();
      })
      .catch(function () {
        lastPreviewOutcome = VW.previewOutcome({ ok: false, status: 0, body: null });
        ScriptoriumAdmin.store.set({ busy: null });
      });
  }

  // -- Overview (FR-06, AC-01, AC-06 read-only, parse errors) -------------------------------------

  /** SD-8's bill Theme card value: the theme name plus a muted scheme pill (M:1128). */
  function themeValueNode(state) {
    var val = el('div');
    val.className = 'a1-val';
    val.appendChild(document.createTextNode(currentThemeName(state) + ' '));
    var pill = el('span');
    pill.className = 'a1-pill muted';
    setText(pill, themeSchemeFor(state) || 'no scheme');
    val.appendChild(pill);
    return val;
  }

  /** SD-8's bill Theme card meta: the VW.themeNudge link, or nothing when there is no other
   * theme to suggest. Theme names are read exact (VW.themeNudge's own exact-name equality). */
  function themeMetaNode(state) {
    var meta = el('div');
    meta.className = 'a1-meta';
    var names = (state.themes || []).map(function (t) {
      return t.name;
    });
    var nudge = VW.themeNudge(names, currentThemeName(state));
    if (nudge) {
      var link = el('a');
      link.className = 'a1-link';
      link.href = ScriptoriumAdmin.NV.hrefFor('theme');
      setText(link, nudge.text);
      meta.appendChild(link);
    }
    return meta;
  }

  /** SD-8's bill Last check card value: tick+ok when clean, warn otherwise, plain text when
   * nothing has run in this tab yet (no icon either way in that last case). */
  function checkValueNode(lastCheck) {
    var bill = VW.billCheck(lastCheck);
    var val = el('div');
    val.className = 'a1-val';
    if (lastCheck) {
      var isClean = bill.text === 'Clean';
      if (isClean) val.classList.add('ok');
      val.appendChild(icon(isClean ? 'tick' : 'warn'));
    }
    val.appendChild(document.createTextNode(bill.text));
    return val;
  }

  /** SD-8's bill Last preview card meta: "built HH:MM", then the preview address as a link
   * (DV-9: only once a preview exists). */
  function previewMetaNode(state, s) {
    var bill = VW.billPreview(s.lastPreview, state.preview && state.preview.built);
    var meta = el('div');
    meta.className = 'a1-meta';
    if (bill.meta) meta.appendChild(document.createTextNode(bill.meta));
    if (bill.showLink) {
      if (bill.meta) meta.appendChild(document.createTextNode(' · '));
      var sess = ScriptoriumAdmin.store.get().session;
      var link = openPreviewLink(state, ScriptoriumAdmin.PV.previewAddress(sess && sess.access, location.hostname, state.previewPort, ''));
      link.className = 'a1-link';
      meta.appendChild(link);
    }
    return meta;
  }

  /** SD-8: `.a1-bill`, three cards (Theme, Last check, Last preview). */
  function buildBill(state, s) {
    var bill = el('div');
    bill.className = 'a1-bill';

    var themeCard = el('div');
    var themeCap = el('div');
    themeCap.className = 'a1-cap';
    setText(themeCap, 'Theme');
    themeCard.appendChild(themeCap);
    themeCard.appendChild(themeValueNode(state));
    themeCard.appendChild(themeMetaNode(state));
    bill.appendChild(themeCard);

    var checkCard = el('div');
    var checkCap = el('div');
    checkCap.className = 'a1-cap';
    setText(checkCap, 'Last check');
    checkCard.appendChild(checkCap);
    checkCard.appendChild(checkValueNode(s.lastCheck));
    var checkMeta = el('div');
    checkMeta.className = 'a1-meta';
    setText(checkMeta, VW.billCheck(s.lastCheck).meta);
    checkCard.appendChild(checkMeta);
    bill.appendChild(checkCard);

    var previewCard = el('div');
    var previewCap = el('div');
    previewCap.className = 'a1-cap';
    setText(previewCap, 'Last preview');
    previewCard.appendChild(previewCap);
    var previewBill = VW.billPreview(s.lastPreview, state.preview && state.preview.built);
    var previewVal = el('div');
    previewVal.className = 'a1-val';
    setText(previewVal, previewBill.text);
    previewCard.appendChild(previewVal);
    previewCard.appendChild(previewMetaNode(state, s));
    bill.appendChild(previewCard);

    return bill;
  }

  /** SD-8: `.a1-actions` -- Run check (primary), Build preview, Open preview (ghost, DV-9: only
   * once a preview exists), Upload image (ghost link). The frame's shared busy status
   * (DV-13) covers the "the panel pauses while..." line; this only swaps the running button's
   * own label per SD-8's last bullet. */
  function buildActions(state, s) {
    var isBusy = ScriptoriumAdmin.store.isBusy();
    var actions = el('div');
    actions.className = 'a1-actions';

    var checkBtn = el('button');
    checkBtn.type = 'button';
    checkBtn.className = 'a1-btn primary';
    checkBtn.setAttribute('data-act', 'check');
    checkBtn.disabled = isBusy;
    if (s.busy === 'check') {
      checkBtn.appendChild(spinSpan());
      checkBtn.appendChild(document.createTextNode(' Checking…'));
    } else {
      checkBtn.appendChild(icon('check'));
      checkBtn.appendChild(document.createTextNode('Run check'));
    }
    checkBtn.addEventListener('click', runCheck);
    actions.appendChild(checkBtn);

    var previewBtn = el('button');
    previewBtn.type = 'button';
    previewBtn.className = 'a1-btn';
    previewBtn.setAttribute('data-act', 'build');
    previewBtn.disabled = isBusy;
    if (s.busy === 'build') {
      previewBtn.appendChild(spinSpan());
      previewBtn.appendChild(document.createTextNode(' Building…'));
    } else {
      previewBtn.appendChild(icon('play'));
      previewBtn.appendChild(document.createTextNode('Build preview'));
    }
    previewBtn.addEventListener('click', runBuildPreview);
    actions.appendChild(previewBtn);

    var previewBill = VW.billPreview(s.lastPreview, state.preview && state.preview.built);
    if (previewBill.showLink) {
      var openLink = openPreviewLink(state);
      openLink.className = 'a1-btn ghost';
      openLink.setAttribute('data-act', 'open-preview');
      openLink.insertBefore(icon('ext'), openLink.firstChild);
      actions.appendChild(openLink);
    }

    var uploadLink = el('a');
    uploadLink.className = 'a1-btn ghost';
    uploadLink.setAttribute('data-act', 'upload');
    uploadLink.href = ScriptoriumAdmin.NV.hrefFor('images');
    uploadLink.appendChild(icon('upload'));
    uploadLink.appendChild(document.createTextNode('Upload image'));
    actions.appendChild(uploadLink);

    return actions;
  }

  /** SD-8: a `.a1-slot` card per SLOT_NAMES entry -- thumb (a real images/ file, an `<img>` with
   * CSS object-fit), path (a vault: value or anything else not thumbnailable, DV-3, a hatched
   * box with a file icon and "vault file"), or empty (a dashed hatched box). */
  function buildSlotsGrid(state, relFn) {
    var grid = el('div');
    grid.className = 'a1-slots';
    VW.slotCells(state, relFn).forEach(function (cell) {
      var card = el('div');
      card.className = 'a1-slot' + (cell.kind === 'empty' ? ' empty' : '');
      var th = el('div');
      th.className = 'th';
      if (cell.kind === 'thumb') {
        var img = el('img');
        img.src = '/api/image?name=' + encodeURIComponent(cell.rel);
        img.alt = cell.slot;
        th.appendChild(img);
      } else if (cell.kind === 'path') {
        th.classList.add('path');
        th.appendChild(icon('file'));
        var pathLabel = el('span');
        setText(pathLabel, 'vault file');
        th.appendChild(pathLabel);
      } else {
        setText(th, 'empty');
      }
      card.appendChild(th);
      var b = el('b');
      setText(b, cell.slot);
      card.appendChild(b);
      var small = el('small');
      if (cell.kind === 'empty') {
        setText(small, 'not set');
      } else {
        setText(small, VW.shortPath(cell.value));
        small.setAttribute('title', cell.value);
      }
      card.appendChild(small);
      grid.appendChild(card);
    });
    return grid;
  }

  /** SD-8: `.a1-cols` -- Check findings beside Image slots. */
  function buildColumns(state, s, slotImageRel) {
    var cols = el('div');
    cols.className = 'a1-cols';

    var findSection = el('section');
    var findHeading = el('h2');
    findHeading.className = 'a1-rule';
    setText(findHeading, 'Check findings');
    findSection.appendChild(findHeading);
    if (s.lastCheck) {
      findSection.appendChild(buildFindingsList(s.lastCheck.findings || []));
    } else {
      var notRunP = el('p');
      setText(notRunP, 'Not run in this tab yet');
      findSection.appendChild(notRunP);
    }
    var findFine = el('p');
    findFine.className = 'a1-fine';
    setText(findFine, "A clean check is not clearance to share the site with players. It can't catch prep prose that names nobody hidden.");
    findSection.appendChild(findFine);
    cols.appendChild(findSection);

    var slotsSection = el('section');
    var slotsHeading = el('h2');
    slotsHeading.className = 'a1-rule';
    setText(slotsHeading, 'Image slots');
    slotsSection.appendChild(slotsHeading);
    slotsSection.appendChild(buildSlotsGrid(state, slotImageRel));
    var slotsFine = el('p');
    slotsFine.className = 'a1-fine';
    setText(slotsFine, 'Anything you upload to images/ is published with the site, used or not.');
    slotsSection.appendChild(slotsFine);
    cols.appendChild(slotsSection);

    return cols;
  }

  /** Joins up to three `<q>`-wrapped values with an Oxford-free ", "/" and " join. */
  function appendQuotedList(p, values) {
    values.forEach(function (val, i) {
      if (i > 0) p.appendChild(document.createTextNode(i === values.length - 1 ? ' and ' : ', '));
      var q = el('q');
      setText(q, val);
      p.appendChild(q);
    });
  }

  /**
   * SD-8/DV-14: `p.a1-words` built from VW.wordsParts, quoting at most three label values, plus
   * VW.pendingLinks. Engineer-interpreted residual (CLAUDE.md's testing-standards precedent,
   * matching the existing VW.wordsSummary comment): the mock's own sentence (M:1141) is a
   * one-off example, not a literal template pinned for every count -- the wording below covers
   * zero, one, few and "and more" without repeating the mock's exact words verbatim.
   */
  function buildWords(state, s) {
    var section = el('section');
    var heading = el('h2');
    heading.className = 'a1-rule';
    setText(heading, 'Words');
    section.appendChild(heading);

    var parts = VW.wordsParts(state.vocab);
    var p = el('p');
    p.className = 'a1-words';
    if (parts.labelCount === 0) {
      p.appendChild(document.createTextNode('No labels are your own yet.'));
    } else {
      var countWord = VW.numberWord(parts.labelCount);
      var capitalized = countWord.charAt(0).toUpperCase() + countWord.slice(1);
      var lead = parts.labelCount === 1 ? 'One label is your own: ' : capitalized + ' labels are your own: ';
      p.appendChild(document.createTextNode(lead));
      appendQuotedList(p, parts.quoted);
      p.appendChild(document.createTextNode(parts.more ? ', and more.' : '.'));
    }
    p.appendChild(document.createTextNode(' '));
    var kindsText = parts.kindsOwn
      ? 'The timeline uses ' + VW.numberWord(parts.kindsCount) + ' of your own kinds.'
      : 'The timeline uses the ' + VW.numberWord(parts.kindsCount) + ' built-in kinds.';
    p.appendChild(document.createTextNode(kindsText));

    VW.pendingLinks(s.pending, ScriptoriumAdmin.NV).forEach(function (link) {
      p.appendChild(document.createTextNode(' '));
      var a = el('a');
      a.className = 'a1-link';
      a.href = ScriptoriumAdmin.NV.hrefFor(link.id);
      setText(a, link.text);
      p.appendChild(a);
    });

    section.appendChild(p);
    return section;
  }

  /**
   * SD-8 (M:1127-1143), restructured V1e-3 (SD-23): the hero, bill+actions, and columns+words
   * now write into THREE PERSISTENT slots (ov-hero, ov-top, ov-rest) rather than one container
   * that gets fully cleared -- sitepane.js's own ov-tabs/ov-strip/ov-site slots, siblings of
   * these, are never touched here, so a live embedded frame inside them never reloads just
   * because Overview's own data changed (risk area 2). Always called with a real `s.state`
   * (renderAll's own guard).
   */
  function renderOverview(ovHero, ovTop, ovRest, s, slotImageRel) {
    var state = s.state;
    var vcj = state.vaultConfigJson || {};

    clear(ovHero);
    var hero = el('header');
    hero.className = 'a1-hero ov-hero';

    var heroRow = el('div');
    heroRow.className = 'ov-hero-row';
    var eyebrow = el('div');
    eyebrow.className = 'a1-eyebrow';
    eyebrow.appendChild(document.createTextNode('Backstage · campaign '));
    var eyebrowCode = el('code');
    setText(eyebrowCode, state.campaign || '');
    eyebrow.appendChild(eyebrowCode);
    heroRow.appendChild(eyebrow);
    // V1e-3 (SD-23): a stable, named slot -- this whole hero only rebuilds on a state/busy/
    // pending/lastCheck/lastPreview change (views.js's own renderAll trigger), but heroControl()
    // must also react to a viewport or placement (prefs) change alone, neither of which
    // re-renders Overview at all. sitepane.js's own central subscription refreshes just this
    // slot's contents on those changes (querying by this data-part, not a captured reference), so
    // this initial population only has to be right for whichever state-triggered render created
    // it. Read lazily -- sitepane.js loads AFTER views.js in index.html's script order, so a
    // top-of-file capture would freeze `undefined` forever, but by the time this actually RUNS
    // (well after boot), sitePane is published.
    var controlSlot = el('span');
    controlSlot.setAttribute('data-part', 'ov-hero-control');
    if (ScriptoriumAdmin.sitePane && typeof ScriptoriumAdmin.sitePane.heroControl === 'function') {
      var control = ScriptoriumAdmin.sitePane.heroControl();
      if (control) controlSlot.appendChild(control);
    }
    heroRow.appendChild(controlSlot);
    hero.appendChild(heroRow);

    var h1 = el('h1');
    h1.className = 'a1-h1';
    h1.tabIndex = -1; // frame.js's show() focuses this on navigate (SD-2: Overview owns its h1)
    setText(h1, vcj.siteTitle || state.campaign || '');
    hero.appendChild(h1);

    var tagline = el('p');
    tagline.className = 'a1-tagline';
    // V1e-1 (SD-7, D-20): the dead landingTagline key is never read here again -- the site only
    // ever reads publish.theme.tagline (_meta/vault-config.md), and that is what the hero shows.
    setText(tagline, (state.vaultConfigFile && state.vaultConfigFile.tagline) || '');
    hero.appendChild(tagline);

    var editLink = el('a');
    editLink.className = 'a1-link';
    editLink.href = ScriptoriumAdmin.NV.hrefFor('title');
    setText(editLink, 'Edit title and tagline');
    hero.appendChild(editLink);

    ovHero.appendChild(hero);

    clear(ovTop);
    if (!state.writable) {
      var readOnlyP = el('p');
      readOnlyP.className = 'views-readonly';
      setText(readOnlyP, state.readOnlyReason || 'This campaign is read-only.');
      ovTop.appendChild(readOnlyP);
    }
    // AC-06/risk area 4: parse errors verbatim, textContent only.
    [
      [state.packToml, 'error'],
      [vcj, 'error'],
    ].forEach(function (pair) {
      if (pair[0] && pair[0][pair[1]]) {
        var errP = el('p');
        errP.className = 'views-error';
        setText(errP, pair[0][pair[1]]);
        ovTop.appendChild(errP);
      }
    });
    if (state.vaultConfigMd && state.vaultConfigMd.ok === false) {
      var mdErrP = el('p');
      mdErrP.className = 'views-error';
      setText(mdErrP, state.vaultConfigMd.text);
      ovTop.appendChild(mdErrP);
    }

    ovTop.appendChild(buildBill(state, s));
    ovTop.appendChild(buildActions(state, s));

    clear(ovRest);
    ovRest.appendChild(buildColumns(state, s, slotImageRel));
    ovRest.appendChild(buildWords(state, s));
  }

  // -- Check (FR-14, AC-02) -----------------------------------------------------------------------

  /** SD-8: primary Run check, counts in `.a1-meta`, then `ul.a1-find` and `.a1-fine`. */
  function renderCheck(mount, s) {
    clear(mount);
    if (!s.state) return;
    var isBusy = ScriptoriumAdmin.store.isBusy();

    var runBtn = el('button');
    runBtn.type = 'button';
    runBtn.className = 'a1-btn primary';
    runBtn.setAttribute('data-act', 'check');
    runBtn.disabled = isBusy;
    if (s.busy === 'check') {
      runBtn.appendChild(spinSpan());
      runBtn.appendChild(document.createTextNode(' Checking…'));
    } else {
      runBtn.appendChild(icon('check'));
      runBtn.appendChild(document.createTextNode('Run check'));
    }
    runBtn.addEventListener('click', runCheck);
    mount.appendChild(runBtn);

    var outcome = lastCheckOutcome;
    if (outcome && outcome.kind !== 'ok' && outcome.message) {
      var banner = el('p');
      banner.setAttribute('role', 'alert');
      banner.className = 'views-outcome views-outcome-alert';
      setText(banner, outcome.message);
      mount.appendChild(banner);
    }

    if (s.lastCheck) {
      var c = s.lastCheck.counts || { error: 0, warn: 0, info: 0 };
      var countsP = el('p');
      countsP.className = 'a1-meta';
      setText(countsP, c.error + ' errors · ' + c.warn + ' warnings · ' + c.info + ' info');
      mount.appendChild(countsP);
      mount.appendChild(buildFindingsList(s.lastCheck.findings || []));
    } else {
      var notRunP = el('p');
      setText(notRunP, 'Not run in this tab yet');
      mount.appendChild(notRunP);
    }

    var finePrint = el('p');
    finePrint.className = 'a1-fine';
    setText(finePrint, "A clean check is not clearance to share the site with players. It can't catch prep prose that names nobody hidden.");
    mount.appendChild(finePrint);
  }

  // -- Preview (FR-15, AC-03) ---------------------------------------------------------------------

  /** SD-8: primary Build preview plus ghost Open preview (DV-9: only once a preview exists), a
   * mini bill (pages written, generated time), `human` in a mono block, and findings as
   * `ul.a1-find` on a refusal. */
  function renderPreview(mount, s) {
    clear(mount);
    var state = s.state;
    if (!state) return;
    var isBusy = ScriptoriumAdmin.store.isBusy();

    var actions = el('div');
    actions.className = 'a1-actions';

    var buildBtn = el('button');
    buildBtn.type = 'button';
    buildBtn.className = 'a1-btn primary';
    buildBtn.setAttribute('data-act', 'build');
    buildBtn.disabled = isBusy;
    if (s.busy === 'build') {
      buildBtn.appendChild(spinSpan());
      buildBtn.appendChild(document.createTextNode(' Building…'));
    } else {
      buildBtn.appendChild(icon('play'));
      buildBtn.appendChild(document.createTextNode('Build preview'));
    }
    buildBtn.addEventListener('click', runBuildPreview);
    actions.appendChild(buildBtn);

    var previewBill = VW.billPreview(s.lastPreview, state.preview && state.preview.built);
    if (previewBill.showLink) {
      var openLink = openPreviewLink(state);
      openLink.className = 'a1-btn ghost';
      openLink.setAttribute('data-act', 'open-preview');
      openLink.insertBefore(icon('ext'), openLink.firstChild);
      actions.appendChild(openLink);
    }
    mount.appendChild(actions);

    var outcome = lastPreviewOutcome;
    if (outcome) {
      if (outcome.kind !== 'built' && outcome.message) {
        var banner = el('p');
        banner.setAttribute('role', 'alert');
        banner.className = 'views-outcome views-outcome-alert';
        setText(banner, outcome.message);
        mount.appendChild(banner);
      }
      if (outcome.kind === 'built' || outcome.kind === 'refused-check' || outcome.kind === 'refused-scan' || outcome.kind === 'failed') {
        var pagesP = el('p');
        pagesP.className = 'a1-meta';
        var pagesText = outcome.pagesWritten === null || outcome.pagesWritten === undefined ? 'none' : String(outcome.pagesWritten);
        setText(pagesP, 'Pages written: ' + pagesText + '. Generated: ' + VW.timeOf(outcome.generatedAt));
        mount.appendChild(pagesP);
      }
      if (typeof outcome.human === 'string') {
        var humanPre = el('pre');
        humanPre.className = 'views-human';
        setText(humanPre, outcome.human);
        mount.appendChild(humanPre);
      }
      // AC-03: findings on a refusal, with no override.
      if ((outcome.kind === 'refused-check' || outcome.kind === 'refused-scan') && outcome.findings && outcome.findings.length > 0) {
        mount.appendChild(buildFindingsList(outcome.findings));
      }
    } else {
      var notRunP = el('p');
      setText(notRunP, 'Not run in this tab yet');
      mount.appendChild(notRunP);
    }
  }

  // -- Registration and the store subscription -----------------------------------------------------

  function init(container) {
    var checkMount = ScriptoriumAdmin.mount('check');
    var previewMount = ScriptoriumAdmin.mount('preview');
    var vaultConfigMount = ScriptoriumAdmin.mount('vault-config');
    // Read lazily, at render time (not at module-parse time): images.js loads AFTER views.js
    // (index.html's script order), so by the time init() actually runs -- during boot()'s
    // initSections(), after every deferred script including images.js has executed -- IM is
    // already published, but a top-of-file capture would have frozen `undefined` forever.
    function slotImageRel(value, images) {
      var IM = ScriptoriumAdmin.IM;
      return IM ? IM.slotImageRel(value, images) : null;
    }

    // V1e-3 (SD-23): persistent Overview slots, built ONCE and never rebuilt by renderOverview --
    // sitepane.js's ov-tabs/ov-strip/ov-site slots are siblings of ov-top/ov-rest inside
    // ov-backstage, so a full re-render of this screen's OWN data can never touch (or reload) a
    // live embedded frame sitepane owns.
    var ovHero = el('div');
    ovHero.setAttribute('data-part', 'ov-hero');
    container.appendChild(ovHero);
    var ovTabs = el('div');
    ovTabs.setAttribute('data-part', 'ov-tabs');
    ovTabs.hidden = true;
    container.appendChild(ovTabs);
    var ovBackstage = el('div');
    ovBackstage.setAttribute('data-part', 'ov-backstage');
    container.appendChild(ovBackstage);
    var ovTop = el('div');
    ovTop.setAttribute('data-part', 'ov-top');
    ovBackstage.appendChild(ovTop);
    var ovStrip = el('div');
    ovStrip.setAttribute('data-part', 'ov-strip');
    ovStrip.hidden = true;
    ovBackstage.appendChild(ovStrip);
    var ovRest = el('div');
    ovRest.setAttribute('data-part', 'ov-rest');
    ovBackstage.appendChild(ovRest);
    var ovSite = el('div');
    ovSite.setAttribute('data-part', 'ov-site');
    ovSite.hidden = true;
    container.appendChild(ovSite);

    function renderAll() {
      var s = ScriptoriumAdmin.store.get();
      if (!s.state) return;
      renderOverview(ovHero, ovTop, ovRest, s, slotImageRel);
      renderCheck(checkMount, s);
      renderPreview(previewMount, s);
    }

    ScriptoriumAdmin.store.subscribe(function (next, prev) {
      if (
        next.state !== prev.state ||
        next.busy !== prev.busy ||
        next.pending !== prev.pending ||
        next.lastCheck !== prev.lastCheck ||
        next.lastPreview !== prev.lastPreview
      ) {
        renderAll();
      }
    });

    renderAll();

    // V1e-3 (SD-23): sitepane manages ov-tabs/ov-strip/ov-site directly (never through
    // renderOverview above), plus the ov1/ov2/ov3 pane registrations. Called after this
    // screen's own first render, so the persistent slots already exist in the DOM.
    ScriptoriumAdmin.sitePane.init({ tabs: ovTabs, strip: ovStrip, site: ovSite });

    // V1e-9 (SD-100): vault-config.md's own screen is a mount hand-off, not a renderAll()
    // participant -- ScriptoriumAdmin.vaultCfg owns its own render loop and store subscriptions
    // from here on.
    ScriptoriumAdmin.vaultCfg.init(vaultConfigMount);
  }

  // V1e-3 (SD-23): published so sitepane.js can call VW.timeOf/VW.pendingLinks and re-run the
  // same Build preview flow (runs.build) every other Rebuild control on Overview uses, without a
  // second POST /api/preview implementation. sitepane.js loads AFTER views.js (index.html), so
  // this is always ready by the time any of its own code runs.
  ScriptoriumAdmin.VW = VW;
  ScriptoriumAdmin.runs = {
    build: runBuildPreview,
    lastPreviewOutcome: function () {
      return lastPreviewOutcome;
    },
  };

  ScriptoriumAdmin.register('views', function (container) {
    init(container);
  });
})();
