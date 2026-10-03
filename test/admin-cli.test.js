'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { parseArgv } = require('../src/cli/args');
const { runServeCommand } = require('../src/cli/serve');
const { ConfigError } = require('../src/util/errors');
const { VaultUnreachableError } = require('../src/util/errors');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { createAdminContext } = require('../src/admin/context');

/*
 * Phase 8 slice S1 (docs/agent-runs/admin-s1-engineering-brief-2026-09-28.md,
 * "Test-first order" item 2). Synthetic cast only (NFR-10/NFR-11).
 */

function writeAdminFixtureOnDisk(root, { withVaultConfig = true } = {}) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n',
  );

  if (withVaultConfig) {
    fs.mkdirSync(path.join(vaultPath, '_meta', 'scriptorium'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, '_meta', 'scriptorium', 'vault.config.json'),
      JSON.stringify({ siteTitle: 'Alpha Test' }, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(vaultPath, '_meta', 'scriptorium', 'pack.toml'), 'theme = "plain"\n');
  }

  const outputPath = path.join(root, 'out'); // deliberately never created (A3)

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      'default_campaign = "alpha"',
      '',
      '[campaigns.alpha]',
      `vault = '${vaultPath}'`,
      `output = '${outputPath}'`,
      '',
    ].join('\n'),
  );
  return { vaultPath, outputPath, configPath };
}

