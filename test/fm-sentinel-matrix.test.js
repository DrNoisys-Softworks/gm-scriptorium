'use strict';

/*
 * ADR 0034. The executable-frontmatter sentinel matrix: the live-vector canary (SD-10), the
 * AC-FM-02 variant x location x command coverage, AC-FM-11 output hygiene, AC-FM-04 positive
 * controls (both copies) plus build equivalence, and FR-FM-07's other entry points.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const pinned = require('../src/generator/pinned');
const { readFrontmatter } = require('../src/vault/read');
const { defaultTitleFor } = require('../src/cli/init');
const { paletteScheme } = require('../src/checks/themescheme');
const { parseRecognisedTypes } = require('../src/vault/entitytypes');
const { runServeCommand } = require('../src/cli/serve');
const { startLocalListener } = require('../src/serve/server');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { mkRoot, sentinelsDir, makeMarker, payload, payloadWithAliases, gmAliasesPayload, fenceFile, writeBytes, writeCampaignConfig, siteConfigJson, run, BIN } = require('./fm-harness');

const ROOT = path.join(__dirname, '..');

function withRoot(fn) {
  const root = mkRoot();
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function grepMarker(text, marker) {
  return (text.match(new RegExp(marker, 'g')) || []).length;
}

// --- SD-10: the live-vector canary ---------------------------------------------------------------

test('canary: the shared payload, through the UNRESTRICTED top-level gray-matter in a child process, DOES create the sentinel', () => {
  const root = mkRoot();
  try {
    const sentinel = path.join(root, 'canary-sentinel.txt');
    const marker = makeMarker();
    const script = `
      const matter = require('gray-matter');
      const text = '---js\\n' + ${JSON.stringify(payload(sentinel, marker))} + '\\n---\\n';
      matter(text);
      console.log('ran');
    `;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(sentinel), true, 'the canary must prove the payload is live: if it does not create the sentinel, every "absent" assertion elsewhere is vacuous');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- AC-FM-02: variant coverage (fixed content-page location) -------------------------------------

const VARIANTS = [
  ['js', { tag: 'js' }],
  ['javascript', { tag: 'javascript' }],
  ['JS-uppercase', { tag: 'JS' }],
  ['space-js', { tag: ' js' }],
  ['tab-js', { tag: '\tjs' }],
  ['ideographic-space-js', { tag: '　js' }],
  ['CRLF', { tag: 'js', crlf: true }],
  ['BOM', { tag: 'js', bom: true }],
  ['BOM+CRLF', { tag: 'js', bom: true, crlf: true }],
  ['no-closing-fence', { tag: 'js', noClose: true }],
  ['bare-CR-in-tag', { tag: 'js', bareCr: true }],
  ['BOM-mid-tag', { tag: '﻿js' }],
];

test('AC-FM-02 variant coverage: every named variant, planted as a content page, gives sentinel-absent under check', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const sentinels = sentinelsDir(root);
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    for (const [label, opts] of VARIANTS) {
      const marker = makeMarker();
      const sentinel = path.join(sentinels, `variant-${label}.txt`);
      const buf = fenceFile({ ...opts, body: payload(sentinel, marker) + '\n' });
      writeBytes(path.join(vaultPath, 'NPCs', `Variant-${label}.md`), buf);
    }
    const { configPath } = writeCampaignConfig(root, { vaultPath });
    const res = run(root, ['check', 'fm', '--config', configPath]);
    assert.equal(res.status, 2, res.stdout + res.stderr);
    for (const [label] of VARIANTS) {
      const sentinel = path.join(sentinels, `variant-${label}.txt`);
      assert.equal(fs.existsSync(sentinel), false, `variant ${label} must not have run its payload`);
    }
  });
});

test('AC-FM-02 over-limit-js variant (the 13th): sentinel absent under check', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const sentinel = path.join(root, 'sentinel-overlimit.txt');
    const marker = makeMarker();
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    writeBytes(path.join(vaultPath, 'NPCs', 'Overlimit.md'), '---' + ' '.repeat(70000) + 'js\n' + payload(sentinel, marker));
    const { configPath } = writeCampaignConfig(root, { vaultPath });
    const res = run(root, ['check', 'fm', '--config', configPath]);
    assert.equal(res.status, 2);
    assert.equal(fs.existsSync(sentinel), false);
  });
});

// --- AC-FM-02: location coverage (fixed js/aliases as each location needs) -----------------------

test('AC-FM-02 location coverage: every FR-FM-04 location gives sentinel-absent under the appropriate command', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const sentinels = sentinelsDir(root);
    const plant = (rel, aliasesKind) => {
      const marker = makeMarker();
      const sentinel = path.join(sentinels, `loc-${rel.replace(/[\\/]/g, '_')}.txt`);
      const body = aliasesKind === 'aliases' ? payloadWithAliases(sentinel, marker) : aliasesKind === 'gm_aliases' ? gmAliasesPayload(sentinel, marker) : payload(sentinel, marker);
      writeBytes(path.join(vaultPath, rel), `---js\n${body}\n---\n`);
      return sentinel;
    };

    const checkOnly = [plant('NPCs/Planted.md'), plant('_meta/vault-config.md'), plant('_meta/publish-manifest.md'), plant('_meta/entity-types.md'), plant('node_modules/pkg/Readme.md'), plant('.hidden.md')];
    const buildOnly = [plant('PCs/Hero_Story.md'), plant('_inbox/Note.md', 'aliases'), plant('GM/Secret.md', 'gm_aliases'), plant('X.MD', 'aliases')];
    writeBytes(path.join(vaultPath, 'NPCs', 'Ordinary.md'), '---\ntype: npc\ntitle: Ordinary\n---\nbody\n');
    writeBytes(path.join(vaultPath, 'PCs', 'Hero.md'), '---\ntype: pc\ntitle: Hero\n---\nbody\n');

    const { configPath, finalOut } = writeCampaignConfig(root, { vaultPath, excludeDirs: ['GM'] });

    const checkRes = run(root, ['check', 'fm', '--config', configPath]);
    assert.equal(checkRes.status, 2, checkRes.stdout + checkRes.stderr);
    for (const s of checkOnly) assert.equal(fs.existsSync(s), false, `${s} must not have run under check`);

    const buildRes = run(root, ['build', 'fm', '--no-check', '--config', configPath]);
    for (const s of [...checkOnly, ...buildOnly]) assert.equal(fs.existsSync(s), false, `${s} must not have run under build --no-check`);
  });
});

// --- AC-FM-02: every command runs against at least content-page and vault-config locations --------

const COMMAND_SETS = [
  ['check', ['check', 'fm']],
  ['check --json', ['check', 'fm', '--json']],
  ['build (no flags)', ['build', 'fm']],
  ['build --force', ['build', 'fm', '--force']],
  ['build --no-check', ['build', 'fm', '--no-check']],
  ['build --force --no-check', ['build', 'fm', '--force', '--no-check']],
];

for (const [label, extraArgs] of COMMAND_SETS) {
  test(`AC-FM-02 command coverage: ${label} against content-page and vault-config locations`, () => {
    withRoot((root) => {
      const vaultPath = path.join(root, 'vault');
      const sentinels = sentinelsDir(root);
      const s1 = path.join(sentinels, 'cmdcov-content.txt');
      const s2 = path.join(sentinels, 'cmdcov-vaultconfig.txt');
      const m1 = makeMarker();
      const m2 = makeMarker();
      writeBytes(path.join(vaultPath, 'NPCs', 'Planted.md'), `---js\n${payload(s1, m1)}\n---\n`);
      writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), `---js\n${payload(s2, m2)}\n---\n`);
      const { configPath } = writeCampaignConfig(root, { vaultPath });

      const res = run(root, [...extraArgs, '--config', configPath]);
      assert.equal(res.status, 2, `${label}: ${res.stdout}${res.stderr}`);
      assert.equal(fs.existsSync(s1), false, `${label}: content-page sentinel must be absent`);
      assert.equal(fs.existsSync(s2), false, `${label}: vault-config sentinel must be absent`);
    });
  });
}

// --- AC-FM-11: hygiene -----------------------------------------------------------------------------

test('AC-FM-11: 0 marker hits across every captured stdout/stderr, and the 10 KB tag never appears whole', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const marker = makeMarker();
    const sentinel = path.join(root, 'sentinel-hygiene.txt');
    const bigTag = 'X'.repeat(64) + marker + 'Y'.repeat(10000);
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    writeBytes(path.join(vaultPath, 'NPCs', 'Planted.md'), `---${bigTag}\n${payload(sentinel, marker)}\n---\n`);
    const { configPath } = writeCampaignConfig(root, { vaultPath });

    const checkRes = run(root, ['check', 'fm', '--config', configPath]);
    const checkJsonRes = run(root, ['check', 'fm', '--config', configPath, '--json']);
    const buildRes = run(root, ['build', 'fm', '--config', configPath, '--force', '--no-check']);

    for (const res of [checkRes, checkJsonRes, buildRes]) {
      assert.equal(grepMarker(res.stdout, marker), 0, 'marker must never appear in stdout');
      assert.equal(grepMarker(res.stderr, marker), 0, 'marker must never appear in stderr');
    }
    // The rendered tag is bounded: find every quoted tag-ish string in the human/json output and
    // assert none is anywhere near 10KB.
    assert.ok(checkRes.stdout.length < 5000, `human output exploded: ${checkRes.stdout.length} bytes (tag not bounded?)`);
    const envelope = JSON.parse(checkJsonRes.stdout);
    const finding = envelope.findings.find((f) => f.id === 'frontmatter/non-yaml-language');
    assert.ok(finding);
    assert.ok(finding.data.tag.length <= 32, `rendered tag exceeded 32 chars: ${finding.data.tag.length}`);
    assert.equal(fs.existsSync(sentinel), false);
  });
});

// --- AC-FM-04: positive controls, both copies --------------------------------------------------

const POSITIVE_TAGS = ['', ' ', 'yaml', 'YAML', 'yml'];
const POSITIVE_LINE_ENDINGS = [
  ['LF', false],
  ['CRLF', true],
];

test('AC-FM-04: positive-control tags parse to identical data through Scriptorium read.js and the generator copy, across LF/CRLF/BOM', () => {
  const read = require('../src/vault/read');
  for (const tag of POSITIVE_TAGS) {
    for (const [label, crlf] of POSITIVE_LINE_ENDINGS) {
      for (const bom of [false, true]) {
        const buf = fenceFile({ tag, crlf, bom, body: 'type: npc\ntitle: Alice\n' });
        const text = buf.toString('utf8');
        const direct = read.parseYamlOnly(text);
        const generatorResult = pinned.generatorGrayMatter(text, {});
        assert.deepEqual(direct.data, generatorResult.data, `tag=${JSON.stringify(tag)} ${label} bom=${bom}: data mismatch`);
      }
    }
  }
});

test('AC-FM-04: --x and --yamlX with no newline give identical data through both copies (gray-matter\'s slice(0,-1) quirk)', () => {
  const read = require('../src/vault/read');
  for (const text of ['---x', '---yamlX']) {
    const direct = read.parseYamlOnly(text);
    const generatorResult = pinned.generatorGrayMatter(text, {});
    assert.deepEqual(direct.data, generatorResult.data);
  }
});

test('AC-FM-04: a vault using positive-control fence variants builds byte-identical output to the same vault with plain ---', () => {
  withRoot((root) => {
    function buildVault(vaultPath, fenceLine) {
      writeBytes(path.join(vaultPath, 'NPCs', 'Public.md'), `${fenceLine}\ntype: npc\ntitle: Public\n---\nbody\n`);
      writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
      writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n');
    }
    function sha256Tree(dir) {
      const entries = [];
      (function walk(d, rel) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(d, entry.name);
          const r = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(full, r);
          else entries.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
        }
      })(dir, '');
      return entries.sort().join('\n');
    }

    const rootA = path.join(root, 'a');
    const rootB = path.join(root, 'b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    const vaultA = path.join(rootA, 'vaultA');
    buildVault(vaultA, '---yaml');
    const { configPath: cA, finalOut: outA } = writeCampaignConfig(rootA, { campaign: 'a', vaultPath: vaultA });
    const resA = run(rootA, ['build', 'a', '--config', cA]);
    assert.equal(resA.status, 0, resA.stdout + resA.stderr);

    const vaultB = path.join(rootB, 'vaultB');
    buildVault(vaultB, '---');
    const { configPath: cB, finalOut: outB } = writeCampaignConfig(rootB, { campaign: 'b', vaultPath: vaultB });
    const resB = run(rootB, ['build', 'b', '--config', cB]);
    assert.equal(resB.status, 0, resB.stdout + resB.stderr);

    assert.equal(sha256Tree(outA), sha256Tree(outB));
  });
});

// --- FR-FM-07: other entry points ------------------------------------------------------------------

test('FR-FM-07: init --yes falls back to the campaign name for the title, and defaultTitleFor agrees directly', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const marker = makeMarker();
    const sentinel = path.join(root, 'sentinel-init.txt');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
    const outDir = path.join(root, 'out-init');
    const res = run(root, ['init', '--name', 'c', '--vault', vaultPath, '--out', outDir, '--yes']);
    assert.equal(fs.existsSync(sentinel), false);
    // defaultTitleFor, called directly (not via the CLI), must independently agree: a refused
    // vault-config.md falls back to the campaign name, same as a missing campaign: field would.
    assert.equal(defaultTitleFor(vaultPath, 'c'), 'c');
  });
});

test('FR-FM-07: status runs against a refused vault-config.md without executing it', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const marker = makeMarker();
    const sentinel = path.join(root, 'sentinel-status.txt');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
    writeBytes(path.join(vaultPath, 'NPCs', 'Ordinary.md'), '---\ntype: npc\ntitle: Ordinary\n---\nbody\n');
    const { configPath } = writeCampaignConfig(root, { vaultPath });
    const res = run(root, ['status', 'fm', '--config', configPath]);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(grepMarker(res.stdout + res.stderr, marker), 0);
  });
});

test('FR-FM-07: themescheme.paletteScheme and entitytypes.parseRecognisedTypes treat a refused file the same as a malformed-YAML one at the same path', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const marker = makeMarker();
    const sentinel = path.join(root, 'sentinel-parity.txt');

    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
    const refusedPalette = paletteScheme(vaultPath);
    const refusedTypes = parseRecognisedTypes(vaultPath);

    const vaultPathAlt = path.join(root, 'vault-alt');
    writeBytes(path.join(vaultPathAlt, '_meta', 'vault-config.md'), '---\nbroken: [\n---\n');
    const malformedPalette = paletteScheme(vaultPathAlt);

    writeBytes(path.join(root, 'vault-other', '_meta', 'entity-types.md'), '---\nbroken: [\n---\n');
    const malformedTypes = parseRecognisedTypes(path.join(root, 'vault-other'));

    assert.deepEqual(refusedPalette, malformedPalette);
    assert.deepEqual([...refusedTypes], [...malformedTypes]);
    assert.equal(fs.existsSync(sentinel), false);
  });
});

// --- FR-FM-07: serve --admin (state read, check handler, preview build) --------------------------
// Pattern copied (not imported, per house convention) from test/admin-views.test.js: real
// sockets, launch() + waitForHandles() + auth + request().

function adminScratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

function launchAdmin(t, configPath) {
  const handles = [];
  const wrappedListener = async (handler, opts) => {
    const handle = await startLocalListener(handler, opts);
    handles.push(handle);
    return handle;
  };
  const emitted = [];
  const signals = new EventEmitter();
  const resultPromise = runServeCommand({ config: configPath, admin: true }, 'fm', {
    emit: (l) => emitted.push(l),
    startLocalListener: wrappedListener,
    signals,
  });
  t.after(async () => {
    for (const h of handles) {
      try {
        await h.close();
      } catch {
        /* already closed */
      }
    }
  });
  return { resultPromise, handles, emitted, signals };
}

