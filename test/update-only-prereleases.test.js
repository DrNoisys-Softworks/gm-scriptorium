'use strict';

/*
 * Issue #51: while a project has only prereleases, GitHub's /releases/latest answers 404, so
 * plain `update` and `update --check` used to say "no release has been published there yet".
 * They now say there is no stable release, name the newest prerelease and point at --pre. The
 * exit code stays 4 (update prerequisite): the frozen exit table does not change. A fake request
 * (test/helpers/fake-request.js) answers per endpoint and records every call. Expected strings are
 * stated here, not derived from the code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUpdateCommand } = require('../src/cli/update');
const { lookupRelease } = require('../src/update/release');
const { installLoopbackGuard } = require('./helpers/net-stubs');
const { byUrl, URLS, json } = require('./helpers/fake-request');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const PUBLISHED_YET = /no release has been published there yet/;

/** `latest` answers /releases/latest, `list` answers /releases?per_page=30; each is a reply or an Error. */
function fakeGithub({ latest, list }) {
  return byUrl({ [URLS.latest]: latest, [URLS.list]: list });
}

async function run(flags, fake) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-51-'));
  try {
    const exeDir = path.join(root, 'exe');
    const tmpRoot = path.join(root, 'tmp');
    fs.mkdirSync(exeDir, { recursive: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    const execPath = path.join(exeDir, 'scriptorium');
    fs.writeFileSync(execPath, 'stub-current-binary');
    return await runUpdateCommand(flags, {
      lookupRelease: (f) => lookupRelease(f, { request: fake.request }),
      execPath,
      tmpRoot,
      isPkg: true,
      platform: 'linux',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NOT_FOUND = { status: 404, body: '{"message":"Not Found"}' };
const rel = (tag, extra = {}) => ({ tag_name: tag, prerelease: true, draft: false, html_url: `https://example.invalid/${tag}`, ...extra });

for (const flags of [{}, { check: true }]) {
  test(`#51: ${flags.check ? 'update --check' : 'update'} with only prereleases says so, names the newest, points at --pre, exits 4`, async () => {
    const list = [rel('v0.4.0-rc.1'), rel('v0.4.0-rc.2'), rel('v0.3.9-rc.7')];
    const result = await run(flags, fakeGithub({ latest: NOT_FOUND, list: json(list) }));
    assert.equal(result.exitCode, 4, result.human);
    assert.equal(
      result.human,
      'No stable release yet. The newest prerelease is v0.4.0-rc.2; run `gm-scriptorium update --pre` to get prereleases.',
    );
  });
}

test('#51: a draft-only list is not offered as a prerelease; the old wording stays, exit 4', async () => {
  const list = [rel('v0.4.0-rc.9', { draft: true })];
  const result = await run({ check: true }, fakeGithub({ latest: NOT_FOUND, list: json(list) }));
  assert.equal(result.exitCode, 4, result.human);
  assert.match(result.human, PUBLISHED_YET);
});

test('#51: nothing published at all (404 then an empty list) keeps the old wording, exit 4', async () => {
  const result = await run({ check: true }, fakeGithub({ latest: NOT_FOUND, list: json([]) }));
  assert.equal(result.exitCode, 4, result.human);
  assert.match(result.human, PUBLISHED_YET);
});

test('#51: if the follow-up lookup also fails, the old wording stays, exit 4 (never a new failure)', async () => {
  const result = await run({ check: true }, fakeGithub({ latest: NOT_FOUND, list: NOT_FOUND }));
  assert.equal(result.exitCode, 4, result.human);
  assert.match(result.human, PUBLISHED_YET);
});

test('#51: a stable release still wins; no follow-up lookup is made', async () => {
  const fake = fakeGithub({ latest: json(rel('v99.0.0', { prerelease: false })), list: json([]) });
  const result = await run({ check: true }, fake);
  assert.equal(result.exitCode, 0, result.human);
  assert.match(result.human, /update available: .* -> v99\.0\.0/);
  assert.equal(fake.calls.length, 1);
});

test('#51: a non-404 failure on /releases/latest is exit 4 (unreachable, it was exit 1 under gh) and makes no follow-up lookup', async () => {
  const fake = fakeGithub({ latest: { status: 500, body: 'oops' }, list: json([rel('v0.4.0-rc.1')]) });
  const result = await run({ check: true }, fake);
  assert.equal(result.exitCode, 4, result.human);
  assert.match(result.human, /^Could not reach GitHub\./);
  assert.equal(fake.calls.length, 1);
});

test('#51: --pre is unchanged (still picks the newest prerelease and carries on)', async () => {
  const list = [rel('v0.4.0-rc.1'), rel('v99.0.0-rc.1')];
  const result = await run({ check: true, pre: true }, fakeGithub({ latest: NOT_FOUND, list: json(list) }));
  assert.equal(result.exitCode, 0, result.human);
  assert.match(result.human, /update available: .* -> v99\.0\.0-rc\.1/);
});
