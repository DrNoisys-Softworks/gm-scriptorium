'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');

/*
 * Issue #105: `config add x --vault` (flag with no value) wrote `vault = true`, which made every
 * later command refuse to load the config, and `config remove x` could not repair it either. The
 * flag with no value is now a usage error that writes nothing; `config remove` can load a config
 * with a malformed entry; and the loader names the bad entry and the fix.
 */

const cfgPath = (root) => path.join(root, 'config.toml');

const GOOD = `config_version = 1\ndefault_campaign = "good"\n\n[campaigns.good]\nvault = '${SAMPLE}'\noutput = '/tmp/b4-good-site'\n`;

test('B4-105-1: a value flag with no value is a usage error naming the flag, and writes nothing', () => {
  const cases = {
    '--vault': ['config', 'add', 'x', '--vault'],
    '--out': ['config', 'add', 'x', '--vault', SAMPLE, '--out'],
    '--site-config': ['config', 'add', 'x', '--vault', SAMPLE, '--out', '/tmp/b4-x', '--site-config'],
  };
  for (const [flag, args] of Object.entries(cases)) {
    withScratch((root) => {
      const res = run(root, args);
      assert.equal(res.code, 1, `${flag}: ${res.all}`);
      assert.match(res.err, new RegExp(`${flag} needs a value`));
      assert.equal(fs.existsSync(cfgPath(root)), false, `${flag}: config must not be created`);
    });
  }
});

test('B4-105-2: a failed config add leaves an existing config byte-for-byte unchanged', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), GOOD);
    const res = run(root, ['config', 'add', 'x', '--vault']);
    assert.equal(res.code, 1);
    assert.equal(fs.readFileSync(cfgPath(root), 'utf8'), GOOD);
  });
});

test('B4-105-3: the loader names the bad entry, the problem and the fix', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), `${GOOD}\n[campaigns.x]\nvault = true\n`);
    const res = run(root, ['config', 'list']);
    assert.equal(res.code, 3); // #108: a malformed config is a config problem, exit 3
    assert.match(res.err, /campaigns\.x: "vault" must be a string/);
    assert.match(res.err, /gm-scriptorium config remove x/);
  });
});

test('B4-105-4: config remove deletes a malformed entry; the rest of the config survives and loads again', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), `${GOOD}\n[campaigns.x]\nvault = true\n`);
    const rm = run(root, ['config', 'remove', 'x']);
    assert.equal(rm.code, 0, rm.all);
    const text = fs.readFileSync(cfgPath(root), 'utf8');
    assert.doesNotMatch(text, /campaigns\.x/);
    assert.match(text, /\[campaigns\.good\]/);
    const list = run(root, ['config', 'list']);
    assert.equal(list.code, 0, list.all);
    assert.match(list.out, /^good \[default\]: vault=/);
  });
});

test('B4-105-5: config remove clears a default_campaign that pointed at the malformed entry', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), `config_version = 1\ndefault_campaign = "x"\n\n[campaigns.x]\nvault = 5\n`);
    assert.equal(run(root, ['config', 'remove', 'x']).code, 0);
    assert.doesNotMatch(fs.readFileSync(cfgPath(root), 'utf8'), /default_campaign/);
    assert.equal(run(root, ['config', 'list']).code, 0);
  });
});

test('B4-105-6: config remove of a name that is not there still fails, and other commands still refuse a bad entry', () => {
  withScratch((root) => {
    fs.writeFileSync(cfgPath(root), `${GOOD}\n[campaigns.x]\nvault = true\n`);
    const rm = run(root, ['config', 'remove', 'nope']);
    assert.equal(rm.code, 3); // #108: an unknown campaign name is a campaign problem, exit 3
    assert.match(rm.err, /no campaign named "nope" to remove/);
    assert.equal(run(root, ['config', 'set-default', 'good']).code, 3);
    assert.equal(run(root, ['status', 'good']).code, 3);
  });
});
