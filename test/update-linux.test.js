'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUpdateCommand, assetPatternForPlatform } = require('../src/cli/update');
const { replaceExecutable } = require('../src/update/replace');
const { EXIT_CODES } = require('../src/util/exitcodes');

const ELF_HEADER = (() => {
  const buf = Buffer.alloc(20);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf.writeUInt16LE(0x3e, 18);
  return buf;
})();

function makeScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeExeAndTmp(root, exeName = 'scriptorium') {
  const exeDir = path.join(root, 'exe');
  fs.mkdirSync(exeDir);
  const execPath = path.join(exeDir, exeName);
  fs.writeFileSync(execPath, 'stub-current-binary');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(tmpRoot);
  return { exeDir, execPath, tmpRoot };
}

// ---------------------------------------------------------------------------
// P5a-FR02/FR04: assetPatternForPlatform()
// ---------------------------------------------------------------------------

test('assetPatternForPlatform("win32") is the public asset name: gm-scriptorium-win-x64.exe', () => {
  assert.equal(assetPatternForPlatform('win32'), 'gm-scriptorium-win-x64.exe');
});

test('S3: assetPatternForPlatform("linux", "x64") returns gm-scriptorium-linux-x64 (D-12: no extension)', () => {
  assert.equal(assetPatternForPlatform('linux', 'x64'), 'gm-scriptorium-linux-x64');
});

// Only meaningful on the build host itself: the two asserts on process.platform/process.arch are
// the test's own stated premise, and the default-arch call resolves to a known asset only there.
const NOT_BUILD_HOST_SKIP = !(process.platform === 'linux' && process.arch === 'x64') && `this host is ${process.platform}-${process.arch}, not the linux-x64 build host`;

test('P5a-FR04: assetPatternForPlatform defaults arch to process.arch; this build host is linux-x64', { skip: NOT_BUILD_HOST_SKIP }, () => {
  // Stated independently of the implementation: this repo's own build/test host is linux x64
  // (docs/decisions/0001-packager.md's spike, and scripts/package-selftest.js's HOST_TARGET).
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(assetPatternForPlatform('linux'), 'gm-scriptorium-linux-x64');
});

test('P5a-FR04: arm64 stays out of scope -- linux+arm64 still throws the "no pattern known" error', () => {
  assert.throws(() => assetPatternForPlatform('linux', 'arm64'), /no release asset pattern known for platform "linux"/);
});

test('macOS keeps today\'s error, unchanged by 5a', () => {
  assert.throws(() => assetPatternForPlatform('darwin', 'x64'), /no release asset pattern known for platform "darwin"/);
});

// ---------------------------------------------------------------------------
// P5a-FR05: the ELF check wired into runUpdateCommand's download-verification
// step, mirroring the existing MZ check for win32.
// ---------------------------------------------------------------------------

function linuxDeps({ execPath, tmpRoot, downloadBytes }) {
  return {
    execPath,
    platform: 'linux',
    arch: 'x64',
    tmpRoot,
    isPkg: true,
    requireGh: () => '/usr/bin/gh',
    fetchLatestRelease: () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/releases/v9.9.9' }),
    downloadAsset: (ghPath, tag, pattern, dir) => {
      fs.writeFileSync(path.join(dir, pattern), downloadBytes);
    },
    verifyDownload: () => {},
    replaceExecutable: (execPathArg, stagedPath, oldVersion) => ({ oldPath: `${execPathArg}.old-${oldVersion}` }),
  };
}

test('P5a-FR05: a downloaded asset without an ELF header is refused on platform=linux', () => {
  const root = makeScratch('scriptorium-linux-elf-t1-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const result = runUpdateCommand({}, linuxDeps({ execPath, tmpRoot, downloadBytes: Buffer.from('not-an-elf-binary') }));

    assert.equal(result.exitCode, EXIT_CODES.SCRIPTORIUM_ERROR);
    assert.match(result.human, /ELF/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P5a-FR05: a downloaded asset WITH a real ELF header passes the check on platform=linux', () => {
  const root = makeScratch('scriptorium-linux-elf-t2-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root);
    const result = runUpdateCommand({}, linuxDeps({ execPath, tmpRoot, downloadBytes: ELF_HEADER }));

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
    assert.match(result.human, /^updated /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the ELF check never runs on platform=win32 (an MZ-only asset still passes there)', () => {
  const root = makeScratch('scriptorium-linux-elf-t3-');
  try {
    const { execPath, tmpRoot } = makeExeAndTmp(root, 'scriptorium.exe');
    const deps = linuxDeps({ execPath, tmpRoot, downloadBytes: Buffer.from([0x4d, 0x5a, 0x00, 0x00]) });
    deps.platform = 'win32';
    const result = runUpdateCommand({}, deps);

    assert.equal(result.exitCode, EXIT_CODES.OK, result.human);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P5a-FR06: the staged file gets mode 0755 before the swap.
// ---------------------------------------------------------------------------

test('P5a-FR06: replaceExecutable() leaves the new (now-current) executable at mode 0755', () => {
  const root = makeScratch('scriptorium-mode-t1-');
  try {
    const exeDir = path.join(root, 'exe');
    fs.mkdirSync(exeDir);
    const currentExePath = path.join(exeDir, 'scriptorium');
    const newExePath = path.join(exeDir, 'scriptorium-staged');
    fs.writeFileSync(currentExePath, 'old-binary');
    fs.writeFileSync(newExePath, 'new-binary');
    fs.chmodSync(newExePath, 0o600); // deliberately NOT executable before the call

    replaceExecutable(currentExePath, newExePath, '0.1.0');

    const mode = fs.statSync(currentExePath).mode & 0o777;
    assert.equal(mode, 0o755, `expected mode 0755, got ${mode.toString(8)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P5a-FR06: a chmod failure rolls back to the old binary, same as a rename failure', () => {
  const root = makeScratch('scriptorium-mode-t2-');
  try {
    const exeDir = path.join(root, 'exe');
    fs.mkdirSync(exeDir);
    const currentExePath = path.join(exeDir, 'scriptorium');
    const newExePath = path.join(exeDir, 'scriptorium-staged');
    fs.writeFileSync(currentExePath, 'old-binary');
    fs.writeFileSync(newExePath, 'new-binary');

    const originalChmodSync = fs.chmodSync;
    fs.chmodSync = (target, mode) => {
      if (target === newExePath) throw new Error('EPERM: simulated chmod failure');
      return originalChmodSync(target, mode);
    };

    try {
      assert.throws(() => replaceExecutable(currentExePath, newExePath, '0.1.0'), /could not move the new executable into place/);
    } finally {
      fs.chmodSync = originalChmodSync;
    }

    assert.equal(fs.readFileSync(currentExePath, 'utf8'), 'old-binary', 'the old binary must still be running (rolled back)');
    assert.equal(fs.existsSync(`${currentExePath}.old-0.1.0`), false, 'the rollback must have renamed the aside-copy back');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
