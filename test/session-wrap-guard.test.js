'use strict';

/*
 * ADR 0036 (docs/agent-runs/r2-session-wrap-architect-2026-09-30.md): replaces the retired
 * "not supported yet" notice (census/session-wrap-unsupported) with three read-only `check`
 * pre-flight warnings. test/fixtures/wrapup-vault (also used by test/build-landing-recap.test.js)
 * keeps its own positive-control role for the build-side reader; test/fixtures/session-chain-vault
 * and its twin (test/session-pairing.test.js, test/session-chain-leak.test.js,
 * test/session-chain-recaps.test.js) cover the rest of R2.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');
const { runBuildCommand } = require('../src/cli/build');
const { runCheckCommand } = require('../src/cli/check');
const { getCheck, CHECKS_BY_ID } = require('../src/checks/registry');
const { RUNNERS } = require('../src/checks/run');
const { captureWithheldHubs } = require('../src/build/sessionmodel');

const WRAPUP_VAULT = path.join(__dirname, 'fixtures', 'wrapup-vault');
const WRAPUP_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'wrapup-vault-site-config.json'));
const SENTINEL = 'SENTINEL-HUB-BODY-TEXT-S1';

const CHAIN_VAULT = path.join(__dirname, 'fixtures', 'session-chain-vault');
const CHAIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'session-chain-vault-site-config.json'));
const TWIN_VAULT = path.join(__dirname, 'fixtures', 'session-chain-twin-vault');
const TWIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'session-chain-twin-vault-site-config.json'));

const NEW_IDS = ['census/session-wrap-hub-unpublished', 'census/session-wrap-link-unpaired', 'census/session-wrap-learned-missing'];
const CODE_RE = /\b(FR|SD|AC|NFR)-\d|\bR2\b/;

function writeConfigToml(configPath, { vaultDir, siteConfigPath, outDir, campaign }) {
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      `default_campaign = "${campaign}"`,
      '',
      `[campaigns.${campaign}]`,
      `vault = '${vaultDir}'`,
      `site_config = '${siteConfigPath}'`,
      `output = '${outDir}'`,
      '',
    ].join('\n'),
  );
}

/** Copies a vault fixture to scratch, applies `mutate(vaultDir)`, and runs `check`. */
function checkVariant(scratch, { srcVault, siteConfig, campaign, mutate, packToml }) {
  const vaultDir = path.join(scratch, campaign, 'vault');
  fs.cpSync(srcVault, vaultDir, { recursive: true });
  if (mutate) mutate(vaultDir);

  const siteConfigDir = path.join(scratch, campaign, 'site');
  fs.mkdirSync(siteConfigDir, { recursive: true });
  const siteConfigPath = path.join(siteConfigDir, 'vault.config.json');
  fs.writeFileSync(siteConfigPath, JSON.stringify({ ...siteConfig, vaultPath: vaultDir }));
  if (packToml) fs.writeFileSync(path.join(siteConfigDir, 'pack.toml'), packToml);

  const configPath = path.join(scratch, campaign, 'config.toml');
  writeConfigToml(configPath, { vaultDir, siteConfigPath, outDir: path.join(scratch, campaign, 'out'), campaign });

  return runCheckCommand({ config: configPath }, campaign);
}

function findingsOf(result, id) {
  return result.envelope.findings.filter((f) => f.id === id);
}

test('registry and runner wiring: the retired id throws, the three new ids are registered and dispatched', () => {
  assert.throws(() => getCheck('census/session-wrap-unsupported'));
  for (const id of NEW_IDS) {
    assert.equal(CHECKS_BY_ID[id].category, 'census');
    assert.equal(CHECKS_BY_ID[id].defaultSeverity, 'warn');
    assert.equal(CHECKS_BY_ID[id].defaultEnabled, true);
    assert.equal(typeof RUNNERS[id], 'function');
  }
});

