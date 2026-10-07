'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const crypto = require('crypto');

const { verifyInstalled, parseSha256Sums, derivePinFromTree, verifyTarball, manifestOf } = require('../scripts/generator-pin');

const REPO_ROOT = path.join(__dirname, '..');
const REAL_GENERATOR_DIR = path.join(REPO_ROOT, 'node_modules', 'gm-apprentice-publish');
const REAL_PIN_PATH = path.join(REPO_ROOT, 'vendor', 'gm-apprentice-publish', 'PIN.json');
const REAL_PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const REAL_LOCK_PATH = path.join(REPO_ROOT, 'package-lock.json');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function withTmpCopyOfGenerator(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pin-test-'));
  const copy = path.join(dir, 'gm-apprentice-publish');
  copyDir(REAL_GENERATOR_DIR, copy);
  try {
    return fn(copy, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the installed tree verifies against PIN.json (real repo state)', () => {
  const { ok, problems } = verifyInstalled();
  assert.deepEqual(problems, []);
  assert.equal(ok, true);
});

test('PIN.json.commit is the pinned SHA', () => {
  const pin = JSON.parse(fs.readFileSync(REAL_PIN_PATH, 'utf8'));
  assert.equal(pin.commit, 'ea94de7f47f398eb695600653017323ee20caa65');
});

test('FR-02: the facade\'s PIN_COMMIT is bound to PIN.json.commit, not just hardcoded in step', () => {
  // AC-02 / M15 (Stale constant: PIN_COMMIT reverted): this test must go red if
  // src/generator/pinned.js's PIN_COMMIT is ever left stale after a pin move.
  // Independent read of PIN.json (not the same literal src/generator/pinned.js hardcodes),
  // per CLAUDE.md's "never derive an assertion's expected value from the code under test".
  const pin = JSON.parse(fs.readFileSync(REAL_PIN_PATH, 'utf8'));
  const pinned = require('../src/generator/pinned');
  assert.equal(pinned.PIN_COMMIT, pin.commit);
});

test('a flipped byte in lib/build.js fails verification, naming lib/build.js', () => {
  withTmpCopyOfGenerator((copy) => {
    const target = path.join(copy, 'lib', 'build.js');
    const data = fs.readFileSync(target);
    const mutated = Buffer.from(data);
    mutated[0] = mutated[0] ^ 0xff;
    fs.writeFileSync(target, mutated);

    const { ok, problems } = verifyInstalled({
      generatorDir: copy,
      pinPath: REAL_PIN_PATH,
      packageJsonPath: REAL_PACKAGE_JSON_PATH,
      lockPath: REAL_LOCK_PATH,
    });
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => p.includes('lib/build.js')),
      `expected a problem naming lib/build.js, got: ${problems.join('; ')}`,
    );
  });
});

test('an extra file fails verification, naming it', () => {
  withTmpCopyOfGenerator((copy) => {
    fs.writeFileSync(path.join(copy, 'lib', 'not-in-the-pin.js'), 'module.exports = {};\n');

    const { ok, problems } = verifyInstalled({
      generatorDir: copy,
      pinPath: REAL_PIN_PATH,
      packageJsonPath: REAL_PACKAGE_JSON_PATH,
      lockPath: REAL_LOCK_PATH,
    });
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => p.includes('lib/not-in-the-pin.js')),
      `expected a problem naming the extra file, got: ${problems.join('; ')}`,
    );
  });
});

test('a missing file fails verification, naming it', () => {
  withTmpCopyOfGenerator((copy) => {
    fs.rmSync(path.join(copy, 'lib', 'build.js'));

    const { ok, problems } = verifyInstalled({
      generatorDir: copy,
      pinPath: REAL_PIN_PATH,
      packageJsonPath: REAL_PACKAGE_JSON_PATH,
      lockPath: REAL_LOCK_PATH,
    });
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => p.includes('lib/build.js')),
      `expected a problem naming the missing file, got: ${problems.join('; ')}`,
    );
  });
});

