'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.parentNode = null;
    this.hidden = false;
    this.className = '';
    this.textContent = '';
    this.classList = { add: (name) => { this.className += ` ${name}`; } };
  }
  // A move takes the node out of its old place first, and a browser drops focus from a moved subtree that holds it.
  detach(child) {
    if (!child.parentNode) return;
    if (this.ownerDocument.blurFocusedSubtree && child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
  }
  appendChild(child) { this.detach(child); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, before) {
    this.detach(child);
    const index = before ? this.children.indexOf(before) : this.children.length;
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    if (this.ownerDocument.blurFocusedSubtree && child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    child.parentNode = null;
    return child;
  }
  contains(node) { return node === this || this.children.some((child) => child.contains ? child.contains(node) : child === node); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  focus() { this.ownerDocument.activeElement = this; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.body; }
}

/**
 * The switcher on a fake DOM, with the panel's data requests held until the test answers them. Focus loss is
 * simulated on every removeChild of a subtree holding focus, which is what a real browser does, and it stays on
 * for the whole test: a refresh must not need it switched off.
 */
function setup() {
  const document = { activeElement: null, blurFocusedSubtree: true };
  const body = new Element('body', document);
  document.body = body;
  const brand = new Element('span', document);
  brand.setAttribute('data-role', 'brand-title');
  body.appendChild(brand);
  Object.assign(document, {
    body,
    activeElement: body,
    createElement: (tag) => new Element(tag, document),
    createTextNode: (text) => ({ textContent: text, parentNode: null }),
    querySelectorAll: (selector) => selector === '[data-role="brand-title"]' ? [brand] : [],
    querySelector: () => null,
    addEventListener: () => {},
  });
  brand.closest = () => null;
  const pending = [];
  let storeListener = () => {};
  const store = {
    get: () => ({ session: { campaign: 'alpha' }, pending: {}, route: {} }),
    subscribe: (fn) => { storeListener = fn; },
  };
  const A = {
    el: (tag) => document.createElement(tag),
    setText: (node, value) => { node.textContent = value; },
    icon: () => new Element('svg'),
    store,
    ST: { pendingTotal: () => 0 },
    api: () => new Promise((resolve) => pending.push(resolve)),
    mount: () => null,
    NV: { hrefFor: () => '#/campaigns' },
    stale: () => null,
  };
  const window = { ScriptoriumAdmin: A };
  vm.runInNewContext(fs.readFileSync('assets/admin/campaigns.js', 'utf8'), { window, document, history: {}, location: {} });
  A.campaigns.mount();
  const switcher = brand.parentNode.parentNode;
  const trigger = switcher.children[0];
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const pop = () => switcher.children.find((child) => child.className === 'cs-pop');
  const list = () => pop().children.find((child) => child.tagName === 'UL');
  const rows = () => list().children.map((li) => li.children[0]);
  const names = () => rows().map((row) => row.getAttribute('data-campaign'));
  const answer = async (index, names) => {
    pending[index]({ ok: true, body: { campaigns: names.map((name) => ({ name, active: name === 'alpha' })) } });
    await flush();
  };
  return { A, document, brand, trigger, pending, pop, list, rows, names, answer, flush, storeListener: () => storeListener, click: () => trigger.listeners.click.forEach((fn) => fn()) };
}

test('a campaign refresh retains the focused row element', async () => {
  const h = setup();
  h.click();
  assert.equal(h.pending.length, 2);
  await h.answer(0, ['alpha', 'beta']);
  await h.answer(1, ['alpha', 'beta']);
  const beta = h.rows()[1];
  beta.focus();
  h.A.campaigns.reload();
  await h.answer(2, ['alpha', 'beta']);

  assert.equal(h.document.activeElement, beta, 'refresh should preserve focus on the beta row');
  assert.equal(beta.isConnected, true, 'refresh should retain the focused row element');
});

test('a refresh keeps the heading first and the list second, with the list node itself kept', async () => {
  const h = setup();
  h.click();
  await h.answer(0, ['alpha', 'beta']);
  await h.answer(1, ['alpha', 'beta']);
  const list = h.list();
  h.A.campaigns.reload();
  await h.answer(2, ['alpha', 'beta', 'gamma']);

  assert.equal(h.pop().children[0].textContent, 'Campaigns', 'the heading stays the first child of the panel');
  assert.equal(h.pop().children[1], list, 'the list keeps its node and its place after the heading');
  assert.equal(h.list(), list, 'the list is not rebuilt');
  assert.deepEqual(h.names(), ['alpha', 'beta', 'gamma']);
});

test('one click after two refreshes starts one switch, not two', async () => {
  const h = setup();
  h.click();
  await h.answer(0, ['alpha', 'beta']);
  await h.answer(1, ['alpha', 'beta']);
  h.A.campaigns.reload();
  await h.answer(2, ['alpha', 'beta']);
  h.A.campaigns.reload();
  await h.answer(3, ['alpha', 'beta']);
  const beta = h.rows()[1];
  // The busy guard hides a second handler from a behaviour check, so count the handlers themselves.
  assert.equal(beta.listeners.click.length, 1, 'the row has one click handler after two refreshes');
  const before = h.pending.length;
  beta.listeners.click.forEach((fn) => fn());

  assert.equal(h.pending.length - before, 1, 'one click sends one switch request');
});

test('a refresh that adds a campaign keeps the focused row and shows the new one at the end', async () => {
  const h = setup();
  h.click();
  await h.answer(0, ['alpha', 'beta', 'gamma']);
  await h.answer(1, ['alpha', 'beta', 'gamma']);
  const beta = h.rows()[1];
  beta.focus();
  h.A.campaigns.reload();
  await h.answer(2, ['alpha', 'beta', 'gamma', 'delta']);

  assert.equal(h.document.activeElement, beta, 'the focused row keeps focus when a campaign is added');
  assert.deepEqual(h.names(), ['alpha', 'beta', 'gamma', 'delta']);
});

test('a refresh that removes a campaign keeps the focused row and drops the removed one', async () => {
  const h = setup();
  h.click();
  await h.answer(0, ['alpha', 'beta', 'gamma']);
  await h.answer(1, ['alpha', 'beta', 'gamma']);
  const beta = h.rows()[1];
  beta.focus();
  h.A.campaigns.reload();
  await h.answer(2, ['alpha', 'beta']);

  assert.equal(h.document.activeElement, beta, 'the focused row keeps focus when a campaign is removed');
  assert.equal(beta.isConnected, true);
  assert.deepEqual(h.names(), ['alpha', 'beta']);
});

test('a refresh that reorders campaigns shows them in the new order and keeps each row element', async () => {
  const h = setup();
  h.click();
  await h.answer(0, ['alpha', 'beta', 'gamma']);
  await h.answer(1, ['alpha', 'beta', 'gamma']);
  const [alpha, beta, gamma] = h.rows();
  h.A.campaigns.reload();
  await h.answer(2, ['gamma', 'beta', 'alpha']);

  assert.deepEqual(h.names(), ['gamma', 'beta', 'alpha']);
  assert.equal(h.rows()[0], gamma, 'gamma keeps its row element');
  assert.equal(h.rows()[1], beta, 'beta keeps its row element');
  assert.equal(h.rows()[2], alpha, 'alpha keeps its row element');
});
