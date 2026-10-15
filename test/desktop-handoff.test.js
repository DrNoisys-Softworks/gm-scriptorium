'use strict';

/*
 * The terminal hand-off (ADR 0057 section 10; ADR 0046 addendum "The tray hand-off"): when it
 * applies, what it prints, and how the helper's exit code becomes the command's. The spawner is
 * always a fake here (this file never touches src/proc/run.js), so no program is started.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { handoffApplies, runHandoff, campaignLabel, runBareHandoff, TIMEOUT_LINE } = require('../src/desktop/handoff');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const EXEC_PATH = 'C:\\Tools\\GM-Scriptorium\\gm-scriptorium.exe';
const TRAY_PATH = 'C:\\Tools\\GM-Scriptorium\\gm-scriptorium-tray.exe';

function sink() {
  const lines = [];
  return {
    lines,
    write(text) {
      assert.ok(text.endsWith('\n'), 'every write is one whole line');
      lines.push(text.slice(0, -1));
      return true;
    },
  };
}

function applies(over = {}) {
  const seen = [];
  const info = {
    platform: 'win32',
    isPkg: true,
    execPath: EXEC_PATH,
    flags: {},
    exists: (p) => {
      seen.push(p);
      return true;
    },
    ...over,
  };
  return { result: handoffApplies(info), seen };
}

// --- when it applies ---------------------------------------------------------------------------------

test('it applies on a packaged Windows program with the helper beside it and no --config', () => {
  const { result, seen } = applies();
  assert.equal(result, true);
  assert.deepEqual(seen, [TRAY_PATH], 'it looks for the helper in the program folder and nowhere else');
});

test('it does not apply with a --config flag, whatever its value (portable and scratch runs keep console launch mode)', () => {
  assert.equal(applies({ flags: { config: 'C:\\Scratch\\config.toml' } }).result, false);
  assert.equal(applies({ flags: { config: true } }).result, false);
  assert.equal(applies({ flags: { config: '' } }).result, false);
});

test('it does not apply when the program is not packaged', () => {
  assert.equal(applies({ isPkg: false }).result, false);
});

test('it does not apply off Windows', () => {
  for (const platform of ['linux', 'darwin']) assert.equal(applies({ platform }).result, false, platform);
});

test('it does not apply without the helper beside the program (a portable copy)', () => {
  assert.equal(applies({ exists: () => false }).result, false);
});

test('it does not apply when the program path is not absolute, and a throwing probe means no', () => {
  assert.equal(applies({ execPath: 'gm-scriptorium.exe' }).result, false);
  assert.equal(applies({ exists: () => { throw new Error('EPERM'); } }).result, false);
});

// --- the output and the exit-code mapping ----------------------------------------------------------------

function fakeTray(outcome) {
  const calls = [];
  const fn = async (opts, deps) => {
    calls.push({ opts, deps });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  fn.calls = calls;
  return fn;
}

async function handoff(outcome, over = {}) {
  const output = sink();
  const tray = fakeTray(outcome);
  const code = await runHandoff({ output, env: { PATH: 'x' }, execPath: EXEC_PATH, campaign: 'long-lease', ...over }, { runTrayHandoff: tray });
  return { code, lines: output.lines, tray };
}

test('exit 0 from the helper: already running, exit 0', async () => {
  const { code, lines } = await handoff({ outcome: 'exited', exitCode: 0 });
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'GM-Scriptorium is already running in the background (long-lease).',
    'Opened a new signed-in tab in your browser.',
  ]);
});

test('exit 3 from the helper: started it, exit 0', async () => {
  const { code, lines } = await handoff({ outcome: 'exited', exitCode: 3 });
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'Started GM-Scriptorium in the background (long-lease).',
    'Its icon is in the system tray, and your browser is opening.',
  ]);
});

test('exit 4 from the helper: the panel could not start, command exit 1, never 4', async () => {
  const { code, lines } = await handoff({ outcome: 'exited', exitCode: 4 });
  assert.equal(code, 1);
  assert.notEqual(code, 4, '4 is the frozen update-prerequisite code');
  assert.deepEqual(lines, [
    "GM-Scriptorium is running, but its panel couldn't start. See the notification, or open the log from its icon in the system tray.",
  ]);
});

test('exit 1 from the helper means nothing was started: fall back (null), print nothing', async () => {
  const { code, lines } = await handoff({ outcome: 'exited', exitCode: 1 });
  assert.equal(code, null);
  assert.deepEqual(lines, []);
});

test('the helper exit code is never passed through: every code maps as stated', async () => {
  const expected = new Map([[0, 0], [3, 0], [4, 1], [1, null]]);
  for (let helper = 0; helper <= 255; helper += 1) {
    const { code } = await handoff({ outcome: 'exited', exitCode: helper });
    if (expected.has(helper)) assert.equal(code, expected.get(helper), `helper exit ${helper}`);
    else assert.equal(code, 1, `helper exit ${helper} is some other failure after a start: exit 1, no fallback`);
  }
});

test('an exit with no code (stopped by a signal) is a failure after a start: exit 1, no fallback, a plain line', async () => {
  const { code, lines } = await handoff({ outcome: 'exited', exitCode: null });
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.ok(!/[\u0000-\u001f]/.test(lines[0]));
});

test('a timeout prints the still-starting line and exits 1 with NO fallback', async () => {
  const { code, lines } = await handoff({ outcome: 'timeout' });
  assert.equal(code, 1);
  assert.notEqual(code, null, 'null would start a second panel in this window');
  assert.deepEqual(lines, ['GM-Scriptorium is still starting. Look for its icon in the system tray.']);
  assert.equal(TIMEOUT_LINE, 'GM-Scriptorium is still starting. Look for its icon in the system tray.');
});

test('a spawn failure, or any refusal from the spawner, falls back (null) and prints nothing', async () => {
  for (const err of [Object.assign(new Error('x'), { code: 'E_PROC_SPAWN' }), Object.assign(new Error('x'), { code: 'E_PROC_NOT_ALLOWED' }), Object.assign(new Error('x'), { code: 'E_PROC_ENV' }), new TypeError('odd')]) {
    const { code, lines } = await handoff(err);
    assert.equal(code, null, String(err.code));
    assert.deepEqual(lines, []);
  }
});

test('with no single or default campaign the parentheses are left out', async () => {
  for (const campaign of [null, undefined, '']) {
    const ran = await handoff({ outcome: 'exited', exitCode: 0 }, { campaign });
    assert.equal(ran.lines[0], 'GM-Scriptorium is already running in the background.');
    const started = await handoff({ outcome: 'exited', exitCode: 3 }, { campaign });
    assert.equal(started.lines[0], 'Started GM-Scriptorium in the background.');
  }
});

test('control characters in a campaign name never reach the terminal', async () => {
  const { lines } = await handoff({ outcome: 'exited', exitCode: 0 }, { campaign: 'harbour\u001b[2J\nwatch' });
  assert.equal(lines.length, 2);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(lines[0]), JSON.stringify(lines[0]));
});

test('the spawner gets a plain copy of the environment and the program path, and nothing that names a helper', async () => {
  const env = { PATH: 'x', SCRIPTORIUM_CONFIG: 'C:\\Scratch\\c.toml', USERDOMAIN: 'HARBOUR-PC' };
  const { tray } = await handoff({ outcome: 'exited', exitCode: 0 }, { env });
  assert.equal(tray.calls.length, 1);
  const { opts, deps } = tray.calls[0];
  assert.deepEqual(Object.keys(opts).sort(), ['env']);
  assert.deepEqual(opts.env, env);
  assert.notEqual(opts.env, env, 'a copy, not the live environment object');
  assert.deepEqual(deps, { execPath: EXEC_PATH });
});

// --- the campaign label --------------------------------------------------------------------------------

test('the campaign label is the default, or the single campaign, else nothing', () => {
  const load = (config) => () => ({ config });
  assert.equal(campaignLabel({}, { loadConfig: load({ default_campaign: 'long-lease', campaigns: { 'long-lease': {}, 'harbour-watch': {} } }) }), 'long-lease');
  assert.equal(campaignLabel({}, { loadConfig: load({ campaigns: { 'harbour-watch': {} } }) }), 'harbour-watch');
  assert.equal(campaignLabel({}, { loadConfig: load({ campaigns: { 'long-lease': {}, 'harbour-watch': {} } }) }), null);
  assert.equal(campaignLabel({}, { loadConfig: load({ campaigns: {} }) }), null);
  assert.equal(campaignLabel({}, { loadConfig: load({}) }), null);
});

test('the campaign label is null when the config cannot be read, instead of failing the hand-off', () => {
  assert.equal(campaignLabel({}, { loadConfig: () => { throw new Error('config is not valid TOML'); } }), null);
});

// --- the whole branch bin/scriptorium.js calls ----------------------------------------------------------

function bare(over = {}) {
  const output = sink();
  const tray = fakeTray({ outcome: 'exited', exitCode: 3 });
  const deps = {
    platform: 'win32',
    isPkg: true,
    execPath: EXEC_PATH,
    exists: () => true,
    output,
    env: { PATH: 'x' },
    loadConfig: () => ({ config: { campaigns: { 'long-lease': {} } } }),
    runTrayHandoff: tray,
    ...over,
  };
  return { output, tray, deps };
}

test('runBareHandoff runs the hand-off and returns its exit code when it applies', async () => {
  const { output, tray, deps } = bare();
  assert.equal(await runBareHandoff({}, deps), 0);
  assert.equal(tray.calls.length, 1);
  assert.equal(output.lines[0], 'Started GM-Scriptorium in the background (long-lease).');
});

test('runBareHandoff returns null without calling the spawner when it does not apply (--config, not packaged, Linux, no helper)', async () => {
  for (const [flags, over] of [
    [{ config: 'C:\\Scratch\\c.toml' }, {}],
    [{}, { isPkg: false }],
    [{}, { platform: 'linux' }],
    [{}, { exists: () => false }],
  ]) {
    const { output, tray, deps } = bare(over);
    assert.equal(await runBareHandoff(flags, deps), null);
    assert.equal(tray.calls.length, 0);
    assert.deepEqual(output.lines, []);
  }
});

test('runBareHandoff returns null when the helper reports nothing started, and 1 (not null) on a timeout', async () => {
  const nothing = bare({ runTrayHandoff: fakeTray({ outcome: 'exited', exitCode: 1 }) });
  assert.equal(await runBareHandoff({}, nothing.deps), null);
  const slow = bare({ runTrayHandoff: fakeTray({ outcome: 'timeout' }) });
  assert.equal(await runBareHandoff({}, slow.deps), 1);
  assert.deepEqual(slow.output.lines, ['GM-Scriptorium is still starting. Look for its icon in the system tray.']);
});
