'use strict';

/*
 * Desktop protocol v1 (ADR 0057, "Protocol v1"): the tab-separated UTF-8 lines the background
 * host and the tray helper exchange over the host's stdio pipes.
 *
 * Pure: no I/O, no network, no process access. The tray helper (C) implements the same rules and
 * a parity test pins the two together.
 *
 * Line format: fields joined by one TAB, closed by one LF, at most 1024 bytes including the LF.
 * The sender strips C0 controls and DEL from every field (so a field can never carry a TAB or LF
 * and split or forge a line). A receiver drops a malformed line and ignores an unknown first
 * field.
 */

const { ScriptoriumError } = require('../util/errors');

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 1024;

const HOST_VERBS = Object.freeze(['hello', 'state', 'confirm', 'update', 'bye']);
const HELPER_VERBS = Object.freeze([
  'open', 'stop?', 'stop', 'start', 'restart', 'retry', 'quit?', 'quit',
]);

const CONTROLS = /[\u0000-\u001f\u007f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;

function encodeLine(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ScriptoriumError('protocol line needs at least one field');
  }
  const clean = fields.map((f) => (f === null || f === undefined ? '' : String(f)).replace(CONTROLS, ''));
  const line = clean.join('\t') + '\n';
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new ScriptoriumError('protocol line is longer than ' + MAX_LINE_BYTES + ' bytes');
  }
  return line;
}

function parseLine(text) {
  if (typeof text !== 'string') return null;
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) return null;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body === '') return null;
  // Only TAB may appear among the controls; an embedded LF or CR makes the line malformed.
  if (HAS_CONTROL.test(body.replace(/\t/g, ''))) return null;
  const parts = body.split('\t');
  const verb = parts[0];
  if (!HOST_VERBS.includes(verb) && !HELPER_VERBS.includes(verb)) return null;
  return { verb, args: parts.slice(1) };
}

module.exports = { PROTOCOL_VERSION, HOST_VERBS, HELPER_VERBS, MAX_LINE_BYTES, encodeLine, parseLine };
