'use strict';

/*
 * Phase 8 slice S4 (FR25). The vocabulary editor, on top of POST /api/pack/vocab and the
 * GET /api/state?include=vocab payload S4 adds. Follows the same two-click save pattern as
 * assets/admin/pack.js (S3): the first POST always carries dryRun:true and shows a before/after
 * diff (plus a comments-lost warning); a second, identical POST without dryRun is the real save.
 * Only the keys the GM actually changed are sent (untouched fields are omitted entirely; a field
 * the GM cleared back to empty is sent as `null`, which removes that key server-side). Everything
 * is rendered with textContent (FR12); no other DOM-injection API appears anywhere in this file
 * (test/admin-assets.test.js enforces the forbidden-token list).
 *
 * admin-fix-1 item 1: buildKindRow().toEntry()'s row->entry logic is a pure function (VB.
 * buildKindEntry below), exported the way assets/site/scriptorium.js exposes CX/PT -- a namespace
 * object plus a guarded `module.exports` -- so it is unit-testable under plain node without a DOM
 * and without adding a dependency. Everything above the `module.exports` guard below never
 * touches ScriptoriumAdmin/document/window, the same reason scriptorium.js keeps its own pure
 * exports above its own guard.
 */
(function () {
  function hasOwn(obj, k) {
    return Object.prototype.hasOwnProperty.call(obj, k);
  }

  var KIND_FIELD_KEYS = ['key', 'label', 'glyph', 'aliases', 'before'];

  /**
   * A single string field (label, glyph): `current`/`initial` are the input's live value and its
   * value at row-construction time. Untouched (`current === initial`) echoes `source[key]`
   * unchanged when it was present on disk, or is omitted (returns undefined) when it was not --
   * FR20's "a save changes only the keys that were edited", applied per-field inside a kind row,
   * not just at the top level. Touched-but-cleared-to-empty is also omitted: `validateLabelString`
   * never accepts an on-disk empty string, so an edited-to-empty field can only ever mean "go back
   * to having no override", never "set it to empty".
   */
  function kindStringFieldValue(current, initial, source, key) {
    if (current === initial) {
      return hasOwn(source, key) ? source[key] : undefined;
    }
    return current === '' ? undefined : current;
  }

  /** Same shape as kindStringFieldValue, for the comma-separated aliases field. */
  function kindAliasesValue(current, initial, source) {
    if (current === initial) {
      return hasOwn(source, 'aliases') ? source.aliases : undefined;
    }
    if (current.trim() === '') return undefined;
    return current
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s.length > 0;
      });
  }

  /** Same shape again, for the `before` checkbox: a boolean has no "empty" edited state, so a
   * genuine touch always carries its new value; only "untouched" can omit. */
  function kindBeforeValue(current, initial, source) {
    if (current === initial) {
      return hasOwn(source, 'before') ? source.before : undefined;
    }
    return current;
  }

  /**
   * Pure: builds the `[[timeline.kinds]]` entry a save should submit for one row, given the
   * on-disk `source` entry (or `{ key: '' }` for a brand-new row -- see buildKindRow below) and
   * the row's live field state. `key` is always required server-side (parseKinds never defaults
   * it), so it is always included; label/glyph/aliases/before are included only when they have a
   * value to report (touched, or present on disk and untouched) -- otherwise they are left off the
   * entry entirely, so the server's own defaulting applies instead of an empty placeholder.
   *
   * @param {object} source the on-disk kind entry (own keys only)
   * @param {{key:string, label:string, labelInitial:string, glyph:string, glyphInitial:string,
   *   aliases:string, aliasesInitial:string, before:boolean, beforeInitial:boolean}} input
   * @returns {object}
   */
  function buildKindEntry(source, input) {
    var out = {};
    for (var k in source) {
      if (hasOwn(source, k) && KIND_FIELD_KEYS.indexOf(k) === -1) out[k] = source[k];
    }
    out.key = input.key;

    var label = kindStringFieldValue(input.label, input.labelInitial, source, 'label');
    if (label !== undefined) out.label = label;

    var glyph = kindStringFieldValue(input.glyph, input.glyphInitial, source, 'glyph');
    if (glyph !== undefined) out.glyph = glyph;

    var aliases = kindAliasesValue(input.aliases, input.aliasesInitial, source);
    if (aliases !== undefined) out.aliases = aliases;

    var before = kindBeforeValue(input.before, input.beforeInitial, source);
    if (before !== undefined) out.before = before;

    return out;
  }

  /*
   * V1b SD-10: vocab.js's field-delta/weights helpers become pure, reproducing vocab.js:164-185
   * and :478-489 exactly. The browser-side per-field wrappers below the guard (fieldDelta(field),
   * commaListDelta(field) taking a {input,initial} field object, and the weightFields.some/every
   * inline check) are removed in favour of calling these directly with the field's live value and
   * initial value -- one function name per behaviour, so there is no same-scope function-name
   * collision between a pure (value, initial) signature and a DOM-bound (field) signature (both
   * live in this same IIFE's closure).
   */
  var COLUMN_KEYS = ['title', 'kind', 'weight', 'place', 'in_game', 'when', 'real_world', 'what', 'session', 'learned', 'after'];

  var LABEL_GROUPS = [
    ['Story timeline', ['learned_lens', 'learned_legend', 'story_lens', 'chapter']],
    ['Recaps', ['recap', 'recap_learned_link', 'same_recap']],
    [
      'Connections',
      [
        'connections_heading',
        'group_tie',
        'group_named',
        'group_pc',
        'group_npc',
        'group_faction',
        'group_location',
        'group_thing',
        'group_event',
        'group_other',
      ],
    ],
  ];

  /** `undefined` when unchanged, `null` when cleared, otherwise the string. */
  function fieldDelta(value, initial) {
    if (value === initial) return undefined;
    return value === '' ? null : value;
  }

  /** `undefined` when unchanged; `null` when cleared; a trimmed, non-empty-filtered string array otherwise. */
  function commaListDelta(value, initial) {
    if (value === initial) return undefined;
    if (value.trim() === '') return null;
    return value
      .split(',')
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s.length > 0;
      });
  }

  /** `undefined` when none of `values` differ from `initials`; `null` when all touched values are cleared to empty; otherwise the array of current values. */
  function weightsDelta(values, initials) {
    var touched = values.some(function (v, i) {
      return v !== initials[i];
    });
    if (!touched) return undefined;
    var allEmpty = values.every(function (v) {
      return v === '';
    });
    return allEmpty ? null : values.slice();
  }

  /** `'unsaved'` when `value` differs from `initial` (touched, not yet saved); otherwise `'yours'` when `onDisk` is truthy, else `'default'`. */
  function fieldState(value, initial, onDisk) {
    if (value !== initial) return 'unsaved';
    return onDisk ? 'yours' : 'default';
  }

  /**
   * `vocab` is a GET /api/state?include=vocab body's `vocab` field ({exists,tables,error,defaults}).
   * `kinds` is the on-disk kind count when timeline.kinds is a real array, else the default count.
   * labels/matching/recaps are fixed (17/16/1): the tab set never varies with vault content.
   */
  function tabCounts(vocab) {
    var defaults = (vocab && vocab.defaults) || {};
    var timelineDefaults = defaults.timeline || {};
    var tables = (vocab && vocab.tables) || null;
    var timeline = (tables && tables.timeline) || null;
    var kindsOnDisk = timeline && Array.isArray(timeline.kinds) ? timeline.kinds : null;
    var kindsDefault = Array.isArray(timelineDefaults.kinds) ? timelineDefaults.kinds : [];
    return {
      labels: 17,
      kinds: kindsOnDisk ? kindsOnDisk.length : kindsDefault.length,
      matching: 16,
      recaps: 1,
    };
  }

  /**
   * The number of distinct edited fields in a vocab save `payload` (labels/recaps object own-keys,
   * timeline.weights/session_token/segment_units/columns/kinds each counted once when present).
   * Used for the nav's "N unsaved changes" pending badge (SD-3's ST.withPending); a residual
   * interpretation since the Engineering Brief names this helper without pinning its exact
   * counting unit -- "one edited field" rather than "one edited character/table" is the reading
   * the pending badge's own text ("N unsaved changes") supports.
   */
  function countChanges(payload) {
    var n = 0;
    if (payload && payload.labels) n += Object.keys(payload.labels).length;
    if (payload && payload.recaps) n += Object.keys(payload.recaps).length;
    if (payload && payload.timeline) {
      var t = payload.timeline;
      if (hasOwn(t, 'weights')) n += 1;
      if (hasOwn(t, 'session_token')) n += 1;
      if (hasOwn(t, 'segment_units')) n += 1;
      if (hasOwn(t, 'columns')) n += Object.keys(t.columns).length;
      if (hasOwn(t, 'kinds')) n += 1;
    }
    return n;
  }

  /*
   * V1e-6 (SD-34): friendly names, group notes, "How to use" copy, synthetic "shows as" samples
   * and the follow-hint table, for vo1's rail and vo3's friendly rows. Every lookup below is
   * against a literal own-property map or a literal array's exact membership -- never a bare
   * object/property read on an attacker- or GM-reachable string (the same 'constructor'/
   * '__proto__' risk nav.js's own comment names).
   */

  // The 9 Connections group keys, named once so sampleFor/followRoleFor never use a prefix/
  // indexOf test against 'group_' (a string-prefix sibling would also match a future unrelated
  // 'group_' key nobody has reviewed for this).
  var GROUP_LABEL_KEYS = [
    'group_tie',
    'group_named',
    'group_pc',
    'group_npc',
    'group_faction',
    'group_location',
    'group_thing',
    'group_event',
    'group_other',
  ];

  // Every LABEL_GROUPS key (17), plus learned_heading (Recaps tab) and the two Patterns keys
  // (session_token, segment_units) -- 20 in all.
  var FRIENDLY_NAMES = {
    learned_lens: 'Timeline tab: what the party learned',
    learned_legend: 'Timeline key: learned facts',
    story_lens: 'Timeline tab: the story',
    chapter: 'Word for a chapter',
    recap: 'Word for a session recap',
    recap_learned_link: "Link to a recap's learned list",
    same_recap: 'Heading: from the same recap',
    connections_heading: 'Connections heading',
    group_tie: 'Group: direct ties',
    group_named: 'Group: pages that name this one',
    group_pc: 'Group: player characters',
    group_npc: 'Group: other people',
    group_faction: 'Group: factions',
    group_location: 'Group: places',
    group_thing: 'Group: things',
    group_event: 'Group: events',
    group_other: 'Group: everything else',
    learned_heading: 'Heading that lists what the party learned',
    session_token: 'How a session is written',
    segment_units: 'How a day or week is written',
  };

  var GROUP_NOTES = {
    'Story timeline': 'On the Timeline page',
    Recaps: 'In links to session recaps',
    Connections: 'On every character, place and faction page',
  };

  /** The friendly name for a vocabulary key, or null. An own-property lookup only. */
  function friendlyName(key) {
    return hasOwn(FRIENDLY_NAMES, key) ? FRIENDLY_NAMES[key] : null;
  }

  // DV-E44: two lines the mock states as true for every vault are reworded here (kinds' "One
  // thing to know" and matching's "Columns") -- everything else is the mock's own copy
  // (r3-src/vocab.js:148-166), unchanged.
  var HOW = {
    labels: [
      [
        'What these are',
        "The words your player site uses for its own headings, tabs and groups. Your notes aren't touched; only the site's wording changes.",
      ],
      ['To change one', 'Type the new word. Leave the box empty and the default (shown faintly in the box) comes back.'],
      [
        'Where they show',
        'Story timeline words are on the Timeline page. Connections words are on every character, place and faction page. Recap words are in links to session recaps.',
      ],
      ['Saving', 'Nothing changes until Review and save, which lists every word before and after. Then build a preview to see them in place.'],
    ],
    kinds: [
      ['What kinds are', 'Each row on your Timeline page has a Kind: fight, meeting and so on. The kind picks the icon and colour on the timeline.'],
      [
        'Aliases',
        'An alias lets a Kind cell say something else and still count. Give meeting the alias "parley" and rows that say parley draw as meetings.',
      ],
      ['Before', 'A "before" kind happened before the campaign began. It sits at the start of the timeline and draws as a star.'],
      ['One thing to know', 'Kinds are saved as a set. Change one and the whole set is written into pack.toml, unchanged ones included.'],
    ],
    matching: [
      [
        'Weights',
        "A Timeline row's Weight is 1, 2 or 3. These are the names the site shows for them, from a quiet aside to a turning point.",
      ],
      [
        'Patterns',
        'How the site finds a session number and an in-game day in your Timeline text. Only change these if your Timeline is written differently; each box shows how your own rows read.',
      ],
      ['Columns', 'The header names each Timeline column may use. Change these only if your Timeline uses different headers.'],
    ],
    recaps: [
      [
        'What this is',
        'The heading in each session recap that lists what the party learned. The site uses it to build the "learned" view of the timeline.',
      ],
      ['Matching', 'It ignores case, so "What the Party Learned" and "what the party learned" both match.'],
    ],
  };

  /** The "How to use" [title, body] pairs for a tab id, or null for an unknown one. */
  function howFor(tabId) {
    return hasOwn(HOW, tabId) ? HOW[tabId] : null;
  }

  /**
   * A synthetic "shows as" sample for a labels-tab or recaps-tab key, built from generic invented
   * text (NFR-11: no mock sample-campaign string is ever copied here). Returns
   * `{kind, label, text, suffix, glyph}` or null for a key with no sample (the Patterns tab's
   * session_token/segment_units, which get a friendly name but no sample chip -- their own hint
   * text already shows how the GM's rows read).
   */
  function sampleFor(key, text) {
    text = text === undefined || text === null ? '' : text;
    if (key === 'learned_lens') return { kind: 'lens on', label: 'shows as', text: text };
    if (key === 'story_lens') return { kind: 'lens', label: 'shows as', text: text };
    if (key === 'learned_legend') return { kind: 'legend', label: 'shows as', text: text, glyph: 'learned' };
    if (key === 'chapter') return { kind: 'meta', label: 'shows as', text: text + ' 3, A sample title' };
    if (key === 'recap') return { kind: 'link', label: 'shows as', text: text + ' III, A sample title' };
    if (key === 'recap_learned_link') return { kind: 'link', label: 'shows as', text: 'Recap III, A sample title: ' + text };
    if (key === 'same_recap') return { kind: 'grp', label: 'shows as', text: text };
    if (key === 'connections_heading') return { kind: 'head', label: 'shows as', text: text };
    if (key === 'learned_heading') return { kind: 'head', label: 'matches', text: '## ' + text };
    if (GROUP_LABEL_KEYS.indexOf(key) !== -1) return { kind: 'grp', label: 'shows as', text: text, suffix: '2' };
    return null;
  }

  /**
   * FR-19's Vocabulary half: which page role the live preview should follow for a tab (and, on
   * the labels tab, a focused key). An unknown tab falls back to 'timeline', the same as kinds
   * and matching.
   */
  function followRoleFor(tabId, focusedKey) {
    if (tabId === 'labels') {
      if (focusedKey === 'same_recap' || focusedKey === 'connections_heading' || GROUP_LABEL_KEYS.indexOf(focusedKey) !== -1) {
        return 'character';
      }
      return 'timeline';
    }
    if (tabId === 'recaps') return 'recap';
    return 'timeline';
  }

  /*
   * V1e-8 (ADR 0039 addendum, SD-71, SD-73). vo2's rail caption text: which real page the
   * example shows (EXAMPLE_CAPTIONS, keyed by the follow role followRoleFor already returns),
   * and what to say about the FOCUSED field or tab (exampleFocus). Both are pure: exampleFocus's
   * only DOM-shaped read is `field.input.value`/`.placeholder`/`.initial`, passed in by the
   * caller, never looked up here.
   */
  var EXAMPLE_CAPTIONS = {
    timeline: 'The Timeline page',
    character: 'A character page, Connections',
    recap: 'A session recap',
  };

  var EXAMPLE_FOCUS_TAB_TEXT = {
    labels: 'The Labels tab',
    kinds: 'Timeline kinds',
    matching: 'How weights and days read',
    recaps: 'The learned heading',
  };

  /**
   * @param {string} tabId the vo2 rail's own current tab (vocab's TABS ids)
   * @param {string|null} key the focused labels-tab field's key, or null
   * @param {{input:{value:string,placeholder:string},initial:string}|null} field the focused
   *   field object (labelsFields[key] shape), or null when nothing is focused / not on labels
   * @returns {{kind:'label',key:string,before:string,after:string}|{kind:'tab',text:string}}
   */
  function exampleFocus(tabId, key, field) {
    if (tabId === 'labels' && field) {
      return {
        kind: 'label',
        key: key,
        before: field.initial || field.input.placeholder,
        after: field.input.value || field.input.placeholder,
      };
    }
    return { kind: 'tab', text: hasOwn(EXAMPLE_FOCUS_TAB_TEXT, tabId) ? EXAMPLE_FOCUS_TAB_TEXT[tabId] : 'The Labels tab' };
  }

  var VB = {
    buildKindEntry: buildKindEntry,
    KIND_FIELD_KEYS: KIND_FIELD_KEYS,
    LABEL_GROUPS: LABEL_GROUPS,
    COLUMN_KEYS: COLUMN_KEYS,
    fieldDelta: fieldDelta,
    commaListDelta: commaListDelta,
    weightsDelta: weightsDelta,
    fieldState: fieldState,
    tabCounts: tabCounts,
    countChanges: countChanges,
    // V1e-6 additions (SD-34):
    GROUP_LABEL_KEYS: GROUP_LABEL_KEYS,
    FRIENDLY_NAMES: FRIENDLY_NAMES,
    GROUP_NOTES: GROUP_NOTES,
    friendlyName: friendlyName,
    HOW: HOW,
    howFor: howFor,
    sampleFor: sampleFor,
    followRoleFor: followRoleFor,
    // V1e-8 additions (SD-71, SD-73):
    EXAMPLE_CAPTIONS: EXAMPLE_CAPTIONS,
    exampleFocus: exampleFocus,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = { VB: VB };
    return;
  }

  var api = ScriptoriumAdmin.api;
  var el = ScriptoriumAdmin.el;
  var setText = ScriptoriumAdmin.setText;
  var store = ScriptoriumAdmin.store;
  var icon = ScriptoriumAdmin.icon;

  /*
   * Panel v2 V1b (FR-09), restructured V1d-2 (SD-10, M:295-334). Rebuilt on the store (SD-3/SD-7)
   * with a WAI-ARIA tabs pattern over the same four groups the payload already had (Labels,
   * Timeline kinds, Weights and matching, Recaps -- VB.tabCounts' own grouping). The
   * payload-construction logic below (buildKindRow, buildPayload) is unchanged from
   * S4/admin-fix-1/V1d-2; only the chrome around it and the save flow (through the sealed slip)
   * are new.
   */

  // Independent literals (never re-derived from src/build/labels.js -- this is a plain browser
  // script with no build step, and the server already validates against its own copies).
  var LABEL_KEYS = [
    'learned_lens',
    'learned_legend',
    'story_lens',
    'chapter',
    'recap',
    'recap_learned_link',
    'same_recap',
    'connections_heading',
    'group_tie',
    'group_named',
    'group_pc',
    'group_npc',
    'group_faction',
    'group_location',
    'group_thing',
    'group_event',
    'group_other',
  ];
  // COLUMN_KEYS moved above the guard (SD-10): now VB.COLUMN_KEYS, same closure, same variable.

  var TABS = [
    { id: 'labels', label: 'Labels' },
    { id: 'kinds', label: 'Timeline kinds' },
    { id: 'matching', label: 'Weights and matching' },
    { id: 'recaps', label: 'Recaps' },
  ];

  // V1e-6 (SD-35): the real, drawable kind glyphs (icons.js's IC.GLYPH_NAMES), named again here
  // as a plain browser-script literal (no build step to import it from) -- the vo3 "in the key"
  // legend chip only draws an icon for one of these; any other typed glyph value (a raw SVG path,
  // or nothing yet) shows the label alone, the same way an unrecognised glyph falls back to the
  // neutral colour rather than a specific icon.
  var KIND_GLYPH_NAMES = ['backstory', 'discovery', 'fight', 'journey', 'learned', 'meeting'];

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function mapOutcomeSafe(result, phase) {
    return ScriptoriumAdmin.OC.mapOutcome(result, phase);
  }

  function renderBanner(box, outcome) {
    clear(box);
    if (!outcome || !outcome.message) return;
    var p = el('p');
    p.setAttribute('role', outcome.role === 'alert' ? 'alert' : 'status');
    p.className = 'vocab-outcome vocab-outcome-' + outcome.role;
    setText(p, outcome.message);
    if (outcome.detail) {
      var detail = el('span');
      setText(detail, ' ' + outcome.detail);
      p.appendChild(detail);
    }
    box.appendChild(p);
  }

  // SD-8: the busy contract. See pack.js's own comment for why this is a busy-only-change
  // subscription, separate from the state/pending re-render.
  var vocabReviewBtn = null;
  var vocabOwnDisabled = false;

  // V1e-6 (SD-37): whether the vo3 "How to use" note has been dismissed. A module variable, a
  // residual (Part 10 item 6): it lasts for this page session only, not across a relaunch.
  var voNoteDismissed = false;

  // V1e-6 (SD-36): the latest buildForm() render's own rail/tools refresh function, so the
  // prefs/viewport subscription in init() (registered once, outside buildForm) always calls the
  // current render's closure rather than a stale one from an earlier render.
  var vocabFormCtl = null;

  // V1e-8 (ADR 0039 addendum, SD-71): which of the vo2 rail's own two subtabs ("How it will
  // look" / "How to use") is showing. Module-session, same residual shape as voNoteDismissed.
  var vo2RailTab = 'ex';

  function afterSaved(body) {
    var s = store.get();
    store.set({
      files: ScriptoriumAdmin.ST.applySaveResult(s.files, body),
      pending: ScriptoriumAdmin.ST.withPending(s.pending, 'vocab', 0),
    });
    store.load();
  }

  var ROW_ID_UNSAFE_RE = /[^a-zA-Z0-9_-]/g;

  /**
   * V1d-2 SD-10 (M:1162-1167): a labelled row -- `<label><code>key</code></label>` beside an
   * `.a1-in`, plus an `.a1-st` state marker (a brass "yours" pill and "default: X", a rose
   * "unsaved" pill and "was X", or plain "default" text -- VB.fieldState, AC-07). `X` for "was" is
   * the field's own value before this edit (its on-disk value when it had one, else the default
   * it was implicitly reading), never re-derived from the code under test.
   *
   * V1e-6 (SD-35): the same row also carries vo3's own parts -- a `b.vo3-fname` friendly name
   * ahead of the `code` key, and an `aria-hidden` `.vo3-sample` "shows as" chip kept live from
   * the input -- so there is one DOM for vo1 and vo3 (CSS shows/hides by `[data-view]`; the
   * payload builder below never reads any of this). `input`/`st` move inside a `.vo3-in` wrapper
   * so vo3's own 3-column row (name / input+state / sample) is a real CSS grid, while `.vo3-in`
   * defaults to `display:contents` so vo1's existing 3-column layout (label / input / state) is
   * byte-unchanged.
   */
  function labeledRow(labelText, value, placeholder, onDisk) {
    var row = el('div');
    var id = 'vocab-row-' + labelText.replace(ROW_ID_UNSAFE_RE, '-');

    var label = el('label');
    label.className = 'vo3-name';
    label.setAttribute('for', id);
    var friendly = VB.friendlyName(labelText);
    if (friendly) {
      var fname = el('b');
      fname.className = 'vo3-fname';
      setText(fname, friendly);
      label.appendChild(fname);
    }
    var code = el('code');
    setText(code, labelText);
    label.appendChild(code);
    row.appendChild(label);

    var inputWrap = el('div');
    inputWrap.className = 'vo3-in';
    row.appendChild(inputWrap);

    var input = el('input');
    input.type = 'text';
    input.id = id;
    input.className = 'a1-in';
    input.value = value === undefined || value === null ? '' : value;
    if (placeholder !== undefined && placeholder !== null) input.placeholder = String(placeholder);
    inputWrap.appendChild(input);

    var field = { wrap: row, input: input, initial: input.value };

    var st = el('span');
    st.className = 'a1-st';
    inputWrap.appendChild(st);

    var sampleWrap = el('div');
    sampleWrap.className = 'vo3-sample';
    sampleWrap.setAttribute('aria-hidden', 'true');
    var sampleLabel = el('span');
    sampleLabel.className = 'vo3-sl';
    var sampleChip = el('span');
    sampleWrap.appendChild(sampleLabel);
    sampleWrap.appendChild(sampleChip);
    row.appendChild(sampleWrap);

    function refreshSample() {
      var sample = VB.sampleFor(labelText, input.value || placeholder);
      if (!sample) {
        sampleWrap.hidden = true;
        return;
      }
      sampleWrap.hidden = false;
      setText(sampleLabel, sample.label);
      sampleChip.className = 'smp ' + sample.kind;
      while (sampleChip.firstChild) sampleChip.removeChild(sampleChip.firstChild);
      if (sample.glyph) sampleChip.appendChild(ScriptoriumAdmin.glyph(sample.glyph));
      sampleChip.appendChild(document.createTextNode(sample.text));
      if (sample.suffix) {
        var suffixEl = el('i');
        setText(suffixEl, sample.suffix);
        sampleChip.appendChild(suffixEl);
      }
    }
    refreshSample();
    input.addEventListener('input', refreshSample);

    function refresh() {
      var fieldState = VB.fieldState(input.value, field.initial, onDisk);
      row.className = 'a1-lrow is-' + (fieldState === 'unsaved' ? 'pend' : fieldState === 'yours' ? 'custom' : 'default');
      while (st.firstChild) st.removeChild(st.firstChild);
      if (fieldState === 'unsaved') {
        var rose = el('span');
        rose.className = 'a1-pill rose';
        setText(rose, 'unsaved');
        st.appendChild(rose);
        var was = el('span');
        if (onDisk) {
          setText(was, 'was ' + field.initial);
        } else {
          setText(was, 'was ' + (placeholder === undefined || placeholder === null ? '' : placeholder) + ' (default)');
        }
        st.appendChild(was);
      } else if (fieldState === 'yours') {
        var brass = el('span');
        brass.className = 'a1-pill brass';
        setText(brass, 'yours');
        st.appendChild(brass);
        var def = el('span');
        setText(def, 'default: ' + (placeholder === undefined || placeholder === null ? '' : placeholder));
        st.appendChild(def);
      } else {
        var plain = el('span');
        setText(plain, 'default');
        st.appendChild(plain);
      }
    }
    refresh();
    input.addEventListener('input', refresh);

    return field;
  }

  // fieldDelta/commaListDelta moved above the guard (SD-10): call sites now pass
  // field.input.value/field.initial directly to the pure (value, initial) versions.

  function commaListValue(arr) {
    return Array.isArray(arr) ? arr.join(', ') : '';
  }

  var plainFieldIdSeq = 0;

  /** A plain `.a1-field`/`.a1-in` text field (no VB.fieldState pill -- the kind card's own
   * .a1-khead pills, built by buildKindRow, cover that role instead), used for the kind card's
   * label/glyph/aliases inputs (SD-10). The label is for/id-linked to the input (found live,
   * axe: an unlinked label -- text sibling only, no association -- fails the `label` rule). */
  function plainField(labelText, value, mono) {
    var field = el('div');
    field.className = 'a1-field';
    var id = 'vocab-plain-' + ++plainFieldIdSeq;
    var label = el('label');
    label.setAttribute('for', id);
    setText(label, labelText);
    field.appendChild(label);
    var input = el('input');
    input.id = id;
    input.type = 'text';
    input.className = mono ? 'a1-in mono' : 'a1-in';
    input.value = value === undefined || value === null ? '' : value;
    field.appendChild(input);
    return { wrap: field, input: input, initial: input.value };
  }

  /**
   * V1d-2 SD-10 (M:1168-1174, DV-6): an `.a1-kind` card -- an `.a1-kg` glyph circle (a live
   * preview of the Glyph field, not a static read-only one), an `.a1-khead` (the editable key,
   * a "before" seal pill and a live "unsaved" rose pill), the editable label/glyph/aliases/before
   * fields, and a ghost Remove. DV-6: the mock's own kinds are read-only; this keeps every field
   * editable (the key too, since a brand-new row -- "Add kind" -- has no key yet), which is why
   * the key sits in an `.a1-in.mono` input rather than a literal `<code>` (F16's mutation target:
   * these inputs must stay wired to the right row field for the POST payload to stay correct).
   */
  function buildKindRow(entry) {
    // Keep every own key of the on-disk entry (FR20 echo-back); key/label/glyph/aliases/before
    // are recomputed from the inputs at submit time via VB.buildKindEntry (admin-fix-1 item 1),
    // which omits any of those four that is both untouched and absent on disk, anything else in
    // `entry` survives as-is. A brand-new row (entry === null, "Add kind") has no on-disk data at
    // all beyond a key the GM must still type, so its fallback source carries only `key`: this
    // keeps every other field's hasOwn() check false until the GM actually edits it.
    var source = entry || { key: '' };
    var row = { source: source, beforeWasOnDisk: source.before === true };

    row.wrap = el('article');
    row.wrap.className = 'a1-kind';

    var kg = el('div');
    kg.className = 'a1-kg';
    row.wrap.appendChild(kg);

    var content = el('div');
    row.wrap.appendChild(content);

    var khead = el('div');
    khead.className = 'a1-khead';
    content.appendChild(khead);

    var keyField = plainField('Key', source.key, true);
    keyField.wrap = null; // the key input sits directly in .a1-khead, not its own .a1-field row
    // Its own <label> goes with the discarded .wrap, so the accessible name moves to aria-label.
    keyField.input.removeAttribute('id');
    keyField.input.setAttribute('aria-label', 'Key');
    khead.appendChild(keyField.input);

    var beforePill = el('span');
    beforePill.className = 'a1-pill seal';
    setText(beforePill, 'before');
    beforePill.hidden = true;
    khead.appendChild(beforePill);

    var unsavedPill = el('span');
    unsavedPill.className = 'a1-pill rose';
    setText(unsavedPill, 'unsaved');
    unsavedPill.hidden = true;
    khead.appendChild(unsavedPill);

    var labelField = plainField('Label', source.label);
    content.appendChild(labelField.wrap);

    var glyphField = plainField('Glyph', source.glyph);
    content.appendChild(glyphField.wrap);

    var aliasesField = plainField('Aliases (comma-separated)', commaListValue(source.aliases));
    content.appendChild(aliasesField.wrap);

    function refreshGlyphPreview() {
      clear(kg);
      kg.appendChild(ScriptoriumAdmin.glyph(glyphField.input.value));
    }
    refreshGlyphPreview();
    glyphField.input.addEventListener('input', refreshGlyphPreview);

    var beforeWrap = el('div');
    beforeWrap.className = 'a1-field';
    var beforeLabel = el('label');
    setText(beforeLabel, 'Before');
    var beforeInput = el('input');
    beforeInput.type = 'checkbox';
    beforeInput.checked = source.before === true;
    row.beforeInitial = beforeInput.checked;
    beforeLabel.appendChild(beforeInput);
    beforeWrap.appendChild(beforeLabel);
    content.appendChild(beforeWrap);

    // V1e-6 (SD-35): a vo3-only sample of how this kind's own key reads -- its legend chip, and,
    // when an alias exists, how a Kind cell with that alias reads -- drawn live from the row's
    // own inputs (CSS gates visibility to [data-view="vo3"]; this never touches the payload
    // built by row.toEntry below).
    var kx = el('div');
    kx.className = 'vo3-kx';
    content.appendChild(kx);

    function refreshKx() {
      clear(kx);
      var inKeyLbl = el('span');
      inKeyLbl.className = 'vo3-sl';
      setText(inKeyLbl, 'in the key');
      kx.appendChild(inKeyLbl);

      var labelVal = labelField.input.value;
      var capitalised = labelVal ? labelVal.charAt(0).toUpperCase() + labelVal.slice(1) : '';
      var legend = el('span');
      legend.className = 'smp legend' + (beforeInput.checked ? ' star' : '');
      if (KIND_GLYPH_NAMES.indexOf(glyphField.input.value) !== -1) {
        legend.appendChild(ScriptoriumAdmin.glyph(glyphField.input.value));
      }
      legend.appendChild(document.createTextNode(capitalised));
      kx.appendChild(legend);

      var aliases = aliasesField.input.value
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(function (s) {
          return s.length > 0;
        });
      if (aliases.length > 0) {
        var says = el('span');
        says.className = 'vo3-sl';
        setText(says, 'a Kind cell saying');
        kx.appendChild(says);
        var aliasCode = el('code');
        setText(aliasCode, aliases[0]);
        kx.appendChild(aliasCode);
        var reads = el('span');
        reads.className = 'vo3-sl';
        setText(reads, 'reads as ' + capitalised);
        kx.appendChild(reads);
      }
    }
    refreshKx();
    labelField.input.addEventListener('input', refreshKx);
    glyphField.input.addEventListener('input', refreshKx);
    aliasesField.input.addEventListener('input', refreshKx);
    beforeInput.addEventListener('change', refreshKx);

    var removeBtn = el('button');
    removeBtn.type = 'button';
    removeBtn.className = 'a1-btn ghost';
    setText(removeBtn, 'Remove');
    content.appendChild(removeBtn);
    row.removeBtn = removeBtn;

    row.key = keyField;
    row.label = labelField;
    row.glyph = glyphField;
    row.aliases = aliasesField;
    row.beforeInput = beforeInput;

    /** Live khead/card state (before pill, unsaved pill, is-pend card border) -- cosmetic only,
     * independent of the payload-construction logic below. */
    function refreshRowState() {
      beforePill.hidden = !beforeInput.checked;
      var dirty =
        keyField.input.value !== keyField.initial ||
        labelField.input.value !== labelField.initial ||
        glyphField.input.value !== glyphField.initial ||
        aliasesField.input.value !== aliasesField.initial ||
        beforeInput.checked !== row.beforeInitial;
      unsavedPill.hidden = !dirty;
      row.wrap.className = 'a1-kind' + (dirty ? ' is-pend' : '');
    }
    refreshRowState();

    /** The entry as it will be submitted: every unknown key from `source` survives, and each of
     * key/label/glyph/aliases/before is included only when it has something to report (VB.
     * buildKindEntry, admin-fix-1 item 1) -- an untouched field that was never on disk stays
     * absent, rather than being resent as an empty string the server refuses. */
    row.toEntry = function () {
      return VB.buildKindEntry(source, {
        key: row.key.input.value,
        label: row.label.input.value,
        labelInitial: row.label.initial,
        glyph: row.glyph.input.value,
        glyphInitial: row.glyph.initial,
        aliases: row.aliases.input.value,
        aliasesInitial: row.aliases.initial,
        before: row.beforeInput.checked,
        beforeInitial: row.beforeInitial,
      });
    };

    row.refreshRowState = refreshRowState;
    return row;
  }

  function buildForm(container, state) {
    var vocabToml = state.packToml || {};
    var vocab = state.vocab || {};
    var tables = vocab.tables || { labels: null, timeline: null, recaps: null };
    var defaults = vocab.defaults || { labels: {}, timeline: { kinds: [], weights: [], columns: {} }, recaps: {} };

    var counts = VB.tabCounts(vocab);

    // V1d-2 SD-10: the "Edit vocabulary" h2 goes -- frame.js's own screenHeader already renders
    // the page's h1 (nav.js's eyebrow/lede for 'vocab', V1d-1).
    var section = el('section');

    var form = el('form');

    // -- tabs (M:1198-1199) ------------------------------------------------------------------------

    var initialSub = ScriptoriumAdmin.NV.parseFragment(location.hash).sub;
    var activeId = TABS.some(function (t) {
      return t.id === initialSub;
    })
      ? initialSub
      : 'labels';

    // V1e-6 (SD-36, SD-37): a shared toolbar row above the tabs (SD-32: the header row already
    // holds the layout switcher), the vo3-only dismissible note, and the phone-only "How to use
    // this screen" disclosure. All three sit above the tabs in every view; CSS and the `hidden`
    // property (never a separate DOM per view, SD-35) decide which ones actually show.

    var voTools = el('div');
    voTools.className = 'vo-tools';
    var voToolsBtn = el('button');
    voToolsBtn.type = 'button';
    voToolsBtn.className = 'a1-btn small ghost';
    voToolsBtn.setAttribute('data-act', 'vocab-help');
    voToolsBtn.appendChild(icon('help'));
    voToolsBtn.appendChild(document.createTextNode('How to use'));
    voToolsBtn.hidden = true;
    voTools.appendChild(voToolsBtn);
    form.appendChild(voTools);

    var vo3Help = el('div');
    vo3Help.className = 'vo3-help';
    vo3Help.appendChild(icon('help'));
    var vo3HelpBody = el('div');
    var vo3HelpTitle = el('b');
    setText(vo3HelpTitle, 'How to use');
    vo3HelpBody.appendChild(vo3HelpTitle);
    var vo3HelpText = el('p');
    setText(
      vo3HelpText,
      "Each row is a word the player site shows. Type to change it and the sample next to it updates; empty a box to go back to the default. Nothing changes on the site until Review and save.",
    );
    vo3HelpBody.appendChild(vo3HelpText);
    vo3Help.appendChild(vo3HelpBody);
    var vo3HelpGotIt = el('button');
    vo3HelpGotIt.type = 'button';
    vo3HelpGotIt.className = 'a1-btn small ghost';
    setText(vo3HelpGotIt, 'Got it');
    vo3Help.appendChild(vo3HelpGotIt);
    form.appendChild(vo3Help);

    var voMhow = el('div');
    voMhow.className = 'vo-mhow';
    var voMhowOpen = false;
    var voMhowBtn = el('button');
    voMhowBtn.type = 'button';
    voMhowBtn.className = 'vo-mhow-s';
    voMhowBtn.setAttribute('aria-expanded', 'false');
    voMhowBtn.appendChild(icon('help'));
    var voMhowLabel = el('span');
    setText(voMhowLabel, 'How to use this screen');
    voMhowBtn.appendChild(voMhowLabel);
    var voMhowChevWrap = el('span');
    voMhowChevWrap.appendChild(icon('chev'));
    voMhowBtn.appendChild(voMhowChevWrap);
    var voMhowBody = el('div');
    voMhowBody.className = 'vo-mhow-b';
    voMhowBody.hidden = true;
    voMhowBtn.addEventListener('click', function () {
      voMhowOpen = !voMhowOpen;
      voMhowBtn.setAttribute('aria-expanded', voMhowOpen ? 'true' : 'false');
      voMhowBody.hidden = !voMhowOpen;
      clear(voMhowChevWrap);
      voMhowChevWrap.appendChild(icon(voMhowOpen ? 'chevd' : 'chev'));
    });
    voMhow.appendChild(voMhowBtn);
    voMhow.appendChild(voMhowBody);
    form.appendChild(voMhow);

    // V1e-8 (ADR 0039 addendum, SD-71, SD-73): the vo2 adapter -- body()/payloadJson() call
    // buildPayload (defined further down in this same buildForm; function declarations hoist, so
    // this closure only ever reads it once something actually calls these, well after buildForm
    // has finished running). role()/focus() follow the currently active tab and, on the labels
    // tab, the last-focused field.
    var vo2FocusedKey = null;
    var vo2RailCtl = null;
    var vo2Example = null;
    var vo2Adapter = {
      body: function () {
        return Object.assign({}, buildPayload(), { baseSha256: store.baseSha('pack.toml') });
      },
      payloadJson: function () {
        return JSON.stringify(buildPayload());
      },
      role: function () {
        return VB.followRoleFor(activeId, vo2FocusedKey);
      },
      focus: function () {
        return VB.exampleFocus(activeId, vo2FocusedKey, vo2FocusedKey ? labelsFields[vo2FocusedKey] : null);
      },
    };

    // A phone-only "See how it will look" disclosure, directly after voMhow -- shown by CSS only
    // at [data-screen="vocab"][data-view="vo2"] and max-width:699px (the rail never docks there,
    // presentation.phone:'inline'). Its own body, with its own vocabExample(adapter), is built
    // lazily on first open.
    var vo2Mhow = el('div');
    vo2Mhow.className = 'vo-mhow vo2-mhow';
    var vo2MhowOpen = false;
    var vo2MhowBtn = el('button');
    vo2MhowBtn.type = 'button';
    vo2MhowBtn.className = 'vo-mhow-s';
    vo2MhowBtn.setAttribute('aria-expanded', 'false');
    vo2MhowBtn.appendChild(icon('preview'));
    var vo2MhowLabel = el('span');
    setText(vo2MhowLabel, 'See how it will look');
    vo2MhowBtn.appendChild(vo2MhowLabel);
    var vo2MhowChevWrap = el('span');
    vo2MhowChevWrap.appendChild(icon('chev'));
    vo2MhowBtn.appendChild(vo2MhowChevWrap);
    var vo2MhowBody = el('div');
    vo2MhowBody.className = 'vo-mhow-b';
    vo2MhowBody.hidden = true;
    var vo2MhowExample = null;
    /** Refresh the phone example from the same hooks as the desktop one (AC-V8-03), only while
     * it is open; reopening refreshes it too (the click handler below). */
    function refreshVo2Mhow() {
      if (vo2MhowOpen && vo2MhowExample) vo2MhowExample.refresh();
    }
    vo2MhowBtn.addEventListener('click', function () {
      vo2MhowOpen = !vo2MhowOpen;
      vo2MhowBtn.setAttribute('aria-expanded', vo2MhowOpen ? 'true' : 'false');
      vo2MhowBody.hidden = !vo2MhowOpen;
      clear(vo2MhowChevWrap);
      vo2MhowChevWrap.appendChild(icon(vo2MhowOpen ? 'chevd' : 'chev'));
      if (vo2MhowOpen && !vo2MhowExample) {
        vo2MhowExample = ScriptoriumAdmin.variants.vocabExample(vo2Adapter);
        vo2MhowBody.appendChild(vo2MhowExample.node);
      } else if (vo2MhowOpen && vo2MhowExample) {
        vo2MhowExample.refresh();
      }
    });
    vo2Mhow.appendChild(vo2MhowBtn);
    vo2Mhow.appendChild(vo2MhowBody);
    form.appendChild(vo2Mhow);

    /** The "How to use" [title, body] blocks for the current tab, shared by the rail and the
     * phone disclosure. */
    function howBlocks(targetContainer) {
      var items = VB.howFor(activeId) || [];
      items.forEach(function (item) {
        var block = el('div');
        block.className = 'vo-how-i';
        var h3 = el('h3');
        setText(h3, item[0]);
        block.appendChild(h3);
        var p = el('p');
        setText(p, item[1]);
        block.appendChild(p);
        targetContainer.appendChild(block);
      });
    }

    function refreshMhowContent() {
      clear(voMhowBody);
      howBlocks(voMhowBody);
    }
    refreshMhowContent();

    /** SD-36's pane `build`: a fresh rail for the CURRENT `activeId` every time it runs (the
     * spec below is itself a new object each time refreshHelpUi() registers it, so a tab change
     * always forces frame.js to rebuild the docked content, not just this function). */
    function buildRail(container) {
      clear(container);
      var header = el('header');
      var cap = el('span');
      cap.className = 'a1-cap';
      setText(cap, 'How to use');
      header.appendChild(cap);
      var railTab = el('span');
      railTab.className = 'vo-railtab';
      var tabInfo = TABS.filter(function (t) {
        return t.id === activeId;
      })[0];
      setText(railTab, tabInfo ? tabInfo.label : '');
      header.appendChild(railTab);
      var hideBtn = el('button');
      hideBtn.type = 'button';
      hideBtn.className = 'a1-iconbtn';
      hideBtn.setAttribute('data-act', 'rail-hide');
      hideBtn.title = 'Hide';
      hideBtn.appendChild(icon('x'));
      hideBtn.addEventListener('click', function () {
        // setPref's own store.set is synchronous, so the toolbar button (a stable element,
        // never rebuilt by the pane) is already visible by the time this focuses it. Its POST
        // then resolves a moment later with the server's own confirmed prefs object -- a second,
        // distinct object even when every value agrees -- which re-fires this same prefs
        // subscription. voToolsBtn survives that (it isn't part of the pane's own DOM), so one
        // focus call is enough here.
        store.setPref('rail.hidden', true);
        if (!voToolsBtn.hidden) voToolsBtn.focus();
      });
      header.appendChild(hideBtn);
      container.appendChild(header);
      howBlocks(container);
      var fine = el('p');
      fine.className = 'a1-fine';
      setText(fine, 'Hide this and it stays hidden on this computer. The How to use button above the tabs brings it back.');
      container.appendChild(fine);
    }

    /**
     * V1e-8 (ADR 0039 addendum, SD-71): unlike buildRail above, this runs only ONCE per
     * buildForm (vo2RailSpec below is one stable object, registered by reference every time
     * refreshHelpUi() runs, so frame.js's own idempotence guard -- the SAME spec object skips a
     * rebuild -- means a tab change never tears down and recreates the Now/After example frame;
     * only vo2RailCtl.refresh(), called from the hooks below, updates it in place).
     */
    function buildVo2Rail(container) {
      clear(container);
      var header = el('header');
      var subtabs = el('div');
      subtabs.className = 'a1-subtabs';
      subtabs.setAttribute('role', 'tablist');
      var exTabBtn = el('button');
      exTabBtn.type = 'button';
      exTabBtn.className = 'a1-subtab';
      exTabBtn.setAttribute('role', 'tab');
      setText(exTabBtn, 'How it will look');
      var howTabBtn = el('button');
      howTabBtn.type = 'button';
      howTabBtn.className = 'a1-subtab';
      howTabBtn.setAttribute('role', 'tab');
      setText(howTabBtn, 'How to use');
      subtabs.appendChild(exTabBtn);
      subtabs.appendChild(howTabBtn);
      header.appendChild(subtabs);

      var hideBtn2 = el('button');
      hideBtn2.type = 'button';
      hideBtn2.className = 'a1-iconbtn';
      hideBtn2.setAttribute('data-act', 'rail-hide');
      hideBtn2.title = 'Hide';
      hideBtn2.appendChild(icon('x'));
      hideBtn2.addEventListener('click', function () {
        store.setPref('rail.hidden', true);
        if (!voToolsBtn.hidden) voToolsBtn.focus();
      });
      header.appendChild(hideBtn2);
      container.appendChild(header);

      var exPanel = el('div');
      var howPanel = el('div');
      container.appendChild(exPanel);
      container.appendChild(howPanel);

      var example = ScriptoriumAdmin.variants.vocabExample(vo2Adapter);
      exPanel.appendChild(example.node);
      howBlocks(howPanel);

      function updateTabButtons() {
        exTabBtn.setAttribute('aria-selected', vo2RailTab === 'ex' ? 'true' : 'false');
        howTabBtn.setAttribute('aria-selected', vo2RailTab === 'how' ? 'true' : 'false');
        exPanel.hidden = vo2RailTab !== 'ex';
        howPanel.hidden = vo2RailTab !== 'how';
      }
      exTabBtn.addEventListener('click', function () {
        vo2RailTab = 'ex';
        updateTabButtons();
      });
      howTabBtn.addEventListener('click', function () {
        vo2RailTab = 'how';
        updateTabButtons();
      });
      updateTabButtons();

      vo2Example = example;
      vo2RailCtl = {
        refresh: function () {
          clear(howPanel);
          howBlocks(howPanel);
          example.refresh();
        },
      };
    }

    var vo2RailSpec = {
      label: 'How it will look',
      className: 'vo-rail vo2-rail',
      presentation: { wide: 'dock', laptop: 'dock', phone: 'inline' },
      hideable: true,
      hiddenPref: 'rail.hidden',
      hiddenAs: 'none',
      build: buildVo2Rail,
    };

    /** SD-36's registration rule (register only while vo1 is the current view) plus SD-37's
     * toolbar-button and note visibility -- re-run from setActiveTab (a tab change) and from
     * init()'s own prefs/viewport subscription (a view or Hide/Show change), via vocabFormCtl.
     * V1e-8 (SD-71, SD-73): a vo2 branch registers vo2RailSpec (the SAME object every call, so a
     * tab change never rebuilds it), and the toolbar button's own icon/label now depend on the
     * view too. */
    function refreshHelpUi() {
      var view = ScriptoriumAdmin.views.current('vocab');
      if (view === 'vo1') {
        ScriptoriumAdmin.pane.register('vocab', {
          label: 'How to use',
          className: 'vo-rail',
          presentation: { wide: 'dock', laptop: 'dock', phone: 'inline' },
          hideable: true,
          hiddenPref: 'rail.hidden',
          hiddenAs: 'none',
          build: buildRail,
        });
      } else if (view === 'vo2') {
        ScriptoriumAdmin.pane.register('vocab', vo2RailSpec);
      } else {
        ScriptoriumAdmin.pane.unregister('vocab');
      }

      var prefs = store.get().prefs || ScriptoriumAdmin.NV.PREF_DEFAULTS;
      var railHidden = !!prefs['rail.hidden'];
      var viewport = store.get().viewport || ScriptoriumAdmin.NV.viewportClass(window.innerWidth);
      voToolsBtn.hidden = !(
        (view === 'vo1' && railHidden) ||
        (view === 'vo3' && voNoteDismissed) ||
        (view === 'vo2' && railHidden && viewport !== 'phone')
      );
      vo3Help.hidden = !(view === 'vo3' && !voNoteDismissed);

      clear(voToolsBtn);
      if (view === 'vo2') {
        voToolsBtn.appendChild(icon('preview'));
        voToolsBtn.appendChild(document.createTextNode('Show example'));
      } else {
        voToolsBtn.appendChild(icon('help'));
        voToolsBtn.appendChild(document.createTextNode('How to use'));
      }
    }

    voToolsBtn.addEventListener('click', function () {
      var v = ScriptoriumAdmin.views.current('vocab');
      if (v === 'vo1') {
        // Unlike Hide (above), the rail's own Hide button is rebuilt from scratch by every
        // dock render -- including the one setPref's own POST triggers a moment after the
        // synchronous optimistic one, with the server's own confirmed (but distinct) prefs
        // object. Refocusing again once that settles keeps focus on the CURRENT button rather
        // than one already detached from the document.
        var focusHideBtn = function () {
          var hideBtnEl = document.querySelector('[data-act="rail-hide"]');
          if (hideBtnEl) hideBtnEl.focus();
        };
        var setPromise = store.setPref('rail.hidden', false);
        focusHideBtn();
        setPromise.then(focusHideBtn);
      } else if (v === 'vo2') {
        // The vo2 rail's own Hide button shares the same [data-act="rail-hide"] selector as
        // vo1's, so the same refocus pattern applies unchanged.
        var focusHideBtn2 = function () {
          var hideBtnEl = document.querySelector('[data-act="rail-hide"]');
          if (hideBtnEl) hideBtnEl.focus();
        };
        var setPromise2 = store.setPref('rail.hidden', false);
        focusHideBtn2();
        setPromise2.then(focusHideBtn2);
      } else if (v === 'vo3') {
        voNoteDismissed = false;
        refreshHelpUi();
        vo3HelpGotIt.focus();
      }
    });

    vo3HelpGotIt.addEventListener('click', function () {
      voNoteDismissed = true;
      refreshHelpUi();
      if (!voToolsBtn.hidden) voToolsBtn.focus();
    });

    vocabFormCtl = { refreshHelpUi: refreshHelpUi };

    var tablist = el('div');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Vocabulary sections');
    tablist.className = 'a1-subtabs';
    form.appendChild(tablist);

    var panels = {};
    var tabButtons = {};
    var tabDots = {};

    function setActiveTab(id) {
      activeId = id;
      TABS.forEach(function (tab) {
        var selected = tab.id === id;
        tabButtons[tab.id].setAttribute('aria-selected', selected ? 'true' : 'false');
        tabButtons[tab.id].tabIndex = selected ? 0 : -1;
        panels[tab.id].hidden = !selected;
      });
      // Only rewrite the address bar when the vocab screen is the one actually showing: this
      // form is built (and re-built on every store update) even while a different screen is
      // visible, and an unconditional replaceState here would silently hijack the hash out from
      // under whatever screen the GM is really looking at.
      if (ScriptoriumAdmin.NV.parseFragment(location.hash).screen === 'vocab') {
        history.replaceState(null, '', '#/vocab/' + id);
      }
      // V1e-6 (SD-36, SD-38): the rail/phone-disclosure copy and the follow hint both depend on
      // the tab, so both refresh on every tab change; the rail is re-registered (not just
      // rebuilt) so frame.js's own layout() actually re-renders the docked content.
      refreshMhowContent();
      refreshHelpUi();
      // V1e-8 (SD-71): refreshHelpUi() re-registers vo2RailSpec by the SAME object reference, so
      // it never forces frame.js to rebuild the rail on a tab change; this is what actually
      // updates the "How to use" panel text and the example's own tab/role-dependent caption.
      if (vo2RailCtl) vo2RailCtl.refresh();
      refreshVo2Mhow();
      store.set({ followHint: { screen: 'vocab', role: VB.followRoleFor(id, null) } });
    }

    TABS.forEach(function (tab, i) {
      var btn = el('button');
      btn.type = 'button';
      btn.className = 'a1-subtab';
      btn.setAttribute('role', 'tab');
      btn.id = 'vocab-tab-' + tab.id;
      btn.setAttribute('aria-controls', 'vocab-panel-' + tab.id);
      btn.appendChild(document.createTextNode(tab.label + ' '));
      var count = el('small');
      setText(count, String(counts[tab.id === 'kinds' ? 'kinds' : tab.id]));
      btn.appendChild(count);
      // V1d-2 SD-10 (M:1196's dot() -- found live, missing from the initial port): a per-tab
      // unsaved dot, live (not the mock's own hardcoded labels/kinds-only pair).
      var dot = el('i');
      dot.className = 'a1-dot';
      dot.setAttribute('aria-label', 'unsaved');
      dot.hidden = true;
      btn.appendChild(dot);
      tabDots[tab.id] = dot;
      btn.addEventListener('click', function () {
        setActiveTab(tab.id);
        tabButtons[tab.id].focus();
      });
      tablist.appendChild(btn);
      tabButtons[tab.id] = btn;
    });

    tablist.addEventListener('keydown', function (ev) {
      var idx = TABS.map(function (t) {
        return t.id;
      }).indexOf(activeId);
      var next = null;
      if (ev.key === 'ArrowRight') next = (idx + 1) % TABS.length;
      else if (ev.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = TABS.length - 1;
      if (next !== null) {
        ev.preventDefault();
        setActiveTab(TABS[next].id);
        tabButtons[TABS[next].id].focus();
      }
    });

    /**
     * V1d-2 SD-10 (M:1200's `.a1-vbody`): `vbody` (default true) applies the mock's own
     * `display:grid;gap:24px` wrapper. Kinds passes false -- its own Add kind/Reset kinds pair
     * (below) is deliberately NOT inside a flex wrapper (so the frozen busy-contract test's
     * literal `kindsPanel.appendChild(addKindBtn/resetKindsBtn)` calls stay intact), and a grid
     * parent would otherwise stack those two .a1-btn siblings one per row instead of side by
     * side; kindsSection/.a1-note (both still appended straight to this panel) get their own
     * margin instead (admin.css).
     */
    function buildPanel(id, vbody) {
      var panel = el('div');
      panel.id = 'vocab-panel-' + id;
      if (vbody !== false) panel.className = 'a1-vbody';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'vocab-tab-' + id);
      panel.hidden = id !== activeId;
      form.appendChild(panel);
      panels[id] = panel;
      return panel;
    }

    // -- Labels tab (VB.LABEL_GROUPS: Story timeline / Recaps / Connections) --------------------
    var labelsPanel = buildPanel('labels');
    var labelsFields = {};
    VB.LABEL_GROUPS.forEach(function (group) {
      var groupName = group[0];
      var keys = group[1];
      var groupSection = el('section');
      // V1e-6 (SD-35, SD-37): a vo3-only class, so the 1800px two-column labels layout (admin.css)
      // can target each group, and so the group note below has somewhere scoped to live.
      groupSection.className = 'vo-group';
      var groupHeading = el('h2');
      groupHeading.className = 'a1-rule';
      setText(groupHeading, groupName);
      // V1e-6 (SD-34): the group's plain-English "where it shows" note, vo3 only.
      if (hasOwn(VB.GROUP_NOTES, groupName)) {
        var gnote = el('small');
        gnote.className = 'vo3-gnote';
        setText(gnote, VB.GROUP_NOTES[groupName]);
        groupHeading.appendChild(gnote);
      }
      groupSection.appendChild(groupHeading);
      keys.forEach(function (key) {
        var onDisk = tables.labels && Object.prototype.hasOwnProperty.call(tables.labels, key);
        var current = onDisk ? tables.labels[key] : '';
        var field = labeledRow(key, current, defaults.labels[key], onDisk);
        labelsFields[key] = field;
        // V1e-6 (SD-38): the follow hint, on focus of a labels-tab input. Harmless before
        // V1e-3 lands (nothing reads store.followHint yet); it always names the 'labels' tab
        // here, since this listener only ever sits on a labels-tab field.
        field.input.addEventListener('focusin', function () {
          store.set({ followHint: { screen: 'vocab', role: VB.followRoleFor('labels', key) } });
          // V1e-8 (SD-71): the vo2 example follows the focused field too.
          vo2FocusedKey = key;
          if (vo2RailCtl) vo2RailCtl.refresh();
          refreshVo2Mhow();
        });
        groupSection.appendChild(field.wrap);
      });
      labelsPanel.appendChild(groupSection);
    });

    // -- Recaps tab (M:1194) -----------------------------------------------------------------------
    var recapsPanel = buildPanel('recaps');
    var recapsSection = el('section');
    var recapsHeading = el('h2');
    recapsHeading.className = 'a1-rule';
    setText(recapsHeading, 'Recaps');
    recapsSection.appendChild(recapsHeading);
    var learnedHeadingOnDisk = Boolean(tables.recaps && Object.prototype.hasOwnProperty.call(tables.recaps, 'learned_heading'));
    var learnedHeadingCurrent = learnedHeadingOnDisk ? tables.recaps.learned_heading : '';
    var learnedHeadingField = labeledRow('learned_heading', learnedHeadingCurrent, defaults.recaps.learned_heading, learnedHeadingOnDisk);
    recapsSection.appendChild(learnedHeadingField.wrap);
    var recapsHint = el('p');
    recapsHint.className = 'a1-hint';
    setText(recapsHint, 'The heading in each session recap that lists what the party learned. Matched ignoring case.');
    recapsSection.appendChild(recapsHint);
    recapsPanel.appendChild(recapsSection);

    // -- Weights and matching tab: weights, session_token, segment_units, columns (M:1184-1192) --
    var matchingPanel = buildPanel('matching');

    /** V1d-2 SD-10 (M:1185-1188): a plain .a1-field with a pips label -- no VB.fieldState pill.
     * The mock's own weight fields carry none (they are placeholder-only in the mock, and the
     * pip pattern itself already signals which of the three a value is). */
    function weightField(i, value, placeholder) {
      var field = el('div');
      field.className = 'a1-field';
      var id = 'vocab-weight-' + i;
      var label = el('label');
      label.setAttribute('for', id);
      var pips = el('span');
      pips.className = 'a1-pips';
      for (var p = 0; p <= 2; p++) {
        var dot = el('i');
        if (p <= i) dot.className = 'on';
        pips.appendChild(dot);
      }
      label.appendChild(pips);
      label.appendChild(document.createTextNode('Weight ' + (i + 1)));
      field.appendChild(label);
      var input = el('input');
      input.type = 'text';
      input.id = id;
      input.className = 'a1-in';
      input.value = value === undefined || value === null ? '' : value;
      if (placeholder !== undefined && placeholder !== null) input.placeholder = String(placeholder);
      field.appendChild(input);
      return { wrap: field, input: input, initial: input.value };
    }

    var weightsSection = el('section');
    var weightsHeading = el('h2');
    weightsHeading.className = 'a1-rule';
    setText(weightsHeading, 'Weights');
    weightsSection.appendChild(weightsHeading);
    var weightsGrid = el('div');
    weightsGrid.className = 'a1-grid2';
    var onDiskWeights = (tables.timeline && tables.timeline.weights) || [];
    var weightFields = [0, 1, 2].map(function (i) {
      var field = weightField(i, onDiskWeights[i], defaults.timeline.weights[i]);
      weightsGrid.appendChild(field.wrap);
      return field;
    });
    weightsSection.appendChild(weightsGrid);
    var weightsHint = el('p');
    weightsHint.className = 'a1-hint';
    setText(weightsHint, "What 1, 2 and 3 in a Timeline row's Weight column are called. Exactly three.");
    weightsSection.appendChild(weightsHint);
    matchingPanel.appendChild(weightsSection);

    /** V1d-2 SD-10/DV-7 (M:1189-1191): .a1-field/.a1-in.mono with the EXISTING hint text -- no
     * live "Your Timeline: X reads as Y" example (that needs real Timeline data). V1e-6 (SD-35):
     * the label also gains the same `b.vo3-fname` friendly name as labeledRow's, shown in vo3
     * only -- no live sample chip here, since the hint span already shows how the GM's own rows
     * read. */
    function patternField(key, value, placeholder, hintText) {
      var field = el('div');
      field.className = 'a1-field';
      var id = 'vocab-pattern-' + key;
      var label = el('label');
      label.className = 'vo3-name';
      label.setAttribute('for', id);
      var friendly = VB.friendlyName(key);
      if (friendly) {
        var fname = el('b');
        fname.className = 'vo3-fname';
        setText(fname, friendly);
        label.appendChild(fname);
      }
      var code = el('code');
      setText(code, key);
      label.appendChild(code);
      field.appendChild(label);
      var input = el('input');
      input.type = 'text';
      input.id = id;
      input.className = 'a1-in mono';
      input.value = value === undefined || value === null ? '' : value;
      if (placeholder !== undefined && placeholder !== null) input.placeholder = String(placeholder);
      field.appendChild(input);
      var hint = el('span');
      hint.className = 'a1-hint';
      setText(hint, hintText);
      field.appendChild(hint);
      return { wrap: field, input: input, initial: input.value };
    }

    var patternsSection = el('section');
    var patternsHeading = el('h2');
    patternsHeading.className = 'a1-rule';
    setText(patternsHeading, 'Patterns');
    patternsSection.appendChild(patternsHeading);
    var patternsCols = el('div');
    patternsCols.className = 'a1-cols';

    var sessionTokenOnDisk = Boolean(tables.timeline && Object.prototype.hasOwnProperty.call(tables.timeline, 'session_token'));
    var sessionTokenCurrent = sessionTokenOnDisk ? tables.timeline.session_token : undefined;
    var sessionTokenField = patternField(
      'session_token',
      sessionTokenCurrent,
      defaults.timeline.session_token,
      'Must contain at least 1 capturing group.',
    );
    patternsCols.appendChild(sessionTokenField.wrap);

    var segmentUnitsOnDisk = Boolean(tables.timeline && Object.prototype.hasOwnProperty.call(tables.timeline, 'segment_units'));
    var segmentUnitsCurrent = segmentUnitsOnDisk ? tables.timeline.segment_units : undefined;
    var segmentUnitsField = patternField(
      'segment_units',
      segmentUnitsCurrent,
      defaults.timeline.segment_units,
      'Must contain at least 2 capturing groups, matched case-insensitively.',
    );
    patternsCols.appendChild(segmentUnitsField.wrap);
    patternsSection.appendChild(patternsCols);
    matchingPanel.appendChild(patternsSection);

    /** V1d-2 SD-10/DV-7 (M:1192): .a1-crow, keeping the column's own editable input (the mock's
     * own row is read-only text; DV-7 keeps ours editable). */
    function columnRow(key, value, placeholder) {
      var row = el('div');
      row.className = 'a1-crow';
      var code = el('code');
      setText(code, key);
      row.appendChild(code);
      var input = el('input');
      input.type = 'text';
      input.className = 'a1-in mono';
      input.value = value === undefined || value === null ? '' : value;
      if (placeholder !== undefined && placeholder !== null) input.placeholder = String(placeholder);
      row.appendChild(input);
      return { wrap: row, input: input, initial: input.value };
    }

    var columnsSection = el('section');
    var columnsHeading = el('h2');
    columnsHeading.className = 'a1-rule';
    setText(columnsHeading, 'Timeline columns');
    columnsSection.appendChild(columnsHeading);
    var columnsGrid = el('div');
    columnsGrid.className = 'a1-cols-t';
    var onDiskColumns = (tables.timeline && tables.timeline.columns) || {};
    var columnFields = {};
    VB.COLUMN_KEYS.forEach(function (key) {
      var onDisk = Object.prototype.hasOwnProperty.call(onDiskColumns, key);
      var current = onDisk ? onDiskColumns[key] : null;
      var field = columnRow(key, commaListValue(current), commaListValue(defaults.timeline.columns[key]));
      columnFields[key] = field;
      columnsGrid.appendChild(field.wrap);
    });
    columnsSection.appendChild(columnsGrid);
    var columnsHint = el('p');
    columnsHint.className = 'a1-hint';
    setText(columnsHint, 'Header names each Timeline column may use. All eleven are the defaults, and your Timeline page matches them.');
    columnsSection.appendChild(columnsHint);
    matchingPanel.appendChild(columnsSection);

    // -- Timeline kinds tab (M:1168-1174, M:1181-1183) ----------------------------------------------
    var kindsPanel = buildPanel('kinds', false);
    var kindsSection = el('section');
    var kindsGrid = el('div');
    kindsGrid.className = 'a1-kinds';
    kindsSection.appendChild(kindsGrid);
    kindsPanel.appendChild(kindsSection);
    // V1d-2 SD-10: the kinds note becomes an .a1-note.
    var kindsNote = el('div');
    kindsNote.className = 'a1-note';
    kindsNote.appendChild(icon('info'));
    var kindsNoteText = el('div');
    var kindsNoteP1 = el('p');
    setText(kindsNoteP1, 'Kinds replace the built-in set as a whole. Change one, and all five are written into pack.toml.');
    kindsNoteText.appendChild(kindsNoteP1);
    var kindsNoteP2 = el('p');
    // DV-7: "fight and journey", not the mock's "fight, meeting, discovery, journey and backstory"
    // (assets/site/scriptorium.css:2394-2399 -- only those two actually get the site's own colour).
    setText(kindsNoteP2, "Only fight and journey get the site's own colours; any other kind uses the neutral colour.");
    kindsNoteText.appendChild(kindsNoteP2);
    kindsNote.appendChild(kindsNoteText);
    kindsPanel.appendChild(kindsNote);

    var kindsBox = kindsGrid;

    var onDiskKinds = tables.timeline && tables.timeline.kinds ? tables.timeline.kinds : defaults.timeline.kinds;
    var kindsWasOnDisk = !!(tables.timeline && tables.timeline.kinds);
    var kindRows = [];
    var kindsDirty = false;
    var kindsReset = false;

    function renderKindRows() {
      clear(kindsBox);
      kindRows.forEach(function (row) {
        kindsBox.appendChild(row.wrap);
      });
    }

    function addKindRow(entry) {
      var row = buildKindRow(entry);
      row.removeBtn.addEventListener('click', function () {
        var idx = kindRows.indexOf(row);
        if (idx !== -1) kindRows.splice(idx, 1);
        kindsDirty = true;
        kindsReset = false;
        renderKindRows();
      });
      [row.key, row.label, row.glyph, row.aliases].forEach(function (field) {
        field.input.addEventListener('input', function () {
          kindsDirty = true;
          kindsReset = false;
          row.refreshRowState();
        });
      });
      row.beforeInput.addEventListener('change', function () {
        kindsDirty = true;
        kindsReset = false;
        row.refreshRowState();
      });
      kindRows.push(row);
      return row;
    }

    onDiskKinds.forEach(function (entry) {
      addKindRow(entry);
    });
    renderKindRows();

    // V1d-2 SD-10 (M:1183): Add kind (plain .a1-btn, plus icon) and Reset kinds to defaults
    // (.a1-btn ghost, undo icon). Both .a1-btn (display: inline-flex) already flow side by side
    // without a flex wrapper; the `.a1-btn + .a1-btn` gap rule (admin.css) spaces them apart.
    var addKindBtn = el('button');
    addKindBtn.type = 'button';
    addKindBtn.className = 'a1-btn';
    setText(addKindBtn, 'Add kind');
    addKindBtn.insertBefore(icon('plus'), addKindBtn.firstChild);
    addKindBtn.addEventListener('click', function () {
      addKindRow(null);
      kindsDirty = true;
      kindsReset = false;
      renderKindRows();
    });
    kindsPanel.appendChild(addKindBtn);

    var resetKindsBtn = el('button');
    resetKindsBtn.type = 'button';
    resetKindsBtn.className = 'a1-btn ghost';
    setText(resetKindsBtn, 'Reset kinds to defaults');
    resetKindsBtn.insertBefore(icon('undo'), resetKindsBtn.firstChild);
    resetKindsBtn.addEventListener('click', function () {
      kindRows = [];
      defaults.timeline.kinds.forEach(function (entry) {
        addKindRow(entry);
      });
      renderKindRows();
      kindsDirty = true;
      kindsReset = true;
    });
    kindsPanel.appendChild(resetKindsBtn);

    renderKindRows();
    setActiveTab(activeId);

    // Deep-linking / browser back-forward: react to an external hash change (not just this
    // tablist's own history.replaceState calls, which never fire hashchange) so #/vocab/<tab>
    // actually switches tabs, not only the vocab screen's own visibility.
    window.addEventListener('hashchange', function () {
      var sub = ScriptoriumAdmin.NV.parseFragment(location.hash).sub;
      if (TABS.some(function (t) { return t.id === sub; }) && sub !== activeId) {
        setActiveTab(sub);
      }
    });

    // -- payload construction (unchanged from S4/admin-fix-1) -------------------------------------

    function buildPayload() {
      var payload = {};

      var labelsChanges = {};
      var anyLabel = false;
      LABEL_KEYS.forEach(function (key) {
        var field = labelsFields[key];
        var delta = fieldDelta(field.input.value, field.initial);
        if (delta !== undefined) {
          labelsChanges[key] = delta;
          anyLabel = true;
        }
      });
      if (anyLabel) payload.labels = labelsChanges;

      var recapsChanges = {};
      var anyRecaps = false;
      var learnedDelta = fieldDelta(learnedHeadingField.input.value, learnedHeadingField.initial);
      if (learnedDelta !== undefined) {
        recapsChanges.learned_heading = learnedDelta;
        anyRecaps = true;
      }
      if (anyRecaps) payload.recaps = recapsChanges;

      var timelineChanges = {};
      var anyTimeline = false;

      var weightsResult = weightsDelta(
        weightFields.map(function (f) {
          return f.input.value;
        }),
        weightFields.map(function (f) {
          return f.initial;
        }),
      );
      if (weightsResult !== undefined) {
        timelineChanges.weights = weightsResult;
        anyTimeline = true;
      }

      var sessionTokenDelta = fieldDelta(sessionTokenField.input.value, sessionTokenField.initial);
      if (sessionTokenDelta !== undefined) {
        timelineChanges.session_token = sessionTokenDelta;
        anyTimeline = true;
      }

      var segmentUnitsDelta = fieldDelta(segmentUnitsField.input.value, segmentUnitsField.initial);
      if (segmentUnitsDelta !== undefined) {
        timelineChanges.segment_units = segmentUnitsDelta;
        anyTimeline = true;
      }

      var columnsChanges = {};
      var anyColumn = false;
      VB.COLUMN_KEYS.forEach(function (key) {
        var field = columnFields[key];
        var delta = commaListDelta(field.input.value, field.initial);
        if (delta !== undefined) {
          columnsChanges[key] = delta;
          anyColumn = true;
        }
      });
      if (anyColumn) {
        timelineChanges.columns = columnsChanges;
        anyTimeline = true;
      }

      if (kindsReset) {
        timelineChanges.kinds = null;
        anyTimeline = true;
      } else if (kindsDirty) {
        timelineChanges.kinds = kindRows.map(function (row) {
          return row.toEntry();
        });
        anyTimeline = true;
      }

      if (anyTimeline) payload.timeline = timelineChanges;

      return payload;
    }

    // -- Show the file, pending bar, save via the slip -------------------------------------------

    var details = el('details');
    var summary = el('summary');
    summary.className = 'df-toggle';
    setText(summary, 'Show the file');
    details.appendChild(summary);
    var pre = el('pre');
    setText(pre, vocabToml.raw === undefined || vocabToml.raw === null ? '' : vocabToml.raw);
    details.appendChild(pre);
    form.appendChild(details);

    var outcomeBox = el('div');
    form.appendChild(outcomeBox);

    function currentPendingCount() {
      return VB.countChanges(buildPayload());
    }

    // V1d-2 SD-10: .a1-pending, with a live "N unsaved change(s)" grow span (M:1201's own text,
    // minus its hardcoded field-name list -- DV-11/DV-14's own precedent of a mechanical count
    // over a literal per-field listing).
    var pendingBar = el('div');
    pendingBar.className = 'a1-pending';
    var pendingGrow = el('span');
    pendingGrow.className = 'grow';
    var pendingDot = el('i');
    pendingDot.className = 'a1-dot';
    pendingDot.setAttribute('aria-hidden', 'true');
    pendingGrow.appendChild(pendingDot);
    var pendingText = el('span');
    pendingGrow.appendChild(pendingText);
    pendingBar.appendChild(pendingGrow);

    function refreshPendingText() {
      var n = currentPendingCount();
      setText(pendingText, ' ' + n + ' unsaved change' + (n === 1 ? '' : 's'));
    }
    refreshPendingText();

    /** V1d-2 SD-10 (M:1196): each subtab's own dot, live -- labels/recaps dirty from their own
     * payload keys; kinds from timeline.kinds; matching from any of weights/session_token/
     * segment_units/columns. */
    function refreshTabDots() {
      var payload = buildPayload();
      tabDots.labels.hidden = !(payload.labels && Object.keys(payload.labels).length > 0);
      tabDots.recaps.hidden = !(payload.recaps && Object.prototype.hasOwnProperty.call(payload.recaps, 'learned_heading'));
      var t = payload.timeline || {};
      tabDots.kinds.hidden = !Object.prototype.hasOwnProperty.call(t, 'kinds');
      tabDots.matching.hidden = !(
        Object.prototype.hasOwnProperty.call(t, 'weights') ||
        Object.prototype.hasOwnProperty.call(t, 'session_token') ||
        Object.prototype.hasOwnProperty.call(t, 'segment_units') ||
        Object.prototype.hasOwnProperty.call(t, 'columns')
      );
    }
    refreshTabDots();

    function onAnyInput() {
      store.set({ pending: ScriptoriumAdmin.ST.withPending(store.get().pending, 'vocab', currentPendingCount()) });
      refreshPendingText();
      refreshTabDots();
      // V1e-8 (SD-71): state text only (the example itself never rebuilds on a keystroke).
      if (vo2Example) vo2Example.refresh();
      refreshVo2Mhow();
    }
    form.addEventListener('input', onAnyInput);
    form.addEventListener('change', onAnyInput);

    var reviewBtn = el('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'a1-btn primary';
    setText(reviewBtn, 'Review and save');
    var disabledReason = Boolean(vocabToml.error) || !state.writable;
    vocabReviewBtn = reviewBtn;
    vocabOwnDisabled = disabledReason;
    reviewBtn.disabled = disabledReason || store.isBusy();
    reviewBtn.addEventListener('click', function () {
      var payload = buildPayload();
      if (Object.keys(payload).length === 0) return;
      reviewBtn.disabled = true;
      // Read the base sha live, at save time (not captured at render time): SD-7 deliberately
      // never re-renders a screen with pending edits, so a captured value here would go stale
      // the moment another screen's save updates store.files['pack.toml'] -- exactly the
      // render-time capture ADR 0022 ("The sealed slip, rebuilt write screens, and per-slot image guidance") lists as rejected, and exactly what pack.js's and
      // images.js's own dry bodies already avoid via store.baseSha().
      var dryBody = Object.assign({}, payload, { baseSha256: store.baseSha('pack.toml'), dryRun: true });
      api('/api/pack/vocab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dryBody) })
        .then(function (result) {
          reviewBtn.disabled = disabledReason || store.isBusy();
          if (!result.ok || !result.body || result.body.ok !== true) {
            renderBanner(outcomeBox, mapOutcomeSafe(result, 'dry'));
            return;
          }
          ScriptoriumAdmin.slip.review({
            kind: 'vocab',
            payload: payload,
            state: state,
            dry: result.body,
            dryBody: dryBody,
            path: '/api/pack/vocab',
            trigger: reviewBtn,
            onSaved: afterSaved,
          });
        })
        .catch(function () {
          reviewBtn.disabled = disabledReason || store.isBusy();
          renderBanner(outcomeBox, mapOutcomeSafe({ ok: false, status: 0, body: null }, 'dry'));
        });
    });
    pendingBar.appendChild(reviewBtn);
    form.appendChild(pendingBar);

    section.appendChild(form);
    container.appendChild(section);
  }

  function render(container, state) {
    clear(container);

    if (!state.writable) {
      var reason = el('p');
      reason.className = 'vocab-readonly';
      setText(reason, state.readOnlyReason || 'This campaign is read-only.');
      container.appendChild(reason);
      // V1e-6: nothing to show a rail for on a screen buildForm never built.
      ScriptoriumAdmin.pane.unregister('vocab');
      vocabFormCtl = null;
      return;
    }

    var packToml = state.packToml || {};
    if (!packToml.exists) {
      var notice = el('p');
      notice.className = 'vocab-readonly';
      setText(notice, 'Save a theme first; that creates pack.toml.');
      container.appendChild(notice);
      ScriptoriumAdmin.pane.unregister('vocab');
      vocabFormCtl = null;
      return;
    }

    if (packToml.error) {
      var err = el('p');
      err.className = 'vocab-error';
      setText(err, packToml.error);
      container.appendChild(err);
      ScriptoriumAdmin.pane.unregister('vocab');
      vocabFormCtl = null;
      return;
    }

    buildForm(container, state);
  }

  function init(container) {
    function renderFromStore() {
      var s = store.get();
      if (!s.state || !s.state.vocab) return;
      // SD-7: a screen with pending edits of its own never re-renders from new state.
      if ((s.pending && s.pending.vocab) > 0) return;
      render(container, s.state);
    }
    store.subscribe(function (next, prev) {
      if (next.state !== prev.state || next.pending !== prev.pending) renderFromStore();
    });

    // SD-8: re-evaluate on a busy change alone (see pack.js's own comment for why this is
    // separate from the state/pending re-render above).
    store.subscribe(function (next, prev) {
      if (next.busy === prev.busy) return;
      if (vocabReviewBtn) vocabReviewBtn.disabled = vocabOwnDisabled || store.isBusy();
    });

    // V1e-6 (SD-36): re-evaluate the rail registration and the toolbar/note visibility on a
    // prefs change (a view switch, or rail.hidden toggling from outside this render's own click
    // handlers) or a viewport-class change (store.viewport, undefined and therefore never !==
    // itself before V1e-3 lands -- harmless until then, per Part 8).
    store.subscribe(function (next, prev) {
      if (next.prefs === prev.prefs && next.viewport === prev.viewport) return;
      if (vocabFormCtl) vocabFormCtl.refreshHelpUi();
    });

    renderFromStore();
  }

  // V1e-8 (ADR 0039 addendum, SD-72): published so assets/admin/variants.js's vocabExample can
  // read VB.EXAMPLE_CAPTIONS/VB.exampleFocus (variants.js loads BEFORE vocab.js, index.html, so
  // this can only ever be read lazily at call time -- sitepane.js's own `ScriptoriumAdmin.PV = PV`
  // is the precedent, loaded the other way around).
  window.ScriptoriumAdmin.VB = VB;

  ScriptoriumAdmin.register('vocab', function (container) {
    init(container);
  });
})();
