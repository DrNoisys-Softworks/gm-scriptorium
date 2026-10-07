'use strict';

/*
 * V1e-9 (ADR 0033 addendum, ADR 0041, SD-100): vc1, the guarded vault-config.md editor. The pure
 * VC half (above the module.exports guard) mirrors r3-src/vaultcfg.js's own pure half, ported
 * from HTML-string building to a plain token/data shape so the browser half below can render it
 * with createElement/textContent only (FR12; no markup-injection sink anywhere in this file). The browser
 * half is called lazily by assets/admin/views.js, once, after its own first renderAll() -- not
 * through ScriptoriumAdmin.register (this is a mount hand-off, not a [data-section]).
 */
(function () {
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var EFFECT_ORDER = { bad: 0, look: 1, ok: 2, info: 3 };

  /**
   * Ported from hlLine (r3-src/vaultcfg.js:104-116). Frontmatter rows only (the fence row and
   * every frontmatter line); the body is never shown (FR32), so `inFrontmatter === false` is
   * never actually reached by this slice's own callers -- kept for interface parity with the
   * mock's own signature.
   *
   * @param {string} line one frontmatter (or fence) line, no EOL
   * @param {boolean} inFrontmatter
   * @returns {{t:'key'|'str'|'fence'|'plain', s:string}[]}
   */
  function tokens(line, inFrontmatter) {
    if (!inFrontmatter) {
      return [{ t: 'plain', s: line }];
    }
    if (line === '---') return [{ t: 'fence', s: '---' }];
    var m = /^(\s*)([A-Za-z0-9_]+)(:)(.*)$/.exec(line);
    if (!m) return [{ t: 'plain', s: line }];
    var out = [];
    if (m[1]) out.push({ t: 'plain', s: m[1] });
    out.push({ t: 'key', s: m[2] });
    out.push({ t: 'plain', s: m[3] });
    var rest = m[4];
    var re = /"(?:[^"\\]|\\.)*"/g;
    var lastIndex = 0;
    var mm;
    while ((mm = re.exec(rest))) {
      if (mm.index > lastIndex) out.push({ t: 'plain', s: rest.slice(lastIndex, mm.index) });
      out.push({ t: 'str', s: mm[0] });
      lastIndex = mm.index + mm[0].length;
    }
    if (lastIndex < rest.length) out.push({ t: 'plain', s: rest.slice(lastIndex) });
    return out;
  }

  var PUBLISH_PRIVACY_PREFIX = 'exclude_';

  /**
   * DV-E9: derived from the file's OWN top-level keys (never the mock's hardcoded MAP).
   *
   * @param {string} text editorText's own shape: frontmatter lines, \n-joined, no EOLs
   * @returns {{label:string, hint:string, line:number|null}[]}
   */
  function fileMap(text) {
    var lines = text.split('\n');
    var out = [];
    var publishChildIndent = null;
    var seen = {};

    function already(key) {
      return Object.prototype.hasOwnProperty.call(seen, key);
    }

    for (var i = 0; i < lines.length; i++) {
      var m = /^(\s*)([A-Za-z0-9_]+):/.exec(lines[i]);
      if (!m) continue;
      var indent = m[1].length;
      var key = m[2];
      var line = i + 2;

      if (indent === 0) {
        if (key === 'publish') continue;
        if (!already('campaign')) {
          out.push({ label: 'Campaign', hint: 'what it is, the system, the year', line: line });
          seen.campaign = true;
        }
        continue;
      }
      if (publishChildIndent === null) publishChildIndent = indent;
      if (indent !== publishChildIndent) continue;

      if (!already('privacy') && (key === 'system' || key === 'mode' || key.indexOf(PUBLISH_PRIVACY_PREFIX) === 0)) {
        out.push({ label: 'Publishing and privacy', hint: 'player mode and the hidden lists', line: line });
        seen.privacy = true;
      } else if (!already('theme') && key === 'theme') {
        out.push({ label: 'Look', hint: 'tagline, colours, fonts, cover art', line: line });
        seen.theme = true;
      } else if (!already('banners') && key === 'banners') {
        out.push({ label: 'Banners', hint: 'the section banners', line: line });
        seen.banners = true;
      } else if (!already('landing') && key === 'landing') {
        out.push({ label: 'Landing page', hint: 'featured characters, quick links, blurbs', line: line });
        seen.landing = true;
      } else if (!already('notfound') && key === 'four_oh_four') {
        out.push({ label: 'Not-found page', hint: 'the 404 message', line: line });
        seen.notfound = true;
      } else if (!already('other') && key !== 'system' && key !== 'mode' && key.indexOf(PUBLISH_PRIVACY_PREFIX) !== 0 && key !== 'theme' && key !== 'banners' && key !== 'landing' && key !== 'four_oh_four') {
        out.push({ label: key, hint: 'other publish settings', line: line });
        seen.other = true;
      }
    }
    out.push({ label: 'Notes', hint: 'your prose, below the frontmatter. The panel never shows or changes it.', line: null });
    return out;
  }

  /** @returns {number[]} file line numbers (frontmatter line n -> file line n + 1) that changed */
  function changedLines(orig, text) {
    var DF = typeof module === 'object' && module.exports ? require('./diff').DF : window.ScriptoriumAdmin.DF;
    var d = DF.diffLines(orig, text);
    var out = [];
    for (var i = 0; i < d.ops.length; i++) {
      if (d.ops[i].t === '+') out.push(d.ops[i].n + 1);
    }
    return out;
  }

  function reviewEnabled(args) {
    return Boolean(args.dirty && args.parseOk && args.parseFresh && args.canEdit && !args.busy);
  }

  function effectsSorted(effects) {
    return effects
      .map(function (e, i) {
        return { e: e, i: i };
      })
      .sort(function (a, b) {
        var d = EFFECT_ORDER[a.e.level] - EFFECT_ORDER[b.e.level];
        return d !== 0 ? d : a.i - b.i;
      })
      .map(function (x) {
        return x.e;
      });
  }

  /** @returns {{level:'ok'|'bad', strong:string, items:string[]}} */
  function checkBlock(check) {
    if (!check || !check.ran) {
      return { level: 'bad', strong: "Check couldn't run on your edited copy.", items: [] };
    }
    var errors = check.counts.error;
    var warns = check.counts.warn;
    if (errors === 0 && warns === 0) {
      return { level: 'ok', strong: 'Check on your edited copy: clean.', items: [' 0 errors, 0 warnings.'] };
    }
    if (check.newCount === 0) {
      return { level: 'ok', strong: 'Check on your edited copy: nothing new.', items: [errors + ' errors and ' + warns + ' warnings, the same as the file now.'] };
    }
    var level = check.newErrorCount > 0 ? 'bad' : 'ok';
    var shown = check.newFindings.slice(0, 5).map(function (f) {
      return f.id + ': ' + f.message;
    });
    if (check.newCount > shown.length) shown.push('and ' + (check.newCount - shown.length) + ' more');
    return { level: level, strong: 'Check on your edited copy: ' + check.newCount + ' new finding(s).', items: shown };
  }

  function ackLabel(reasons) {
    if ((reasons || []).indexOf('privacy') !== -1) return "Save anyway. I want what's listed in red published to players.";
    return "Save anyway. I've read the check results above.";
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** @param {string} taken an ISO instant @param {string} now an ISO instant */
  function backupWhen(taken, now) {
    var t = new Date(taken);
    var n = new Date(now);
    var hh = pad2(t.getHours());
    var mm = pad2(t.getMinutes());
    var isToday = t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth() && t.getDate() === n.getDate();
    if (isToday) return 'Today ' + hh + ':' + mm;
    return MONTHS[t.getMonth()] + ' ' + t.getDate() + ', ' + hh + ':' + mm;
  }

  function sizeLabel(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  function acceptResponse(latestSeq, seq) {
    return seq === latestSeq;
  }

  // ===========================================================================================
  // V1e-10 (SD-113 to SD-115): the pure half of vc2 (unlock by typing the campaign name) and vc3
  // (fields by risk). FIELDS is a client mirror of src/admin/vaultconfigfields.js's FIELD_SCHEMA
  // (drift-tested, test/admin-v1e10-model.test.js).
  // ===========================================================================================

  var FIELDS = [
    { path: 'publish.exclude_fields', kind: 'list', group: 'privacy', label: 'Hidden fields' },
    { path: 'publish.exclude_sections', kind: 'list', group: 'privacy', label: 'Hidden headings' },
    { path: 'publish.exclude_dirs', kind: 'list', group: 'privacy', label: 'Hidden folders' },
    { path: 'publish.landing.featured_npcs', kind: 'list', group: 'safe', label: 'Featured characters' },
    { path: 'publish.landing.quick_links', kind: 'list', group: 'safe', label: 'Quick links' },
    { path: 'publish.landing.max_npcs', kind: 'int', group: 'safe', label: 'How many characters to show', min: 0, max: 100 },
    { path: 'publish.four_oh_four.message', kind: 'string', group: 'safe', label: 'Not-found message', min: 1, max: 300 },
  ];

  var PRIVACY_PATHS = ['publish.exclude_fields', 'publish.exclude_sections', 'publish.exclude_dirs'];

  function fieldByPath(path) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].path === path) return FIELDS[i];
    return null;
  }

  /**
   * SD-113: the unlock gate. Exact equality of the trimmed, lower-cased typed text with the
   * lower-cased campaign name -- never a contains/indexOf match ('xlease' and 'lease2' stay locked).
   * An absent or empty campaign never unlocks.
   */
  function unlockMatches(typed, campaign) {
    if (typeof typed !== 'string' || typeof campaign !== 'string' || campaign === '') return false;
    return typed.trim().toLowerCase() === campaign.toLowerCase();
  }

  /** The value of `path` now: the pending edit if there is one, else the loaded value (a list is never null). */
  function currentValue(fieldsGet, edits, path) {
    if (edits && Object.prototype.hasOwnProperty.call(edits, path)) return edits[path];
    var fields = (fieldsGet && fieldsGet.fields) || [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].path === path) {
        var v = fields[i].value;
        if (fields[i].kind === 'list') return Array.isArray(v) ? v.slice() : [];
        return v;
      }
    }
    return undefined;
  }

  function sameValue(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    return a === b;
  }

  /**
   * Returns a NEW edits object with `path` set to `value`, or with `path` dropped when `value`
   * equals the loaded value (so "edit it back" leaves nothing pending).
   */
  function withEdit(fieldsGet, edits, path, value) {
    var next = {};
    Object.keys(edits || {}).forEach(function (k) {
      if (k !== path) next[k] = edits[k];
    });
    var loaded = currentValue(fieldsGet, {}, path);
    if (!sameValue(loaded, value)) next[path] = value;
    return next;
  }

  /** Number of settings with a pending change. */
  function fieldChangeCount(fieldsGet, edits) {
    var n = 0;
    FIELDS.forEach(function (f) {
      if (edits && Object.prototype.hasOwnProperty.call(edits, f.path) && !sameValue(currentValue(fieldsGet, {}, f.path), edits[f.path])) n++;
    });
    return n;
  }

  /** Entries removed from the three privacy lists by `edits` (the server's review stays authoritative). */
  function fieldRisks(fieldsGet, edits) {
    var n = 0;
    PRIVACY_PATHS.forEach(function (path) {
      if (!edits || !Object.prototype.hasOwnProperty.call(edits, path)) return;
      var before = currentValue(fieldsGet, {}, path);
      var after = edits[path];
      before.forEach(function (x) {
        if (after.indexOf(x) === -1) n++;
      });
    });
    return n;
  }

  /**
   * SD-114: chip flags for the lists. `bad`: an exclude_fields entry no page in the vault carries
   * (usage[x] === 0), with a "Did you mean" when a missing default is the same word bar a trailing
   * s. `new`: an entry added this session. Only flagged entries are listed, in list order.
   *
   * @returns {Object<string, {entry:string, c:'bad'|'new', t:string}[]>} keyed by FIELDS path
   */
  function chipFlags(fieldsGet, edits) {
    var out = {};
    var usage = (fieldsGet && fieldsGet.usage) || {};
    var missing = (fieldsGet && fieldsGet.missingDefaults && fieldsGet.missingDefaults.exclude_fields) || [];
    FIELDS.forEach(function (f) {
      if (f.kind !== 'list') return;
      var now = currentValue(fieldsGet, edits, f.path);
      var was = currentValue(fieldsGet, {}, f.path);
      var flags = [];
      now.forEach(function (x) {
        if (f.path === 'publish.exclude_fields' && Object.prototype.hasOwnProperty.call(usage, x) && usage[x] === 0) {
          var title = 'No page in your vault has a "' + x + '" field.';
          for (var i = 0; i < missing.length; i++) {
            if (missing[i].replace(/s$/, '') === x.replace(/s$/, '')) {
              title += ' Did you mean "' + missing[i] + '"?';
              break;
            }
          }
          flags.push({ entry: x, c: 'bad', t: title });
        } else if (was.indexOf(x) === -1) {
          flags.push({ entry: x, c: 'new', t: 'New' });
        }
      });
      if (flags.length) out[f.path] = flags;
    });
    return out;
  }

  function valueText(entry, v) {
    if (v === undefined || v === null) return 'Not set';
    if (entry.kind === 'list') return v.length ? v.join(', ') : 'Nothing listed';
    return String(v);
  }

  /**
   * SD-114: the rows the review slip's Setting/Now/After grid shows for a field save, in FIELDS order.
   *
   * @returns {{where:string, key:string, now:string, after:string}[]}
   */
  function fieldRows(fieldsGet, edits) {
    var rows = [];
    FIELDS.forEach(function (f) {
      if (!edits || !Object.prototype.hasOwnProperty.call(edits, f.path)) return;
      var was = currentValue(fieldsGet, {}, f.path);
      if (sameValue(was, edits[f.path])) return;
      rows.push({ where: f.label, key: f.path, now: valueText(f, was), after: valueText(f, edits[f.path]) });
    });
    return rows;
  }

  /** SD-115: which kind of edit session a layout belongs to. */
  function viewKind(view) {
    return view === 'vc3' ? 'fields' : 'text';
  }

  function codePoints(s) {
    return Array.from(s).length;
  }

  var CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

  /** A message (label-prefixed) when `value` is not acceptable for the FIELDS entry at `path`, else null. */
  function fieldProblem(path, value) {
    var f = fieldByPath(path);
    if (!f) return 'Unknown setting.';
    if (f.kind === 'int') {
      if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value || value < f.min || value > f.max) {
        return f.label + ': must be a whole number from ' + f.min + ' to ' + f.max + '.';
      }
      return null;
    }
    if (f.kind === 'string') {
      if (typeof value !== 'string') return f.label + ': must be text.';
      var n = codePoints(value);
      if (n < f.min || n > f.max) return f.label + ': must be ' + f.min + ' to ' + f.max + ' characters.';
      if (CONTROL_CHARS.test(value)) return f.label + ": can't hold a line break or other control character.";
      return null;
    }
    return null;
  }

  /** A message when `entry` can't be added to the list at `path` (whose entries now are `list`), else null. */
  function entryProblem(path, list, entry) {
    var f = fieldByPath(path);
    var label = f ? f.label : 'List';
    if (typeof entry !== 'string' || entry !== entry.trim() || entry === '') return label + ': type an entry first.';
    if (codePoints(entry) > 200) return label + ': an entry can be at most 200 characters.';
    if (CONTROL_CHARS.test(entry)) return label + ": an entry can't hold a line break or other control character.";
    if (list.indexOf(entry) !== -1) return '"' + entry + '" is already listed.';
    if (list.length >= 100) return label + ': at most 100 entries.';
    return null;
  }

  /** Display text for a read-only value (colours, fonts, cover art, genre, banners). */
  function displayText(v) {
    if (v === null || v === undefined || v === '') return 'Not set';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.length ? v.map(displayText).join(', ') : 'Not set';
    var keys = Object.keys(v);
    if (!keys.length) return 'Not set';
    return keys
      .map(function (k) {
        var x = v[k];
        return k + ': ' + (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x));
      })
      .join(', ');
  }

  var VC = {
    tokens: tokens,
    fileMap: fileMap,
    changedLines: changedLines,
    reviewEnabled: reviewEnabled,
    effectsSorted: effectsSorted,
    checkBlock: checkBlock,
    ackLabel: ackLabel,
    backupWhen: backupWhen,
    sizeLabel: sizeLabel,
    acceptResponse: acceptResponse,
    FIELDS: FIELDS,
    PRIVACY_PATHS: PRIVACY_PATHS,
    unlockMatches: unlockMatches,
    currentValue: currentValue,
    withEdit: withEdit,
    fieldChangeCount: fieldChangeCount,
    fieldRisks: fieldRisks,
    chipFlags: chipFlags,
    fieldRows: fieldRows,
    viewKind: viewKind,
    fieldProblem: fieldProblem,
    entryProblem: entryProblem,
    displayText: displayText,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { VC: VC };
    return;
  }

  // ===========================================================================================
  // The browser half. DOM only; every string via setText/textContent (FR12). One screen's worth
  // of closure state (this module's `init` runs exactly once, from views.js).
  // ===========================================================================================

  var el = window.ScriptoriumAdmin.el;
  var setText = window.ScriptoriumAdmin.setText;
  var api = window.ScriptoriumAdmin.api;
  var icon = window.ScriptoriumAdmin.icon;
  var store = window.ScriptoriumAdmin.store;

  var RISKS = [
    ['shield', 'It decides what stays private', 'The hidden headings, fields and folders live here. One typo can publish GM notes or secrets to players.'],
    ['warn', 'Every build reads it', 'If the frontmatter stops reading cleanly, check, preview and publish all stop until it is fixed.'],
    ['file', 'Other tools read it too', 'gm-apprentice keeps its own settings here. Change a setting you do not recognise and it may behave differently.'],
  ];
  var PROMISES_TEMPLATE = [
    ['archive', 'A backup before every save', 'The current file is copied to <dir> first. The last 20 are kept.'],
    ['check', 'A review before anything is written', 'Every change listed, with what it does, and the check run on your edited copy.'],
    ['undo', 'One click back', 'Any backup can be restored from this screen.'],
  ];

  var mountEl = null;
  var railHost = null;
  var reqSeq = 0;
  // session !== null while the switch is on (editing). Cleared on save or Stop editing.
  var session = null;
  var pendingHashChange = null;
  var reviewBtnRefs = [];
  var restoreBtnRefs = [];
  // SD-100's own busy contract: the review button's OWN disabled state (dirty/parseOk/parseFresh/
  // canEdit), tracked here so the busy-change subscription (init()) can re-evaluate
  // `reviewBtn.disabled = reviewOwnDisabled || store.isBusy()` without recomputing the whole form.
  var reviewOwnDisabled = true;
  // V1e-10 (SD-113 to SD-115): layout-local state. The unlock is shared by all three layouts
  // (session !== null); everything below is reset when it ends.
  var vc2Open = false;
  var vc2Typed = '';
  var vc3Raw = false;
  var vc3RawView = false;
  var vc3Confirm = null;
  var drafts = {};
  var invalid = {};
  var addOpen = {};
  var lastEffects = null;
  var effectsListener = null;
  var effRailHost = null;
  var inlineEffHost = null;
  var fieldsGet = null;
  var fieldsErr = null;
  var fieldsLoading = false;
  var fieldsSeq = 0;
  var fieldsReviewBtnRefs = [];
  var fieldsReviewOwnDisabled = true;
  var fieldsPendingParts = null;

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function state() {
    return store.get().state || {};
  }

  function editorField() {
    return state().vaultConfigEditor || {};
  }

  function campaign() {
    return store.get().session && store.get().session.campaign;
  }

  function writable() {
    return store.get().session ? store.get().session.writable : true;
  }

  /** Builds a `.vc-code` block: the opening fence, every frontmatter line, the closing fence. */
  function buildCode(text) {
    var code = el('div');
    code.className = 'vc-code';
    // A scrollable region must be keyboard-reachable (axe scrollable-region-focusable, found live
    // in V1e-10's G7 at 390 px).
    code.setAttribute('role', 'region');
    code.setAttribute('aria-label', 'vault-config.md frontmatter');
    code.tabIndex = 0;
    var lines = text.split('\n');

    function row(lineNo, lineText) {
      var ln = el('div');
      ln.className = 'vc-ln';
      var n = el('span');
      n.className = 'n';
      setText(n, String(lineNo));
      ln.appendChild(n);
      var t = el('span');
      t.className = 't';
      VC.tokens(lineText, true).forEach(function (tok) {
        if (tok.t === 'plain') {
          t.appendChild(document.createTextNode(tok.s));
          return;
        }
        var span = el('span');
        span.className = tok.t === 'key' ? 'y-key' : tok.t === 'str' ? 'y-str' : 'y-fence';
        setText(span, tok.s);
        t.appendChild(span);
      });
      ln.appendChild(t);
      return ln;
    }

    code.appendChild(row(1, '---'));
    lines.forEach(function (lineText, i) {
      code.appendChild(row(i + 2, lineText));
    });
    code.appendChild(row(lines.length + 2, '---'));
    return code;
  }

  /**
   * A fixed, non-editable "---" row for buildEditor's own gutter (Reviewer 2 finding 1, G7
   * follow-up): the mock and buildCode above both frame the editable block with these; the
   * editor used to have none. Never part of the textarea's own value or the saved payload --
   * only ever drawn around it. Returns the row element plus its own number span, so the caller
   * can keep the closing row's line number current as the line count changes.
   */
  function fenceRow(lineNo) {
    var ln = el('div');
    ln.className = 'vc-ln-fence';
    var n = el('span');
    n.className = 'n';
    setText(n, String(lineNo));
    ln.appendChild(n);
    var t = el('span');
    t.className = 't';
    var f = el('span');
    f.className = 'y-fence';
    setText(f, '---');
    t.appendChild(f);
    ln.appendChild(t);
    return { el: ln, numEl: n };
  }

  function buildMap(container, text) {
    clear(container);
    var cap = el('div');
    cap.className = 'a1-cap';
    setText(cap, "What's in this file");
    container.appendChild(cap);
    VC.fileMap(text).forEach(function (entry) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'vc-mapi';
      var b = el('b');
      setText(b, entry.label);
      btn.appendChild(b);
      var small = el('small');
      setText(small, entry.hint);
      btn.appendChild(small);
      if (entry.line !== null) {
        var code = el('code');
        setText(code, 'line ' + entry.line);
        btn.appendChild(code);
        btn.addEventListener('click', function () {
          var target = mountEl.querySelector('.vc-ln:nth-child(' + entry.line + ')');
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
        });
      } else {
        btn.disabled = true;
      }
      container.appendChild(btn);
    });
  }

  var inlineMapHost = null;

  /**
   * D-16/SD-104: at wide, the map docks in the screen's own pane (the generic pane system, which
   * frame.js renders for 'dock' mode only); at laptop it is inline above the file (rendered
   * directly here -- the pane system's own 'inline' mode has no built-in renderer anywhere in
   * this codebase, so a screen that wants one builds it itself); at phone it is hidden entirely.
   */
  function syncPlacement() {
    var viewport = store.get().viewport || window.ScriptoriumAdmin.NV.viewportClass(window.innerWidth);
    var view = currentView();
    effRailHost = null;
    inlineEffHost = null;
    if (view === 'vc3') {
      // vc3 has no file map and no rail.
      window.ScriptoriumAdmin.pane.unregister('vault-config');
      railHost = null;
      inlineMapHost = null;
      return;
    }
    if (view === 'vc2' && session !== null && session.kind === 'text' && !mismatchedSession()) {
      // vc2 while editing: "What this changes" replaces the map. At wide it docks in the pane; at
      // laptop and phone renderVc2 puts it inline below the editor.
      railHost = null;
      inlineMapHost = null;
      if (viewport === 'wide') {
        var rail = Object.assign({}, VC2_RAIL, {
          build: function (container) {
            effRailHost = container;
            buildLiveEffects(container);
          },
        });
        window.ScriptoriumAdmin.pane.register('vault-config', rail);
      } else {
        window.ScriptoriumAdmin.pane.unregister('vault-config');
      }
      return;
    }
    if (viewport === 'wide') {
      if (inlineMapHost && inlineMapHost.parentNode) inlineMapHost.parentNode.removeChild(inlineMapHost);
      inlineMapHost = null;
      window.ScriptoriumAdmin.pane.register('vault-config', {
        label: "What's in this file",
        className: 'vc-rail',
        presentation: { wide: 'dock', laptop: null, phone: null },
        hideable: true,
        hiddenPref: 'rail.hidden',
        hiddenAs: 'edge',
        build: function (container) {
          railHost = container;
          buildMap(railHost, editorField().text || '');
        },
      });
      return;
    }
    window.ScriptoriumAdmin.pane.unregister('vault-config');
    railHost = null;
    if (viewport === 'phone') {
      if (inlineMapHost && inlineMapHost.parentNode) inlineMapHost.parentNode.removeChild(inlineMapHost);
      inlineMapHost = null;
      return;
    }
    if (!inlineMapHost) {
      inlineMapHost = el('nav');
      inlineMapHost.className = 'vc-map';
      inlineMapHost.setAttribute('aria-label', "What's in this file");
    }
    buildMap(inlineMapHost, editorField().text || '');
  }

  function refreshMap() {
    if (currentView() === 'vc3') return;
    if (railHost && railHost.isConnected) buildMap(railHost, editorField().text || '');
    if (inlineMapHost && inlineMapHost.isConnected) buildMap(inlineMapHost, editorField().text || '');
  }

  function riskListEl(extraClass) {
    var ul = el('ul');
    ul.className = 'vc-risks' + (extraClass ? ' ' + extraClass : '');
    RISKS.forEach(function (r) {
      var li = el('li');
      li.appendChild(icon(r[0]));
      var div = el('div');
      var b = el('b');
      setText(b, r[1]);
      div.appendChild(b);
      var p = el('p');
      setText(p, r[2]);
      div.appendChild(p);
      li.appendChild(div);
      ul.appendChild(li);
    });
    return ul;
  }

  function promiseListEl(backupDir) {
    var ul = el('ul');
    ul.className = 'vc-prom';
    PROMISES_TEMPLATE.forEach(function (r) {
      var li = el('li');
      li.appendChild(icon(r[0]));
      var div = el('div');
      var b = el('b');
      setText(b, r[1]);
      div.appendChild(b);
      var p = el('p');
      if (r[2].indexOf('<dir>') !== -1) {
        var parts = r[2].split('<dir>');
        p.appendChild(document.createTextNode(parts[0]));
        var code = el('code');
        setText(code, backupDir || '');
        p.appendChild(code);
        p.appendChild(document.createTextNode(parts[1]));
      } else {
        setText(p, r[2]);
      }
      div.appendChild(p);
      li.appendChild(div);
      ul.appendChild(li);
    });
    return ul;
  }

  /** The vc1-dialog's own content (shared by the warning dialog's build). */
  function buildWarningDialogBody(body, ackCheckbox, unlockBtn, backupDir) {
    var band = el('div');
    band.className = 'vc-dband';
    band.appendChild(icon('warn'));
    var bandSpan = el('span');
    setText(bandSpan, 'Careful');
    band.appendChild(bandSpan);
    body.appendChild(band);

    var dbody = el('div');
    dbody.className = 'vc-dbody';
    var h2 = el('h2');
    h2.id = 'vc1-t';
    setText(h2, 'Editing this file can break your site or publish your secrets');
    dbody.appendChild(h2);
    var lede = el('p');
    lede.id = 'vc1-d';
    lede.className = 'vc-lede';
    setText(
      lede,
      'Do this with care, and make sure you have a backup. The panel makes one for you before every save, but a commit of your vault is better still.',
    );
    dbody.appendChild(lede);
    dbody.appendChild(riskListEl());
    var sub = el('div');
    sub.className = 'vc-dsub';
    setText(sub, 'What the panel does for you');
    dbody.appendChild(sub);
    dbody.appendChild(promiseListEl(backupDir));

    var ackLabelEl = el('label');
    ackLabelEl.className = 'st-check vc-ack';
    ackLabelEl.appendChild(ackCheckbox);
    ackLabelEl.appendChild(document.createTextNode(' I understand the risks. Let me edit vault-config.md.'));
    dbody.appendChild(ackLabelEl);

    var btns = el('div');
    btns.className = 'vc-dbtns';
    var cancelBtn = el('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'a1-btn';
    setText(cancelBtn, 'Keep it read-only');
    btns.appendChild(cancelBtn);
    unlockBtn.type = 'button';
    unlockBtn.className = 'a1-btn danger';
    unlockBtn.disabled = true;
    unlockBtn.appendChild(icon('unlock'));
    unlockBtn.appendChild(document.createTextNode('Edit the file'));
    btns.appendChild(unlockBtn);
    dbody.appendChild(btns);

    body.appendChild(dbody);
    return { cancelBtn: cancelBtn };
  }

  /** The leave-with-unsaved-edits dialog, built once. */
  function leaveDialogEl() {
    var existing = document.getElementById('vc-leave-dialog');
    if (existing) return existing;
    var dialog = el('dialog');
    dialog.id = 'vc-leave-dialog';
    dialog.className = 'vc-leave';
    var h2 = el('h2');
    setText(h2, 'Leave with unsaved edits?');
    dialog.appendChild(h2);
    var p = el('p');
    setText(p, "Your edits to vault-config.md aren't saved. Leaving discards them and locks the file again.");
    dialog.appendChild(p);
    var btns = el('div');
    btns.className = 'cf-btns';
    var keepBtn = el('button');
    keepBtn.type = 'button';
    keepBtn.className = 'a1-btn primary';
    setText(keepBtn, 'Keep editing');
    keepBtn.addEventListener('click', function () {
      dialog.close();
    });
    var discardBtn = el('button');
    discardBtn.type = 'button';
    discardBtn.className = 'a1-btn';
    setText(discardBtn, 'Discard and leave');
    discardBtn.addEventListener('click', function () {
      dialog.close();
      var hash = pendingHashChange;
      pendingHashChange = null;
      stopEditing(false);
      if (hash) window.location.hash = hash;
    });
    btns.appendChild(keepBtn);
    btns.appendChild(discardBtn);
    dialog.appendChild(btns);
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      dialog.close();
    });
    return dialog;
  }

  function fineLine() {
    var existing = mountEl.querySelector('[data-part="vc-fine"]');
    if (existing) return existing;
    var p = el('p');
    p.className = 'a1-fine';
    p.setAttribute('role', 'status');
    p.setAttribute('data-part', 'vc-fine');
    return p;
  }

  function setFine(text) {
    var node = fineLine();
    setText(node, text || '');
    if (!node.isConnected && text) mountEl.appendChild(node);
  }

  function resetLayoutState() {
    vc2Open = false;
    vc2Typed = '';
    vc3Raw = false;
    vc3RawView = false;
    vc3Confirm = null;
    drafts = {};
    invalid = {};
    addOpen = {};
    lastEffects = null;
  }

  function stopEditing(announce) {
    session = null;
    resetLayoutState();
    store.set({ vcEditing: false, pending: window.ScriptoriumAdmin.ST.withPending(store.get().pending, 'vault-config', 0) });
    if (announce !== false) setFine('Editing is off. Unsaved edits were discarded.');
    else setFine('Editing is off.');
    render();
  }

  // -- Effects status (debounced) ----------------------------------------------------------------

  var statusTimer = null;

  /** @returns {Promise<{ok:boolean, status:number, body:any}>} resolves to a no-op shape
   * ({ok:false, status:0, body:null}) when a later call supersedes this one (VC.acceptResponse). */
  function scheduleStatus(text) {
    if (statusTimer) window.clearTimeout(statusTimer);
    var seq = ++reqSeq;
    return new Promise(function (resolve, reject) {
      statusTimer = window.setTimeout(function () {
        api('/api/vault-config/effects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frontmatterText: text, baseSha256: session.base }),
        })
          .then(function (result) {
            if (!VC.acceptResponse(reqSeq, seq)) {
              resolve({ ok: false, status: 0, body: null });
              return;
            }
            resolve(result);
          })
          .catch(reject);
      }, 400);
    });
  }

  // -- Editing view ---------------------------------------------------------------------------------

  function buildEditingBanner() {
    var banner = el('div');
    banner.className = 'vc-editing';
    banner.appendChild(icon('unlock'));
    var div = el('div');
    var b = el('b');
    setText(b, 'Editing vault-config.md');
    div.appendChild(b);
    var span = el('span');
    setText(span, 'Nothing is saved until you review it. A backup is made before every save.');
    div.appendChild(span);
    banner.appendChild(div);
    var stopBtn = el('button');
    stopBtn.type = 'button';
    stopBtn.className = 'a1-btn small ghost';
    setText(stopBtn, 'Stop editing');
    stopBtn.addEventListener('click', function () {
      stopEditing(sessionDirty());
    });
    banner.appendChild(stopBtn);
    return banner;
  }

  function buildEditor() {
    var wrap = el('div');
    wrap.className = 'vc-ed';

    var topFence = fenceRow(1);
    topFence.el.setAttribute('aria-hidden', 'true');
    wrap.appendChild(topFence.el);

    var mid = el('div');
    mid.className = 'vc-ed-mid';
    wrap.appendChild(mid);

    var gutter = el('div');
    gutter.className = 'vc-gut';
    gutter.setAttribute('aria-hidden', 'true');
    mid.appendChild(gutter);

    var label = el('label');
    label.className = 'visually-hidden';
    label.setAttribute('for', 'vc-text');
    setText(label, 'vault-config.md');
    mid.appendChild(label);

    var ta = el('textarea');
    ta.id = 'vc-text';
    ta.className = 'vc-ta';
    ta.setAttribute('wrap', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.value = session.current;
    mid.appendChild(ta);

    var bottomFence = fenceRow(2);
    bottomFence.el.setAttribute('aria-hidden', 'true');
    wrap.appendChild(bottomFence.el);

    var statusEl = el('div');
    statusEl.className = 'vc-status';

    var pendingBar = el('div');
    pendingBar.className = 'a1-pending';
    var growEl = el('span');
    growEl.className = 'grow';
    pendingBar.appendChild(growEl);

    var discardBtn = el('button');
    discardBtn.type = 'button';
    discardBtn.className = 'a1-btn ghost';
    setText(discardBtn, 'Discard');
    discardBtn.addEventListener('click', function () {
      ta.value = session.orig;
      onInput();
    });
    pendingBar.appendChild(discardBtn);

    var reviewBtn = el('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'a1-btn primary';
    setText(reviewBtn, 'Review and save');
    reviewBtn.addEventListener('click', function () {
      openReview('text', { frontmatterText: ta.value });
    });
    pendingBar.appendChild(reviewBtn);
    reviewBtnRefs = [reviewBtn];

    function renderGutterAndStatus(parseResult, effectsResult) {
      clear(gutter);
      var lines = ta.value.split('\n');
      setText(bottomFence.numEl, String(lines.length + 2));
      var changed = {};
      VC.changedLines(session.orig, ta.value).forEach(function (fileLine) {
        changed[fileLine - 2] = true;
      });
      var badLine = parseResult && !parseResult.ok ? parseResult.line : null;
      ta.rows = lines.length + 1;
      lines.forEach(function (_, i) {
        var span = el('span');
        var cls = [];
        if (changed[i]) cls.push('chg');
        if (badLine !== null && badLine === i + 2) cls.push('bad');
        span.className = cls.join(' ');
        // File-relative, matching buildCode's own numbering and the status line's own per-line
        // parse-error wording below: the opening fence is line 1, so the first content line is 2.
        setText(span, String(i + 2));
        gutter.appendChild(span);
      });
      wrap.classList.toggle('has-bad', badLine !== null);

      clear(statusEl);
      statusEl.classList.toggle('bad', Boolean(parseResult && !parseResult.ok));
      if (parseResult && !parseResult.ok) {
        statusEl.appendChild(icon('warn'));
        var span1 = el('span');
        setText(span1, 'Line ' + parseResult.line + ': ' + parseResult.message);
        statusEl.appendChild(span1);
      } else {
        statusEl.appendChild(icon('tick'));
        var span2 = el('span');
        setText(span2, 'The frontmatter reads cleanly.');
        statusEl.appendChild(span2);
      }
      var chg = el('span');
      chg.className = 'vc-chg';
      var d = VC.changedLines(session.orig, ta.value);
      setText(chg, d.length ? d.length + ' changed line' + (d.length === 1 ? '' : 's') : 'no changes');
      statusEl.appendChild(chg);

      renderPendingBar(parseResult, effectsResult);
    }

    /** Updates the EXISTING pendingBar elements in place (never rebuilds discardBtn/reviewBtn,
     * so SD-100's busy contract can re-evaluate `reviewBtn.disabled` on its own, independent of a
     * render). */
    function renderPendingBar(parseResult, effectsResult) {
      var dirty = ta.value !== session.orig;
      var badCount = (effectsResult && effectsResult.effects ? effectsResult.effects : []).filter(function (e) {
        return e.level === 'bad';
      }).length;
      pendingBar.classList.toggle('lock', !dirty);
      clear(growEl);
      if (dirty) {
        var dot = el('i');
        dot.className = 'a1-dot';
        growEl.appendChild(dot);
        var span = el('span');
        var d = VC.changedLines(session.orig, ta.value);
        var text = d.length + ' changed line' + (d.length === 1 ? '' : 's');
        if (badCount > 0 && parseResult && parseResult.ok) {
          text += ', including ' + badCount + ' privacy risk' + (badCount === 1 ? '' : 's');
        }
        setText(span, text);
        growEl.appendChild(span);
      } else {
        growEl.appendChild(icon('tick'));
        growEl.appendChild(document.createTextNode('No changes yet.'));
      }

      discardBtn.disabled = !dirty;

      var parseOk = Boolean(parseResult && parseResult.ok);
      reviewOwnDisabled = !VC.reviewEnabled({ dirty: dirty, parseOk: parseOk, parseFresh: true, canEdit: true, busy: false });
      // SD-100's own busy-count literal (3: initial, .then, .catch -- here, the initial site).
      reviewBtn.disabled = reviewOwnDisabled || store.isBusy();

      store.set({ pending: window.ScriptoriumAdmin.ST.withPending(store.get().pending, 'vault-config', VC.changedLines(session.orig, ta.value).length) });
    }

    var latestParse = null;
    var latestEffects = null;

    function onInput() {
      session.current = ta.value;
      if (ta.value !== session.orig) session.view = currentView();
      renderGutterAndStatus(latestParse, latestEffects);
      scheduleStatus(ta.value)
        .then(function (result) {
          if (!result.ok || !result.body) return;
          latestParse = result.body.parse;
          latestEffects = result.body;
          renderGutterAndStatus(latestParse, latestEffects);
          if (effectsListener) effectsListener(result.body);
          // SD-100's own busy-count literal (3: initial, .then, .catch -- here, the .then site).
          reviewBtn.disabled = reviewOwnDisabled || store.isBusy();
        })
        .catch(function () {
          // SD-100's own busy-count literal (3: initial, .then, .catch -- here, the .catch site).
          reviewBtn.disabled = reviewOwnDisabled || store.isBusy();
        });
    }

    ta.addEventListener('input', onInput);
    onInput();

    return { wrap: wrap, statusEl: statusEl, pendingBar: pendingBar, textarea: ta, reviewBtn: reviewBtn };
  }

  // -- The review slip (openCustom) ------------------------------------------------------------

  function buildEffectsListEl(effects, parts, onFix) {
    var ul = el('ul');
    ul.className = 'vc-eff';
    if (effects.length === 0) {
      var p = el('p');
      p.className = 'vc-none';
      p.appendChild(icon('tick'));
      p.appendChild(document.createTextNode('No changes yet.'));
      return p;
    }
    VC.effectsSorted(effects).forEach(function (e) {
      var li = el('li');
      li.className = e.level;
      li.appendChild(icon(e.level === 'bad' ? 'warn' : e.level === 'ok' ? 'tick' : e.level === 'look' ? 'theme' : 'info'));
      var div = el('div');
      var b = el('b');
      setText(b, e.title);
      div.appendChild(b);
      var p = el('p');
      setText(p, e.detail);
      div.appendChild(p);
      if (e.fix) {
        var fixBtn = el('button');
        fixBtn.type = 'button';
        fixBtn.className = 'a1-btn small';
        fixBtn.appendChild(icon('undo'));
        fixBtn.appendChild(document.createTextNode('Put "' + e.fix.entry + '" back'));
        fixBtn.addEventListener('click', function () {
          onFix(e.fix);
        });
        div.appendChild(fixBtn);
      }
      li.appendChild(div);
      ul.appendChild(li);
    });
    return ul;
  }

  function buildCheckBlockEl(check) {
    var block = VC.checkBlock(check);
    var div = el('div');
    div.className = 'vc-check ' + block.level;
    div.appendChild(icon(block.level === 'bad' ? 'warn' : 'tick'));
    var span = el('span');
    var strong = el('b');
    setText(strong, block.strong);
    span.appendChild(strong);
    if (block.items.length) {
      block.items.forEach(function (line) {
        span.appendChild(document.createTextNode(' ' + line));
      });
    }
    div.appendChild(span);
    return div;
  }

  function endpointFor(op) {
    if (op === 'restore') return '/api/vault-config/restore';
    if (op === 'fields') return '/api/vault-config/fields';
    return '/api/vault-config/text';
  }

  /** Re-inserts a privacy-list entry the user removed (server-side: effects route's putBack), then calls done(newText). */
  function putBack(fix, text, done) {
    api('/api/vault-config/effects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frontmatterText: text, baseSha256: session.base, putBack: fix }),
    }).then(function (result) {
      if (!result.ok || !result.body || !result.body.frontmatterText) return;
      if (session) done(result.body.frontmatterText);
    });
  }

  /** The fields layout's Put it back: re-adds the entry at its loaded position (else the end), then re-opens the review. */
  function fieldsPutBack(fix) {
    if (session === null || session.kind !== 'fields') return;
    var list = VC.currentValue(fieldsGet, session.edits, fix.path).slice();
    if (list.indexOf(fix.entry) === -1) {
      var loadedAt = VC.currentValue(fieldsGet, {}, fix.path).indexOf(fix.entry);
      if (loadedAt === -1 || loadedAt > list.length) list.push(fix.entry);
      else list.splice(loadedAt, 0, fix.entry);
    }
    session.edits = VC.withEdit(fieldsGet, session.edits, fix.path, list);
    render();
    openReview('fields', { set: session.edits });
  }

  /**
   * Opens the guarded review slip for a dry-run response (`dry`), for any op. `onSaved` runs
   * after a confirmed save.
   */
  function openGuardedSlip(op, dry, confirmBody, onSaved, trigger) {
    window.ScriptoriumAdmin.slip.openCustom({
      trigger: trigger,
      build: function (ctx) {
        var eyebrow = el('p');
        eyebrow.className = 'cf-eyebrow';
        setText(eyebrow, 'Review before saving');
        ctx.body.appendChild(eyebrow);

        var title = el('h2');
        title.id = ctx.titleId;
        title.className = 'cf-title';
        setText(title, op === 'restore' ? 'Restore vault-config.md' : 'Save vault-config.md');
        ctx.body.appendChild(title);

        if (op === 'restore') {
          var firstLine = el('p');
          setText(
            firstLine,
            'Restoring the backup from ' + VC.backupWhen(dry.backup ? dry.backup.takenAt : new Date().toISOString(), new Date().toISOString()) + '. Only the frontmatter comes back; your notes below it stay as they are now.',
          );
          ctx.body.appendChild(firstLine);
        }

        var fileRow = el('div');
        fileRow.className = 'cf-file';
        var code = el('code');
        setText(code, '_meta/vault-config.md');
        fileRow.appendChild(code);
        var pill = el('span');
        pill.className = 'a1-pill err';
        setText(pill, 'guarded file');
        fileRow.appendChild(pill);
        ctx.body.appendChild(fileRow);

        var df = el('div');
        df.className = 'df';
        if (op === 'fields') df.appendChild(ctx.parts.dfFields(VC.fieldRows(fieldsGet, confirmBody.set)));
        var sliphead = el('div');
        sliphead.className = 'vc-sliphead';
        setText(sliphead, 'What this changes');
        df.appendChild(sliphead);
        df.appendChild(buildEffectsListEl(dry.effects, ctx.parts, function (fix) {
          ctx.close();
          if (op === 'fields') {
            fieldsPutBack(fix);
            return;
          }
          putBack(fix, op === 'restore' ? dry.after : confirmBody.frontmatterText, function (text) {
            session.current = text;
            render();
            openReview('text', { frontmatterText: text });
          });
        }));
        df.appendChild(buildCheckBlockEl(dry.check));
        df.appendChild(ctx.parts.diffToggle(window.ScriptoriumAdmin.DF.diffLines(dry.before, dry.after)));
        ctx.body.appendChild(df);

        var bk = el('div');
        bk.className = 'vc-bk';
        bk.appendChild(icon('archive'));
        var bkDiv = el('div');
        var bkB = el('b');
        setText(bkB, 'Backed up first');
        bkDiv.appendChild(bkB);
        var bkP = el('p');
        setText(bkP, 'Before writing, the panel copies today’s file to');
        bkDiv.appendChild(bkP);
        var bkCode = el('code');
        setText(bkCode, dry.backupDir || '');
        bkDiv.appendChild(bkCode);
        bk.appendChild(bkDiv);
        ctx.body.appendChild(bk);

        dry.notes.forEach(function (note) {
          // A plain paragraph, not a list item: `df` (the line-by-line diff's own container) is
          // a <div>, never a <ul>/<ol>, so an <li> here would be an orphan list item (axe
          // "listitem", found live during G7). No rule anywhere styles this specific element as
          // a list, so a <p> keeps the same look.
          var p = el('p');
          p.className = 'info';
          setText(p, note);
          df.appendChild(p);
        });

        var tick = null;
        if (dry.needsAck) {
          var ackWrap = el('label');
          ackWrap.className = 'st-check vc-saveack';
          tick = el('input');
          tick.type = 'checkbox';
          ackWrap.appendChild(tick);
          ackWrap.appendChild(document.createTextNode(' ' + VC.ackLabel(dry.reasons)));
          ctx.foot.appendChild(ackWrap);
        }

        var note = el('p');
        note.className = 'cf-note';
        setText(note, 'Saving writes this one file and never publishes. Commit your vault too; the panel never commits.');
        ctx.foot.appendChild(note);

        var btns = el('div');
        btns.className = 'cf-btns';
        var keepBtn = el('button');
        keepBtn.type = 'button';
        keepBtn.className = 'a1-btn';
        setText(keepBtn, 'Keep editing');
        keepBtn.addEventListener('click', ctx.close);
        btns.appendChild(keepBtn);

        var saveBtn = el('button');
        saveBtn.type = 'button';
        saveBtn.className = 'a1-btn ' + (dry.needsAck ? 'danger' : 'primary');
        saveBtn.appendChild(icon('archive'));
        saveBtn.appendChild(document.createTextNode('Back up and save'));
        function updateSaveDisabled() {
          saveBtn.disabled = (dry.needsAck && !(tick && tick.checked)) || store.isBusy();
        }
        if (dry.needsAck) {
          ctx.track(null);
          updateSaveDisabled();
          tick.addEventListener('change', function () {
            ctx.track(tick.checked ? saveBtn : null);
            updateSaveDisabled();
          });
        } else {
          ctx.track(saveBtn);
          updateSaveDisabled();
        }
        saveBtn.addEventListener('click', function () {
          saveBtn.disabled = true;
          var body = Object.assign({}, confirmBody, { dryRun: false, saveAnyway: Boolean(tick && tick.checked), reviewedSha256: dry.candidateSha256 });
          api(endpointFor(op), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).then(function (result) {
            var outcome = window.ScriptoriumAdmin.OC.mapOutcome(result, 'save');
            if (outcome.kind === 'saved' || (result.ok && result.body && result.body.ok)) {
              onSaved(result.body);
            } else {
              clear(ctx.foot);
              ctx.foot.appendChild(ctx.parts.buildGenericOutcome(outcome, {}));
            }
          });
        });
        btns.appendChild(saveBtn);
        ctx.foot.appendChild(btns);
        restoreBtnRefs = [];
      },
    });
  }

  function buildSavedDoneBody(bodyEl, footEl, backupPath) {
    clear(bodyEl);
    clear(footEl);
    var eyebrow = el('p');
    eyebrow.className = 'cf-eyebrow';
    setText(eyebrow, 'Saved');
    bodyEl.appendChild(eyebrow);
    var h2 = el('h2');
    setText(h2, 'vault-config.md is updated');
    bodyEl.appendChild(h2);
    var p = el('p');
    setText(p, 'Editing is switched off again.');
    bodyEl.appendChild(p);

    var bk = el('div');
    bk.className = 'vc-bk';
    bk.appendChild(icon('archive'));
    var div = el('div');
    var b = el('b');
    setText(b, 'Backup kept');
    div.appendChild(b);
    var code = el('code');
    setText(code, backupPath || '');
    div.appendChild(code);
    var span = el('span');
    setText(span, 'The file as it was before this save.');
    div.appendChild(span);
    bk.appendChild(div);
    bodyEl.appendChild(bk);

    var list = el('div');
    list.className = 'vc-bklist';
    bodyEl.appendChild(list);
    loadBackupsInto(list, true);

    var actions = el('div');
    actions.className = 'a1-actions';
    var buildBtn = el('button');
    buildBtn.type = 'button';
    buildBtn.className = 'a1-btn primary';
    buildBtn.appendChild(icon('play'));
    buildBtn.appendChild(document.createTextNode('Build preview'));
    buildBtn.addEventListener('click', function () {
      window.ScriptoriumAdmin.slip.close();
      if (window.ScriptoriumAdmin.runs && window.ScriptoriumAdmin.runs.build) window.ScriptoriumAdmin.runs.build();
    });
    actions.appendChild(buildBtn);
    var backBtn = el('button');
    backBtn.type = 'button';
    backBtn.className = 'a1-btn';
    setText(backBtn, 'Back to vault-config.md');
    backBtn.addEventListener('click', function () {
      window.ScriptoriumAdmin.slip.close();
    });
    actions.appendChild(backBtn);
    bodyEl.appendChild(actions);
  }

  function openReview(op, payload) {
    store.set({ busy: 'check' });
    var body = Object.assign({ baseSha256: session.base, dryRun: true }, payload);
    return api(endpointFor(op), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (result) {
        store.set({ busy: null });
        if (!result.ok || !result.body) {
          setFine((result.body && result.body.message) || 'The review could not be run.');
          return;
        }
        var dry = result.body;
        openGuardedSlip(op, dry, body, function (confirmResultBody) {
          window.ScriptoriumAdmin.ST.applySaveResult(store.get().files, confirmResultBody);
          store.set({ files: window.ScriptoriumAdmin.ST.applySaveResult(store.get().files, confirmResultBody) });
          store.load();
          var backupPath = confirmResultBody && confirmResultBody.backupPath;
          var dialog = document.getElementById('admin-slip');
          if (dialog) {
            var bodyEl = dialog.querySelector('[data-part="body"]');
            var footEl = dialog.querySelector('[data-part="foot"]');
            if (bodyEl && footEl) buildSavedDoneBody(bodyEl, footEl, backupPath);
          }
          session = null;
          resetLayoutState();
          store.set({ vcEditing: false, pending: window.ScriptoriumAdmin.ST.withPending(store.get().pending, 'vault-config', 0) });
          setFine('');
          render();
        });
      })
      .catch(function () {
        store.set({ busy: null });
      });
  }

  // -- Backups list ----------------------------------------------------------------------------

  function loadBackupsInto(container, compact) {
    api('/api/vault-config/backups').then(function (result) {
      clear(container);
      if (!result.ok || !result.body || !result.body.available) return;
      var body = result.body;
      if (!compact) {
        var toggle = el('button');
        toggle.type = 'button';
        toggle.className = 'df-toggle';
        var count = el('span');
        setText(count, 'Backups');
        toggle.appendChild(count);
        var small = el('small');
        setText(small, body.items.length + ' of up to ' + body.keep + ', kept in ');
        var code = el('code');
        setText(code, body.dir);
        toggle.appendChild(small);
        toggle.appendChild(code);
        container.appendChild(toggle);
      } else {
        var sub = el('div');
        sub.className = 'st-sub';
        setText(sub, 'Backups');
        var small2 = el('small');
        setText(small2, body.items.length + ' of up to ' + body.keep);
        sub.appendChild(small2);
        container.appendChild(sub);
      }
      body.items.forEach(function (item) {
        var row = el('div');
        row.className = 'vc-bkrow';
        var when = el('span');
        setText(when, VC.backupWhen(item.takenAt, new Date().toISOString()));
        row.appendChild(when);
        var small = el('small');
        setText(small, item.before);
        row.appendChild(small);
        var restoreBtn = el('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'a1-btn small';
        restoreBtn.appendChild(icon('undo'));
        restoreBtn.appendChild(document.createTextNode('Restore'));
        var restoreOwnDisabled = session !== null || !writable() || !item.restorable;
        // SD-100's own busy-count literal (1, at build: a fresh backups list is fetched on every
        // render, so there is no separate update site the way the stable reviewBtn has).
        restoreBtn.disabled = restoreOwnDisabled || store.isBusy();
        restoreBtn._ownDisabled = restoreOwnDisabled;
        var btn = restoreBtn;
        restoreBtnRefs.push(btn);
        btn.addEventListener('click', function () {
          var ed = editorField();
          store.set({ busy: 'check' });
          api('/api/vault-config/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupId: item.id, baseSha256: ed.sha256, dryRun: true }),
          }).then(function (dryResult) {
            store.set({ busy: null });
            if (!dryResult.ok || !dryResult.body) return;
            session = session || { kind: 'text', base: ed.sha256, orig: ed.text, current: ed.text, view: currentView() };
            openGuardedSlip('restore', dryResult.body, { backupId: item.id, baseSha256: ed.sha256 }, function (confirmResultBody) {
              store.load();
              session = null;
              store.set({ vcEditing: false });
              render();
            }, btn);
          });
        });
        row.appendChild(btn);
        container.appendChild(row);
      });
    });
  }

  // -- Top-level render -------------------------------------------------------------------------

  function renderVc1() {
    var ed = editorField();
    var toolbar = el('div');
    toolbar.className = 'vc-tools';
    var sw = el('button');
    sw.type = 'button';
    sw.className = 'a1-switch vc-sw';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', session !== null ? 'true' : 'false');
    var trk = el('span');
    trk.className = 'trk';
    sw.appendChild(trk);
    var swLabel = el('span');
    setText(swLabel, 'Edit this file');
    sw.appendChild(swLabel);
    sw.disabled = !ed.canEdit && session === null;
    toolbar.appendChild(sw);
    if (!ed.canEdit && ed.reason) {
      var hint = el('span');
      hint.className = 'a1-hint';
      setText(hint, ed.reason);
      toolbar.appendChild(hint);
    }
    mountEl.appendChild(toolbar);

    syncPlacement();
    effectsListener = null;

    if (session === null) {
      var rofine = el('p');
      rofine.className = 'a1-fine vc-rofine';
      rofine.appendChild(icon('lock'));
      rofine.appendChild(document.createTextNode(' Read-only. Turn on "Edit this file" to change it; you will see a warning first.'));
      mountEl.appendChild(rofine);
      if (inlineMapHost) mountEl.appendChild(inlineMapHost);
      mountEl.appendChild(buildCode(ed.text || ''));
      if (ed.parse && !ed.parse.ok) {
        var status = el('p');
        status.className = 'vc-status bad';
        setText(status, 'Line ' + ed.parse.line + ': ' + ed.parse.message);
        mountEl.appendChild(status);
      }
      var backupsBlock = el('div');
      backupsBlock.className = 'vc-backups-block';
      mountEl.appendChild(backupsBlock);
      loadBackupsInto(backupsBlock, false);
    } else if (mismatchedSession()) {
      mountEl.appendChild(buildEditingBanner());
      mountEl.appendChild(buildMismatchNote());
      if (inlineMapHost) mountEl.appendChild(inlineMapHost);
      mountEl.appendChild(buildCode(ed.text || ''));
    } else {
      mountEl.appendChild(buildEditingBanner());
      if (inlineMapHost) mountEl.appendChild(inlineMapHost);
      var editorParts = buildEditor();
      mountEl.appendChild(editorParts.wrap);
      mountEl.appendChild(editorParts.statusEl);
      mountEl.appendChild(editorParts.pendingBar);
    }

    sw.addEventListener('click', function () {
      if (session === null) openWarningDialog();
      else stopEditing(sessionDirty());
    });
  }

  // ===========================================================================================
  // V1e-10 (SD-113 to SD-115): vc2 (unlock by typing the campaign name, live "What this changes")
  // and vc3 (fields by risk). One unlock per screen; one edit session of kind 'text' (vc1, vc2,
  // and vc3's "Edit as text instead") or 'fields' (vc3). A layout switch NEVER discards edits.
  // ===========================================================================================

  var VC2_RAIL = {
    label: 'What this changes',
    className: 'vc2-rail',
    presentation: { wide: 'dock', laptop: null, phone: null },
    hideable: true,
    hiddenPref: 'rail.hidden',
    hiddenAs: 'edge',
  };

  function currentView() {
    var NV = window.ScriptoriumAdmin.NV;
    var viewport = store.get().viewport || NV.viewportClass(window.innerWidth);
    return NV.viewFor(store.get().prefs, 'vault-config', viewport);
  }

  function viewOf(snapshot) {
    var NV = window.ScriptoriumAdmin.NV;
    var viewport = snapshot.viewport || NV.viewportClass(window.innerWidth);
    return NV.viewFor(snapshot.prefs, 'vault-config', viewport);
  }

  function layoutName(view) {
    var options = window.ScriptoriumAdmin.NV.VIEWS['vault-config'] || [];
    for (var i = 0; i < options.length; i++) if (options[i].id === view) return options[i].name;
    return 'other';
  }

  /** The kind of session the CURRENT layout edits: vc3 is 'fields' unless its raw text editor is open. */
  function kindForView(view) {
    return view === 'vc3' && vc3Raw ? 'text' : VC.viewKind(view);
  }

  function makeSession(kind, base) {
    var ed = editorField();
    var view = currentView();
    if (kind === 'text') return { kind: 'text', base: base, orig: ed.text, current: ed.text, view: view };
    return { kind: 'fields', base: base, edits: {}, view: view };
  }

  function sessionDirty() {
    if (session === null) return false;
    if (session.kind === 'fields') return VC.fieldChangeCount(fieldsGet, session.edits) > 0;
    return session.current !== session.orig;
  }

  function pendingCount() {
    if (session === null) return 0;
    if (session.kind === 'fields') return VC.fieldChangeCount(fieldsGet, session.edits);
    return VC.changedLines(session.orig, session.current).length;
  }

  /**
   * A clean session follows the layout it is shown in (its kind is re-derived, same unlock, same
   * base). A dirty one never changes kind: the other layout shows a note instead (SD-115).
   */
  function ensureSessionKind() {
    if (session === null) return true;
    var want = kindForView(currentView());
    if (session.kind === want || sessionDirty()) return true;
    if (editorField().sha256 !== session.base) {
      // stopEditing re-renders; the caller must not carry on drawing the stale frame.
      lockForStaleBase();
      return false;
    }
    session = makeSession(want, session.base);
    return true;
  }

  function mismatchedSession() {
    return session !== null && sessionDirty() && session.kind !== kindForView(currentView());
  }

  function buildMismatchNote() {
    var note = el('div');
    note.className = 'a1-note';
    note.appendChild(icon('info'));
    var p = el('p');
    setText(p, 'Your unsaved edits are in the ' + layoutName(session.view) + ' layout. Switch back to review or discard them.');
    note.appendChild(p);
    return note;
  }

  function lockForStaleBase() {
    stopEditing(false);
    setFine('vault-config.md changed while the panel loaded it. Reload.');
  }

  /** Shared by every layout's unlock: refuses a base that drifted while the panel loaded it. */
  function beginSession(kind) {
    var ed = editorField();
    var knownSha = store.baseSha('vault-config.md');
    if (knownSha !== null && ed.sha256 !== knownSha) {
      setFine('vault-config.md changed while the panel loaded it. Reload.');
      render();
      return false;
    }
    session = makeSession(kind, ed.sha256);
    lastEffects = null;
    store.set({ vcEditing: true });
    return true;
  }

  // -- Live effects (vc2) -----------------------------------------------------------------------

  function goToLine(n) {
    var ta = document.getElementById('vc-text');
    if (!ta) return;
    var idx = Math.max(0, n - 2);
    var lines = ta.value.split('\n');
    var pos = 0;
    for (var i = 0; i < idx && i < lines.length; i++) pos += lines[i].length + 1;
    ta.focus();
    try {
      ta.setSelectionRange(pos, pos);
    } catch (e) {
      // a textarea that cannot take a selection still got focus above
    }
  }

  function buildParseBadEl(parse) {
    var ul = el('ul');
    ul.className = 'vc-eff';
    var li = el('li');
    li.className = 'bad';
    li.appendChild(icon('warn'));
    var div = el('div');
    var b = el('b');
    setText(b, "The frontmatter won't read");
    div.appendChild(b);
    var p = el('p');
    setText(p, 'Line ' + parse.line + ': ' + parse.message + ' Check, preview and publish all stop until it reads cleanly.');
    div.appendChild(p);
    if (parse.line !== null && parse.line !== undefined) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'a1-link';
      setText(btn, 'Go to line ' + parse.line);
      btn.addEventListener('click', function () {
        goToLine(parse.line);
      });
      div.appendChild(btn);
    }
    li.appendChild(div);
    ul.appendChild(li);
    return ul;
  }

  /** The "What this changes" content, written into the docked rail or the inline aside alike. */
  function buildLiveEffects(container) {
    clear(container);
    var cap = el('div');
    cap.className = 'a1-cap';
    setText(cap, 'What this changes');
    container.appendChild(cap);
    var res = lastEffects;
    if (res && res.parse && !res.parse.ok) {
      container.appendChild(buildParseBadEl(res.parse));
    } else {
      container.appendChild(
        buildEffectsListEl((res && res.effects) || [], null, function (fix) {
          putBack(fix, session.current, function (text) {
            session.current = text;
            render();
          });
        }),
      );
    }
    var fine = el('p');
    fine.className = 'a1-fine';
    setText(fine, 'Read from your edit as you type. The review shows the same list, plus the line-by-line change.');
    container.appendChild(fine);
  }

  function refreshEffects() {
    if (effRailHost && effRailHost.isConnected) buildLiveEffects(effRailHost);
    if (inlineEffHost && inlineEffHost.isConnected) buildLiveEffects(inlineEffHost);
  }

  function buildSwitchEl(label, on, disabled) {
    var sw = el('button');
    sw.type = 'button';
    sw.className = 'a1-switch vc-sw';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    var trk = el('span');
    trk.className = 'trk';
    sw.appendChild(trk);
    var swLabel = el('span');
    setText(swLabel, label);
    sw.appendChild(swLabel);
    sw.disabled = Boolean(disabled);
    return sw;
  }

  function buildVc2Warn(onUnlock, onCancel) {
    var section = el('section');
    section.className = 'vc2-warn';
    section.setAttribute('aria-labelledby', 'vc2-t');

    var whead = el('div');
    whead.className = 'vc2-whead';
    whead.appendChild(icon('warn'));
    var wdiv = el('div');
    var h2 = el('h2');
    h2.id = 'vc2-t';
    setText(h2, 'Careful: this file controls what players can see');
    wdiv.appendChild(h2);
    var wp = el('p');
    setText(wp, 'Editing it can break your site or publish your secrets. Take care, and make sure you have a backup.');
    wdiv.appendChild(wp);
    whead.appendChild(wdiv);
    section.appendChild(whead);

    section.appendChild(riskListEl('row'));

    var unlock = el('div');
    unlock.className = 'vc2-unlock';
    var typeWrap = el('div');
    typeWrap.className = 'vc2-type';
    var label = el('label');
    label.setAttribute('for', 'vc2-type');
    label.appendChild(document.createTextNode('Type the campaign name, '));
    var code = el('code');
    setText(code, campaign() || '');
    label.appendChild(code);
    label.appendChild(document.createTextNode(', to unlock editing'));
    typeWrap.appendChild(label);
    var input = el('input');
    input.className = 'a1-in mono';
    input.id = 'vc2-type';
    input.type = 'text';
    input.value = vc2Typed;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('placeholder', campaign() || '');
    typeWrap.appendChild(input);
    unlock.appendChild(typeWrap);

    var prom = el('div');
    prom.className = 'vc2-prom';
    prom.appendChild(icon('archive'));
    var promSpan = el('span');
    setText(promSpan, 'A backup is made before every save, and every save is reviewed first.');
    prom.appendChild(promSpan);
    unlock.appendChild(prom);

    var btns = el('div');
    btns.className = 'vc-dbtns';
    var cancelBtn = el('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'a1-btn';
    setText(cancelBtn, 'Keep it read-only');
    btns.appendChild(cancelBtn);
    var unlockBtn = el('button');
    unlockBtn.type = 'button';
    unlockBtn.className = 'a1-btn danger';
    unlockBtn.appendChild(icon('unlock'));
    unlockBtn.appendChild(document.createTextNode('Unlock editing'));
    unlockBtn.disabled = !VC.unlockMatches(vc2Typed, campaign());
    btns.appendChild(unlockBtn);
    unlock.appendChild(btns);
    section.appendChild(unlock);

    // In-place updates only: a re-render on every keystroke would drop the caret.
    input.addEventListener('input', function () {
      vc2Typed = input.value;
      unlockBtn.disabled = !VC.unlockMatches(vc2Typed, campaign());
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && VC.unlockMatches(vc2Typed, campaign())) {
        ev.preventDefault();
        onUnlock();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        onCancel();
      }
    });
    unlockBtn.addEventListener('click', function () {
      if (VC.unlockMatches(vc2Typed, campaign())) onUnlock();
    });
    cancelBtn.addEventListener('click', onCancel);
    return section;
  }

  function renderVc2() {
    var ed = editorField();
    var editing = session !== null;
    var mismatch = mismatchedSession();

    var bar = el('div');
    bar.className = 'vc2-bar' + (vc2Open || editing ? ' on' : '');
    bar.appendChild(icon(editing ? 'unlock' : 'lock'));
    var state = el('span');
    setText(state, editing ? 'Unlocked for editing' : 'Read-only');
    bar.appendChild(state);
    var sw = buildSwitchEl(editing ? 'Editing' : 'Unlock editing', editing || vc2Open, !ed.canEdit && !editing);
    bar.appendChild(sw);
    mountEl.appendChild(bar);
    if (!ed.canEdit && ed.reason && !editing) {
      var hint = el('p');
      hint.className = 'a1-hint';
      setText(hint, ed.reason);
      mountEl.appendChild(hint);
    }

    syncPlacement();

    function closeWarn(announce) {
      vc2Open = false;
      vc2Typed = '';
      render();
      var sw2 = mountEl.querySelector('.vc2-bar .a1-switch');
      if (sw2) sw2.focus();
      if (announce) setFine('Still read-only. Nothing changed.');
    }

    function unlockNow() {
      if (!VC.unlockMatches(vc2Typed, campaign())) return;
      if (!beginSession('text')) return;
      vc2Open = false;
      vc2Typed = '';
      render();
      setFine('');
    }

    sw.addEventListener('click', function () {
      if (editing) {
        stopEditing(sessionDirty());
        return;
      }
      vc2Open = !vc2Open;
      if (!vc2Open) vc2Typed = '';
      render();
      if (vc2Open) {
        var input = document.getElementById('vc2-type');
        if (input) input.focus();
      }
    });

    if (editing && !mismatch) {
      effectsListener = function (body) {
        lastEffects = body;
        refreshEffects();
      };
      mountEl.appendChild(buildEditingBanner());
      var viewport = store.get().viewport || window.ScriptoriumAdmin.NV.viewportClass(window.innerWidth);
      var parts = buildEditor();
      mountEl.appendChild(parts.wrap);
      mountEl.appendChild(parts.statusEl);
      if (viewport !== 'wide') {
        inlineEffHost = el('aside');
        inlineEffHost.className = 'vc2-eff';
        inlineEffHost.setAttribute('aria-label', 'What this changes');
        buildLiveEffects(inlineEffHost);
        mountEl.appendChild(inlineEffHost);
      }
      mountEl.appendChild(parts.pendingBar);
      return;
    }
    effectsListener = null;

    if (mismatch) {
      mountEl.appendChild(buildEditingBanner());
      mountEl.appendChild(buildMismatchNote());
      mountEl.appendChild(buildCode(ed.text || ''));
      return;
    }

    if (vc2Open) {
      mountEl.appendChild(buildVc2Warn(unlockNow, function () {
        closeWarn(true);
      }));
      var dim = el('div');
      dim.className = 'vc2-dim';
      dim.setAttribute('inert', '');
      dim.appendChild(buildCode(ed.text || ''));
      mountEl.appendChild(dim);
      return;
    }

    var rofine = el('p');
    rofine.className = 'a1-fine vc-rofine';
    rofine.appendChild(icon('lock'));
    rofine.appendChild(document.createTextNode(' Read-only. Turn on "Unlock editing" to change it; you will see a warning first.'));
    mountEl.appendChild(rofine);
    if (inlineMapHost) mountEl.appendChild(inlineMapHost);
    mountEl.appendChild(buildCode(ed.text || ''));
    appendReadParseStatus(ed);
    var backupsBlock = el('div');
    backupsBlock.className = 'vc-backups-block';
    mountEl.appendChild(backupsBlock);
    loadBackupsInto(backupsBlock, false);
  }

  function appendReadParseStatus(ed) {
    if (ed.parse && !ed.parse.ok) {
      var status = el('p');
      status.className = 'vc-status bad';
      setText(status, 'Line ' + ed.parse.line + ': ' + ed.parse.message);
      mountEl.appendChild(status);
    }
  }

  // -- vc3: fields by risk ----------------------------------------------------------------------

  function loadFields() {
    if (fieldsLoading) return;
    var sha = editorField().sha256;
    fieldsLoading = true;
    var seq = ++fieldsSeq;
    function done() {
      fieldsLoading = false;
      if (seq === fieldsSeq && currentView() === 'vc3') render();
    }
    api('/api/vault-config/fields')
      .then(function (result) {
        if (seq !== fieldsSeq) {
          fieldsLoading = false;
          return;
        }
        if (result.ok && result.body && result.body.ok) {
          fieldsGet = result.body;
          fieldsErr = null;
        } else {
          fieldsGet = null;
          fieldsErr = { sha: sha, message: (result.body && result.body.message) || "The fields couldn't be loaded." };
        }
        done();
      })
      .catch(function () {
        fieldsGet = null;
        fieldsErr = { sha: sha, message: "The fields couldn't be loaded." };
        done();
      });
  }

  /** True when the fields are ready to draw. Otherwise starts a load (once) and says so. */
  function fieldsReady() {
    var sha = editorField().sha256;
    if (fieldsGet && fieldsGet.sha256 !== sha && !(session !== null && session.kind === 'fields')) fieldsGet = null;
    if (fieldsGet) return true;
    if (fieldsErr && fieldsErr.sha !== sha) fieldsErr = null;
    if (!fieldsErr) loadFields();
    return false;
  }

  function valueOf(path) {
    return VC.currentValue(fieldsGet, session !== null && session.kind === 'fields' ? session.edits : {}, path);
  }

  function buildTierHeader(iconName, title, text, boldText) {
    var header = el('header');
    var h2 = el('h2');
    h2.appendChild(icon(iconName));
    h2.appendChild(document.createTextNode(title));
    header.appendChild(h2);
    var p = el('p');
    p.appendChild(document.createTextNode(text));
    if (boldText) {
      var b = el('b');
      setText(b, boldText);
      p.appendChild(b);
    }
    header.appendChild(p);
    return header;
  }

  function buildDisplayField(label, path, valueNode) {
    var f = el('div');
    f.className = 'vc3-f';
    f.appendChild(buildFieldLabel(label, path, null));
    f.appendChild(valueNode);
    return f;
  }

  function buildFieldLabel(label, path, forId) {
    var node = el(forId ? 'label' : 'div');
    node.className = 'vc3-lab';
    if (forId) node.setAttribute('for', forId);
    node.appendChild(document.createTextNode(label));
    var small = el('small');
    setText(small, path === 'publish.mode' || path.indexOf('publish.exclude_') === 0 ? path : path.replace(/^publish\./, ''));
    node.appendChild(small);
    return node;
  }

  function valText(text, className) {
    var v = el('div');
    v.className = 'vc3-val' + (className ? ' ' + className : '');
    setText(v, text);
    return v;
  }

  function displayEntry(path) {
    var list = (fieldsGet && fieldsGet.display) || [];
    for (var i = 0; i < list.length; i++) if (list[i].path === path) return list[i];
    return { path: path, value: null };
  }

  function buildModeValue() {
    var mode = displayEntry('publish.mode').value;
    var wrap = el('div');
    wrap.className = 'vc3-val';
    var pill = el('span');
    pill.className = 'a1-pill ' + (mode === 'player' ? 'sage' : 'err');
    setText(pill, VC.displayText(mode));
    wrap.appendChild(pill);
    wrap.appendChild(
      document.createTextNode(mode === 'player' ? ' GM-only pages and sections are left out' : ' Anything other than player can publish GM-only pages'),
    );
    return wrap;
  }

  function buildPaletteValue() {
    var pal = displayEntry('publish.theme.palette').value;
    var wrap = el('div');
    wrap.className = 'vc3-pal';
    if (!pal || typeof pal !== 'object' || Array.isArray(pal) || !Object.keys(pal).length) {
      wrap.className = 'vc3-val';
      setText(wrap, VC.displayText(pal));
      return wrap;
    }
    Object.keys(pal).forEach(function (k) {
      var span = el('span');
      var b = el('b');
      setText(b, k);
      span.appendChild(b);
      var code = el('code');
      setText(code, VC.displayText(pal[k]));
      span.appendChild(code);
      wrap.appendChild(span);
    });
    return wrap;
  }

  function buildFontsValue() {
    var fonts = displayEntry('publish.theme.fonts').value;
    var wrap = el('div');
    wrap.className = 'vc3-val';
    if (fonts && typeof fonts === 'object' && !Array.isArray(fonts) && typeof fonts.heading === 'string' && typeof fonts.body === 'string') {
      wrap.appendChild(document.createTextNode('Headings in '));
      var b1 = el('b');
      setText(b1, fonts.heading);
      wrap.appendChild(b1);
      wrap.appendChild(document.createTextNode(', text in '));
      var b2 = el('b');
      setText(b2, fonts.body);
      wrap.appendChild(b2);
    } else {
      setText(wrap, VC.displayText(fonts));
    }
    return wrap;
  }

  function buildCoverValue() {
    var cover = displayEntry('publish.theme.campaign_image').value;
    if (typeof cover !== 'string' || cover === '') return valText('Not set');
    var wrap = el('div');
    wrap.className = 'vc3-val';
    var code = el('code');
    setText(code, cover);
    wrap.appendChild(code);
    return wrap;
  }

  function fieldEntry(path) {
    var list = (fieldsGet && fieldsGet.fields) || [];
    for (var i = 0; i < list.length; i++) if (list[i].path === path) return list[i];
    return null;
  }

  /** One list field: chips (with × while editing), "+ add", the chip-flag titles, missing defaults. */
  function buildChipField(path, editing, focusSpec) {
    var f = VC.FIELDS.filter(function (x) {
      return x.path === path;
    })[0];
    var wrap = el('div');
    wrap.className = 'vc3-f';
    wrap.setAttribute('data-path', path);
    var labelId = 'vc3-l-' + path.replace(/\./g, '-');
    var lab = buildFieldLabel(f.label, path, null);
    lab.id = labelId;
    wrap.appendChild(lab);

    var list = valueOf(path);
    var flags = (VC.chipFlags(fieldsGet, session !== null && session.kind === 'fields' ? session.edits : {})[path]) || [];
    var chips = el('div');
    chips.className = 'vc3-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-labelledby', labelId);
    list.forEach(function (x, idx) {
      var flag = flags.filter(function (g) {
        return g.entry === x;
      })[0];
      var chip = el('span');
      chip.className = 'vc3-chip' + (flag ? ' ' + flag.c : '');
      if (flag) chip.setAttribute('title', flag.t);
      chip.appendChild(document.createTextNode(x));
      if (flag && flag.c === 'bad') {
        var why = el('span');
        why.className = 'visually-hidden';
        setText(why, ' (' + flag.t + ')');
        chip.appendChild(why);
      }
      if (editing) {
        var rm = el('button');
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove ' + x);
        rm.setAttribute('data-chip-idx', String(idx));
        setText(rm, '×');
        rm.addEventListener('click', function () {
          var next = valueOf(path).filter(function (y) {
            return y !== x;
          });
          setFieldValue(path, next, { chip: Math.min(idx, next.length - 1) });
        });
        chip.appendChild(rm);
      }
      chips.appendChild(chip);
    });
    if (editing) {
      var add = el('button');
      add.type = 'button';
      add.className = 'vc3-add';
      add.setAttribute('aria-expanded', addOpen[path] ? 'true' : 'false');
      setText(add, '+ add');
      add.addEventListener('click', function () {
        addOpen[path] = !addOpen[path];
        refreshField(path, addOpen[path] ? { addInput: true } : { addBtn: true });
      });
      chips.appendChild(add);
    }
    wrap.appendChild(chips);

    if (editing && addOpen[path]) {
      var row = el('div');
      row.className = 'vc3-addrow';
      var input = el('input');
      input.className = 'a1-in';
      input.type = 'text';
      input.setAttribute('aria-label', 'Add to ' + f.label);
      input.setAttribute('autocomplete', 'off');
      var addBtn = el('button');
      addBtn.type = 'button';
      addBtn.className = 'a1-btn small';
      setText(addBtn, 'Add');
      var problem = el('p');
      problem.className = 'a1-hint vc3-bad';
      problem.setAttribute('role', 'status');
      function commit() {
        var text = input.value.trim();
        var msg = VC.entryProblem(path, valueOf(path), text);
        if (msg !== null) {
          setText(problem, msg);
          input.setAttribute('aria-invalid', 'true');
          return;
        }
        setFieldValue(path, valueOf(path).concat([text]), { addInput: true });
      }
      addBtn.addEventListener('click', commit);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          addOpen[path] = false;
          refreshField(path, { addBtn: true });
        }
      });
      input.addEventListener('input', function () {
        input.removeAttribute('aria-invalid');
        setText(problem, '');
      });
      row.appendChild(input);
      row.appendChild(addBtn);
      wrap.appendChild(row);
      wrap.appendChild(problem);
    }

    if (path === 'publish.exclude_fields') {
      var missing = ((fieldsGet.missingDefaults && fieldsGet.missingDefaults.exclude_fields) || []).filter(function (d) {
        return !list.some(function (y) {
          return y.toLowerCase() === d.toLowerCase();
        });
      });
      missing.forEach(function (d) {
        var p = el('p');
        p.className = 'vc3-miss';
        p.appendChild(icon('warn'));
        var span = el('span');
        var b = el('b');
        setText(b, d);
        span.appendChild(b);
        var count = (fieldsGet.usage && Object.prototype.hasOwnProperty.call(fieldsGet.usage, d) && fieldsGet.usage[d]) || 0;
        span.appendChild(
          document.createTextNode(' is a default hidden field, and your list no longer includes it.' + (count > 0 ? ' ' + count + ' pages in your vault have one.' : '') + ' '),
        );
        if (editing) {
          var fix = el('button');
          fix.type = 'button';
          fix.className = 'a1-link';
          setText(fix, 'Put it back');
          fix.addEventListener('click', function () {
            setFieldValue(path, valueOf(path).concat([d]), { addBtn: true });
          });
          span.appendChild(fix);
        }
        p.appendChild(span);
        wrap.appendChild(p);
      });
    }
    if (path === 'publish.exclude_sections') {
      var hint = el('p');
      hint.className = 'a1-hint';
      setText(hint, "These combine with vault.config.json's list: a heading named in either stays hidden.");
      wrap.appendChild(hint);
    }

    if (focusSpec) {
      window.setTimeout(function () {
        var target = null;
        if (focusSpec.addInput) target = wrap.querySelector('.vc3-addrow input');
        else if (focusSpec.addBtn) target = wrap.querySelector('.vc3-add');
        else if (focusSpec.chip !== undefined && focusSpec.chip >= 0) target = wrap.querySelector('[data-chip-idx="' + focusSpec.chip + '"]') || wrap.querySelector('.vc3-add');
        else if (focusSpec.chip !== undefined) target = wrap.querySelector('.vc3-add');
        if (target) target.focus();
      }, 0);
    }
    return wrap;
  }

  function refreshField(path, focusSpec) {
    var old = mountEl.querySelector('.vc3-f[data-path="' + path + '"]');
    if (!old) return;
    old.parentNode.replaceChild(buildChipField(path, true, focusSpec), old);
  }

  function setFieldValue(path, value, focusSpec) {
    session.edits = VC.withEdit(fieldsGet, session.edits, path, value);
    session.view = currentView();
    refreshField(path, focusSpec);
    updateFieldsPending();
  }

  /** An editable scalar (int or string): validates on input without re-rendering. */
  function buildScalarField(path, editing) {
    var f = VC.FIELDS.filter(function (x) {
      return x.path === path;
    })[0];
    var wrap = el('div');
    wrap.className = 'vc3-f';
    var id = path === 'publish.landing.max_npcs' ? 'vc3-max' : 'vc3-404';
    var current = valueOf(path);
    var shown = current === null || current === undefined ? '' : String(current);
    if (!editing) {
      wrap.appendChild(buildFieldLabel(f.label, path, null));
      wrap.appendChild(valText(shown === '' ? 'Not set' : shown, f.kind === 'int' ? 'narrow' : ''));
      return wrap;
    }
    wrap.appendChild(buildFieldLabel(f.label, path, id));
    var input = el('input');
    input.id = id;
    input.type = 'text';
    input.className = 'a1-in' + (f.kind === 'int' ? ' narrow' : '');
    if (f.kind === 'int') input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'off');
    input.value = Object.prototype.hasOwnProperty.call(drafts, path) ? drafts[path] : shown;
    var problem = el('p');
    problem.className = 'a1-hint vc3-bad';
    problem.id = id + '-problem';
    problem.setAttribute('role', 'status');
    wrap.appendChild(input);
    wrap.appendChild(problem);
    function validate() {
      var raw = input.value;
      drafts[path] = raw;
      var value;
      if (f.kind === 'int') value = /^\s*\d+\s*$/.test(raw) ? Number(raw.trim()) : NaN;
      else value = raw;
      var msg = VC.fieldProblem(path, value);
      invalid[path] = msg;
      setText(problem, msg || '');
      if (msg) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', problem.id);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
        session.edits = VC.withEdit(fieldsGet, session.edits, path, value);
        session.view = currentView();
      }
      updateFieldsPending();
    }
    input.addEventListener('input', validate);
    if (Object.prototype.hasOwnProperty.call(drafts, path)) {
      var msg0 = invalid[path];
      if (msg0) {
        setText(problem, msg0);
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', problem.id);
      }
    }
    return wrap;
  }

  function buildFieldsGrid(editing) {
    var grid = el('div');
    grid.className = 'vc3-grid';

    var priv = el('section');
    priv.className = 'vc3-tier priv' + (editing ? ' is-live' : '');
    priv.appendChild(
      editing
        ? buildTierHeader('shield', 'Controls privacy', 'What never reaches players. ', 'Removing an entry here publishes it.')
        : buildTierHeader('shield', 'Controls privacy', 'The riskiest part of the file.'),
    );
    priv.appendChild(buildDisplayField('Publish mode', 'publish.mode', buildModeValue()));
    priv.appendChild(buildChipField('publish.exclude_fields', editing, null));
    priv.appendChild(buildChipField('publish.exclude_sections', editing, null));
    priv.appendChild(buildChipField('publish.exclude_dirs', editing, null));
    grid.appendChild(priv);

    var safe = el('section');
    safe.className = 'vc3-tier safe';
    safe.appendChild(buildTierHeader('tick', 'Safe to change', 'Words and picks on the landing and not-found pages.'));
    safe.appendChild(buildChipField('publish.landing.featured_npcs', editing, null));
    safe.appendChild(buildChipField('publish.landing.quick_links', editing, null));
    safe.appendChild(buildScalarField('publish.landing.max_npcs', editing));
    safe.appendChild(buildScalarField('publish.four_oh_four.message', editing));
    grid.appendChild(safe);

    var look = el('section');
    look.className = 'vc3-tier look';
    look.appendChild(buildTierHeader('theme', 'Changes the look', "Colours, fonts and cover art. Mistakes look odd but don't leak anything."));
    look.appendChild(buildDisplayField('Colours', 'publish.theme.palette', buildPaletteValue()));
    look.appendChild(buildDisplayField('Fonts', 'publish.theme.fonts', buildFontsValue()));
    look.appendChild(buildDisplayField('Cover art', 'publish.theme.campaign_image', buildCoverValue()));
    look.appendChild(buildDisplayField('Genre preset', 'publish.theme.genre', valText(VC.displayText(displayEntry('publish.theme.genre').value))));
    look.appendChild(buildDisplayField('Section banners', 'publish.banners', valText(VC.displayText(displayEntry('publish.banners').value))));
    grid.appendChild(look);
    return grid;
  }

  /** "Also in this file: ..." plus the raw-file link ("Show the raw file" read-only, "Edit as text instead" editing). */
  function buildFieldsFine(editing, onRaw) {
    var p = el('p');
    p.className = 'a1-fine';
    var unknown = (fieldsGet && fieldsGet.unknown) || [];
    p.appendChild(
      document.createTextNode('Also in this file: ' + (unknown.length ? unknown.join(', ') + ' and ' : '') + 'your notes below the frontmatter. '),
    );
    var link = el('button');
    link.type = 'button';
    link.className = 'a1-link';
    setText(link, editing ? 'Edit as text instead' : 'Show the raw file');
    link.addEventListener('click', onRaw);
    p.appendChild(link);
    return p;
  }

  /** The inline confirm shown when leaving a dirty session for the other kind of editing. */
  function buildSwitchConfirm(message, discardLabel, keepLabel, onDiscard) {
    var box = el('div');
    box.className = 'a1-note vc3-confirm';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Confirm switching');
    box.appendChild(icon('warn'));
    var div = el('div');
    var p = el('p');
    setText(p, message);
    div.appendChild(p);
    var btns = el('div');
    btns.className = 'vc3-confirm-btns';
    var discard = el('button');
    discard.type = 'button';
    discard.className = 'a1-btn danger small';
    setText(discard, discardLabel);
    discard.addEventListener('click', onDiscard);
    var keep = el('button');
    keep.type = 'button';
    keep.className = 'a1-btn small';
    setText(keep, keepLabel);
    keep.addEventListener('click', function () {
      vc3Confirm = null;
      render();
    });
    btns.appendChild(discard);
    btns.appendChild(keep);
    div.appendChild(btns);
    box.appendChild(div);
    window.setTimeout(function () {
      keep.focus();
    }, 0);
    return box;
  }

  function buildFieldsPendingBar() {
    var bar = el('div');
    bar.className = 'a1-pending';
    var grow = el('span');
    grow.className = 'grow';
    bar.appendChild(grow);
    var discardBtn = el('button');
    discardBtn.type = 'button';
    discardBtn.className = 'a1-btn ghost';
    setText(discardBtn, 'Discard');
    bar.appendChild(discardBtn);
    var fieldsReviewBtn = el('button');
    fieldsReviewBtn.type = 'button';
    fieldsReviewBtn.className = 'a1-btn primary';
    setText(fieldsReviewBtn, 'Review and save');
    bar.appendChild(fieldsReviewBtn);
    fieldsReviewBtnRefs = [fieldsReviewBtn];
    fieldsPendingParts = { grow: grow, bar: bar, discardBtn: discardBtn, reviewBtn: fieldsReviewBtn };

    discardBtn.addEventListener('click', function () {
      session.edits = {};
      drafts = {};
      invalid = {};
      addOpen = {};
      render();
    });
    fieldsReviewBtn.addEventListener('click', function () {
      openReview('fields', { set: session.edits })
        .then(function () {
          fieldsReviewBtn.disabled = fieldsReviewOwnDisabled || store.isBusy();
        })
        .catch(function () {
          fieldsReviewBtn.disabled = fieldsReviewOwnDisabled || store.isBusy();
        });
    });
    return bar;
  }

  /** Updates the existing fields pending bar in place (never rebuilds its buttons). */
  function updateFieldsPending() {
    var parts = fieldsPendingParts;
    if (!parts || session === null || session.kind !== 'fields') return;
    var n = VC.fieldChangeCount(fieldsGet, session.edits);
    var risks = VC.fieldRisks(fieldsGet, session.edits);
    var anyInvalid = Object.keys(invalid).some(function (k) {
      return Boolean(invalid[k]);
    });
    parts.bar.classList.toggle('lock', n === 0);
    clear(parts.grow);
    if (n > 0) {
      var dot = el('i');
      dot.className = 'a1-dot';
      parts.grow.appendChild(dot);
      var span = el('span');
      var text = n + ' change' + (n === 1 ? '' : 's');
      if (risks > 0) text += ', including ' + risks + ' privacy risk' + (risks === 1 ? '' : 's');
      setText(span, text);
      parts.grow.appendChild(span);
    } else {
      parts.grow.appendChild(icon('tick'));
      parts.grow.appendChild(document.createTextNode('No changes yet.'));
    }
    parts.discardBtn.disabled = n === 0 && Object.keys(drafts).length === 0;
    fieldsReviewOwnDisabled = !(n > 0 && !anyInvalid && writable());
    var fieldsReviewBtn = parts.reviewBtn;
    fieldsReviewBtn.disabled = fieldsReviewOwnDisabled || store.isBusy();
    store.set({ pending: window.ScriptoriumAdmin.ST.withPending(store.get().pending, 'vault-config', n) });
  }

  function openFieldsWarning() {
    var dialog = el('dialog');
    dialog.className = 'vc3-drawer a1-drawer';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', 'vc3-t');
    dialog.setAttribute('aria-describedby', 'vc3-d');

    var band = el('div');
    band.className = 'vc-dband';
    band.appendChild(icon('warn'));
    var bandSpan = el('span');
    setText(bandSpan, 'Before you edit');
    band.appendChild(bandSpan);
    dialog.appendChild(band);

    var dbody = el('div');
    dbody.className = 'vc-dbody';
    var h2 = el('h2');
    h2.id = 'vc3-t';
    setText(h2, 'Editing vault-config.md can break your site or publish your secrets');
    dbody.appendChild(h2);
    var lede = el('p');
    lede.id = 'vc3-d';
    lede.className = 'vc-lede';
    setText(lede, 'Take care, and make sure you have a backup.');
    dbody.appendChild(lede);
    dbody.appendChild(riskListEl());
    var sub = el('div');
    sub.className = 'vc-dsub';
    setText(sub, 'What the panel does for you');
    dbody.appendChild(sub);
    dbody.appendChild(promiseListEl(editorField().backupDir));

    var ack = el('input');
    ack.type = 'checkbox';
    ack.id = 'vc3-ack';
    var ackLabel = el('label');
    ackLabel.className = 'st-check vc-ack';
    ackLabel.appendChild(ack);
    ackLabel.appendChild(document.createTextNode(' I understand. Unlock the fields.'));
    dbody.appendChild(ackLabel);

    var btns = el('div');
    btns.className = 'vc-dbtns';
    var cancelBtn = el('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'a1-btn';
    setText(cancelBtn, 'Keep it read-only');
    btns.appendChild(cancelBtn);
    var unlockBtn = el('button');
    unlockBtn.type = 'button';
    unlockBtn.className = 'a1-btn danger';
    unlockBtn.disabled = true;
    unlockBtn.appendChild(icon('unlock'));
    unlockBtn.appendChild(document.createTextNode('Unlock'));
    btns.appendChild(unlockBtn);
    dbody.appendChild(btns);
    dialog.appendChild(dbody);
    document.body.appendChild(dialog);

    function closeAndCleanup() {
      dialog.close();
      document.body.removeChild(dialog);
    }
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      closeAndCleanup();
      setFine('Still read-only. Nothing changed.');
    });
    cancelBtn.addEventListener('click', function () {
      closeAndCleanup();
      setFine('Still read-only. Nothing changed.');
    });
    ack.addEventListener('change', function () {
      unlockBtn.disabled = !ack.checked;
    });
    unlockBtn.addEventListener('click', function () {
      closeAndCleanup();
      var ed = editorField();
      if (!fieldsGet || fieldsGet.sha256 !== ed.sha256) {
        setFine('vault-config.md changed while the panel loaded it. Reload.');
        fieldsGet = null;
        render();
        return;
      }
      if (!beginSession('fields')) return;
      drafts = {};
      invalid = {};
      addOpen = {};
      render();
      setFine('');
    });
    dialog.showModal();
  }

  function renderVc3() {
    var ed = editorField();
    var editing = session !== null;
    var mismatch = mismatchedSession();

    var toolbar = el('div');
    toolbar.className = 'vc-tools';
    var sw = buildSwitchEl('Edit this file', editing, !ed.canEdit && !editing);
    toolbar.appendChild(sw);
    if (!ed.canEdit && ed.reason && !editing) {
      var hint = el('span');
      hint.className = 'a1-hint';
      setText(hint, ed.reason);
      toolbar.appendChild(hint);
    }
    mountEl.appendChild(toolbar);
    sw.addEventListener('click', function () {
      if (editing) stopEditing(sessionDirty());
      else openFieldsWarning();
    });

    syncPlacement();
    effectsListener = null;

    if (editing && session.kind === 'text' && !mismatch) {
      // vc3's raw text editor ("Edit as text instead"): V1e-9's editor, the warning already acknowledged.
      mountEl.appendChild(buildEditingBanner());
      var back = el('p');
      back.className = 'a1-fine';
      var backBtn = el('button');
      backBtn.type = 'button';
      backBtn.className = 'a1-link';
      setText(backBtn, 'Back to the fields');
      backBtn.addEventListener('click', function () {
        if (sessionDirty()) {
          vc3Confirm = 'fields';
          render();
          return;
        }
        vc3Raw = false;
        render();
      });
      back.appendChild(backBtn);
      mountEl.appendChild(back);
      if (vc3Confirm === 'fields') {
        mountEl.appendChild(
          buildSwitchConfirm("Switching back to the fields discards the text changes you haven't saved.", 'Discard and switch', 'Keep editing the text', function () {
            vc3Confirm = null;
            vc3Raw = false;
            session = makeSession('fields', session.base);
            render();
          }),
        );
      }
      var parts = buildEditor();
      mountEl.appendChild(parts.wrap);
      mountEl.appendChild(parts.statusEl);
      mountEl.appendChild(parts.pendingBar);
      return;
    }

    if (mismatch) {
      mountEl.appendChild(buildEditingBanner());
      mountEl.appendChild(buildMismatchNote());
      mountEl.appendChild(buildCode(ed.text || ''));
      return;
    }

    if (!editing && vc3RawView) {
      var backView = el('p');
      backView.className = 'a1-fine';
      var backViewBtn = el('button');
      backViewBtn.type = 'button';
      backViewBtn.className = 'a1-link';
      setText(backViewBtn, 'Back to the fields');
      backViewBtn.addEventListener('click', function () {
        vc3RawView = false;
        render();
      });
      backView.appendChild(backViewBtn);
      mountEl.appendChild(backView);
      mountEl.appendChild(buildCode(ed.text || ''));
      appendReadParseStatus(ed);
      return;
    }

    if (!fieldsReady()) {
      if (fieldsErr) {
        var note = el('div');
        note.className = 'a1-note';
        note.appendChild(icon('info'));
        var np = el('p');
        setText(np, fieldsErr.message);
        note.appendChild(np);
        mountEl.appendChild(note);
        var rawFine = el('p');
        rawFine.className = 'a1-fine';
        var rawBtn = el('button');
        rawBtn.type = 'button';
        rawBtn.className = 'a1-link';
        setText(rawBtn, 'Show the raw file');
        rawBtn.addEventListener('click', function () {
          vc3RawView = true;
          render();
        });
        rawFine.appendChild(rawBtn);
        mountEl.appendChild(rawFine);
      } else {
        var loading = el('p');
        loading.className = 'a1-fine';
        loading.setAttribute('role', 'status');
        setText(loading, 'Loading the fields...');
        mountEl.appendChild(loading);
      }
      return;
    }

    if (editing && session.kind === 'fields' && fieldsGet.sha256 !== session.base) {
      lockForStaleBase();
      return;
    }

    if (!editing) {
      var rofine = el('p');
      rofine.className = 'a1-fine vc-rofine';
      rofine.appendChild(icon('lock'));
      rofine.appendChild(document.createTextNode(' Read-only. Turn on "Edit this file" to change these; you will see a warning first.'));
      mountEl.appendChild(rofine);
      mountEl.appendChild(buildFieldsGrid(false));
      mountEl.appendChild(
        buildFieldsFine(false, function () {
          vc3RawView = true;
          render();
        }),
      );
      var backupsBlock = el('div');
      backupsBlock.className = 'vc-backups-block';
      mountEl.appendChild(backupsBlock);
      loadBackupsInto(backupsBlock, false);
      return;
    }

    // Editing the fields.
    mountEl.appendChild(buildEditingBanner());
    mountEl.appendChild(buildFieldsGrid(true));
    mountEl.appendChild(
      buildFieldsFine(true, function () {
        if (sessionDirty()) {
          vc3Confirm = 'text';
          render();
          return;
        }
        vc3Raw = true;
        session = makeSession('text', session.base);
        render();
      }),
    );
    if (vc3Confirm === 'text') {
      mountEl.appendChild(
        buildSwitchConfirm("Switching to text discards the field changes you haven't saved.", 'Discard and switch', 'Keep the fields', function () {
          vc3Confirm = null;
          vc3Raw = true;
          drafts = {};
          invalid = {};
          session = makeSession('text', session.base);
          render();
        }),
      );
    }
    mountEl.appendChild(buildFieldsPendingBar());
    updateFieldsPending();
  }


  function render() {
    clear(mountEl);
    if (!ensureSessionKind()) return;
    var view = currentView();
    if (view === 'vc2') renderVc2();
    else if (view === 'vc3') renderVc3();
    else renderVc1();
    mountEl.appendChild(fineLine());
    refreshMap();
  }

  function openWarningDialog() {
    var dialog = el('dialog');
    dialog.className = 'vc-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', 'vc1-t');
    dialog.setAttribute('aria-describedby', 'vc1-d');
    var ack = el('input');
    ack.type = 'checkbox';
    ack.id = 'vc1-ack';
    var unlockBtn = el('button');
    unlockBtn.type = 'button';
    var refs = buildWarningDialogBody(dialog, ack, unlockBtn, editorField().backupDir);
    document.body.appendChild(dialog);

    function closeAndCleanup() {
      dialog.close();
      document.body.removeChild(dialog);
    }
    dialog.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      closeAndCleanup();
      setFine('Still read-only. Nothing changed.');
    });
    refs.cancelBtn.addEventListener('click', function () {
      closeAndCleanup();
      setFine('Still read-only. Nothing changed.');
    });
    ack.addEventListener('change', function () {
      unlockBtn.disabled = !ack.checked;
    });
    unlockBtn.addEventListener('click', function () {
      var ed = editorField();
      var knownSha = store.baseSha('vault-config.md');
      closeAndCleanup();
      if (knownSha !== null && ed.sha256 !== knownSha) {
        // Base drifted while the panel loaded it (e.g. another screen's own save): refuse to
        // open a stale session. session stays null, so the switch itself stays off.
        setFine('vault-config.md changed while the panel loaded it. Reload.');
        render();
        return;
      }
      session = makeSession('text', ed.sha256);
      lastEffects = null;
      store.set({ vcEditing: true });
      window.ScriptoriumAdmin.pane.unregister('vault-config');
      render();
      setFine('');
    });
    dialog.showModal();
  }

  function onHashChangeGuard() {
    var route = window.ScriptoriumAdmin.NV.parseFragment(window.location.hash);
    if (route.screen === 'vault-config') return;
    if (session === null) return;
    if (!sessionDirty()) {
      stopEditing(false);
      return;
    }
    pendingHashChange = window.location.hash;
    window.location.hash = '#/vault-config';
    leaveDialogEl().showModal();
  }

  function init(mount) {
    mountEl = mount;
    render();
    window.addEventListener('hashchange', onHashChangeGuard);
    store.subscribe(function (next, prev) {
      if (next.state !== prev.state && session === null) render();
      // A layout switch (a prefs change to this screen's view) or a viewport change re-renders;
      // it never ends the session (SD-115).
      if (next.viewport !== prev.viewport || viewOf(next) !== viewOf(prev)) render();
      if (next.busy !== prev.busy) {
        reviewBtnRefs.forEach(function (btn) {
          btn.disabled = reviewOwnDisabled || store.isBusy();
        });
        restoreBtnRefs.forEach(function (btn) {
          btn.disabled = btn._ownDisabled || store.isBusy();
        });
        fieldsReviewBtnRefs.forEach(function (btn) {
          btn.disabled = fieldsReviewOwnDisabled || store.isBusy();
        });
      }
    });
  }

  window.ScriptoriumAdmin = window.ScriptoriumAdmin || {};
  window.ScriptoriumAdmin.VC = VC;
  window.ScriptoriumAdmin.vaultCfg = { init: init };
})();
