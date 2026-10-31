'use strict';

const { JSON_BODY_CAP } = require('./body');

/*
 * Whole-file candidates for _meta/vault-config.yaml, the twin of vaultconfigcandidate.js. The
 * browser edits the whole file as plain lines; a candidate is those lines written back with the
 * file's own byte order mark and line ending. Pure: nothing here reads or writes a file.
 *
 * Each line of a candidate ends with the line ending, so a file whose last line had none gains one.
 */

const YAML_EDITOR_REASON = Object.freeze({
  'not-utf8': "vault-config.yaml isn't valid UTF-8 text, so the panel won't edit it.",
  'mixed-eol': "vault-config.yaml mixes line endings in the file, so the panel won't edit it. Edit it by hand.",
  'too-large': 'vault-config.yaml is larger than the 64 KiB the panel can edit.',
  'lone-cr':
    "Line <N> of vault-config.yaml has a stray carriage return that the browser's editor would change, so the panel won't edit it. Edit it by hand.",
});

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

/**
 * @param {Buffer} bytes the whole file
 * @returns {{ok:true, bom:boolean, eol:'\n'|'\r\n', lines:string[]} | {ok:false, code:'not-utf8'|'mixed-eol'|'too-large'}}
 *   `lines` keep their own line ending (the last may have none); `eol` is the first line's ending,
 *   or '\n' for a file with none
 */
function splitYamlFile(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { ok: false, code: 'not-utf8' };
  const bom = text.charCodeAt(0) === 0xfeff;
  const rest = bom ? text.slice(1) : text;
  if (Buffer.byteLength(rest, 'utf8') > JSON_BODY_CAP) return { ok: false, code: 'too-large' };
  const lines = splitKeepingEol(rest);
  const ends = lines.map(eolOf).filter((e) => e !== null);
  const eol = ends.length > 0 ? ends[0] : '\n';
  if (ends.some((e) => e !== eol)) return { ok: false, code: 'mixed-eol' };
  return { ok: true, bom, eol, lines };
}

/**
 * @param {{lines: string[]}} split splitYamlFile's result
 * @returns {string} the lines without their endings, joined by '\n', no trailing newline
 */
function yamlEditorText(split) {
  return split.lines.map(stripEol).join('\n');
}

/**
 * @param {{lines: string[]}} split splitYamlFile's result
 * @returns {number|null} the file line (from 1) of the first line that still holds a stray \r
 *   once its own ending is taken off, else null
 */
function yamlLoneCrLine(split) {
  for (let i = 0; i < split.lines.length; i++) {
    if (stripEol(split.lines[i]).includes('\r')) return i + 1;
  }
  return null;
}

function assemble(split, lines) {
  const text = lines.map((l) => l + split.eol).join('');
  return { text, bytes: Buffer.from((split.bom ? '\uFEFF' : '') + text, 'utf8') };
}

/**
 * The candidate for a whole-file text edit.
 *
 * @param {{bom:boolean, eol:string}} split splitYamlFile's result for the CURRENT file
 * @param {string} text the browser's edited text, plain '\n' line breaks
 * @returns {{ok:true, bytes:Buffer, text:string} | {ok:false, line:null, message:string}} `text` is
 *   the candidate as written, line endings included, without the byte order mark
 */
function buildYamlTextCandidate(split, text) {
  if (typeof text !== 'string') return { ok: false, line: null, message: "The edited text isn't valid text." };
  if (text.includes('\r')) return { ok: false, line: null, message: 'The edited text must use plain line breaks.' };
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) return { ok: false, line: null, message: "The edited text isn't valid text." };
  let lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  const { text: written, bytes } = assemble(split, lines);
  return { ok: true, bytes, text: written };
}

/**
 * The candidate for a restore: the backup's lines, written with the CURRENT file's byte order mark
 * and line ending.
 *
 * @param {{bom:boolean, eol:string}} split splitYamlFile's result for the CURRENT file
 * @param {Buffer} backupBytes the backup's whole bytes
 * @returns {{ok:true, bytes:Buffer, text:string, eolChanged:boolean} | {ok:false, code:string}}
 *   `eolChanged` is true when the backup's own lines ended differently
 */
function buildYamlRestoreCandidate(split, backupBytes) {
  const backup = splitYamlFile(backupBytes);
  if (!backup.ok) return { ok: false, code: backup.code };
  const hadEnding = backup.lines.some((l) => eolOf(l) !== null);
  const { text, bytes } = assemble(split, backup.lines.map(stripEol));
  return { ok: true, bytes, text, eolChanged: hadEnding && backup.eol !== split.eol };
}

module.exports = {
  YAML_EDITOR_REASON,
  splitYamlFile,
  yamlEditorText,
  yamlLoneCrLine,
  buildYamlTextCandidate,
  buildYamlRestoreCandidate,
};
