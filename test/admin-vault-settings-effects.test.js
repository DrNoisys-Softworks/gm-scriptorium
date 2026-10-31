'use strict';

/*
 * The panel's "what this changes" review over _meta/vault-config.yaml. The review's rules are
 * written against the old file's names, so the yaml's settings are put back under the names the
 * generator's registry keeps for them, and every path the review shows is translated back to the
 * yaml's own name. These cases check that translation, that every setting a GM can name gives some
 * line in the review, that build-command settings are found, and that check findings about the yaml
 * are redacted. Expected names and messages are typed out by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../src/generator/pinned');
const publishset = require('../src/vault/publishset');
const read = require('../src/vault/read');
const candidatecheck = require('../src/admin/candidatecheck');
const checkcli = require('../src/cli/check');
const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite } = require('../src/cli/check');
const { toOldShape, nameOf, effectsForYaml, commandSettingsChanged, COMMAND_REFUSAL } = require('../src/admin/vaultsettingseffects');
const { moveVaultCopy, assertMovedLayout } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const YAML_REL = '_meta/vault-config.yaml';

function inScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-settings-effects-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function movedSample(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
  assertMovedLayout(vaultPath);
  return vaultPath;
}

// loadPublishConfig on the moved vault, with `data` (plus version 1) served as the yaml. JSON is
// YAML, so the object is written as JSON text.
function publishWith(vault, data) {
  const target = path.join(vault, '_meta', 'vault-config.yaml');
  const bytes = Buffer.from(JSON.stringify({ version: 1, ...data }) + '\n');
  const { value, hits } = read.withCandidateFile(target, bytes, () => publishset.loadPublishConfig(vault, {}));
  assert.ok(hits > 0, 'the publish config was read from the served yaml');
  return value;
}

function setAt(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

// The effects for an edit from `curData` to `candData`, each side's publish config real.
function effectsFor(vault, curData, candData, extra = {}) {
  return effectsForYaml({
    cur: curData,
    cand: candData,
    curPublish: publishWith(vault, curData || {}),
    candPublish: publishWith(vault, candData),
    jsonConfig: {},
    publishDiff: null,
    fixable: new Set(),
    ...extra,
  });
}

// One value the pin reads for each type of setting.
function sampleValue(entry) {
  switch (entry.type) {
    case 'list':
      return ['x'];
    case 'switch':
      return true;
    case 'number':
      return 1;
    case 'choice':
      return entry.values[0];
    case 'map':
      return { x: 'x' };
    default:
      return 'x';
  }
}

// Test titles other assertions in this file are known by, so an exemption can name the one that
// covers it instead.
const COVERS = Object.freeze({
  folderMap: 'a new player_site.folder_map entry is named by the publish comparison, under its yaml name',
});

// Settings that give no line in the review with the coverage case's value. Each says why, and a
// hiding setting names the test that covers it.
const EXEMPT = Object.freeze([
  {
    name: 'player_site.folder_map',
    reason: 'a folder map line comes from the publish comparison, which runs only with the check',
    coveredBy: COVERS.folderMap,
  },
]);

function namesIt(effect, name) {
  if (effect.path !== null && (effect.path === name || name.startsWith(effect.path + '.'))) return true;
  return typeof effect.detail === 'string' && effect.detail.includes(name);
}

test('toOldShape of the moved sample puts registry names under their old names, and the rest under their own', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const parsed = pinned.parseSettingsText(vault, fs.readFileSync(path.join(vault, YAML_REL)));
    assert.equal(parsed.ok, true);
    const { old, rest } = toOldShape(parsed.data);
    assert.deepEqual(old.publish.exclude_fields, ['secrets', 'current_plan', 'plan_progress', 'gm_notes', 'prep_notes', 'reliability']);
    assert.equal(old.publish.four_oh_four.message, 'This page has been cut from the ledger. Someone owes us an explanation.');
    assert.equal(rest.version, 1);
    assert.equal(rest['player_site.host'], 'github-pages');
    assert.equal(old.player_site, undefined, 'no yaml name is left in the old shape');
  });
});

test('toOldShape keeps a key the registry does not list under its own dotted path', () => {
  const { old, rest } = toOldShape({ player_site: { mystery: { deep: 3 }, hide: { fields: ['a'] } } });
  assert.deepEqual(rest, { 'player_site.mystery.deep': 3 });
  assert.deepEqual(old, { publish: { exclude_fields: ['a'] } });
});

test('nameOf translates old paths to the yaml names, parents included, and leaves an unknown path alone', () => {
  assert.equal(nameOf('publish.overrides'), 'player_site.hide.field_exceptions');
  assert.equal(nameOf('publish.overrides.fields'), 'player_site.hide.field_exceptions');
  assert.equal(nameOf('publish.theme.fonts'), 'player_site.theme.fonts');
  assert.equal(nameOf('publish.theme.palette'), 'player_site.theme.palette');
  assert.equal(nameOf('publish.exclude_dirs'), 'player_site.hide.folders');
  assert.equal(nameOf('publish.landing.max_npcs'), 'player_site.landing.max_npcs');
  assert.equal(nameOf('publish.unknown'), 'publish.unknown');
});

test('every setting a GM can name gives a line in the review, except the listed exemptions', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const failing = [];
    for (const name of pinned.settingsNameMap().leaves) {
      const entry = pinned.settingEntry(name);
      const cand = setAt({}, name, sampleValue(entry));
      const effects = effectsFor(vault, {}, cand);
      if (!effects.some((e) => namesIt(e, name))) failing.push(name);
    }
    assert.deepEqual(failing, EXEMPT.map((e) => e.name), `settings with no line in the review: ${failing.join(', ')}`);
  });
});

test('no hiding setting is exempted unless another test in this file covers it', () => {
  const titles = new Set(Object.values(COVERS));
  for (const ex of EXEMPT) {
    assert.ok(ex.reason, `${ex.name} has a reason`);
    if (pinned.settingEntry(ex.name).guards) {
      assert.ok(titles.has(ex.coveredBy), `${ex.name} is a hiding setting, so it names the test that covers it`);
    }
  }
});

test('turning player_site.hide.drafts off is a bad drafts line under its yaml name', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const effects = effectsFor(vault, { player_site: { hide: { drafts: true } } }, { player_site: { hide: { drafts: false } } });
    const drafts = effects.filter((e) => e.id === 'drafts');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].level, 'bad');
    assert.equal(drafts[0].path, 'player_site.hide.drafts');
  });
});

test('the drafts and overrides lines name the yaml settings in their words, not the old keys', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const off = effectsFor(vault, { player_site: { hide: { drafts: true } } }, { player_site: { hide: { drafts: false } } }).filter((e) => e.id === 'drafts');
    assert.equal(off[0].detail, 'player_site.hide.drafts is off, so pages marked as drafts are no longer left out.');
    const on = effectsFor(vault, { player_site: { hide: { drafts: false } } }, { player_site: { hide: { drafts: true } } }).filter((e) => e.id === 'drafts');
    assert.equal(on[0].detail, 'player_site.hide.drafts is on, so pages marked as drafts are left out.');
    const overrides = effectsFor(vault, {}, { player_site: { hide: { field_exceptions: { 'Characters/NPCs/Orpiment.md': ['secrets'] } } } }).filter((e) => e.id === 'overrides');
    assert.equal(overrides[0].detail, 'player_site.hide.field_exceptions can show a hidden field on one page. Check the line-by-line change.');
  });
});

test(COVERS.folderMap, () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const effects = effectsFor(vault, {}, { player_site: { folder_map: { Secret: 'secret' } } }, {
      publishDiff: { newlyPublished: [{ rel: 'Secret/Plot.md', title: 'Plot' }], foldersAdded: [{ folder: 'Secret', output: 'secret' }], foldersRemoved: [] },
    });
    const added = effects.filter((e) => e.id === 'folder-map-added');
    assert.equal(added.length, 1);
    assert.equal(added[0].path, 'player_site.folder_map');
    assert.equal(added[0].title, 'Publishes the folder Secret as /secret/');
    assert.equal(effects.filter((e) => e.id === 'published-more').length, 1);
  });
});

test('a changed player_site.hide.fields reads in the old words, under the yaml name', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const cur = { player_site: { hide: { fields: ['secrets'] } } };
    const cand = { player_site: { hide: { fields: ['secrets', 'x'] } } };
    const added = effectsFor(vault, cur, cand).filter((e) => e.id === 'list-added');
    assert.equal(added.length, 1);
    assert.equal(added[0].path, 'player_site.hide.fields');
    assert.equal(added[0].title, 'The "x" field is now hidden too');

    const removed = effectsFor(vault, cand, cur).filter((e) => e.id === 'list-removed');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].path, 'player_site.hide.fields');
    assert.equal(removed[0].title, 'The "x" field is no longer hidden');
  });
});

test('a fix offered on a yaml list names the yaml setting', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const cur = { player_site: { hide: { fields: ['secrets', 'x'] } } };
    const cand = { player_site: { hide: { fields: ['secrets'] } } };
    const removed = effectsFor(vault, cur, cand, { fixable: new Set(['publish.exclude_fields']) }).filter((e) => e.id === 'list-removed');
    assert.deepEqual(removed[0].fix, { path: 'player_site.hide.fields', entry: 'x' });
  });
});

test('a new player_site.hide.field_exceptions entry is a bad overrides line under the yaml name', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const effects = effectsFor(vault, {}, { player_site: { hide: { field_exceptions: { 'Characters/NPCs/Orpiment.md': ['secrets'] } } } });
    const overrides = effects.filter((e) => e.id === 'overrides');
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].level, 'bad');
    assert.equal(overrides[0].path, 'player_site.hide.field_exceptions');
  });
});

test('a palette change is the colours line under player_site.theme.palette', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const cur = { player_site: { theme: { palette: { primary: '#111111' } } } };
    const cand = { player_site: { theme: { palette: { primary: '#222222' } } } };
    const look = effectsFor(vault, cur, cand).filter((e) => e.id === 'look-palette');
    assert.equal(look.length, 1);
    assert.equal(look[0].path, 'player_site.theme.palette');
    assert.equal(look[0].title, 'The colours change');
  });
});

test('a setting with no old name is listed under its own name among the other settings', () => {
  inScratch((root) => {
    const vault = movedSample(root);
    const other = effectsFor(vault, { player_site: { host: 'github-pages' } }, { player_site: { host: 'cloudflare-pages' } }).filter((e) => e.id === 'other');
    assert.equal(other.length, 1);
    assert.equal(other[0].detail, "player_site.host. The panel doesn't read these; the line-by-line change shows them.");
  });
});

test('commandSettingsChanged finds a changed gm_site.after_build, and nothing for a change elsewhere', () => {
  const cur = { gm_site: { after_build: ['echo one'] }, player_site: { title: 'A' } };
  assert.deepEqual(commandSettingsChanged(cur, { gm_site: { after_build: ['echo two'] }, player_site: { title: 'A' } }), ['gm_site.after_build']);
  assert.deepEqual(commandSettingsChanged(cur, { gm_site: { after_build: ['echo one'] }, player_site: { title: 'B' } }), []);
  assert.deepEqual(commandSettingsChanged({}, { player_site: { before_build: ['make'] } }), ['player_site.before_build']);
});

test('commandSettingsChanged fails closed when the current file cannot be read', () => {
  // The same value as before; with nothing to compare against, it still counts as changed.
  assert.deepEqual(commandSettingsChanged(null, { player_site: { before_build: ['make'] } }), ['player_site.before_build']);
  assert.deepEqual(commandSettingsChanged(null, { player_site: { title: 'A' } }), []);
});

test('COMMAND_REFUSAL names the settings and says to change them by hand', () => {
  assert.equal(
    COMMAND_REFUSAL(['player_site.before_build', 'gm_site.after_build']),
    'The panel never changes player_site.before_build or gm_site.after_build. They run commands on your computer when gm-apprentice publishes. Change them in _meta/vault-config.yaml yourself.',
  );
});

test('redact on the yaml keeps a settings-fault message and redacts any other finding there', () => {
  const fault = { id: 'config/settings-fault', severity: 'error', path: YAML_REL, line: 3, message: 'player_site.hide.fields must be a list' };
  assert.equal(candidatecheck.redact(fault, YAML_REL).message, 'player_site.hide.fields must be a list');
  const other = { id: 'config/exclude-fields-divergence', severity: 'warning', path: YAML_REL, line: 3, message: 'quoted secret text' };
  assert.equal(candidatecheck.redact(other, YAML_REL).message, 'Check reports this for vault-config.yaml. Run Check after saving to see the detail.');
  const elsewhere = { id: 'link/unresolved', severity: 'warning', path: 'Locations/Town.md', line: 3, message: 'kept as it is' };
  assert.equal(candidatecheck.redact(elsewhere, YAML_REL).message, 'kept as it is');
});

test('redact on vault-config.md is unchanged: a settings-fault there is redacted, a kept id is not', () => {
  const md = '_meta/vault-config.md';
  assert.equal(
    candidatecheck.redact({ id: 'config/settings-fault', severity: 'error', path: md, line: 1, message: 'm' }).message,
    'Check reports this for vault-config.md. Run Check after saving to see the detail.',
  );
  assert.equal(candidatecheck.redact({ id: 'config/exclude-fields-divergence', severity: 'warning', path: md, line: 1, message: 'm' }).message, 'm');
});

test('a review of the yaml redacts what the check says about the yaml', (t) => {
  inScratch((root) => {
    const vault = movedSample(root);
    const cfg = path.join(root, 'config.toml');
    fs.writeFileSync(
      cfg,
      `config_version = 1\ndefault_campaign = "s"\n\n[campaigns.s]\nvault = ${JSON.stringify(vault)}\noutput = ${JSON.stringify(path.join(root, 'out'))}\npack = ${JSON.stringify(path.join(vault, '_meta', 'scriptorium'))}\n`,
    );
    const ctxInfo = resolveCampaignContext({ config: cfg }, 's');
    const ctx = { vaultPath: resolveVaultSite(ctxInfo).vaultPath, ctxInfo };
    // The check is replaced by one that reads the settings (so the candidate is seen) and reports
    // one finding about the yaml whose message must not reach the panel.
    const real = checkcli.runCheckForContextWithContext;
    let calls = 0;
    t.after(() => {
      checkcli.runCheckForContextWithContext = real;
    });
    checkcli.runCheckForContextWithContext = () => {
      calls += 1;
      publishset.loadPublishConfig(ctx.vaultPath, {});
      const findings = calls === 1 ? [] : [{ id: 'config/odd', severity: 'warning', path: YAML_REL, line: 2, message: 'SECRET-MARKER' }];
      return { exitCode: 0, envelope: { findings, counts: {} }, checkCtx: { publishSet: null } };
    };
    const bytes = fs.readFileSync(path.join(vault, YAML_REL));
    const rv = candidatecheck.runReview(ctx, { candidateBytes: bytes, withCheck: true, targetRel: YAML_REL });
    assert.equal(rv.check.ran, true);
    assert.deepEqual(rv.check.newFindings.map((f) => f.message), ['Check reports this for vault-config.yaml. Run Check after saving to see the detail.']);
  });
});