test('a mismatched package.json dependency spec fails verification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pin-test-pkgjson-'));
  try {
    const badPackageJsonPath = path.join(dir, 'package.json');
    fs.writeFileSync(
      badPackageJsonPath,
      JSON.stringify({ dependencies: { 'gm-apprentice-publish': '1.2.1' } }),
    );

    const { ok, problems } = verifyInstalled({
      generatorDir: REAL_GENERATOR_DIR,
      pinPath: REAL_PIN_PATH,
      packageJsonPath: badPackageJsonPath,
      lockPath: REAL_LOCK_PATH,
    });
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('package.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mismatched package-lock.json resolved entry fails verification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pin-test-lock-'));
  try {
    const badLockPath = path.join(dir, 'package-lock.json');
    fs.writeFileSync(
      badLockPath,
      JSON.stringify({
        packages: {
          'node_modules/gm-apprentice-publish': {
            version: '1.11.30',
            resolved: 'file:vendor/gm-apprentice-publish/wrong-file.tgz',
          },
        },
      }),
    );

    const { ok, problems } = verifyInstalled({
      generatorDir: REAL_GENERATOR_DIR,
      pinPath: REAL_PIN_PATH,
      packageJsonPath: REAL_PACKAGE_JSON_PATH,
      lockPath: badLockPath,
    });
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('resolved')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- FR-16 (SD-1): the release-tarball pin source's decoupled mechanism -- parseSha256Sums,
// derivePinFromTree, verifyTarball. Synthetic fixtures only; independent of the live PIN.json
// (still 5779522 -- the FR-16 cutover is blocked, see $QC/repin-gate/GATE.md). ---

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pin-fr16-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function makeTarball(dir, tarballName, content) {
  const p = path.join(dir, tarballName);
  fs.writeFileSync(p, content);
  return p;
}

function makeSums(dir, entries, { binary = false } = {}) {
  const p = path.join(dir, 'SHA256SUMS');
  const sep = binary ? ' *' : '  ';
  const text = entries.map(([hash, name]) => `${hash}${sep}${name}`).join('\n') + '\n';
  fs.writeFileSync(p, text);
  return p;
}

// --- parseSha256Sums ---

test('parseSha256Sums: text-mode line (two spaces)', () => {
  const hash = 'a'.repeat(64);
  const map = parseSha256Sums(`${hash}  gm-apprentice-publish-1.11.40.tgz\n`);
  assert.equal(map.get('gm-apprentice-publish-1.11.40.tgz'), hash);
});

test('parseSha256Sums: binary-mode line (space asterisk)', () => {
  const hash = 'b'.repeat(64);
  const map = parseSha256Sums(`${hash} *gm-apprentice-publish-1.11.40.tgz\n`);
  assert.equal(map.get('gm-apprentice-publish-1.11.40.tgz'), hash);
});

test('parseSha256Sums: mixed case hash is lowercased', () => {
  const hash = 'C'.repeat(32) + 'd'.repeat(32);
  const map = parseSha256Sums(`${hash}  x.tgz\n`);
  assert.equal(map.get('x.tgz'), hash.toLowerCase());
});

test('parseSha256Sums: blank lines and unparseable lines are skipped, not thrown', () => {
  const hash = 'e'.repeat(64);
  const map = parseSha256Sums(`\n\n${hash}  ok.tgz\nnot a sums line\n`);
  assert.deepEqual([...map.keys()], ['ok.tgz']);
});

test('parseSha256Sums: two entries', () => {
  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);
  const map = parseSha256Sums(`${h1}  a.tgz\n${h2}  b.tgz\n`);
  assert.equal(map.size, 2);
  assert.equal(map.get('a.tgz'), h1);
  assert.equal(map.get('b.tgz'), h2);
});

test('parseSha256Sums: (M21 argument-swap discriminator) a hash and a filename-shaped 64-hex string do not cross-contaminate', () => {
  // If the parser's capture groups were swapped (hash <-> name), this filename (which happens to
  // be a valid 64-hex string) would be misread as the hash. Real sha256sum output never puts the
  // hash in the second column, so this is adversarial-but-well-formed input.
  const realHash = 'f'.repeat(64);
  const trickyName = '0'.repeat(64) + '.tgz';
  const map = parseSha256Sums(`${realHash}  ${trickyName}\n`);
  assert.equal(map.get(trickyName), realHash, 'the hash column must stay the hash, regardless of what the name looks like');
  assert.equal(map.size, 1);
});

// --- derivePinFromTree ---

