'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installLoopbackGuard } = require('./helpers/net-stubs');
const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const TOML = require('smol-toml');
const { parseUpdateTable, CHANNELS } = require('../src/config/updatesettings');
const { setUpdateSetting, serializeConfig } = require('../src/config/write');
const { ConfigError, UpdatePrerequisiteError } = require('../src/util/errors');
const notice = require('../src/update/notice');
const controller = require('../src/admin/updatenotice');

/*
 * The update notice (docs/decisions/0028-installer-and-first-run.md, addendum "The update notice"):
 * the pure setting reader and writer, the daily rule, the check core and the panel controller. Every
 * expected string and number is written here, not read back from the code under test. Nothing here
 * reaches a network: the check is always an injected stand-in.
 */

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 14, 9, 14, 0);
const TAG_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v1.0.1';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-update-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- parseUpdateTable -------------------------------------------------------------------------

test('parseUpdateTable: an absent table reads as on, with no saved channel', () => {
  assert.deepEqual(parseUpdateTable(undefined), { readable: true, check: true, channel: null });
});

test('parseUpdateTable: an empty table reads as on, with no saved channel', () => {
  assert.deepEqual(parseUpdateTable({}), { readable: true, check: true, channel: null });
});

test('parseUpdateTable: check true and check false', () => {
  assert.deepEqual(parseUpdateTable({ check: true }), { readable: true, check: true, channel: null });
  assert.deepEqual(parseUpdateTable({ check: false }), { readable: true, check: false, channel: null });
});

test('parseUpdateTable: a channel of stable or beta is read, anything else makes the table unreadable', () => {
  assert.deepEqual(parseUpdateTable({ channel: 'beta' }), { readable: true, check: true, channel: 'beta' });
  assert.deepEqual(parseUpdateTable({ channel: 'stable', check: false }), { readable: true, check: false, channel: 'stable' });
  const bad = { readable: false, check: false, channel: null };
  assert.deepEqual(parseUpdateTable({ channel: 'Beta' }), bad, 'case matters');
  assert.deepEqual(parseUpdateTable({ channel: 'nightly' }), bad);
  assert.deepEqual(parseUpdateTable({ channel: 1 }), bad);
});

test('parseUpdateTable: a check that is not exactly a boolean makes the table unreadable', () => {
  const bad = { readable: false, check: false, channel: null };
  assert.deepEqual(parseUpdateTable({ check: 'yes' }), bad);
  assert.deepEqual(parseUpdateTable({ check: 1 }), bad);
  assert.deepEqual(parseUpdateTable({ check: 'true' }), bad);
});

test('parseUpdateTable: another key inside [update] is ignored', () => {
  assert.deepEqual(parseUpdateTable({ check: false, note: 'hi' }), { readable: true, check: false, channel: null });
});

test('parseUpdateTable: a value that is not a table is unreadable, and it never throws', () => {
  const bad = { readable: false, check: false, channel: null };
  for (const raw of [5, 'on', true, null, [], [{ check: true }]]) assert.deepEqual(parseUpdateTable(raw), bad, JSON.stringify(raw));
});

test('CHANNELS is frozen and holds exactly stable and beta', () => {
  assert.deepEqual([...CHANNELS], ['stable', 'beta']);
  assert.equal(Object.isFrozen(CHANNELS), true);
});

// ---- setUpdateSetting -------------------------------------------------------------------------

const BASE = { config_version: 1, default_campaign: 'a', campaigns: { a: { vault: '/v' } } };

test('setUpdateSetting: adds the table, keeps the rest, and does not touch its input', () => {
  const before = JSON.stringify(BASE);
  const next = setUpdateSetting(BASE, 'check', false);
  assert.deepEqual(next.update, { check: false });
  assert.deepEqual(next.campaigns, BASE.campaigns);
  assert.equal(JSON.stringify(BASE), before);
});

test('setUpdateSetting: keeps the other [update] keys', () => {
  const next = setUpdateSetting({ ...BASE, update: { check: false, note: 'x', channel: 'stable' } }, 'channel', 'beta');
  assert.deepEqual(next.update, { check: false, note: 'x', channel: 'beta' });
});

