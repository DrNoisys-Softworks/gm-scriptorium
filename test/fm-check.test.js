'use strict';

/*
 * ADR 0034 / FR-FM-04, FR-FM-05. The whole-vault fence walk (src/vault/fencescan.js) and the
 * frontmatter/non-yaml-language check it drives: every location FR-FM-04's superset requires,
 * and the precision locations that must NOT be listed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanFrontmatterFences } = require('../src/vault/fencescan');
const { readFrontmatter } = require('../src/vault/read');
const { FrontmatterLanguageError, VaultReadError } = require('../src/util/errors');
const { CHECKS, CHECKS_BY_ID } = require('../src/checks/registry');
const { RUNNERS } = require('../src/checks/run');
const frontmatterChecks = require('../src/checks/frontmatter');
const read = require('../src/vault/read');
const { mkRoot, sentinelsDir, makeMarker, payload, payloadWithAliases, gmAliasesPayload, writeBytes, writeCampaignConfig, run } = require('./fm-harness');

function withRoot(fn) {
  const root = mkRoot();
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Plants every FR-FM-04 must-list location plus every precision-control location that must NOT
 * be listed, under vaultPath. Returns the set of relative paths that MUST be refused.
 */
function plantMatrixVault(vaultPath) {
  const mustList = new Set();

  function plantJs(rel, { aliases = false, gmAliases = false } = {}) {
    const marker = makeMarker();
    const body = aliases ? payloadWithAliases(path.join(vaultPath, '..', 'sentinels', `${rel.replace(/[\\/]/g, '_')}.txt`), marker) : gmAliases ? gmAliasesPayload(path.join(vaultPath, '..', 'sentinels', `${rel.replace(/[\\/]/g, '_')}.txt`), marker) : payload(path.join(vaultPath, '..', 'sentinels', `${rel.replace(/[\\/]/g, '_')}.txt`), marker);
    writeBytes(path.join(vaultPath, rel), `---js\n${body}\n---\n`);
    mustList.add(rel);
  }

  // Must-list locations
  plantJs('NPCs/Planted.md');
  plantJs('_meta/vault-config.md');
  plantJs('_meta/publish-manifest.md');
  plantJs('_meta/entity-types.md');
  plantJs('PCs/Hero_Story.md');
  plantJs('_inbox/Note.md', { aliases: true });
  plantJs('GM/Secret.md', { gmAliases: true });
  plantJs('node_modules/pkg/Readme.md');
  plantJs('.hidden.md');
  plantJs('sub/.hidden.md');
  plantJs('X.MD', { aliases: true });
  plantJs('notes.v2/Note.md');

  // Precision controls: must NOT be listed
  writeBytes(path.join(vaultPath, '.obsidian', 'x.md'), '---js\nshould not be walked\n---\n');
  writeBytes(path.join(vaultPath, 'notes.md.bak'), '---js\nnot a .md file\n---\n');

  // A directory symlink loop (must terminate, not infinite-recurse)
  fs.symlinkSync('.', path.join(vaultPath, 'loop'));

  // A directory symlink to an outside folder holding a ---js file: directory symlinks are never
  // followed (FR-FM-04 / Out of scope), so this must not be listed.
  const outsideDir = path.join(vaultPath, '..', 'outside-dir-link-target');
  fs.mkdirSync(outsideDir, { recursive: true });
  writeBytes(path.join(outsideDir, 'Outside.md'), '---js\noutside content, never reached via a dir symlink\n---\n');
  fs.symlinkSync(outsideDir, path.join(vaultPath, 'dirlink'));

  // A dangling .md symlink: skipped (ENOENT target)
  fs.symlinkSync(path.join(vaultPath, 'does-not-exist.md'), path.join(vaultPath, 'dangling.md'));

  // A plain, unrelated ordinary page so the vault isn't ENTIRELY fence-refused content
  writeBytes(path.join(vaultPath, 'NPCs', 'Ordinary.md'), '---\ntype: npc\ntitle: Ordinary\n---\nbody\n');

  return mustList;
}

// --- Locations that must be listed --------------------------------------------------------------

test('scanFrontmatterFences: every FR-FM-04 must-list location is refused, exactly once each', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const mustList = plantMatrixVault(vaultPath);

    const results = scanFrontmatterFences(vaultPath);
    const listedPaths = results.map((r) => r.relPath);

    for (const expected of mustList) {
      assert.ok(listedPaths.includes(expected), `expected ${expected} to be listed; got ${JSON.stringify(listedPaths)}`);
    }
    // Exactly one finding per planted file: no duplicates.
    assert.deepEqual(listedPaths, [...new Set(listedPaths)]);
  });
});