test('derivePinFromTree: happy path returns the FR-16 PIN shape, no omitted key', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    const treeB = path.join(dir, 'cross');
    writeTree(treeA, { 'package/index.js': 'module.exports = 1;\n', 'package/lib/a.js': 'a\n' });
    writeTree(treeB, { 'package/index.js': 'module.exports = 1;\n', 'package/lib/a.js': 'a\n' });

    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballContent = 'fake-tarball-bytes';
    const tarballPath = makeTarball(tarballDir, 'gm-apprentice-publish-1.11.40.tgz', tarballContent);
    const sha = crypto.createHash('sha256').update(tarballContent).digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'gm-apprentice-publish-1.11.40.tgz']]);

    const pin = derivePinFromTree({
      tree: path.join(treeA, 'package'),
      crossCheckTree: path.join(treeB, 'package'),
      tarballPath,
      sumsPath,
      commit: '78696167d39448db38cd11fe6c5fb0f0c4819070',
      tag: 'publish-v1.11.40',
      packageVersion: '1.11.40',
      crossCheckMethod: 'npm-ci-pack',
      npmVersion: '10.9.8',
    });

    assert.equal(pin.commit, '78696167d39448db38cd11fe6c5fb0f0c4819070');
    assert.deepEqual(pin.labels, { tag: 'publish-v1.11.40', packageVersion: '1.11.40' });
    assert.equal(pin.source.kind, 'release-tarball');
    assert.equal(pin.tarball, 'gm-apprentice-publish-1.11.40.tgz');
    assert.equal(pin.tarballSha256, sha);
    assert.equal(pin.sums, 'SHA256SUMS');
    assert.equal(pin.crossCheck.method, 'npm-ci-pack');
    assert.equal(pin.crossCheck.npmVersion, '10.9.8');
    assert.ok(pin.crossCheck.treeSha256);
    assert.deepEqual(Object.keys(pin.files).sort(), ['index.js', 'lib/a.js']);
    assert.ok(pin.treeSha256);
    assert.equal('omitted' in pin, false, 'SD-1 drops the omit-rule model; no omitted key');
  });
});

test('derivePinFromTree: a flipped tarball byte refuses, naming the tarball', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const goodContent = 'fake-tarball-bytes';
    const sha = crypto.createHash('sha256').update(goodContent).digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'x.tgz']]);
    // The tarball on disk does NOT match what SHA256SUMS records (a "flipped byte").
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'DIFFERENT-tarball-bytes');

    assert.throws(
      () =>
        derivePinFromTree({
          tree: path.join(treeA, 'package'),
          crossCheckTree: path.join(treeA, 'package'),
          tarballPath,
          sumsPath,
          commit: '7'.repeat(40),
          tag: 't',
          packageVersion: '1.0.0',
          crossCheckMethod: 'npm-ci-pack',
        }),
      (err) => {
        assert.ok(err.problems.some((p) => p.includes('tarball sha256 mismatch') && p.includes('x.tgz')));
        return true;
      },
    );
  });
});

test('derivePinFromTree: a mismatched SHA256SUMS hash refuses', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sumsPath = makeSums(tarballDir, [['0'.repeat(64), 'x.tgz']]); // wrong hash

    assert.throws(
      () =>
        derivePinFromTree({
          tree: path.join(treeA, 'package'),
          crossCheckTree: path.join(treeA, 'package'),
          tarballPath,
          sumsPath,
          commit: '7'.repeat(40),
          tag: 't',
          packageVersion: '1.0.0',
          crossCheckMethod: 'npm-ci-pack',
        }),
      /tarball sha256 mismatch/,
    );
  });
});

test('derivePinFromTree: a missing SHA256SUMS entry refuses, naming SHA256SUMS', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sumsPath = makeSums(tarballDir, [['1'.repeat(64), 'some-other-file.tgz']]);

    assert.throws(
      () =>
        derivePinFromTree({
          tree: path.join(treeA, 'package'),
          crossCheckTree: path.join(treeA, 'package'),
          tarballPath,
          sumsPath,
          commit: '7'.repeat(40),
          tag: 't',
          packageVersion: '1.0.0',
          crossCheckMethod: 'npm-ci-pack',
        }),
      (err) => {
        assert.ok(err.problems.some((p) => p.includes('SHA256SUMS has no entry for x.tgz')));
        return true;
      },
    );
  });
});

