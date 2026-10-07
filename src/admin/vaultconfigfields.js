'use strict';

const { isDeepStrictEqual } = require('util');
const { describeLine, stripEol } = require('./vaultconfigedit');

/*
 * V1e-9 (ADR 0033 addendum, SD-97): pure. A generic block-mapping path locator, plus "set an
 * existing list" with a textual guard and a semantic guard. V1e-9's own use is the three privacy
 * lists (publish.exclude_fields/exclude_sections/exclude_dirs), both for "Put it back" (the
 * effects route) and for computing `fixable` (the review pipeline). V1e-10 extends this file with
 * the field-edit operation (c) and the remaining FIELD_SCHEMA paths.
 */

const UNUSUAL = 'an unusual layout';

/**
 * @param {object} data a parsed frontmatter `data` object
 * @param {string[]} segments
 * @returns {*} the value at `segments`, following OWN properties only at every step, else undefined
 */
function getPath(data, segments) {
  let cur = data;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return undefined;
    }
    cur = cur[seg];
  }
  return cur;
}

/** Lines after `startIdx` with indent > `headerIndent`; blank lines never terminate the range. */
function ownRangeEnd(descs, startIdx, headerIndent) {
  let end = startIdx + 1;
  while (end < descs.length) {
    const d = descs[end];
    if (d.isBlank) {
      end++;
      continue;
    }
    if (d.indent <= headerIndent) break;
    end++;
  }
  return end;
}

function firstChildIndent(descs, start, end) {
  for (let i = start; i < end; i++) {
    if (!descs[i].isBlank) return descs[i].indent;
  }
  return null;
}

function findChildAt(descs, start, end, indent, name) {
  for (let i = start; i < end; i++) {
    const d = descs[i];
    if (d.isBlank || d.indent !== indent) continue;
    if (d.key === name) return { idx: i, form: d.form };
  }
  return null;
}

function hasMergeKeyAt(descs, start, end, indent) {
  for (let i = start; i < end; i++) {
    const d = descs[i];
    if (!d.isBlank && d.indent === indent && d.key === '<<') return true;
  }
  return false;
}

/** The leaf range: the key line, then indented children, then (only when nothing is indented
 * under the key) same-indent `- ` list items -- the block-list-at-the-key's-own-indent form. */
function leafRange(descs, lines, keyIdx, keyIndent) {
  let end = ownRangeEnd(descs, keyIdx, keyIndent);
  if (end === keyIdx + 1) {
    while (end < descs.length) {
      const d = descs[end];
      if (d.isBlank || d.indent !== keyIndent) break;
      const text = stripEol(lines[end]).slice(keyIndent);
      if (!text.startsWith('- ')) break;
      end++;
    }
  }
  return end;
}

/** A `#` outside any double-quoted span, after at least one space -- strips it and the rest of
 * the line, so a trailing comment on a flow-list key line never breaks shape detection. */
function stripTrailingComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inQuote = !inQuote;
    else if (ch === '#' && !inQuote && i > 0 && /\s/.test(line[i - 1])) return line.slice(0, i).trimEnd();
  }
  return line;
}

function valueTextOf(line, key) {
  const idx = line.indexOf(key + ':');
  return idx === -1 ? '' : stripTrailingComment(line.slice(idx + key.length + 1).trim());
}

/** Trailing blank lines (from `start` to `end`, exclusive) are excluded from the returned end. */
function trimTrailingBlank(descs, start, end) {
  let e = end;
  while (e > start && descs[e - 1].isBlank) e--;
  return e;
}

/**
 * @param {{lines: string[]}} split splitFileDetailed's result
 * @param {object} data the SAME text's parsed `data` (own-property cross-checked at every level)
 * @param {string[]} segments e.g. ['publish', 'exclude_fields']
 * @returns {{ok:true, shape:'absent'} |
 *   {ok:true, shape:'flow'|'block'|'scalar', keyIdx:number, keyIndent:number, rangeStart:number,
 *     rangeEnd:number, itemIndent:number|null} |
 *   {ok:false, form:string}}
 */