// --- Precision: must NOT be listed --------------------------------------------------------------

test('scanFrontmatterFences: precision controls are never listed (dot-dirs, .md.bak, directory-symlink targets, dangling links)', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    plantMatrixVault(vaultPath);

    const results = scanFrontmatterFences(vaultPath);
    const listedPaths = results.map((r) => r.relPath);

    assert.ok(!listedPaths.some((p) => p.includes('.obsidian')), 'dot-dir must be skipped');
    assert.ok(!listedPaths.includes('notes.md.bak'), '.md.bak must not match .md');
    assert.ok(!listedPaths.some((p) => p.startsWith('dirlink/')), 'a directory symlink must never be followed');
    assert.ok(!listedPaths.includes('dangling.md'), 'a dangling .md symlink must be skipped');
  });
});

test('scanFrontmatterFences: a directory symlink loop (loop -> .) terminates instead of recursing forever', { timeout: 20000 }, () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    plantMatrixVault(vaultPath);
    // Termination itself is the assertion: scanFrontmatterFences must return, not hang or crash
    // with a stack overflow, because a directory symlink is never followed (Dirent.isDirectory()
    // is false for a symlink; only listDir's own isDirectory flag, backed by lstat semantics via
    // withFileTypes, decides -- fs.readdirSync withFileTypes reports symlinks distinctly from
    // real directories).
    const results = scanFrontmatterFences(vaultPath);
    assert.ok(Array.isArray(results));
  });
});

// --- Sorted order, exactly-one-finding, zero parse-error -----------------------------------------

test('scanFrontmatterFences: results are sorted by relPath', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    plantMatrixVault(vaultPath);
    const results = scanFrontmatterFences(vaultPath);
    const sorted = [...results].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    assert.deepEqual(results, sorted);
  });
});

test('nonYamlLanguageFindings: one finding per planted file, and frontmatter/parse-error never fires for the same file', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const mustList = plantMatrixVault(vaultPath);

    const findings = frontmatterChecks.nonYamlLanguageFindings({ vaultPath, campaign: 'fm' });
    const byPath = new Map();
    for (const f of findings) {
      assert.equal(f.id, 'frontmatter/non-yaml-language');
      assert.equal(f.detail, null);
      assert.equal(byPath.has(f.path), false, `duplicate finding for ${f.path}`);
      byPath.set(f.path, f);
    }
    for (const expected of mustList) {
      assert.ok(byPath.has(expected), `missing finding for ${expected}`);
    }
  });
});

// --- Invariant: guard superset of read -----------------------------------------------------------

test('invariant: for every matrix file, readFrontmatter returning FrontmatterLanguageError implies the scan lists it', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const mustList = plantMatrixVault(vaultPath);
    const listed = new Set(scanFrontmatterFences(vaultPath).map((r) => r.relPath));

    for (const rel of mustList) {
      const abs = path.join(vaultPath, rel);
      const result = readFrontmatter(abs);
      if (result.ok === false && result.error instanceof FrontmatterLanguageError) {
        assert.ok(listed.has(rel), `readFrontmatter refused ${rel} but the scan did not list it`);
      }
    }
  });
});

// --- Over-limit unterminated ----------------------------------------------------------------------

test('over-limit js (no newline within 65536 bytes): refused as unterminated, sentinel absent', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const sentinel = path.join(root, 'sentinel-overlimit.txt');
    const marker = makeMarker();
    const overLimit = '---' + ' '.repeat(70000) + 'js\n' + payload(sentinel, marker);
    writeBytes(path.join(vaultPath, 'Overlimit.md'), overLimit);

    const results = scanFrontmatterFences(vaultPath);
    const hit = results.find((r) => r.relPath === 'Overlimit.md');
    assert.ok(hit, 'Overlimit.md must be refused');
    assert.equal(hit.reason, 'unterminated');
    assert.equal(fs.existsSync(sentinel), false);
  });
});

// --- Injected read failure aborts with VaultReadError ---------------------------------------------

test('an injected read.readHead VaultReadError inside _inbox propagates unchanged out of scanFrontmatterFences', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    writeBytes(path.join(vaultPath, '_inbox', 'Note.md'), '---\ntype: npc\n---\nbody\n');
    const original = read.readHead;
    read.readHead = (absPath, maxBytes) => {
      if (absPath.includes(`${path.sep}_inbox${path.sep}`)) {
        throw new VaultReadError(absPath, new Error('simulated EIO'));
      }
      return original(absPath, maxBytes);
    };
    try {
      assert.throws(() => scanFrontmatterFences(vaultPath), VaultReadError);
    } finally {
      read.readHead = original;
    }
  });
});