test('derivePinFromTree: tree/cross-check-tree with different paths refuses (this is exactly the real FR-16 STOP shape)', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    const treeB = path.join(dir, 'cross');
    writeTree(treeA, { 'package/index.js': 'x\n', 'package/CHANGELOG.md': 'notes\n' });
    writeTree(treeB, { 'package/index.js': 'x\n' }); // missing CHANGELOG.md, like the real upstream delta
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sha = crypto.createHash('sha256').update('real-bytes').digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'x.tgz']]);

    assert.throws(
      () =>
        derivePinFromTree({
          tree: path.join(treeA, 'package'),
          crossCheckTree: path.join(treeB, 'package'),
          tarballPath,
          sumsPath,
          commit: '7'.repeat(40),
          tag: 't',
          packageVersion: '1.0.0',
          crossCheckMethod: 'npm-ci-pack',
        }),
      (err) => {
        assert.ok(err.problems.some((p) => p.includes('cross-check tree mismatch') && p.includes('CHANGELOG.md')));
        return true;
      },
    );
  });
});

test('derivePinFromTree: tree/cross-check-tree with same paths but different content refuses', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    const treeB = path.join(dir, 'cross');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    writeTree(treeB, { 'package/index.js': 'y\n' }); // same path, different bytes
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sha = crypto.createHash('sha256').update('real-bytes').digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'x.tgz']]);

    assert.throws(
      () =>
        derivePinFromTree({
          tree: path.join(treeA, 'package'),
          crossCheckTree: path.join(treeB, 'package'),
          tarballPath,
          sumsPath,
          commit: '7'.repeat(40),
          tag: 't',
          packageVersion: '1.0.0',
          crossCheckMethod: 'npm-ci-pack',
        }),
      /different content/,
    );
  });
});

test('derivePinFromTree: refusal writes nothing (CLI --out path never created)', () => {
  withTmpDir((dir) => {
    const { execFileSync } = require('child_process');
    const treeA = path.join(dir, 'tree');
    const treeB = path.join(dir, 'cross');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    writeTree(treeB, { 'package/index.js': 'y\n' });
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sha = crypto.createHash('sha256').update('real-bytes').digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'x.tgz']]);
    const outPath = path.join(dir, 'PIN.json');

    const script = path.join(__dirname, '..', 'scripts', 'generator-pin.js');
    const result = require('node:child_process').spawnSync(
      process.execPath,
      [
        script, 'derive',
        '--tree', path.join(treeA, 'package'),
        '--cross-check-tree', path.join(treeB, 'package'),
        '--tarball', tarballPath,
        '--sums', sumsPath,
        '--commit', '7'.repeat(40),
        '--tag', 't',
        '--package-version', '1.0.0',
        '--out', outPath,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(outPath), false, 'a refused derive must never write the --out path');
  });
});

// --- verifyTarball ---

test('verifyTarball: happy path', () => {
  withTmpDir((dir) => {
    const tarballPath = makeTarball(dir, 'x.tgz', 'bytes');
    const sha = sha256File(tarballPath);
    const sumsPath = makeSums(dir, [[sha, 'x.tgz']]);
    const { ok, problems } = verifyTarball({ pin: { tarballSha256: sha, sums: 'SHA256SUMS' }, tarballPath, sumsPath });
    assert.equal(ok, true);
    assert.deepEqual(problems, []);
  });
});

test('verifyTarball: flipped tarball byte fails, naming the tarball', () => {
  withTmpDir((dir) => {
    const tarballPath = makeTarball(dir, 'x.tgz', 'bytes');
    const originalSha = sha256File(tarballPath);
    const sumsPath = makeSums(dir, [[originalSha, 'x.tgz']]);
    // Flip the tarball after computing the pin's recorded hash from the original bytes.
    fs.writeFileSync(tarballPath, 'BYTES');
    const { ok, problems } = verifyTarball({ pin: { tarballSha256: originalSha, sums: 'SHA256SUMS' }, tarballPath, sumsPath });
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('x.tgz') && p.includes('tarballSha256')));
  });
});

test('verifyTarball: SHA256SUMS entry missing fails, naming SHA256SUMS', () => {
  withTmpDir((dir) => {
    const tarballPath = makeTarball(dir, 'x.tgz', 'bytes');
    const sha = sha256File(tarballPath);
    const sumsPath = makeSums(dir, [[sha, 'different-name.tgz']]);
    const { ok, problems } = verifyTarball({ pin: { tarballSha256: sha, sums: 'SHA256SUMS' }, tarballPath, sumsPath });
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('SHA256SUMS has no entry for x.tgz')));
  });
});

