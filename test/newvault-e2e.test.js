'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runInitCommand } = require('../src/cli/init');
const { BIN, scratchEnv } = require('./helpers/b4-cli');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

/*
 * A freshly created vault works end to end (docs/decisions/0048-new-campaign-vault.md, section 1):
 * `check` reports no error and no warning, and `build` writes the landing page, the 404 page and
 * the welcome page, with the leak checks clean. Today this runs against the test fixture starter
 * for each of its systems; the real starter's systems are added when it is pinned. The real
 * `check` and `build` commands run in child processes, with a scratch config only.
 */

const NOW = () => new Date(2026, 9, 8, 12, 0, 0);

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-nv-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(root, args) {
  const res = spawnSync(process.execPath, [BIN, ...args, '--config', path.join(root, 'cfg', 'config.toml')], { env: scratchEnv(root), encoding: 'utf8', timeout: 90000 });
  if (res.error) throw res.error;
  return { code: res.status, all: `${res.stdout}${res.stderr}` };
}

async function create(root, system, templateDir = FIXTURE_DIR, title = 'The Brass Lantern') {
  await runInitCommand(
    { yes: true, name: 'fresh', 'new-vault': path.join(root, 'Fresh Campaign & Co'), system, title, config: path.join(root, 'cfg', 'config.toml') },
    [],
    { output: { write() {} }, now: NOW, env: {}, templateDir },
  );
}

for (const system of ['none', 'dnd-5e-2024']) {
  test(`FR-17: a new ${system} vault passes check with no error and no warning, and builds`, { timeout: 120000 }, async (t) => {
    const root = scratch(t);
    await create(root, system);

    const checked = cli(root, ['check', 'fresh']);
    assert.equal(checked.code, 0, checked.all);
    assert.match(checked.all, /0 error\(s\), 0 warning\(s\), \d+ info\./);

    const built = cli(root, ['build', 'fresh']);
    assert.equal(built.code, 0, built.all);
    const site = path.join(root, 'fresh-site');
    for (const rel of ['index.html', '404.html', path.join('campaign', 'welcome.html')]) {
      assert.equal(fs.existsSync(path.join(site, rel)), true, rel);
    }
    const landing = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
    assert.equal(landing.includes('The Brass Lantern'), true, 'the landing page carries the title');
    const welcome = fs.readFileSync(path.join(site, 'campaign', 'welcome.html'), 'utf8');
    assert.match(welcome, /story starts soon\./);
    assert.equal(welcome.includes('Edit this page, then tick more pages'), false, 'the GM notes under ## GM Notes never reach the site');

    // the leak checks read the built output too: still clean once a build exists
    const again = cli(root, ['check', 'fresh']);
    assert.equal(again.code, 0, again.all);
    assert.match(again.all, /0 error\(s\), 0 warning\(s\), \d+ info\./);
    assert.doesNotMatch(again.all, /^(ERROR|WARN) leak\//m);
  });
}

test('FR-17: a title with a colon, a hash, three dashes and non-ASCII text builds and shows exactly as typed', { timeout: 120000 }, async (t) => {
  const root = scratch(t);
  await create(root, 'dnd-5e-2024', FIXTURE_DIR, 'Tomb: Act #2 --- Café 世界');
  const built = cli(root, ['build', 'fresh']);
  assert.equal(built.code, 0, built.all);
  const landing = fs.readFileSync(path.join(root, 'fresh-site', 'index.html'), 'utf8');
  assert.equal(landing.includes('Tomb: Act #2 --- Café 世界'), true);
});

test('negative control: without the declared deviation the new vault has its site switched off, and build refuses', { timeout: 120000 }, async (t) => {
  const root = scratch(t);
  const copy = path.join(root, 'template-without-deviation');
  fs.cpSync(FIXTURE_DIR, copy, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
  manifest.deviations = [];
  fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest));
  await create(root, 'none', copy);
  assert.match(fs.readFileSync(path.join(root, 'Fresh Campaign & Co', '_meta', 'vault-config.md'), 'utf8'), /\n {2}site: false\n/);
  const built = cli(root, ['build', 'fresh']);
  assert.notEqual(built.code, 0, built.all);
  assert.equal(fs.existsSync(path.join(root, 'fresh-site', 'index.html')), false);
});

test('names with spaces and an ampersand work from the command line to the built site', { timeout: 120000 }, async (t) => {
  const root = scratch(t);
  await create(root, 'none');
  assert.equal(fs.existsSync(path.join(root, 'Fresh Campaign & Co', 'Factions & Organizations')), true);
  assert.equal(cli(root, ['build', 'fresh']).code, 0);
});
