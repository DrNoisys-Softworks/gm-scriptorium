'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUnresolved, runInCode } = require('../src/checks/link');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * #77: check reports wikilinks inside inline code spans / fenced code
 * blocks as link/unresolved ERRORs. Integration-level tests against
 * runUnresolved() itself (test/vault-links.test.js covers the masking
 * primitive it delegates to), using a hand-built ctx so these are isolated
 * from vault-fixture/config machinery that runUnresolved never touches.
 */

function ctxWith(raw, resolvedTargets = []) {
  const resolvedSet = new Set(resolvedTargets.map((t) => t.toLowerCase()));
  return {
    campaign: 'fixture',
    index: {
      files: [{ ok: true, relPath: 'Notes/Example.md', raw }],
      resolves: (target) => resolvedSet.has(String(target).trim().toLowerCase()),
    },
  };
}

test('runUnresolved: a documented wikilink inside a code span does not fire, even though its target does not resolve', () => {
  const raw = 'Pin syntax: `marker: default, down%, across%, [[Nonexistent]], label`\n';
  const findings = runUnresolved(ctxWith(raw));
  assert.deepEqual(findings, []);
});

test('runUnresolved: a real unresolved wikilink in prose still fires', () => {
  const raw = 'See [[Nonexistent]] for detail.\n';
  const findings = runUnresolved(ctxWith(raw));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'link/unresolved');
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /\[\[Nonexistent\]\] does not resolve/);
});

test('runUnresolved: an unresolved wikilink inside a fenced code block does not fire', () => {
  const raw = 'Example vault layout:\n```\n[[Nonexistent]]\n```\n';
  const findings = runUnresolved(ctxWith(raw));
  assert.deepEqual(findings, []);
});

test('runUnresolved: a real link on the same line as a code span still fires; the code-span occurrence does not', () => {
  const raw = 'Code `x = 1` and a real [[Nonexistent]] link, e.g. `[[InCode]]`.\n';
  const findings = runUnresolved(ctxWith(raw));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].message.includes('[[Nonexistent]]'), true);
});

test('runUnresolved: an unterminated backtick does not suppress the real link that follows it on the same line (fail closed)', () => {
  const raw = 'A stray ` backtick and then [[Nonexistent]].\n';
  const findings = runUnresolved(ctxWith(raw));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
});

test('runUnresolved: a resolved target inside a code span still resolves (no finding either way)', () => {
  const raw = 'Example: `[[Real]]`.\n';
  const findings = runUnresolved(ctxWith(raw, ['Real']));
  assert.deepEqual(findings, []);
});

test('runUnresolved: a file that fails to parse (f.ok === false) is skipped entirely, unchanged by #77', () => {
  const ctx = {
    campaign: 'fixture',
    index: {
      files: [{ ok: false, relPath: 'Notes/Broken.md', raw: '[[Nonexistent]]' }],
      resolves: () => false,
    },
  };
  assert.deepEqual(runUnresolved(ctx), []);
});

/*
 * #77 follow-up (Orchestrator decision, narrowed a second time): link/in-code
 * reports INFO for a wikilink found only inside code AND whose target does
 * NOT resolve — the exact cases that used to be link/unresolved ERRORs. A
 * resolving in-code link (Leaflet marker/image syntax, a GM changelog
 * quoting an old value) stays silent: the first cut fired for every in-code
 * wikilink regardless of resolution, which was 42 findings for 2 genuine
 * signals on the real vault. runUnresolved()'s tests above prove the 2
 * genuine signals no longer fire as ERROR; these prove they surface as
 * their own, non-blocking finding, and that the 40 resolving ones do not.
 */

test('runInCode: an UNRESOLVED wikilink inside a single-backtick span fires INFO, with the right id/message/target (positive control)', () => {
  const raw = 'Pin syntax: `marker: default, down%, across%, [[Nonexistent]], label`\n';
  const findings = runInCode(ctxWith(raw));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'link/in-code');
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].category, 'link');
  assert.match(findings[0].message, /\[\[Nonexistent\]\] does not resolve/);
  assert.match(findings[0].message, /would not render as a link either way/);
  assert.equal(findings[0].line, 1);
});

test('runInCode: an UNRESOLVED wikilink inside a fenced code block fires INFO (positive control)', () => {
  const raw = 'Example vault layout:\n```\n[[Nonexistent]]\n```\n';
  const findings = runInCode(ctxWith(raw));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'link/in-code');
  assert.equal(findings[0].line, 3);
});

test('runInCode: a real (prose) wikilink does not fire, even when unresolved', () => {
  const raw = 'See [[Nonexistent]] for detail.\n';
  assert.deepEqual(runInCode(ctxWith(raw)), []);
});

test('runInCode: stays SILENT when the in-code target actually resolves (Leaflet marker/image, a GM changelog quoting an old value, ...)', () => {
  const raw = 'Example: `[[Real]]`.\n';
  assert.deepEqual(runInCode(ctxWith(raw, ['Real'])), []);
});

