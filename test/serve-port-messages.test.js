'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runServeCommand } = require('../src/cli/serve');
const { describeListenError } = require('../src/serve/server');

/*
 * QA F06 (messages only, exit code stays 1): --port abc used to print Node's raw
 * "options.port should be >= 0 and < 65536" text; port 80 without rights printed a raw EACCES.
 */

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-port-msg-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n');
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'index.html'), '<html></html>');
  const cfg = path.join(root, 'config.toml');
  fs.writeFileSync(cfg, ['config_version = 1', 'default_campaign = "t"', '', '[campaigns.t]', `vault = '${vault}'`, `output = '${out}'`, ''].join('\n'));
  return { root, cfg };
}

for (const [label, port, shown] of [
  ['letters', 'abc', 'you gave "abc"'],
  ['too big', '99999', 'you gave "99999"'],
  ['negative', '-5', 'you gave "-5"'],
  ['decimal', '80.5', 'you gave "80.5"'],
  ['no value', true, 'needs a value'],
]) {
  test(`F06: --port ${label} gives a plain message, exit code 1, and never starts a server`, async () => {
    const { root, cfg } = scratch();
    try {
      let started = false;
      const r = await runServeCommand({ config: cfg, port }, 't', {
        emit: () => {},
        startServer: async () => {
          started = true;
          throw new Error('should not start');
        },
      });
      assert.equal(r.exitCode, 1);
      assert.ok(r.human.startsWith('--port must be a whole number from 0 to 65535'), r.human);
      assert.ok(r.human.includes(shown), r.human);
      assert.ok(!r.human.includes('options.port'), r.human);
      assert.equal(started, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('F06: port 0 and 65535 are still accepted', async () => {
  const { root, cfg } = scratch();
  try {
    for (const port of ['0', '65535']) {
      const seen = [];
      const { EventEmitter } = require('events');
      const signals = new EventEmitter();
      const p = runServeCommand({ config: cfg, port }, 't', {
        emit: () => {},
        startServer: async (_o, { port: got }) => {
          seen.push(got);
          return { server: { close: (cb) => cb && cb() }, port: got };
        },
        signals,
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      signals.emit('SIGINT');
      await p;
      assert.deepEqual(seen, [Number(port)]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F06: listen failures map to plain English; unknown errors pass through unchanged', () => {
  assert.equal(
    describeListenError({ code: 'EACCES' }, 80, '127.0.0.1').message,
    'port 80 needs administrator rights on this computer; try a port above 1024, for example 8081',
  );
  assert.equal(describeListenError({ code: 'EADDRINUSE' }, 8080, '127.0.0.1').message, 'port 8080 is already in use on 127.0.0.1');
  const other = Object.assign(new Error('weird'), { code: 'EOTHER' });
  assert.equal(describeListenError(other, 1, 'x'), other);
});