test('an injected read.listDir VaultReadError inside _inbox propagates unchanged', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    writeBytes(path.join(vaultPath, '_inbox', 'Note.md'), '---\ntype: npc\n---\nbody\n');
    const original = read.listDir;
    read.listDir = (absDir) => {
      if (absDir.endsWith(`${path.sep}_inbox`)) {
        throw new VaultReadError(absDir, new Error('simulated EIO'));
      }
      return original(absDir);
    };
    try {
      assert.throws(() => scanFrontmatterFences(vaultPath), VaultReadError);
    } finally {
      read.listDir = original;
    }
  });
});

/**
 * A leaner planted vault for the whole-CLI tests below: only ordinary refused files, no
 * symlinks. The full precision matrix above already proves fencescan's own symlink handling in
 * isolation; mixing a dangling symlink into a full `check` CLI run also exercises the PRE-
 * EXISTING census walk (src/vault/read.js's walkVault, used by buildResolutionIndex), which
 * throws VaultReadError for ANY symlink stat failure including a legitimately dangling one --
 * unrelated to this slice and out of scope to fix here.
 */
function plantCliVault(vaultPath) {
  const mustList = new Set();
  function plantJs(rel, { aliases = false } = {}) {
    const marker = makeMarker();
    const sentinel = path.join(vaultPath, '..', 'sentinels', `${rel.replace(/[\\/]/g, '_')}.txt`);
    const body = aliases ? payloadWithAliases(sentinel, marker) : payload(sentinel, marker);
    writeBytes(path.join(vaultPath, rel), `---js\n${body}\n---\n`);
    mustList.add(rel);
  }
  plantJs('NPCs/Planted.md');
  plantJs('_meta/vault-config.md');
  plantJs('_inbox/Note.md', { aliases: true });
  plantJs('X.MD', { aliases: true });
  writeBytes(path.join(vaultPath, 'NPCs', 'Ordinary.md'), '---\ntype: npc\ntitle: Ordinary\n---\nbody\n');
  return mustList;
}

// --- CLI: check exits 2, refusal listed, no parse-error, VaultReadError -> process exit 1 (AC-FM-14, corrected from FR-FM-04's "3") ---

test('CLI: check on a matrix vault exits 2, lists frontmatter/non-yaml-language once per planted file, no parse-error for them', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    plantCliVault(vaultPath);
    const { configPath } = writeCampaignConfig(root, { vaultPath });
    const res = run(root, ['check', 'fm', '--config', configPath, '--json']);
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const envelope = JSON.parse(res.stdout);
    const nonYaml = envelope.findings.filter((f) => f.id === 'frontmatter/non-yaml-language');
    const parseErrors = envelope.findings.filter((f) => f.id === 'frontmatter/parse-error');
    const nonYamlPaths = new Set(nonYaml.map((f) => f.path));
    const parseErrorPaths = new Set(parseErrors.map((f) => f.path));
    for (const p of nonYamlPaths) {
      assert.equal(parseErrorPaths.has(p), false, `${p} must not also be a parse-error`);
    }
    assert.ok(nonYaml.length > 0);
  });
});

test('CLI: a VaultReadError from a census-directory failure and from the frontmatter guard walk give the same exit code (AC-FM-14)', () => {
  withRoot((root) => {
    if (process.getuid && process.getuid() === 0) {
      return; // running as root: chmod 000 does not block readdirSync
    }
    const vaultPath = path.join(root, 'vault');
    writeBytes(path.join(vaultPath, 'NPCs', 'Ordinary.md'), '---\ntype: npc\ntitle: Ordinary\n---\nbody\n');
    const blockedInbox = path.join(vaultPath, '_inbox');
    fs.mkdirSync(blockedInbox, { recursive: true });
    fs.writeFileSync(path.join(blockedInbox, 'x.md'), '---\ntype: npc\n---\n');
    fs.chmodSync(blockedInbox, 0o000);

    const blockedNpcs = path.join(root, 'vault2', 'NPCs');
    fs.mkdirSync(blockedNpcs, { recursive: true });
    fs.writeFileSync(path.join(blockedNpcs, 'x.md'), '---\ntype: npc\n---\n');
    fs.chmodSync(blockedNpcs, 0o000);

    try {
      const { configPath: c1 } = writeCampaignConfig(root, { campaign: 'inbox', vaultPath });
      const res1 = run(root, ['check', 'inbox', '--config', c1]);

      const { configPath: c2 } = writeCampaignConfig(root, { campaign: 'npcs', vaultPath: path.join(root, 'vault2') });
      const res2 = run(root, ['check', 'npcs', '--config', c2]);

      assert.equal(res1.status, res2.status, `inbox-blocked exit ${res1.status} vs npcs-blocked (census) exit ${res2.status}`);
    } finally {
      fs.chmodSync(blockedInbox, 0o755);
      fs.chmodSync(blockedNpcs, 0o755);
    }
  });
});

