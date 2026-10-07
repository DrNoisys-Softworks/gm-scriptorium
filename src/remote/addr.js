'use strict';

/*
 * V1.5a (docs/decisions/0029-remote-access.md, sections 4 and 5). Pure IP-literal handling for the
 * remote-access settings and the request gate. No `net` (the network-builtin scans allow only
 * src/serve/server.js), so parsing and canonicalising are done here by hand:
 *
 *  - canonicalize() returns RFC 5952 text for IPv6 (lowercase, the longest run of two or more zero
 *    groups compressed, the first on a tie) and plain dotted text for IPv4. An IPv4-mapped IPv6
 *    address (::ffff:a.b.c.d) is returned in its dotted IPv4 form, so a trusted-peer comparison is
 *    the same string comparison whichever way the socket reports the peer.
 *  - Nothing here accepts a zone id, a port, a prefix length or a wildcard: a settings value is an
 *    address, and only an address.
 */

/** Exactly these two literals are "this machine" once a socket peer has been normalised. */
const LOOPBACK_PEERS = Object.freeze(['127.0.0.1', '::1']);

/** @returns {number[]|null} four octets, or null. Decimal only, no leading zeros, no spaces. */
function parseIPv4(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** @returns {number[]|null} eight 16-bit groups, or null. */
function parseIPv6(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 45) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let work = text;
  // An embedded IPv4 tail (::ffff:1.2.3.4) stands for the last two groups.
  const lastColon = work.lastIndexOf(':');
  if (work.includes('.')) {
    const v4 = parseIPv4(work.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    work = `${work.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const doubleAt = work.indexOf('::');
  if (doubleAt !== work.lastIndexOf('::')) return null;
  let head;
  let tail;
  if (doubleAt === -1) {
    head = work.split(':');
    tail = [];
    if (head.length !== 8) return null;
  } else {
    const left = work.slice(0, doubleAt);
    const right = work.slice(doubleAt + 2);
    head = left === '' ? [] : left.split(':');
    tail = right === '' ? [] : right.split(':');
    if (head.length + tail.length > 7) return null;
  }
  const groups = [];
  const pushGroup = (g) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
    groups.push(parseInt(g, 16));
    return true;
  };
  for (const g of head) if (!pushGroup(g)) return null;
  if (doubleAt !== -1) {
    const missing = 8 - head.length - tail.length;
    for (let i = 0; i < missing; i++) groups.push(0);
  }
  for (const g of tail) if (!pushGroup(g)) return null;
  return groups.length === 8 ? groups : null;
}

function formatIPv6(groups) {
  // The longest run of two or more zero groups; the first one on a tie (RFC 5952 4.2.3).
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
  const left = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(':');
  return `${left}::${right}`;
}

/**
 * @param {unknown} text
 * @returns {string|null} the canonical form, or null when `text` is not an IP literal.
 */
function canonicalize(text) {
  if (typeof text !== 'string') return null;
  const v4 = parseIPv4(text);
  if (v4 !== null) return v4.join('.');
  const g = parseIPv6(text);
  if (g === null) return null;
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (mapped) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  return formatIPv6(g);
}

/**
 * The address bytes of an already-canonical literal: 4 for IPv4, 16 for IPv6.
 *
 * @param {string} canonical
 * @returns {Buffer|null}
 */
function ipBytes(canonical) {
  const v4 = parseIPv4(canonical);
  if (v4 !== null) return Buffer.from(v4);
  const g = parseIPv6(canonical);
  if (g === null) return null;
  const buf = Buffer.alloc(16);
  g.forEach((x, i) => buf.writeUInt16BE(x, i * 2));
  return buf;
}

/**
 * A socket's remoteAddress, normalised for comparison against LOOPBACK_PEERS and the trusted
 * proxy list. Anything that is not an IP literal gives null, which matches nothing.
 *
 * @param {unknown} remoteAddress
 * @returns {string|null}
 */
function normalizePeer(remoteAddress) {
  return canonicalize(remoteAddress);
}

/**
 * The predicate startPanelListener's allowPeer wants: a socket's remoteAddress is admitted only on
 * EXACT membership of the (already canonical) list after normalisation, never a prefix match, so
 * trusting 127.0.0.2 can never admit 127.0.0.20.
 *
 * @param {string[]} list canonical addresses
 * @returns {(remoteAddress: unknown) => boolean}
 */
function makePeerPredicate(list) {
  const allowed = [...list];
  return (remoteAddress) => {
    const peer = normalizePeer(remoteAddress);
    return peer !== null && allowed.includes(peer);
  };
}

/**
 * The client address a trusted proxy appended: the RIGHTMOST X-Forwarded-For entry (the leftmost
 * is whatever the client chose to send). Node joins repeated headers with ", ", which this
 * handles the same way. A rightmost entry that is not an IP literal gives null.
 *
 * @param {unknown} header
 * @returns {string|null}
 */
function rightmostForwardedFor(header) {
  if (typeof header !== 'string') return null;
  const entries = header.split(',').map((e) => e.trim());
  let last = entries[entries.length - 1];
  if (last === undefined || last === '') return null;
  if (last.startsWith('[') && last.endsWith(']')) last = last.slice(1, -1);
  return canonicalize(last);
}

module.exports = { LOOPBACK_PEERS, parseIPv4, parseIPv6, canonicalize, ipBytes, normalizePeer, makePeerPredicate, rightmostForwardedFor };
