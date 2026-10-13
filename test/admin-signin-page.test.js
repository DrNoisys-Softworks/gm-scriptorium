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
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script\b[^>]*>/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('signin.html (ADR 0054): labelled username and password fields with the autocomplete tokens password managers look for, the submit button, the alert line and the fixed lockout text', () => {
  assert.match(html, /<body data-page="signin">/);
  assert.match(html, /<h1 class="gs-h">Sign in to the GM console<\/h1>/);
  assert.match(html, /<form data-role="signin-form"[^>]*action="\/auth\/password" method="post"/);
  assert.match(html, /<label for="signin-username">Username<\/label>/);
  assert.match(html, /<input type="text" id="signin-username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>/);
  assert.match(html, /<label for="signin-password">Password<\/label>/);
  assert.match(html, /<input type="password" id="signin-password" name="password" autocomplete="current-password" required>/);
  assert.match(html, /<button type="submit">Sign in<\/button>/);
  assert.match(html, /role="alert"/);
  assert.ok(
    html.includes(
      'Five wrong tries for one username in ten minutes pause that username for fifteen minutes. A much higher number of wrong tries across every username pauses sign-in for everyone. On the machine running GM-Scriptorium, the one-time link still works.',
    ),
  );
  assert.ok(html.includes('Admin console. No campaign content is shown before you sign in.'));
  const scripts = html.match(/<script\b[^>]*>/gi);
  assert.ok(scripts && scripts.length > 0, 'the page has at least one script tag');
  assert.ok(scripts.every((s) => /\bdefer\b/.test(s)), 'every script is deferred');
});

test('signin.html: Lantern branding only. No campaign name, title, theme file, image or vault reference of any kind', () => {
  assert.ok(html.includes('GM-Scriptorium'));
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /url\(/i);
  assert.doesNotMatch(html, /\bsrc="(?!\/assets\/(app|signin)\.js")/i, 'the only src= are the two scripts');
  assert.doesNotMatch(html, /theme|siteTitle|long-lease/i);
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
  assert.ok(src.includes('JSON.stringify({ username: name, password: password })'));
  assert.ok(src.includes('location.replace'));
  for (const bad of ['innerHTML', 'fetch(', 'localStorage', 'sessionStorage', 'document.cookie', 'console.']) assert.ok(!src.includes(bad), bad);
});

test('signin.js: neither field is cleared before navigating on success (password managers), and only the password is cleared on failure', () => {
  const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, 'signin.js'), 'utf8');
  const success = src.slice(src.indexOf('if (res.ok) {'), src.indexOf('location.replace(target())'));
  assert.ok(success.length > 0 && !/\.value\s*=/.test(success), 'nothing is assigned to a field on the success path');
  const failure = src.slice(src.indexOf('submit.disabled = false;'));
  assert.ok(/input\.value = '';/.test(failure));
  assert.ok(!/username\.value\s*=/.test(src), 'the username field is never written by the script');
});

test('signin.js: the campaign hint is re-checked against the campaign-name shape, and is the only thing forwarded', () => {
  const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, 'signin.js'), 'utf8');
  assert.ok(src.includes('[a-z0-9][a-z0-9-]{0,62}'), 'the same shape as NAME_RE in src/setup/validate.js');
  assert.ok(src.includes('/^\\?campaign=('), 'the whole query must be exactly one campaign=<name>');
  assert.ok(src.includes("'/?campaign=' + match[1]"));
  assert.ok(!src.includes('URLSearchParams'), 'no lenient parsing: other parameters are not skipped over');
  assert.equal([...src.matchAll(/location\.replace\(/g)].length, 1, 'one navigation, to the checked target');
});

test('the sign-in page is NOT listed in the embedded asset routes under its html name (served only as a refusal page)', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(ADMIN_ASSET_ROUTES, 'signin.html'));
});
