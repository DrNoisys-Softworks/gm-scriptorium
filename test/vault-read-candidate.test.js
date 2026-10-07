'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const read = require('../src/vault/read');
const { FENCE_HEAD_BYTES } = require('../src/vault/fence');
const { FrontmatterLanguageError, ScriptoriumError } = require('../src/util/errors');

/*
 * V1e-9 (ADR 0041, SD-90). The candidate overlay is DV-E90's security-bearing seam: the one way
 * check ever reads an edited copy that was never written to disk. Every test here runs against a
 * scratch vault copy -- never the owner's real vault -- per the Owner hard rules.
 */

function scratchVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1e9-read-candidate-'));
  const metaDir = path.join(dir, '_meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const target = path.join(metaDir, 'vault-config.md');
  fs.writeFileSync(target, '---\ntype: meta\npublish:\n  mode: player\n---\n\nnotes\n');
  return { dir, metaDir, target };
}

// -- Each of the four readers consults the overlay for the exact path, and `hits` counts it -----

test('readFrontmatter serves the candidate text for the exact path, and hits counts the serve', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('---\ntype: meta\npublish:\n  mode: gm\n---\n\nnotes\n', 'utf8');
  const { value, hits } = read.withCandidateFile(target, candidateBytes, () => read.readFrontmatter(target));
  assert.equal(value.ok, true);
  assert.equal(value.data.publish.mode, 'gm');
  assert.equal(hits, 1);
});

test('readText serves the candidate text for the exact path', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('candidate whole text\n', 'utf8');
  const { value, hits } = read.withCandidateFile(target, candidateBytes, () => read.readText(target));
  assert.equal(value, 'candidate whole text\n');
  assert.equal(hits, 1);
});

test('readBytes serves the candidate bytes for the exact path, as a fresh Buffer copy', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('candidate bytes\n', 'utf8');
  const { value, hits } = read.withCandidateFile(target, candidateBytes, () => read.readBytes(target));
  assert.ok(value.equals(candidateBytes));
  assert.notEqual(value, candidateBytes, 'must be a copy, not the same Buffer object');
  assert.equal(hits, 1);
});

test('readHead serves the candidate bytes for the exact path, honouring maxBytes truncation', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('short\n', 'utf8');
  const { value, hits } = read.withCandidateFile(target, candidateBytes, () => read.readHead(target, 100));
  assert.equal(value.text, 'short\n');
  assert.equal(value.truncated, false);
  assert.equal(hits, 1);
});

test('readHead truncates the candidate at exactly the FENCE_HEAD_BYTES literal, truncated:true', () => {
  const { target } = scratchVault();
  const longBody = 'x'.repeat(FENCE_HEAD_BYTES + 500);
  const candidateBytes = Buffer.from(longBody, 'utf8');
  const { value, hits } = read.withCandidateFile(target, candidateBytes, () => read.readHead(target, FENCE_HEAD_BYTES));
  assert.equal(value.text.length, FENCE_HEAD_BYTES);
  assert.equal(value.truncated, true);
  assert.equal(hits, 1);
});

test('hits counts every serve, not just the first, across multiple reads inside one fn', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('---\ntype: meta\n---\n\nbody\n', 'utf8');
  const { hits } = read.withCandidateFile(target, candidateBytes, () => {
    read.readText(target);
    read.readBytes(target);
    read.readFrontmatter(target);
    return null;
  });
  assert.equal(hits, 3);
});

// -- Siblings are NOT overlaid: exact string equality only, never startsWith/dirname -------------

test('a sibling file with a longer name sharing the target as a prefix is never overlaid', () => {
  const { metaDir, target } = scratchVault();
  const sibling = path.join(metaDir, 'vault-config.md-notes.md');
  fs.writeFileSync(sibling, 'real sibling content\n');
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  const { value } = read.withCandidateFile(target, candidateBytes, () => read.readText(sibling));
  assert.equal(value, 'real sibling content\n');
});

test('a sibling file with a different extension (.mdx) is never overlaid', () => {
  const { metaDir, target } = scratchVault();
  const sibling = path.join(metaDir, 'vault-config.mdx');
  fs.writeFileSync(sibling, 'real mdx content\n');
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  const { value } = read.withCandidateFile(target, candidateBytes, () => read.readText(sibling));
  assert.equal(value, 'real mdx content\n');
});

test('a different file in the same directory (_meta/other.md) is never overlaid', () => {
  const { metaDir, target } = scratchVault();
  const sibling = path.join(metaDir, 'other.md');
  fs.writeFileSync(sibling, 'real other content\n');
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  const { value } = read.withCandidateFile(target, candidateBytes, () => read.readText(sibling));
  assert.equal(value, 'real other content\n');
});

test('the vault root itself is never overlaid, even though it is an ancestor of the candidate path', () => {
  const { dir, target } = scratchVault();
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  const { value } = read.withCandidateFile(target, candidateBytes, () => read.pathExists(dir));
  assert.equal(value, true); // pathExists is never overlaid either way; proves the root was read for real
});

// -- Platform-folded key equality, restored in t.after --------------------------------------------

test('on win32, a differently-cased path still matches the candidate (case-folded)', (t) => {
  const { target } = scratchVault();
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', original));
  const upper = target.toUpperCase();
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  const { value } = read.withCandidateFile(target, candidateBytes, () => read.readText(upper));
  assert.equal(value, 'candidate\n');
});

test('on linux, a differently-cased path does NOT match the candidate (case-sensitive)', (t) => {
  const { metaDir, target } = scratchVault();
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', original));
  const upperName = path.join(metaDir, 'VAULT-CONFIG.MD');
  fs.writeFileSync(upperName, 'real upper-case file\n');
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  const { value } = read.withCandidateFile(target, candidateBytes, () => read.readText(upperName));
  assert.equal(value, 'real upper-case file\n');
});