test('verifyTarball: SHA256SUMS entry differs from PIN.json fails', () => {
  withTmpDir((dir) => {
    const tarballPath = makeTarball(dir, 'x.tgz', 'bytes');
    const sha = sha256File(tarballPath);
    const sumsPath = makeSums(dir, [['f'.repeat(64), 'x.tgz']]);
    const { ok, problems } = verifyTarball({ pin: { tarballSha256: sha, sums: 'SHA256SUMS' }, tarballPath, sumsPath });
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('differs from PIN.json.tarballSha256')));
  });
});

test('verifyTarball: missing tarballSha256 fails closed', () => {
  withTmpDir((dir) => {
    const tarballPath = makeTarball(dir, 'x.tgz', 'bytes');
    const sumsPath = makeSums(dir, [[sha256File(tarballPath), 'x.tgz']]);
    const { ok, problems } = verifyTarball({ pin: { sums: 'SHA256SUMS' }, tarballPath, sumsPath });
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('no tarballSha256')));
  });
});

test('verifyTarball: missing sums field fails closed', () => {
  withTmpDir((dir) => {
    const tarballPath = makeTarball(dir, 'x.tgz', 'bytes');
    const sha = sha256File(tarballPath);
    const { ok, problems } = verifyTarball({ pin: { tarballSha256: sha }, tarballPath, sumsPath: path.join(dir, 'SHA256SUMS') });
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('no sums field')));
  });
});

// --- generalises to a bundled (nested node_modules) path, via manifestOf + the existing
// verifyInstalled diff logic, without any code change: the manifest walk is path-generic. ---

test('manifestOf generalises to a bundled node_modules/lunr/lunr.js-shaped path (a flipped byte is caught by path)', () => {
  withTmpDir((dir) => {
    const generatorDir = path.join(dir, 'gm-apprentice-publish');
    writeTree(generatorDir, {
      'lib/index.js': 'ok\n',
      'node_modules/lunr/lunr.js': 'var lunr = {};\n',
      'node_modules/lunr/package.json': '{"version":"2.3.9"}\n',
    });
    const before = manifestOf(generatorDir);
    assert.ok('node_modules/lunr/lunr.js' in before.files);

    fs.writeFileSync(path.join(generatorDir, 'node_modules', 'lunr', 'lunr.js'), 'var lunr = MUTATED;\n');
    const after = manifestOf(generatorDir);
    assert.notEqual(after.files['node_modules/lunr/lunr.js'], before.files['node_modules/lunr/lunr.js']);

    // Same check verifyInstalled runs internally: compare against a synthetic PIN built from the
    // pre-mutation manifest.
    const { verifyInstalled } = require('../scripts/generator-pin');
    const pinPath = path.join(dir, 'PIN.json');
    fs.writeFileSync(pinPath, JSON.stringify({ commit: '7'.repeat(40), files: before.files, treeSha256: before.treeSha256 }));
    const pkgJsonPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ dependencies: {} }));
    const lockPath = path.join(dir, 'package-lock.json');
    fs.writeFileSync(lockPath, JSON.stringify({ packages: {} }));

    const { ok, problems } = verifyInstalled({ generatorDir, pinPath, packageJsonPath: pkgJsonPath, lockPath });
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => p.includes('node_modules/lunr/lunr.js')),
      `expected a problem naming the bundled lunr path, got: ${problems.join('; ')}`,
    );
  });
});

// --- SD-1 ruling (docs/agent-runs/repin-v1.11.40-sd1-ruling-2026-09-30.md): verifyInstalled gains a
// fail-closed crossCheck check, and derivePinFromTree/the CLI require --cross-check-method. Synthetic
// fixtures only. ---

function writeSyntheticInstall(dir, { pinExtra = {} } = {}) {
  const generatorDir = path.join(dir, 'gm-apprentice-publish');
  writeTree(generatorDir, { 'lib/index.js': 'ok\n' });
  const { files, treeSha256 } = manifestOf(generatorDir);

  const vendorDir = path.join(dir, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  const tarballPath = makeTarball(vendorDir, 'x.tgz', 'synthetic-tarball-bytes');
  const tarballSha256 = sha256File(tarballPath);
  makeSums(vendorDir, [[tarballSha256, 'x.tgz']]);

  const pin = {
    commit: '7'.repeat(40),
    files,
    treeSha256,
    tarball: 'x.tgz',
    tarballSha256,
    sums: 'SHA256SUMS',
    labels: { packageVersion: '1.0.0' },
    ...pinExtra,
  };
  const pinPath = path.join(dir, 'PIN.json');
  fs.writeFileSync(pinPath, JSON.stringify(pin));
  const packageJsonPath = path.join(dir, 'package.json');
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({ dependencies: { 'gm-apprentice-publish': 'file:vendor/gm-apprentice-publish/x.tgz' } }),
  );
  const lockPath = path.join(dir, 'package-lock.json');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      packages: {
        'node_modules/gm-apprentice-publish': {
          version: '1.0.0',
          resolved: 'file:vendor/gm-apprentice-publish/x.tgz',
        },
      },
    }),
  );
  return { generatorDir, pinPath, packageJsonPath, lockPath, vendorDir, treeSha256 };
}