test('setUpdateSetting: refuses an unknown key, a bad value and an unreadable table', () => {
  assert.throws(() => setUpdateSetting(BASE, 'other', true), ConfigError);
  assert.throws(() => setUpdateSetting(BASE, 'check', 'yes'), ConfigError);
  assert.throws(() => setUpdateSetting(BASE, 'channel', 'Beta'), ConfigError);
  assert.throws(() => setUpdateSetting(BASE, 'channel', 3), ConfigError);
  assert.throws(() => setUpdateSetting({ ...BASE, update: { check: 'yes' } }, 'check', true), ConfigError);
  assert.throws(() => setUpdateSetting({ ...BASE, update: 5 }, 'check', true), ConfigError);
});

test('setUpdateSetting: the serialised file holds [update] and reads back through the parser', () => {
  const text = serializeConfig(setUpdateSetting(setUpdateSetting(BASE, 'check', false), 'channel', 'beta'));
  assert.match(text, /^\[update\]$/m);
  assert.match(text, /^check = false$/m);
  assert.match(text, /^channel = "beta"$/m);
  assert.deepEqual(parseUpdateTable(TOML.parse(text).update), { readable: true, check: false, channel: 'beta' });
});

// ---- channel and the daily rule ---------------------------------------------------------------

test('defaultChannel: a stable build is stable, a prerelease build is beta', () => {
  assert.equal(notice.defaultChannel('0.5.0'), 'stable');
  assert.equal(notice.defaultChannel('1.0.0'), 'stable');
  assert.equal(notice.defaultChannel('1.0.0-rc.2'), 'beta');
  assert.equal(notice.defaultChannel('0.4.0-rc.3'), 'beta');
});

test('effectiveChannel: a saved channel wins, otherwise the build decides', () => {
  assert.equal(notice.effectiveChannel('stable', '1.0.0-rc.2'), 'stable');
  assert.equal(notice.effectiveChannel('beta', '1.0.0'), 'beta');
  assert.equal(notice.effectiveChannel(null, '1.0.0-rc.2'), 'beta');
  assert.equal(notice.effectiveChannel(null, '1.0.0'), 'stable');
});

test('isDue: 23 hours old is not due, exactly 24 hours is not due, one millisecond more is due', () => {
  assert.equal(notice.isDue(NOW - 23 * 3600000, NOW), false);
  assert.equal(notice.isDue(NOW - 86400000, NOW), false);
  assert.equal(notice.isDue(NOW - 86400001, NOW), true);
});

test('isDue: a missing, future or non-integer time is due', () => {
  assert.equal(notice.isDue(null, NOW), true);
  assert.equal(notice.isDue(undefined, NOW), true);
  assert.equal(notice.isDue(NOW + 1, NOW), true);
  assert.equal(notice.isDue(1.5, NOW), true);
  assert.equal(notice.isDue('1', NOW), true);
  assert.equal(notice.isDue(NOW, NOW), false);
});

test('constants: a day, and a thirty second check timeout', () => {
  assert.equal(notice.DAY_MS, 86400000);
  assert.equal(notice.CHECK_TIMEOUT_MS, 30000);
});

// ---- checkForUpdate ---------------------------------------------------------------------------

