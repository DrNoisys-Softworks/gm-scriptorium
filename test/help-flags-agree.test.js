'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMAND_FLAGS, COMMON_FLAGS, parseArgv, validateFlags } = require('../src/cli/args');
const { commandHelp, HELP_BY_COMMAND } = require('../src/cli/help');
const { runServeCommand } = require('../src/cli/serve');

/*
 * Per-command help must list exactly the flags the strict validator accepts for that command.
 * (Both are checked against each other here; the validator's table in src/cli/args.js is the
 * source of truth.)
 */

for (const cmd of Object.keys(HELP_BY_COMMAND)) {
  test(`help for ${cmd} mentions every command-specific flag the validator accepts, and no other flag`, () => {
    const text = commandHelp(cmd);
    const mentioned = new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
    const accepted = new Set(COMMAND_FLAGS[cmd]);
    const specific = COMMAND_FLAGS[cmd].filter((f) => !COMMON_FLAGS.includes(f));
    for (const f of specific) assert.ok(mentioned.has(f), `--${f} is accepted but not in ${cmd} help`);
    for (const f of mentioned) assert.ok(accepted.has(f), `--${f} is in ${cmd} help but the validator rejects it`);
  });

  test(`every flag shown in ${cmd} help passes validateFlags`, () => {
    const text = commandHelp(cmd);
    for (const m of text.matchAll(/--([a-z][a-z-]*)/g)) {
      const { flags } = parseArgv([cmd, `--${m[1]}`, 'x']);
      assert.doesNotThrow(() => validateFlags(cmd, flags), `--${m[1]}`);
    }
  });
}

test('serve help states the port rule per mode, and the behaviour matches it', async () => {
  const text = commandHelp('serve');
  assert.ok(text.includes('Plain serve also accepts 0'));
  assert.ok(text.includes('with --admin, leave --port out'));
  // --admin rejects an explicit 0 (before touching config), as the help says.
  await assert.rejects(() => runServeCommand({ admin: true, port: '0' }, undefined, { emit: () => {} }), /whole number from 1 to 65535/);
});
