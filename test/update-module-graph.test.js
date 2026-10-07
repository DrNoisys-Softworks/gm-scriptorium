'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * Structural proof (not a code-review claim) that src/update/ cannot touch
 * campaign content: it never touches a vault or a build (Engineering
 * Brief section 6, criteria 25 and 30). Walks the actual require() graph
 * of every file under src/update/ (plus src/cli/update.js, its entrypoint)
 * and asserts none of it resolves into src/vault or src/build.
 */

const ROOT = path.join(__dirname, '..');
const ENTRYPOINTS = [
  path.join(ROOT, 'src', 'update'),
  path.join(ROOT, 'src', 'cli', 'update.js'),
];

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function extractRequires(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const requires = [];
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source))) requires.push(m[1]);
  return requires;
}

function resolveRelative(fromFile, spec) {
  let resolved = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, 'index.js');
  }
  if (!resolved.endsWith('.js') && fs.existsSync(resolved + '.js')) resolved += '.js';
  return resolved;
}

function walkModuleGraph(startFiles) {
  const visited = new Set();
  const queue = [...startFiles];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!fs.existsSync(file)) continue;
    for (const spec of extractRequires(file)) {
      queue.push(resolveRelative(file, spec));
    }
  }
  return visited;
}

test('src/update/ module graph never reaches src/vault or src/build', () => {
  const startFiles = [];
  for (const entry of ENTRYPOINTS) {
    if (fs.statSync(entry).isDirectory()) startFiles.push(...listJsFiles(entry));
    else startFiles.push(entry);
  }

  const graph = walkModuleGraph(startFiles);
  const forbidden = [...graph].filter(
    (f) => f.includes(`${path.sep}src${path.sep}vault${path.sep}`) || f.includes(`${path.sep}src${path.sep}build${path.sep}`),
  );

  assert.deepEqual(
    forbidden,
    [],
    `src/update/'s module graph must never reach src/vault or src/build; found: ${forbidden.join(', ')}`,
  );
});

test('src/update/ files import no fs-writing network client other than child_process (gh subprocess only)', () => {
  const files = listJsFiles(path.join(ROOT, 'src', 'update'));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(
      !/require\(['"]https?['"]\)/.test(source) && !/require\(['"]node-fetch['"]\)/.test(source) && !/\bfetch\(/.test(source),
      `${file} must not make a direct network call; update goes through the gh subprocess only`,
    );
  }
});