function lookup(reply) {
  const calls = [];
  const fn = async (flags) => {
    calls.push(flags);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  fn.calls = calls;
  return fn;
}

function prerequisite(reason) {
  const err = new UpdatePrerequisiteError('x');
  err.reason = reason;
  return err;
}

test('checkForUpdate: stable asks for the latest release with a 30 second bound and no pre', async () => {
  const lookupRelease = lookup({ tag_name: 'v1.0.1', prerelease: false });
  const signal = new AbortController().signal;
  const out = await notice.checkForUpdate({ channel: 'stable', currentVersion: '1.0.0', signal }, { lookupRelease });
  assert.deepEqual(lookupRelease.calls, [{ totalTimeoutMs: 30000, signal }]);
  assert.equal('pre' in lookupRelease.calls[0], false);
  assert.deepEqual(out, { state: 'available', tag: 'v1.0.1', prerelease: false, notesUrl: TAG_URL });
});

test('checkForUpdate: beta passes pre: true', async () => {
  const lookupRelease = lookup({ tag_name: 'v0.4.0-rc.4', prerelease: true });
  const out = await notice.checkForUpdate({ channel: 'beta', currentVersion: '0.4.0-rc.3' }, { lookupRelease });
  assert.equal(lookupRelease.calls[0].pre, true);
  assert.equal(lookupRelease.calls[0].totalTimeoutMs, 30000);
  assert.equal(out.state, 'available');
  assert.equal(out.prerelease, true);
});

test('checkForUpdate: the same or an older version is current', async () => {
  for (const tag of ['v1.0.0', 'v0.9.0']) {
    const out = await notice.checkForUpdate({ channel: 'stable', currentVersion: '1.0.0' }, { lookupRelease: lookup({ tag_name: tag }) });
    assert.deepEqual(out, { state: 'current' }, tag);
  }
});

test('checkForUpdate: no-release counts as current', async () => {
  const out = await notice.checkForUpdate({ channel: 'stable', currentVersion: '1.0.0' }, { lookupRelease: lookup(prerequisite('no-release')) });
  assert.deepEqual(out, { state: 'current' });
});

test('checkForUpdate: any other failure rejects', async () => {
  for (const reason of ['rate-limit', 'unreachable', 'tls', 'redirect']) {
    await assert.rejects(
      notice.checkForUpdate({ channel: 'stable', currentVersion: '1.0.0' }, { lookupRelease: lookup(prerequisite(reason)) }),
      (err) => err.reason === reason,
      reason,
    );
  }
  await assert.rejects(notice.checkForUpdate({ channel: 'stable', currentVersion: '1.0.0' }, { lookupRelease: lookup(new Error('boom')) }), /boom/);
});

test('checkForUpdate: the notes link is built from the tag, never taken from the reply', async () => {
  const lookupRelease = lookup({ tag_name: 'v1.0.1', html_url: 'https://evil.example/phish', url: 'https://evil.example/api' });
  const out = await notice.checkForUpdate({ channel: 'stable', currentVersion: '1.0.0' }, { lookupRelease });
  assert.equal(out.notesUrl, TAG_URL);
});

test('checkForUpdate: an unsafe or unparseable tag is an error, not a notice', async () => {
  for (const tag of ['v1.0.1/../../x', ' v1.0.1', 'latest', 5, undefined, null]) {
    await assert.rejects(
      notice.checkForUpdate({ channel: 'stable', currentVersion: '1.0.0' }, { lookupRelease: lookup({ tag_name: tag }) }),
      (err) => err.name === 'ScriptoriumError' || err instanceof Error,
      String(tag),
    );
  }
});

test('checkForUpdate: a current version that does not parse is an error', async () => {
  await assert.rejects(notice.checkForUpdate({ channel: 'stable', currentVersion: 'dev' }, { lookupRelease: lookup({ tag_name: 'v1.0.1' }) }));
});

// ---- readState and writeState -----------------------------------------------------------------

const EMPTY = { lastSuccessMs: null, channel: null, latest: null, prerelease: false, dismissed: null };
const FULL = { lastSuccessMs: NOW - 3600000, channel: 'stable', latest: 'v1.0.1', prerelease: false, dismissed: null };

test('readState: a missing file reads as empty', (t) => {
  assert.deepEqual(controller.readState(scratch(t)), EMPTY);
});

test('readState: bad JSON, a non-object, an array and an oversized file read as empty', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, controller.FILE);
  for (const text of ['{nope', '5', '[]', 'null', '"x"']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(controller.readState(dir), EMPTY, text);
  }
  fs.writeFileSync(file, JSON.stringify({ ...FULL, pad: 'x'.repeat(5000) }));
  assert.deepEqual(controller.readState(dir), EMPTY, 'over 4096 bytes');
});

test('readState: a directory or a symlink in its place reads as empty', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, controller.FILE);
  fs.mkdirSync(file);
  assert.deepEqual(controller.readState(dir), EMPTY);
  fs.rmdirSync(file);
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, JSON.stringify(FULL));
  try {
    fs.symlinkSync(real, file);
  } catch {
    return; // symlinks unavailable here
  }
  assert.deepEqual(controller.readState(dir), EMPTY);
});