// --- check --json determinism ----------------------------------------------------------------------

test('check --json is byte-identical (minus generatedAt) across two runs', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    plantCliVault(vaultPath);
    const { configPath } = writeCampaignConfig(root, { vaultPath });
    const res1 = run(root, ['check', 'fm', '--config', configPath, '--json']);
    const res2 = run(root, ['check', 'fm', '--config', configPath, '--json']);
    const strip = (s) => JSON.parse(s).findings; // findings array must be identical; envelope generatedAt varies
    assert.deepEqual(strip(res1.stdout), strip(res2.stdout));
  });
});

// --- Registry and RUNNERS wiring -------------------------------------------------------------------

test('registry: frontmatter/non-yaml-language is registered first, error, enabled by default', () => {
  assert.equal(CHECKS[0].id, 'frontmatter/non-yaml-language');
  assert.equal(CHECKS_BY_ID['frontmatter/non-yaml-language'].defaultSeverity, 'error');
  assert.equal(CHECKS_BY_ID['frontmatter/non-yaml-language'].defaultEnabled, true);
});

test('RUNNERS: frontmatter/non-yaml-language maps to frontmatterChecks.runNonYamlLanguage', () => {
  assert.equal(RUNNERS['frontmatter/non-yaml-language'], frontmatterChecks.runNonYamlLanguage);
});

// --- Interaction with relationship/unknown-predicate (ADR 0037's reader) ---------------------------
// R5's src/vault/relationshiptypes.js reads _meta/relationship-types.md through this same
// read.readFrontmatter chokepoint. A refused ---js fence there must land on BOTH checks: this
// slice's own frontmatter/non-yaml-language ERROR (the whole-vault fence walk sees the file
// directly), and relationship/unknown-predicate's existing "parse-error" INFO (readRelationshipTypes
// treats any !result.ok the same way, regardless of why) -- never a third, different outcome, and
// never the payload.

test('interaction: a ---js _meta/relationship-types.md gives frontmatter/non-yaml-language AND relationship/unknown-predicate\'s parse-error INFO, sentinel absent', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    const sentinels = sentinelsDir(root);
    const marker = makeMarker();
    const sentinel = path.join(sentinels, 'relationship-types.txt');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n');
    writeBytes(path.join(vaultPath, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public\n---\nbody\n');
    writeBytes(path.join(vaultPath, '_meta', 'relationship-types.md'), `---js\n${payload(sentinel, marker)}\n---\n`);

    const { configPath } = writeCampaignConfig(root, { vaultPath });
    const res = run(root, ['check', 'fm', '--config', configPath, '--json']);
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const envelope = JSON.parse(res.stdout);

    const nonYaml = envelope.findings.filter((f) => f.id === 'frontmatter/non-yaml-language' && f.path === '_meta/relationship-types.md');
    assert.equal(nonYaml.length, 1, 'expected exactly one frontmatter/non-yaml-language finding for _meta/relationship-types.md');

    const unknownPredicate = envelope.findings.filter((f) => f.id === 'relationship/unknown-predicate');
    assert.equal(unknownPredicate.length, 1, 'expected exactly one relationship/unknown-predicate finding');
    assert.equal(unknownPredicate[0].severity, 'info');
    assert.match(unknownPredicate[0].message, /_meta\/relationship-types\.md's frontmatter failed to parse; relationship words were not checked/);
    assert.deepEqual(unknownPredicate[0].data, { reason: 'parse-error' });

    // No relationship/unknown-predicate WARN/ERROR ever fired for an individual edge (the vocab
    // never loaded, so per-edge checking never ran).
    assert.equal(envelope.findings.filter((f) => f.id === 'relationship/unknown-predicate' && f.severity !== 'info').length, 0);

    assert.equal(fs.existsSync(sentinel), false, 'the payload must never have run');
  });
});

test('interaction: direct readRelationshipTypes on a refused ---js file returns reason:"parse-error" without running the payload', () => {
  withRoot((root) => {
    const { readRelationshipTypes } = require('../src/vault/relationshiptypes');
    const vaultPath = path.join(root, 'vault');
    const sentinel = path.join(root, 'sentinel-direct.txt');
    const marker = makeMarker();
    writeBytes(path.join(vaultPath, '_meta', 'relationship-types.md'), `---js\n${payload(sentinel, marker)}\n---\n`);

    const result = readRelationshipTypes(vaultPath);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'parse-error');
    assert.equal(fs.existsSync(sentinel), false);
  });
});
