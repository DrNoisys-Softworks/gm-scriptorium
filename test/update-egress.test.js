'use strict';

/*
 * `update` reaches GitHub only through src/net/egress.js. These tests drive src/update/release.js
 * with an injected `request` (test/helpers/fake-request.js), so they check the exact shape of every
 * request, the status and network-error mapping, the tag refusal and the download file handling.
 * Expected values are written here from the brief, not read back from the code under test.
 *
 * No test here reaches the network: the loopback guard is installed as a backstop, so a missed
 * injection fails on the guard instead of reaching GitHub. The redirect rules themselves are
 * proven on loopback stubs in test/net-egress.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const release = require('../src/update/release');
const { runUpdateCommand } = require('../src/cli/update');
const { NetError } = require('../src/net/errors');
const { UpdatePrerequisiteError, ScriptoriumError } = require('../src/util/errors');
const { installLoopbackGuard, sentinel } = require('./helpers/net-stubs');
const { fakeRequest, byUrl, URLS, json } = require('./helpers/fake-request');
const { mentionsUrl } = require('./helpers/url-mention');
const pkg = require('../package.json');

const guard = installLoopbackGuard();
test.after(() => guard.assertClean({ minConnects: 0 }));

const RELEASES_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases';
const API_HEADERS = { 'user-agent': 'GM-Scriptorium/' + pkg.version, accept: 'application/vnd.github+json' };

function scratch(t, prefix = 'scriptorium-update-egress-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail('expected a rejection');
}

// --- literals --------------------------------------------------------------------------------------

test('constants: REPO, USER_AGENT, CAPS, the asset timeout and the redirect id are pinned as literals', () => {
  assert.equal(release.REPO, 'DrNoisys-Softworks/gm-scriptorium');
  assert.equal(release.USER_AGENT, 'GM-Scriptorium/' + pkg.version);
  assert.deepEqual({ ...release.CAPS }, { releaseJson: 2097152, sums: 65536, asset: 268435456 });
  assert.ok(Object.isFrozen(release.CAPS));
  assert.equal(release.ASSET_TOTAL_TIMEOUT_MS, 1800000);
  assert.deepEqual([...release.ASSET_REDIRECT_TO], ['github-release-assets']);
  assert.ok(Object.isFrozen(release.ASSET_REDIRECT_TO));
});

test('the asset cap is at least twice the larger release asset measured on 2026-10-12 (83352045 bytes)', () => {
  assert.ok(release.CAPS.asset >= 2 * 83352045);
});

test('isSafeTag: a plain version passes; anything that could change a URL path does not', () => {
  for (const ok of ['v0.4.0', '0.4.0', 'v0.4.0-rc.1', 'v10.20.30', 'v1.0.0+build.5']) assert.equal(release.isSafeTag(ok), true, ok);
  const bad = [
    'v1.0.0/../x', '../v1.0.0', 'v1.0.0/', '/v1.0.0', 'v1.0.0?x=1', 'v1.0.0#x', 'v1.0.0 ', ' v1.0.0', 'v1.0.0\n', 'v1',
    'latest', '', 'v1.0.0%2F', 'v1.0.0\\x', 'v01.0.0', null, undefined, 5, {}, ['v1.0.0'], 'v' + '1'.repeat(80) + '.0.0',
  ];
  for (const b of bad) assert.equal(release.isSafeTag(b), false, JSON.stringify(b));
});

test('releaseNotesUrl is built from the constants and the encoded tag', () => {
  assert.equal(release.releaseNotesUrl('v0.4.0-rc.1'), 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v0.4.0-rc.1');
  assert.equal(release.releaseNotesUrl('v1.0.0+b'), 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v1.0.0%2Bb');
});

// --- the shape of each lookup request --------------------------------------------------------------

test('lookupRelease: latest, pre and version each send exactly the specified request', async () => {
  const rows = [
    [{}, `${URLS.latest}`, json({ tag_name: 'v9.9.9' })],
    [{ pre: true }, 'https://api.github.com/repos/DrNoisys-Softworks/gm-scriptorium/releases?per_page=30', json([{ tag_name: 'v9.9.9' }])],
    [{ version: 'v0.4.0-rc.1' }, 'https://api.github.com/repos/DrNoisys-Softworks/gm-scriptorium/releases/tags/v0.4.0-rc.1', json({ tag_name: 'v0.4.0-rc.1' })],
    [{ version: 'v1.0.0+b' }, 'https://api.github.com/repos/DrNoisys-Softworks/gm-scriptorium/releases/tags/v1.0.0%2Bb', json({ tag_name: 'v1.0.0+b' })],
  ];
  for (const [flags, url, reply] of rows) {
    const fake = fakeRequest(() => reply);
    await release.lookupRelease(flags, { request: fake.request });
    assert.equal(fake.calls.length, 1, url);
    assert.deepEqual(fake.calls[0], {
      destination: 'github-api',
      url,
      method: 'GET',
      headers: { 'user-agent': 'GM-Scriptorium/' + pkg.version, accept: 'application/vnd.github+json' },
      maxResponseBytes: 2097152,
      totalTimeoutMs: 60000,
    });
  }
});

test('lookupRelease: the signal and a custom total timeout are passed on; version wins over pre', async () => {
  const ac = new AbortController();
  const fake = fakeRequest(() => json({ tag_name: 'v0.4.0' }));
  await release.lookupRelease({ pre: true, version: 'v0.4.0', signal: ac.signal, totalTimeoutMs: 5000 }, { request: fake.request });
  assert.equal(fake.calls[0].signal, ac.signal);
  assert.equal(fake.calls[0].totalTimeoutMs, 5000);
  assert.equal(fake.calls[0].url, URLS.tag('v0.4.0'));
});

test('lookupRelease: every request carries the User-Agent and the JSON accept header, and no redirectTo or body', async () => {
  const fake = fakeRequest(() => json({ tag_name: 'v0.4.0' }));
  await release.lookupRelease({}, { request: fake.request });
  assert.deepEqual(fake.calls[0].headers, API_HEADERS);
  assert.equal('redirectTo' in fake.calls[0], false);
  assert.equal('body' in fake.calls[0], false);
});

test('lookupRelease: a tag that is not a plain version is refused with exit 1 and no request is made', async () => {
  for (const bad of ['v1.0.0/../x', '../../x', 'v1.0.0?x', 'latest', 'v1.0.0 ']) {
    const fake = fakeRequest(() => assert.fail('no request should be made'));
    const e = await rejection(release.lookupRelease({ version: bad }, { request: fake.request }));
    assert.ok(e instanceof ScriptoriumError && !(e instanceof UpdatePrerequisiteError), bad);
    assert.match(e.message, /^--version needs a release tag like v0\.4\.0$/);
    assert.equal(fake.calls.length, 0, bad);
  }
});

// --- status handling --------------------------------------------------------------------------------

test('lookupRelease: a 200 is parsed; bad JSON and non-objects are exit 1 (not a prerequisite)', async () => {
  const ok = await release.lookupRelease({}, { request: fakeRequest(() => json({ tag_name: 'v1.2.3', extra: 1 })).request });
  assert.equal(ok.tag_name, 'v1.2.3');
  for (const body of ['not json{', 'null', '5', '']) {
    const e = await rejection(release.lookupRelease({}, { request: fakeRequest(() => ({ status: 200, body })).request }));
    assert.ok(e instanceof ScriptoriumError && !(e instanceof UpdatePrerequisiteError), body);
  }
});

test('lookupRelease: status mapping, with the reason each error carries', async () => {
  const rows = [
    [404, {}, 'no-release'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limit'],
    [429, {}, 'rate-limit'],
    [429, { 'x-ratelimit-remaining': '5' }, 'rate-limit'],
    [403, {}, 'unreachable'],
    [403, { 'x-ratelimit-remaining': '7' }, 'unreachable'],
    [500, {}, 'unreachable'],
    [503, {}, 'unreachable'],
    [401, {}, 'unreachable'],
    [204, {}, 'unreachable'],
  ];
  for (const [status, headers, reason] of rows) {
    // pre: true so the 404 case makes no second lookup for the prerelease hint.
    const e = await rejection(release.lookupRelease({ pre: true }, { request: fakeRequest(() => ({ status, headers, body: '{}' })).request }));
    assert.ok(e instanceof UpdatePrerequisiteError, `${status}: exit 4`);
    assert.equal(e.reason, reason, `${status} ${JSON.stringify(headers)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(e, 'reason'), 'reason is an own property');
  }
});

test('lookupRelease: each NetError code maps to its exit code and reason', async () => {
  const rows = [
    ['E_NET_CONNECT', 4, 'unreachable'],
    ['E_NET_TIMEOUT', 4, 'unreachable'],
    ['E_NET_INCOMPLETE', 4, 'unreachable'],
    ['E_NET_TLS', 4, 'tls'],
    ['E_NET_REDIRECT', 4, 'redirect'],
    ['E_NET_RESPONSE_CAP', 1, undefined],
    ['E_NET_REFUSED', 1, undefined],
    ['E_NET_BAD_OPTIONS', 1, undefined],
    ['E_NET_ABORTED', 1, undefined],
    ['E_NET_CALLBACK', 1, undefined],
  ];
  for (const [code, exit, reason] of rows) {
    const e = await rejection(release.lookupRelease({}, { request: fakeRequest(() => new NetError(code)).request }));
    if (exit === 4) {
      assert.ok(e instanceof UpdatePrerequisiteError, code);
      assert.equal(e.reason, reason, code);
    } else {
      assert.ok(e instanceof ScriptoriumError && !(e instanceof UpdatePrerequisiteError), code);
      assert.equal(e.reason, undefined, code);
    }
  }
});

test('lookupRelease: a redirect with any reason is still the redirect error, exit 4', async () => {
  for (const reason of ['off-list', 'downgrade', 'second-hop', 'no-location', 'bad-location', 'not-followed']) {
    const e = await rejection(release.lookupRelease({}, { request: fakeRequest(() => new NetError('E_NET_REDIRECT', { status: 302, reason })).request }));
    assert.ok(e instanceof UpdatePrerequisiteError, reason);
    assert.equal(e.reason, 'redirect', reason);
  }
});

test('error messages: one line each, name the releases page, carry no reply text, no URL from a reply, and never mention gh', async () => {
  const marker = sentinel('reply');
  const failures = [
    () => fakeRequest(() => ({ status: 404, headers: { 'x-marker': marker }, body: JSON.stringify({ message: marker }) })),
    () => fakeRequest(() => ({ status: 429, headers: { location: `https://${marker}.invalid/` }, body: marker })),
    () => fakeRequest(() => ({ status: 500, headers: {}, body: marker })),
    () => fakeRequest(() => new NetError('E_NET_CONNECT', { syscallCode: 'ECONNREFUSED' })),
    () => fakeRequest(() => new NetError('E_NET_TLS', { tlsCode: 'CERT_HAS_EXPIRED' })),
    () => fakeRequest(() => new NetError('E_NET_REDIRECT', { status: 302, reason: 'off-list' })),
  ];
  const seen = new Set();
  for (const make of failures) {
    const e = await rejection(release.lookupRelease({ pre: true }, { request: make().request }));
    assert.ok(e instanceof UpdatePrerequisiteError);
    assert.ok(!e.message.includes('\n'), 'one line');
    assert.ok(mentionsUrl(e.message, RELEASES_URL), `names the releases page: ${e.message}`);
    assert.ok(!e.message.includes(marker), 'no reply text');
    assert.doesNotMatch(e.message, /\bgh\b|GitHub CLI|SCRIPTORIUM_GITHUB_TOKEN|private/i);
    // The only URL in the message is the releases page.
    assert.equal(e.message.split(RELEASES_URL).join('').includes('http'), false, e.message);
    seen.add(e.reason);
  }
  assert.deepEqual([...seen].sort(), ['no-release', 'rate-limit', 'redirect', 'tls', 'unreachable']);
});

// --- the newest-prerelease hint --------------------------------------------------------------------

const rel = (tag, extra = {}) => ({ tag_name: tag, prerelease: true, draft: false, html_url: `https://example.invalid/${tag}`, ...extra });
const HINT = 'No stable release yet. The newest prerelease is v0.4.0-rc.2; run `gm-scriptorium update --pre` to get prereleases.';

test('the prerelease hint: a 404 on latest, then the list, names the newest prerelease by semver (exit 4, reason no-release)', async () => {
  const fake = byUrl({
    [URLS.latest]: { status: 404, body: '{}' },
    [URLS.list]: json([rel('v0.4.0-rc.1'), rel('v0.4.0-rc.2'), rel('v0.3.9-rc.7'), rel('v0.9.0-rc.9', { draft: true })]),
  });
  const e = await rejection(release.lookupRelease({}, { request: fake.request }));
  assert.ok(e instanceof UpdatePrerequisiteError);
  assert.equal(e.message, HINT);
  assert.equal(e.reason, 'no-release');
  assert.deepEqual(fake.calls.map((c) => c.url), [URLS.latest, URLS.list]);
  assert.deepEqual(fake.calls[1].headers, API_HEADERS);
});

test('the prerelease hint: any failure of the follow-up lookup keeps the plain wording, still exit 4', async () => {
  const plain = /no release has been published there yet/;
  const followUps = [
    { status: 404, body: '{}' },
    { status: 500, body: 'x' },
    { status: 200, body: 'not json' },
    { status: 200, body: '{}' },
    json([]),
    json([rel('v0.4.0-rc.9', { draft: true })]),
    json([{ tag_name: 'not-a-version', prerelease: true }]),
    new NetError('E_NET_CONNECT'),
    new NetError('E_NET_TLS'),
  ];
  for (const followUp of followUps) {
    const fake = byUrl({ [URLS.latest]: { status: 404, body: '{}' }, [URLS.list]: followUp });
    const e = await rejection(release.lookupRelease({}, { request: fake.request }));
    assert.ok(e instanceof UpdatePrerequisiteError);
    assert.match(e.message, plain);
    assert.equal(e.reason, 'no-release');
  }
});

test('the prerelease hint: not tried for --pre or --version, and not when latest is a 200 or another failure', async () => {
  for (const [flags, status] of [[{ pre: true }, 404], [{ version: 'v0.4.0' }, 404], [{}, 500], [{}, 429]]) {
    const fake = fakeRequest(() => ({ status, body: '{}' }));
    await rejection(release.lookupRelease(flags, { request: fake.request }));
    assert.equal(fake.calls.length, 1, JSON.stringify(flags) + status);
  }
  const ok = fakeRequest(() => json({ tag_name: 'v1.0.0' }));
  await release.lookupRelease({}, { request: ok.request });
  assert.equal(ok.calls.length, 1);
});

test('--pre: the highest version wins, whatever the list order, and a stable release counts', async () => {
  const list = [rel('v0.4.0-rc.1'), rel('v0.4.0', { prerelease: false }), rel('v0.4.0-rc.9'), rel('v0.5.0-rc.1', { draft: true }), { tag_name: 'junk' }];
  const got = await release.lookupRelease({ pre: true }, { request: byUrl({ [URLS.list]: json(list) }).request });
  assert.equal(got.tag_name, 'v0.4.0');
});

test('--pre: an empty list is the "nothing published" error (exit 4); a list with nothing usable is exit 1', async () => {
  const empty = await rejection(release.lookupRelease({ pre: true }, { request: byUrl({ [URLS.list]: json([]) }).request }));
  assert.ok(empty instanceof UpdatePrerequisiteError);
  assert.equal(empty.reason, 'no-release');
  const draftOnly = await rejection(
    release.lookupRelease({ pre: true }, { request: byUrl({ [URLS.list]: json([{ tag_name: 'v1.0.0', draft: true }]) }).request }),
  );
  assert.ok(draftOnly instanceof ScriptoriumError && !(draftOnly instanceof UpdatePrerequisiteError));
  assert.equal(draftOnly.message, 'no usable release found for DrNoisys-Softworks/gm-scriptorium');
});

// --- downloadAsset ---------------------------------------------------------------------------------

const TAG = 'v0.4.0-rc.1';
const ASSET = 'gm-scriptorium-win-x64.exe';

function downloadRoutes(extra = {}) {
  return {
    [`https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/${TAG}/${ASSET}`]: { status: 200, body: [Buffer.from('MZ'), Buffer.from('rest-of-file')] },
    [`https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/${TAG}/SHA256SUMS`]: { status: 200, body: 'abc  file\n' },
    ...extra,
  };
}

test('downloadAsset: the asset then SHA256SUMS are requested with the exact shape, and written into dir', async (t) => {
  const dir = scratch(t);
  const fake = byUrl(downloadRoutes());
  await release.downloadAsset(TAG, ASSET, dir, { request: fake.request });
  assert.equal(fake.calls.length, 2);
  const [asset, sums] = fake.calls;
  const base = `https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/${TAG}`;
  const { onResponse, onChunk, ...assetRest } = asset;
  assert.equal(typeof onResponse, 'function');
  assert.equal(typeof onChunk, 'function');
  assert.deepEqual(assetRest, {
    destination: 'github',
    url: `${base}/${ASSET}`,
    method: 'GET',
    headers: { 'user-agent': 'GM-Scriptorium/' + pkg.version },
    redirectTo: ['github-release-assets'],
    maxResponseBytes: 268435456,
    totalTimeoutMs: 1800000,
  });
  assert.deepEqual(sums, {
    destination: 'github',
    url: `${base}/SHA256SUMS`,
    method: 'GET',
    headers: { 'user-agent': 'GM-Scriptorium/' + pkg.version },
    redirectTo: ['github-release-assets'],
    maxResponseBytes: 65536,
  });
  assert.equal(fs.readFileSync(path.join(dir, ASSET), 'utf8'), 'MZrest-of-file');
  assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), 'abc  file\n');
});

test('downloadAsset: the tag is encoded into the URL and the signal is passed on', async (t) => {
  const dir = scratch(t);
  const ac = new AbortController();
  const fake = byUrl({
    [`https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/v1.0.0%2Bb/${ASSET}`]: { status: 200, body: 'MZ' },
    [`https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/v1.0.0%2Bb/SHA256SUMS`]: { status: 200, body: 'x' },
  });
  await release.downloadAsset('v1.0.0+b', ASSET, dir, { request: fake.request, signal: ac.signal });
  assert.equal(fake.calls[0].signal, ac.signal);
  assert.equal(fake.calls[1].signal, ac.signal);
});

test('downloadAsset: an unsafe tag or asset name is refused with exit 1 before any request', async (t) => {
  const dir = scratch(t);
  const cases = [
    ['v1.0.0/../x', ASSET],
    ['v1.0.0?x', ASSET],
    [TAG, '../evil'],
    [TAG, 'a/b'],
    [TAG, '..'],
    [TAG, ''],
    [TAG, 'x y'],
    [TAG, 5],
  ];
  for (const [tag, name] of cases) {
    const fake = fakeRequest(() => assert.fail('no request should be made'));
    const e = await rejection(release.downloadAsset(tag, name, dir, { request: fake.request }));
    assert.ok(e instanceof ScriptoriumError && !(e instanceof UpdatePrerequisiteError), `${tag} ${name}`);
    assert.equal(fake.calls.length, 0);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('downloadAsset: a non-200 writes nothing, and maps like a lookup (404, rate limit, other)', async (t) => {
  const rows = [
    [404, {}, 'no-release'],
    [429, {}, 'rate-limit'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate-limit'],
    [500, {}, 'unreachable'],
    [302, {}, 'unreachable'],
  ];
  for (const [status, headers, reason] of rows) {
    const dir = scratch(t);
    const fake = byUrl(downloadRoutes({ [`https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/${TAG}/${ASSET}`]: { status, headers, body: 'error page' } }));
    const e = await rejection(release.downloadAsset(TAG, ASSET, dir, { request: fake.request }));
    assert.ok(e instanceof UpdatePrerequisiteError, String(status));
    assert.equal(e.reason, reason, String(status));
    assert.deepEqual(fs.readdirSync(dir), [], `${status}: nothing written`);
    assert.equal(fake.calls.length, 1, 'SHA256SUMS is not requested after a failed asset');
  }
});

test('downloadAsset: a failing SHA256SUMS is an error too, and maps the same way', async (t) => {
  const dir = scratch(t);
  const sums = `https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/${TAG}/SHA256SUMS`;
  const e = await rejection(release.downloadAsset(TAG, ASSET, dir, { request: byUrl(downloadRoutes({ [sums]: { status: 404, body: '' } })).request }));
  assert.ok(e instanceof UpdatePrerequisiteError);
  assert.equal(e.reason, 'no-release');
});

test('downloadAsset: network errors map as for a lookup (exit 4 with a reason; a cap overrun is exit 1)', async (t) => {
  const asset = `https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/download/${TAG}/${ASSET}`;
  const rows = [
    ['E_NET_INCOMPLETE', 4, 'unreachable'],
    ['E_NET_TIMEOUT', 4, 'unreachable'],
    ['E_NET_TLS', 4, 'tls'],
    ['E_NET_REDIRECT', 4, 'redirect'],
    ['E_NET_RESPONSE_CAP', 1, undefined],
  ];
  for (const [code, exit, reason] of rows) {
    const dir = scratch(t);
    const e = await rejection(release.downloadAsset(TAG, ASSET, dir, { request: byUrl(downloadRoutes({ [asset]: new NetError(code, { status: 302, reason: 'off-list' }) })).request }));
    assert.equal(e instanceof UpdatePrerequisiteError, exit === 4, code);
    assert.equal(e.reason, reason, code);
  }
});

test('downloadAsset: the file is created new; an existing file is never overwritten (exit 1, content kept)', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, ASSET), 'precious');
  const e = await rejection(release.downloadAsset(TAG, ASSET, dir, { request: byUrl(downloadRoutes()).request }));
  assert.ok(e instanceof ScriptoriumError && !(e instanceof UpdatePrerequisiteError));
  assert.match(e.message, /^could not write the download \(EEXIST\)$/);
  assert.equal(fs.readFileSync(path.join(dir, ASSET), 'utf8'), 'precious');
});

test('downloadAsset: an unwritable folder is exit 1 with the system code only', async (t) => {
  const dir = path.join(scratch(t), 'does-not-exist');
  const e = await rejection(release.downloadAsset(TAG, ASSET, dir, { request: byUrl(downloadRoutes()).request }));
  assert.ok(e instanceof ScriptoriumError && !(e instanceof UpdatePrerequisiteError));
  assert.match(e.message, /^could not write the download \(ENOENT\)$/);
});

// --- the command, end to end through the real lookup and download with a fake request ---------------

function packagedDeps(t, fake, over = {}) {
  const root = scratch(t, 'scriptorium-update-cmd-');
  const exeDir = path.join(root, 'exe');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(exeDir);
  fs.mkdirSync(tmpRoot);
  const execPath = path.join(exeDir, 'scriptorium');
  fs.writeFileSync(execPath, 'stub-current-binary');
  return {
    execPath,
    tmpRoot,
    isPkg: true,
    platform: 'linux',
    arch: 'x64',
    lookupRelease: (flags) => release.lookupRelease(flags, { request: fake.request }),
    downloadAsset: (tag, name, dir) => release.downloadAsset(tag, name, dir, { request: fake.request }),
    ...over,
  };
}

test('the command: --check shows a release-notes link built from the tag, never the html_url in the reply', async (t) => {
  const evil = sentinel('evil');
  const fake = byUrl({ [URLS.latest]: json({ tag_name: 'v99.0.0', html_url: `https://${evil}.invalid/x` }) });
  const r = await runUpdateCommand({ check: true }, packagedDeps(t, fake));
  assert.equal(r.exitCode, 0, r.human);
  assert.ok(r.human.includes('Release notes: https://github.com/DrNoisys-Softworks/gm-scriptorium/releases/tag/v99.0.0'), r.human);
  assert.ok(!r.human.includes(evil));
});

test('the command: the exit codes of FR-22 hold for each failure kind', async (t) => {
  const rows = [
    ['no release', { status: 404, body: '{}' }, 4],
    ['rate limit', { status: 429, body: '{}' }, 4],
    ['server error', { status: 500, body: '{}' }, 4],
    ['offline', new NetError('E_NET_CONNECT'), 4],
    ['timeout', new NetError('E_NET_TIMEOUT'), 4],
    ['tls', new NetError('E_NET_TLS'), 4],
    ['redirect', new NetError('E_NET_REDIRECT', { reason: 'off-list' }), 4],
    ['malformed reply', { status: 200, body: 'not json' }, 1],
    ['oversize reply', new NetError('E_NET_RESPONSE_CAP'), 1],
  ];
  for (const [label, route, exit] of rows) {
    const fake = fakeRequest((opts) => (opts.url === URLS.list ? { status: 500, body: '' } : route));
    const r = await runUpdateCommand({ check: true }, packagedDeps(t, fake));
    assert.equal(r.exitCode, exit, `${label}: ${r.human}`);
    if (exit === 4) assert.ok(mentionsUrl(r.human, RELEASES_URL), label);
  }
});

test('the command: a full update downloads through the egress shape, verifies, and replaces', async (t) => {
  const exeBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(10), Buffer.from([0x3e, 0x00]), Buffer.alloc(32)]);
  const sha = require('crypto').createHash('sha256').update(exeBytes).digest('hex');
  const fake = byUrl({
    [URLS.latest]: json({ tag_name: 'v99.0.0' }),
    [URLS.download('v99.0.0', 'gm-scriptorium-linux-x64')]: { status: 200, body: [exeBytes.subarray(0, 20), exeBytes.subarray(20)] },
    [URLS.download('v99.0.0', 'SHA256SUMS')]: { status: 200, body: `${sha}  gm-scriptorium-linux-x64\n` },
  });
  const deps = packagedDeps(t, fake, { replaceExecutable: () => ({ oldPath: 'old-copy' }) });
  const r = await runUpdateCommand({}, deps);
  assert.equal(r.exitCode, 0, r.human);
  assert.match(r.human, /^updated .* -> v99\.0\.0\. Previous binary kept at old-copy\./);
  assert.deepEqual(fake.calls.map((c) => c.destination), ['github-api', 'github', 'github']);
  assert.equal(fs.readdirSync(deps.tmpRoot).length, 0, 'the download folder is gone');
});

test('the command: a checksum mismatch is exit 1 and nothing is installed', async (t) => {
  const fake = byUrl({
    [URLS.latest]: json({ tag_name: 'v99.0.0' }),
    [URLS.download('v99.0.0', 'gm-scriptorium-linux-x64')]: { status: 200, body: 'tampered' },
    [URLS.download('v99.0.0', 'SHA256SUMS')]: { status: 200, body: `${'0'.repeat(64)}  gm-scriptorium-linux-x64\n` },
  });
  let replaced = false;
  const r = await runUpdateCommand({}, packagedDeps(t, fake, { replaceExecutable: () => { replaced = true; return { oldPath: 'x' }; } }));
  assert.equal(r.exitCode, 1, r.human);
  assert.match(r.human, /checksum mismatch/);
  assert.equal(replaced, false);
});

test('the command: --version with an unsafe tag exits 1 with the plain message and makes no request', async (t) => {
  for (const bad of ['v1.0.0/../x', 'latest', '../x', 'v1.0.0?x=1']) {
    const fake = fakeRequest(() => assert.fail('no request should be made'));
    const r = await runUpdateCommand({ version: bad }, packagedDeps(t, fake));
    assert.equal(r.exitCode, 1, bad);
    assert.equal(r.human, 'update failed: --version needs a release tag like v0.4.0');
    assert.equal(fake.calls.length, 0);
  }
});

// --- the bin entry (catches a missing await) ---------------------------------------------------------

test('bin: from source, `update` under a scratch config exits 4 with the source-run message', (t) => {
  const root = scratch(t, 'scriptorium-update-bin-');
  const env = { ...process.env, SCRIPTORIUM_CONFIG: path.join(root, 'unused-config.toml'), APPDATA: path.join(root, 'appdata'), XDG_CONFIG_HOME: path.join(root, 'xdg') };
  delete env.SCRIPTORIUM_PROFILE;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'scriptorium.js'), 'update'], { encoding: 'utf8', env, timeout: 20000 });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stdout, /update only runs inside a packaged GM-Scriptorium executable/);
  assert.doesNotMatch(r.stdout + r.stderr, /\[object Promise\]|undefined/);
});

// --- source rules ------------------------------------------------------------------------------------

test('no gh, no token and no child_process remain in src/ or bin/', () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  const files = [...walk(path.join(__dirname, '..', 'src')), ...walk(path.join(__dirname, '..', 'bin'))];
  assert.ok(files.length > 100);
  const banned = /SCRIPTORIUM_GITHUB_TOKEN|GH_TOKEN|runGh|requireGh/;
  for (const f of files) assert.ok(!banned.test(fs.readFileSync(f, 'utf8')), f);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'update', 'gh.js')), false);
  for (const f of walk(path.join(__dirname, '..', 'src', 'update'))) {
    assert.ok(!/child_process/.test(fs.readFileSync(f, 'utf8')), `${f} must not name child_process`);
  }
});

test('release.js: reply URLs are never read (no html_url, browser_download_url or url property)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'update', 'release.js'), 'utf8');
  assert.ok(!/html_url|browser_download_url|\.assets\b|zipball_url|tarball_url/.test(src));
});