function locatePath(split, data, segments) {
  const lines = split.lines;
  const descs = lines.map(describeLine);
  if (descs.some((d) => d.hasTab)) return { ok: false, form: UNUSUAL };

  const safeData = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  let searchStart = 0;
  let searchEnd = descs.length;
  let ours = safeData;
  let keyIdx = -1;
  let keyIndent = 0;

  for (let level = 0; level < segments.length; level++) {
    const seg = segments[level];
    const isLast = level === segments.length - 1;
    const indent = level === 0 ? 0 : firstChildIndent(descs, keyIdx + 1, searchEnd);

    if (indent === null) {
      if (Object.prototype.hasOwnProperty.call(ours, seg)) return { ok: false, form: UNUSUAL };
      return { ok: true, shape: 'absent' };
    }
    if (hasMergeKeyAt(descs, searchStart, searchEnd, indent)) {
      return { ok: false, form: 'a merge key' };
    }

    const hit = findChildAt(descs, searchStart, searchEnd, indent, seg);
    const oursHasSeg = Object.prototype.hasOwnProperty.call(ours, seg);

    if (!hit) {
      if (oursHasSeg) return { ok: false, form: UNUSUAL };
      return { ok: true, shape: 'absent' };
    }
    if (!oursHasSeg) return { ok: false, form: UNUSUAL };

    if (!isLast) {
      if (hit.form === 'a flow mapping') return { ok: false, form: 'a flow mapping' };
      if (hit.form === 'a block scalar') return { ok: false, form: 'a block scalar' };
      if (hit.form === 'an anchor, alias or tag') return { ok: false, form: 'an anchor, alias or tag' };
      const next = ours[seg];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) return { ok: false, form: UNUSUAL };
      ours = next;
      keyIdx = hit.idx;
      searchEnd = ownRangeEnd(descs, hit.idx, indent);
      searchStart = hit.idx + 1;
      keyIndent = indent;
      continue;
    }

    // Leaf.
    keyIdx = hit.idx;
    keyIndent = indent;
    if (hit.form === 'an anchor, alias or tag') return { ok: false, form: 'an anchor, alias or tag' };

    const rangeStart = keyIdx;
    let rangeEnd = leafRange(descs, lines, keyIdx, keyIndent);
    rangeEnd = trimTrailingBlank(descs, rangeStart + 1, rangeEnd) < rangeStart + 1 ? rangeStart + 1 : trimTrailingBlank(descs, rangeStart + 1, rangeEnd);

    const keyLineText = stripEol(lines[keyIdx]);
    const valueText = valueTextOf(keyLineText, seg);

    if (valueText.startsWith('[')) {
      if (!valueText.endsWith(']')) return { ok: false, form: 'a list written across several lines' };
      const parsedValue = ours[seg];
      if (!Array.isArray(parsedValue) || !parsedValue.every((v) => typeof v === 'string')) {
        return { ok: false, form: 'a list holding something other than text' };
      }
      return { ok: true, shape: 'flow', keyIdx, keyIndent, rangeStart, rangeEnd, itemIndent: null };
    }
    if (hit.form === 'a flow mapping') return { ok: false, form: UNUSUAL };
    if (hit.form === 'a block scalar') return { ok: false, form: 'a block scalar' };

    if (valueText === '' || valueText.startsWith('#')) {
      // Block form, or absent/empty (treated as block so setList can still render into it).
      const itemIndent = firstChildIndent(descs, keyIdx + 1, rangeEnd) ?? keyIndent;
      for (let i = rangeStart + 1; i < rangeEnd; i++) {
        const d = descs[i];
        if (d.isBlank) continue;
        const stripped = stripEol(lines[i]).slice(d.indent);
        if (stripped.startsWith('#')) return { ok: false, form: 'comments between the entries' };
        if (!stripped.startsWith('- ')) continue;
        const item = stripped.slice(2);
        // "- key: value" (an unquoted, unbracketed colon before any further structure) is a
        // mapping item, not a plain scalar.
        if (/^[^"'\s][^:]*:\s/.test(item) || /^[^"'\s][^:]*:$/.test(item)) {
          return { ok: false, form: 'a list of settings' };
        }
      }
      const parsedValue = ours[seg];
      if (!Array.isArray(parsedValue) || !parsedValue.every((v) => typeof v === 'string')) {
        return { ok: false, form: 'a list holding something other than text' };
      }
      return { ok: true, shape: 'block', keyIdx, keyIndent, rangeStart, rangeEnd, itemIndent };
    }

    return { ok: true, shape: 'scalar', keyIdx, keyIndent, rangeStart, rangeEnd: keyIdx + 1, itemIndent: null };
  }

  return { ok: false, form: UNUSUAL };
}