test('FR-21 pin positive control: the built hub page lacks the sentinel, carries the marker, and captureWithheldHubs reads it', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-pos-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const userJsonConfig = { ...WRAPUP_SITE_CONFIG, vaultPath: WRAPUP_VAULT };

    const result = runAtomicBuild({
      vaultPath: WRAPUP_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'session-guard-pos',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));

    // Listed once, then stated as literals (house style: never derive an expected value from the
    // code under test).
    const built = fs.readdirSync(path.join(finalOut, 'sessions')).sort();
    assert.deepEqual(built, ['index.html', 's1-wrap-up.html', 's1.html']);

    const hubHtml = fs.readFileSync(path.join(finalOut, 'sessions', 's1.html'), 'utf8');
    assert.ok(!hubHtml.includes(SENTINEL), 'the paired hub body must be withheld (sentinel absent)');
    assert.ok(hubHtml.includes('class="recap session-recap"'), 'the pin must emit its own withheld-body marker');

    const { wrapUpByHub, unreadable } = captureWithheldHubs(finalOut);
    assert.deepEqual([...wrapUpByHub.entries()], [['sessions/s1.html', 'sessions/s1-wrap-up.html']]);
    assert.deepEqual(unreadable, []);
    assert.deepEqual(result.sessionPairs.wrapUpByHub, wrapUpByHub);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('FR-21 (M32 discriminator, kept): a hub linked to an UNPUBLISHED Wrap-Up must not fire -- only a published Wrap-Up counts', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-unpub-'));
  try {
    const result = checkVariant(scratch, {
      srcVault: WRAPUP_VAULT,
      siteConfig: WRAPUP_SITE_CONFIG,
      campaign: 'guard-unpub',
      mutate: (vaultDir) => {
        const wrapPath = path.join(vaultDir, 'Sessions', 'S1-Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap = wrap.replace('session: "[[S1]]"', 'session: "[[S1]]"\npublish: false');
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    for (const id of NEW_IDS) assert.deepEqual(findingsOf(result, id), [], `an unpublished Wrap-Up must never pair (${id})`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('build human output no longer says "does not support"', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-build-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(WRAPUP_VAULT, vaultDir, { recursive: true });
    const siteConfigPath = path.join(scratch, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...WRAPUP_SITE_CONFIG, vaultPath: vaultDir }));
    const configPath = path.join(scratch, 'config.toml');
    writeConfigToml(configPath, { vaultDir, siteConfigPath, outDir: path.join(scratch, 'out'), campaign: 'guard-build' });

    const result = runBuildCommand({ config: configPath, force: true }, 'guard-build');
    assert.equal(result.exitCode, 0, result.human);
    assert.ok(!result.human.includes('does not support'), result.human);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-flight: (b) and the twin give 0 of all three new ids', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-b-'));
  try {
    const b = checkVariant(scratch, { srcVault: CHAIN_VAULT, siteConfig: CHAIN_SITE_CONFIG, campaign: 'b' });
    for (const id of NEW_IDS) assert.deepEqual(findingsOf(b, id), []);

    const twin = checkVariant(scratch, { srcVault: TWIN_VAULT, siteConfig: TWIN_SITE_CONFIG, campaign: 'twin' });
    for (const id of NEW_IDS) assert.deepEqual(findingsOf(twin, id), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-flight (e1): the excluded-dir hub gives one hub-unpublished, naming GM/Session 2.md', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-e1-'));
  try {
    const result = checkVariant(scratch, {
      srcVault: CHAIN_VAULT,
      siteConfig: { ...CHAIN_SITE_CONFIG, excludeDirs: [...CHAIN_SITE_CONFIG.excludeDirs, 'GM'] },
      campaign: 'e1',
      mutate: (vaultDir) => {
        fs.mkdirSync(path.join(vaultDir, 'GM'), { recursive: true });
        fs.renameSync(path.join(vaultDir, 'Sessions', 'Session 2.md'), path.join(vaultDir, 'GM', 'Session 2.md'));
      },
    });
    const hits = findingsOf(result, 'census/session-wrap-hub-unpublished');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].data.hub, 'GM/Session 2.md');
    assert.deepEqual(findingsOf(result, 'census/session-wrap-link-unpaired'), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-flight (e2): publish: false on the hub gives one hub-unpublished', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-e2-'));
  try {
    const result = checkVariant(scratch, {
      srcVault: CHAIN_VAULT,
      siteConfig: CHAIN_SITE_CONFIG,
      campaign: 'e2',
      mutate: (vaultDir) => {
        const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
        let hub = fs.readFileSync(hubPath, 'utf8');
        hub = hub.replace('---\n\nR2SENTINEL-HUB-BODY', 'publish: false\n---\n\nR2SENTINEL-HUB-BODY');
        fs.writeFileSync(hubPath, hub);
      },
    });
    const hits = findingsOf(result, 'census/session-wrap-hub-unpublished');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].data.hub, 'Sessions/Session 2.md');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-flight (ambiguous): an ambiguous link gives one link-unpaired', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-ambig-'));
  try {
    const result = checkVariant(scratch, {
      srcVault: CHAIN_VAULT,
      siteConfig: CHAIN_SITE_CONFIG,
      campaign: 'ambiguous',
      mutate: (vaultDir) => {
        const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
        let hub = fs.readFileSync(hubPath, 'utf8');
        hub = hub.replace(/documents:\n {2}wrap_up: "\[\[Session 2 Wrap-Up\]\]"\n {2}prep: "R2SENTINEL-DOCS"\n/, '');
        fs.writeFileSync(hubPath, hub);

        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap = wrap.replace('---\ntype: session_wrap', '---\ntype: session_wrap\nsession: "[[Session 2]]"');
        fs.writeFileSync(wrapPath, wrap);

        fs.mkdirSync(path.join(vaultDir, '_Templates'), { recursive: true });
        fs.writeFileSync(path.join(vaultDir, '_Templates', 'Session 2.md'), '---\ntype: session\n---\n\nTemplate.\n');
      },
    });
    const hits = findingsOf(result, 'census/session-wrap-link-unpaired');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].data.wrapUp, 'WrapUps/Session 2 Wrap-Up.md');
    assert.deepEqual(findingsOf(result, 'census/session-wrap-hub-unpublished'), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-flight (learned-missing): the hub keeps the learned heading, the Wrap-Up loses it -- one learned-missing', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-learned-'));
  try {
    const result = checkVariant(scratch, {
      srcVault: CHAIN_VAULT,
      siteConfig: CHAIN_SITE_CONFIG,
      campaign: 'learned-missing',
      mutate: (vaultDir) => {
        const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
        let hub = fs.readFileSync(hubPath, 'utf8');
        hub += '\n## What the Party Learned\n\n- **The well runs deeper.** Something moves beneath the old stones.\n';
        fs.writeFileSync(hubPath, hub);

        const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
        let wrap = fs.readFileSync(wrapPath, 'utf8');
        wrap = wrap.replace(/## What the Party Learned\n\n- \*\*The well runs deeper\.\*\*[\s\S]*?\n\n/, '');
        fs.writeFileSync(wrapPath, wrap);
      },
    });
    const hits = findingsOf(result, 'census/session-wrap-learned-missing');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].data.hub, 'Sessions/Session 2.md');
    assert.equal(hits[0].data.wrapUp, 'WrapUps/Session 2 Wrap-Up.md');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('pre-flight (custom heading): a pack.toml learned_heading of "Discoveries" clears the finding; the default heading does not', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-custom-'));
  try {
    const rename = (vaultDir) => {
      const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
      let hub = fs.readFileSync(hubPath, 'utf8');
      hub += '\n## Discoveries\n\n- **The well runs deeper.** Something moves beneath the old stones.\n';
      fs.writeFileSync(hubPath, hub);

      const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
      let wrap = fs.readFileSync(wrapPath, 'utf8');
      wrap = wrap.replace('## What the Party Learned', '## Discoveries');
      fs.writeFileSync(wrapPath, wrap);
    };

    const withPack = checkVariant(scratch, {
      srcVault: CHAIN_VAULT,
      siteConfig: CHAIN_SITE_CONFIG,
      campaign: 'custom-with-pack',
      mutate: rename,
      packToml: '[recaps]\nlearned_heading = "Discoveries"\n',
    });
    assert.deepEqual(findingsOf(withPack, 'census/session-wrap-learned-missing'), []);

    const withoutPack = checkVariant(scratch, {
      srcVault: CHAIN_VAULT,
      siteConfig: CHAIN_SITE_CONFIG,
      campaign: 'custom-without-pack',
      mutate: rename,
    });
    // Under the DEFAULT vocab, neither the hub nor the Wrap-Up carries "What the Party Learned"
    // any more (both were renamed to "Discoveries"), so there is nothing to report missing --
    // this proves the default-heading list genuinely gives 0, not that the finding is broken.
    assert.deepEqual(findingsOf(withoutPack, 'census/session-wrap-learned-missing'), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('messages carry no slice codes or role names', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-session-guard-msg-'));
  try {
    const result = checkVariant(scratch, {
      srcVault: CHAIN_VAULT,
      siteConfig: CHAIN_SITE_CONFIG,
      campaign: 'msg',
      mutate: (vaultDir) => {
        const hubPath = path.join(vaultDir, 'Sessions', 'Session 2.md');
        let hub = fs.readFileSync(hubPath, 'utf8');
        hub = hub.replace('---\n\nR2SENTINEL-HUB-BODY', 'publish: false\n---\n\nR2SENTINEL-HUB-BODY');
        fs.writeFileSync(hubPath, hub);
      },
    });
    const hits = findingsOf(result, 'census/session-wrap-hub-unpublished');
    assert.ok(hits.length > 0);
    for (const f of hits) assert.ok(!CODE_RE.test(f.message), f.message);
    for (const check of Object.values(CHECKS_BY_ID)) {
      if (NEW_IDS.includes(check.id)) assert.ok(!CODE_RE.test(check.description), check.description);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("change detector: the pin's templates/session.js still emits class=\"recap session-recap\" and the recap-link anchor", () => {
  const GENERATOR_DIR = path.join(__dirname, '..', 'node_modules', 'gm-apprentice-publish');
  const source = fs.readFileSync(path.join(GENERATOR_DIR, 'lib', 'templates', 'session.js'), 'utf8');
  assert.ok(source.includes('class="recap session-recap"'));
  assert.ok(source.includes('<a class="recap-link" href="${href(ctx.wrapUp)}">'));
});
