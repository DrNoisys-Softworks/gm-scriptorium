'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ADMIN_ASSET_ROUTES, ADMIN_ASSETS_DIR } = require('../src/admin/assets');

/*
 * V1.5a (SD-a11). The sign-in page: the same three HTML scans as test/admin-assets.test.js applied
 * to signin.html, the fixed text, the form's shape, and the boot-skip marker in app.js.
 */

const html = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, 'signin.html'), 'utf8');

test('signin.html: every src/href starts with /assets/ and names a route in ADMIN_ASSET_ROUTES', () => {
  const refs = [];
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) refs.push(m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(ref.startsWith('/assets/'), ref);
    assert.ok(Object.prototype.hasOwnProperty.call(ADMIN_ASSET_ROUTES, ref.slice('/assets/'.length)), `${ref} is not a route`);
  }
  assert.ok(refs.includes('/assets/app.js'));
  assert.ok(refs.includes('/assets/signin.js'));
});

test('signin.html: no inline script, <style>, style= or on*=', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('signin.html: the body marker, the labelled password field, the submit button, the alert line and the fixed lockout text', () => {
  assert.match(html, /<body data-page="signin">/);
  assert.match(html, /<h1>Scriptorium admin panel<\/h1>/);
  assert.match(html, /<form data-role="signin-form"/);
  assert.match(html, /<label for="signin-password">/);
  assert.match(html, /<input type="password" id="signin-password"[^>]*autocomplete="current-password"[^>]*required>/);
  assert.match(html, /<button type="submit">/);
  assert.ok(html.includes('The password is set on the machine running GM-Scriptorium, with <code>gm-scriptorium remote password</code>.'));
  assert.match(html, /role="alert"/);
  assert.ok(html.includes('Five wrong passwords in ten minutes pause remote sign-in for fifteen minutes. On the machine running GM-Scriptorium, the one-time link still works.'));
  const scripts = html.match(/<script[^>]*>/g);
  assert.ok(scripts.every((s) => /\bdefer\b/.test(s)), 'every script is deferred');
});

test('app.js: the boot skip for the sign-in page is present, before any request', () => {
  const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, 'app.js'), 'utf8');
  const marker = "document.body.getAttribute('data-page') === 'signin'";
  assert.ok(src.includes(marker));
  const bootAt = src.indexOf('function boot()');
  assert.ok(src.indexOf(marker) > bootAt);
  assert.ok(src.indexOf(marker) < src.indexOf("api('/api/session')", bootAt), 'the skip returns before /api/session is requested');
});

test('signin.js: preventDefault on submit (form-action none), JSON POST through ScriptoriumAdmin.api, textContent only, no storage', () => {
  const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, 'signin.js'), 'utf8');
  assert.ok(src.includes('event.preventDefault()'));
  assert.ok(src.includes("A.api('/auth/password'"));
  assert.ok(src.includes('location.replace'));
  for (const bad of ['innerHTML', 'fetch(', 'localStorage', 'sessionStorage', 'document.cookie', 'console.']) assert.ok(!src.includes(bad), bad);
});

test('the sign-in page is NOT listed in the embedded asset routes under its html name (served only as a refusal page)', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(ADMIN_ASSET_ROUTES, 'signin.html'));
});
