'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCampaignContext } = require('../src/cli/args');
const { resolveVaultSite, runCheckForContext } = require('../src/cli/check');
const vaultconfigwrite = require('../src/vault/vaultconfigwrite');
const candidatecheck = require('../src/admin/candidatecheck');

/*
 * V1e-9 (ADR 0041, SD-92), AC-13's equivalence oracle. "The candidate check never disagrees with
 * a real check on the real file" is the one property this whole slice exists to prove: for every
 * fixture below, a real `check` over a SECOND scratch copy with the candidate bytes actually
 * written must name the exact same (id, path, severity) triples candidatecheck.runReview found
 * without ever writing anything. The multiset diff used to compute the expected set here is
 * hand-written, independent of src/admin/candidatecheck.js's own diffFindings -- never derived
 * from the code under test (CLAUDE.md).
 *
 * Invented names throughout (NFR-10/NFR-11). test/fixtures/vocab-vault is copied to scratch for
 * every fixture, never read or written in place.
 */

const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

function scratchCampaign(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `v1e9-candcheck-${label}-`));
  const vaultPath = path.join(root, 'vocab-vault');
  fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = ${JSON.stringify(vaultPath)}`, `output = ${JSON.stringify(path.join(root, 'out'))}`, ''].join('\n'),
  );
  return { root, vaultPath, configPath };
}

function ctxFor(configPath) {
  const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
  const { vaultPath } = resolveVaultSite(ctxInfo);
  return { vaultPath, ctxInfo };
}

/** Independent of src/admin/candidatecheck.js's diffFindings: a hand-written multiset diff. */
function findingKey(f) {
  return [f.id, f.path, f.severity, f.message].join('\u0000');
}
function independentNewFindings(baselineFindings, candidateFindings) {
  const counts = new Map();
  for (const f of baselineFindings) counts.set(findingKey(f), (counts.get(findingKey(f)) || 0) + 1);
  const out = [];
  for (const f of candidateFindings) {
    const k = findingKey(f);
    const remaining = counts.get(k) || 0;
    if (remaining > 0) counts.set(k, remaining - 1);
    else out.push(f);
  }
  return out;
}
function triples(findings) {
  return findings.map((f) => `${f.id}\u0000${f.path}\u0000${f.severity}`).sort();
}

/**
 * Runs the AC-13 oracle for one fixture: `setup(vaultPath)` edits the base vault's on-disk state
 * (the "current" file, read by both the real baseline run and candidatecheck's own baseline
 * call); `candidateBytes` is the edited copy. Returns `{ rv, expectedNewTriples, candidateRealExitCode }`.
 */
function runOracle(setup, candidateBytes) {
  const base = scratchCampaign('base');
  setup(base.vaultPath);
  const baseCtx = ctxFor(base.configPath);
  const baselineReal = runCheckForContext(baseCtx.ctxInfo, {}, {});

  const cand = scratchCampaign('cand');
  setup(cand.vaultPath);
  fs.writeFileSync(path.join(cand.vaultPath, '_meta', 'vault-config.md'), candidateBytes);
  const candCtx = ctxFor(cand.configPath);
  const candidateReal = runCheckForContext(candCtx.ctxInfo, {}, {});

  const expectedNew = independentNewFindings(baselineReal.envelope.findings, candidateReal.envelope.findings);

  const rv = candidatecheck.runReview(baseCtx, { candidateBytes, withCheck: true });

  return { rv, expectedNewTriples: triples(expectedNew), candidateRealExitCode: candidateReal.exitCode };
}

function noop() {}

// -- F1: a mode change -----------------------------------------------------------------------

test('F1 (mode change): candidate findings equal the written-copy oracle', () => {
  const candidateBytes = Buffer.from('---\ntype: meta\npublish:\n  mode: player\n---\n\nFixture vault.\n', 'utf8');
  const { rv, expectedNewTriples, candidateRealExitCode } = runOracle(noop, candidateBytes);
  assert.deepEqual(triples(rv.check.newFindings), expectedNewTriples);
  assert.equal(rv.check.exitCode, candidateRealExitCode);
  assert.equal(rv.check.newCount, expectedNewTriples.length);
});

// -- F2: exclude_fields: ["secrets"], two published pages carrying it, candidate clears the list --

function setupF2(vaultPath) {
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\npublish:\n  mode: full\n  exclude_fields: ["secrets"]\n---\n\nFixture vault.\n',
  );
  const sera = path.join(vaultPath, 'People', 'Sera Wick.md');
  fs.writeFileSync(sera, fs.readFileSync(sera, 'utf8').replace('title: Sera Wick\n', 'title: Sera Wick\nsecrets: She owes the harbourmaster money.\n'));
  const doran = path.join(vaultPath, 'People', 'Doran Vex.md');
  fs.writeFileSync(doran, fs.readFileSync(doran, 'utf8').replace('title: Doran Vex\n', 'title: Doran Vex\nsecrets: He deserted the town guard.\n'));
}

test('F2 (exclude_fields cleared, two published pages carry the field): candidate findings equal the written-copy oracle', () => {
  const candidateBytes = Buffer.from('---\ntype: meta\npublish:\n  mode: full\n  exclude_fields: []\n---\n\nFixture vault.\n', 'utf8');
  const { rv, expectedNewTriples, candidateRealExitCode } = runOracle(setupF2, candidateBytes);
  assert.deepEqual(triples(rv.check.newFindings), expectedNewTriples);
  assert.equal(rv.check.exitCode, candidateRealExitCode);
});

test('F2: the new-findings literal names config/exclude-fields-divergence, warn, path null', () => {
  const candidateBytes = Buffer.from('---\ntype: meta\npublish:\n  mode: full\n  exclude_fields: []\n---\n\nFixture vault.\n', 'utf8');
  const { rv } = runOracle(setupF2, candidateBytes);
  assert.deepEqual(
    rv.check.newFindings.map((f) => ({ id: f.id, severity: f.severity, path: f.path })),
    [{ id: 'config/exclude-fields-divergence', severity: 'warn', path: null }],
  );
});

test('F2: candPublishSet carries both published pages that have the secrets field as an own key', () => {
  const candidateBytes = Buffer.from('---\ntype: meta\npublish:\n  mode: full\n  exclude_fields: []\n---\n\nFixture vault.\n', 'utf8');
  const { rv } = runOracle(setupF2, candidateBytes);
  const pages = rv.candPublishSet.publishedPages.filter((p) => Object.prototype.hasOwnProperty.call(p.frontmatter, 'secrets'));
  assert.deepEqual(pages.map((p) => p.relPath).sort(), ['People/Doran Vex.md', 'People/Sera Wick.md']);
});

// -- F3: a section listed in both lists, removed from the vault list only (unioned, no check finding) --

function setupF3(vaultPath) {
  const jsonPath = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  json.excludeSections = ['Secret Lore'];
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\npublish:\n  mode: full\n  exclude_sections: ["Secret Lore"]\n---\n\nFixture vault.\n',
  );
}

test('F3 (a section unioned via vault.config.json, removed from vault-config.md only): candidate findings equal the written-copy oracle, and nothing is new', () => {
  const candidateBytes = Buffer.from('---\ntype: meta\npublish:\n  mode: full\n---\n\nFixture vault.\n', 'utf8');
  const { rv, expectedNewTriples, candidateRealExitCode } = runOracle(setupF3, candidateBytes);
  assert.deepEqual(triples(rv.check.newFindings), expectedNewTriples);
  assert.deepEqual(expectedNewTriples, []);
  assert.equal(rv.check.newCount, 0);
  assert.equal(rv.check.exitCode, candidateRealExitCode);
});

// -- F4: a `---js` candidate (direct runReview call) ------------------------------------------

test('F4 (`---js` candidate): candidate findings equal the written-copy oracle; exitCode 2; unforceable names frontmatter/non-yaml-language', () => {
  const candidateBytes = Buffer.from('---js\nevil: true\n---\n\nFixture vault.\n', 'utf8');
  const { rv, expectedNewTriples, candidateRealExitCode } = runOracle(noop, candidateBytes);
  assert.deepEqual(triples(rv.check.newFindings), expectedNewTriples);
  assert.equal(rv.check.exitCode, 2);
  assert.equal(candidateRealExitCode, 2);
  assert.equal(rv.check.unforceable.length, 1);
  assert.equal(rv.check.unforceable[0].id, 'frontmatter/non-yaml-language');
  assert.equal(rv.check.unforceable[0].path, candidatecheck.VAULT_CONFIG_REL);
});

// -- F5: a candidate `aliases` entry colliding with an existing note's name ------------------

test('F5 (aliases collision with an existing page): candidate findings equal the written-copy oracle, and names link/ambiguous-target', () => {
  const candidateBytes = Buffer.from('---\ntype: meta\naliases:\n  - Sera Wick\npublish:\n  mode: full\n---\n\nFixture vault.\n', 'utf8');
  const { rv, expectedNewTriples, candidateRealExitCode } = runOracle(noop, candidateBytes);
  assert.deepEqual(triples(rv.check.newFindings), expectedNewTriples);
  assert.equal(rv.check.exitCode, candidateRealExitCode);
  assert.deepEqual(
    rv.check.newFindings.map((f) => f.id),
    ['link/ambiguous-target'],
  );
});

// -- Redaction: a body marker never appears in any returned finding --------------------------

// Reviewer 1 (non-blocking finding, test #8/9): this test's own fixture doesn't actually
// discriminate a broken redact() -- its candidate (`---js`) is refused by the fence predicate
// before the check ever runs, so the only finding it can ever produce is
// frontmatter/non-yaml-language, which is in MESSAGE_KEEP_IDS (never redacted either way) and
// whose own message can't structurally contain body text in the first place. Disabling redact()
// entirely leaves this test green. Renamed to describe what it actually proves (an unforceable
// refusal's own message never echoes the body, which does hold, and is worth keeping); the real
// redact() contract was already separately proven by the "5 redacted keys" test below via K24.
// A second test underneath this one now gives the original name's own claim a fixture that can
// actually fail: a real, non-kept, redactable finding (link/unresolved on vault-config.md's own
// body) whose un-redacted message would genuinely quote the marker.
test('redaction: an unforceable refusal\'s own message never echoes body text, even when a body link happens to share the fence\'s own candidate bytes', () => {
  function setupWithBodyMarker(vaultPath) {
    fs.writeFileSync(
      path.join(vaultPath, '_meta', 'vault-config.md'),
      '---\ntype: meta\npublish:\n  mode: full\n---\n\nSee [[BodyMarkerZq]] for the real plan.\n',
    );
  }
  const base = scratchCampaign('redact-base');
  setupWithBodyMarker(base.vaultPath);
  const baseCtx = ctxFor(base.configPath);
  const candidateBytes = Buffer.from('---js\nevil: true\n---\n\nSee [[BodyMarkerZq]] for the real plan.\n', 'utf8');
  const rv = candidatecheck.runReview(baseCtx, { candidateBytes, withCheck: true });
  const everything = JSON.stringify(rv);
  assert.doesNotMatch(everything, /BodyMarkerZq/);
});

test('redaction: a real link/unresolved finding on vault-config.md\'s own body (not in MESSAGE_KEEP_IDS) has its marker text redacted -- disabling redact() leaks it', () => {
  function setupNoMarker(vaultPath) {
    fs.writeFileSync(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: full\n---\n\nJust a note, nothing linked.\n');
  }
  const base = scratchCampaign('redact-base2');
  setupNoMarker(base.vaultPath);
  const baseCtx = ctxFor(base.configPath);
  // Valid YAML both sides (reaches the real check this time); only the body changes, adding an
  // unresolved wikilink that names the marker -- empirically confirmed this produces a real
  // link/unresolved finding, path _meta/vault-config.md, message "...[[BodyMarkerZq]] does not
  // resolve", and link/unresolved is not in MESSAGE_KEEP_IDS.
  const candidateBytes = Buffer.from('---\ntype: meta\npublish:\n  mode: full\n---\n\nSee [[BodyMarkerZq]] for the real plan.\n', 'utf8');
  const rv = candidatecheck.runReview(baseCtx, { candidateBytes, withCheck: true });
  const linkFindings = rv.check.newFindings.filter((f) => f.id === 'link/unresolved' && f.path === candidatecheck.VAULT_CONFIG_REL);
  assert.equal(linkFindings.length, 1, 'expected exactly one new link/unresolved finding on vault-config.md itself');
  assert.equal(linkFindings[0].message, candidatecheck.REDACTED_MESSAGE);
  const everything = JSON.stringify(rv);
  assert.doesNotMatch(everything, /BodyMarkerZq/);
});

test('redaction: a non-kept finding about vault-config.md itself has its message replaced, and carries only the 5 redacted keys', () => {
  const { vaultPath, configPath } = scratchCampaign('redact-type');
  const ctx = ctxFor(configPath);
  // census/unrecognised-type is NOT in MESSAGE_KEEP_IDS, and its message would otherwise quote
  // the typed value verbatim -- a real way a GM's own text could leak through a "helpful" finding.
  const candidateBytes = Buffer.from('---\ntype: BogusTypeMarker\npublish:\n  mode: full\n---\n\nFixture vault.\n', 'utf8');
  const rv = candidatecheck.runReview(ctx, { candidateBytes, withCheck: true });
  const finding = rv.check.newFindings.find((f) => f.id === 'census/unrecognised-type');
  assert.ok(finding, 'expected a census/unrecognised-type finding');
  assert.deepEqual(Object.keys(finding).sort(), ['id', 'line', 'message', 'path', 'severity']);
  assert.equal(finding.message, candidatecheck.REDACTED_MESSAGE);
  assert.doesNotMatch(JSON.stringify(rv), /BogusTypeMarker/);
});

// -- hits < 1: an injected target mismatch throws CandidateCheckError -------------------------

test('hits < 1 (injected targetPathFor mismatch) throws CandidateCheckError, both with and without withCheck', () => {
  const { vaultPath, configPath } = scratchCampaign('hits');
  const ctx = ctxFor(configPath);
  const original = vaultconfigwrite.targetPathFor;
  vaultconfigwrite.targetPathFor = () => path.join(vaultPath, '_meta', 'nowhere.md');
  try {
    assert.throws(
      () => candidatecheck.runReview(ctx, { candidateBytes: Buffer.from('x'), withCheck: false }),
      candidatecheck.CandidateCheckError,
    );
    assert.throws(
      () => candidatecheck.runReview(ctx, { candidateBytes: Buffer.from('x'), withCheck: true }),
      candidatecheck.CandidateCheckError,
    );
  } finally {
    vaultconfigwrite.targetPathFor = original;
  }
});