/**
 * @param {{indent:number, key:string, items:string[], shape:'flow'|'block', itemIndent:number, eol:string}} args
 * @returns {string[]} rendered lines, each carrying `eol`
 */
function renderList({ indent, key, items, shape, itemIndent, eol }) {
  if (shape === 'block' && items.length > 0) {
    const out = [' '.repeat(indent) + key + ':' + eol];
    for (const item of items) out.push(' '.repeat(itemIndent) + '- ' + JSON.stringify(item) + eol);
    return out;
  }
  return [' '.repeat(indent) + key + ': [' + items.map((i) => JSON.stringify(i)).join(', ') + ']' + eol];
}

/** A `#` outside any double-quoted span, after at least one space -- a quote-aware comment scan. */
function hasTrailingComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inQuote = !inQuote;
    else if (ch === '#' && !inQuote && i > 0 && /\s/.test(line[i - 1])) return true;
  }
  return false;
}

/**
 * @param {{lines:string[], eol:string}} split
 * @param {object} data
 * @param {string[]} segments
 * @param {string[]} items the new list, in order
 * @returns {{ok:true, bytes:Buffer, notes:string[]} | {ok:false, form:string}}
 */
function setList(split, data, segments, items) {
  const plan = locatePath(split, data, segments);
  if (!plan.ok) return { ok: false, form: plan.form };
  if (plan.shape === 'absent' || plan.shape === 'scalar') {
    return { ok: false, form: "a setting that isn't a list here" };
  }

  const key = segments[segments.length - 1];
  const replacedLines = split.lines.slice(plan.rangeStart, plan.rangeEnd);
  const notes = [];
  if (replacedLines.some((l) => hasTrailingComment(stripEol(l)))) {
    notes.push(`A comment on the ${key} line is removed.`);
  }

  const itemIndent = plan.itemIndent !== null ? plan.itemIndent : plan.keyIndent + 2;
  const rendered = renderList({ indent: plan.keyIndent, key, items, shape: plan.shape, itemIndent, eol: split.eol });

  // The note fires when the CURRENT value, re-rendered through the same builder, isn't
  // byte-equal to what's actually on disk today -- i.e. the original was written in some
  // non-canonical form (single quotes, odd spacing) that this replace will normalize away.
  const originalItems = Array.isArray(getPath(data, segments)) ? getPath(data, segments) : [];
  const originalRendered = renderList({ indent: plan.keyIndent, key, items: originalItems, shape: plan.shape, itemIndent, eol: split.eol });
  if (originalRendered.join('') !== replacedLines.join('')) {
    notes.push(`The ${key} list is written back with every entry in double quotes.`);
  }

  const newLines = split.lines.slice(0, plan.rangeStart).concat(rendered, split.lines.slice(plan.rangeEnd));
  const frontmatterText = newLines.join('');
  const bytes = Buffer.from(split.head + frontmatterText + split.tail, 'utf8');
  return { ok: true, bytes, notes };
}

const LEAF_RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s) {
  return s.replace(LEAF_RE_ESCAPE, '\\$&');
}

/**
 * @param {{head:string, tail:string, lines:string[]}} prevSplit
 * @param {{head:string, tail:string, lines:string[]}} nextSplit
 * @param {string} leafKey
 * @returns {boolean}
 */
