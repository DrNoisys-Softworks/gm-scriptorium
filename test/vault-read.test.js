'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { walkVault, walkMarkdownFiles, readFrontmatter, readText, readBytes, realPath } = require('../src/vault/read');
const { VaultReadError } = require('../src/util/errors');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');

test('walkVault finds every file in the fixture vault', () => {
  const files = walkVault(MINI_VAULT);
  assert.equal(files.length, 13);
  assert.ok(files.some((f) => f.relPath === 'Characters/NPCs/Alice.md'));
  assert.ok(files.some((f) => f.relPath === '_meta/vault-config.md'));
});

test('walkVault results are sorted by relPath, independent of readdir order', () => {
  const files = walkVault(MINI_VAULT);
  const relPaths = files.map((f) => f.relPath);
  const sorted = [...relPaths].sort();
  assert.deepEqual(relPaths, sorted);
});

test('walkVault is deterministic across repeated calls', () => {
  const a = walkVault(MINI_VAULT);
  const b = walkVault(MINI_VAULT);
  assert.deepEqual(a, b);
});

test('walkVault uses POSIX separators in relPath regardless of platform', () => {
  const files = walkVault(MINI_VAULT);
  for (const f of files) {
    assert.ok(!f.relPath.includes('\\'));
  }
});

test('walkVault skips .git, .obsidian and node_modules by name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-walk-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(dir, '.obsidian'));
    fs.writeFileSync(path.join(dir, '.obsidian', 'workspace.json'), '{}');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), '');
    fs.writeFileSync(path.join(dir, 'real.md'), '---\ntype: npc\n---\nok\n');

    const files = walkVault(dir);
    assert.deepEqual(
      files.map((f) => f.relPath),
      ['real.md'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('walkVault aborts on a filesystem-level read error instead of returning a partial list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-walk-abort-'));
  const blocked = path.join(dir, 'blocked');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), '---\ntype: npc\n---\n');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'b.md'), '---\ntype: npc\n---\n');
    fs.chmodSync(blocked, 0o000);

    assert.throws(() => walkVault(dir), VaultReadError);
  } finally {
    fs.chmodSync(blocked, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFrontmatter parses a well-formed file', () => {
  const result = readFrontmatter(path.join(MINI_VAULT, 'Characters/NPCs/Alice.md'));
  assert.equal(result.ok, true);
  assert.equal(result.data.type, 'npc');
  assert.equal(result.data.title, 'Alice');
});

test('readFrontmatter reports (not throws) a malformed-YAML frontmatter file', () => {
  const result = readFrontmatter(
    path.join(MINI_VAULT, 'Characters/NPCs/broken-frontmatter.md'),
  );
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
  assert.equal(typeof result.raw, 'string');
});

test('readFrontmatter throws VaultReadError on a filesystem-level failure, not ok:false', () => {
  assert.throws(
    () => readFrontmatter(path.join(MINI_VAULT, 'does-not-exist.md')),
    VaultReadError,
  );
});

test('walkMarkdownFiles folds frontmatter into every entry, ok and not-ok alike', () => {
  const files = walkMarkdownFiles(MINI_VAULT);
  assert.equal(files.length, 13);
  const broken = files.find((f) => f.relPath === 'Characters/NPCs/broken-frontmatter.md');
  assert.equal(broken.ok, false);
  const alice = files.find((f) => f.relPath === 'Characters/NPCs/Alice.md');
  assert.equal(alice.ok, true);
  assert.equal(alice.data.type, 'npc');
});

test('reading the same malformed content twice reports the error both times (gray-matter cache-poisoning guard)', () => {
  // gray-matter 4.0.3 caches its parsed result keyed by raw content, and it
  // writes that cache entry BEFORE parsing rather than after: if the first
  // parse throws, a second read of byte-identical content is silently
  // served the unparsed placeholder as a false "success" instead of
  // throwing again. read.js works around this by never using gray-matter's
  // default cache path (see the comment in readFrontmatter). This test
  // reads the same broken file twice in one process to prove the second
  // read still reports the parse failure.
  const brokenPath = path.join(MINI_VAULT, 'Characters/NPCs/broken-frontmatter.md');
  const first = readFrontmatter(brokenPath);
  const second = readFrontmatter(brokenPath);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
});

// ADR 0018 (G3): readText is the chokepoint a campaign pack's JSON is read
// through, so pack reads never fall back to plain fs.

test('V1: readText returns exactly the string written, including a non-ASCII character', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-readtext-'));
  try {
    const filePath = path.join(dir, 'pack.json');
    const content = '{"siteTitle":"café fixture"}';
    fs.writeFileSync(filePath, content, 'utf8');
    assert.equal(readText(filePath), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V2: readText throws VaultReadError with .path set to the path, for a missing path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-readtext-missing-'));
  try {
    const missing = path.join(dir, 'does-not-exist.json');
    assert.throws(
      () => readText(missing),
      (err) => err instanceof VaultReadError && err.path === missing,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ADR 0019 (image slots): readBytes and realPath are the chokepoints SD-5's "the plan holds
// the bytes" reads through.

test('V3: readBytes returns the exact Buffer, including 0x00 and 0xff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-readbytes-'));
  try {
    const filePath = path.join(dir, 'a.bin');
    const content = Buffer.from([0x00, 0x01, 0xff, 0x10]);
    fs.writeFileSync(filePath, content);
    assert.deepEqual(readBytes(filePath), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V4: realPath resolves a symlink; a missing path gives VaultReadError with .path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-realpath-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    const link = path.join(dir, 'link.txt');
    try {
      fs.symlinkSync(target, link);
    } catch (err) {
      if (err.code === 'EPERM') {
        t.skip('symlinks unavailable: EPERM creating a symlink in this environment');
        return;
      }
      throw err;
    }
    assert.equal(realPath(link), fs.realpathSync(target));

    const missing = path.join(dir, 'does-not-exist.txt');
    assert.throws(
      () => realPath(missing),
      (err) => err instanceof VaultReadError && err.path === missing,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('src/vault/read.js never calls a write-capable fs function (structural, not by convention)', () => {
  const fullSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'vault', 'read.js'), 'utf8');
  // Strip comments before scanning: the module's own documentation names
  // several of these functions in prose (explaining what must never
  // appear), which would otherwise trip this check on its own comment.
  const source = fullSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const forbidden = [
    'writeFileSync',
    'writeFile(',
    'appendFileSync',
    'appendFile(',
    'copyFileSync',
    'copyFile(',
    'rmSync',
    'rm(',
    'unlinkSync',
    'unlink(',
    'mkdirSync',
    'mkdir(',
    'renameSync',
    'rename(',
    'chmodSync',
    'chmod(',
    'truncateSync',
    'truncate(',
    'createWriteStream',
  ];
  const hits = forbidden.filter((token) => source.includes(token));
  assert.deepEqual(hits, [], `read.js must stay read-only; found forbidden call(s): ${hits}`);
});