test('readState: each bad field reads as empty on its own, the good fields stay', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, controller.FILE);
  const put = (o) => fs.writeFileSync(file, JSON.stringify(o));
  put({ ...FULL, lastSuccessMs: -1 });
  assert.equal(controller.readState(dir).lastSuccessMs, null);
  put({ ...FULL, lastSuccessMs: 1.5 });
  assert.equal(controller.readState(dir).lastSuccessMs, null);
  put({ ...FULL, lastSuccessMs: '5' });
  assert.equal(controller.readState(dir).lastSuccessMs, null);
  put({ ...FULL, latest: 'v1/../x' });
  assert.equal(controller.readState(dir).latest, null);
  put({ ...FULL, dismissed: '<b>' });
  assert.equal(controller.readState(dir).dismissed, null);
  put({ ...FULL, channel: 'Beta' });
  const s = controller.readState(dir);
  assert.equal(s.channel, null);
  assert.equal(s.latest, 'v1.0.1');
  assert.equal(s.lastSuccessMs, FULL.lastSuccessMs);
  put({ ...FULL, prerelease: 'yes' });
  assert.equal(controller.readState(dir).prerelease, false);
});

test('writeState then readState round-trips, and the file is 0600 in a 0700 folder on POSIX', (t) => {
  const dir = path.join(scratch(t), 'panel');
  const state = { ...FULL, prerelease: true, dismissed: 'v1.0.1' };
  controller.writeState(dir, state);
  assert.deepEqual(controller.readState(dir), state);
  assert.deepEqual(fs.readdirSync(dir), [controller.FILE], 'no temp file left behind');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, controller.FILE)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

// ---- the controller ---------------------------------------------------------------------------

/** A controllable clock and check. `outcomes` is consumed one per call; a function runs as the check. */
function rig(t, opts = {}) {
  const panelDir = opts.panelDir || path.join(scratch(t), 'panel');
  const clock = { ms: opts.now === undefined ? NOW : opts.now };
  const calls = [];
  const outcomes = [...(opts.outcomes || [])];
  const check = (args) => {
    calls.push({ ...args });
    const next = outcomes.length > 0 ? outcomes.shift() : { state: 'current' };
    if (typeof next === 'function') return next(args);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  const n = controller.createUpdateNotice({
    panelDir,
    config: opts.config === undefined ? {} : opts.config,
    currentVersion: opts.currentVersion || '1.0.0',
    setupMode: opts.setupMode === true,
    isPkg: opts.isPkg === undefined ? true : opts.isPkg,
    check,
    now: () => clock.ms,
  });
  t.after(() => n.stop());
  return { n, calls, clock, panelDir };
}

const AVAILABLE = { state: 'available', tag: 'v1.0.1', prerelease: false, notesUrl: TAG_URL };

test('a controller does no I/O until start: creating it writes and reads nothing', (t) => {
  const { n, calls, panelDir } = rig(t, { outcomes: [AVAILABLE] });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(panelDir), false);
  assert.equal(n.snapshot().state, 'idle');
});

test('start with nothing stored runs one check, shows the notice and writes 0600', async (t) => {
  const { n, calls, panelDir } = rig(t, { outcomes: [AVAILABLE] });
  await n.start();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].channel, 'stable');
  assert.equal(calls[0].currentVersion, '1.0.0');
  assert.ok(calls[0].signal instanceof AbortSignal);
  const snap = n.snapshot();
  assert.equal(snap.state, 'available');
  assert.equal(snap.latest, '1.0.1');
  assert.equal(snap.latestTag, 'v1.0.1');
  assert.equal(snap.notesUrl, TAG_URL);
  assert.equal(snap.beta, false);
  assert.equal(snap.dismissed, false);
  assert.equal(snap.lastSuccessMs, NOW);
  assert.deepEqual(controller.readState(panelDir), { lastSuccessMs: NOW, channel: 'stable', latest: 'v1.0.1', prerelease: false, dismissed: null });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(panelDir, controller.FILE)).mode & 0o777, 0o600);
});

