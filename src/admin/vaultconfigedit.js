'use strict';

const { isDeepStrictEqual } = require('util');
const read = require('../vault/read');
const pinned = require('../generator/pinned');
const { JSON_BODY_CAP } = require('./body');

/*
 * V1e-1 (ADR 0033, SD-4): a line-level locator and editor for exactly `publish.theme.tagline` in
 * _meta/vault-config.md's frontmatter block YAML. Pure -- no fs anywhere in this file. Correctness
 * is carried by two guards run against the parsed result (semanticGuard, textualGuard), never by
 * the locator itself: anything the locator can't confidently classify is refused, and a refusal
 * here is always safe (the file stays exactly as it was).
 *
 * The whole-file model (splitFile) keeps `head` (an optional BOM plus the opening "---" line) and
 * `tail` (the closing "---" line plus the entire body) as untouched string slices of the original
 * text -- they are never re-encoded, so a comment, a date literal, or the body itself can never be
 * disturbed by anything below. Only `lines` (the frontmatter's own content lines, each carrying
 * its own line ending) is ever spliced.
 */

// -- Line-splitting helpers ---------------------------------------------------

function splitKeepingEol(s) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      lines.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) lines.push(s.slice(start));
  return lines;
}

function eolOf(line) {
  if (line.endsWith('\r\n')) return '\r\n';
  if (line.endsWith('\n')) return '\n';
  return null;
}

function stripEol(line) {
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  if (line.endsWith('\n')) return line.slice(0, -1);
  return line;
}

// -- splitFile -----------------------------------------------------------------

const REASON = {
  notUtf8: "vault-config.md isn't valid UTF-8 text, so the panel won't edit it.",
  noOpen: "vault-config.md doesn't start with a plain --- line, so the panel won't edit it. Change the tagline in the file by hand.",
  noClose: "vault-config.md's frontmatter has no closing --- line, so the panel won't edit it. Change the tagline in the file by hand.",
  mixedEol: "vault-config.md mixes line endings in its frontmatter, so the panel won't edit it. Change the tagline in the file by hand.",
  tooLarge: "vault-config.md's frontmatter is larger than the 64 KiB the panel can edit.",
};

/** V1e-9 (SD-94): REASON's own string -> splitFileDetailed's code, one per failure branch. */
const REASON_CODE = {
  notUtf8: 'not-utf8',
  noOpen: 'no-open',
  noClose: 'no-close',
  mixedEol: 'mixed-eol',
  tooLarge: 'too-large',
};

/**
 * V1e-9 (SD-94): the same logic as splitFile, additionally naming which of the 5 reasons failed
 * (`code`) so callers (src/admin/handlers/vaultconfigeditor.js's EDITOR_REASON lookup) don't have
 * to string-match the human `reason` text.
 *
 * @param {Buffer} buf the whole file's bytes
 * @returns {{ok:true, head:string, eol:string, lines:string[], tail:string, frontmatterText:string} |
 *   {ok:false, code:'not-utf8'|'no-open'|'no-close'|'mixed-eol'|'too-large', reason:string}}
 */
function splitFileDetailed(buf) {
  let text;
  try {
    text = buf.toString('utf8');
  } catch {
    return { ok: false, code: REASON_CODE.notUtf8, reason: REASON.notUtf8 };
  }
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    return { ok: false, code: REASON_CODE.notUtf8, reason: REASON.notUtf8 };
  }

  const bomLen = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const bom = bomLen ? text.slice(0, 1) : '';
  const rest = text.slice(bomLen);
  const rawLines = splitKeepingEol(rest);

  if (rawLines.length === 0) {
    return { ok: false, code: REASON_CODE.noOpen, reason: REASON.noOpen };
  }

  const firstLine = rawLines[0];
  const firstEol = eolOf(firstLine);
  if (stripEol(firstLine) !== '---' || firstEol === null) {
    return { ok: false, code: REASON_CODE.noOpen, reason: REASON.noOpen };
  }
  const eol = firstEol;

  let closeIdx = -1;
  for (let i = 1; i < rawLines.length; i++) {
    if (stripEol(rawLines[i]).startsWith('---')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1 || stripEol(rawLines[closeIdx]) !== '---') {
    return { ok: false, code: REASON_CODE.noClose, reason: REASON.noClose };
  }

  const frontmatterLines = rawLines.slice(1, closeIdx);
  for (const line of frontmatterLines) {
    const lineEol = eolOf(line);
    if (lineEol === null || lineEol !== eol) {
      return { ok: false, code: REASON_CODE.mixedEol, reason: REASON.mixedEol };
    }
  }

  const frontmatterText = frontmatterLines.join('');
  if (Buffer.byteLength(frontmatterText, 'utf8') > JSON_BODY_CAP) {
    return { ok: false, code: REASON_CODE.tooLarge, reason: REASON.tooLarge };
  }

  const head = bom + firstLine;
  const tail = rawLines.slice(closeIdx).join('');

  return { ok: true, head, eol, lines: frontmatterLines, tail, frontmatterText };
}

