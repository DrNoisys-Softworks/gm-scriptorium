'use strict';

/*
 * The carry starts no program. The pin's move code can ask "which publish tool does this site
 * folder use?" by running its own command with process.execPath. In the packaged executable that
 * path is GM-Scriptorium itself, so it must never run. The facade hands the pin an answer
 * (deps.pinCheck, always "nothing to say"), so the question is never asked
 * (docs/decisions/0005-generator-pin.md, 1.26.0 addendum).
 *
 * The probe stubs every program starter before the carry loads, then plans and applies a real carry
 * on a moved vault whose pack holds `host`, one of the site-folder keys (the case that makes the pin ask).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { withScratch, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');

const PROBE = path.join(__dirname, 'helpers', 'carry-no-spawn-probe.js');

test('planning and applying a carry on a moved vault starts no program', () => {
  withScratch((root) => {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    const packFile = path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json');
    const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
    assert.equal(pack.host, 'github-pages', 'the pack must hold a site-folder key (host), or the pin never asks about the tool');
    pack.excludeSections.push('Pack Only Secret');
    fs.writeFileSync(packFile, JSON.stringify(pack, null, 2));
    const res = spawnSync(process.execPath, [PROBE, vaultPath, root], { encoding: 'utf8', timeout: 60000 });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(out.state, 'ready');
    assert.equal(out.applied, true);
    assert.deepEqual(out.started, []);
    assert.ok(fs.readFileSync(path.join(vaultPath, '_meta', 'vault-config.yaml'), 'utf8').includes('Pack Only Secret'));
  });
});

test('control: the probe does catch a program start (the pin run without the facade answer)', () => {
  withScratch((root) => {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    const probe = path.join(root, 'control.js');
    fs.writeFileSync(
      probe,
      [
        "const cp = require('child_process');",
        "cp.spawnSync = () => { throw new Error('a program was started'); };",
        // Load the facade first (it seeds what the pin's tree needs), then the pin's move directly.
        `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'generator', 'pinned'))});`,
        `const { planMove } = require(${JSON.stringify(path.join(__dirname, '..', 'node_modules', 'gm-apprentice-publish', 'lib', 'settings', 'move'))});`,
        `const site = ${JSON.stringify(path.join(root, 'site', 'vault.config.json'))};`,
        "require('fs').mkdirSync(require('path').dirname(site), { recursive: true });",
        `require('fs').writeFileSync(site, JSON.stringify({ host: 'github-pages', vaultPath: ${JSON.stringify(vaultPath)} }));`,
        `planMove({ vaultPath: ${JSON.stringify(vaultPath)}, siteConfigPath: site, foldSiteFile: true });`,
      ].join('\n'),
    );
    const res = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 60000, cwd: path.join(__dirname, '..') });
    assert.notEqual(res.status, 0, 'the pin must try to start a program when it is not given an answer');
    assert.match(res.stderr, /a program was started/);
  });
});