test('snapshot has exactly the documented fields', async (t) => {
  const { n } = rig(t, { outcomes: [AVAILABLE] });
  await n.start();
  assert.deepEqual(Object.keys(n.snapshot()).sort(), [
    'beta', 'channel', 'channelSaved', 'current', 'defaultChannel', 'dismissed', 'lastSuccessMs', 'latest', 'latestTag',
    'notesUrl', 'prereleaseBuild', 'setting', 'state',
  ]);
});

test('a current result shows no notice and still writes the time', async (t) => {
  const { n, panelDir } = rig(t, { outcomes: [{ state: 'current' }] });
  await n.start();
  assert.equal(n.snapshot().state, 'current');
  assert.deepEqual(controller.readState(panelDir), { lastSuccessMs: NOW, channel: 'stable', latest: null, prerelease: false, dismissed: null });
});

test('a failure shows failed and writes nothing', async (t) => {
  const { n, panelDir } = rig(t, { outcomes: [prerequisite('unreachable')] });
  await n.start();
  assert.equal(n.snapshot().state, 'failed');
  assert.equal(fs.existsSync(path.join(panelDir, controller.FILE)), false);
});

test('a failure keeps an earlier stored success untouched', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  const old = { lastSuccessMs: NOW - 2 * DAY, channel: 'stable', latest: 'v1.0.1', prerelease: false, dismissed: null };
  controller.writeState(dir, old);
  const { n } = rig(t, { panelDir: dir, outcomes: [new Error('boom')] });
  await n.start();
  assert.equal(n.snapshot().state, 'failed');
  assert.deepEqual(controller.readState(dir), old);
});

test('a rejecting check and a synchronously throwing check both end in failed, with no unhandled rejection', async (t) => {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.removeListener('unhandledRejection', onRejection));
  const a = rig(t, { outcomes: [new Error('rejected')] });
  await a.n.start();
  assert.equal(a.n.snapshot().state, 'failed');
  const b = rig(t, {
    outcomes: [
      () => {
        throw new Error('thrown');
      },
    ],
  });
  await b.n.start();
  assert.equal(b.n.snapshot().state, 'failed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
});

test('start returns without a rejection even when the state file cannot be written', async (t) => {
  const dir = scratch(t);
  const blocker = path.join(dir, 'panel');
  fs.writeFileSync(blocker, 'a file, not a folder');
  const { n } = rig(t, { panelDir: blocker, outcomes: [AVAILABLE] });
  await n.start();
  assert.equal(n.snapshot().state, 'available', 'the notice still shows for this run');
});

test('restore: a success under a day old for the same channel is shown without a check', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, FULL);
  const { n, calls } = rig(t, { panelDir: dir });
  await n.start();
  assert.equal(calls.length, 0);
  const snap = n.snapshot();
  assert.equal(snap.state, 'available');
  assert.equal(snap.latestTag, 'v1.0.1');
});

test('restore: a stored latest that is no longer newer restores as current', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, FULL);
  const { n, calls } = rig(t, { panelDir: dir, currentVersion: '1.0.1' });
  await n.start();
  assert.equal(calls.length, 0);
  assert.equal(n.snapshot().state, 'current');
});

test('restore: a success stored for another channel is ignored and checks again', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, { ...FULL, channel: 'beta' });
  const { n, calls } = rig(t, { panelDir: dir, outcomes: [{ state: 'current' }] });
  await n.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'stable');
});

test('restore: a success more than a day old checks again', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, { ...FULL, lastSuccessMs: NOW - DAY - 1 });
  const { n, calls } = rig(t, { panelDir: dir, outcomes: [{ state: 'current' }] });
  await n.start();
  assert.equal(calls.length, 1);
});

test('restore: exactly a day old does not check', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, { ...FULL, lastSuccessMs: NOW - DAY });
  const { n, calls } = rig(t, { panelDir: dir });
  await n.start();
  assert.equal(calls.length, 0);
});

test('restore: a success time in the future is due', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, { ...FULL, lastSuccessMs: NOW + 5000 });
  const { n, calls } = rig(t, { outcomes: [{ state: 'current' }], panelDir: dir });
  await n.start();
  assert.equal(calls.length, 1);
});