function listTextualGuard(prevSplit, nextSplit, leafKey) {
  if (prevSplit.head !== nextSplit.head) return false;
  if (prevSplit.tail !== nextSplit.tail) return false;

  const a = prevSplit.lines;
  const b = nextSplit.lines;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const removed = a.slice(p, a.length - s);
  const added = b.slice(p, b.length - s);

  for (const line of removed) {
    const stripped = stripEol(line);
    if (stripped.trim() === '') return false;
    if (/^\s*#/.test(stripped)) return false;
  }

  const leaf = escapeRegex(leafKey);
  const Q = '(?:[^"\\\\]|\\\\.)*';
  const flowRe = new RegExp(`^( *)${leaf}: \\[("${Q}"(, "${Q}")*)?\\]$`);
  const headerRe = new RegExp(`^( *)${leaf}:$`);
  const itemRe = new RegExp(`^( *)- "${Q}"$`);

  for (const line of added) {
    const stripped = stripEol(line);
    if (flowRe.test(stripped) || headerRe.test(stripped) || itemRe.test(stripped)) continue;
    return false;
  }

  if (removed.length === 0) return true;
  const firstStripped = stripEol(removed[0]);
  if (!new RegExp(`^( *)${leaf}:`).test(firstStripped)) return false;
  const firstIndent = /^( *)/.exec(firstStripped)[1].length;
  for (let i = 1; i < removed.length; i++) {
    const stripped = stripEol(removed[i]);
    const indent = /^( *)/.exec(stripped)[1].length;
    if (indent > firstIndent) continue;
    if (/^ *- /.test(stripped) && indent >= firstIndent) continue;
    return false;
  }
  return true;
}

/**
 * @param {object} curData
 * @param {object} candData
 * @param {{segments:string[], value:*}[]} edits
 * @returns {boolean}
 */
function pathsGuard(curData, candData, edits) {
  const stripPaths = (data) => {
    const copy = JSON.parse(JSON.stringify(data));
    for (const { segments } of edits) {
      let cur = copy;
      for (let i = 0; i < segments.length - 1; i++) {
        if (!cur || typeof cur !== 'object') return copy;
        cur = cur[segments[i]];
      }
      if (cur && typeof cur === 'object') delete cur[segments[segments.length - 1]];
    }
    // prune parents left empty, deepest first.
    for (const { segments } of edits) {
      for (let depth = segments.length - 1; depth >= 1; depth--) {
        let parent = copy;
        for (let i = 0; i < depth - 1; i++) {
          if (!parent || typeof parent !== 'object') break;
          parent = parent[segments[i]];
        }
        const key = segments[depth - 1];
        if (parent && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, key)) {
          const child = parent[key];
          if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
            delete parent[key];
          }
        }
      }
    }
    return copy;
  };

  if (!isDeepStrictEqual(stripPaths(curData), stripPaths(candData))) return false;
  for (const { segments, value } of edits) {
    if (!isDeepStrictEqual(getPath(candData, segments), value)) return false;
  }
  return true;
}

// ================================================================================================
// V1e-10 (ADR 0033 second addendum, SD-110, SD-111): the seven editable settings and operation (c).
// ================================================================================================

const { parseWithBothDetailed, splitFileDetailed } = require('./vaultconfigedit');

/**
 * The publish mode is deliberately left out (privacy-critical: it stays "Edit as text instead").
 * publish.mode is deliberately NOT here (privacy-critical: it stays "Edit as text instead").
 */
const FIELD_SCHEMA = Object.freeze(
  [
    { path: 'publish.exclude_fields', kind: 'list', group: 'privacy', label: 'Hidden fields' },
    { path: 'publish.exclude_sections', kind: 'list', group: 'privacy', label: 'Hidden headings' },
    { path: 'publish.exclude_dirs', kind: 'list', group: 'privacy', label: 'Hidden folders' },
    { path: 'publish.landing.featured_npcs', kind: 'list', group: 'safe', label: 'Featured characters' },
    { path: 'publish.landing.quick_links', kind: 'list', group: 'safe', label: 'Quick links' },
    { path: 'publish.landing.max_npcs', kind: 'int', group: 'safe', label: 'How many characters to show', min: 0, max: 100 },
    { path: 'publish.four_oh_four.message', kind: 'string', group: 'safe', label: 'Not-found message', min: 1, max: 300 },
  ].map((f) => Object.freeze(f)),
);

