'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUpdateCommand } = require('../src/cli/update');
const { UPDATE_TMP_PREFIX, OWNER_MARKER_FILENAME } = require('../src/update/replace');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * P5a-FR07 (closes F8): `update` must refuse with UPDATE_PREREQUISITE (exit 4) whenever
 * process.pkg is undefined -- i.e. whenever it is run from source, on every platform --
 * before any network call or file effect. src/update/verify.js:41's own comment on the
 * consequence: running from source would replace process.execPath (`node` itself), not
 * Scriptorium.
 *
 * These tests never build or run a packaged binary: `isPkg` is injected (default:
 * `typeof process.pkg !== 'undefined'`), exactly the way src/generator/bootstrap.js and
 * src/util/notices.js already gate their own pkg-only behaviour.
 */

function makeScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A scratch <root>/exe/<exeName> and <root>/tmp, both real directories on disk. */
function makeExeAndTmp(root, exeName = 'scriptorium.exe') {
  const exeDir = path.join(root, 'exe');
  fs.mkdirSync(exeDir);
  const execPath = path.join(exeDir, exeName);
  fs.writeFileSync(execPath, 'stub-current-binary');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(tmpRoot);
  return { exeDir, execPath, tmpRoot };
}

test('P5a-FR07: isPkg:false refuses with UPDATE_PREREQUISITE (exit 4) and names why', () => {
  const root = makeScratch('scriptorium-guard-t1-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const result = runUpdateCommand({}, { execPath, tmpRoot, platform: 'win32', isPkg: false });

    assert.equal(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE);
    assert.match(result.human, /packaged/i);
    assert.match(result.human, /source/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P5a-FR07: isPkg:false fires on win32, linux and darwin alike (platform-independent)', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const root = makeScratch(`scriptorium-guard-t2-${platform}-`);
    try {
      const { execPath, tmpRoot } = makeExeAndTmp(root);
      const result = runUpdateCommand({}, { execPath, tmpRoot, platform, isPkg: false });
      assert.equal(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE, `platform=${platform}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('P5a-FR07: the default isPkg wiring (no override, plain unpackaged node) refuses at exit 4', () => {
  // No requireGh/fetchLatestRelease/etc supplied either: if the guard did not fire here, the
  // REAL requireGh would run next and this test's result would depend on this box's gh
  // installation state rather than on the guard. Asserting the guard's own distinctive message
  // (not just the exit code) rules that out.
  const root = makeScratch('scriptorium-guard-t3-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const result = runUpdateCommand({}, { execPath, tmpRoot });

    assert.equal(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE);
    assert.match(result.human, /packaged GM-Scriptorium executable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P5a-FR07: the guard fires before any sweep (file effect) or network call', () => {
  const root = makeScratch('scriptorium-guard-t4-');
  try {
    const { exeDir, execPath, tmpRoot } = makeExeAndTmp(root);

    // Seed exactly the artefacts sweepOldExecutables/sweepStaleUpdateDirs would remove if they
    // ran (mirroring test/update-cleanup.test.js's AC-24-03 fixture): a dead-owner temp dir and
    // a legacy `.old-*` sibling. If either sweep ran, one of these would be gone afterward.
    const staleOld = `${execPath}.old-0.1.0`;
    fs.writeFileSync(staleOld, 'stale');
    const deadDir = path.join(tmpRoot, `${UPDATE_TMP_PREFIX}dead`);
    fs.mkdirSync(deadDir);
    fs.writeFileSync(path.join(deadDir, OWNER_MARKER_FILENAME), '999999999');

    let requireGhCalled = false;
    const result = runUpdateCommand(
      {},
      {
        execPath,
        tmpRoot,
        platform: 'win32',
        isPkg: false,
        requireGh: () => {
          requireGhCalled = true;
          return '/usr/bin/gh';
        },
      },
    );

    assert.equal(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE);
    assert.equal(requireGhCalled, false, 'requireGh (the first network-adjacent call) must never run');
    assert.equal(fs.existsSync(staleOld), true, 'sweepOldExecutables must not have run');
    assert.equal(fs.existsSync(deadDir), true, 'sweepStaleUpdateDirs must not have run');
    assert.deepEqual(fs.readdirSync(exeDir).sort(), [path.basename(execPath), path.basename(staleOld)].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P5a-FR07: isPkg:true lets the run proceed past the guard (positive control)', () => {
  const root = makeScratch('scriptorium-guard-t5-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);

    const result = runUpdateCommand(
      {},
      {
        execPath,
        tmpRoot,
        platform: 'win32',
        isPkg: true,
        requireGh: () => '/usr/bin/gh',
        fetchLatestRelease: () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/releases/v9.9.9' }),
        downloadAsset: (ghPath, tag, pattern, dir) => {
          fs.writeFileSync(path.join(dir, pattern), Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
        },
        verifyDownload: () => {},
        replaceExecutable: (execPathArg, stagedPath, oldVersion) => ({ oldPath: `${execPathArg}.old-${oldVersion}` }),
      },
    );

    // Proceeding past the guard means the real flow ran and reached its own (unrelated) result;
    // exit 4 here would mean the guard swallowed a legitimate packaged run.
    assert.notEqual(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE);
    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.match(result.human, /^updated /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
