'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { validateFlags, closestFlag, parseArgv } = require('../src/cli/args');
const { ConfigError } = require('../src/util/errors');

/*
 * Issue #106: an unknown flag used to be ignored, so `build --prot` quietly built and `check --jsno`
 * printed text instead of JSON. Each command now rejects flags it does not accept. The tables below
 * are written by hand from the HELP text and the README, never read back from the code under test.
 */

const GLOBAL = ['campaign', 'config', 'json', 'quiet', 'no-color', 'version', 'help', 'notices', 'vault', 'out', 'site-config'];
const DOCUMENTED = {
  init: ['name', 'vault', 'out', 'title', 'theme', 'yes'],
  check: ['graph', 'json', 'quiet', 'no-color'],
  build: ['no-check', 'force', 'out', 'json'],
  serve: ['build', 'port', 'host', 'admin', 'json'],
  status: ['json'],
  config: ['vault', 'out', 'site-config'],
  update: ['check', 'pre', 'version'],
};

function flagsFor(names) {
  return Object.fromEntries(names.map((n) => [n, 'x']));
}

test('B4-106-1: every documented flag of every command, and every global flag, is accepted', () => {
  for (const [command, names] of Object.entries(DOCUMENTED)) {
    for (const name of [...names, ...GLOBAL]) {
      const flags = { [name]: name === 'version' && command !== 'update' ? true : 'x' };
      if (['graph', 'json', 'quiet', 'no-color', 'help', 'notices', 'yes', 'force', 'no-check', 'build', 'admin', 'check', 'pre'].includes(name)) flags[name] = true;
      assert.doesNotThrow(() => validateFlags(command, flags), `${command} --${name}`);
    }
  }
});

test('B4-106-2: a flag that belongs to a different command is rejected', () => {
  const cases = [['status', 'force'], ['check', 'no-check'], ['build', 'graph'], ['check', 'yes'], ['config', 'port'], ['serve', 'pre'], ['update', 'host'], ['build', 'admin']];
  for (const [command, name] of cases) {
    assert.throws(() => validateFlags(command, { [name]: true }), (e) => e instanceof ConfigError && e.message.startsWith(`unknown flag --${name} for "${command}".`), `${command} --${name}`);
  }
});

test('B4-106-3: closestFlag suggests within 1-2 edits and stays quiet when nothing is close', () => {
  const accepted = ['json', 'graph', 'force', 'no-check', 'port', 'campaign'];
  assert.equal(closestFlag('jsno', accepted), 'json'); // a swap is 2 edits
  assert.equal(closestFlag('prot', accepted), 'port');
  assert.equal(closestFlag('forse', accepted), 'force');
  assert.equal(closestFlag('nocheck', accepted), 'no-check');
  assert.equal(closestFlag('bogus', accepted), null);
  assert.equal(closestFlag('x', accepted), null);
  assert.equal(closestFlag('zzzzzz', accepted), null);
});

test('B4-106-4: --flag=value gets a message that says to use a space', () => {
  assert.throws(
    () => validateFlags('build', parseArgv(['build', '--out=/tmp/x']).flags),
    /unknown flag --out=\/tmp\/x: write the value after a space, as in --out <value>/,
  );
});

test('B4-106-5: a value flag with no value is an error naming it', () => {
  assert.throws(() => validateFlags('build', { out: true }), /--out needs a value/);
  assert.throws(() => validateFlags('serve', { port: true }), /--port needs a value/);
  assert.throws(() => validateFlags('update', { version: true }), /--version needs a value/);
  assert.doesNotThrow(() => validateFlags('check', { version: true })); // the boolean that prints the version
});

test('B4-106-6: end to end, a typo makes the command fail before it does anything', () => {
  withScratch((root) => {
    const out = path.join(root, 'site');
    assert.equal(run(root, ['config', 'add', 'lease', '--vault', SAMPLE, '--out', out]).code, 0);

    const build = run(root, ['build', 'lease', '--prot']);
    assert.equal(build.code, 1);
    assert.match(build.err, /unknown flag --prot for "build"/);
    assert.equal(fs.existsSync(out), false, 'a rejected build must not write the site');

    const forse = run(root, ['build', 'lease', '--forse']);
    assert.match(forse.err, /Did you mean --force\?/);
    assert.equal(fs.existsSync(out), false);

    const check = run(root, ['check', 'lease', '--bogus']);
    assert.equal(check.code, 1);
    assert.match(check.err, /unknown flag --bogus for "check"/);
    assert.doesNotMatch(check.err, /Did you mean/);
    assert.equal(check.out, '');

    const jsno = run(root, ['check', 'lease', '--jsno']);
    assert.equal(jsno.code, 1);
    assert.match(jsno.err, /Did you mean --json\?/);

    const serve = run(root, ['serve', 'lease', '--prot', '0']);
    assert.equal(serve.code, 1);
    assert.match(serve.err, /Did you mean --port\?/);
  });
});

test('B4-106-7: init, config, status and update reject unknown flags too, and nothing is written', () => {
  withScratch((root) => {
    const init = run(root, ['init', '--vault', SAMPLE, '--name', 'z', '--yes', '--yess']);
    assert.equal(init.code, 1);
    assert.match(init.err, /unknown flag --yess for "init"\. Did you mean --yes\?/);
    assert.equal(fs.existsSync(path.join(root, 'config.toml')), false);

    const cfg = run(root, ['config', 'add', 'z', '--vault', SAMPLE, '--out', path.join(root, 'o'), '--sitconfig', 'x']);
    assert.equal(cfg.code, 1);
    assert.match(cfg.err, /unknown flag --sitconfig for "config"/);
    assert.equal(fs.existsSync(path.join(root, 'config.toml')), false);

    assert.match(run(root, ['status', '--jsn']).err, /unknown flag --jsn for "status"\. Did you mean --json\?/);
    assert.match(run(root, ['update', '--chek']).err, /unknown flag --chek for "update"\. Did you mean --check\?/);
  });
});

test('B4-106-8: every flag used in a command example in the README and the examples README is accepted', () => {
  const docs = ['README.md', path.join('docs', 'using.md'), path.join('docs', 'install.md'), path.join('examples', 'README.md')];
  let checked = 0;
  for (const rel of docs) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/gm-scriptorium\s+(init|check|build|serve|status|config|update)\b(.*)$/);
      if (!m) continue;
      const flags = [...m[2].matchAll(/--([a-z][a-z-]*)/g)].map((x) => x[1]);
      for (const name of flags) {
        const value = ['graph', 'json', 'quiet', 'no-color', 'yes', 'force', 'no-check', 'build', 'admin', 'check', 'pre', 'help', 'notices'].includes(name) ? true : 'x';
        assert.doesNotThrow(() => validateFlags(m[1], { [name]: value }), `${rel}: ${m[1]} --${name} in: ${line.trim()}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 4, `expected to find documented flags, found ${checked}`);
});