function waitForMacrotaskAdmin() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForHandlesAdmin(state) {
  while (state.handles.length < 2) {
    await waitForMacrotaskAdmin();
  }
  return state;
}

function tokenFromLineAdmin(line) {
  return line.match(/token=([A-Za-z0-9_-]{43})$/)[1];
}

function adminRequest(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function launchAdminAuthed(t, configPath) {
  const s = await waitForHandlesAdmin(launchAdmin(t, configPath));
  const adminPort = s.handles[0].port;
  const authResult = await adminRequest(adminPort, { path: `/auth?token=${tokenFromLineAdmin(s.emitted[0])}` });
  const cookieHeader = authResult.headers['set-cookie'][0].split(';')[0];
  return {
    adminPort,
    get: (p) => adminRequest(adminPort, { path: p, headers: { Cookie: cookieHeader } }),
    post: (p, opts = {}) =>
      adminRequest(adminPort, { method: 'POST', path: p, headers: { Cookie: cookieHeader, Origin: `http://127.0.0.1:${adminPort}`, ...(opts.headers || {}) }, body: opts.body }),
    shutdown: async () => {
      s.signals.emit('SIGINT');
      await s.resultPromise;
    },
  };
}

function adminJson(res) {
  return JSON.parse(res.body.toString('utf8'));
}

test('FR-FM-07 admin: GET /api/state reports the refusal text for a ---js vault-config.md, no marker anywhere in the body', async (t) => {
  const root = mkRoot();
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });
    const marker = makeMarker();
    const sentinel = path.join(root, 'sentinel-admin-state.txt');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
    writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Fine.md\n');
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify(siteConfigJson({ vaultPath, outputDir: path.join(root, 'out'), folderMap: { Notes: 'notes' }, excludeDirs: [] })));
    writeBytes(path.join(vaultPath, 'Notes', 'Fine.md'), '---\ntype: character\n---\n\n# Fine\n');

    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "fm"', '', '[campaigns.fm]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'));

    const originalEnv = { ...process.env };
    Object.assign(process.env, adminScratchEnv(root));
    try {
      const c = await launchAdminAuthed(t, configPath);
      const res = await c.get('/api/state');
      assert.equal(res.status, 200);
      const body = adminJson(res);
      assert.equal(body.vaultConfigMd.ok, false);
      assert.match(body.vaultConfigMd.text, /frontmatter declares the language "js"/);
      assert.equal(grepMarker(res.body.toString('utf8'), marker), 0);
      assert.equal(fs.existsSync(sentinel), false);
      await c.shutdown();
    } finally {
      process.env = originalEnv;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR-FM-07 admin: POST /api/check includes the frontmatter/non-yaml-language finding', async (t) => {
  const root = mkRoot();
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });
    const marker = makeMarker();
    const sentinel = path.join(root, 'sentinel-admin-check.txt');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Fine.md\n');
    writeBytes(path.join(vaultPath, 'Notes', 'Planted.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify(siteConfigJson({ vaultPath, outputDir: path.join(root, 'out'), folderMap: { Notes: 'notes' }, excludeDirs: [] })));
    writeBytes(path.join(vaultPath, 'Notes', 'Fine.md'), '---\ntype: character\n---\n\n# Fine\n');

    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "fm"', '', '[campaigns.fm]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'));

    const originalEnv = { ...process.env };
    Object.assign(process.env, adminScratchEnv(root));
    try {
      const c = await launchAdminAuthed(t, configPath);
      const res = await c.post('/api/check');
      assert.equal(res.status, 200);
      const body = adminJson(res);
      assert.ok(body.envelope.findings.some((f) => f.id === 'frontmatter/non-yaml-language'));
      assert.equal(fs.existsSync(sentinel), false);
      await c.shutdown();
    } finally {
      process.env = originalEnv;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR-FM-07 admin: POST /api/preview exits 2 (refused), never runs the payload', async (t) => {
  const root = mkRoot();
  try {
    const vaultPath = path.join(root, 'vault');
    const packDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(path.join(vaultPath, 'Notes'), { recursive: true });
    const marker = makeMarker();
    const sentinel = path.join(root, 'sentinel-admin-preview.txt');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
    writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] Notes/Fine.md\n');
    fs.writeFileSync(path.join(packDir, 'pack.toml'), 'theme = "plain"\n');
    fs.writeFileSync(path.join(packDir, 'vault.config.json'), JSON.stringify(siteConfigJson({ vaultPath, outputDir: path.join(root, 'out'), folderMap: { Notes: 'notes' }, excludeDirs: [] })));
    writeBytes(path.join(vaultPath, 'Notes', 'Fine.md'), '---\ntype: character\n---\n\n# Fine\n');

    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, ['config_version = 1', 'default_campaign = "fm"', '', '[campaigns.fm]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'));

    const originalEnv = { ...process.env };
    Object.assign(process.env, adminScratchEnv(root));
    try {
      const c = await launchAdminAuthed(t, configPath);
      const res = await c.post('/api/preview');
      assert.equal(res.status, 200);
      const body = adminJson(res);
      assert.equal(body.exitCode, EXIT_CODES.CHECK_FAILED);
      assert.equal(fs.existsSync(sentinel), false);
      await c.shutdown();
    } finally {
      process.env = originalEnv;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR-FM-07: plain serve --build on a refused vault refuses (exit 2) before ever calling startServer', async () => {
  await (async () => {
    const root = mkRoot();
    try {
      const vaultPath = path.join(root, 'vault');
      const marker = makeMarker();
      const sentinel = path.join(root, 'sentinel-serve.txt');
      writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
      writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Ordinary.md\n');
      writeBytes(path.join(vaultPath, 'NPCs', 'Ordinary.md'), '---\ntype: npc\ntitle: Ordinary\n---\nbody\n');
      const { configPath } = writeCampaignConfig(root, { vaultPath });

      let startServerCalled = false;
      const startServer = async () => {
        startServerCalled = true;
        return { server: { close: (cb) => cb() } };
      };
      const signals = new EventEmitter();
      const result = await runServeCommand({ config: configPath, build: true }, 'fm', { emit: () => {}, startServer, signals });

      assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
      assert.equal(startServerCalled, false, 'startServer must never be called when the build it depends on was refused');
      assert.equal(fs.existsSync(sentinel), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })();
});
