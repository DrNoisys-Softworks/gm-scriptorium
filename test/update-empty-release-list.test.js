'use strict';

/*
 * F1 (S6): `update --pre` against a repository with no releases (the brand-new public repo:
 * GET releases?per_page=30 returns `[]`) is an expected state, not a Scriptorium bug. It must
 * exit 4 (update prerequisite) with the same "no release published yet" wording that the
 * /releases/latest 404 path gives. A fake request (test/helpers/fake-request.js) answers per URL
 * and drives the REAL lookupRelease and runUpdateCommand. Expected values are stated here, not
 * derived from the code.
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
const { mentionsUrl } = require('./helpers/url-mention');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const PUBLISHED_YET = /no release has been published there yet/;
const RELEASES_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases';

/** A fake request that answers `latest` and `list`, each as a reply or an Error; anything else throws. */
function fakeGithub({ latest, list }) {
  return byUrl({ [URLS.latest]: latest, [URLS.list]: list });
}

const NOT_FOUND = { status: 404, body: '{"message":"Not Found"}' };

async function run(flags, fake) {
  // Packaged-path deps (the source-mode guard would otherwise answer first); the exe and tmp
  // dirs live in a scratch root, so nothing outside it is touched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-f1-'));
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

test('F1: `update --check --pre` with an empty release list exits 4 with the "published yet" wording', async () => {
  const result = await run({ check: true, pre: true }, fakeGithub({ list: json([]) }));
  assert.equal(result.exitCode, 4, result.human);
  assert.match(result.human, PUBLISHED_YET);
  assert.ok(mentionsUrl(result.human, RELEASES_URL));
  assert.doesNotMatch(result.human, /update failed/);
});

test('F1: `update --pre` (install) with an empty release list also exits 4', async () => {
  const result = await run({ pre: true }, fakeGithub({ list: json([]) }));
  assert.equal(result.exitCode, 4, result.human);
  assert.match(result.human, PUBLISHED_YET);
});

test('F1: the empty-list message is word-for-word the 404 message (consistent across the two paths)', async () => {
  const empty = await run({ check: true, pre: true }, fakeGithub({ list: json([]) }));
  const notFound = await run({ check: true }, fakeGithub({ latest: NOT_FOUND, list: NOT_FOUND }));
  assert.equal(notFound.exitCode, 4);
  assert.match(notFound.human, PUBLISHED_YET);
  assert.equal(empty.human, notFound.human);
});

test('F1 control: --pre 404 on the list endpoint is still exit 4', async () => {
  const result = await run({ check: true, pre: true }, fakeGithub({ list: NOT_FOUND }));
  assert.equal(result.exitCode, 4);
  assert.match(result.human, PUBLISHED_YET);
});

test('F1 control: empty list WITHOUT --pre (/releases/latest returning []) is not treated as "no release" and is unchanged', async () => {
  // Without --pre the body is returned as-is; an empty array has no tag_name, so it is not a
  // usable release and must not be reported as the prerequisite state by this fix.
  const parsed = await lookupRelease({ pre: false }, { request: fakeGithub({ latest: json([]) }).request });
  assert.deepEqual(parsed, []);
});

test('F1 control: --pre list that is non-empty but has no usable release (draft only) stays exit 1', async () => {
  const body = [{ tag_name: 'v1.0.0', draft: true }];
  const result = await run({ check: true, pre: true }, fakeGithub({ list: json(body) }));
  assert.equal(result.exitCode, 1, result.human);
  assert.match(result.human, /^update failed: no usable release found for DrNoisys-Softworks\/gm-scriptorium$/);
});

test('F1 control: genuinely malformed JSON stays exit 1', async () => {
  const result = await run({ check: true, pre: true }, fakeGithub({ list: { status: 200, body: 'not json{' } }));
  assert.equal(result.exitCode, 1);
  assert.match(result.human, /^update failed: GitHub sent a reply that could not be read/);
});

test('F1 control: a server error (500) is the unreachable state, exit 4 (it was exit 1 under gh)', async () => {
  const result = await run({ check: true, pre: true }, fakeGithub({ list: { status: 500, body: 'oops' } }));
  assert.equal(result.exitCode, 4);
  assert.match(result.human, /^Could not reach GitHub\./);
  assert.ok(mentionsUrl(result.human, RELEASES_URL));
});