/** SD-110: read-only paths the field layout shows as text. */
const DISPLAY_PATHS = Object.freeze(
  [
    { path: 'publish.mode', group: 'privacy', label: 'Publish mode' },
    { path: 'publish.theme.palette', group: 'look', label: 'Colours' },
    { path: 'publish.theme.fonts', group: 'look', label: 'Fonts' },
    { path: 'publish.theme.campaign_image', group: 'look', label: 'Cover art' },
    { path: 'publish.theme.genre', group: 'look', label: 'Genre preset' },
    { path: 'publish.banners', group: 'look', label: 'Section banners' },
  ].map((d) => Object.freeze(d)),
);

/** An exact-membership lookup (never a prefix test or an object-property lookup). */
const FIELD_BY_PATH = new Map(FIELD_SCHEMA.map((f) => [f.path, f]));

const MAX_LIST_ITEMS = 100;
const LIST_ITEM_MAX = 200;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function codePointLength(s) {
  return Array.from(s).length;
}

/**
 * @param {{path:string, kind:string, label:string, min?:number, max?:number}} entry a FIELD_SCHEMA entry
 * @param {*} value the requested new value
 * @returns {string|null} null when valid, else a message already prefixed with the field label
 */
function validateFieldValue(entry, value) {
  const label = entry.label;
  if (entry.kind === 'list') {
    if (!Array.isArray(value)) return label + ': must be a list of entries.';
    if (value.length > MAX_LIST_ITEMS) return label + ': at most ' + MAX_LIST_ITEMS + ' entries.';
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== 'string') return label + ': every entry must be text.';
      if (item !== item.trim()) return label + ": an entry can't start or end with a space.";
      const len = codePointLength(item);
      if (len < 1 || len > LIST_ITEM_MAX) return label + ': every entry must be 1 to ' + LIST_ITEM_MAX + ' characters.';
      if (CONTROL_RE.test(item)) return label + ": an entry can't hold a line break or other control character.";
      if (seen.has(item)) return label + ': "' + item + '" is listed twice.';
      seen.add(item);
    }
    return null;
  }
  if (entry.kind === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < entry.min || value > entry.max) {
      return label + ': must be a whole number from ' + entry.min + ' to ' + entry.max + '.';
    }
    return null;
  }
  if (typeof value !== 'string') return label + ': must be text.';
  const len = codePointLength(value);
  if (len < entry.min || len > entry.max) return label + ': must be ' + entry.min + ' to ' + entry.max + ' characters.';
  if (CONTROL_RE.test(value)) return label + ": can't hold a line break or other control character.";
  return null;
}

/**
 * The mapping-ancestor half of locatePath: finds the deepest PRESENT mapping on `segments` (a
 * leaf's parent path), with exactly locatePath's refusals on the way down. Used to place an absent
 * leaf. `missingFrom` is the index in `segments` of the first absent mapping, or segments.length
 * when every one is present.
 *
 * @returns {{ok:false, form:string} | {ok:true, missingFrom:number, container:{keyIdx:number,
 *   keyIndent:number, start:number, end:number, childIndent:number|null}}}
 */