/**
 * @param {Buffer} buf the whole file's bytes
 * @returns {{ok:true, head:string, eol:string, lines:string[], tail:string, frontmatterText:string} | {ok:false, reason:string}}
 */
function splitFile(buf) {
  const result = splitFileDetailed(buf);
  if (!result.ok) return { ok: false, reason: result.reason };
  return result;
}

// -- locateTagline ---------------------------------------------------------------

function describeLine(raw) {
  const text = stripEol(raw);
  const indentMatch = /^[ \t]*/.exec(text)[0];
  const hasTab = indentMatch.includes('\t');
  const indent = indentMatch.length;
  const rest = text.slice(indent);
  const isBlank = rest.length === 0;
  const m = /^([^\s:#][^:]*):(.*)$/.exec(rest);
  let key = null;
  let form = null;
  if (m) {
    key = m[1];
    const valueTrimmed = m[2].trim();
    if (valueTrimmed === '' || /^#/.test(valueTrimmed)) {
      form = null;
    } else if (valueTrimmed.startsWith('{') || valueTrimmed.startsWith('[')) {
      form = 'a flow mapping';
    } else if (valueTrimmed.startsWith('|') || valueTrimmed.startsWith('>')) {
      form = 'a block scalar';
    } else if (/^[&*!]/.test(valueTrimmed)) {
      form = 'an anchor, alias or tag';
    } else {
      form = 'scalar';
    }
  }
  return { indent, hasTab, isBlank, key, form };
}

/** Lines after `startIdx` with indent > `headerIndent`, blank lines never terminate the range. */
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

const UNUSUAL = 'an unusual layout';

/**
 * @param {{lines: string[]}} model splitFile's result
 * @param {object} ours Scriptorium's own parsed frontmatter `data` for the SAME text
 * @returns {{ok:true, hasPublish:boolean, hasTheme:boolean, hasTagline:boolean, currentValue:string|null, ...} | {ok:false, form:string}}
 */
function locateTagline(model, ours) {
  const descs = model.lines.map(describeLine);
  const safeOurs = ours && typeof ours === 'object' && !Array.isArray(ours) ? ours : {};

  if (descs.some((d) => d.hasTab)) return { ok: false, form: UNUSUAL };

  const publishIdx = descs.findIndex((d) => d.indent === 0 && d.key === 'publish');
  const oursHasPublish = Object.prototype.hasOwnProperty.call(safeOurs, 'publish');

  if (publishIdx === -1) {
    if (oursHasPublish) return { ok: false, form: UNUSUAL };
    return { ok: true, hasPublish: false, hasTheme: false, hasTagline: false, currentValue: null };
  }
  if (!oursHasPublish) return { ok: false, form: UNUSUAL };

  const publishDesc = descs[publishIdx];
  if (publishDesc.form === 'a flow mapping') return { ok: false, form: 'a flow mapping' };
  if (publishDesc.form === 'a block scalar') return { ok: false, form: 'a block scalar' };
  if (publishDesc.form === 'an anchor, alias or tag') return { ok: false, form: 'an anchor, alias or tag' };
  if (publishDesc.form === 'scalar') return { ok: false, form: UNUSUAL };

  const oursPublish = safeOurs.publish;
  if (oursPublish === null || typeof oursPublish !== 'object' || Array.isArray(oursPublish)) {
    return { ok: false, form: UNUSUAL };
  }

  const publishEnd = ownRangeEnd(descs, publishIdx, 0);
  const publishChildIndent = firstChildIndent(descs, publishIdx + 1, publishEnd);
  if (publishChildIndent !== null && hasMergeKeyAt(descs, publishIdx + 1, publishEnd, publishChildIndent)) {
    return { ok: false, form: 'a merge key' };
  }

  const themeHit = publishChildIndent === null ? null : findChildAt(descs, publishIdx + 1, publishEnd, publishChildIndent, 'theme');
  const oursHasTheme = Object.prototype.hasOwnProperty.call(oursPublish, 'theme');

  const base = { ok: true, hasPublish: true, publishIdx, publishEnd, publishChildIndent };

  if (!themeHit) {
    if (oursHasTheme) return { ok: false, form: UNUSUAL };
    return { ...base, hasTheme: false, hasTagline: false, currentValue: null };
  }
  if (!oursHasTheme) return { ok: false, form: UNUSUAL };
  if (themeHit.form === 'a flow mapping') return { ok: false, form: 'a flow mapping' };
  if (themeHit.form === 'a block scalar') return { ok: false, form: 'a block scalar' };
  if (themeHit.form === 'an anchor, alias or tag') return { ok: false, form: 'an anchor, alias or tag' };
  if (themeHit.form === 'scalar') return { ok: false, form: UNUSUAL };

  const oursTheme = oursPublish.theme;
  if (oursTheme === null || typeof oursTheme !== 'object' || Array.isArray(oursTheme)) {
    return { ok: false, form: UNUSUAL };
  }

  const themeIdx = themeHit.idx;
  const themeEnd = ownRangeEnd(descs, themeIdx, publishChildIndent);
  const themeChildIndent = firstChildIndent(descs, themeIdx + 1, themeEnd);
  if (themeChildIndent !== null && hasMergeKeyAt(descs, themeIdx + 1, themeEnd, themeChildIndent)) {
    return { ok: false, form: 'a merge key' };
  }

  const themeBase = { ...base, hasTheme: true, themeIdx, themeEnd, themeChildIndent };

  const taglineHit = themeChildIndent === null ? null : findChildAt(descs, themeIdx + 1, themeEnd, themeChildIndent, 'tagline');
  const oursHasTagline = Object.prototype.hasOwnProperty.call(oursTheme, 'tagline');

  if (!taglineHit) {
    if (oursHasTagline) return { ok: false, form: UNUSUAL };
    return { ...themeBase, hasTagline: false, currentValue: null };
  }
  if (!oursHasTagline) return { ok: false, form: UNUSUAL };
  if (taglineHit.form === 'a flow mapping') return { ok: false, form: 'a flow mapping' };
  if (taglineHit.form === 'a block scalar') return { ok: false, form: 'a block scalar' };
  if (taglineHit.form === 'an anchor, alias or tag') return { ok: false, form: 'an anchor, alias or tag' };

  const oursTaglineValue = oursTheme.tagline;
  if (typeof oursTaglineValue !== 'string') return { ok: false, form: "a value that isn't text" };

  const taglineIdx = taglineHit.idx;
  // Issue #87: ownRangeEnd lets blank lines ride along; trailing ones are not the tagline's own
  // lines, so trim them or the textual guard sees more than the tagline changing.
  let taglineEnd = ownRangeEnd(descs, taglineIdx, themeChildIndent);
  while (taglineEnd > taglineIdx + 1 && descs[taglineEnd - 1].isBlank) taglineEnd--;

  return { ...themeBase, hasTagline: true, taglineIdx, taglineEnd, currentValue: oursTaglineValue };
}

// -- applyTagline ------------------------------------------------------------

function hasNonBlankContent(lines, start, end) {
  for (let i = start; i < end; i++) {
    if (stripEol(lines[i]).trim() !== '') return true;
  }
  return false;
}

function applyClear(model, plan) {
  if (!plan.hasTagline) {
    return Buffer.from(model.head + model.lines.join('') + model.tail, 'utf8');
  }
  const lines = model.lines.slice();
  const tRemoved = plan.taglineEnd - plan.taglineIdx;
  lines.splice(plan.taglineIdx, tRemoved);

  const themeIdx = plan.themeIdx;
  let themeEnd = plan.themeEnd - tRemoved;

  if (!hasNonBlankContent(lines, themeIdx + 1, themeEnd)) {
    const thRemoved = themeEnd - themeIdx;
    lines.splice(themeIdx, thRemoved);

    const publishIdx = plan.publishIdx;
    const publishEnd = plan.publishEnd - tRemoved - thRemoved;
    if (!hasNonBlankContent(lines, publishIdx + 1, publishEnd)) {
      lines.splice(publishIdx, publishEnd - publishIdx);
    }
  }

  return Buffer.from(model.head + lines.join('') + model.tail, 'utf8');
}

/**
 * @param {{head:string, eol:string, lines:string[], tail:string}} model splitFile's result
 * @param {object} plan locateTagline's ok:true result
 * @param {string} value '' clears; anything else sets
 * @returns {Buffer}
 */
function applyTagline(model, plan, value) {
  if (value === '') return applyClear(model, plan);

  const eol = model.eol;
  const encoded = JSON.stringify(value);
  const newLine = (indent, text) => ' '.repeat(indent) + text + eol;
  const lines = model.lines.slice();

  if (plan.hasTagline) {
    const indent = describeLine(model.lines[plan.taglineIdx]).indent;
    lines.splice(plan.taglineIdx, plan.taglineEnd - plan.taglineIdx, newLine(indent, `tagline: ${encoded}`));
    return Buffer.from(model.head + lines.join('') + model.tail, 'utf8');
  }

  const step = plan.hasPublish && plan.publishChildIndent !== null ? plan.publishChildIndent : 2;

  if (plan.hasTheme) {
    const indent = plan.themeChildIndent !== null ? plan.themeChildIndent : plan.publishChildIndent + step;
    lines.splice(plan.themeEnd, 0, newLine(indent, `tagline: ${encoded}`));
    return Buffer.from(model.head + lines.join('') + model.tail, 'utf8');
  }

  if (plan.hasPublish) {
    const themeIndent = plan.publishChildIndent !== null ? plan.publishChildIndent : step;
    const taglineIndent = themeIndent + step;
    const insertion = newLine(themeIndent, 'theme:') + newLine(taglineIndent, `tagline: ${encoded}`);
    lines.splice(plan.publishEnd, 0, insertion);
    return Buffer.from(model.head + lines.join('') + model.tail, 'utf8');
  }

  const insertion = newLine(0, 'publish:') + newLine(step, 'theme:') + newLine(step * 2, `tagline: ${encoded}`);
  lines.push(insertion);
  return Buffer.from(model.head + lines.join('') + model.tail, 'utf8');
}

// -- semanticGuard ------------------------------------------------------------

function strip(data) {
  const copy = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  if (copy.publish && typeof copy.publish === 'object' && !Array.isArray(copy.publish)) {
    const publish = { ...copy.publish };
    if (publish.theme && typeof publish.theme === 'object' && !Array.isArray(publish.theme)) {
      const theme = { ...publish.theme };
      delete theme.tagline;
      if (Object.keys(theme).length === 0) delete publish.theme;
      else publish.theme = theme;
    }
    if (Object.keys(publish).length === 0) delete copy.publish;
    else copy.publish = publish;
  }
  return copy;
}

/**
 * @param {object} cur the CURRENT text's parsed data (one parser)
 * @param {object} cand the CANDIDATE text's parsed data (the SAME parser)
 * @param {string} value '' for clear, else the set value
 * @returns {boolean}
 */
function semanticGuard(cur, cand, value) {
  if (!isDeepStrictEqual(strip(cur), strip(cand))) return false;
  const candPublish = cand && typeof cand === 'object' ? cand.publish : undefined;
  const candTheme = candPublish && typeof candPublish === 'object' ? candPublish.theme : undefined;
  if (value === '') {
    return !(candTheme && typeof candTheme === 'object' && Object.prototype.hasOwnProperty.call(candTheme, 'tagline'));
  }
  return Boolean(candTheme && typeof candTheme === 'object' && candTheme.tagline === value);
}

// -- textualGuard ------------------------------------------------------------

/**
 * Independent of the locator: never receives `plan`, only the two splitFile models. Pattern rules
 * only -- see the module doc comment.
 *
 * @param {{head:string, tail:string, lines:string[]}} model the CURRENT file's split model
 * @param {{head:string, tail:string, lines:string[]}} candModel the CANDIDATE's split model
 * @returns {boolean}
 */
function textualGuard(model, candModel) {
  if (model.head !== candModel.head) return false;
  if (model.tail !== candModel.tail) return false;

  const a = model.lines;
  const b = candModel.lines;

  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const removed = a.slice(p, a.length - s);
  const added = b.slice(p, b.length - s);

  for (const line of removed) {
    const rest = stripEol(line).replace(/^ */, '');
    if (rest === '') return false;
    if (rest.startsWith('#')) return false;
  }

  for (const line of added) {
    const stripped = stripEol(line);
    if (/^ *(publish|theme):$/.test(stripped)) continue;
    if (/^ *tagline: ".*"$/.test(stripped)) continue;
    return false;
  }

  let taglineIndent = null;
  for (const line of removed) {
    const stripped = stripEol(line);
    if (/^ *(publish|theme):$/.test(stripped)) {
      taglineIndent = null;
      continue;
    }
    const indent = /^( *)/.exec(stripped)[1].length;
    if (/^ *tagline:/.test(stripped)) {
      taglineIndent = indent;
      continue;
    }
    if (taglineIndent !== null && indent > taglineIndent) continue;
    return false;
  }

  return true;
}

// -- parseWithBoth -------------------------------------------------------------

/** V1e-9 (SD-94): file line = err.mark.line + 1 (js-yaml's mark is 0-based); null without a mark. */
function lineFromErr(err) {
  return err && err.mark && Number.isInteger(err.mark.line) ? err.mark.line + 1 : null;
}

/**
 * V1e-9 (SD-94): the same logic as parseWithBoth, additionally naming which reader failed and
 * (when the failing error carries a js-yaml mark) the 1-based file line.
 *
 * @param {string} text a whole document (delimiters and body, exactly as gray-matter expects)
 * @returns {{ok:true, scriptorium:{data:object,content:string}, generator:{data:object,content:string}} |
 *   {ok:false, reader:'scriptorium'|'generator', reason:string, line:number|null}}
 */
function parseWithBothDetailed(text) {
  const s = read.parseFrontmatterText(text);
  if (!s.ok) {
    return {
      ok: false,
      reader: 'scriptorium',
      reason: `vault-config.md's frontmatter doesn't parse (scriptorium reader): ${s.error.message}`,
      line: lineFromErr(s.error),
    };
  }
  let g;
  try {
    g = pinned.generatorGrayMatter(text, {});
  } catch (err) {
    return {
      ok: false,
      reader: 'generator',
      reason: `vault-config.md's frontmatter doesn't parse (generator reader): ${err.message}`,
      line: lineFromErr(err),
    };
  }
  if (s.data === null || typeof s.data !== 'object' || Array.isArray(s.data)) {
    return {
      ok: false,
      reader: 'scriptorium',
      reason: "vault-config.md's frontmatter doesn't parse (scriptorium reader): frontmatter must be a mapping",
      line: null,
    };
  }
  if (g.data === null || typeof g.data !== 'object' || Array.isArray(g.data)) {
    return {
      ok: false,
      reader: 'generator',
      reason: "vault-config.md's frontmatter doesn't parse (generator reader): frontmatter must be a mapping",
      line: null,
    };
  }
  return { ok: true, scriptorium: { data: s.data, content: s.content }, generator: { data: g.data, content: g.content } };
}

/**
 * @param {string} text a whole document (delimiters and body, exactly as gray-matter expects)
 * @returns {{ok:true, scriptorium:{data:object,content:string}, generator:{data:object,content:string}} | {ok:false, reason:string}}
 */
function parseWithBoth(text) {
  const result = parseWithBothDetailed(text);
  if (!result.ok) return { ok: false, reason: result.reason };
  return result;
}

module.exports = {
  splitFile,
  splitFileDetailed,
  locateTagline,
  applyTagline,
  semanticGuard,
  textualGuard,
  parseWithBoth,
  parseWithBothDetailed,
  describeLine,
  stripEol,
};
