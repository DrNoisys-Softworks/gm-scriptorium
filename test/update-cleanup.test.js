'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runUpdateCommand } = require('../src/cli/update');
const {
  UPDATE_TMP_PREFIX,
  OWNER_MARKER_FILENAME,
  LEGACY_MIN_AGE_MS,
  stagedExecutableName,
  sweepStaleUpdateDirs,
  sweepStaleStagedExecutables,
} = require('../src/update/replace');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { UpdatePrerequisiteError } = require('../src/util/errors');
const { NOTICES_FILENAME } = require('../src/util/notices');

const WIN_ASSET_PATTERN = 'scriptorium-win-x64.exe';
const MZ_HEADER = Buffer.from([0x4d, 0x5a, 0x00, 0x00]);

function makeScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A pid guaranteed to already be dead: spawnSync blocks until the child has fully exited before
 * returning, so the pid it reports is no longer live by the time this function returns.
 */
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number.parseInt(result.stdout, 10);
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

function baseDeps({ execPath, tmpRoot, extra = {} }) {
  return {
    execPath,
    platform: 'win32',
    tmpRoot,
    // P5a-FR07: runUpdateCommand now refuses at exit 4 unless isPkg is true. These are all
    // pre-existing tests of the rest of the flow (cleanup, sweeps, notices), so they opt into
    // the packaged branch here; test/update-packaged-guard.test.js covers the guard itself.
    isPkg: true,
    requireGh: () => '/usr/bin/gh',
    fetchLatestRelease: () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/releases/v9.9.9' }),
    downloadAsset: (ghPath, tag, pattern, dir) => {
      fs.writeFileSync(path.join(dir, pattern), MZ_HEADER);
    },
    verifyDownload: () => {},
    replaceExecutable: (execPathArg, stagedPath, oldVersion) => ({ oldPath: `${execPathArg}.old-${oldVersion}` }),
    ...extra,
  };
}

/** Content that discardNoticesBesideExecutable's own header/stamp check recognises as ours. */
function fakeNoticesContent(version = '0.2.2') {
  return [
    '='.repeat(20),
    'Scriptorium: Third-Party Notices',
    '='.repeat(20),
    '',
    `Scriptorium version: ${version}`,
    'Generated: 2020-01-01T00:00:00.000Z',
    '',
  ].join('\n');
}

// -- AC-24-01: a throwing verifyDownload leaves no temp dir behind --

