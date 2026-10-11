'use strict';

/*
 * Issue #51: while a project has only prereleases, GitHub's /releases/latest answers 404, so
 * plain `update` and `update --check` used to say "no release has been published there yet".
 * They now say there is no stable release, name the newest prerelease and point at --pre. The
 * exit code stays 4 (update prerequisite): the frozen exit table does not change. A fake `gh`
 * shell script answers per endpoint. Expected strings are stated here, not derived from the code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runUpdateCommand } = require('../src/cli/update');

const PUBLISHED_YET = /no release has been published there yet/;

/**
 * A fake gh. `latest` answers /releases/latest, `list` answers /releases?per_page=30; each is
 * { stdout, stderr, status }. Every call is appended to <root>/calls.
 */
function fakeGh(root, { latest, list }) {
  for (const [name, r] of [['latest', latest], ['list', list]]) {
    fs.writeFileSync(path.join(root, `${name}.out`), r.stdout || '');
    fs.writeFileSync(path.join(root, `${name}.err`), r.stderr || '');
    fs.writeFileSync(path.join(root, `${name}.status`), String(r.status || 0));
  }
  const p = path.join(root, 'gh');
  fs.writeFileSync(
    p,
    `#!/bin/sh
echo "$*" >> "${root}/calls"
case "$*" in
  *releases/latest*) k=latest ;;
  *releases?per_page*) k=list ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
cat "${root}/$k.out"
cat "${root}/$k.err" >&2
exit "$(cat "${root}/$k.status")"
`,
    { mode: 0o755 },
  );
  return p;
}

function run(flags, gh) {
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-51-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NOT_FOUND = { stderr: 'gh: Not Found (HTTP 404)', status: 1 };
const rel = (tag, extra = {}) => ({ tag_name: tag, prerelease: true, draft: false, html_url: `https://example.invalid/${tag}`, ...extra });

for (const flags of [{}, { check: true }]) {
  test(`#51: ${flags.check ? 'update --check' : 'update'} with only prereleases says so, names the newest, points at --pre, exits 4`, () => {
    withScratch((root) => {
      const list = JSON.stringify([rel('v0.4.0-rc.1'), rel('v0.4.0-rc.2'), rel('v0.3.9-rc.7')]);
      const result = run(flags, fakeGh(root, { latest: NOT_FOUND, list: { stdout: list } }));
      assert.equal(result.exitCode, 4, result.human);
      assert.equal(
        result.human,
        'No stable release yet. The newest prerelease is v0.4.0-rc.2; run `gm-scriptorium update --pre` to get prereleases.',
      );
    });
  });
}

test('#51: a draft-only list is not offered as a prerelease; the old wording stays, exit 4', () => {
  withScratch((root) => {
    const list = JSON.stringify([rel('v0.4.0-rc.9', { draft: true })]);
    const result = run({ check: true }, fakeGh(root, { latest: NOT_FOUND, list: { stdout: list } }));
    assert.equal(result.exitCode, 4, result.human);
    assert.match(result.human, PUBLISHED_YET);
  });
});

test('#51: nothing published at all (404 then an empty list) keeps the old wording, exit 4', () => {
  withScratch((root) => {
    const result = run({ check: true }, fakeGh(root, { latest: NOT_FOUND, list: { stdout: '[]' } }));
    assert.equal(result.exitCode, 4, result.human);
    assert.match(result.human, PUBLISHED_YET);
  });
});

test('#51: if the follow-up lookup also fails, the old wording stays, exit 4 (never a new failure)', () => {
  withScratch((root) => {
    const result = run({ check: true }, fakeGh(root, { latest: NOT_FOUND, list: NOT_FOUND }));
    assert.equal(result.exitCode, 4, result.human);
    assert.match(result.human, PUBLISHED_YET);
  });
});

test('#51: a stable release still wins; no follow-up lookup is made', () => {
  withScratch((root) => {
    const stable = JSON.stringify(rel('v99.0.0', { prerelease: false }));
    const gh = fakeGh(root, { latest: { stdout: stable }, list: { stdout: '[]' } });
    const result = run({ check: true }, gh);
    assert.equal(result.exitCode, 0, result.human);
    assert.match(result.human, /update available: .* -> v99\.0\.0/);
    assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').length, 1);
  });
});

test('#51: a non-404 failure on /releases/latest stays exit 1 and makes no follow-up lookup', () => {
  withScratch((root) => {
    const gh = fakeGh(root, { latest: { stderr: 'HTTP 500', status: 1 }, list: { stdout: JSON.stringify([rel('v0.4.0-rc.1')]) } });
    const result = run({ check: true }, gh);
    assert.equal(result.exitCode, 1, result.human);
    assert.match(result.human, /^update failed: gh api failed: HTTP 500/);
    assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').length, 1);
  });
});

test('#51: --pre is unchanged (still picks the newest prerelease and carries on)', () => {
  withScratch((root) => {
    const list = JSON.stringify([rel('v0.4.0-rc.1'), rel('v99.0.0-rc.1')]);
    const result = run({ check: true, pre: true }, fakeGh(root, { latest: NOT_FOUND, list: { stdout: list } }));
    assert.equal(result.exitCode, 0, result.human);
    assert.match(result.human, /update available: .* -> v99\.0\.0-rc\.1/);
  });
});
