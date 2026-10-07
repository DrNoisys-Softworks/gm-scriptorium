'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createTicketStore } = require('../src/remote/tickets');

/* V1.5a (SD-a9). The one-time preview hand-off tickets, on an injected clock. */

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('mint returns 43 base64url characters (256 random bits) and consume returns the parent once', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now });
  const ticket = store.mint('parent-1');
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.consume(ticket), 'parent-1');
});

test('Ma18: a ticket is single use: the second consume is null', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now });
  const ticket = store.mint('p');
  assert.equal(store.consume(ticket), 'p');
  assert.equal(store.consume(ticket), null);
});

test('Ma19: usable at +59999 ms, dead at +60000 ms (strict)', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now });
  const early = store.mint('p');
  const late = store.mint('p');
  c.t += 59999;
  assert.equal(store.consume(early), 'p');
  c.t += 1;
  assert.equal(store.consume(late), null);
});

test('an expired ticket is also gone: a later consume cannot revive it', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now });
  const ticket = store.mint('p');
  c.t += 60001;
  assert.equal(store.consume(ticket), null);
  c.t -= 60001;
  assert.equal(store.consume(ticket), null);
});

test('an unknown, empty, non-string or oversized ticket is null and never throws', () => {
  const store = createTicketStore();
  for (const bad of ['nope', '', undefined, null, 42, {}, 'x'.repeat(5000)]) assert.equal(store.consume(bad), null);
});

test('a ticket is bound to the session that minted it', () => {
  const store = createTicketStore();
  const a = store.mint('session-a');
  const b = store.mint('session-b');
  assert.equal(store.consume(b), 'session-b');
  assert.equal(store.consume(a), 'session-a');
});

test('only the SHA-256 is held: the store never keeps the ticket text (a probe of the Map keys)', () => {
  const store = createTicketStore({ randomBytes: () => Buffer.alloc(32, 9) });
  const ticket = store.mint('p');
  // The ticket for 32 bytes of 0x09 is fixed; its digest is what a second store would look up.
  const digest = crypto.createHash('sha256').update(ticket).digest('hex');
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(store.size(), 1);
  assert.equal(store.consume(ticket), 'p');
  assert.equal(store.size(), 0);
});

test('past max (32), the OLDEST ticket is evicted first', () => {
  const store = createTicketStore();
  const tickets = [];
  for (let i = 0; i < 33; i++) tickets.push(store.mint(`p${i}`));
  assert.equal(store.size(), 32);
  assert.equal(store.consume(tickets[0]), null, 'the oldest was evicted');
  assert.equal(store.consume(tickets[1]), 'p1');
  assert.equal(store.consume(tickets[32]), 'p32');
});

test('max and ttl are options', () => {
  const c = clock();
  const store = createTicketStore({ now: c.now, ttlMs: 1000, max: 2 });
  const a = store.mint('a');
  store.mint('b');
  store.mint('c');
  assert.equal(store.consume(a), null);
  const d = store.mint('d');
  c.t += 1000;
  assert.equal(store.consume(d), null);
});