test('AC-24-01: verifyDownload throwing exits 1 and leaves no scriptorium-update-* dir under tmpRoot', () => {
  const root = makeScratch('scriptorium-cleanup-t1-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = baseDeps({
      execPath,
      tmpRoot,
      extra: {
        verifyDownload: () => {
          throw new Error('checksum mismatch');
        },
      },
    });

    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR);
    const leftover = fs.readdirSync(tmpRoot).filter((e) => e.startsWith(UPDATE_TMP_PREFIX));
    assert.deepEqual(leftover, [], 'no scriptorium-update-* directory should remain under tmpRoot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- AC-24-02: a throwing replaceExecutable leaves no staged file behind --

test('AC-24-02: replaceExecutable throwing exits 1 and leaves no staged <exeName>-update-* file behind', () => {
  const root = makeScratch('scriptorium-cleanup-t2-');
  try {
    const { exeDir, execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = baseDeps({
      execPath,
      tmpRoot,
      extra: {
        replaceExecutable: () => {
          throw new Error('could not rename the running executable aside');
        },
      },
    });

    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR);
    const leftover = fs.readdirSync(exeDir).filter((e) => e.startsWith(`${path.basename(execPath)}-update-`));
    assert.deepEqual(leftover, [], 'no staged executable should remain in the exe directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- AC-24-03: a pre-seeded dead-owner temp dir is removed at the start of the next run --

test('AC-24-03: a pre-seeded dead-owner temp dir is removed at the start of the next run', () => {
  const root = makeScratch('scriptorium-cleanup-t3-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deadDir = path.join(tmpRoot, `${UPDATE_TMP_PREFIX}dead`);
    fs.mkdirSync(deadDir);
    fs.writeFileSync(path.join(deadDir, OWNER_MARKER_FILENAME), String(deadPid()));

    const deps = baseDeps({ execPath, tmpRoot });
    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.equal(fs.existsSync(deadDir), false, 'a dead-owner temp dir must be swept at the start of the next run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- AC-24-04: the concurrency guarantee --

test('AC-24-04: a pre-seeded live-owner temp dir survives a full run (the concurrency guarantee)', () => {
  const root = makeScratch('scriptorium-cleanup-t4-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const liveDir = path.join(tmpRoot, `${UPDATE_TMP_PREFIX}live`);
    fs.mkdirSync(liveDir);
    fs.writeFileSync(path.join(liveDir, OWNER_MARKER_FILENAME), String(process.pid));

    const deps = baseDeps({ execPath, tmpRoot });
    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.equal(
      fs.existsSync(liveDir),
      true,
      "a concurrently running update's staging directory must survive the sweep",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- AC-24-05: the legacy (marker-less) age threshold, driven by an injected now, not by waiting --

test('AC-24-05: a marker-less legacy temp dir survives under the age threshold and is removed past it', () => {
  // Hardcoded literal, independent of the constant used below: catches a mutation to
  // LEGACY_MIN_AGE_MS itself, which the relative before/after windows further down cannot (they
  // are derived from the same constant, so they would shift together with it).
  assert.equal(LEGACY_MIN_AGE_MS, 24 * 60 * 60 * 1000, 'the legacy age threshold must be exactly 24 hours');

  const tmpRoot = makeScratch('scriptorium-cleanup-t5-');
  try {
    const legacyDir = path.join(tmpRoot, `${UPDATE_TMP_PREFIX}legacy`);
    fs.mkdirSync(legacyDir);
    const mtime = fs.statSync(legacyDir).mtimeMs;

    // Explicit literal threshold too (not derived from the imported constant), so this half of
    // the test alone still catches a default-parameter mutation inside sweepStaleUpdateDirs.
    const oneDayMs = 24 * 60 * 60 * 1000;
    sweepStaleUpdateDirs(tmpRoot, { now: () => mtime + oneDayMs - 1000, minLegacyAgeMs: oneDayMs });
    assert.equal(fs.existsSync(legacyDir), true, 'must survive while under the age threshold');

    sweepStaleUpdateDirs(tmpRoot, { now: () => mtime + oneDayMs + 1000, minLegacyAgeMs: oneDayMs });
    assert.equal(fs.existsSync(legacyDir), false, 'must be removed once past the age threshold');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// -- AC-24-06: the staged-executable arm's pid ownership (new shape) and age rule (legacy shape) --

test('AC-24-06: staged-executable sweep applies pid ownership to the new shape and age to the legacy shape', () => {
  const exeDir = makeScratch('scriptorium-cleanup-t6-');
  try {
    const exeName = 'scriptorium.exe';
    const livePath = path.join(exeDir, stagedExecutableName(exeName, process.pid, 1));
    const deadPath = path.join(exeDir, stagedExecutableName(exeName, deadPid(), 2));
    const legacyPath = path.join(exeDir, `${exeName}-update-${Date.now()}.tmp`);
    fs.writeFileSync(livePath, 'live');
    fs.writeFileSync(deadPath, 'dead');
    fs.writeFileSync(legacyPath, 'legacy');
    const legacyMtime = fs.statSync(legacyPath).mtimeMs;

    sweepStaleStagedExecutables(exeDir, exeName, { now: () => legacyMtime + LEGACY_MIN_AGE_MS + 1000 });

    assert.equal(fs.existsSync(livePath), true, "a live pid's staged executable must survive");
    assert.equal(fs.existsSync(deadPath), false, "a dead pid's staged executable must be removed");
    assert.equal(fs.existsSync(legacyPath), false, 'a legacy staged executable past the age threshold must be removed');
  } finally {
    fs.rmSync(exeDir, { recursive: true, force: true });
  }
});

// -- AC-24-07: round-trip drift guard between stagedExecutableName and the sweep's own parser --

test('AC-24-07: a name from stagedExecutableName is recognised as new-shape by the sweep, never as legacy', () => {
  const exeDir = makeScratch('scriptorium-cleanup-t7-');
  try {
    const exeName = 'scriptorium.exe';
    const dead = deadPid();
    const newName = stagedExecutableName(exeName, dead, 12345);
    const newPath = path.join(exeDir, newName);
    fs.writeFileSync(newPath, 'x');

    // A huge legacy age threshold: if this name were (mis)matched by the legacy (age-only)
    // pattern instead of the new (pid-only) one, a file created moments ago would survive. Only
    // the new-shape pid check, which never consults age, explains removal here.
    sweepStaleStagedExecutables(exeDir, exeName, { now: () => Date.now(), minLegacyAgeMs: Number.MAX_SAFE_INTEGER });

    assert.equal(
      fs.existsSync(newPath),
      false,
      'stagedExecutableName output must be recognised by the new-shape (pid) regex, not the legacy (age) one',
    );
  } finally {
    fs.rmSync(exeDir, { recursive: true, force: true });
  }
});

// -- AC-24-08: cleanup failure is invisible in the exit code --

test('AC-24-08: a failed cleanup never changes the exit code -- success path still reports success', () => {
  const root = makeScratch('scriptorium-cleanup-t8a-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = baseDeps({ execPath, tmpRoot });

    const originalRmSync = fs.rmSync;
    const originalUnlinkSync = fs.unlinkSync;
    fs.rmSync = (target, opts) => {
      if (String(target).startsWith(tmpRoot)) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return originalRmSync(target, opts);
    };
    fs.unlinkSync = (target) => {
      if (String(target).includes('-update-')) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return originalUnlinkSync(target);
    };

    let result;
    try {
      result = runUpdateCommand({}, deps);
    } finally {
      fs.rmSync = originalRmSync;
      fs.unlinkSync = originalUnlinkSync;
    }

    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.match(result.human, /^updated /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-24-08: a failed cleanup never changes the exit code -- failure path still reports its own failure', () => {
  const root = makeScratch('scriptorium-cleanup-t8b-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = baseDeps({
      execPath,
      tmpRoot,
      extra: {
        verifyDownload: () => {
          throw new Error('checksum mismatch for real reason');
        },
      },
    });

    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, opts) => {
      if (String(target).startsWith(tmpRoot)) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return originalRmSync(target, opts);
    };

    let result;
    try {
      result = runUpdateCommand({}, deps);
    } finally {
      fs.rmSync = originalRmSync;
    }

    assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR);
    assert.match(result.human, /checksum mismatch for real reason/);
    assert.doesNotMatch(result.human, /EBUSY/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- The success path itself is unchanged: no orphan on a clean run --

test('a clean successful run leaves no temp dir and no staged file behind', () => {
  const root = makeScratch('scriptorium-cleanup-happy-');
  try {
    const { exeDir, execPath, tmpRoot } = makeExeAndTmp(root);
    const deps = baseDeps({ execPath, tmpRoot });

    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.deepEqual(
      fs.readdirSync(tmpRoot).filter((e) => e.startsWith(UPDATE_TMP_PREFIX)),
      [],
    );
    assert.deepEqual(
      fs.readdirSync(exeDir).filter((e) => e.startsWith(`${path.basename(execPath)}-update-`)),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- AC-26-04: a successful update deletes the stale beside-exe notices file --

test('AC-26-04: a successful update removes the beside-exe notices file and names how to get it back', () => {
  const root = makeScratch('scriptorium-cleanup-t26a-');
  try {
    const { exeDir, execPath, tmpRoot } = makeExeAndTmp(root);
    const noticesPath = path.join(exeDir, NOTICES_FILENAME);
    fs.writeFileSync(noticesPath, fakeNoticesContent('0.2.2'));

    const deps = baseDeps({ execPath, tmpRoot });
    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.equal(fs.existsSync(noticesPath), false, 'the stale notices file must be gone after a successful update');
    assert.match(result.human, /--version/, 'the success message must name --version as a way to get it back');
    assert.match(result.human, /--notices/, 'the success message must name --notices as a way to get it back');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-26-04 (scoping): a same-named file without the recognisable header is left untouched even on success', () => {
  const root = makeScratch('scriptorium-cleanup-t26a2-');
  try {
    const { exeDir, execPath, tmpRoot } = makeExeAndTmp(root);
    const noticesPath = path.join(exeDir, NOTICES_FILENAME);
    const foreignContent = "This is somebody else's THIRD-PARTY-NOTICES.txt, not Scriptorium's.\n";
    fs.writeFileSync(noticesPath, foreignContent);

    const deps = baseDeps({ execPath, tmpRoot });
    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.equal(fs.existsSync(noticesPath), true, 'a foreign same-named file must not be deleted');
    assert.equal(fs.readFileSync(noticesPath, 'utf8'), foreignContent, 'and must be byte-unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- AC-26-05: on every failure path, the beside-exe notices file survives byte-unchanged --

const AC_26_05_FAILURE_CASES = [
  {
    name: 'prerequisite (requireGh throws UpdatePrerequisiteError)',
    extra: {
      requireGh: () => {
        throw new UpdatePrerequisiteError('gh not found');
      },
    },
  },
  {
    name: 'checksum (verifyDownload throws)',
    extra: {
      verifyDownload: () => {
        throw new Error('checksum mismatch');
      },
    },
  },
  {
    name: 'MZ (downloadAsset writes a non-Windows-executable asset)',
    extra: {
      downloadAsset: (ghPath, tag, pattern, dir) => {
        fs.writeFileSync(path.join(dir, pattern), Buffer.from('not-an-exe'));
      },
    },
  },
  {
    name: 'replace-throws (replaceExecutable throws)',
    extra: {
      replaceExecutable: () => {
        throw new Error('could not rename the running executable aside');
      },
    },
  },
];

for (const { name, extra } of AC_26_05_FAILURE_CASES) {
  test(`AC-26-05: the beside-exe notices file survives byte-unchanged on failure -- ${name}`, () => {
    const root = makeScratch('scriptorium-cleanup-t26b-');
    try {
      const { exeDir, execPath, tmpRoot } = makeExeAndTmp(root);
      const noticesPath = path.join(exeDir, NOTICES_FILENAME);
      const originalContent = fakeNoticesContent('0.2.2');
      fs.writeFileSync(noticesPath, originalContent);

      const deps = baseDeps({ execPath, tmpRoot, extra });
      const result = runUpdateCommand({}, deps);

      assert.notEqual(result.exitCode, EXIT_CODES.OK, `${name} must not report success`);
      assert.equal(fs.existsSync(noticesPath), true, 'the notices file must survive a failed update');
      assert.equal(
        fs.readFileSync(noticesPath, 'utf8'),
        originalContent,
        'the notices file must be byte-unchanged, since the old binary it describes is still on disk',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

// -- AC-26-06: a failed deletion never changes the exit code or loses the success message --

test('AC-26-06: a failed notices deletion (EBUSY) does not change the exit code or lose the success message', () => {
  const root = makeScratch('scriptorium-cleanup-t26c-');
  try {
    const { exeDir, execPath, tmpRoot } = makeExeAndTmp(root);
    const noticesPath = path.join(exeDir, NOTICES_FILENAME);
    fs.writeFileSync(noticesPath, fakeNoticesContent('0.2.2'));

    const deps = baseDeps({ execPath, tmpRoot });

    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (String(target) === noticesPath) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return originalUnlinkSync(target);
    };

    let result;
    try {
      result = runUpdateCommand({}, deps);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }

    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.match(result.human, /^updated /);
    assert.equal(fs.existsSync(noticesPath), true, 'the locked notices file is left in place, not silently lost track of');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
