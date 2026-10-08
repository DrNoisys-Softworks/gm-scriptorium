'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runInitCommand } = require('../src/cli/init');
const template = require('../src/setup/template');
const { validateStarterTitle } = require('../src/setup/validate');
const { scanBuffer } = require('../scripts/content-markers');
const { BIN, scratchEnv } = require('./helpers/b4-cli');
const { getRenderer } = require('gm-apprentice-publish/lib/templates/pc-registry');

/*
 * The real starter (assets/vault-template), captured from gm-apprentice's own vault scaffold
 * (docs/decisions/0048-new-campaign-vault.md). Every expected value here is written out by hand
 * from the pin record, or is the scaffold's own sha256 recorded at capture time; none is read
 * back from src/setup/template.js.
 */

const DIR = template.TEMPLATE_DIR;
const SHIPPED = ['dnd-5e-2024', 'fitd', 'none', 'pf2e'];
const NOW = () => new Date(2026, 9, 8, 12, 0, 0);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('the shipped starter verifies as a whole tree: every file listed, nothing extra', () => {
  assert.deepEqual(template.verifyTemplateTree(DIR).problems, []);
});

test('the pin record: upstream, commit, plugin version, licence, systems, deviation', () => {
  const tpl = template.loadTemplate();
  const m = tpl.manifest;
  assert.equal(m.upstream.repository, 'https://github.com/AntTheLimey/gm-apprentice');
  assert.equal(m.upstream.commit, 'a0215b1f2e688c476e37d372fd647935360f00b8');
  assert.equal(m.upstream.pluginVersion, '1.10.37');
  assert.equal(m.upstream.script, 'skills/shared/scripts/vault_scaffold.py');
  assert.equal(m.license, 'CC-BY-SA-4.0');
  assert.deepEqual(Object.keys(m.systems).sort(), SHIPPED);
  assert.deepEqual(template.starterSystems(tpl), ['dnd-5e-2024', 'fitd', 'pf2e']);
  assert.deepEqual(m.deviations.map((d) => [d.file, d.from, d.to]), [['_meta/vault-config.md', '  site: false', '  site: true']]);
  assert.deepEqual(m.rulesScan, []);
});

test('per-system counts: 25 folders everywhere; 29 files, and 30 for fitd (its crew template)', () => {
  const m = template.loadTemplate().manifest;
  const counts = Object.fromEntries(Object.entries(m.systems).map(([id, s]) => [id, [s.dirs.length, Object.keys(s.files).length]]));
  assert.deepEqual(counts, { 'dnd-5e-2024': [25, 29], fitd: [25, 30], none: [25, 29], pf2e: [25, 29] });
});

test('exactly three files in every system are ours, and the rest are the scaffold\'s', () => {
  const m = template.loadTemplate().manifest;
  for (const id of SHIPPED) {
    const own = Object.entries(m.systems[id].files).filter(([, e]) => e.origin === 'scriptorium').map(([rel]) => rel).sort();
    assert.deepEqual(own, ['_Campaign/Welcome.md', '_meta/NOTICE.txt', '_meta/publish-manifest.md'], id);
  }
});

test('every shipped game system is one the generator renders sheets for', () => {
  for (const id of ['dnd-5e-2024', 'fitd', 'pf2e']) assert.equal(typeof getRenderer(id), 'function', id);
});

test('no rules-content marker string is anywhere in the starter folder', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(DIR);
  assert.equal(files.length, 43);
  for (const f of files) assert.deepEqual(scanBuffer(fs.readFileSync(f)), [], path.relative(DIR, f));
});

test('parity: every recorded run renders back to the scaffold\'s own bytes once the deviation is reversed', () => {
  const tpl = template.loadTemplate();
  assert.equal(tpl.manifest.parity.length, 8, 'two runs for each of four systems');
  for (const v of tpl.manifest.parity) {
    const out = template.renderStarter(tpl, { system: v.system, title: validateStarterTitle(v.name), created: v.created });
    const got = {};
    for (const f of out.files) {
      if (tpl.manifest.systems[v.system].files[f.rel].origin !== 'upstream') continue;
      let text = f.data.toString('utf8');
      for (const d of tpl.manifest.deviations) if (d.file === f.rel) text = text.replace(d.to, () => d.from);
      got[f.rel] = sha(Buffer.from(text, 'utf8'));
    }
    assert.deepEqual(got, v.files, `${v.system} ${v.created}`);
  }
});

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(root, args) {
  const res = spawnSync(process.execPath, [BIN, ...args, '--config', path.join(root, 'cfg', 'config.toml')], { env: scratchEnv(root), encoding: 'utf8', timeout: 90000 });
  if (res.error) throw res.error;
  return { code: res.status, all: `${res.stdout}${res.stderr}` };
}

