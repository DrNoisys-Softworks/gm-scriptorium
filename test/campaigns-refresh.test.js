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
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, before) { const index = this.children.indexOf(before); child.parentNode = this; this.children.splice(index, 0, child); return child; }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    if (this.ownerDocument.blurFocusedSubtree && child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    child.parentNode = null;
    return child;
  }
  contains(node) { return node === this || this.children.some((child) => child.contains ? child.contains(node) : child === node); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  focus() { this.ownerDocument.activeElement = this; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.body; }
}

test('a campaign refresh retains the focused row element', async () => {
  const document = { activeElement: null, blurFocusedSubtree: true };
  const body = new Element('body', document);
  document.body = body;
  const brand = new Element('span', document);
  brand.setAttribute('data-role', 'brand-title');
  body.appendChild(brand);
  const docListeners = {};
  Object.assign(document, {
    body,
    activeElement: body,
    createElement: (tag) => new Element(tag, document),
    createTextNode: (text) => ({ textContent: text, parentNode: null }),
    querySelectorAll: (selector) => selector === '[data-role="brand-title"]' ? [brand] : [],
    querySelector: () => null,
    addEventListener: (name, fn) => { docListeners[name] = fn; },
  });
  brand.closest = () => null;
  const pending = [];
  const store = {
    get: () => ({ session: { campaign: 'alpha' }, pending: {}, route: {} }),
    subscribe: () => {},
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
  trigger.listeners.click();
  assert.equal(pending.length, 2);
  pending[0]({ ok: true, body: { campaigns: [
    { name: 'alpha', active: true }, { name: 'beta' },
  ] } });
  await new Promise((resolve) => setImmediate(resolve));
  const cachedPop = switcher.children.find((child) => child.className === 'cs-pop');
  const cachedList = cachedPop.children.find((child) => child.tagName === 'UL');
  const beta = cachedList.children[1].children[0];
  beta.focus();
  document.blurFocusedSubtree = false;
  pending[1]({ ok: true, body: { campaigns: [
    { name: 'alpha', active: true }, { name: 'beta' },
  ] } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.activeElement, beta, 'refresh should preserve focus on the beta row');
  assert.equal(beta.isConnected, true, 'refresh should retain the focused row element');
});