test('verifyInstalled: a missing crossCheck fails closed, naming crossCheck', () => {
  withTmpDir((dir) => {
    const { generatorDir, pinPath, packageJsonPath, lockPath, vendorDir } = writeSyntheticInstall(dir);
    // pinExtra has no crossCheck key at all.
    const { ok, problems } = verifyInstalled({ generatorDir, pinPath, packageJsonPath, lockPath, vendorDir });
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => p.toLowerCase().includes('crosscheck')),
      `expected a problem naming crossCheck, got: ${problems.join('; ')}`,
    );
  });
});

test('verifyInstalled: crossCheck.method !== "npm-ci-pack" fails closed', () => {
  withTmpDir((dir) => {
    const { generatorDir, treeSha256, vendorDir } = writeSyntheticInstall(dir);
    // Rewrite with a crossCheck present but the wrong method.
    const pinPath = path.join(dir, 'PIN.json');
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    pin.crossCheck = { method: 'npm-pack-tree-equality', npmVersion: '10.9.8', treeSha256 };
    fs.writeFileSync(pinPath, JSON.stringify(pin));
    const { ok, problems } = verifyInstalled({
      generatorDir,
      pinPath,
      packageJsonPath: path.join(dir, 'package.json'),
      lockPath: path.join(dir, 'package-lock.json'),
      vendorDir,
    });
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => p.toLowerCase().includes('crosscheck') && p.includes('method')),
      `expected a problem naming crossCheck's method, got: ${problems.join('; ')}`,
    );
  });
});

test('verifyInstalled: crossCheck.treeSha256 !== treeSha256 fails closed', () => {
  withTmpDir((dir) => {
    const { generatorDir, treeSha256, vendorDir } = writeSyntheticInstall(dir);
    const pinPath = path.join(dir, 'PIN.json');
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    pin.crossCheck = { method: 'npm-ci-pack', npmVersion: '10.9.8', treeSha256: 'f'.repeat(64) };
    assert.notEqual(pin.crossCheck.treeSha256, treeSha256);
    fs.writeFileSync(pinPath, JSON.stringify(pin));
    const { ok, problems } = verifyInstalled({
      generatorDir,
      pinPath,
      packageJsonPath: path.join(dir, 'package.json'),
      lockPath: path.join(dir, 'package-lock.json'),
      vendorDir,
    });
    assert.equal(ok, false);
    assert.ok(
      problems.some((p) => p.toLowerCase().includes('crosscheck') && p.toLowerCase().includes('treesha256')),
      `expected a problem naming crossCheck's treeSha256, got: ${problems.join('; ')}`,
    );
  });
});

test('verifyInstalled: a valid, matching crossCheck is not itself a problem', () => {
  withTmpDir((dir) => {
    const { generatorDir, treeSha256, vendorDir } = writeSyntheticInstall(dir);
    const pinPath = path.join(dir, 'PIN.json');
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    pin.crossCheck = { method: 'npm-ci-pack', npmVersion: '10.9.8', treeSha256 };
    fs.writeFileSync(pinPath, JSON.stringify(pin));
    const { ok, problems } = verifyInstalled({
      generatorDir,
      pinPath,
      packageJsonPath: path.join(dir, 'package.json'),
      lockPath: path.join(dir, 'package-lock.json'),
      vendorDir,
    });
    assert.equal(ok, true, `expected no problems, got: ${problems.join('; ')}`);
  });
});