function locateMapping(split, data, segments) {
  const lines = split.lines;
  const descs = lines.map(describeLine);
  if (descs.some((d) => d.hasTab)) return { ok: false, form: UNUSUAL };
  let ours = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  let container = { keyIdx: -1, keyIndent: -1, start: 0, end: descs.length, childIndent: 0 };

  for (let level = 0; level < segments.length; level++) {
    const seg = segments[level];
    const indent = level === 0 ? 0 : firstChildIndent(descs, container.start, container.end);
    const oursHas = Object.prototype.hasOwnProperty.call(ours, seg);
    if (indent === null) {
      if (oursHas) return { ok: false, form: UNUSUAL };
      return { ok: true, missingFrom: level, container };
    }
    if (hasMergeKeyAt(descs, container.start, container.end, indent)) return { ok: false, form: 'a merge key' };
    container = { ...container, childIndent: indent };
    const hit = findChildAt(descs, container.start, container.end, indent, seg);
    if (!hit) {
      if (oursHas) return { ok: false, form: UNUSUAL };
      return { ok: true, missingFrom: level, container };
    }
    if (!oursHas) return { ok: false, form: UNUSUAL };
    if (hit.form === 'a flow mapping') return { ok: false, form: 'a flow mapping' };
    if (hit.form === 'a block scalar') return { ok: false, form: 'a block scalar' };
    if (hit.form === 'an anchor, alias or tag') return { ok: false, form: 'an anchor, alias or tag' };
    if (hit.form === 'scalar') return { ok: false, form: UNUSUAL };
    const next = ours[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return { ok: false, form: UNUSUAL };
    ours = next;
    container = { keyIdx: hit.idx, keyIndent: indent, start: hit.idx + 1, end: ownRangeEnd(descs, hit.idx, indent), childIndent: null };
  }

  if (segments.length > 0) {
    const ci = firstChildIndent(descs, container.start, container.end);
    if (ci === null) return { ok: false, form: UNUSUAL };
    container = { ...container, childIndent: ci };
  }
  return { ok: true, missingFrom: segments.length, container };
}

function renderLeaf(entry, value, { indent, key, shape, itemIndent, eol }) {
  if (entry.kind === 'list') return renderList({ indent, key, items: value, shape, itemIndent, eol });
  if (entry.kind === 'int') return [' '.repeat(indent) + key + ': ' + String(value) + eol];
  return [' '.repeat(indent) + key + ': ' + JSON.stringify(value) + eol];
}

const SCALAR_SHAPE_REFUSAL = "a setting that isn't a plain value here";
const LIST_SHAPE_REFUSAL = "a setting that isn't a list here";
const MULTILINE_REFUSAL = 'a value written across several lines';

/** True when a non-blank line indented deeper than the key follows its line (a continued scalar). */
function continuesBelow(descs, keyIdx, keyIndent) {
  for (let i = keyIdx + 1; i < descs.length; i++) {
    if (descs[i].isBlank) continue;
    return descs[i].indent > keyIndent;
  }
  return false;
}

function stepSplitAndData(bytes) {
  const split = splitFileDetailed(bytes);
  if (!split.ok) return null;
  const parsed = parseWithBothDetailed(bytes.toString('utf8'));
  if (!parsed.ok) return null;
  return { split, data: parsed.scriptorium.data };
}

/**
 * Renders the next field edit against `cur`. Returns {ok:true, lines, notes} (the whole new
 * frontmatter lines) or {ok:false, form}.
 */
function renderStep(cur, entry, value, afterRender) {
  const { split, data } = cur;
  const segments = entry.path.split('.');
  const key = segments[segments.length - 1];
  const eol = split.eol;
  const plan = locatePath(split, data, segments);
  if (!plan.ok) return { ok: false, form: plan.form };
  const notes = [];

  let lines;
  if (plan.shape !== 'absent') {
    if (entry.kind === 'list' && plan.shape !== 'flow' && plan.shape !== 'block') return { ok: false, form: LIST_SHAPE_REFUSAL };
    if (entry.kind !== 'list') {
      if (plan.shape !== 'scalar') return { ok: false, form: SCALAR_SHAPE_REFUSAL };
      const descs = split.lines.map(describeLine);
      if (continuesBelow(descs, plan.keyIdx, plan.keyIndent)) return { ok: false, form: MULTILINE_REFUSAL };
    }
    const replaced = split.lines.slice(plan.rangeStart, plan.rangeEnd);
    if (replaced.some((l) => hasTrailingComment(stripEol(l)))) notes.push('A comment on the ' + entry.label + ' line is removed.');
    const itemIndent = plan.itemIndent !== null && plan.itemIndent !== undefined ? plan.itemIndent : plan.keyIndent + 2;
    const rendered = renderLeaf(entry, value, { indent: plan.keyIndent, key, shape: plan.shape, itemIndent, eol });
    if (entry.kind === 'list') {
      const originalItems = Array.isArray(getPath(data, segments)) ? getPath(data, segments) : [];
      const originalRendered = renderList({ indent: plan.keyIndent, key, items: originalItems, shape: plan.shape, itemIndent, eol });
      if (originalRendered.join('') !== replaced.join('')) {
        notes.push('The ' + key + ' list is written back with every entry in double quotes.');
      }
    }
    lines = split.lines.slice(0, plan.rangeStart).concat(rendered, split.lines.slice(plan.rangeEnd));
  } else {
    const parentSegs = segments.slice(0, -1);
    const where = locateMapping(split, data, parentSegs);
    if (!where.ok) return { ok: false, form: where.form };
    const descs = split.lines.map(describeLine);
    const c = where.container;
    const insertAt = trimTrailingBlank(descs, c.start, c.end);

    // The indent step is publish's own child indent when publish is already in the file, else 2.
    const pub = locateMapping(split, data, ['publish']);
    let step = 2;
    if (pub.ok && pub.missingFrom === 1 && pub.container.childIndent !== null) {
      const delta = pub.container.childIndent - pub.container.keyIndent;
      if (delta > 0) step = delta;
    }

    const inserted = [];
    let indent = c.childIndent === null || c.childIndent === undefined ? 0 : c.childIndent;
    for (let i = where.missingFrom; i < parentSegs.length; i++) {
      inserted.push(' '.repeat(indent) + parentSegs[i] + ':' + eol);
      indent += step;
    }
    inserted.push(...renderLeaf(entry, value, { indent, key, shape: 'flow', itemIndent: indent + 2, eol }));
    lines = split.lines.slice(0, insertAt).concat(inserted, split.lines.slice(insertAt));
  }

  if (afterRender) lines = afterRender(lines);
  return { ok: true, lines, notes };
}

const HEADER_RE = /^( *)(publish|landing|four_oh_four):$/;

/**
 * The per-step textual guard for operation (c): only the leaf's own lines (and, on insert, the
 * header lines of the parents that had to be created) may change; the head, the tail and every
 * other line stay byte-identical, and no comment line or blank line is ever removed.
 *
 * @param {{head:string, tail:string, lines:string[]}} prevSplit
 * @param {{head:string, tail:string, lines:string[]}} nextSplit
 * @param {string} leafKey
 * @param {'list'|'int'|'string'} kind
 * @returns {boolean}
 */
function fieldTextualGuard(prevSplit, nextSplit, leafKey, kind) {
  if (prevSplit.head !== nextSplit.head) return false;
  if (prevSplit.tail !== nextSplit.tail) return false;

  const a = prevSplit.lines;
  const b = nextSplit.lines;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.slice(p, a.length - s);
  const added = b.slice(p, b.length - s);

  for (const line of removed) {
    const stripped = stripEol(line);
    if (stripped.trim() === '') return false;
    if (/^\s*#/.test(stripped)) return false;
  }

  const leaf = escapeRegex(leafKey);
  const Q = '(?:[^"\\\\]|\\\\.)*';
  const matchers = [HEADER_RE];
  if (kind === 'list') {
    matchers.push(new RegExp(`^( *)${leaf}: \\[("${Q}"(, "${Q}")*)?\\]$`));
    matchers.push(new RegExp(`^( *)${leaf}:$`));
    matchers.push(new RegExp(`^( *)- "${Q}"$`));
  } else if (kind === 'int') {
    matchers.push(new RegExp(`^( *)${leaf}: -?\\d+$`));
  } else {
    matchers.push(new RegExp(`^( *)${leaf}: "${Q}"$`));
  }
  for (const line of added) {
    const stripped = stripEol(line);
    if (matchers.some((re) => re.test(stripped))) continue;
    return false;
  }

  if (removed.length === 0) return true;
  const firstStripped = stripEol(removed[0]);
  if (!new RegExp(`^( *)${leaf}:`).test(firstStripped)) {
    // The key line itself is unchanged (the diff narrowed to the entries): only whole `- ` entry
    // lines may have been replaced, and only by entry lines (added was already pattern-checked).
    // Which list they belong to is the semantic guard's job: the value at the edited path must
    // be exactly the requested one and every other path unchanged.
    return kind === 'list' && removed.every((l) => /^ *- /.test(stripEol(l)));
  }
  const firstIndent = /^( *)/.exec(firstStripped)[1].length;
  for (let i = 1; i < removed.length; i++) {
    const stripped = stripEol(removed[i]);
    const indent = /^( *)/.exec(stripped)[1].length;
    if (indent > firstIndent) continue;
    if (kind === 'list' && /^ *- /.test(stripped) && indent >= firstIndent) continue;
    return false;
  }
  return true;
}

function pathNamed(done) {
  return done[done.length - 1].segments.join('.');
}

/**
 * SD-111: operation (c). Applies `edits` one path at a time, in FIELD_SCHEMA order, each step
 * re-split and re-parsed from the previous step's bytes, located, rendered and guarded. After the
 * last step the semantic guard runs once per parser.
 *
 * @param {{head:string, tail:string, lines:string[], eol:string}} split the CURRENT file's split
 * @param {object} dataScriptorium that same text's Scriptorium-reader data
 * @param {Object<string,*>} edits plain object: FIELD_SCHEMA path -> requested value (already validated)
 * @param {{_afterRender?:(lines:string[])=>string[], _skipTextualGuard?:boolean}} [testSeams] test-only;
 *   production callers never pass it
 * @returns {{ok:true, bytes:Buffer, notes:string[]} | {ok:false, path:string, form:string}}
 */
function applyFieldEdits(split, dataScriptorium, edits, testSeams) {
  const seams = testSeams || {};
  const origBytes = Buffer.from(split.head + split.lines.join('') + split.tail, 'utf8');
  const origParsed = parseWithBothDetailed(origBytes.toString('utf8'));
  if (!origParsed.ok) return { ok: false, path: FIELD_SCHEMA[0].path, form: UNUSUAL };

  let cur = { split, data: dataScriptorium };
  let curBytes = origBytes;
  const notes = [];
  const done = [];

  for (const entry of FIELD_SCHEMA) {
    if (!Object.prototype.hasOwnProperty.call(edits, entry.path)) continue;
    const value = edits[entry.path];
    const segments = entry.path.split('.');
    if (isDeepStrictEqual(getPath(cur.data, segments), value)) continue;

    const step = renderStep(cur, entry, value, seams._afterRender);
    if (!step.ok) return { ok: false, path: entry.path, form: step.form };

    const nextBytes = Buffer.from(cur.split.head + step.lines.join('') + cur.split.tail, 'utf8');
    const next = stepSplitAndData(nextBytes);
    if (next === null) return { ok: false, path: entry.path, form: UNUSUAL };
    if (!seams._skipTextualGuard && !fieldTextualGuard(cur.split, next.split, segments[segments.length - 1], entry.kind)) {
      return { ok: false, path: entry.path, form: UNUSUAL };
    }
    for (const n of step.notes) if (!notes.includes(n)) notes.push(n);
    done.push({ segments, value });
    cur = next;
    curBytes = nextBytes;
  }

  if (done.length === 0) return { ok: true, bytes: origBytes, notes: [] };

  const finalParsed = parseWithBothDetailed(curBytes.toString('utf8'));
  if (!finalParsed.ok) return { ok: false, path: pathNamed(done), form: UNUSUAL };
  for (const reader of ['scriptorium', 'generator']) {
    if (!pathsGuard(origParsed[reader].data, finalParsed[reader].data, done)) {
      return { ok: false, path: pathNamed(done), form: UNUSUAL };
    }
  }
  return { ok: true, bytes: curBytes, notes };
}

module.exports = {
  FIELD_SCHEMA,
  DISPLAY_PATHS,
  FIELD_BY_PATH,
  validateFieldValue,
  applyFieldEdits,
  fieldTextualGuard,
  locateMapping,
  getPath,
  locatePath,
  renderList,
  setList,
  listTextualGuard,
  pathsGuard,
};
