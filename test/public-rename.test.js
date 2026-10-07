'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { REPO, fetchLatestRelease, downloadAsset } = require('../src/update/release');
const { runUpdateCommand } = require('../src/cli/update');
const { UpdatePrerequisiteError } = require('../src/util/errors');
const { EXIT_CODES } = require('../src/util/exitcodes');

/*
 * S3: the public repository is the update source. These tests exercise src/update/release.js's
 * fetchLatestRelease() and downloadAsset() against a real child process (a fake `gh`), which is
 * the only way to see the real gh argument vector -- every pre-existing update-*.test.js injects
 * both functions directly and never sees REPO or the argv gh is actually called with.
 */

const PUBLIC_REPO = 'DrNoisys-Softworks/gm-scriptorium';
const PUBLIC_RELEASES_URL = `https://github.com/${PUBLIC_REPO}/releases`;

function makeScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A temp-dir "gh" executable. It appends `JSON.stringify(process.argv.slice(2))` (one line per
 * invocation) to the file named by FAKE_GH_ARGS_FILE, then either prints a release JSON body or
 * fails like a real 404, depending on FAKE_GH_MODE. runGh() (src/update/gh.js) copies
 * process.env into the child, so setting these on process.env before calling release.js's
 * functions directly is enough; t.after restores them.
 */
function createFakeGh(dir) {
  const ghPath = path.join(dir, 'fake-gh.js');
  const script = [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("fs");',
    'const argsFile = process.env.FAKE_GH_ARGS_FILE;',
    'if (argsFile) {',
    '  fs.appendFileSync(argsFile, JSON.stringify(process.argv.slice(2)) + "\\n");',
    '}',
    'if (process.env.FAKE_GH_MODE === "404") {',
    '  process.stderr.write("HTTP 404: Not Found\\n");',
    '  process.exit(1);',
    '}',
    'process.stdout.write(JSON.stringify({ tag_name: "v9.9.9", html_url: "x" }));',
    'process.exit(0);',
    '',
  ].join('\n');
  fs.writeFileSync(ghPath, script, { mode: 0o755 });
  return ghPath;
}

