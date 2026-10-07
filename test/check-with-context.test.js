'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCampaignContext } = require('../src/cli/args');
const { runCheckForContext, runCheckForContextWithContext } = require('../src/cli/check');

/*
 * V1e-9 (SD-91). runCheckForContext's body becomes runCheckForContextWithContext, which also
 * returns checkCtx (so src/admin/candidatecheck.js can read checkCtx.publishSet after a real
 * check run); runCheckForContext itself stays behaviour-identical. test/fixtures/vocab-vault is
 * copied to scratch first, never read or written in place (NFR-10/NFR-11).
 */

const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

function withVocabVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1e9-check-with-context-'));
  try {
    const vaultPath = path.join(root, 'vocab-vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "vocab"', '', '[campaigns.vocab]', `vault = '${vaultPath}'`, `output = '${root}/out'`, ''].join('\n'),
    );
    return fn({ vaultPath, configPath });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('runCheckForContext returns exactly the keys envelope, exitCode, human', () => {
  withVocabVault(({ configPath }) => {
    const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
    const result = runCheckForContext(ctxInfo, {}, {});
    assert.deepEqual(Object.keys(result).sort(), ['envelope', 'exitCode', 'human']);
  });
});

test('runCheckForContextWithContext returns the same envelope.findings as runCheckForContext, plus checkCtx', () => {
  withVocabVault(({ configPath }) => {
    const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
    const a = runCheckForContext(ctxInfo, {}, {});
    const b = runCheckForContextWithContext(ctxInfo, {}, {});
    assert.deepEqual(b.envelope.findings, a.envelope.findings);
    assert.equal(b.exitCode, a.exitCode);
    assert.equal(b.human, a.human);
    assert.deepEqual(Object.keys(b).sort(), ['checkCtx', 'envelope', 'exitCode', 'human']);
  });
});

test('runCheckForContextWithContext.checkCtx.publishSet exists and carries publishedPages', () => {
  withVocabVault(({ configPath }) => {
    const ctxInfo = resolveCampaignContext({ config: configPath }, 'vocab');
    const result = runCheckForContextWithContext(ctxInfo, {}, {});
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'checkCtx'), 'expected a checkCtx key');
    assert.ok(result.checkCtx && result.checkCtx.publishSet, 'expected checkCtx.publishSet');
    assert.ok(Array.isArray(result.checkCtx.publishSet.publishedPages));
  });
});
