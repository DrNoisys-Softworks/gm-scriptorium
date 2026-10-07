'use strict';

/*
 * #99: a named `@container <name>` rule only ever matches if some element declares
 * `container-name: <name>` (or the `container` shorthand). V1e-9 shipped two blocks, `main` and
 * `app`, that nothing declared, so they never applied and nothing failed. This is the cheap,
 * browser-free guard; test/admin-bugs-b1.dom.test.js checks the behaviour the rules were for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs
  .readFileSync(path.join(__dirname, '..', 'assets', 'admin', 'admin.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('every named @container query in admin.css has a container that declares that name', () => {
  const queried = new Set();
  for (const m of css.matchAll(/@container\s+([a-zA-Z_][\w-]*)\s*\(/g)) queried.add(m[1]);
  const declared = new Set();
  for (const m of css.matchAll(/container-name\s*:\s*([^;}]+)/g)) m[1].trim().split(/\s+/).forEach((n) => declared.add(n));
  for (const m of css.matchAll(/(?:^|[;{\s])container\s*:\s*([^;}/]+)/g)) declared.add(m[1].trim().split(/\s+/)[0]);
  const orphans = [...queried].filter((n) => !declared.has(n));
  assert.deepEqual(orphans, [], `@container queries with no declaring container: ${orphans.join(', ')}`);
});

test('the checker itself: an undeclared name is caught, a declared one is not', () => {
  const run = (src) => {
    const q = [...src.matchAll(/@container\s+([a-zA-Z_][\w-]*)\s*\(/g)].map((m) => m[1]);
    const d = [...src.matchAll(/container-name\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    return q.filter((n) => !d.includes(n));
  };
  assert.deepEqual(run('@container main (max-width:1px){a{b:c}}'), ['main']);
  assert.deepEqual(run('.x{container-name:main}@container main (max-width:1px){a{b:c}}'), []);
});
