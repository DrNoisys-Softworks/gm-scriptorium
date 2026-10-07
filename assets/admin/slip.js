'use strict';

/*
 * V1b SD-4/SD-5/SD-6: SL, the pure half of the sealed-slip save review (schemeMismatch,
 * confirmBody, buildSlip), above the node module.exports guard. The browser half -- the native
 * <dialog>, showModal()/close(), focus return -- is added to this same file in the C4 (DOM)
 * commit, once the four screens exist to open it. Stub only for the pure half: every export is
 * present with the right shape but a placeholder body; test/admin-slip.test.js drives the real
 * implementation in the C3 commit.
 */
(function () {
  var DF = typeof module === 'object' && module.exports ? require('./diff').DF : window.ScriptoriumAdmin.DF;

  var TITLES = { theme: 'Save theme', settings: 'Save title and tagline', tagline: 'Save tagline', vocab: 'Save vocabulary', slots: 'Save image choices' };
  var FOOT = 'Saving writes this one file and never publishes. The panel never commits.';
  // V1e-1 (SD-7, D-19): the combined Title-screen review, when both vault.config.json and
  // vault-config.md have pending edits.
  var FOOT_MANY = 'Saving writes these two files and never publishes. The panel never commits.';
  var KIND_FIELD_KEYS = ['label', 'glyph', 'aliases', 'before'];

  // ADR 0032, Structural decision 2: a literal mirror of src/checks/themescheme.js's own
  // `owns.includes('palette')` branch -- the panel never sees theme.json, so it can't derive
  // this from a live check the way the server does; kept as a literal, cross-checked against
  // the server by test/admin-v1b-server.test.js's PARITY_CASES (ADR 0022, "Vocabulary edits": no new
  // /api/state field for this).
  var PALETTE_OWNING_THEMES = ['gloam'];

  /** Mirrors src/checks/themescheme.js:86-92's rule exactly, over the client's own copies. */
  function schemeMismatch(themeName, themes, palette) {
    if (!palette || palette.error !== null) return null;
    var theme = (themes || []).find(function (t) {
      return t.name === themeName;
    });
    if (!theme || theme.scheme === null) return null;
    if (PALETTE_OWNING_THEMES.indexOf(themeName) !== -1) return null;
    if (palette.scheme === null) return null;
    if (palette.scheme === theme.scheme) return null;
    return { theme: themeName, themeScheme: theme.scheme, paletteScheme: palette.scheme, background: palette.background };
  }

  function confirmBody(dryBody) {
    var next = {};
    Object.keys(dryBody).forEach(function (key) {
      if (key === 'dryRun') return;
      next[key] = dryBody[key];
    });
    return next;
  }

  function normalizeEmpty(v) {
    return v === null || v === undefined ? '' : v;
  }

  function joinList(v) {
    if (Array.isArray(v)) return v.join(', ');
    return normalizeEmpty(v);
  }

  function schemeNoteFor(scheme) {
    return scheme === null || scheme === undefined ? 'no scheme' : scheme;
  }

  function themeSchemeFor(name, themes) {
    var found = (themes || []).find(function (t) {
      return t.name === name;
    });
    return found ? found.scheme : null;
  }

  function buildThemeRows(payload, state) {
    var themes = (state && state.themes) || [];
    var nowTheme = (state && state.packToml && state.packToml.theme) || 'plain';
    var afterTheme = payload.theme;
    return [
      {
        where: 'Theme',
        key: 'theme',
        now: nowTheme,
        nowNote: schemeNoteFor(themeSchemeFor(nowTheme, themes)),
        after: afterTheme,
        afterNote: schemeNoteFor(themeSchemeFor(afterTheme, themes)),
      },
    ];
  }

  function buildSettingsRows(payload, state) {
    var vcj = (state && state.vaultConfigJson) || {};
    var rows = [];
    // V1e-1 (SD-7, FR-08): siteTitle only -- landingTagline is dead config (D-20) and is never
    // sent, so a stray landingTagline key in a payload is silently ignored here, never a row.
    ['siteTitle'].forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
      var now = normalizeEmpty(vcj[key]);
      var after = normalizeEmpty(payload[key]);
      if (now !== after) {
        rows.push({ where: 'Settings', key: key, now: now, nowNote: undefined, after: after, afterNote: undefined });
      }
    });
    return rows;
  }

  /** V1e-1 (SD-7): the tagline part's one row, `publish.theme.tagline` in vault-config.md. */
  function buildTaglineRows(payload, state) {
    var vcf = (state && state.vaultConfigFile) || {};
    var now = normalizeEmpty(vcf.tagline);
    var after = normalizeEmpty(payload.tagline);
    if (now === after) return [];
    return [{ where: 'vault-config.md', key: 'publish.theme.tagline', now: now, nowNote: undefined, after: after, afterNote: undefined }];
  }

  /**
   * V1e-5 (SD-58): `images.js` loads after `slip.js` (app.js's script order), so the `IM` lookup
   * here is lazy -- read only at call time, never at module load, the same reason
   * src/admin/handlers/pack.js requires packwrite through its own module object.
   */
  function slotWhere(slot) {
    var im = typeof module === 'object' && module.exports ? require('./images').IM : window.ScriptoriumAdmin.IM;
    return im.friendlyName(slot) || 'Images';
  }

  function buildSlotsRows(payload, state) {
    var images = (state && state.packToml && state.packToml.images) || {};
    var slots = (payload && payload.slots) || {};
    return Object.keys(slots).map(function (slot) {
      var value = slots[slot];
      var now = Object.prototype.hasOwnProperty.call(images, slot) ? images[slot] : 'not set';
      var after = value === null ? 'cleared' : value;
      return { where: slotWhere(slot), key: slot, now: now, nowNote: undefined, after: after, afterNote: undefined };
    });
  }

  /** One row for a scalar/list field: value comes from the on-disk table when present, else the
   * default (noted 'default'); the sent value, or the default (noted 'default') when null. */
  function vocabFieldRow(where, key, sentValue, onDiskTable, defaultsTable, isList) {
    var onDiskHas = onDiskTable && Object.prototype.hasOwnProperty.call(onDiskTable, key);
    var defaultVal = defaultsTable ? defaultsTable[key] : undefined;
    var nowIsDefault = !onDiskHas;
    var nowRaw = onDiskHas ? onDiskTable[key] : defaultVal;
    var afterIsDefault = sentValue === null;
    var afterRaw = afterIsDefault ? defaultVal : sentValue;
    return {
      where: where,
      key: key,
      now: isList ? joinList(nowRaw) : normalizeEmpty(nowRaw),
      nowNote: nowIsDefault ? 'default' : undefined,
      after: isList ? joinList(afterRaw) : normalizeEmpty(afterRaw),
      afterNote: afterIsDefault ? 'default' : undefined,
    };
  }

  /**
   * Kind rows: added/removed/changed-with-changed-field-names, no row for an unchanged kind.
   * "now"/"after" text for added/removed/changed rows is an Engineer-interpreted residual: the
   * Engineering Brief names the three outcomes without pinning literal cell text beyond the
   * "your N kinds"/"built-in set" pair for the null case, so this uses 'none'/'added',
   * 'present'/'removed', and 'changed'/<comma-joined field names> for the three cases.
   */
  function kindsRows(payloadKinds, onDiskKinds, defaultKinds) {
    if (payloadKinds === null) {
      var priorKinds = onDiskKinds || defaultKinds || [];
      return [{ where: 'Timeline kinds', key: 'kinds', now: 'your ' + priorKinds.length + ' kinds', nowNote: undefined, after: 'built-in set', afterNote: undefined }];
    }
    if (!Array.isArray(payloadKinds)) return [];

    var baseline = onDiskKinds || defaultKinds || [];
    var baselineByKey = {};
    baseline.forEach(function (k) {
      baselineByKey[k.key] = k;
    });
    var seen = {};
    var rows = [];

    payloadKinds.forEach(function (k) {
      seen[k.key] = true;
      var prior = baselineByKey[k.key];
      if (!prior) {
        rows.push({ where: 'Timeline kinds', key: k.key, now: 'none', nowNote: undefined, after: 'added', afterNote: undefined });
        return;
      }
      var changedFields = KIND_FIELD_KEYS.filter(function (f) {
        return JSON.stringify(prior[f]) !== JSON.stringify(k[f]);
      });
      if (changedFields.length > 0) {
        rows.push({ where: 'Timeline kinds', key: k.key, now: 'changed', nowNote: undefined, after: changedFields.join(', '), afterNote: undefined });
      }
    });

    baseline.forEach(function (k) {
      if (!seen[k.key]) {
        rows.push({ where: 'Timeline kinds', key: k.key, now: 'present', nowNote: undefined, after: 'removed', afterNote: undefined });
      }
    });

    return rows;
  }

  function buildVocabRows(payload, state) {
    var vocab = (state && state.vocab) || {};
    var tables = vocab.tables || {};
    var defaults = vocab.defaults || {};
    var labelsOnDisk = tables.labels || null;
    var labelsDefaults = defaults.labels || {};
    var timelineOnDisk = tables.timeline || null;
    var timelineDefaults = defaults.timeline || {};
    var recapsOnDisk = tables.recaps || null;
    var recapsDefaults = defaults.recaps || {};

    var rows = [];

    if (payload.labels) {
      Object.keys(payload.labels).forEach(function (key) {
        rows.push(vocabFieldRow('Labels', key, payload.labels[key], labelsOnDisk, labelsDefaults, false));
      });
    }

    if (payload.recaps && Object.prototype.hasOwnProperty.call(payload.recaps, 'learned_heading')) {
      rows.push(vocabFieldRow('Recaps', 'learned_heading', payload.recaps.learned_heading, recapsOnDisk, recapsDefaults, false));
    }

    if (payload.timeline) {
      var t = payload.timeline;
      if (Object.prototype.hasOwnProperty.call(t, 'weights')) {
        rows.push(vocabFieldRow('Timeline', 'weights', t.weights, timelineOnDisk, timelineDefaults, true));
      }
      if (Object.prototype.hasOwnProperty.call(t, 'session_token')) {
        rows.push(vocabFieldRow('Timeline', 'session_token', t.session_token, timelineOnDisk, timelineDefaults, false));
      }
      if (Object.prototype.hasOwnProperty.call(t, 'segment_units')) {
        rows.push(vocabFieldRow('Timeline', 'segment_units', t.segment_units, timelineOnDisk, timelineDefaults, false));
      }
      if (t.columns) {
        var columnsOnDisk = (timelineOnDisk && timelineOnDisk.columns) || null;
        var columnsDefaults = timelineDefaults.columns || {};
        Object.keys(t.columns).forEach(function (key) {
          rows.push(vocabFieldRow('Timeline columns', key, t.columns[key], columnsOnDisk, columnsDefaults, true));
        });
      }
      if (Object.prototype.hasOwnProperty.call(t, 'kinds')) {
        var onDiskKinds = timelineOnDisk && Array.isArray(timelineOnDisk.kinds) ? timelineOnDisk.kinds : null;
        var defaultKinds = Array.isArray(timelineDefaults.kinds) ? timelineDefaults.kinds : [];
        rows = rows.concat(kindsRows(t.kinds, onDiskKinds, defaultKinds));
      }
    }

    return rows;
  }

  function buildRows(kind, payload, state) {
    if (kind === 'theme') return buildThemeRows(payload, state);
    if (kind === 'settings') return buildSettingsRows(payload, state);
    if (kind === 'tagline') return buildTaglineRows(payload, state);
    if (kind === 'slots') return buildSlotsRows(payload, state);
    if (kind === 'vocab') return buildVocabRows(payload, state);
    return [];
  }

  function buildEffects(kind, payload, dry, rows, mismatch, advice, onDiskHasKinds) {
    var effects = [];

    if (dry.before === null) {
      effects.push({ id: 'creates', level: 'info', text: "pack.toml doesn't exist yet; saving creates it." });
    }
    if (dry.before === dry.after) {
      effects.push({ id: 'no-change', level: 'info', text: 'Nothing in the file changes.' });
    }
    if (rows.length === 0 && dry.before !== null && dry.before !== dry.after) {
      effects.push({ id: 'format-only', level: 'info', text: 'No setting changes; saving only reformats the file.' });
    }
    if (dry.commentsLost === true) {
      effects.push({ id: 'comments-lost', level: 'warn', text: 'Saving will remove the comments in the current file.' });
    }

    if (kind === 'vocab' && payload.timeline && Object.prototype.hasOwnProperty.call(payload.timeline, 'kinds')) {
      var kindsPayload = payload.timeline.kinds;
      if (kindsPayload === null) {
        effects.push({ id: 'kinds-removed', level: 'info', text: 'Kinds removed; the built-in set applies.' });
      } else if (Array.isArray(kindsPayload) && !onDiskHasKinds) {
        effects.push({ id: 'kinds-written', level: 'info', text: 'All ' + kindsPayload.length + ' kinds are written into pack.toml, including unchanged ones.' });
      } else if (Array.isArray(kindsPayload)) {
        effects.push({ id: 'kinds-replaced', level: 'info', text: 'The kinds list is replaced as a whole.' });
      }
    }

    // V1e-1 (SD-7, FR-09): the two effects the mock's .vc-bk block names -- always shown for a
    // tagline save, never conditional on anything changing elsewhere.
    if (kind === 'tagline') {
      effects.push({ id: 'backup', level: 'info', text: 'vault-config.md is backed up first, to ' + dry.backupDir + '.' });
      effects.push({ id: 'frontmatter-only', level: 'info', text: 'Only the frontmatter is shown. The rest of the note is not changed.' });
    }

    // V1e-4 (SD-31): closes V1e-1's DV-E17 -- an over-soft-limit tagline still saves, but the
    // review says so, matching the Title screen's own live counter warning. Counted in code
    // points (Array.from), the same rule PK.countState uses.
    if (kind === 'tagline' && payload.tagline && Array.from(payload.tagline).length > 140) {
      effects.push({
        id: 'tagline-length',
        level: 'warn',
        text: 'The tagline is ' + Array.from(payload.tagline).length + ' characters; about 140 reads best on a phone. It still saves.',
      });
    }

    // V1e-4 (SD-30, D-6): the campaign-id warning, only for a settings save whose dry-run extras
    // hook (src/admin/handlers/pack.js's settingsDryRunExtras) found a backend flag on and the
    // slug actually changing. Never blocks -- it is an 'info'-adjacent 'warn' the same way
    // comments-lost is, not a refusal.
    if (kind === 'settings' && dry.campaignId) {
      effects.push({
        id: 'campaign-id',
        level: 'warn',
        text:
          "Your site's backend features are switched on in vault.config.json, and the generator builds a campaign id from the site title. Saving this title changes that id from " +
          dry.campaignId.before +
          ' to ' +
          dry.campaignId.after +
          '. Anything those features stored under the old id is not moved.',
      });
    }

    if (kind === 'theme' && mismatch) {
      effects.push({
        id: 'scheme-mismatch',
        level: 'info',
        text:
          'Check will report config/theme-scheme-mismatch (info): your palette background ' +
          mismatch.background +
          ' is ' +
          mismatch.paletteScheme +
          ' and ' +
          mismatch.theme +
          ' is ' +
          mismatch.themeScheme +
          '.',
      });
    }

    (dry.warnings || []).forEach(function (w) {
      effects.push({ id: 'warning', level: 'warn', text: w });
    });

    (advice || []).forEach(function (a) {
      effects.push({ id: 'slot-size', level: a.level, text: a.text });
    });

    return effects;
  }

  /**
   * @param {{kind:'theme'|'settings'|'vocab'|'slots', payload:object, state:object, dry:object, advice:Array}} args
   */
  function buildSlip(args) {
    var kind = args.kind;
    var payload = args.payload || {};
    var state = args.state || {};
    var dry = args.dry;

    // Whether kinds existed on disk before this save, needed by buildEffects' kinds-written
    // check.
    var timelineOnDisk = state.vocab && state.vocab.tables && state.vocab.tables.timeline;
    var onDiskHasKinds = Boolean(timelineOnDisk && Array.isArray(timelineOnDisk.kinds));

    var rows = buildRows(kind, payload, state);
    var mismatch = kind === 'theme' ? schemeMismatch(payload.theme, state.themes, state.palette) : null;
    var effects = buildEffects(kind, payload, dry, rows, mismatch, args.advice, onDiskHasKinds);

    return {
      eyebrow: 'Review before saving',
      title: TITLES[kind],
      // V1e-1 (SD-7): a third file joins the ternary -- vault-config.md, still inside _meta but
      // outside _meta/scriptorium/ (ADR 0033).
      filePath:
        dry.file === 'pack.toml'
          ? '_meta/scriptorium/pack.toml'
          : dry.file === 'vault.config.json'
            ? '_meta/scriptorium/vault.config.json'
            : '_meta/vault-config.md',
      saveLabel:
        dry.file === 'pack.toml' ? 'Save pack.toml' : dry.file === 'vault.config.json' ? 'Save vault.config.json' : 'Back up and save vault-config.md',
      rows: rows,
      effects: effects,
      diff: DF.diffLines(dry.before, dry.after),
      foot: FOOT,
    };
  }

  /**
   * V1e-1 (SD-7, D-19): one review covering up to two files. `parts` is an array of the same
   * `{kind, payload, dry, advice}` shape `buildSlip` itself takes (minus `state`, added here).
   * @param {{parts: Array, state: object}} args
   */
  function buildCombined(args) {
    var parts = args.parts || [];
    var state = args.state;
    var files = parts.map(function (part) {
      return buildSlip({ kind: part.kind, payload: part.payload, state: state, dry: part.dry, advice: part.advice });
    });
    return {
      eyebrow: 'Review before saving',
      title: 'Save title and tagline',
      files: files,
      saveLabel: parts.length > 1 ? 'Save both files' : files[0].saveLabel,
      foot: parts.length > 1 ? FOOT_MANY : FOOT,
    };
  }

  /**
   * V1e-1 (SD-7, D-19, AC-05): posts `requests` one at a time, in order, ALWAYS attempting every
   * request regardless of an earlier one's outcome. A rejected `post(...)` call (a network error)
   * is turned into `{ok:false, status:0, body:null}` rather than aborting the chain.
   * @param {Array} requests opaque request descriptors, passed to `post` unchanged
   * @param {(request:any) => Promise<{ok:boolean,status:number,body:any}>} post
   * @returns {Promise<Array>} results, in the same order as `requests`
   */
  function postInOrder(requests, post) {
    return requests.reduce(function (chain, req) {
      return chain.then(function (acc) {
        return post(req).then(
          function (result) {
            return acc.concat([result]);
          },
          function () {
            return acc.concat([{ ok: false, status: 0, body: null }]);
          },
        );
      });
    }, Promise.resolve([]));
  }

  /**
   * V1e-1 (SD-7): a one-line-per-file summary after postInOrder resolves. Each `results[i]` must
   * carry its own `file` name (the caller attaches it, since a failure response's body often has
   * no `file` key of its own).
   * @param {Array<{file:string}>} results
   * @param {(result:any, phase:string) => {kind:string, message?:string}} mapOutcome
   * @returns {{allSaved: boolean, lines: string[]}}
   */
  function partSummary(results, mapOutcome) {
    var lines = [];
    var allSaved = true;
    results.forEach(function (result) {
      var outcome = mapOutcome(result, 'save');
      var file = result.file || (result.body && result.body.file) || 'the file';
      if (outcome.kind === 'saved') {
        lines.push(file + ' saved.');
      } else {
        allSaved = false;
        lines.push(file + ' not saved: ' + outcome.message);
      }
    });
    return { allSaved: allSaved, lines: lines };
  }

  var SL = {
    schemeMismatch: schemeMismatch,
    confirmBody: confirmBody,
    buildSlip: buildSlip,
    buildCombined: buildCombined,
    postInOrder: postInOrder,
    partSummary: partSummary,
    PALETTE_OWNING_THEMES: PALETTE_OWNING_THEMES,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { SL: SL };
    return;
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.SL = SL;

  /*
   * The browser half (SD-5), restructured V1d-2 (SD-10, M:335-362, M:150-201): one native
   * <dialog class="a1-slip">, built once and reused. showModal() makes the page underneath inert.
   * `cancel` (Escape) means Keep editing; focus returns to the trigger on every close, explicit
   * rather than relying on <dialog>'s own return-focus behaviour (which targets whatever had
   * focus when showModal() was called, not necessarily the button that started the flow if a
   * prior render moved focus in between). DV-10: a native modal over a ::backdrop dim, not the
   * mock's in-flow .a1-stack/.a1-under -- .a1-seal is still the dialog's own direct child (not
   * inside the scrollable body), so its top overhang is never clipped (risk area 5).
   *
   * V1e-9 follow-up (Reviewer 2 finding 3, G7): a hand-rolled focus trap was previously rejected
   * in favour of relying solely on native showModal() semantics -- live keyboard testing found
   * that relying on the native behaviour alone does not hold here: tabbing forward from the last
   * focusable element (a disabled trailing button, which native Tab correctly skips) released
   * focus to <body>, outside the dialog, once per cycle, rather than wrapping straight back to
   * the dialog's own first focusable element. trapFocus below is attached once, here, on the one
   * reused dialog, so it covers every path that opens it (review, reviewMany, openCustom) without
   * needing to be wired into each one separately.
   */
  function trapFocus(dialog, ev) {
    if (ev.key !== 'Tab') return;
    var focusable = Array.prototype.slice
      .call(dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]'))
      .filter(function (node) {
        return !node.disabled && node.tabIndex !== -1 && node.offsetParent !== null;
      });
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
  var el = window.ScriptoriumAdmin.el;
  var setText = window.ScriptoriumAdmin.setText;
  var api = window.ScriptoriumAdmin.api;
  var icon = window.ScriptoriumAdmin.icon;
  var DIALOG_ID = 'admin-slip';
  var lastTrigger = null;
  // SD-8: the busy contract. review() rebuilds the Save button fresh every time it opens (it's
  // one reused dialog, not one screen with its own init()), so this always points at whichever
  // Save button the most recent open created -- null once nothing has opened the slip yet, and
  // still valid (just pointing at a detached node) after a close, which is harmless.
  var currentSaveBtn = null;

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function buildDialog() {
    var dialog = el('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'a1-slip';

    var titleId = DIALOG_ID + '-title';
    dialog.setAttribute('aria-labelledby', titleId);

    var seal = el('div');
    seal.className = 'a1-seal';
    seal.setAttribute('aria-hidden', 'true');
    setText(seal, 'S');
    dialog.appendChild(seal);

    var body = el('div');
    body.className = 'slip-body';
    body.setAttribute('data-part', 'body');
    dialog.appendChild(body);

    var foot = el('div');
    foot.className = 'slip-foot cf-foot';
    foot.setAttribute('data-part', 'foot');
    dialog.appendChild(foot);

    document.body.appendChild(dialog);

    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      closeDialog();
    });

    dialog.addEventListener('keydown', function (ev) {
      trapFocus(dialog, ev);
    });

    return dialog;
  }

  function dialogEl() {
    return document.getElementById(DIALOG_ID) || buildDialog();
  }

  function closeDialog() {
    var dialog = document.getElementById(DIALOG_ID);
    if (dialog && dialog.open) dialog.close();
    if (lastTrigger && typeof lastTrigger.focus === 'function') lastTrigger.focus();
    lastTrigger = null;
  }

  /** V1d-2 SD-10 (M:1071-1076): the Setting/Now/(arrow)/After save grid. */
  function dfFields(rows) {
    var wrap = el('div');
    wrap.className = 'df-fields';
    wrap.setAttribute('role', 'table');
    wrap.setAttribute('aria-label', 'Settings that change');

    var head = el('div');
    head.className = 'df-fhead';
    head.setAttribute('role', 'row');
    ['Setting', 'Now', '', 'After save'].forEach(function (text) {
      var cell = el('span');
      cell.setAttribute('role', 'columnheader');
      if (text) {
        setText(cell, text);
      } else {
        // The arrow column's own header cell (M:1071's blank <span>): axe's empty-table-header
        // check wants real text, even for a decorative arrow -- a visually-hidden name instead
        // of an empty one.
        var hidden = el('span');
        hidden.className = 'visually-hidden';
        setText(hidden, 'Direction');
        cell.appendChild(hidden);
      }
      head.appendChild(cell);
    });
    wrap.appendChild(head);

    rows.forEach(function (row) {
      var frow = el('div');
      frow.className = 'df-frow';
      frow.setAttribute('role', 'row');

      var where = el('span');
      where.className = 'df-fwhere';
      where.setAttribute('role', 'cell');
      var whereSmall = el('small');
      setText(whereSmall, row.where);
      where.appendChild(whereSmall);
      var whereCode = el('code');
      setText(whereCode, row.key);
      where.appendChild(whereCode);
      frow.appendChild(where);

      var was = el('span');
      was.className = 'df-was';
      was.setAttribute('role', 'cell');
      setText(was, row.now);
      if (row.nowNote) {
        var wasSmall = el('small');
        setText(wasSmall, row.nowNote);
        was.appendChild(wasSmall);
      }
      frow.appendChild(was);

      var arrow = el('span');
      arrow.className = 'df-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      setText(arrow, '→');
      frow.appendChild(arrow);

      var now = el('span');
      now.className = 'df-now';
      now.setAttribute('role', 'cell');
      setText(now, row.after);
      if (row.afterNote) {
        var nowSmall = el('small');
        setText(nowSmall, row.afterNote);
        now.appendChild(nowSmall);
      }
      frow.appendChild(now);

      wrap.appendChild(frow);
    });
    return wrap;
  }

  /** V1d-2 SD-10 (M:1077): a heading plus a ul of effects -- h3, not the mock's own literal h4
   * (M:1077): the slip's own heading sequence is h2.cf-title then this, and axe's heading-order
   * rule refuses an h2-to-h4 skip (found live). warn-level effects (comments-lost, slot-size
   * warnings) keep a colour cue -- not itself mocked (the mock's own .df-effects has no per-item
   * colour), but not contradicted by it either, and worth keeping (D-10 (c) warnings). */
  function dfEffects(effects) {
    var wrap = el('div');
    wrap.className = 'df-effects';
    var heading = el('h3');
    setText(heading, 'Also happens to the file');
    wrap.appendChild(heading);
    var ul = el('ul');
    effects.forEach(function (effect) {
      var li = el('li');
      if (effect.level === 'warn') li.className = 'df-effect-warn';
      setText(li, effect.text);
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    return wrap;
  }

  /** V1d-2 SD-10 (M:165-166): +N/−M, tokenised. */
  function dfCounts(diff) {
    var wrap = el('span');
    wrap.className = 'df-counts';
    var counts = DF.counts(diff.ops);
    var p = el('span');
    p.className = 'p';
    setText(p, '+' + counts.added);
    wrap.appendChild(p);
    var m = el('span');
    m.className = 'm';
    setText(m, ' −' + counts.removed);
    wrap.appendChild(m);
    return wrap;
  }

  /** V1d-2 SD-10 (M:1019-1051, M:181-183): the expanded diff -- a .df-scroll table.df-lines with
   * old/new line numbers, sign and text, using the add/del/gap rows from DF.hunks. Collapsed
   * (`hidden`) by default, matching the mock's own S.raw starting false. */
  function diffToggle(diff) {
    var wrap = el('div');
    if (diff.tooLarge) {
      var tooBig = el('p');
      setText(tooBig, 'This change is too large to preview here.');
      wrap.appendChild(tooBig);
      return wrap;
    }

    var btn = el('button');
    btn.type = 'button';
    btn.className = 'df-toggle';
    btn.setAttribute('aria-expanded', 'false');
    var label = el('span');
    // V1d-2 REWORK: seed the initial label the same way the click handler computes it (SD-10,
    // M:1061 -- `S.raw ? 'Hide' : 'Show'`, with `S.raw` starting false), so the collapsed state
    // reads correctly on first render, not only from the second interaction onward.
    setText(label, 'Show the file diff ');
    btn.appendChild(label);
    btn.appendChild(dfCounts(diff));
    btn.insertBefore(icon('chev'), btn.firstChild);

    var scroll = el('div');
    scroll.className = 'df-scroll';
    scroll.hidden = true;
    // axe scrollable-region-focusable: a horizontally-scrollable region (overflow-x: auto, admin.
    // css) needs to be reachable by keyboard, found live.
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Changed lines in the file, scrollable');
    var table = el('table');
    table.className = 'df-lines';
    table.setAttribute('aria-label', 'Changed lines in the file');
    var tbody = el('tbody');
    DF.hunks(diff.ops, 3).forEach(function (row) {
      var tr = el('tr');
      if (row.gap !== undefined) {
        tr.className = 'df-gap';
        var td = el('td');
        td.colSpan = 4;
        setText(td, row.gap + ' unchanged line' + (row.gap === 1 ? '' : 's'));
        tr.appendChild(td);
      } else {
        tr.className = row.t === '+' ? 'df-add' : row.t === '-' ? 'df-del' : '';
        var oldNo = el('td');
        oldNo.className = 'df-no';
        setText(oldNo, row.o || '');
        tr.appendChild(oldNo);
        var newNo = el('td');
        newNo.className = 'df-no';
        setText(newNo, row.n || '');
        tr.appendChild(newNo);
        var sign = el('td');
        sign.className = 'df-sign';
        setText(sign, row.t === '+' ? '+' : row.t === '-' ? '−' : '');
        tr.appendChild(sign);
        var txt = el('td');
        var code = el('span');
        code.className = 'df-code';
        setText(code, row.s);
        txt.appendChild(code);
        tr.appendChild(txt);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);

    btn.addEventListener('click', function () {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      scroll.hidden = expanded;
      setText(label, (expanded ? 'Show' : 'Hide') + ' the file diff ');
    });

    wrap.appendChild(btn);
    wrap.appendChild(scroll);
    return wrap;
  }

  /** V1d-2 SD-10 (M:252-258): `.a1-btn`, `.primary` for the slip's main action. `iconName` is
   * optional -- several mocked buttons here (Keep editing, Save <file>, Back to overview) carry
   * none. */
  function actionButton(label, level, iconName, onClick) {
    var btn = el('button');
    btn.type = 'button';
    btn.className = 'a1-btn' + (level ? ' ' + level : '');
    setText(btn, label);
    if (iconName) btn.insertBefore(icon(iconName), btn.firstChild);
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** V1d-2 SD-10 (M:1210): the refused outcome (OC's `changed` kind -- pack.toml/vault.config.json
   * changed outside the panel). `.a1-refused` role=alert, strong+detail p, Keep editing then
   * Reload (primary, refresh icon). */
  function buildRefused(outcome) {
    var wrap = el('div');
    wrap.className = 'a1-refused';
    wrap.setAttribute('role', 'alert');
    var strong = el('strong');
    setText(strong, outcome.message || '');
    wrap.appendChild(strong);
    if (outcome.detail) {
      var p = el('p');
      setText(p, outcome.detail);
      wrap.appendChild(p);
    }
    var btns = el('div');
    btns.className = 'cf-btns';
    btns.appendChild(actionButton('Keep editing', null, null, closeDialog));
    btns.appendChild(
      actionButton('Reload', 'primary', 'refresh', function () {
        window.ScriptoriumAdmin.store.allowUnload();
        window.location.reload();
      }),
    );
    wrap.appendChild(btns);
    return wrap;
  }

  /** V1d-2 SD-10 (M:1206): the saved outcome. `.a1-done`, Build preview (primary, play icon)
   * plus Back to overview. `fileBase` is the bare filename (`slip.filePath`'s last segment). */
  function buildDone(fileBase, handlers, plural) {
    var wrap = el('div');
    wrap.className = 'a1-done';
    var eyebrow = el('p');
    eyebrow.className = 'cf-eyebrow';
    setText(eyebrow, 'Saved');
    wrap.appendChild(eyebrow);
    var h2 = el('h2');
    setText(h2, fileBase + (plural ? ' are updated' : ' is updated'));
    wrap.appendChild(h2);
    var p = el('p');
    setText(p, 'Build a preview to see the change.');
    wrap.appendChild(p);
    var btns = el('div');
    btns.className = 'cf-btns';
    btns.appendChild(
      actionButton('Build preview', 'primary', 'play', function () {
        closeDialog();
        if (handlers && handlers.onBuildPreview) handlers.onBuildPreview();
      }),
    );
    btns.appendChild(
      actionButton('Back to overview', null, null, function () {
        closeDialog();
        window.location.hash = '#/overview';
      }),
    );
    wrap.appendChild(btns);
    return wrap;
  }

  /** Every other OC outcome kind (busy/invalid/read-only/io/too-large/unreachable/unknown) is not
   * mocked here at all -- the mock's slip only ever shows ready, refused (`changed`) or saved.
   * Same visual language as the refused block (an alert message), but OC's own variable
   * `actions` list decides the buttons, not a fixed Keep-editing-plus-Reload pair. */
  function buildGenericOutcome(outcome, handlers) {
    var wrap = el('div');
    var message = el('p');
    message.setAttribute('role', outcome.role === 'alert' ? 'alert' : 'status');
    message.className = 'slip-message slip-message-' + outcome.role;
    setText(message, outcome.message || '');
    if (outcome.detail) {
      var detail = el('span');
      detail.className = 'slip-message-detail';
      setText(detail, ' ' + outcome.detail);
      message.appendChild(detail);
    }
    if (outcome.message) wrap.appendChild(message);

    var actions = outcome.actions || [];
    var btns = el('div');
    btns.className = 'cf-btns';
    if (actions.indexOf('keep-editing') !== -1) {
      btns.appendChild(actionButton('Keep editing', null, null, closeDialog));
    }
    if (actions.indexOf('reload') !== -1) {
      btns.appendChild(
        actionButton('Reload', 'primary', 'refresh', function () {
          window.ScriptoriumAdmin.store.allowUnload();
          window.location.reload();
        }),
      );
    }
    if (actions.indexOf('build-preview') !== -1) {
      btns.appendChild(
        actionButton('Build preview', 'primary', 'play', function () {
          closeDialog();
          if (handlers && handlers.onBuildPreview) handlers.onBuildPreview();
        }),
      );
    }
    if (actions.indexOf('overview') !== -1) {
      btns.appendChild(
        actionButton('Back to overview', null, null, function () {
          closeDialog();
          window.location.hash = '#/overview';
        }),
      );
    }
    if (btns.childNodes.length > 0) wrap.appendChild(btns);
    return wrap;
  }

  /**
   * Opens the slip in review mode.
   * @param {{kind, payload, state, dry, advice, path, trigger, extra, onSaved}} args `path` is the
   *   confirm POST route; `extra` is an optional extra DOM node appended after the field rows
   *   (V1e-7, ADR 0039: the Theme review's before/after slip shots); `onSaved` is called (with
   *   the confirm response body) after a successful save, so the caller can clear its own
   *   pending count and refresh.
   */
  function review(args) {
    var slip = buildSlip(args);
    var dryBody = args.dryBody;
    var dialog = dialogEl();
    lastTrigger = args.trigger || null;
    var fileBase = slip.filePath.split('/').pop();

    var body = dialog.querySelector('[data-part="body"]');
    var foot = dialog.querySelector('[data-part="foot"]');
    clear(body);
    clear(foot);

    var titleId = DIALOG_ID + '-title';
    var eyebrow = el('p');
    eyebrow.className = 'cf-eyebrow';
    setText(eyebrow, slip.eyebrow);
    body.appendChild(eyebrow);

    var title = el('h2');
    title.id = titleId;
    title.className = 'cf-title';
    setText(title, slip.title);
    body.appendChild(title);

    var filePath = el('div');
    filePath.className = 'cf-file';
    var filePathCode = el('code');
    setText(filePathCode, slip.filePath);
    filePath.appendChild(filePathCode);
    filePath.appendChild(dfCounts(slip.diff));
    body.appendChild(filePath);

    if (slip.rows.length > 0) body.appendChild(dfFields(slip.rows));
    // V1e-7 (ADR 0039, SD-68): an optional extra node (the Theme review's before/after slip shots).
    if (args.extra) body.appendChild(args.extra);
    if (slip.effects.length > 0) body.appendChild(dfEffects(slip.effects));
    body.appendChild(diffToggle(slip.diff));

    /** Renders an outcome (or restores the ready foot) after a Save attempt. */
    function renderOutcome(outcome, handlers) {
      if (outcome.kind === 'saved') {
        clear(foot);
        clear(body);
        body.appendChild(buildDone(fileBase, handlers));
        return;
      }
      clear(foot);
      if (outcome.kind === 'changed') {
        foot.appendChild(buildRefused(outcome));
        return;
      }
      foot.appendChild(buildGenericOutcome(outcome, handlers));
    }

    // M:1211: the ready foot -- cf-note, then Keep editing before Save <file> (primary).
    var note = el('p');
    note.className = 'cf-note';
    setText(note, slip.foot);
    foot.appendChild(note);

    var btns = el('div');
    btns.className = 'cf-btns';
    btns.appendChild(actionButton('Keep editing', null, null, closeDialog));
    var saveBtn = actionButton(slip.saveLabel, 'primary', null, function () {
      saveBtn.disabled = true;
      api(args.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(confirmBody(dryBody)) })
        .then(function (result) {
          var outcome = mapOutcomeSafe(result, 'save');
          renderOutcome(outcome, { onBuildPreview: args.onBuildPreview });
          if (outcome.kind === 'saved' && args.onSaved) args.onSaved(result.body);
        })
        .catch(function () {
          renderOutcome(mapOutcomeSafe({ ok: false, status: 0, body: null }, 'save'), {});
        });
    });
    // SD-8: the slip's Save "does the same" -- own state here is trivially satisfied (the dry
    // run already succeeded, or the slip would never have opened), so disabled is just busy.
    currentSaveBtn = saveBtn;
    saveBtn.disabled = window.ScriptoriumAdmin.store.isBusy();
    btns.appendChild(saveBtn);
    foot.appendChild(btns);

    if (!dialog.open) dialog.showModal();
  }

  /** OC may not be loaded yet in every consumer context; guarded so a missing OC never throws. */
  function mapOutcomeSafe(result, phase) {
    var OC = window.ScriptoriumAdmin.OC;
    if (!OC) return { kind: 'unknown', role: 'alert', message: 'The save did not go through.', actions: ['reload'] };
    return OC.mapOutcome(result, phase);
  }

  /**
   * V1e-1 (SD-7, D-19): opens the slip in COMBINED review mode, covering up to two files' pending
   * edits in one dialog. `review()` above is byte-unchanged; this is a new, separate entry point.
   * @param {{parts: Array<{kind,payload,dry,dryBody,advice}>, state, trigger, onPartSaved, onDone, onBuildPreview}} args
   */
  function reviewMany(args) {
    var parts = args.parts || [];
    var combined = buildCombined({ parts: parts, state: args.state });
    var dialog = dialogEl();
    lastTrigger = args.trigger || null;

    var body = dialog.querySelector('[data-part="body"]');
    var foot = dialog.querySelector('[data-part="foot"]');
    clear(body);
    clear(foot);

    var titleId = DIALOG_ID + '-title';
    var eyebrow = el('p');
    eyebrow.className = 'cf-eyebrow';
    setText(eyebrow, combined.eyebrow);
    body.appendChild(eyebrow);

    var title = el('h2');
    title.id = titleId;
    title.className = 'cf-title';
    setText(title, combined.title);
    body.appendChild(title);

    combined.files.forEach(function (fileSlip, i) {
      var part = parts[i];
      var filePath = el('div');
      filePath.className = 'cf-file';
      var filePathCode = el('code');
      setText(filePathCode, fileSlip.filePath);
      filePath.appendChild(filePathCode);
      filePath.appendChild(dfCounts(fileSlip.diff));
      body.appendChild(filePath);

      if (fileSlip.rows.length > 0) body.appendChild(dfFields(fileSlip.rows));
      if (fileSlip.effects.length > 0) body.appendChild(dfEffects(fileSlip.effects));

      // The tagline part's ported .vc-bk block (vaultcfg.js:273, vaultcfg.css:139-144): an icon
      // column, then a text column (strong, then p, then code) grouped in their own div.
      if (part.kind === 'tagline') {
        var bk = el('div');
        bk.className = 'vc-bk';
        bk.appendChild(icon('archive'));
        var bkText = el('div');
        var bkStrong = el('strong');
        setText(bkStrong, 'Backed up first');
        bkText.appendChild(bkStrong);
        var bkP = el('p');
        setText(bkP, 'Before writing, the panel copies the current file to');
        bkText.appendChild(bkP);
        var bkCode = el('code');
        setText(bkCode, (part.dry && part.dry.backupDir) || '');
        bkText.appendChild(bkCode);
        bk.appendChild(bkText);
        body.appendChild(bk);
      }

      body.appendChild(diffToggle(fileSlip.diff));
    });

    function renderMultiOutcome(results) {
      clear(foot);
      var summary = partSummary(results, mapOutcomeSafe);
      if (summary.allSaved) {
        clear(body);
        var fileBase =
          combined.files.length > 1 ? 'vault.config.json and vault-config.md' : combined.files[0].filePath.split('/').pop();
        body.appendChild(buildDone(fileBase, { onBuildPreview: args.onBuildPreview }, combined.files.length > 1));
        if (combined.files.length > 1) {
          var taglineIdx = parts.findIndex(function (p) {
            return p.kind === 'tagline';
          });
          var backupPath = taglineIdx !== -1 && results[taglineIdx] && results[taglineIdx].body ? results[taglineIdx].body.backupPath : null;
          if (backupPath) {
            var kept = el('p');
            var keptLabel = el('strong');
            setText(keptLabel, 'Backup kept');
            kept.appendChild(keptLabel);
            var keptCode = el('code');
            setText(keptCode, backupPath);
            kept.appendChild(keptCode);
            body.insertBefore(kept, body.firstChild ? body.firstChild.nextSibling : null);
          }
        }
        return;
      }
      var lines = el('ul');
      lines.className = 'cf-summary';
      summary.lines.forEach(function (line) {
        var li = el('li');
        setText(li, line);
        lines.appendChild(li);
      });
      foot.appendChild(lines);
      var firstFailResult = results.find(function (r) {
        return mapOutcomeSafe(r, 'save').kind !== 'saved';
      });
      foot.appendChild(buildGenericOutcome(mapOutcomeSafe(firstFailResult, 'save'), { onBuildPreview: args.onBuildPreview }));
    }

    var note = el('p');
    note.className = 'cf-note';
    setText(note, combined.foot);
    foot.appendChild(note);

    var btns = el('div');
    btns.className = 'cf-btns';
    btns.appendChild(actionButton('Keep editing', null, null, closeDialog));
    var saveBtn = actionButton(combined.saveLabel, 'primary', null, function () {
      saveBtn.disabled = true;
      var requests = parts.map(function (part) {
        return {
          file: part.dry.file,
          path: part.dry.file === 'vault-config.md' ? '/api/vault-config/tagline' : '/api/pack/settings',
          body: confirmBody(part.dryBody),
        };
      });
      postInOrder(requests, function (req) {
        return api(req.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }).then(function (
          result,
        ) {
          return Object.assign({ file: req.file }, result);
        });
      }).then(function (results) {
        results.forEach(function (result, i) {
          var outcome = mapOutcomeSafe(result, 'save');
          if (outcome.kind === 'saved' && args.onPartSaved) args.onPartSaved(parts[i], result.body);
        });
        renderMultiOutcome(results);
        if (args.onDone) args.onDone(results);
      });
    });
    currentSaveBtn = saveBtn;
    saveBtn.disabled = window.ScriptoriumAdmin.store.isBusy();
    btns.appendChild(saveBtn);
    foot.appendChild(btns);

    if (!dialog.open) dialog.showModal();
  }

  /**
   * V1e-9 (SD-101): opens the one shared dialog for a caller that builds its own body/foot
   * entirely (vaultcfg.js's guarded save/restore review, which doesn't fit review()'s own
   * single-file dryBody shape). `track` is the only way a caller ever assigns currentSaveBtn --
   * the busy subscription below (the frozen line, unchanged) re-evaluates whatever `track` last
   * pointed at.
   *
   * @param {{ trigger: Element|null|undefined, build: (ctx: object) => void }} args
   */
  function openCustom(args) {
    var dialog = dialogEl();
    lastTrigger = args.trigger || null;
    var body = dialog.querySelector('[data-part="body"]');
    var foot = dialog.querySelector('[data-part="foot"]');
    clear(body);
    clear(foot);

    args.build({
      body: body,
      foot: foot,
      titleId: DIALOG_ID + '-title',
      close: closeDialog,
      track: function (btn) {
        currentSaveBtn = btn || null;
      },
      parts: {
        dfFields: dfFields,
        dfEffects: dfEffects,
        dfCounts: dfCounts,
        diffToggle: diffToggle,
        actionButton: actionButton,
        buildRefused: buildRefused,
        buildDone: buildDone,
        buildGenericOutcome: buildGenericOutcome,
        mapOutcome: mapOutcomeSafe,
      },
    });

    if (!dialog.open) dialog.showModal();
  }

  // SD-8: re-evaluate the slip's Save button on a busy change alone (see pack.js's own comment
  // for why this is separate from any full rebuild -- here there is no full-rebuild subscription
  // at all, since review() only ever runs in direct response to a user opening the slip).
  window.ScriptoriumAdmin.store.subscribe(function (next, prev) {
    if (next.busy === prev.busy) return;
    if (currentSaveBtn) currentSaveBtn.disabled = window.ScriptoriumAdmin.store.isBusy();
  });

  window.ScriptoriumAdmin.slip = { review: review, reviewMany: reviewMany, openCustom: openCustom, close: closeDialog };
})();