test('verifyInstalled: a flipped byte in the vendored tarball is reported as a problem (M20-class wiring)', () => {
  // Guards the wiring at scripts/generator-pin.js's verifyInstalled: it calls verifyTarball()
  // and pushes its problems onto its own `problems` array. A `problems.push(...tarballProblems)`
  // that got discarded (or the whole `if (pin.tarball) { ... }` block removed) would leave a
  // byte-flipped vendored tarball undetected by verifyInstalled() itself, even though
  // verifyTarball() in isolation (tested above) still catches it. This exercises the real
  // wiring path, not verifyTarball() directly.
  withTmpDir((dir) => {
    const { generatorDir, pinPath, packageJsonPath, lockPath, vendorDir, treeSha256 } = writeSyntheticInstall(dir);
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    pin.crossCheck = { method: 'npm-ci-pack', npmVersion: '10.9.8', treeSha256 };
    fs.writeFileSync(pinPath, JSON.stringify(pin));

    // Flip one byte in the vendored tarball, in place -- SHA256SUMS and PIN.json's own
    // tarballSha256 still record the ORIGINAL (unflipped) hash, so this is a real mismatch.
    const tarballPath = path.join(vendorDir, 'x.tgz');
    const bytes = fs.readFileSync(tarballPath);
    const flipped = Buffer.from(bytes);
    flipped[0] ^= 0xff;
    fs.writeFileSync(tarballPath, flipped);

    const { ok, problems } = verifyInstalled({ generatorDir, pinPath, packageJsonPath, lockPath, vendorDir });
    assert.equal(ok, false, `expected the flipped tarball to be a problem, got: ${problems.join('; ')}`);
    assert.ok(
      problems.some((p) => p.toLowerCase().includes('tarball')),
      `expected a problem naming the tarball, got: ${problems.join('; ')}`,
    );
  });
});

test('derivePinFromTree: refuses without a crossCheckMethod', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sha = crypto.createHash('sha256').update('real-bytes').digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'x.tgz']]);

    assert.throws(
      () =>
        derivePinFromTree({
          tree: path.join(treeA, 'package'),
          crossCheckTree: path.join(treeA, 'package'),
          tarballPath,
          sumsPath,
          commit: '7'.repeat(40),
          tag: 't',
          packageVersion: '1.0.0',
          // crossCheckMethod deliberately omitted
        }),
      (err) => {
        assert.ok(err.problems.some((p) => p.toLowerCase().includes('cross-check-method') || p.toLowerCase().includes('crosscheckmethod')));
        return true;
      },
    );
  });
});

test('derivePinFromTree: happy path with crossCheckMethod records crossCheck.method and npmVersion', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    const treeB = path.join(dir, 'cross');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    writeTree(treeB, { 'package/index.js': 'x\n' });
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sha = crypto.createHash('sha256').update('real-bytes').digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'x.tgz']]);

    const pin = derivePinFromTree({
      tree: path.join(treeA, 'package'),
      crossCheckTree: path.join(treeB, 'package'),
      tarballPath,
      sumsPath,
      commit: '7'.repeat(40),
      tag: 't',
      packageVersion: '1.0.0',
      crossCheckMethod: 'npm-ci-pack',
      npmVersion: '10.9.8',
    });
    assert.equal(pin.crossCheck.method, 'npm-ci-pack');
    assert.equal(pin.crossCheck.npmVersion, '10.9.8');
    assert.ok(pin.crossCheck.treeSha256);
  });
});

test('CLI: derive --tree refuses without --cross-check-method', () => {
  withTmpDir((dir) => {
    const treeA = path.join(dir, 'tree');
    writeTree(treeA, { 'package/index.js': 'x\n' });
    const tarballDir = path.join(dir, 'vendor');
    fs.mkdirSync(tarballDir, { recursive: true });
    const tarballPath = makeTarball(tarballDir, 'x.tgz', 'real-bytes');
    const sha = crypto.createHash('sha256').update('real-bytes').digest('hex');
    const sumsPath = makeSums(tarballDir, [[sha, 'x.tgz']]);
    const outPath = path.join(dir, 'PIN.json');

    const script = path.join(__dirname, '..', 'scripts', 'generator-pin.js');
    const result = require('node:child_process').spawnSync(
      process.execPath,
      [
        script, 'derive',
        '--tree', path.join(treeA, 'package'),
        '--cross-check-tree', path.join(treeA, 'package'),
        '--tarball', tarballPath,
        '--sums', sumsPath,
        '--commit', '7'.repeat(40),
        '--tag', 't',
        '--package-version', '1.0.0',
        '--out', outPath,
        // --cross-check-method deliberately omitted
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(outPath), false);
  });
});