test('a prerelease build defaults to beta and the check asks for beta', async (t) => {
  const { n, calls } = rig(t, { currentVersion: '1.0.0-rc.2', outcomes: [{ state: 'available', tag: 'v1.0.0-rc.3', prerelease: true, notesUrl: 'x' }] });
  await n.start();
  assert.equal(calls[0].channel, 'beta');
  const snap = n.snapshot();
  assert.equal(snap.channel, 'beta');
  assert.equal(snap.channelSaved, false);
  assert.equal(snap.defaultChannel, 'beta');
  assert.equal(snap.prereleaseBuild, true);
  assert.equal(snap.beta, true);
  assert.equal(snap.latest, '1.0.0-rc.3');
});

test('a saved channel beats the build, and a beta channel that finds a full release has no beta label', async (t) => {
  const { n, calls } = rig(t, {
    currentVersion: '1.0.0',
    config: { update: { channel: 'beta' } },
    outcomes: [{ state: 'available', tag: 'v1.0.1', prerelease: false, notesUrl: TAG_URL }],
  });
  await n.start();
  assert.equal(calls[0].channel, 'beta');
  const snap = n.snapshot();
  assert.equal(snap.channelSaved, true);
  assert.equal(snap.beta, false);
});

test('the wait between attempts: a failure is not retried inside a day by a tick, and is a day later', async (t) => {
  const { n, calls, clock } = rig(t, { outcomes: [new Error('down'), { state: 'current' }] });
  await n.start();
  assert.equal(calls.length, 1);
  clock.ms += 3600000;
  await n.tick();
  clock.ms += 23 * 3600000;
  await n.tick();
  assert.equal(calls.length, 1, 'exactly 24 hours after the attempt is still waiting');
  clock.ms += 1;
  await n.tick();
  assert.equal(calls.length, 2);
  assert.equal(n.snapshot().state, 'current');
});

test('a tick checks nothing while the last success is fresh, and checks once it is over a day old', async (t) => {
  const { n, calls, clock } = rig(t, { outcomes: [{ state: 'current' }, { state: 'current' }] });
  await n.start();
  clock.ms += 12 * 3600000;
  await n.tick();
  assert.equal(calls.length, 1);
  clock.ms += 12 * 3600000 + 1;
  await n.tick();
  assert.equal(calls.length, 2);
});

test('a tick never starts a second check while one is in flight', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { n, calls, clock } = rig(t, { outcomes: [() => gate] });
  const started = n.start();
  assert.equal(n.snapshot().state, 'checking');
  clock.ms += 2 * DAY;
  await n.tick();
  assert.equal(calls.length, 1);
  release({ state: 'current' });
  await started;
});

test('the setting off: no check, state off, and the last success still shows', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, { ...FULL, lastSuccessMs: NOW - 5 * DAY });
  const { n, calls } = rig(t, { panelDir: dir, config: { update: { check: false } } });
  await n.start();
  await n.tick();
  assert.equal(calls.length, 0);
  const snap = n.snapshot();
  assert.equal(snap.setting, 'off');
  assert.equal(snap.state, 'off');
  assert.equal(snap.lastSuccessMs, NOW - 5 * DAY);
});

test('an unreadable setting: no check, setting unreadable, channel null, nothing restored', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, FULL);
  const { n, calls } = rig(t, { panelDir: dir, config: { update: { check: 'yes' } } });
  await n.start();
  await n.tick();
  assert.equal(calls.length, 0);
  const snap = n.snapshot();
  assert.equal(snap.setting, 'unreadable');
  assert.equal(snap.channel, null);
  assert.equal(snap.state, 'off');
  assert.equal(snap.lastSuccessMs, null);
});

test('a source run (not packaged) never checks, but restores', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, FULL);
  const { n, calls } = rig(t, { panelDir: dir, isPkg: false });
  await n.start();
  await n.tick();
  assert.equal(calls.length, 0);
  assert.equal(n.snapshot().state, 'available');
});

