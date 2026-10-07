'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { runServeCommand } = require('../src/cli/serve');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * Issue #25: `serve` accumulated its warnings in a local array and only
 * printed them from inside the SIGINT handler, so nothing reached stdout
 * between process start and Ctrl-C (docs/decisions/0002-serve-binds-
 * localhost.md:7-9 requires the --host warning "before starting"). These
 * tests exercise the injected `emit`/`startServer`/`runBuild`/`signals` seam
 * (src/cli/serve.js's new options-object DI) to assert ORDERING, not just
 * presence: the --host warning string already existed in the output before
 * this fix (before AND after Ctrl-C), so a test that only checks it is
 * somewhere in the combined output proves nothing. Every ordering assertion
 * below uses ONE shared log array that both `emit` and `startServer`
 * push onto, so the index comparison is meaningful.
 *
 * A minimal on-disk campaign (config.toml + a bare vault) is used instead of
 * a hand-built ctx, the same way test/build-output-gate.test.js's
 * writeGateVaultOnDisk exercises the real production call site
 * (resolveCampaignContext -> locateVault) rather than bypassing it.
 */

function writeServeFixtureOnDisk(root, { withOutput = true } = {}) {
  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    '---\ntype: meta\npublish:\n  mode: player\n---\n\n# Vault config\n',
  );

  const outputPath = path.join(root, 'out');
  if (withOutput) {
    fs.mkdirSync(outputPath, { recursive: true });
    fs.writeFileSync(path.join(outputPath, 'index.html'), '<html></html>');
  }

  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      'default_campaign = "servetest"',
      '',
      '[campaigns.servetest]',
      `vault = '${vaultPath}'`,
      `output = '${outputPath}'`,
      '',
    ].join('\n'),
  );
  return { vaultPath, outputPath, configPath };
}

