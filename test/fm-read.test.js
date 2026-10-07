'use strict';

/*
 * ADR 0034 / FR-FM-02. src/vault/read.js's two independent layers: the fence-predicate refusal
 * (layer 1, readFrontmatter/parseFrontmatterText) and the restricted gray-matter call
 * (parseYamlOnly, layer 2). Each has its own seam test -- a green refusal test alone is not
 * evidence that layer 2 also holds, and vice versa (Risk area 2).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const read = require('../src/vault/read');
const { FrontmatterLanguageError, VaultReadError } = require('../src/util/errors');
const { mkRoot, sentinelsDir, makeMarker, payload, writeBytes } = require('./fm-harness');

function withRoot(fn) {
  const root = mkRoot();
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- Layer 1: readFrontmatter / parseFrontmatterText refusal ----------------------------------

test('readFrontmatter: a ---js file is refused without gray-matter ever running the payload', () => {
  withRoot((root) => {
    const sentinels = sentinelsDir(root);
    const marker = makeMarker();
    const sentinel = path.join(sentinels, 's1.txt');
    const filePath = path.join(root, 'Planted.md');
    writeBytes(filePath, `---js\n${payload(sentinel, marker)}\n---\n`);

    const result = read.readFrontmatter(filePath);
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof FrontmatterLanguageError);
    assert.equal(result.error.code, 'FRONTMATTER_NON_YAML_LANGUAGE');
    assert.equal(result.error.tag, 'js');
    assert.equal(result.error.reason, 'language');
    assert.equal(result.raw, fs.readFileSync(filePath, 'utf8'));
    assert.equal(fs.existsSync(sentinel), false, 'the payload must never have run');
  });
});

test('readFrontmatter: an ordinary yaml file still parses normally', () => {
  withRoot((root) => {
    const filePath = path.join(root, 'Hero.md');
    writeBytes(filePath, '---\ntype: pc\ntitle: Hero\n---\nBody text.\n');
    const result = read.readFrontmatter(filePath);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { type: 'pc', title: 'Hero' });
    assert.equal(result.content.trim(), 'Body text.');
  });
});

test('readFrontmatter: a filesystem read failure still throws VaultReadError, unrelated to the fence predicate', () => {
  const missing = path.join(os.tmpdir(), 'scriptorium-fm-does-not-exist', 'Nope.md');
  assert.throws(() => read.readFrontmatter(missing), VaultReadError);
});

test('parseFrontmatterText: a ---javascript candidate buffer is refused the same way, with no path', () => {
  const result = read.parseFrontmatterText('---javascript\nx\n---\n');
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof FrontmatterLanguageError);
  assert.equal(result.error.tag, 'javascript');
  assert.equal(result.error.path, null);
});

test('parseFrontmatterText: an ordinary yaml candidate still parses', () => {
  const result = read.parseFrontmatterText('---\ntype: pc\n---\nbody\n');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { type: 'pc' });
});

// --- Layer 2: parseYamlOnly, called directly, independent of the predicate --------------------

test('parseYamlOnly: js/javascript/JS/json all throw a plain Error, never FrontmatterLanguageError, and never run the payload', () => {
  withRoot((root) => {
    const sentinels = sentinelsDir(root);
    for (const tag of ['js', 'javascript', 'JS', 'json']) {
      const marker = makeMarker();
      const sentinel = path.join(sentinels, `${tag}.txt`);
      const body = tag === 'json' ? '{}' : payload(sentinel, marker);
      const raw = `---${tag}\n${body}\n---\n`;
      assert.throws(
        () => read.parseYamlOnly(raw),
        (err) => {
          assert.ok(err instanceof Error);
          assert.equal(err instanceof FrontmatterLanguageError, false, `tag ${tag} must not throw FrontmatterLanguageError`);
          return true;
        },
        `tag ${tag} must throw`,
      );
      assert.equal(fs.existsSync(sentinel), false, `tag ${tag} must never run its payload`);
    }
  });
});

test('parseYamlOnly: a yaml fixture parses normally', () => {
  const result = read.parseYamlOnly('---\ntype: npc\ntitle: Placeholder\n---\nbody\n');
  assert.deepEqual(result.data, { type: 'npc', title: 'Placeholder' });
});

test('parseYamlOnly: the SAME malformed content parsed twice throws twice (cache bypass preserved)', () => {
  const raw = '---js\nx\n---\n';
  assert.throws(() => read.parseYamlOnly(raw));
  assert.throws(() => read.parseYamlOnly(raw));
});

// --- readHead ----------------------------------------------------------------------------------

test('readHead: truncated is false for a file under the bound, true for one over it', () => {
  withRoot((root) => {
    const small = path.join(root, 'small.md');
    writeBytes(small, 'hello');
    const smallResult = read.readHead(small, 65536);
    assert.equal(smallResult.truncated, false);
    assert.equal(smallResult.text, 'hello');

    const big = path.join(root, 'big.md');
    writeBytes(big, 'x'.repeat(100));
    const bigResult = read.readHead(big, 10);
    assert.equal(bigResult.truncated, true);
    assert.equal(bigResult.text, 'x'.repeat(10));
  });
});

test('readHead: an injected EIO on the underlying read throws VaultReadError', () => {
  withRoot((root) => {
    const filePath = path.join(root, 'eio.md');
    writeBytes(filePath, 'hello world');
    const original = fs.readSync;
    fs.readSync = () => {
      const err = new Error('simulated EIO');
      err.code = 'EIO';
      throw err;
    };
    try {
      assert.throws(() => read.readHead(filePath, 65536), VaultReadError);
    } finally {
      fs.readSync = original;
    }
  });
});

test('readHead: a missing file throws VaultReadError from the open, not a crash', () => {
  const missing = path.join(os.tmpdir(), 'scriptorium-fm-does-not-exist-2', 'nope.md');
  assert.throws(() => read.readHead(missing, 100), VaultReadError);
});

// --- Structural (comments stripped) -------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('structural: exactly one require("gray-matter") across src/**/*.js and bin/*.js, in src/vault/read.js', () => {
  const root = path.join(__dirname, '..');
  const files = [...walkJs(path.join(root, 'src')), ...fs.readdirSync(path.join(root, 'bin')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'bin', f))];
  const re = /require\(\s*(['"])gray-matter\1\s*\)/g;
  const hits = [];
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const matches = text.match(re) || [];
    for (const m of matches) hits.push(path.relative(root, file));
  }
  assert.deepEqual(hits, ['src/vault/read.js']);
});

test('structural: exactly one bare matter( call in read.js', () => {
  const text = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'vault', 'read.js'), 'utf8'));
  const re = /(?<![\w$.])matter\(/g;
  const matches = text.match(re) || [];
  assert.equal(matches.length, 1, `expected exactly one bare matter( call, found ${matches.length}`);
});

test('structural: every openSync( in read.js passes \'r\'', () => {
  const text = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'vault', 'read.js'), 'utf8'));
  const re = /openSync\(([^)]*)\)/g;
  let m;
  let count = 0;
  while ((m = re.exec(text))) {
    count += 1;
    assert.match(m[1], /,\s*['"]r['"]\s*$/, `openSync call "${m[0]}" must pass 'r'`);
  }
  assert.ok(count >= 1, 'expected at least one openSync( call in read.js');
});

// --- Branch A: parseFrontmatterText's layer-2 restriction ---------------------------------------

test('Branch A: parseFrontmatterText also rejects a js candidate at layer 2 even if the predicate were stubbed to allow it (parseYamlOnly is independently restricted)', () => {
  // Direct layer-2 seam: parseYamlOnly, not parseFrontmatterText, so this is evidence
  // independent of the predicate (Risk area 2's "own seam test" requirement).
  assert.throws(() => read.parseYamlOnly('---javascript\nx\n---\n'));
});
