'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { REPO, lookupRelease, downloadAsset } = require('../src/update/release');
const { runUpdateCommand } = require('../src/cli/update');
const { UpdatePrerequisiteError } = require('../src/util/errors');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { installLoopbackGuard } = require('./helpers/net-stubs');
const { fakeRequest, json } = require('./helpers/fake-request');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

/*
 * S3: the public repository is the update source. These tests exercise src/update/release.js's
 * lookupRelease() and downloadAsset() with a fake request, which records the exact URLs the code
 * asks for -- every pre-existing update-*.test.js injects both functions directly and never sees
 * REPO or the requests actually made.
 */

const PUBLIC_REPO = 'DrNoisys-Softworks/gm-scriptorium';
const PUBLIC_RELEASES_URL = `https://github.com/${PUBLIC_REPO}/releases`;

function makeScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// AC-01 / SD-1: REPO is the public repository
// ---------------------------------------------------------------------------

test('REPO is the public repository, exactly', () => {
  assert.equal(REPO, 'DrNoisys-Softworks/gm-scriptorium');
});

// ---------------------------------------------------------------------------
// AC-01: the requests name the public repository, exactly
// ---------------------------------------------------------------------------

test('lookupRelease() asks for exactly https://api.github.com/repos/DrNoisys-Softworks/gm-scriptorium/releases/latest', async () => {
  const fake = fakeRequest(() => json({ tag_name: 'v9.9.9' }));
  const release = await lookupRelease({}, { request: fake.request });

  assert.deepEqual(
    fake.calls.map((c) => c.url),
    ['https://api.github.com/repos/DrNoisys-Softworks/gm-scriptorium/releases/latest'],
  );
  assert.equal(release.tag_name, 'v9.9.9');
});

test('downloadAsset() asks for exactly the asset URL then the SHA256SUMS URL under the public repository', async (t) => {
  const destDir = makeScratch('scriptorium-public-rename-dest-');
  t.after(() => fs.rmSync(destDir, { recursive: true, force: true }));
  const fake = fakeRequest((opts) => ({ status: 200, body: opts.url.endsWith('SHA256SUMS') ? 'sums' : 'MZ' }));

  await downloadAsset('v9.9.9', 'gm-scriptorium-linux-x64', destDir, { request: fake.request });

  assert.deepEqual(
    fake.calls.map((c) => c.url),
    [
      'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/v9.9.9/gm-scriptorium-linux-x64',
      'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/v9.9.9/SHA256SUMS',
    ],
  );
});

// ---------------------------------------------------------------------------
// AC-01: the 404 message contains no "private", names the releases URL, still exits 4
// ---------------------------------------------------------------------------

test('lookupRelease() on a 404: no "private", names the public releases URL, throws UpdatePrerequisiteError', async () => {
  const fake = fakeRequest(() => ({ status: 404, body: '{"message":"Not Found"}' }));

  await assert.rejects(
    () => lookupRelease({}, { request: fake.request }),
    (err) => {
      assert.ok(err instanceof UpdatePrerequisiteError, 'must be UpdatePrerequisiteError (exit 4)');
      assert.doesNotMatch(err.message, /private/i);
      assert.ok(err.message.includes(PUBLIC_RELEASES_URL), 'message must name the public releases URL as a literal');
      return true;
    },
  );
});

test('end-to-end: a 404 from the release lookup still exits 4, with the new wording', async (t) => {
  const root = makeScratch('scriptorium-public-rename-e2e-404-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = fakeRequest(() => ({ status: 404, body: '{"message":"Not Found"}' }));

  const exeDir = path.join(root, 'exe');
  fs.mkdirSync(exeDir);
  const execPath = path.join(exeDir, 'gm-scriptorium-linux-x64');
  fs.writeFileSync(execPath, 'stub-current-binary');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(tmpRoot);

  const result = await runUpdateCommand(
    {},
    {
      execPath,
      platform: 'linux',
      tmpRoot,
      isPkg: true,
      lookupRelease: (flags) => lookupRelease(flags, { request: fake.request }),
    },
  );

  assert.equal(result.exitCode, EXIT_CODES.UPDATE_PREREQUISITE);
  assert.doesNotMatch(result.human, /private/i);
  assert.ok(result.human.includes(PUBLIC_RELEASES_URL));
});

// ---------------------------------------------------------------------------
// AC-01: the source-mode guard message contains the public releases URL as a literal
// ---------------------------------------------------------------------------

test('the source-mode guard message names the public releases URL as a literal', async () => {
  const result = await runUpdateCommand({}, { isPkg: false });
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

