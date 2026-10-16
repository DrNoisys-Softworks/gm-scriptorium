'use strict';

/*
 * The screenshot harness (scripts/docs-screenshots.js): its picture list, the two pure folder
 * checks and the refusals in main(). No browser is started here. The capture itself is run by hand
 * and its pictures are checked by a person. Every expected value is a literal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SHOTS, outDirProblem, userSegmentProblem, main } = require('../scripts/docs-screenshots');

const REPO = '/work/gm-scriptorium';

test('SHOTS: the names, in order', () => {
  assert.deepEqual(
    SHOTS.map((s) => s.file),
    [
      'how-to/setup-new-vault.png',
      'how-to/setup-review.png',
      'how-to/campaigns-screen.png',
      'how-to/add-a-campaign.png',
      'how-to/campaign-switcher.png',
      'how-to/theme-screen.png',
      'how-to/images-screen.png',
      'how-to/title-and-tagline.png',
      'how-to/vocabulary-screen.png',
      'how-to/vault-config-fields.png',
      'how-to/check-leak-found.png',
      'how-to/site-footer-gm-link.png',
      'how-to/remote-access-screen.png',
    ]
  );
});

test('SHOTS: frozen, well named, unique, with plain alt text and a page', () => {
  assert.equal(Object.isFrozen(SHOTS), true);
  const seen = new Set();
  for (const s of SHOTS) {
    assert.equal(Object.isFrozen(s), true, s.file);
    assert.match(s.file, /^how-to\/[a-z0-9-]+\.png$/);
    assert.equal(seen.has(s.file), false, `duplicate ${s.file}`);
    seen.add(s.file);
    assert.ok(s.alt.length > 0 && s.alt.length <= 200, `${s.file} alt length ${s.alt.length}`);
    assert.doesNotMatch(s.alt, /[-\u2010-\u2015\u2192\u2190>]/, `${s.file} alt has a dash or an arrow`);
    assert.match(s.page, /^(docs\/how-to\/[a-z0-9-]+\.md|docs\/remote-access\.md)$/, s.file);
  }
});

test('SHOTS: Overview is not in the list', () => {
  assert.equal(SHOTS.some((s) => /overview/.test(s.file)), false);
});

test('outDirProblem: the repository itself, the images folder and a relative path are refused', () => {
  assert.equal(typeof outDirProblem(REPO, REPO), 'string');
  assert.equal(typeof outDirProblem(REPO, `${REPO}/docs/images`), 'string');
  assert.equal(typeof outDirProblem(REPO, `${REPO}/docs/images/how-to`), 'string');
  assert.equal(typeof outDirProblem(REPO, 'shots'), 'string');
  assert.equal(typeof outDirProblem(REPO, '../shots'), 'string');
  assert.equal(typeof outDirProblem(REPO, `${REPO}/..shots`), 'string', 'a folder whose name starts with two dots is still inside');
});

test('outDirProblem: a folder outside the repository is fine, including a name that starts the same', () => {
  assert.equal(outDirProblem(REPO, `${REPO}-shots`), null);
  assert.equal(outDirProblem(REPO, '/tmp/lease-docs'), null);
  assert.equal(outDirProblem(REPO, '/work'), null);
});

test('userSegmentProblem: a folder named after the user is refused, a longer name is not', () => {
  assert.equal(userSegmentProblem('/tmp/lease-docs', 'alice'), null);
  assert.equal(typeof userSegmentProblem('/srv/alice/x', 'alice'), 'string');
  assert.equal(userSegmentProblem('/tmp/alicex/y', 'alice'), null);
  assert.equal(typeof userSegmentProblem('D:\\Campaigns\\alice\\x', 'alice'), 'string');
  assert.equal(userSegmentProblem('/tmp/lease-docs', ''), null);
});

function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-shots-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function run(args, extra = {}) {
  const out = [];
  const errs = [];
  const calls = [];
  const code = await main(args, {
    repoRoot: REPO,
    username: 'alice',
    loadPlaywright: () => ({ fake: true }),
    capture: async (o) => {
      calls.push(o);
    },
    log: (m) => out.push(m),
    err: (m) => errs.push(m),
    ...extra,
  });
  return { code, out, errs, calls };
}

test('main: missing or unknown arguments exit 2 and capture nothing', async (t) => {
  const d = scratch(t);
  for (const args of [[], ['--out', path.join(d, 'o')], ['--root', path.join(d, 'r')], ['--bogus'], ['--out']]) {
    const r = await run(args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.equal(r.calls.length, 0);
  }
});

test('main: refuses a folder inside the repository, a user-named root, an existing folder and an unknown --only', async (t) => {
  const d = scratch(t);
  const ok = { out: path.join(d, 'out'), root: path.join(d, 'root') };
  assert.equal((await run(['--out', `${REPO}/docs/images`, '--root', ok.root])).code, 2);
  assert.equal((await run(['--out', ok.out, '--root', `${REPO}/tmp`])).code, 2);
  assert.equal((await run(['--out', ok.out, '--root', path.join(d, 'alice', 'root')])).code, 2);
  assert.equal((await run(['--out', d, '--root', ok.root])).code, 2, 'out exists');
  assert.equal((await run(['--out', ok.out, '--root', d])).code, 2, 'root exists');
  assert.equal((await run(['--out', ok.out, '--root', ok.out])).code, 2, 'same folder');
  assert.equal((await run(['--out', ok.out, '--root', ok.root, '--only', 'how-to/nope.png'])).code, 2);
  const none = await run(['--out', ok.out, '--root', ok.root], { loadPlaywright: () => null });
  assert.equal(none.code, 2, 'no Playwright');
  assert.equal(none.calls.length, 0);
});

test('main: the output folder may be named after the user (it is never drawn into a picture)', async (t) => {
  const d = scratch(t);
  const r = await run(['--out', path.join(d, 'alice', 'out'), '--root', path.join(d, 'root')]);
  assert.equal(r.code, 0);
});

test('main: a good call hands the folders and --only to the capture and exits 0; a capture error exits 1', async (t) => {
  const d = scratch(t);
  const o = path.join(d, 'out');
  const rt = path.join(d, 'root');
  const r = await run(['--out', o, '--root', rt, '--only', 'how-to/theme-screen.png']);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].outDir, o);
  assert.equal(r.calls[0].root, rt);
  assert.equal(r.calls[0].only, 'how-to/theme-screen.png');
  const bad = await run(['--out', o, '--root', rt], {
    capture: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.errs, ['docs-screenshots: boom']);
  assert.equal(fs.existsSync(o), false, 'the stub wrote nothing');
});

test('the script never names the images folder as a place to write, and loads Playwright only inside main', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'docs-screenshots.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  assert.equal(/docs[\\/'",\s]+images/.test(code), false);
  assert.equal(/^const .*require\(['"]playwright/m.test(code), false);
});