test('runInCode: a real link on the same line as a code span fires only for the in-code occurrence, and only because it is unresolved', () => {
  const raw = 'Code `x = 1` and a real [[Nonexistent]] link, e.g. `[[InCode]]`.\n';
  const findings = runInCode(ctxWith(raw));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].message.includes('[[InCode]]'), true);
});

test('runInCode: the same in-code position with a RESOLVING target is silent (mirrors the test above, target flipped)', () => {
  const raw = 'Code `x = 1` and a real [[Nonexistent]] link, e.g. `[[InCode]]`.\n';
  assert.deepEqual(runInCode(ctxWith(raw, ['InCode'])), []);
});

test('runInCode: an unterminated backtick produces no in-code finding (fail closed, matches runUnresolved)', () => {
  const raw = 'A stray ` backtick and then [[Nonexistent]].\n';
  assert.deepEqual(runInCode(ctxWith(raw)), []);
});

test('runInCode: a file that fails to parse (f.ok === false) is skipped entirely', () => {
  const ctx = {
    campaign: 'fixture',
    index: {
      files: [{ ok: false, relPath: 'Notes/Broken.md', raw: '`[[Nonexistent]]`' }],
      resolves: () => false,
    },
  };
  assert.deepEqual(runInCode(ctx), []);
});

/*
 * End-to-end, real runCheckCommand: link/in-code is an INFO finding, and
 * INFO never affects check's exit code (src/cli/check.js:
 * `hasError = envelope.counts.error > 0`, only error-severity findings
 * count). A minimal, self-contained scratch vault (not the shared
 * pin-vault/mini-vault fixtures, to avoid perturbing their other tests)
 * with a single published page whose only wikilink lives in a code span.
 */

function withScratchVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-link-in-code-e2e-'));
  try {
    const vaultPath = path.join(dir, 'vault');
    fs.mkdirSync(path.join(vaultPath, 'NPCs'), { recursive: true });
    fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, '_meta', 'vault-config.md'),
      '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n',
    );
    fs.writeFileSync(
      path.join(vaultPath, '_meta', 'publish-manifest.md'),
      '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n',
    );
    fs.writeFileSync(
      path.join(vaultPath, 'NPCs', 'Public.md'),
      '---\ntype: npc\ntitle: Public Page\n---\n' +
        'Pin syntax example, not a real link: `[[Ghost]]`.\n\n' +
        'Leaflet-style reference to a real page, which must stay silent: `[[Real Page]]`.\n',
    );
    fs.writeFileSync(
      path.join(vaultPath, 'NPCs', 'Real Page.md'),
      '---\ntype: npc\ntitle: Real Page\n---\nAn ordinary, resolvable target.\n',
    );

    const siteDir = path.join(vaultPath, '_meta', 'scriptorium');
    fs.mkdirSync(siteDir, { recursive: true });
    fs.writeFileSync(
      path.join(siteDir, 'vault.config.json'),
      JSON.stringify(
        { siteTitle: 'Link In Code E2E', siteUrl: 'https://example.invalid', excludeDirs: [], folderMap: { NPCs: 'npcs' } },
        null,
        2,
      ),
    );

    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        'config_version = 1',
        'default_campaign = "alpha"',
        '',
        '[campaigns.alpha]',
        `vault = '${vaultPath}'`,
        `output = '${path.join(dir, 'out')}'`,
        '',
      ].join('\n'),
    );

    return fn({ configPath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runCheckCommand: an UNRESOLVED wikilink inside a code span produces a link/in-code INFO finding and exit code OK; a RESOLVING one in the same file stays silent', () => {
  const { runCheckCommand } = require('../src/cli/check');
  withScratchVault(({ configPath }) => {
    const result = runCheckCommand({ config: configPath }, 'alpha');

    assert.equal(result.exitCode, EXIT_CODES.OK, `expected OK, findings: ${JSON.stringify(result.envelope.findings)}`);
    assert.equal(result.envelope.counts.error, 0);
    assert.ok(result.envelope.counts.info >= 1);

    const inCodeFindings = result.envelope.findings.filter((f) => f.id === 'link/in-code');
    assert.equal(inCodeFindings.length, 1, 'exactly one: Ghost (unresolved); Real Page (resolves) must stay silent');
    assert.equal(inCodeFindings[0].severity, 'info');
    assert.match(inCodeFindings[0].message, /\[\[Ghost\]\] does not resolve/);
    assert.match(inCodeFindings[0].message, /would not render as a link either way/);
    assert.ok(!inCodeFindings.some((f) => f.message.includes('Real Page')), 'the resolving in-code target must never appear');

    const unresolved = result.envelope.findings.find((f) => f.id === 'link/unresolved');
    assert.equal(unresolved, undefined, 'the code-span occurrence must not ALSO fire link/unresolved (#77)');
  });
});
