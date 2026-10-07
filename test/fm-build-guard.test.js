'use strict';

/*
 * ADR 0034 / FR-FM-06. The build guard: an unforceable, unconditional refusal at the very top of
 * runAtomicBuild, before sweepStaleSiblings, before any write. --force, --no-check, and both
 * together must all still refuse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runAtomicBuild } = require('../src/build/run');
const { mkRoot, sentinelsDir, makeMarker, payload, writeBytes, writeCampaignConfig, run } = require('./fm-harness');

function withRoot(fn) {
  const root = mkRoot();
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sha256Manifest(dir) {
  if (!fs.existsSync(dir)) return null;
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

function siblingDirs(finalOut) {
  const parent = path.dirname(finalOut);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent).filter((e) => /^\.scriptorium-(build|old)-/.test(e));
}

function plantRefusedVault(root) {
  const vaultPath = path.join(root, 'vault');
  const sentinels = sentinelsDir(root);
  const marker = makeMarker();
  const sentinel = path.join(sentinels, 'build-guard.txt');
  writeBytes(path.join(vaultPath, 'NPCs', 'Planted.md'), `---js\n${payload(sentinel, marker)}\n---\n`);
  writeBytes(path.join(vaultPath, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public\n---\nbody\n');
  writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
  writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n');
  return { vaultPath, sentinel };
}

// --- Direct runAtomicBuild ------------------------------------------------------------------------

test('direct runAtomicBuild with force:true still returns refusedByFrontmatter:true', () => {
  withRoot((root) => {
    const { vaultPath, sentinel } = plantRefusedVault(root);
    const siteDir = path.join(root, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(root, 'out');

    const result = runAtomicBuild({
      vaultPath,
      userJsonConfig: { siteTitle: 'X', siteUrl: 'https://example.invalid', vaultPath, outputDir: path.join(root, 'declared-out'), attachmentsDir: '_attachments', folderMap: { NPCs: 'npcs' }, excludeDirs: [] },
      finalOut,
      siteDir,
      campaign: 'fm',
      force: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.refusedByFrontmatter, true);
    assert.ok(result.findings.some((f) => f.path === 'NPCs/Planted.md'));
    assert.equal(result.stagingRoot, null);
    assert.equal(fs.existsSync(sentinel), false);
  });
});

test('a pre-existing finalOut and a stale sibling are left completely untouched -- proves nothing ran before the guard', () => {
  withRoot((root) => {
    const { vaultPath } = plantRefusedVault(root);
    const siteDir = path.join(root, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(root, 'out');
    fs.mkdirSync(finalOut, { recursive: true });
    fs.writeFileSync(path.join(finalOut, 'index.html'), 'pre-existing site');
    const staleSibling = path.join(root, '.scriptorium-build-stale');
    fs.mkdirSync(staleSibling, { recursive: true });
    fs.writeFileSync(path.join(staleSibling, 'marker.txt'), 'stale');

    const before = sha256Manifest(finalOut);
    const result = runAtomicBuild({
      vaultPath,
      userJsonConfig: { siteTitle: 'X', siteUrl: 'https://example.invalid', vaultPath, outputDir: path.join(root, 'declared-out'), attachmentsDir: '_attachments', folderMap: { NPCs: 'npcs' }, excludeDirs: [] },
      finalOut,
      siteDir,
      campaign: 'fm',
    });

    assert.equal(result.refusedByFrontmatter, true);
    assert.equal(sha256Manifest(finalOut), before, 'finalOut must be byte-unchanged');
    assert.ok(fs.existsSync(staleSibling), 'the stale sibling must still exist -- sweepStaleSiblings never ran');
    assert.ok(fs.existsSync(path.join(staleSibling, 'marker.txt')));
    const siblingsAfter = siblingDirs(finalOut).filter((s) => s !== '.scriptorium-build-stale');
    assert.deepEqual(siblingsAfter, [], `no NEW .scriptorium-(build|old)- sibling may appear; found ${JSON.stringify(siblingsAfter)}`);
  });
});

// --- CLI spawn: build, --force, --no-check, --force --no-check -------------------------------------

const FLAG_SETS = [[], ['--force'], ['--no-check'], ['--force', '--no-check']];

for (const flags of FLAG_SETS) {
  test(`CLI: build ${flags.join(' ') || '(no flags)'} on a refused vault exits 2 with refused:true`, () => {
    withRoot((root) => {
      const { vaultPath, sentinel } = plantRefusedVault(root);
      const { configPath } = writeCampaignConfig(root, { vaultPath });
      const res = run(root, ['build', 'fm', '--config', configPath, '--json', ...flags]);
      assert.equal(res.status, 2, res.stdout + res.stderr);
      const envelope = JSON.parse(res.stdout);
      assert.equal(envelope.refused, true);
      assert.equal(fs.existsSync(sentinel), false);

      if (flags.length > 0) {
        assert.equal(envelope.refusedByFrontmatter, true);
        assert.ok(Array.isArray(envelope.frontmatterFindings));
        assert.ok(envelope.frontmatterFindings.some((f) => f.path === 'NPCs/Planted.md'));
        assert.deepEqual(envelope.overriddenFindings, []);
      }
    });
  });
}

test('CLI human output: "neither --force nor --no-check overrides this" appears, and no OVERRIDDEN frontmatter/non-yaml-language line ever does', () => {
  withRoot((root) => {
    const { vaultPath } = plantRefusedVault(root);
    const { configPath } = writeCampaignConfig(root, { vaultPath });
    for (const flags of [['--force'], ['--no-check'], ['--force', '--no-check']]) {
      const res = run(root, ['build', 'fm', '--config', configPath, ...flags]);
      assert.equal(res.status, 2);
      assert.match(res.stdout, /neither --force nor --no-check overrides this/);
      assert.doesNotMatch(res.stdout, /OVERRIDDEN frontmatter\/non-yaml-language/);
    }
  });
});

test('CLI: a tag-free vault building with --force has byte-identical output to before this slice (no frontmatter lines at all)', () => {
  withRoot((root) => {
    const vaultPath = path.join(root, 'vault');
    writeBytes(path.join(vaultPath, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public\n---\nbody\n');
    writeBytes(path.join(vaultPath, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n\n# vault config\n');
    writeBytes(path.join(vaultPath, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n');
    const { configPath } = writeCampaignConfig(root, { vaultPath });
    const res = run(root, ['build', 'fm', '--config', configPath, '--force']);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /non-yaml-language/);
    assert.doesNotMatch(res.stdout, /frontmatter declares/);
  });
});

// --- Structural ------------------------------------------------------------------------------------

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

test('structural: runGeneratorBuild( is called exactly once across src, bin and scripts, in src/build/run.js', () => {
  const root = path.join(__dirname, '..');
  const files = [
    ...walkJs(path.join(root, 'src')),
    ...fs.readdirSync(path.join(root, 'bin')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'bin', f)),
    ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'scripts', f)),
  ];
  const hits = [];
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    // exclude the definition itself ("function runGeneratorBuild(")
    const re = /(?<!function\s)runGeneratorBuild\(/g;
    const matches = text.match(re) || [];
    for (const m of matches) hits.push(path.relative(root, file));
  }
  assert.deepEqual(hits, ['src/build/run.js']);
});

test('structural: in run.js, nonYamlLanguageFindings( occurs exactly once, before sweepStaleSiblings(, which is before runGeneratorBuild(', () => {
  const text = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'build', 'run.js'), 'utf8'));
  const matches = text.match(/nonYamlLanguageFindings\(/g) || [];
  assert.equal(matches.length, 1);

  const fenceIdx = text.indexOf('nonYamlLanguageFindings(');
  const sweepIdx = text.indexOf('sweepStaleSiblings(');
  const genIdx = text.indexOf('runGeneratorBuild(');
  assert.ok(fenceIdx < sweepIdx, 'nonYamlLanguageFindings( must appear before sweepStaleSiblings(');
  assert.ok(sweepIdx < genIdx, 'sweepStaleSiblings( must appear before runGeneratorBuild(');
});

test('structural: the frontmatter guard is never inside an if() mentioning force', () => {
  const text = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'build', 'run.js'), 'utf8'));
  assert.doesNotMatch(
    text,
    /if\s*\([^)]*force[^)]*\)\s*\{[^}]*nonYamlLanguageFindings\(/s,
    'nonYamlLanguageFindings must never be called from inside an if() whose condition mentions force',
  );
});