async function withServeFixture(fn, opts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-serve-'));
  try {
    return await fn(writeServeFixtureOnDisk(root, opts), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A fake `server.close(cb)` that invokes cb synchronously, per the interface
// contract (Engineering Brief: "A fake must resolve { server } where
// server.close(cb) invokes cb").
function fakeServerHandle() {
  return { close: (cb) => cb() };
}

// One microtask turn is not enough to guarantee runServeCommand has reached
// the SIGINT registration (it awaits startServer first); a macrotask tick
// is deliberately used so every microtask queued along the way has drained.
function waitForMacrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- AC-25-01: the --host warning precedes startServer, on a shared log ----

test('AC-25-01: the --host warning is emitted strictly before startServer is called', { timeout: 5000 }, async () => {
  await withServeFixture(async ({ configPath }) => {
    const order = [];
    const emit = (line) => order.push({ type: 'emit', line });
    const startServer = async () => {
      order.push({ type: 'startServer' });
      return { server: fakeServerHandle() };
    };
    const signals = new EventEmitter();

    const resultPromise = runServeCommand({ config: configPath, host: '0.0.0.0' }, 'servetest', {
      emit,
      startServer,
      signals,
    });

    await waitForMacrotask();
    signals.emit('SIGINT');
    const result = await resultPromise;
    assert.equal(result.exitCode, EXIT_CODES.OK);

    const warningIdx = order.findIndex((e) => e.type === 'emit' && /--host 0\.0\.0\.0 exposes/.test(e.line));
    const startIdx = order.findIndex((e) => e.type === 'startServer');
    assert.ok(warningIdx !== -1, 'expected the --host warning to have been emitted');
    assert.ok(startIdx !== -1, 'expected startServer to have been called');
    assert.ok(
      warningIdx < startIdx,
      `--host warning (log index ${warningIdx}) must be emitted before startServer is called (log index ${startIdx})`,
    );
  });
});

// --- AC-25-02: the serving line is emitted while the promise is still pending --

test(
  'AC-25-02: the serving line is emitted before the returned promise settles (proven by racing a resolved sentinel)',
  { timeout: 5000 },
  async () => {
    await withServeFixture(async ({ configPath }) => {
      const emitted = [];
      const emit = (line) => emitted.push(line);
      const startServer = async () => ({ server: fakeServerHandle() });
      const signals = new EventEmitter(); // SIGINT deliberately never fired in this test

      const resultPromise = runServeCommand({ config: configPath }, 'servetest', { emit, startServer, signals });

      await waitForMacrotask();
      assert.ok(
        emitted.some((line) => /^serving .* \(Ctrl-C to stop\)$/.test(line)),
        'expected the serving line to already have been emitted',
      );

      const sentinel = Symbol('sentinel');
      const winner = await Promise.race([resultPromise, Promise.resolve(sentinel)]);
      assert.equal(
        winner,
        sentinel,
        'the returned promise must still be pending here: it only settles on SIGINT, which this test never fires',
      );
    });
  },
);

// --- AC-25-03: with --build, the build summary precedes startServer --------

test('AC-25-03: with --build, the build summary is emitted before startServer is called', { timeout: 5000 }, async () => {
  await withServeFixture(async ({ configPath }) => {
    const order = [];
    const emit = (line) => order.push({ type: 'emit', line });
    const runBuild = () => {
      order.push({ type: 'runBuild' });
      return { exitCode: EXIT_CODES.OK, human: 'BUILD SUMMARY: 3 page(s) rendered' };
    };
    const startServer = async () => {
      order.push({ type: 'startServer' });
      return { server: fakeServerHandle() };
    };
    const signals = new EventEmitter();

    const resultPromise = runServeCommand({ config: configPath, build: true }, 'servetest', {
      emit,
      runBuild,
      startServer,
      signals,
    });

    await waitForMacrotask();
    signals.emit('SIGINT');
    await resultPromise;

    const buildEmitIdx = order.findIndex((e) => e.type === 'emit' && /BUILD SUMMARY/.test(e.line));
    const startIdx = order.findIndex((e) => e.type === 'startServer');
    assert.ok(buildEmitIdx !== -1, 'expected the build summary to have been emitted');
    assert.ok(startIdx !== -1, 'expected startServer to have been called');
    assert.ok(buildEmitIdx < startIdx, 'the build summary must be emitted before startServer is called');
  });
});

// --- AC-25-04: no duplication -----------------------------------------------

test(
  'AC-25-04: after a clean shutdown, the union of everything emitted plus human contains each line exactly once',
  { timeout: 5000 },
  async () => {
    await withServeFixture(async ({ configPath }) => {
      const emitted = [];
      const emit = (line) => emitted.push(line);
      const runBuild = () => ({ exitCode: EXIT_CODES.OK, human: 'BUILD SUMMARY: 3 page(s) rendered' });
      const startServer = async () => ({ server: fakeServerHandle() });
      const signals = new EventEmitter();

      const resultPromise = runServeCommand({ config: configPath, build: true, host: '0.0.0.0' }, 'servetest', {
        emit,
        runBuild,
        startServer,
        signals,
      });

      await waitForMacrotask();
      signals.emit('SIGINT');
      const result = await resultPromise;
      assert.equal(result.exitCode, EXIT_CODES.OK);

      // This scenario (--build, --host, a successful startServer, a clean
      // SIGINT shutdown) has exactly three lines that must reach stdout
      // before Ctrl-C per ADR 0002 and AC-25-01/02/03: the build summary,
      // the --host risk warning, and the serving line. Asserting emit's
      // call count directly, not just what ends up somewhere in the
      // combined output, is what catches an implementation that falls back
      // to accumulating those lines in a local array and only joining them
      // into `human` at shutdown: emit would never be called, emitted
      // would stay empty, and a containment check alone would not notice
      // because `human` still contains each line once.
      assert.equal(
        emitted.length,
        3,
        'emit must have been called exactly 3 times (build summary, --host warning, serving line) before shutdown',
      );

      const combinedText = [...emitted, result.human].join('\n');
      const countOf = (needle) => combinedText.split(needle).length - 1;

      assert.equal(countOf('BUILD SUMMARY: 3 page(s) rendered'), 1, 'build summary must appear exactly once');
      assert.equal(countOf('WARNING: --host 0.0.0.0 exposes'), 1, '--host warning must appear exactly once');
      assert.equal(countOf('(Ctrl-C to stop)'), 1, 'the serving line must appear exactly once');
      assert.ok(
        !emitted.some((line) => line === result.human || (result.human && line.includes(result.human))),
        'human must not repeat a line that was already emitted',
      );
    });
  },
);

// --- AC-25-06: failure paths unchanged in message content -------------------

test('AC-25-06: no build exists — exit 3 with its own message, and nothing was emitted first', { timeout: 5000 }, async () => {
  await withServeFixture(
    async ({ configPath, outputPath }) => {
      const emitted = [];
      const emit = (line) => emitted.push(line);

      const result = await runServeCommand({ config: configPath }, 'servetest', { emit });

      assert.equal(result.exitCode, EXIT_CODES.VAULT_UNREACHABLE); // #108: a campaign problem
      assert.match(result.human, /^no build exists at /);
      assert.ok(result.human.includes(outputPath));
      assert.match(result.human, /run "gm-scriptorium build" first or pass --build/);
      assert.deepEqual(emitted, [], 'the no-build-exists path emits nothing before its own early return');
    },
    { withOutput: false },
  );
});

test(
  'AC-25-06: startServer failure — exit 1 naming the error, without re-emitting the already-emitted --host warning',
  { timeout: 5000 },
  async () => {
    await withServeFixture(async ({ configPath }) => {
      const emitted = [];
      const emit = (line) => emitted.push(line);
      const startServer = async () => {
        throw new Error('port 8080 is already in use on 0.0.0.0');
      };

      const result = await runServeCommand({ config: configPath, host: '0.0.0.0' }, 'servetest', {
        emit,
        startServer,
      });

      assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR);
      assert.equal(result.human, 'failed to start server: port 8080 is already in use on 0.0.0.0');
      assert.equal(emitted.length, 1, 'the --host warning must have been emitted exactly once, before the failed startServer call');
      assert.match(emitted[0], /^WARNING: --host 0\.0\.0\.0 exposes/);
      assert.ok(!result.human.includes('WARNING'), 'the catch path must not re-include an already-emitted warning');
    });
  },
);

// --- AC-25-05: bin/scriptorium.js prints no blank line when human is empty --
//
// Exercising this end to end would mean spawning a real network server and
// sending a real SIGINT to a child process — disproportionate for a
// one-line guard, and the DI seam this brief adds is scoped to
// src/cli/serve.js, not bin/scriptorium.js. Structural source check instead,
// the same pattern test/build-output-gate.test.js's AC-D2-18 test and
// test/leak-l4-rendered.test.js's AC-D3-01 test already use in this
// codebase for a "which exact code shape ran" guarantee.

test(
  'AC-25-05: bin/scriptorium.js guards the serve case the same way it already guards config, so human: "" prints no blank line',
  () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'scriptorium.js'), 'utf8');
    const serveCaseMatch = src.match(/case 'serve': \{[\s\S]*?\n {6}\}/);
    assert.ok(serveCaseMatch, 'expected to find the serve case block in bin/scriptorium.js');
    assert.match(
      serveCaseMatch[0],
      /if \(result\.human\) console\.log\(result\.human\);/,
      'the serve case must guard console.log the same way the config case does (bin/scriptorium.js), so an empty human prints nothing',
    );
  },
);

// --- AC-25-07: no new require of a forbidden network builtin ---------------

test('AC-25-07: src/cli/serve.js requires no network-capable builtin directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'serve.js'), 'utf8');
  const FORBIDDEN_NETWORK_BUILTINS = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'];
  for (const mod of FORBIDDEN_NETWORK_BUILTINS) {
    assert.doesNotMatch(
      src,
      new RegExp(`require\\(['"](node:)?${mod}['"]\\)`),
      `src/cli/serve.js must not require('${mod}') directly — network-builtin capability stays confined to src/serve/server.js`,
    );
  }
});

// --- Risk #3: no test above leaked a listener onto the real process --------

test('no test above registered a SIGINT listener on the real process (all drove shutdown through the injected signals seam)', () => {
  assert.equal(
    process.listenerCount('SIGINT'),
    0,
    'a real SIGINT listener here would leak across every other test file sharing this process under node --test',
  );
});
