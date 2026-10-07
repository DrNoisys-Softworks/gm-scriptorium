'use strict';

/*
 * ADR 0036 (docs/agent-runs/r2-session-wrap-architect-2026-09-30.md), SD-4: timeline learned
 * items, recap numerals and Connections now source from a paired session's Wrap-Up, matching the
 * unmigrated twin (test/fixtures/session-chain-twin-vault) page for page everywhere that the pin's
 * own graph allocation doesn't itself make per-page equality meaningless (AC-02's corrected scope:
 * every page whose type is neither `session` nor a Wrap-Up type -- docs/agent-runs corrections 0.2).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');
const { runBuildCommand } = require('../src/cli/build');
const { runStatusCommand } = require('../src/cli/status');
const { computePublishedSet } = require('../src/vault/publishset');
const sessionpairs = require('../src/vault/sessionpairs');

const CHAIN_VAULT = path.join(__dirname, 'fixtures', 'session-chain-vault');
const CHAIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'session-chain-vault-site-config.json'));
const TWIN_VAULT = path.join(__dirname, 'fixtures', 'session-chain-twin-vault');
const TWIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'session-chain-twin-vault-site-config.json'));

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

function buildVault(vaultPath, siteConfig, campaign, { vocab } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-chain-recaps-${campaign}-`));
  const siteDir = path.join(scratch, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const finalOut = path.join(scratch, 'out');
  const result = runAtomicBuild({
    vaultPath,
    userJsonConfig: { ...siteConfig, vaultPath },
    finalOut,
    siteDir,
    campaign,
    force: true,
    vocab,
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
  return { scratch, finalOut, result };
}

function readTree(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, entryRel);
      else if (entry.name.endsWith('.html')) out[entryRel] = fs.readFileSync(full, 'utf8');
    }
  })(dir, '');
  return out;
}

function dataIsland(html, cls) {
  const re = new RegExp(`<script type="application/json" class="${cls}">([^<]*)</script>`);
  const m = html.match(re);
  return m ? JSON.parse(m[1]) : null;
}

function typesByOutputPath(vaultPath, siteConfig) {
  const { publishedPages } = computePublishedSet(vaultPath, { ...siteConfig, vaultPath });
  const out = new Map();
  for (const p of publishedPages) out.set(p.outputPath, p.frontmatter.type || '');
  return out;
}

function isSessionOrWrapUp(type) {
  return type === 'session' || ['session-wrap-up', 'session_wrap', 'session-wrapup'].includes(type);
}

// ---------------------------------------------------------------------------
// AC-02 / AC-03: (b) and (c), each against the twin
// ---------------------------------------------------------------------------

function assertAgainstTwin(t, label, vaultPath, siteConfig, { pairedSessions = [1, 2] } = {}) {
  const b = buildVault(vaultPath, siteConfig, `recaps-${label}`);
  const twin = buildVault(TWIN_VAULT, TWIN_SITE_CONFIG, `recaps-${label}-twin`);
  try {
    const bTree = readTree(b.finalOut);
    const twinTree = readTree(twin.finalOut);
    const bTypes = typesByOutputPath(vaultPath, siteConfig);
    const twinTypes = typesByOutputPath(TWIN_VAULT, TWIN_SITE_CONFIG);

    // Timeline totals.
    const bTimeline = dataIsland(bTree['timeline.html'], 'sc-tl-data');
    const twinTimeline = dataIsland(twinTree['timeline.html'], 'sc-tl-data');
    assert.equal(b.result.timeline.learned.total, twin.result.timeline.learned.total, `${label}: learned total`);
    assert.ok(b.result.timeline.learned.total > 0, `${label}: learned total must be > 0`);
    assert.equal(b.result.timeline.learned.placed, twin.result.timeline.learned.placed, `${label}: learned placed`);
    assert.equal(bTimeline.points.length, twinTimeline.points.length, `${label}: timeline points`);

    // Per-page numeral sets and lane item sets, on every page whose type is neither `session`
    // nor a Wrap-Up type (docs/agent-runs corrections, finding 0.2).
    for (const outputPath of Object.keys(bTree)) {
      if (!(outputPath in twinTree)) continue;
      const type = bTypes.get(outputPath);
      if (type === undefined || isSessionOrWrapUp(type)) continue;
      const bIsland = dataIsland(bTree[outputPath], 'sc-cx-data');
      const twinIsland = dataIsland(twinTree[outputPath], 'sc-cx-data');
      if (!bIsland && !twinIsland) continue;
      assert.ok(bIsland && twinIsland, `${label}: ${outputPath} must have a Connections island on both sides`);
      assert.deepEqual(
        (bIsland.sessions || []).map((s) => s.n).sort(),
        (twinIsland.sessions || []).map((s) => s.n).sort(),
        `${label}: ${outputPath} numeral set`,
      );
      const laneSet = (island) => (island.items || []).map((it) => `${it.name}\u0000${it.kind}\u0000${it.group}`).sort();
      assert.deepEqual(laneSet(bIsland), laneSet(twinIsland), `${label}: ${outputPath} lane item set`);
    }

    // Learned links and point recap links resolve to wrap-ups/... for every PAIRED session (a
    // session with no Wrap-Up at all, e.g. (c)'s unpaired Session 1, correctly links to itself).
    for (const learned of bTimeline.learned) {
      if (!pairedSessions.includes(learned.s)) continue;
      assert.ok(learned.links.some(([, href]) => href.startsWith('wrap-ups/')), `learned item link must target a Wrap-Up: ${JSON.stringify(learned)}`);
    }
    for (const point of bTimeline.points) {
      if (!pairedSessions.includes(point.s)) continue;
      const recapLink = point.links.find(([text]) => text.startsWith('Read the full session') || /^[IVXLCDM]+,/.test(text));
      if (recapLink) assert.ok(recapLink[1].startsWith('wrap-ups/'), `point recap link must target a Wrap-Up: ${JSON.stringify(point)}`);
    }

    // The session-plan page stays a lane item on Ysolde's page; no Wrap-Up is ever a lane item.
    const ysoldePath = Object.keys(bTree).find((p) => p.endsWith('ysolde-marr.html'));
    const ysoldeIsland = dataIsland(bTree[ysoldePath], 'sc-cx-data');
    assert.ok(ysoldeIsland, 'Ysolde\'s page must carry a Connections island');
    const planItem = (ysoldeIsland.items || []).find((it) => it.href && it.href.includes('session-3-plan'));
    assert.ok(planItem, 'the session-plan page must stay a lane item on Ysolde\'s page');
    for (const outputPath of Object.keys(bTree)) {
      const island = dataIsland(bTree[outputPath], 'sc-cx-data');
      if (!island) continue;
      for (const it of island.items || []) {
        assert.ok(!(it.href && it.href.includes('wrap-up')), `no lane item may be a Wrap-Up page (${outputPath}: ${JSON.stringify(it)})`);
      }
    }
  } finally {
    fs.rmSync(b.scratch, { recursive: true, force: true });
    fs.rmSync(twin.scratch, { recursive: true, force: true });
  }
}

test('AC-02: (b) against the twin', (t) => {
  assertAgainstTwin(t, 'b', CHAIN_VAULT, CHAIN_SITE_CONFIG);
});

test('AC-03: (c) against the twin', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-recaps-c-setup-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
    fs.copyFileSync(path.join(TWIN_VAULT, 'Sessions', 'Session 1.md'), path.join(vaultDir, 'Sessions', 'Session 1.md'));
    fs.rmSync(path.join(vaultDir, 'WrapUps', 'Session 1 Wrap-Up.md'));
    assertAgainstTwin(t, 'c', vaultDir, CHAIN_SITE_CONFIG, { pairedSessions: [2] });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-04: (d1) equals the twin; (d2)/(d3) give Session 2 0 learned items
// ---------------------------------------------------------------------------

test('AC-04 (d1): the twin plus both Wrap-Ups set to publish: false still equals the plain twin', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-recaps-d1-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(TWIN_VAULT, vaultDir, { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'WrapUps'));
    for (const [src, hubFile] of [
      ['Session 1 Wrap-Up.md', 'Session 1.md'],
      ['Session 2 Wrap-Up.md', 'Session 2.md'],
    ]) {
      let wrap = fs.readFileSync(path.join(CHAIN_VAULT, 'WrapUps', src), 'utf8');
      wrap = wrap.replace('---\ntype: session_wrap', '---\ntype: session_wrap\npublish: false');
      fs.writeFileSync(path.join(vaultDir, 'WrapUps', src), wrap);

      const hubPath = path.join(vaultDir, 'Sessions', hubFile);
      let hub = fs.readFileSync(hubPath, 'utf8');
      const n = hubFile.includes('1') ? 1 : 2;
      hub = hub.replace('---\n\n', `documents:\n  wrap_up: "[[${src.replace('.md', '')}]]"\n---\n\n`);
      fs.writeFileSync(hubPath, hub);
    }

    const d1 = buildVault(vaultDir, { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir }, 'recaps-d1');
    const twin = buildVault(TWIN_VAULT, TWIN_SITE_CONFIG, 'recaps-d1-twin');
    try {
      assert.equal(d1.result.timeline.learned.total, twin.result.timeline.learned.total);
      assert.equal(d1.result.timeline.learned.placed, twin.result.timeline.learned.placed);
      const d1Tree = readTree(d1.finalOut);
      for (const sentinel of ['R2SENTINEL-SCENE', 'R2SENTINEL-DOCS', 'R2SENTINEL-HUB-BODY', 'R2SENTINEL-WRAP-GM']) {
        for (const html of Object.values(d1Tree)) assert.ok(!html.includes(sentinel));
      }
    } finally {
      fs.rmSync(d1.scratch, { recursive: true, force: true });
      fs.rmSync(twin.scratch, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('AC-04 (d2): Session 2 set to publish: stub (Narrative Recap only) gives 0 learned items; numerals come only from the recap\'s own links', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-recaps-d2-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
    const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
    let wrap = fs.readFileSync(wrapPath, 'utf8');
    wrap = wrap.replace(
      '---\ntype: session_wrap',
      '---\ntype: session_wrap\npublish: stub\npublish_include_sections: ["Narrative Recap"]',
    );
    fs.writeFileSync(wrapPath, wrap);

    const { result, finalOut, scratch: bScratch } = buildVault(vaultDir, { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir }, 'recaps-d2');
    try {
      const tree = readTree(finalOut);
      const island = dataIsland(tree['timeline.html'], 'sc-tl-data');
      const session2Learned = island.learned.filter((l) => l.s === 2);
      assert.equal(session2Learned.length, 0, 'Session 2 must contribute 0 learned items once its Wrap-Up is stub-reduced to the recap only');
      assert.equal(result.timeline.learned.total, 2, 'only Session 1\'s two learned items remain');
    } finally {
      fs.rmSync(bScratch, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('AC-04 (d3): Session 2\'s Wrap-Up learned list fenced gm-only gives 0 learned items for Session 2', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-recaps-d3-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
    const wrapPath = path.join(vaultDir, 'WrapUps', 'Session 2 Wrap-Up.md');
    let wrap = fs.readFileSync(wrapPath, 'utf8');
    wrap = wrap.replace(
      /## What the Party Learned\n\n([\s\S]*?)\n\n## GM Notes/,
      '## What the Party Learned\n\n<!-- gm-only -->\n$1\n<!-- /gm-only -->\n\n## GM Notes',
    );
    fs.writeFileSync(wrapPath, wrap);

    const { result, finalOut, scratch: bScratch } = buildVault(vaultDir, { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir }, 'recaps-d3');
    try {
      const tree = readTree(finalOut);
      const island = dataIsland(tree['timeline.html'], 'sc-tl-data');
      const session2Learned = island.learned.filter((l) => l.s === 2);
      assert.equal(session2Learned.length, 0);
      assert.equal(result.timeline.learned.total, 2);
    } finally {
      fs.rmSync(bScratch, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FR-06 / FR-07
// ---------------------------------------------------------------------------

test('FR-06: Wrap-Up pages carry no metadata-badges or data-field=; hubs keep data-field="session_number"', () => {
  const { finalOut, scratch } = buildVault(CHAIN_VAULT, CHAIN_SITE_CONFIG, 'recaps-fr06');
  try {
    const tree = readTree(finalOut);
    const wrapHtml = tree['wrap-ups/session-2-wrap-up.html'];
    assert.ok(wrapHtml, 'the Wrap-Up page must exist');
    assert.ok(!wrapHtml.includes('metadata-badges'));
    assert.ok(!wrapHtml.includes('data-field='));
    const hubHtml = tree['sessions/session-2.html'];
    assert.ok(hubHtml.includes('data-field="session_number"'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('FR-07: status --json lastSession is equal for (b) and the twin', () => {
  function statusFor(vaultPath, siteConfig, campaign) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-chain-recaps-status-${campaign}-`));
    try {
      const siteConfigPath = path.join(scratch, 'vault.config.json');
      fs.writeFileSync(siteConfigPath, JSON.stringify({ ...siteConfig, vaultPath }));
      const configPath = path.join(scratch, 'config.toml');
      writeConfigToml(configPath, { vaultDir: vaultPath, siteConfigPath, outDir: path.join(scratch, 'out'), campaign });
      return runStatusCommand({ config: configPath }, campaign);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  const b = statusFor(CHAIN_VAULT, CHAIN_SITE_CONFIG, 'recaps-status-b');
  const twin = statusFor(TWIN_VAULT, TWIN_SITE_CONFIG, 'recaps-status-twin');
  assert.deepEqual(b.envelope.lastSession, twin.envelope.lastSession);
});

// ---------------------------------------------------------------------------
// FR-08: a custom learned_heading through parseVocab
// ---------------------------------------------------------------------------

test('FR-08: a custom learned_heading gives learned items from the Wrap-Up\'s own custom heading', () => {
  const { parseVocab } = require('../src/build/labels');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-recaps-fr08-'));
  try {
    const vaultDir = path.join(scratch, 'vault');
    fs.cpSync(CHAIN_VAULT, vaultDir, { recursive: true });
    // Both Wrap-Ups' headings are renamed: under the custom vocab, the DEFAULT heading no longer
    // matches at all, so Session 1 would otherwise drop out of the total too.
    for (const file of ['Session 1 Wrap-Up.md', 'Session 2 Wrap-Up.md']) {
      const wrapPath = path.join(vaultDir, 'WrapUps', file);
      let wrap = fs.readFileSync(wrapPath, 'utf8');
      wrap = wrap.replace('## What the Party Learned', '## Discoveries');
      fs.writeFileSync(wrapPath, wrap);
    }

    const { vocab } = parseVocab({ recaps: { learned_heading: 'Discoveries' } }, { T: 'pack.toml', c: 'recaps-fr08' });
    const { result, finalOut, scratch: bScratch } = buildVault(vaultDir, { ...CHAIN_SITE_CONFIG, vaultPath: vaultDir }, 'recaps-fr08', { vocab });
    try {
      const tree = readTree(finalOut);
      const island = dataIsland(tree['timeline.html'], 'sc-tl-data');
      const session2Learned = island.learned.filter((l) => l.s === 2);
      assert.equal(session2Learned.length, 2, 'the two Discoveries items must be picked up under the custom vocab');
      assert.equal(result.timeline.learned.total, 4);
    } finally {
      fs.rmSync(bScratch, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sourcing follows the built pages, not the recomputed check-side pairing
// ---------------------------------------------------------------------------

test('sourcing follows the built pages: a real (b) build still sources from the Wrap-Ups even when the check-side pairing is stubbed empty, and warns once per hub', () => {
  const original = sessionpairs.computeSessionPairing;
  sessionpairs.computeSessionPairing = () => sessionpairs.EMPTY_PAIRING;
  let b;
  try {
    b = buildVault(CHAIN_VAULT, CHAIN_SITE_CONFIG, 'recaps-stubbed');
    assert.ok(b.result.timeline.learned.total > 0, 'recaps/timeline must still source from the Wrap-Ups');
  } finally {
    sessionpairs.computeSessionPairing = original;
    if (b) fs.rmSync(b.scratch, { recursive: true, force: true });
  }

  // Re-run the same stub through the CLI so the human warning line is observable.
  sessionpairs.computeSessionPairing = () => sessionpairs.EMPTY_PAIRING;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-recaps-stub-cli-'));
  try {
    const siteConfigPath = path.join(scratch, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...CHAIN_SITE_CONFIG, vaultPath: CHAIN_VAULT }));
    const configPath = path.join(scratch, 'config.toml');
    writeConfigToml(configPath, { vaultDir: CHAIN_VAULT, siteConfigPath, outDir: path.join(scratch, 'out'), campaign: 'recaps-stub-cli' });
    const build = runBuildCommand({ config: configPath, force: true }, 'recaps-stub-cli');
    assert.equal(build.exitCode, 0, build.human);
    const warningLines = build.human.split('\n').filter((l) => l.startsWith('warning: sessions:'));
    assert.equal(warningLines.length, 2, `expected one warning: sessions: line per paired hub, got:\n${build.human}`);
  } finally {
    sessionpairs.computeSessionPairing = original;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('normal (b): no warning: sessions: line', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-chain-recaps-normal-'));
  try {
    const siteConfigPath = path.join(scratch, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...CHAIN_SITE_CONFIG, vaultPath: CHAIN_VAULT }));
    const configPath = path.join(scratch, 'config.toml');
    writeConfigToml(configPath, { vaultDir: CHAIN_VAULT, siteConfigPath, outDir: path.join(scratch, 'out'), campaign: 'recaps-normal' });
    const build = runBuildCommand({ config: configPath, force: true }, 'recaps-normal');
    assert.equal(build.exitCode, 0, build.human);
    const warningLines = build.human.split('\n').filter((l) => l.startsWith('warning: sessions:'));
    assert.deepEqual(warningLines, []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
