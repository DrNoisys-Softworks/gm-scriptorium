'use strict';

/*
 * F1 (S6): `update --pre` against a repository with no releases (the brand-new public repo:
 * GET releases?per_page=30 returns `[]`) is an expected state, not a Scriptorium bug. It must
 * exit 4 (update prerequisite) with the same "no release published yet" wording that the
 * /releases/latest 404 path gives. A fake `gh` shell script drives the REAL fetchLatestRelease
 * and runUpdateCommand. Expected values are stated here, not derived from the code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUpdateCommand } = require('../src/cli/update');
const { fetchLatestRelease } = require('../src/update/release');

const PUBLISHED_YET = /no release has been published there yet/;
const RELEASES_URL = 'https://github.com/DrNoisys-Softworks/gm-scriptorium/releases';

/** Writes an executable fake gh that prints `stdout` / `stderr` and exits `status` for `gh api ...`. */
function fakeGh(root, { stdout = '', stderr = '', status = 0 }) {
  fs.writeFileSync(path.join(root, 'out'), stdout);
  fs.writeFileSync(path.join(root, 'err'), stderr);
  const p = path.join(root, 'gh');
  fs.writeFileSync(p, `#!/bin/sh\ncat "${root}/out"\ncat "${root}/err" >&2\nexit ${status}\n`, { mode: 0o755 });
  return p;
}

function run(flags, gh) {
  // Packaged-path deps (the source-mode guard would otherwise answer first); the exe and tmp
  // dirs live beside the fake gh in the scratch root, so nothing outside it is touched.
  const root = path.dirname(gh);
  const exeDir = path.join(root, 'exe');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  const execPath = path.join(exeDir, 'scriptorium');
  fs.writeFileSync(execPath, 'stub-current-binary');
  return runUpdateCommand(flags, { requireGh: () => gh, execPath, tmpRoot, isPkg: true, platform: 'linux' });
}

function withScratch(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-f1-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('F1: `update --check --pre` with an empty release list exits 4 with the "published yet" wording', () => {
  withScratch((root) => {
    const result = run({ check: true, pre: true }, fakeGh(root, { stdout: '[]' }));
    assert.equal(result.exitCode, 4, result.human);
    assert.match(result.human, PUBLISHED_YET);
    assert.ok(result.human.includes(RELEASES_URL));
    assert.doesNotMatch(result.human, /update failed/);
  });
});

test('F1: `update --pre` (install) with an empty release list also exits 4', () => {
  withScratch((root) => {
    const result = run({ pre: true }, fakeGh(root, { stdout: '[]' }));
    assert.equal(result.exitCode, 4, result.human);
    assert.match(result.human, PUBLISHED_YET);
  });
});

test('F1: the empty-list message is word-for-word the 404 message (consistent across the two paths)', () => {
  withScratch((root) => {
    const empty = run({ check: true, pre: true }, fakeGh(root, { stdout: '[]' }));
    const notFound = run({ check: true }, fakeGh(root, { stderr: 'gh: Not Found (HTTP 404)', status: 1 }));
    assert.equal(notFound.exitCode, 4);
    assert.match(notFound.human, PUBLISHED_YET);
    assert.equal(empty.human, notFound.human);
  });
});

test('F1 control: --pre 404 on the list endpoint is still exit 4', () => {
  withScratch((root) => {
    const result = run({ check: true, pre: true }, fakeGh(root, { stderr: 'HTTP 404', status: 1 }));
    assert.equal(result.exitCode, 4);
    assert.match(result.human, PUBLISHED_YET);
  });
});

test('F1 control: empty list WITHOUT --pre (/releases/latest returning []) is not treated as "no release" and is unchanged', () => {
  withScratch((root) => {
    // Without --pre the body is returned as-is; an empty array has no tag_name, so it is not a
    // usable release and must not be reported as the prerequisite state by this fix.
    const parsed = fetchLatestRelease(fakeGh(root, { stdout: '[]' }), { pre: false });
    assert.deepEqual(parsed, []);
  });
});

test('F1 control: --pre list that is non-empty but has no usable release (draft only) stays exit 1', () => {
  withScratch((root) => {
    const body = JSON.stringify([{ tag_name: 'v1.0.0', draft: true }]);
    const result = run({ check: true, pre: true }, fakeGh(root, { stdout: body }));
    assert.equal(result.exitCode, 1, result.human);
    assert.match(result.human, /^update failed: no usable release found for DrNoisys-Softworks\/gm-scriptorium$/);
  });
});

test('F1 control: genuinely malformed JSON stays exit 1', () => {
  withScratch((root) => {
    const result = run({ check: true, pre: true }, fakeGh(root, { stdout: 'not json{' }));
    assert.equal(result.exitCode, 1);
    assert.match(result.human, /^update failed: gh returned malformed JSON/);
  });
});

test('F1 control: a non-404 gh failure stays exit 1', () => {
  withScratch((root) => {
    const result = run({ check: true, pre: true }, fakeGh(root, { stderr: 'HTTP 500', status: 1 }));
    assert.equal(result.exitCode, 1);
    assert.match(result.human, /^update failed: gh api failed: HTTP 500/);
  });
});
