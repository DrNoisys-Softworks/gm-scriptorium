'use strict';

const { ScriptoriumError } = require('../util/errors');

/*
 * The one error class for outgoing connections and stream parsing (ADR 0024).
 *
 * The message is looked up from a fixed table by code, so no request or response text can reach it.
 * Only the listed fields are kept, and only when they are short plain strings or whole numbers.
 * The original Node error is never attached: callers read its code and build a fresh NetError.
 */

const MESSAGES = Object.freeze({
  E_NET_BAD_OPTIONS: 'the request options were not accepted',
  E_NET_BAD_URL: 'the address is not a valid URL',
  E_NET_REFUSED: 'the address is not on the list of allowed destinations',
  E_NET_ABORTED: 'the request was cancelled',
  E_NET_TIMEOUT: 'the request took too long',
  E_NET_CONNECT: 'the connection could not be made',
  E_NET_TLS: 'the secure connection could not be verified',
  E_NET_REDIRECT: 'the server answered with a redirect, which is not followed',
  E_NET_RESPONSE_CAP: 'the reply was larger than the allowed size',
  E_NET_INCOMPLETE: 'the connection ended before the reply was complete',
  E_NET_CALLBACK: 'a callback given to the request failed',
  E_SSE_LINE_CAP: 'an event stream line was longer than the allowed size',
  E_SSE_EVENT_CAP: 'an event stream event was larger than the allowed size',
  E_NDJSON_LINE_CAP: 'a stream line was longer than the allowed size',
  E_NDJSON_INVALID: 'a stream line was not valid JSON',
  E_PARSER_INPUT: 'the parser was given something other than bytes',
  E_PARSER_DONE: 'the parser has finished or failed and cannot be used again',
});

const FIELDS = Object.freeze(['destination', 'reason', 'phase', 'status', 'limit', 'syscallCode', 'tlsCode', 'line']);
const SAFE_STRING = /^[A-Za-z0-9_.-]{1,64}$/;

class NetError extends ScriptoriumError {
  constructor(code, fields = {}) {
    if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(MESSAGES, code)) {
      throw new TypeError('unknown network error code');
    }
    super(MESSAGES[code]);
    this.code = code;
    for (const name of FIELDS) {
      const value = fields[name];
      if (typeof value === 'string' && SAFE_STRING.test(value)) this[name] = value;
      else if (Number.isSafeInteger(value)) this[name] = value;
    }
  }
}

module.exports = { NetError, MESSAGES };
