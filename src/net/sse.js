'use strict';

const { NetError } = require('./errors');

/*
 * A pure, incremental parser for server-sent event streams (ADR 0024, section 3).
 *
 * It takes bytes, decodes them as UTF-8 (a leading byte-order mark is dropped, and a character split
 * across two chunks is held until it is whole), and returns the events that completed. It makes no
 * connection and reads nothing but the bytes it is given. Lengths are counted in UTF-16 code units of
 * the decoded text, terminators excluded. After any error or after end(), every call throws.
 * What an event means is decided by whoever reads it, not here.
 */

const DEFAULTS = Object.freeze({ maxLineLength: 262144, maxEventLength: 1048576 });

function positive(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new NetError('E_NET_BAD_OPTIONS', { reason: 'limit' });
  return value;
}

function createSseParser(opts = {}) {
  const maxLine = positive(opts.maxLineLength, DEFAULTS.maxLineLength);
  const maxEvent = positive(opts.maxEventLength, DEFAULTS.maxEventLength);
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let skipLF = false;
  let data = '';
  let type = '';
  let lastEventId = '';
  let done = false;

  function line(text, out) {
    if (text === '') {
      if (data !== '') {
        out.push({ event: type || 'message', data: data.slice(0, -1), id: lastEventId });
      }
      data = '';
      type = '';
      return;
    }
    if (text[0] === ':') return;
    const colon = text.indexOf(':');
    let field = text;
    let value = '';
    if (colon !== -1) {
      field = text.slice(0, colon);
      value = text.slice(colon + 1);
      if (value[0] === ' ') value = value.slice(1);
    }
    if (field === 'event') type = value;
    else if (field === 'data') {
      data += value + '\n';
      if (data.length > maxEvent) throw new NetError('E_SSE_EVENT_CAP', { limit: maxEvent });
    } else if (field === 'id') {
      if (!value.includes('\u0000')) lastEventId = value;
    }
  }

  function push(chunk) {
    if (done) throw new NetError('E_PARSER_DONE');
    try {
      if (!(chunk instanceof Uint8Array)) throw new NetError('E_PARSER_INPUT');
      let text = decoder.decode(chunk, { stream: true });
      if (text === '') return [];
      if (skipLF) {
        if (text[0] === '\n') text = text.slice(1);
        skipLF = false;
      }
      const buffer = pending + text;
      const out = [];
      let pos = 0;
      for (;;) {
        let i = pos;
        while (i < buffer.length && buffer[i] !== '\r' && buffer[i] !== '\n') i += 1;
        if (i >= buffer.length) break;
        const text1 = buffer.slice(pos, i);
        if (text1.length > maxLine) throw new NetError('E_SSE_LINE_CAP', { limit: maxLine });
        if (buffer[i] === '\r') {
          if (i + 1 < buffer.length) pos = buffer[i + 1] === '\n' ? i + 2 : i + 1;
          else {
            pos = i + 1;
            skipLF = true;
          }
        } else pos = i + 1;
        line(text1, out);
      }
      pending = buffer.slice(pos);
      if (pending.length > maxLine) throw new NetError('E_SSE_LINE_CAP', { limit: maxLine });
      return out;
    } catch (error) {
      done = true;
      throw error;
    }
  }

  function end() {
    if (done) throw new NetError('E_PARSER_DONE');
    done = true;
    decoder.decode();
    pending = '';
    data = '';
    return [];
  }

  return { push, end };
}

module.exports = { DEFAULTS, createSseParser };