test('a process that started in setup mode never checks', async (t) => {
  const { n, calls } = rig(t, { setupMode: true });
  await n.start();
  await n.tick();
  assert.equal(calls.length, 0);
});

test('a source run or setup process does not arm the hourly timer', async (t) => {
  const real = global.setInterval;
  const made = [];
  global.setInterval = (...a) => {
    const h = real(...a);
    made.push(h);
    return h;
  };
  t.after(() => {
    global.setInterval = real;
    made.forEach((h) => clearInterval(h));
  });
  const a = rig(t, { isPkg: false });
  await a.n.start();
  const b = rig(t, { setupMode: true });
  await b.n.start();
  assert.equal(made.length, 0);
  const c = rig(t);
  await c.n.start();
  assert.equal(made.length, 1);
  assert.equal(made[0].hasRef(), false, 'the timer is unref-ed');
  c.n.stop();
  assert.equal(made[0]._destroyed, true);
});

test('applySetting check false: aborts a check in flight, clears the notice and sets off', async (t) => {
  let signal;
  const { n, panelDir } = rig(t, {
    outcomes: [
      (args) => {
        signal = args.signal;
        return new Promise(() => {});
      },
    ],
  });
  n.start();
  assert.equal(n.snapshot().state, 'checking');
  n.applySetting('check', false);
  assert.equal(signal.aborted, true);
  assert.equal(n.snapshot().state, 'off');
  assert.equal(n.snapshot().setting, 'off');
  assert.equal(fs.existsSync(path.join(panelDir, controller.FILE)), false);
});

test('a superseded check writes nothing: its late result is ignored', async (t) => {
  let finish;
  const { n, panelDir } = rig(t, {
    outcomes: [
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ],
  });
  const started = n.start();
  n.applySetting('check', false);
  finish(AVAILABLE);
  await started;
  assert.equal(fs.existsSync(path.join(panelDir, controller.FILE)), false);
  assert.equal(n.snapshot().state, 'off');
});

test('applySetting check true: does not check now, and the next attempt waits a day', async (t) => {
  const { n, calls, clock } = rig(t, { config: { update: { check: false } }, outcomes: [{ state: 'current' }] });
  await n.start();
  n.applySetting('check', true);
  assert.equal(calls.length, 0);
  assert.equal(n.snapshot().setting, 'on');
  assert.equal(n.snapshot().state, 'idle');
  clock.ms += 3600000;
  await n.tick();
  assert.equal(calls.length, 0);
  clock.ms += DAY;
  await n.tick();
  assert.equal(calls.length, 1);
});

test('applySetting check true restores a fresh stored result without checking', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, FULL);
  const { n, calls } = rig(t, { panelDir: dir, config: { update: { check: false } } });
  await n.start();
  assert.equal(n.snapshot().state, 'off');
  n.applySetting('check', true);
  assert.equal(calls.length, 0);
  assert.equal(n.snapshot().state, 'available');
});

test('applySetting channel: aborts, forgets the result and checks once straight away', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  controller.writeState(dir, FULL);
  const { n, calls } = rig(t, { panelDir: dir, outcomes: [{ state: 'available', tag: 'v1.1.0-rc.1', prerelease: true, notesUrl: 'x' }] });
  await n.start();
  assert.equal(n.snapshot().state, 'available');
  const pending = n.applySetting('channel', 'beta');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'beta');
  assert.equal(n.snapshot().state, 'checking');
  assert.equal(n.snapshot().latestTag, null, 'the old result is forgotten at once');
  await pending;
  const snap = n.snapshot();
  assert.equal(snap.state, 'available');
  assert.equal(snap.latestTag, 'v1.1.0-rc.1');
  assert.equal(snap.channel, 'beta');
  assert.equal(snap.channelSaved, true);
  assert.equal(controller.readState(dir).channel, 'beta');
});

test('applySetting channel while checks are off saves the choice but checks nothing', async (t) => {
  const { n, calls } = rig(t, { config: { update: { check: false } } });
  await n.start();
  await n.applySetting('channel', 'beta');
  assert.equal(calls.length, 0);
  assert.equal(n.snapshot().channel, 'beta');
  assert.equal(n.snapshot().state, 'off');
});

