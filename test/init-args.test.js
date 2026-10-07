'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

const { parseArgv } = require('../src/cli/args');
const { shouldOfferInit, runInitCommand } = require('../src/cli/init');

test('A1: parseArgv(["init","--yes","alpha"]) gives flags.yes === true and _ equal to ["init","alpha"]', () => {
  const { _: positional, flags } = parseArgv(['init', '--yes', 'alpha']);
  assert.equal(flags.yes, true);
  assert.deepEqual(positional, ['init', 'alpha']);
});

test('A2: shouldOfferInit truth table', () => {
  const base = { positional: [], flags: {}, stdinIsTTY: true, stdoutIsTTY: true, exists: () => false };

  assert.equal(shouldOfferInit(base), true, 'all conditions hold');
  assert.equal(shouldOfferInit({ ...base, positional: ['check'] }), false, 'a positional argument');
  assert.equal(shouldOfferInit({ ...base, flags: { help: true } }), false, '--help');
  assert.equal(shouldOfferInit({ ...base, flags: { version: true } }), false, '--version');
  assert.equal(shouldOfferInit({ ...base, flags: { notices: true } }), false, '--notices');
  assert.equal(shouldOfferInit({ ...base, exists: () => true }), false, 'a config file exists');
  assert.equal(shouldOfferInit({ ...base, stdinIsTTY: false }), false, 'stdin is not a TTY');
  assert.equal(shouldOfferInit({ ...base, stdoutIsTTY: false }), false, 'stdout is not a TTY');
  assert.equal(shouldOfferInit({ ...base, flags: { config: true } }), false, 'flags.config === true');
});

test('A3: up-front refusals give their exact message, print no banner, and never touch a hanging stdin', { timeout: 15000 }, async () => {
  const cases = [
    {
      flags: {},
      positional: ['extra'],
      message: 'init takes no positional argument (got "extra"); use --name <name>',
    },
    { flags: { campaign: 'x' }, positional: [], message: 'init does not accept --campaign' },
    { flags: { 'site-config': 'x' }, positional: [], message: 'init does not accept --site-config' },
    { flags: { json: true }, positional: [], message: 'init does not accept --json' },
    { flags: { name: true }, positional: [], message: '--name needs a value' },
    { flags: { yes: true, name: 'alpha' }, positional: [], message: 'init --yes needs --name <name> and --vault <path>' },
  ];

  for (const { flags, positional, message } of cases) {
    const input = new PassThrough(); // never ended: any prompt would hang, failing on the test timeout
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => {
      written += chunk.toString();
    });

    await assert.rejects(
      () => runInitCommand(flags, positional, { input, output }),
      (err) => err.message === message,
    );
    assert.equal(written, '', `expected no banner for ${JSON.stringify({ flags, positional })}, got: ${JSON.stringify(written)}`);
    input.end();
  }
});
