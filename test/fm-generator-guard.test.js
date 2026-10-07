'use strict';

/*
 * ADR 0034 / FR-FM-03. The primary control: the generator's bundled gray-matter is frozen to a
 * yaml-only engine registry, in every process that loads either src/generator/pinned.js or
 * src/generator/bootstrap.js alone (child processes, per Risk area 5 -- this guard is process-
 * lifetime and cannot be undone in-process), self-checked through the generator's own
 * parseManifest, and bound by hash to PIN.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const pinned = require('../src/generator/pinned');
const fmguard = require('../src/generator/fmguard');
const bootstrap = require('../src/generator/bootstrap');
const { ScriptoriumError } = require('../src/util/errors');
const { mkRoot, sentinelsDir, makeMarker, payload, writeBytes, writeCampaignConfig } = require('./fm-harness');

const ROOT = path.join(__dirname, '..');

function runNode(script) {
  return spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
}

// --- Registry frozen after loading the facade --------------------------------------------------

test('after loading the facade: pinned.generatorGrayMatter.engines is exactly ["yaml"], frozen', () => {
  assert.deepEqual(Reflect.ownKeys(pinned.generatorGrayMatter.engines), ['yaml']);
  assert.equal(Object.isFrozen(pinned.generatorGrayMatter.engines), true);
});

test('child process: requiring ONLY src/generator/pinned.js yields the same frozen registry', () => {
  const script = `
    const pinned = require('./src/generator/pinned');
    const keys = Reflect.ownKeys(pinned.generatorGrayMatter.engines);
    if (keys.length !== 1 || keys[0] !== 'yaml') throw new Error('unexpected keys: ' + JSON.stringify(keys));
    if (!Object.isFrozen(pinned.generatorGrayMatter.engines)) throw new Error('not frozen');
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test('child process: requiring ONLY src/generator/bootstrap.js yields the same frozen registry', () => {
  // Inspects the bundled gray-matter's engine table DIRECTLY (not through src/generator/pinned.js
  // -- requiring pinned.js here, even just to read pinned.generatorGrayMatter, would itself run
  // pinned.js's own install/verify and mask a bug where bootstrap.js's OWN top-level install is
  // the thing missing).
  const script = `
    require('./src/generator/bootstrap');
    // eslint-disable-next-line global-require
    const gm = require('gm-apprentice-publish/node_modules/gray-matter');
    const keys = Reflect.ownKeys(gm.engines);
    if (keys.length !== 1 || keys[0] !== 'yaml') throw new Error('unexpected keys: ' + JSON.stringify(keys));
    if (!Object.isFrozen(gm.engines)) throw new Error('not frozen');
    console.log('OK');
  `;
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

// --- Branch B identity test is not ours to write (Branch A landed; V1e-1's identity test in
// test/vault-config-parsers.test.js already covers this and must not be edited -- see the fm-read
// structural test for "one literal" coverage below).

// --- pinned.parseManifest self-check --------------------------------------------------------

test('pinned.parseManifest(jsPayload) throws "not registered" and never runs the payload', () => {
  const root = mkRoot();
  try {
    const sentinels = sentinelsDir(root);
    const marker = makeMarker();
    const sentinel = path.join(sentinels, 'manifest-js.txt');
    const raw = `---js\n${payload(sentinel, marker)}\n---\n`;
    assert.throws(() => pinned.parseManifest(raw), /engine "js" is not registered/);
    assert.equal(fs.existsSync(sentinel), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Direct runGeneratorBuild, no guard bypass possible --------------------------------------

test('direct runGeneratorBuild on a planted vault (X.MD aliases + NPCs/Planted.md): the sentinel is absent', () => {
  const root = mkRoot();
  try {
    const vaultPath = path.join(root, 'vault');
    const sentinels = sentinelsDir(root);
    const marker1 = makeMarker();
    const marker2 = makeMarker();
    const sentinel1 = path.join(sentinels, 'planted.txt');
    const sentinel2 = path.join(sentinels, 'xmd.txt');

    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n');
    writeBytes(path.join(vaultPath, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public\n---\nbody\n');
    writeBytes(path.join(vaultPath, 'NPCs', 'Planted.md'), `---js\n${payload(sentinel1, marker1)}\n---\n`);
    writeBytes(path.join(vaultPath, 'X.MD'), `---js\n${payload(sentinel2, marker2)}\naliases: 0;\n---\n`);

    const outputDir = path.join(root, 'out');
    const configPath = path.join(root, `config-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        siteTitle: 'Guard Direct',
        siteUrl: 'https://example.invalid',
        vaultPath,
        outputDir,
        attachmentsDir: '_attachments',
        folderMap: { NPCs: 'npcs' },
        excludeDirs: [],
      }),
    );

    const result = bootstrap.runGeneratorBuild(configPath);
    assert.equal(fs.existsSync(sentinel1), false, 'NPCs/Planted.md payload must never have run');
    assert.equal(fs.existsSync(sentinel2), false, 'X.MD payload must never have run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Pin binding --------------------------------------------------------------------------------

test('pin binding: BOUND_PIN_FILES has exactly the four expected paths, each hash equal to PIN.json and to disk', () => {
  const PIN = require('../vendor/gm-apprentice-publish/PIN.json');
  const expectedPaths = [
    'node_modules/gray-matter/index.js',
    'node_modules/gray-matter/lib/defaults.js',
    'node_modules/gray-matter/lib/engine.js',
    'node_modules/gray-matter/lib/engines.js',
  ];
  assert.deepEqual(fmguard.BOUND_PIN_FILES.map((f) => f.pinPath), expectedPaths);
  for (const { pinPath, expectedSha256 } of fmguard.BOUND_PIN_FILES) {
    assert.equal(PIN.files[pinPath], expectedSha256, `${pinPath}: PIN.json mismatch`);
    const onDisk = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'node_modules', 'gm-apprentice-publish', pinPath))).digest('hex');
    assert.equal(onDisk, expectedSha256, `${pinPath}: on-disk mismatch`);
  }
});

// --- verifyFrontmatterEngineGuard with fakes ----------------------------------------------------

test('verifyFrontmatterEngineGuard: (a) a fake where js does not throw -- throws', () => {
  const fake = (raw) => {
    const m = raw.match(/"([^"]+)"/);
    return { meta: { scriptorium_probe: m ? m[1] : null } };
  };
  assert.throws(() => fmguard.verifyFrontmatterEngineGuard(fake, { cache: {} }), ScriptoriumError);
});

test('verifyFrontmatterEngineGuard: (b) a fake where the yaml positive control throws -- throws', () => {
  const fake = () => {
    throw new Error('positive control always fails');
  };
  assert.throws(() => fmguard.verifyFrontmatterEngineGuard(fake, { cache: {} }));
});

test('verifyFrontmatterEngineGuard: (c) a fake where js throws a non-matching error -- throws', () => {
  const fake = (raw) => {
    const m = raw.match(/"([^"]+)"/);
    if (/---(js|javascript|json)/.test(raw)) throw new Error('unrelated failure message');
    return { meta: { scriptorium_probe: m ? m[1] : null } };
  };
  assert.throws(() => fmguard.verifyFrontmatterEngineGuard(fake, { cache: {} }), ScriptoriumError);
});

test('verifyFrontmatterEngineGuard: a real, correctly-guarded pair passes', () => {
  assert.doesNotThrow(() => fmguard.verifyFrontmatterEngineGuard(pinned.parseManifest, pinned.generatorGrayMatter));
});

test('installFrontmatterEngineGuard: a different handle than the one already installed by facade load throws ScriptoriumError', () => {
  // This test process already installed the guard against the REAL pinned.generatorGrayMatter
  // when it required src/generator/pinned.js above (module load order, matching real process
  // behaviour: the facade installs once, process-lifetime -- Risk area 5). Any other object is
  // therefore a "second, different handle" from this call's point of view.
  const fakeHandle = { engines: { yaml: {}, javascript: {}, json: {} } };
  assert.throws(() => fmguard.installFrontmatterEngineGuard(fakeHandle), ScriptoriumError);
});

// --- M11-shaped decoy: a preload re-adds an engine after this module's own install; the child
// process's own self-check must still catch it and exit 1 ---------------------------------------

test('decoy: a preload re-adding matter.engines after install still fails closed at exit 1', () => {
  const root = mkRoot();
  try {
    const { configPath } = writeCampaignConfig(root, { vaultPath: path.join(root, 'vault') });
    fs.mkdirSync(path.join(root, 'vault', '_meta'), { recursive: true });
    writeBytes(path.join(root, 'vault', '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');

    const preloadPath = path.join(root, 'preload.js');
    fs.writeFileSync(
      preloadPath,
      `
      const path = require('path');
      const gm = require(path.join(${JSON.stringify(ROOT)}, 'node_modules', 'gm-apprentice-publish', 'node_modules', 'gray-matter'));
      try {
        gm.engines = Object.assign({}, gm.engines, { javascript: { parse: (s) => eval(s) } });
      } catch (e) {
        // the freeze may already reject the reassignment outright -- either way the guard below
        // must still see the tampering attempt and fail closed.
      }
      `,
    );

    const BIN = path.join(ROOT, 'bin', 'scriptorium.js');
    const env = { ...process.env };
    delete env.SCRIPTORIUM_PROFILE;
    env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-config.toml');
    env.APPDATA = path.join(root, 'unused-appdata');
    env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');

    const result = spawnSync(process.execPath, ['-r', preloadPath, BIN, 'check', 'fm', '--config', configPath], {
      encoding: 'utf8',
      timeout: 20000,
      env,
    });
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /frontmatter engine guard self-check failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Wiring: a stubbed verify failure surfaces as result.error from runGeneratorBuild -----------

test('wiring: stubbing fmguard.verifyFrontmatterEngineGuard to throw makes runGeneratorBuild return that error', () => {
  const root = mkRoot();
  try {
    const vaultPath = path.join(root, 'vault');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n');
    writeBytes(path.join(vaultPath, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public\n---\nbody\n');
    const outputDir = path.join(root, 'out');
    const configPath = path.join(root, `config-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        siteTitle: 'Wiring',
        siteUrl: 'https://example.invalid',
        vaultPath,
        outputDir,
        attachmentsDir: '_attachments',
        folderMap: { NPCs: 'npcs' },
        excludeDirs: [],
      }),
    );

    const original = fmguard.verifyFrontmatterEngineGuard;
    const injected = new Error('injected verify failure');
    fmguard.verifyFrontmatterEngineGuard = () => {
      throw injected;
    };
    try {
      const result = bootstrap.runGeneratorBuild(configPath);
      assert.equal(result.error, injected);
    } finally {
      fmguard.verifyFrontmatterEngineGuard = original;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Single literal -------------------------------------------------------------------------

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

test('structural: exactly one require("gm-apprentice-publish/node_modules/gray-matter") across src and bin, in pinned.js', () => {
  const files = [...walkJs(path.join(ROOT, 'src')), ...fs.readdirSync(path.join(ROOT, 'bin')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'bin', f))];
  const re = /require\(\s*(['"])gm-apprentice-publish\/node_modules\/gray-matter\1\s*\)/g;
  const hits = [];
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const matches = text.match(re) || [];
    for (const m of matches) hits.push(path.relative(ROOT, file));
  }
  assert.deepEqual(hits, ['src/generator/pinned.js']);
});
