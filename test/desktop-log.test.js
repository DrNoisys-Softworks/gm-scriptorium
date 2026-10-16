'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installLoopbackGuard } = require('./helpers/net-stubs');

const { createDesktopLog, scrub, LOG_EVENTS } = require('../src/desktop/log');
const { createToken } = require('../src/admin/session');
const { createLaunchCodeStore } = require('../src/launch/codes');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * ADR 0057, section 9: the desktop log. A closed list of events, scrubbed values, an owner-only file
 * in an owner-only folder, rotation at a size, and no throw to the caller. The expected line shapes
 * are written out here, not read back from the module.
 */

const POSIX = process.platform !== 'win32';
const FIXED = Date.UTC(2026, 9, 14, 1, 2, 3, 456);

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-dlog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

test('the event list is exactly the eleven in ADR 0057 section 9, and frozen', () => {
  assert.deepEqual([...LOG_EVENTS], ['host-start', 'panel-starting', 'panel-running', 'panel-stopped', 'panel-error', 'panel-warning', 'retry', 'op', 'quit', 'exit', 'uncaught']);
  assert.ok(Object.isFrozen(LOG_EVENTS));
});

test('a line is "<ISO time> <event> k=v ..." with JSON-quoted values, in <dir>/desktop.log', (t) => {
  const dir = path.join(scratch(t), 'panel', 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED });
  log.event('panel-error', { kind: 'port', message: 'port 1 is "busy"', port: 7 });
  assert.deepEqual(lines(path.join(dir, 'desktop.log')), ['2026-10-14T01:02:03.456Z panel-error kind="port" message="port 1 is \\"busy\\"" port="7"']);
  assert.equal(log.dir, dir);
});

test('lines are appended, not overwritten, and an event with no fields is just the time and the name', (t) => {
  const dir = path.join(scratch(t), 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED });
  log.event('host-start', {});
  log.event('quit');
  assert.deepEqual(lines(path.join(dir, 'desktop.log')), ['2026-10-14T01:02:03.456Z host-start', '2026-10-14T01:02:03.456Z quit']);
});

test('an unknown event name is dropped, and so is a field with an odd name', (t) => {
  const dir = path.join(scratch(t), 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED });
  log.event('made-up', { a: 1 });
  log.event('op', { name: 'stop', 'bad key': 'x', 'Also Bad': 'y' });
  assert.deepEqual(lines(path.join(dir, 'desktop.log')), ['2026-10-14T01:02:03.456Z op name="stop"']);
});

test('control characters become spaces and a long value is cut, so a value can never make a second line', (t) => {
  const dir = path.join(scratch(t), 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED });
  log.event('panel-warning', { text: 'one\ntwo\r\nthree\tfour' });
  log.event('panel-warning', { text: 'word '.repeat(400) });
  const out = lines(path.join(dir, 'desktop.log'));
  assert.equal(out.length, 2);
  assert.equal(out[0], '2026-10-14T01:02:03.456Z panel-warning text="one two three four"');
  assert.ok(out[1].length < 600, `a cut line, got ${out[1].length}`);
  assert.ok(out[1].endsWith('..."'));
});

test('scrub: a real session token and a real launch code are removed, and so is anything after token=, code=, password or cookie', () => {
  const token = createToken();
  const code = createLaunchCodeStore().mint();
  assert.equal(token.length, 43);
  assert.equal(code.length, 43);
  for (const secret of [token, code]) {
    const out = scrub(`opened http://127.0.0.1:7400/auth?x=${secret} done`);
    assert.ok(!out.includes(secret), out);
    assert.match(out, /\[redacted\]/);
  }
  assert.equal(scrub('see token=abc123 now'), 'see [redacted] now');
  assert.equal(scrub('see CODE=abc123 now'), 'see [redacted] now');
  assert.equal(scrub('Password: hunter2 ok'), '[redacted] ok');
  assert.equal(scrub('a cookie=scriptorium_admin_7400=xyz; Path=/'), 'a [redacted] Path=/');
  assert.equal(scrub('plain words only'), 'plain words only');
  assert.equal(scrub('a 42-char run stays: ' + 'a'.repeat(42)), 'a 42-char run stays: ' + 'a'.repeat(42));
  assert.equal(scrub('a 43-char run goes: ' + 'a'.repeat(43)), 'a 43-char run goes: [redacted]');
});

test('the file on disk never holds a real token or code passed in any field', (t) => {
  const dir = path.join(scratch(t), 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED });
  const token = createToken();
  const code = createLaunchCodeStore().mint();
  log.event('panel-warning', { text: `url ?token=${token}` });
  log.event('panel-error', { kind: 'other', message: `bad ${code}` });
  log.event('op', { name: token, extra: code });
  const text = fs.readFileSync(path.join(dir, 'desktop.log'), 'utf8');
  assert.equal(text.split(token).length - 1, 0);
  assert.equal(text.split(code).length - 1, 0);
  assert.equal(lines(path.join(dir, 'desktop.log')).length, 3);
});

test('POSIX: the file is 0600 and a new folder is 0700, both set at creation', { skip: !POSIX && 'POSIX modes only' }, (t) => {
  const dir = path.join(scratch(t), 'panel', 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED });
  log.event('host-start', {});
  assert.equal(fs.statSync(path.join(dir, 'desktop.log')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('rotation: at maxBytes the file moves to desktop.log.1 and a new desktop.log starts; an older .1 is replaced', (t) => {
  const dir = path.join(scratch(t), 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED, maxBytes: 200 });
  const main = path.join(dir, 'desktop.log');
  let n = 0;
  while (!fs.existsSync(`${main}.1`) && n < 50) log.event('op', { name: `n${n++}` });
  assert.ok(fs.existsSync(`${main}.1`), 'rotated');
  assert.ok(fs.statSync(`${main}.1`).size >= 200, 'the rotated file reached the limit');
  assert.ok(lines(main).length <= 1, 'a fresh file');
  const firstRotated = fs.readFileSync(`${main}.1`, 'utf8');
  while (fs.readFileSync(`${main}.1`, 'utf8') === firstRotated && n < 200) log.event('op', { name: `n${n++}` });
  assert.notEqual(fs.readFileSync(`${main}.1`, 'utf8'), firstRotated, 'the second rotation replaced the first');
  assert.ok(!fs.existsSync(`${main}.2`));
});

test('below maxBytes nothing rotates', (t) => {
  const dir = path.join(scratch(t), 'logs');
  const log = createDesktopLog({ dir, now: () => FIXED });
  for (let i = 0; i < 20; i++) log.event('op', { name: 'x' });
  assert.equal(lines(path.join(dir, 'desktop.log')).length, 20);
  assert.ok(!fs.existsSync(path.join(dir, 'desktop.log.1')));
});

test('it never throws to the caller: a folder that cannot be made, or a log path that is a folder', (t) => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'afile'), 'x');
  const blocked = createDesktopLog({ dir: path.join(root, 'afile', 'logs'), now: () => FIXED });
  assert.doesNotThrow(() => blocked.event('host-start', {}));
  const dir = path.join(root, 'logs');
  fs.mkdirSync(path.join(dir, 'desktop.log'), { recursive: true });
  const asFolder = createDesktopLog({ dir, now: () => FIXED });
  assert.doesNotThrow(() => asFolder.event('host-start', {}));
  const badClock = createDesktopLog({ dir: path.join(root, 'other'), now: () => NaN });
  assert.doesNotThrow(() => badClock.event('host-start', {}));
});