function readArgvCalls(argsFile) {
  if (!fs.existsSync(argsFile)) return [];
  return fs
    .readFileSync(argsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withFakeGhEnv(t, { mode, argsFile }) {
  const savedArgsFile = process.env.FAKE_GH_ARGS_FILE;
  const savedMode = process.env.FAKE_GH_MODE;
  process.env.FAKE_GH_ARGS_FILE = argsFile;
  if (mode) process.env.FAKE_GH_MODE = mode;
  else delete process.env.FAKE_GH_MODE;
  t.after(() => {
    if (savedArgsFile === undefined) delete process.env.FAKE_GH_ARGS_FILE;
    else process.env.FAKE_GH_ARGS_FILE = savedArgsFile;
    if (savedMode === undefined) delete process.env.FAKE_GH_MODE;
    else process.env.FAKE_GH_MODE = savedMode;
  });
}

// ---------------------------------------------------------------------------
// AC-01 / SD-1: REPO is the public repository
// ---------------------------------------------------------------------------

test('REPO is the public repository, exactly', () => {
  assert.equal(REPO, 'DrNoisys-Softworks/gm-scriptorium');
});

// ---------------------------------------------------------------------------
// AC-01: the fake-gh argument vectors match exactly
// ---------------------------------------------------------------------------

test('fetchLatestRelease() calls gh with exactly ["api", "repos/DrNoisys-Softworks/gm-scriptorium/releases/latest"]', (t) => {
  const dir = makeScratch('scriptorium-public-rename-argv-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ghPath = createFakeGh(dir);
  const argsFile = path.join(dir, 'args.log');
  withFakeGhEnv(t, { argsFile });

  const release = fetchLatestRelease(ghPath);

  assert.deepEqual(readArgvCalls(argsFile), [
    ['api', 'repos/DrNoisys-Softworks/gm-scriptorium/releases/latest'],
  ]);
  assert.equal(release.tag_name, 'v9.9.9');
});

test('downloadAsset() calls gh with exactly ["release","download","v9.9.9","--repo","DrNoisys-Softworks/gm-scriptorium","--pattern","gm-scriptorium-linux-x64","--dir",<dir>,"--clobber"]', (t) => {
  const dir = makeScratch('scriptorium-public-rename-argv-dl-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ghPath = createFakeGh(dir);
  const destDir = makeScratch('scriptorium-public-rename-dest-');
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }));
  const argsFile = path.join(dir, 'args.log');
  withFakeGhEnv(t, { argsFile });

  downloadAsset(ghPath, 'v9.9.9', 'gm-scriptorium-linux-x64', destDir);

  const calls = readArgvCalls(argsFile);
  assert.deepEqual(calls[0], [
    'release',
    'download',
    'v9.9.9',
    '--repo',
    'DrNoisys-Softworks/gm-scriptorium',
    '--pattern',
    'gm-scriptorium-linux-x64',
    '--dir',
    destDir,
    '--clobber',
  ]);
  assert.deepEqual(calls[1], [
    'release',
    'download',
    'v9.9.9',
    '--repo',
    'DrNoisys-Softworks/gm-scriptorium',
    '--pattern',
    'SHA256SUMS',
    '--dir',
    destDir,
    '--clobber',
  ]);
});

// ---------------------------------------------------------------------------
// AC-01: the 404 message contains no "private", names the releases URL, still exits 4
// ---------------------------------------------------------------------------

test('fetchLatestRelease() on a 404: no "private", names the public releases URL, throws UpdatePrerequisiteError', (t) => {
  const dir = makeScratch('scriptorium-public-rename-404-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ghPath = createFakeGh(dir);
  const argsFile = path.join(dir, 'args.log');
  withFakeGhEnv(t, { mode: '404', argsFile });

  assert.throws(
    () => fetchLatestRelease(ghPath),
    (err) => {
      assert.ok(err instanceof UpdatePrerequisiteError, 'must be UpdatePrerequisiteError (exit 4)');
      assert.doesNotMatch(err.message, /private/i);
      assert.ok(err.message.includes(PUBLIC_RELEASES_URL), 'message must name the public releases URL as a literal');
      return true;
    },
  );
});

test('end-to-end: a 404 from the release lookup still exits 4, with the new wording', (t) => {
  const root = makeScratch('scriptorium-public-rename-e2e-404-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ghPath = createFakeGh(root);
  const argsFile = path.join(root, 'args.log');
  withFakeGhEnv(t, { mode: '404', argsFile });

  const exeDir = path.join(root, 'exe');
  fs.mkdirSync(exeDir);
  const execPath = path.join(exeDir, 'gm-scriptorium-linux-x64');
  fs.writeFileSync(execPath, 'stub-current-binary');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(tmpRoot);

  const result = runUpdateCommand(
    {},
    {
      execPath,
      platform: 'linux',
      tmpRoot,
      isPkg: true,
      requireGh: () => ghPath,
    },
  );

  assert.equal(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE);
  assert.doesNotMatch(result.human, /private/i);
  assert.ok(result.human.includes(PUBLIC_RELEASES_URL));
});

// ---------------------------------------------------------------------------
// AC-01: the source-mode guard message contains the public releases URL as a literal
// ---------------------------------------------------------------------------

test('the source-mode guard message names the public releases URL as a literal', () => {
  const result = runUpdateCommand({}, { isPkg: false });
  assert.equal(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE);
  assert.ok(result.human.includes(PUBLIC_RELEASES_URL), 'must contain the public releases URL as a literal');
  assert.doesNotMatch(result.human, /Noisyink/);
});

// ---------------------------------------------------------------------------
// AC-04: the HELP line
// ---------------------------------------------------------------------------

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');

function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

test('gm-scriptorium.js --help: the first line is exactly the new HELP banner', (t) => {
  const root = makeScratch('scriptorium-public-rename-help-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const res = spawnSync(
    process.execPath,
    [BIN, '--help', '--config', path.join(root, 'unused.toml')],
    { encoding: 'utf8', env: scratchEnv(root), timeout: 10000 },
  );

  assert.equal(res.status, EXIT_CODES.OK);
  const firstLine = res.stdout.split('\n')[0];
  assert.equal(firstLine, 'gm-scriptorium <command> [campaign] [flags]');
});

// ---------------------------------------------------------------------------
// AC-06: package.json carries the public repository's metadata
// ---------------------------------------------------------------------------

test('package.json: name, repository, homepage and bugs point at the public repo; bin/version/license/private unchanged', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.name, 'gm-scriptorium');
  assert.deepEqual(pkg.repository, {
    type: 'git',
    url: 'git+https://github.com/DrNoisys-Softworks/gm-scriptorium.git',
  });
  assert.equal(pkg.homepage, 'https://github.com/DrNoisys-Softworks/gm-scriptorium#readme');
  assert.deepEqual(pkg.bugs, { url: 'https://github.com/DrNoisys-Softworks/gm-scriptorium/issues' });
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.bin, { scriptorium: 'bin/scriptorium.js' });
  assert.equal(pkg.license, 'MIT');
});