test('applySetting on an unreadable setting changes nothing', async (t) => {
  const { n, calls } = rig(t, { config: { update: { channel: 'nope' } } });
  await n.start();
  await n.applySetting('check', true);
  await n.applySetting('channel', 'beta');
  assert.equal(calls.length, 0);
  assert.equal(n.snapshot().setting, 'unreadable');
});

test('dismiss: the right tag is written and kept, other fields stay', async (t) => {
  const { n, panelDir } = rig(t, { outcomes: [AVAILABLE] });
  await n.start();
  n.dismiss('v1.0.1');
  assert.equal(n.snapshot().dismissed, true);
  assert.deepEqual(controller.readState(panelDir), { lastSuccessMs: NOW, channel: 'stable', latest: 'v1.0.1', prerelease: false, dismissed: 'v1.0.1' });
});

test('dismiss: a wrong tag, a non-string and a dismiss with nothing to dismiss all throw and write nothing', async (t) => {
  const { n, panelDir } = rig(t, { outcomes: [AVAILABLE] });
  assert.throws(() => n.dismiss('v1.0.1'), 'nothing is available yet');
  await n.start();
  const before = fs.readFileSync(path.join(panelDir, controller.FILE), 'utf8');
  for (const bad of ['v9.9.9', '', null, 5, undefined, 'v1.0.1 ']) assert.throws(() => n.dismiss(bad), String(bad));
  assert.equal(fs.readFileSync(path.join(panelDir, controller.FILE), 'utf8'), before);
  assert.equal(n.snapshot().dismissed, false);
});

test('a dismissal persists across a restart and applies only to that version', async (t) => {
  const dir = path.join(scratch(t), 'panel');
  const first = rig(t, { panelDir: dir, outcomes: [AVAILABLE] });
  await first.n.start();
  first.n.dismiss('v1.0.1');
  first.n.stop();
  const second = rig(t, { panelDir: dir });
  await second.n.start();
  assert.equal(second.n.snapshot().state, 'available');
  assert.equal(second.n.snapshot().dismissed, true);
  second.clock.ms += 2 * DAY;
  second.calls.length = 0;
  const third = rig(t, { panelDir: dir, now: NOW + 2 * DAY, outcomes: [{ state: 'available', tag: 'v1.0.2', prerelease: false, notesUrl: 'x' }] });
  await third.n.start();
  assert.equal(third.n.snapshot().latestTag, 'v1.0.2');
  assert.equal(third.n.snapshot().dismissed, false);
});

test('after stop, a late result writes nothing and dismiss refuses', async (t) => {
  let finish;
  const { n, panelDir } = rig(t, {
    outcomes: [
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ],
  });
  const started = n.start();
  n.stop();
  finish(AVAILABLE);
  await started;
  assert.equal(fs.existsSync(path.join(panelDir, controller.FILE)), false);
  assert.throws(() => n.dismiss('v1.0.1'));
});

test('stop aborts the signal that was passed to the check, and a second stop is harmless', async (t) => {
  let signal;
  const { n } = rig(t, {
    outcomes: [
      (args) => {
        signal = args.signal;
        return new Promise(() => {});
      },
    ],
  });
  n.start();
  assert.equal(signal.aborted, false);
  n.stop();
  assert.equal(signal.aborted, true);
  n.stop();
});

test('a failing, a rejecting and a throwing check write nothing to the console', async (t) => {
  const written = [];
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const real = {};
  for (const n of names) {
    real[n] = console[n];
    console[n] = (...a) => written.push(`${n}: ${a.join(' ')}`);
  }
  t.after(() => names.forEach((n) => (console[n] = real[n])));
  const replies = [
    new Error('rejected'),
    () => {
      throw new Error('thrown');
    },
    prerequisite('unreachable'),
  ];
  for (const reply of replies) {
    const { n } = rig(t, { outcomes: [reply] });
    await n.start();
    assert.equal(n.snapshot().state, 'failed');
    n.stop();
  }
  const ok = rig(t, { outcomes: [AVAILABLE] });
  await ok.n.start();
  assert.deepEqual(written, []);
});
