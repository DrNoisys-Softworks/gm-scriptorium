'use strict';

const { NetError } = require('./errors');

/*
 * A pure, incremental parser for newline-delimited JSON (ADR 0024, section 3).
 *
 * It takes bytes, decodes them as UTF-8 (a leading byte-order mark is dropped, and a character split
 * across two chunks is held until it is whole), splits on line feeds only, and returns the values
 * that completed. A line that is not JSON fails with the line number and nothing else: the line's
 * text is never put in the error. Lengths are counted in UTF-16 code units of the decoded text, the
 * terminator excluded. After any error or after end(), every call throws.
 */

const DEFAULTS = Object.freeze({ maxLineLength: 1048576 });

function createNdjsonParser(opts = {}) {
  let maxLine = DEFAULTS.maxLineLength;
  if (opts.maxLineLength !== undefined) {
    if (!Number.isSafeInteger(opts.maxLineLength) || opts.maxLineLength < 1) {
      throw new NetError('E_NET_BAD_OPTIONS', { reason: 'limit' });
    }
    maxLine = opts.maxLineLength;
  }
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let lineNumber = 0;
  let done = false;

  function parseLine(raw, out) {
    lineNumber += 1;
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.replace(/[ \t\r]/g, '') === '') return;
    let value;
    try {
      value = JSON.parse(text);
    } catch (_) {
      throw new NetError('E_NDJSON_INVALID', { line: lineNumber });
    }
    out.push(value);
  }

  function push(chunk) {
    if (done) throw new NetError('E_PARSER_DONE');
    try {
      if (!(chunk instanceof Uint8Array)) throw new NetError('E_PARSER_INPUT');
      const text = decoder.decode(chunk, { stream: true });
      const buffer = pending + text;
      const out = [];
      let pos = 0;
      for (;;) {
        const i = buffer.indexOf('\n', pos);
        if (i === -1) break;
        const raw = buffer.slice(pos, i);
        if (raw.length > maxLine) throw new NetError('E_NDJSON_LINE_CAP', { limit: maxLine });
        pos = i + 1;
        parseLine(raw, out);
      }
      pending = buffer.slice(pos);
      if (pending.length > maxLine) throw new NetError('E_NDJSON_LINE_CAP', { limit: maxLine });
      return out;
    } catch (error) {
      done = true;
      throw error;
    }
  }

  function end() {
    if (done) throw new NetError('E_PARSER_DONE');
    done = true;
    const rest = pending + decoder.decode();
    pending = '';
    const out = [];
    parseLine(rest, out);
    return out;
  }

  return { push, end };
}

module.exports = { DEFAULTS, createNdjsonParser };