async function withAdminFixture(fn, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-admin-cli-'));
  try {
    return await fn(writeAdminFixtureOnDisk(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fakeListenerFactory(ports) {
  let call = 0;
  const log = [];
  const fn = async (handler, opts) => {
    const port = ports[call] !== undefined ? ports[call] : opts.port;
    call += 1;
    log.push({ handler, opts, port });
    return {
      server: {},
      port,
      close: async () => {
        log.push({ closed: port });
      },
    };
  };
  fn.log = log;
  return fn;
}

function waitForMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- A1 --------------------------------------------------------------------

test('A1: parseArgv(["serve","--admin","alpha"]) gives flags.admin===true and positional ["serve","alpha"]', () => {
  const { _, flags } = parseArgv(['serve', '--admin', 'alpha']);
  assert.equal(flags.admin, true);
  assert.deepEqual(_, ['serve', 'alpha']);
});

// --- A2: allowlist -----------------------------------------------------------

test('A2: the flag allowlist refuses every disallowed flag with an exact ConfigError, calling neither listener starter nor startServer', async () => {
  await withAdminFixture(async ({ configPath }) => {
    const cases = [
      { flags: { host: '0.0.0.0' }, message: 'serve --admin does not accept --host; remote access comes only from saved settings (see "scriptorium remote")' },
      { flags: { host: '127.0.0.1' }, message: 'serve --admin does not accept --host; remote access comes only from saved settings (see "scriptorium remote")' },
      { flags: { host: true }, message: 'serve --admin does not accept --host; remote access comes only from saved settings (see "scriptorium remote")' },
      { flags: { build: true }, message: 'serve --admin does not accept --build' },
      { flags: { out: '/x' }, message: 'serve --admin does not accept --out' },
      { flags: { 'site-config': '/x.json' }, message: 'serve --admin does not accept --site-config' },
      { flags: { 'host=0.0.0.0': true }, message: 'serve --admin does not accept --host; remote access comes only from saved settings (see "scriptorium remote")' },
      { flags: { force: true }, message: 'serve --admin does not accept --force' },
    ];

    for (const { flags: extra, message } of cases) {
      const log = [];
      const startServer = async (...args) => {
        log.push({ type: 'startServer', args });
        throw new Error('must not be called');
      };
      const startLocalListener = async (...args) => {
        log.push({ type: 'startLocalListener', args });
        throw new Error('must not be called');
      };
      const emitted = [];
      const emit = (line) => emitted.push(line);

      await assert.rejects(
        () =>
          runServeCommand({ config: configPath, admin: true, ...extra }, 'alpha', {
            emit,
            startServer,
            startLocalListener,
            signals: new EventEmitter(),
          }),
        (err) => err instanceof ConfigError && err.message === message,
      );
      assert.deepEqual(log, [], `expected no listener/startServer calls for ${JSON.stringify(extra)}`);
      assert.deepEqual(emitted, [], `expected no emit calls for ${JSON.stringify(extra)}`);
    }

    // Positive control: {config, admin:true} calls startLocalListener twice.
    const startLocalListener = fakeListenerFactory([40001, 40002]);
    const signals = new EventEmitter();
    const resultPromise = runServeCommand({ config: configPath, admin: true }, 'alpha', {
      emit: () => {},
      startLocalListener,
      signals,
    });
    await waitForMacrotask();
    signals.emit('SIGINT');
    await resultPromise;
    assert.equal(startLocalListener.log.filter((e) => e.opts).length, 2);
  });
});

// --- A3: launch preconditions ------------------------------------------------

test('A3: launch succeeds with the configured output absent', async () => {
  await withAdminFixture(async ({ configPath }) => {
    const startLocalListener = fakeListenerFactory([40001, 40002]);
    const signals = new EventEmitter();
    const emitted = [];
    const resultPromise = runServeCommand({ config: configPath, admin: true }, 'alpha', {
      emit: (l) => emitted.push(l),
      startLocalListener,
      signals,
    });
    await waitForMacrotask();
    assert.equal(emitted.length, 3);
    signals.emit('SIGINT');
    const result = await resultPromise;
    assert.equal(result.exitCode, EXIT_CODES.OK);
  });
});

test('A3: E-NONE — no site config anywhere — rejects with the exact message, listener never called', async () => {
  await withAdminFixture(
    async ({ configPath, vaultPath }) => {
      const conventionDir = path.join(vaultPath, '_meta', 'scriptorium');
      const conventionJson = path.join(conventionDir, 'vault.config.json');
      const log = [];
      const startLocalListener = async (...args) => {
        log.push(args);
        throw new Error('must not be called');
      };
      await assert.rejects(
        () => runServeCommand({ config: configPath, admin: true }, 'alpha', { emit: () => {}, startLocalListener, signals: new EventEmitter() }),
        (err) =>
          err instanceof VaultUnreachableError &&
          err.message ===
            `campaign "alpha" has no site config: site_config is not set, pack is not set, and ${conventionJson} does not exist. ` +
              'Run "gm-scriptorium init" to create one, or set site_config or pack on the campaign.',
      );
      assert.deepEqual(log, []);
    },
    { withVaultConfig: false },
  );
});

test('A3: E-CONV — convention dir exists but has no vault.config.json — rejects with the exact message', async () => {
  await withAdminFixture(
    async ({ configPath, vaultPath }) => {
      const conventionDir = path.join(vaultPath, '_meta', 'scriptorium');
      fs.mkdirSync(conventionDir, { recursive: true });
      await assert.rejects(
        () => runServeCommand({ config: configPath, admin: true }, 'alpha', { emit: () => {}, signals: new EventEmitter() }),
        (err) =>
          err instanceof VaultUnreachableError &&
          err.message === `campaign "alpha": ${conventionDir} exists but has no vault.config.json`,
      );
    },
    { withVaultConfig: false },
  );
});

test('A3: E-PACKDIR — an explicit --config pack pointing at a missing directory — rejects with the exact message', async () => {
  await withAdminFixture(async ({ vaultPath, configPath }) => {
    const packDir = path.join(vaultPath, 'nonexistent-pack');
    const configText = fs.readFileSync(configPath, 'utf8').replace(
      /\[campaigns\.alpha\]\n/,
      `[campaigns.alpha]\npack = '${packDir}'\n`,
    );
    fs.writeFileSync(configPath, configText);
    await assert.rejects(
      () => runServeCommand({ config: configPath, admin: true }, 'alpha', { emit: () => {}, signals: new EventEmitter() }),
      (err) =>
        err instanceof VaultUnreachableError && err.message === `campaign "alpha": pack directory does not exist: ${packDir}`,
    );
  });
});

test('A3: E-PACKJSON — pack dir exists but has no vault.config.json — rejects with the exact message', async () => {
  await withAdminFixture(async ({ vaultPath, configPath }) => {
    const packDir = path.join(vaultPath, 'empty-pack');
    fs.mkdirSync(packDir, { recursive: true });
    const configText = fs.readFileSync(configPath, 'utf8').replace(
      /\[campaigns\.alpha\]\n/,
      `[campaigns.alpha]\npack = '${packDir}'\n`,
    );
    fs.writeFileSync(configPath, configText);
    await assert.rejects(
      () => runServeCommand({ config: configPath, admin: true }, 'alpha', { emit: () => {}, signals: new EventEmitter() }),
      (err) =>
        err instanceof VaultUnreachableError &&
        err.message === `campaign "alpha": pack directory ${packDir} has no vault.config.json`,
    );
  });
});

test('A3: a missing vault rejects with VaultUnreachableError, listener never called', async () => {
  await withAdminFixture(async ({ configPath, vaultPath }) => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
    const log = [];
    const startLocalListener = async (...args) => {
      log.push(args);
      throw new Error('must not be called');
    };
    await assert.rejects(
      () => runServeCommand({ config: configPath, admin: true }, 'alpha', { emit: () => {}, startLocalListener, signals: new EventEmitter() }),
      (err) => err instanceof VaultUnreachableError,
    );
    assert.deepEqual(log, []);
  });
});

// --- A4: startup output ------------------------------------------------------

test('A4: startup lines, port defaulting, token shape, SIGINT shutdown', async () => {
  await withAdminFixture(async ({ configPath }) => {
    const startLocalListener = fakeListenerFactory([40001, 40002]);
    const signals = new EventEmitter();
    const emitted = [];

    const resultPromise = runServeCommand({ config: configPath, admin: true, port: '40001' }, 'alpha', {
      emit: (l) => emitted.push(l),
      startLocalListener,
      signals,
    });
    await waitForMacrotask();

    assert.equal(startLocalListener.log[0].opts.port, 40001);
    assert.equal(startLocalListener.log[1].opts.port, 0);

    assert.equal(emitted.length, 3);
    assert.match(emitted[0], /^admin panel: http:\/\/127\.0\.0\.1:40001\/auth\?token=([A-Za-z0-9_-]{43})$/);
    const token = emitted[0].match(/token=([A-Za-z0-9_-]{43})$/)[1];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(emitted[1], 'preview: http://127.0.0.1:40002/');
    assert.equal(emitted[2], 'open the admin panel link in your browser. Press Ctrl-C to stop.');

    signals.emit('SIGINT');
    const result = await resultPromise;
    assert.deepEqual(result, { exitCode: EXIT_CODES.OK, human: 'stopped.' });
    assert.equal(emitted.length, 3, 'emit must be called exactly 3 times total');
    assert.ok(startLocalListener.log.some((e) => e.closed === 40001));
    assert.ok(startLocalListener.log.some((e) => e.closed === 40002));
  });
});

test('A4: --port absent means the admin listener asks for port 0', async () => {
  await withAdminFixture(async ({ configPath }) => {
    const startLocalListener = fakeListenerFactory([40001, 40002]);
    const signals = new EventEmitter();
    const resultPromise = runServeCommand({ config: configPath, admin: true }, 'alpha', {
      emit: () => {},
      startLocalListener,
      signals,
    });
    await waitForMacrotask();
    assert.equal(startLocalListener.log[0].opts.port, 0);
    signals.emit('SIGINT');
    await resultPromise;
  });
});

// --- A5: failure paths ---------------------------------------------------

test('A5: admin EADDRINUSE gives exit 1, preview never started', async () => {
  await withAdminFixture(async ({ configPath }) => {
    const log = [];
    const startLocalListener = async (handler, opts) => {
      log.push(opts);
      throw new Error('port 40001 is already in use on 127.0.0.1');
    };
    const result = await runServeCommand({ config: configPath, admin: true, port: '40001' }, 'alpha', {
      emit: () => {},
      startLocalListener,
      signals: new EventEmitter(),
    });
    assert.deepEqual(result, {
      exitCode: EXIT_CODES.SCRIPTORIUM_ERROR,
      human: 'failed to start server: port 40001 is already in use on 127.0.0.1',
    });
    assert.equal(log.length, 1);
  });
});

test('A5: a preview failure calls the admin close()', async () => {
  await withAdminFixture(async ({ configPath }) => {
    let adminClosed = false;
    const startLocalListener = async (handler, opts) => {
      if (opts.port === 40001) {
        return { server: {}, port: 40001, close: async () => { adminClosed = true; } };
      }
      throw new Error('preview boom');
    };
    const result = await runServeCommand({ config: configPath, admin: true, port: '40001' }, 'alpha', {
      emit: () => {},
      startLocalListener,
      signals: new EventEmitter(),
    });
    assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR);
    assert.match(result.human, /^failed to start server: preview boom$/);
    assert.equal(adminClosed, true);
  });
});

// --- A6: --port validation -----------------------------------------------

test('A6: --port abc, 0, 65536 and bare --port each give the exact ConfigError', async () => {
  await withAdminFixture(async ({ configPath }) => {
    for (const portFlag of ['abc', '0', '65536', true]) {
      await assert.rejects(
        () =>
          runServeCommand({ config: configPath, admin: true, port: portFlag }, 'alpha', {
            emit: () => {},
            signals: new EventEmitter(),
          }),
        (err) => err instanceof ConfigError && err.message === 'serve --admin: --port must be a whole number from 1 to 65535',
      );
    }
  });
});

// --- A7: writable / readOnlyReason ----------------------------------------

test('A7: createAdminContext computes writable/readOnlyReason for each site source', () => {
  const base = { ctxInfo: { campaign: 'alpha' }, vaultPath: '/v', token: 'tok' };

  const convention = createAdminContext({ ...base, site: { siteSource: 'convention', siteConfigPath: '/v/_meta/scriptorium/vault.config.json', siteDir: '/v/_meta/scriptorium' } });
  assert.equal(convention.writable, true);
  assert.equal(convention.readOnlyReason, null);

  const pack = createAdminContext({ ...base, site: { siteSource: 'pack', siteConfigPath: '/pack/vault.config.json', siteDir: '/pack' } });
  assert.equal(pack.writable, false);
  assert.match(pack.readOnlyReason, /^This campaign's pack key points at a folder of its own,/);

  const siteConfig = createAdminContext({ ...base, site: { siteSource: 'site_config', siteConfigPath: '/x/site.json', siteDir: '/x' } });
  assert.equal(siteConfig.writable, false);
  assert.match(siteConfig.readOnlyReason, /^This campaign builds from a site_config file,/);
});

// --- A8: no leaked SIGINT listener -----------------------------------------

test('no test above registered a SIGINT listener on the real process', () => {
  assert.equal(process.listenerCount('SIGINT'), 0);
});