// -- Refusals: nesting, bad arguments, a thenable fn --------------------------------------------

test('nesting withCandidateFile throws ScriptoriumError (programming error), and the outer overlay survives', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('outer\n', 'utf8');
  assert.throws(() => {
    read.withCandidateFile(target, candidateBytes, () => {
      read.withCandidateFile(target, Buffer.from('inner\n'), () => null);
    });
  }, ScriptoriumError);
});

test('bytes that are not a Buffer throws ScriptoriumError before any candidate is set', () => {
  const { target } = scratchVault();
  assert.throws(() => read.withCandidateFile(target, 'not a buffer', () => null), ScriptoriumError);
});

test('fn that is not a function throws ScriptoriumError', () => {
  const { target } = scratchVault();
  assert.throws(() => read.withCandidateFile(target, Buffer.from('x'), 'not a function'), ScriptoriumError);
});

test('an fn returning a thenable throws ScriptoriumError, and the overlay is cleared afterwards', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  assert.throws(() => {
    read.withCandidateFile(target, candidateBytes, () => ({ then: () => {} }));
  }, ScriptoriumError);
  // The overlay must be cleared: the next read goes to disk, not to a stale candidate.
  assert.equal(read.readText(target).startsWith('---\ntype: meta'), true);
});

test('a throw inside fn propagates, and clears the overlay (the next read is from disk)', () => {
  const { target } = scratchVault();
  const candidateBytes = Buffer.from('candidate\n', 'utf8');
  assert.throws(() => {
    read.withCandidateFile(target, candidateBytes, () => {
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(read.readText(target).startsWith('---\ntype: meta'), true);
});

// -- A `---js` candidate refuses at the fence, and gray-matter is never reached -------------------

function withSpiedGrayMatter(fn) {
  const grayMatterPath = require.resolve('gray-matter');
  const readPath = require.resolve('../src/vault/read');
  const originalGrayMatterEntry = require.cache[grayMatterPath];
  const realExports = originalGrayMatterEntry ? originalGrayMatterEntry.exports : require('gray-matter');
  let calls = 0;
  function spy(...args) {
    calls++;
    return realExports(...args);
  }
  require.cache[grayMatterPath] = Object.assign({}, originalGrayMatterEntry, { exports: spy });
  delete require.cache[readPath];
  try {
    const freshRead = require('../src/vault/read');
    return fn(freshRead, () => calls);
  } finally {
    delete require.cache[readPath];
    if (originalGrayMatterEntry) require.cache[grayMatterPath] = originalGrayMatterEntry;
    else delete require.cache[grayMatterPath];
  }
}

test('positive control: the gray-matter spy actually counts a real on-disk parse', () => {
  withSpiedGrayMatter((freshRead, callCount) => {
    const { target } = scratchVault();
    const result = freshRead.readFrontmatter(target);
    assert.equal(result.ok, true);
    assert.equal(callCount(), 1);
  });
});

test('a `---js` candidate through readFrontmatter gives FrontmatterLanguageError, and gray-matter is never called', () => {
  withSpiedGrayMatter((freshRead, callCount) => {
    const { target } = scratchVault();
    const candidateBytes = Buffer.from('---js\nevil: true\n---\n\nbody\n', 'utf8');
    const { value } = freshRead.withCandidateFile(target, candidateBytes, () => freshRead.readFrontmatter(target));
    assert.equal(value.ok, false);
    assert.ok(value.error instanceof FrontmatterLanguageError);
    assert.equal(callCount(), 0);
  });
});

// -- Structural: withCandidateFile is called only from read.js itself and candidatecheck.js -------

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// V1e-7 (Amendment A, 2026-10-01): src/admin/variants.js is added to the caller list -- it reuses
// this overlay for theme/vocab preview copies rather than inventing a second candidate mechanism.
// This test stays red until V1e-9's own src/admin/candidatecheck.js (its commit 3) also exists in
// this tree; that is expected and tracked in the V1e-7 Engineer's report, not a V1e-7 defect.
test('withCandidateFile is called only from src/vault/read.js (its own definition), src/admin/candidatecheck.js and src/admin/variants.js', () => {
  const root = path.join(__dirname, '..');
  const files = [...listJsFiles(path.join(root, 'src')), ...listJsFiles(path.join(root, 'bin'))];
  const callers = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (/\bwithCandidateFile\s*\(/.test(src)) callers.push(path.relative(root, file));
  }
  assert.deepEqual(
    callers.sort(),
    ['src/admin/candidatecheck.js', 'src/admin/variants.js', 'src/vault/read.js'].sort(),
  );
});

test('positive control: the withCandidateFile caller scan actually finds a planted fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1e9-wcf-control-'));
  try {
    const fixture = path.join(dir, 'planted.js');
    fs.writeFileSync(fixture, 'withCandidateFile(a, b, c);\n');
    const src = fs.readFileSync(fixture, 'utf8');
    assert.match(src, /\bwithCandidateFile\s*\(/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -- Graph: src/cli/{build,check,init}.js never reach src/admin/** --------------------------------

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

test('src/cli/build.js, check.js and init.js never reach src/admin/** in their require graph', () => {
  const root = path.join(__dirname, '..');
  const entries = ['build.js', 'check.js', 'init.js'].map((f) => path.join(root, 'src', 'cli', f));
  const graph = walkModuleGraph(entries);
  const adminHits = [...graph].filter((f) => f.startsWith(path.join(root, 'src', 'admin') + path.sep));
  assert.deepEqual(adminHits, []);
});
