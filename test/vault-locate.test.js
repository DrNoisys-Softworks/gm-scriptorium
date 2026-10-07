'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { locateVault } = require('../src/vault/locate');
const { VaultUnreachableError } = require('../src/util/errors');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');

test('locateVault succeeds for a real vault', () => {
  const result = locateVault(MINI_VAULT, 'fixture');
  assert.equal(result.vaultPath, MINI_VAULT);
});

test('locateVault reports "not-found" for a missing path, distinct from "not-a-vault"', () => {
  try {
    locateVault('/this/path/does/not/exist/anywhere', 'fixture');
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(err instanceof VaultUnreachableError);
    assert.equal(err.reason, 'not-found');
    assert.match(err.message, /does not exist/);
  }
});

test('locateVault reports "not-a-vault" for an existing directory with no _meta/vault-config.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-locate-'));
  try {
    locateVault(dir, 'fixture');
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(err instanceof VaultUnreachableError);
    assert.equal(err.reason, 'not-a-vault');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('locateVault never requires the vault to be writable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-locate-ro-'));
  try {
    fs.mkdirSync(path.join(dir, '_meta'));
    fs.writeFileSync(path.join(dir, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
    fs.chmodSync(dir, 0o555);
    assert.doesNotThrow(() => locateVault(dir, 'fixture'));
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