/*
 * KNOWN GAP, reported to the owner: on the real starter `check` gives no error but exactly these
 * seven warnings, all census/unrecognised-type. The scaffold's own entity-types page lists
 * `meta`, `timeline` and `pc_roster` only under its "Required Fields" section, which the
 * recognised-type union (src/vault/entitytypes.js) does not read, and not in its hierarchy or
 * folder mapping. The starter cannot be edited (byte parity with the scaffold), so the fix is in the
 * checker, not here. When it lands this list becomes empty and the test below must say "0 warning(s)".
 */
const KNOWN_WARNINGS = [
  'WARN census/unrecognised-type _Campaign/Player Characters.md  _Campaign/Player Characters.md: type "pc_roster" is not in the recognised union (hierarchy + folder-mapping + character-story)',
  'WARN census/unrecognised-type _Campaign/Timeline.md  _Campaign/Timeline.md: type "timeline" is not in the recognised union (hierarchy + folder-mapping + character-story)',
  'WARN census/unrecognised-type _meta/entity-types.md  _meta/entity-types.md: type "meta" is not in the recognised union (hierarchy + folder-mapping + character-story)',
  'WARN census/unrecognised-type _meta/index.md  _meta/index.md: type "meta" is not in the recognised union (hierarchy + folder-mapping + character-story)',
  'WARN census/unrecognised-type _meta/publish-manifest.md  _meta/publish-manifest.md: type "meta" is not in the recognised union (hierarchy + folder-mapping + character-story)',
  'WARN census/unrecognised-type _meta/relationship-types.md  _meta/relationship-types.md: type "meta" is not in the recognised union (hierarchy + folder-mapping + character-story)',
  'WARN census/unrecognised-type _meta/vault-config.md  _meta/vault-config.md: type "meta" is not in the recognised union (hierarchy + folder-mapping + character-story)',
];

const warnings = (out) => out.split('\n').filter((l) => /^(WARN|ERROR) /.test(l));

for (const system of SHIPPED) {
  test(`FR-17 on the real starter: a new ${system} vault has no error, only the known seven census warnings, builds, and the leak checks stay clean`, { timeout: 120000 }, async (t) => {
    const root = scratch(t);
    await runInitCommand(
      { yes: true, name: 'fresh', 'new-vault': path.join(root, 'Fresh Campaign & Co'), system, title: 'The Brass Lantern', config: path.join(root, 'cfg', 'config.toml') },
      [],
      { output: { write() {} }, now: NOW, env: {} },
    );
    const vault = path.join(root, 'Fresh Campaign & Co');
    for (const rel of ['Factions & Organizations', 'Items & Artifacts', '_meta/NOTICE.txt', '_Campaign/Welcome.md', '_meta/publish-manifest.md']) {
      assert.equal(fs.existsSync(path.join(vault, ...rel.split('/'))), true, rel);
    }
    assert.match(fs.readFileSync(path.join(vault, '_meta', 'vault-config.md'), 'utf8'), /\n {2}site: true\n/);
    const notice = fs.readFileSync(path.join(vault, '_meta', 'NOTICE.txt'), 'utf8');
    assert.equal(notice.includes('a0215b1f2e688c476e37d372fd647935360f00b8'), true);
    assert.equal(notice.includes('CC BY-SA 4.0'), true);

    const checked = cli(root, ['check', 'fresh']);
    assert.equal(checked.code, 0, checked.all);
    assert.match(checked.all, /0 error\(s\), 7 warning\(s\), \d+ info\./);
    assert.deepEqual(warnings(checked.all), KNOWN_WARNINGS);

    const built = cli(root, ['build', 'fresh']);
    assert.equal(built.code, 0, built.all);
    const site = path.join(root, 'fresh-site');
    for (const rel of ['index.html', '404.html', path.join('campaign', 'welcome.html')]) assert.equal(fs.existsSync(path.join(site, rel)), true, rel);
    assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8').includes('The Brass Lantern'), true);

    const again = cli(root, ['check', 'fresh']);
    assert.equal(again.code, 0, again.all);
    assert.deepEqual(warnings(again.all), KNOWN_WARNINGS, 'a build adds no leak finding');
    assert.doesNotMatch(again.all, /^(ERROR|WARN) leak\//m);
  });
}
