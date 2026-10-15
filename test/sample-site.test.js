'use strict';

/*
 * The hosted-sample pipeline (scripts/sample-site.js) and the leak demo generator
 * (scripts/leak-demo.js). One real pipeline run happens in `before`, into a throwaway root; the
 * rest are controls. Every gate in the pipeline has a control that makes it fire, because a gate
 * that has never fired may not work.
 *
 * Expected values here are literals, not read from the scripts: the withheld name, the probe
 * sentence, the site URL and the example path are written out again on purpose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'scriptorium.js');
const SITE_SCRIPT = path.join(ROOT, 'scripts', 'sample-site.js');
const DEMO_SCRIPT = path.join(ROOT, 'scripts', 'leak-demo.js');
const SAMPLE = path.join(ROOT, 'examples', 'the-long-lease');

const NAME = 'Ottoline Pardew';
const PROBE = 'Trade is brisk and sleep is poor.';
const SITE_URL = 'https://drnoisys-softworks.github.io/gm-scriptorium/';

const made = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashTree(root) {
  const map = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) map[path.relative(root, p).split(path.sep).join('/')] = sha(p);
    }
  })(root);
  return map;
}

function listFiles(root) {
  return Object.keys(hashTree(root)).sort();
}

function htmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const sampleBefore = hashTree(SAMPLE);
let mod;
let demoMod;
let rootA;
let runA;

test.before(() => {
  mod = require(SITE_SCRIPT);
  demoMod = require(DEMO_SCRIPT);
  rootA = tmp('sample-site-a-');
  runA = mod.runSampleSite({ command: [process.execPath, BIN], root: rootA });
});

test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// -- S1 to S5: the real run -----------------------------------------------------------------------

test('S1: the pipeline passes and the steps are exactly prepare, build, check, stage, demo, final, PASS', () => {
  assert.equal(runA.ok, true, JSON.stringify(runA));
  assert.deepEqual(
    runA.lines.map((l) => l.split(' ')[1]),
    ['prepare', 'build', 'check', 'stage', 'demo', 'final', 'PASS'],
  );
  for (const l of runA.lines.slice(0, 6)) assert.match(l, /^SITE \w+ ok /, l);
  assert.equal(runA.lines[6], 'SITE PASS');
  // The stage note carries the number of files compared; it must equal an independent count.
  const stage = runA.lines[3].split(' ');
  assert.equal(Number(stage[3]), listFiles(path.join(rootA, '.sample-site', 'out')).length);
  assert.ok(Number(stage[3]) > 50, 'the sample site has far more than 50 files');
  // The final note carries the number of files swept: every file in _site, the demo included.
  const final = runA.lines[5].split(' ');
  assert.equal(Number(final[3]), listFiles(path.join(rootA, '_site')).length);
  assert.equal(Number(final[3]), Number(stage[3]) + 1);
});

test('S2: _site is the checked tree plus only leak-demo.html, and out never holds the demo', () => {
  const out = hashTree(path.join(rootA, '.sample-site', 'out'));
  const site = hashTree(path.join(rootA, '_site'));
  assert.equal('leak-demo.html' in out, false);
  assert.equal('leak-demo.html' in site, true);
  const rest = { ...site };
  delete rest['leak-demo.html'];
  assert.deepEqual(rest, out);
  assert.deepEqual(Object.keys(site).filter((k) => !(k in out)), ['leak-demo.html']);
  // Scratch files never sit in the artefact.
  for (const k of Object.keys(site)) {
    assert.equal(/config\.toml|unused-|^pack\//.test(k), false, k);
  }
});

test('S3: the 404 page links sit under /gm-scriptorium/', () => {
  const html = fs.readFileSync(path.join(rootA, '_site', '404.html'), 'utf8');
  assert.ok(html.includes('href="/gm-scriptorium/index.html"'));
  assert.ok(html.includes('href="/gm-scriptorium/css/style.css"'));
  assert.equal(html.includes('href="/css/'), false);
  assert.equal(html.includes('href="/index.html"'), false);
});

test('S4: the config names the tracked vault and a scratch pack, and the tracked sample is untouched', () => {
  const toml = fs.readFileSync(path.join(rootA, '.sample-site', 'config.toml'), 'utf8');
  const vaultLines = toml.split('\n').filter((l) => /^vault = /.test(l));
  assert.equal(vaultLines.length, 1);
  assert.equal(vaultLines[0], `vault = '${SAMPLE.split(path.sep).join('/')}'`);
  const packLines = toml.split('\n').filter((l) => /^pack = /.test(l));
  assert.equal(packLines.length, 1);
  assert.equal(packLines[0], `pack = '${path.join(rootA, '.sample-site', 'pack').split(path.sep).join('/')}'`);
  assert.equal(toml.includes('site_config'), false);

  const tracked = JSON.parse(fs.readFileSync(path.join(SAMPLE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
  const derived = JSON.parse(fs.readFileSync(path.join(rootA, '.sample-site', 'pack', 'vault.config.json'), 'utf8'));
  assert.equal('siteUrl' in tracked, false);
  assert.deepEqual(derived, { ...tracked, siteUrl: SITE_URL });
  // The rest of the derived pack is the tracked pack.
  const a = hashTree(path.join(SAMPLE, '_meta', 'scriptorium'));
  const b = hashTree(path.join(rootA, '.sample-site', 'pack'));
  delete a['vault.config.json'];
  delete b['vault.config.json'];
  assert.deepEqual(b, a);
  assert.deepEqual(hashTree(SAMPLE), sampleBefore);
});

test('S5: the withheld name and the GM Notes heading appear in no site file except the demo', () => {
  const site = path.join(rootA, '_site');
  for (const rel of listFiles(site)) {
    if (rel === 'leak-demo.html') continue;
    const text = fs.readFileSync(path.join(site, rel), 'latin1');
    assert.equal(/ottoline/i.test(text), false, `ottoline in ${rel}`);
    assert.equal(/pardew/i.test(text), false, `pardew in ${rel}`);
    assert.equal(/gm notes/i.test(text), false, `gm notes in ${rel}`);
  }
  const demo = fs.readFileSync(path.join(site, 'leak-demo.html'), 'utf8');
  assert.ok(demo.includes(NAME));
});

// -- S6: prepare refuses and creates nothing -------------------------------------------------------

test('S6: a pre-existing scratch or staging folder fails at prepare and nothing else is created', () => {
  const r1 = tmp('sample-site-s6a-');
  fs.mkdirSync(path.join(r1, '.sample-site'));
  const res1 = mod.runSampleSite({ command: [process.execPath, BIN], root: r1 });
  assert.equal(res1.ok, false);
  assert.equal(res1.step, 'prepare');
  assert.equal(res1.reason, 'scratch-exists');
  assert.deepEqual(fs.readdirSync(r1), ['.sample-site']);
  assert.deepEqual(fs.readdirSync(path.join(r1, '.sample-site')), []);

  const r2 = tmp('sample-site-s6b-');
  fs.mkdirSync(path.join(r2, '_site'));
  const res2 = mod.runSampleSite({ command: [process.execPath, BIN], root: r2 });
  assert.equal(res2.ok, false);
  assert.equal(res2.step, 'prepare');
  assert.equal(res2.reason, 'staging-exists');
  assert.deepEqual(fs.readdirSync(r2), ['_site']);
});

test('S6b: preparePack refuses a tracked pack that already has siteUrl, and adds the URL to the copy only', () => {
  const src = tmp('sample-site-pack-src-');
  fs.cpSync(path.join(SAMPLE, '_meta', 'scriptorium'), src, { recursive: true });
  const cfgPath = path.join(src, 'vault.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, siteUrl: 'https://example.invalid/x/' }));
  const dest = path.join(tmp('sample-site-pack-dst-'), 'pack');
  const res = mod.preparePack({ packSrc: src, packDest: dest });
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'pack-has-siteUrl' });
  assert.equal(fs.existsSync(dest), false);

  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const before = hashTree(src);
  const ok = mod.preparePack({ packSrc: src, packDest: dest });
  assert.equal(ok.ok, true);
  assert.deepEqual(hashTree(src), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest, 'vault.config.json'), 'utf8')), { ...cfg, siteUrl: SITE_URL });
});

// -- S7: every gate fires --------------------------------------------------------------------------

/**
 * A wrapper around the real CLI that edits what it reports. It lives in a folder outside the
 * pipeline root, otherwise prepare would refuse on the scratch folder and prove nothing.
 */
function wrapperDir() {
  return tmp('sample-site-wrap-');
}

function writeWrapper(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    [
      "'use strict';",
      "const { spawnSync } = require('child_process');",
      'const [real, ...args] = process.argv.slice(2);',
      "const res = spawnSync(process.execPath, [real, ...args], { env: process.env, encoding: 'utf8' });",
      'const verb = args[0];',
      'let out = res.stdout;',
      'let code = res.status;',
      body,
      'process.stdout.write(out);',
      'process.exit(code);',
    ].join('\n'),
  );
  return file;
}

function runWrapped(body, name) {
  const dir = wrapperDir();
  const w = writeWrapper(dir, name, body);
  const root = tmp('sample-site-s7-');
  const res = mod.runSampleSite({ command: [process.execPath, w, BIN], root });
  return { res, root };
}

test('S7a: build exiting 2 with a good envelope fails at build, and _site is absent', () => {
  const { res, root } = runWrapped("if (verb === 'build') code = 2;", 'build-exit2.js');
  assert.equal(res.ok, false);
  assert.equal(res.step, 'build');
  assert.equal(res.reason, 'exit 2');
  assert.equal(fs.existsSync(path.join(root, '_site')), false);
});

test('S7b: build exiting 0 with ok:false fails at build', () => {
  const { res, root } = runWrapped(
    "if (verb === 'build') { const j = JSON.parse(out); j.ok = false; out = JSON.stringify(j); }",
    'build-notok.js',
  );
  assert.equal(res.ok, false);
  assert.equal(res.step, 'build');
  assert.equal(res.reason, 'exit 0');
  assert.equal(fs.existsSync(path.join(root, '_site')), false);
});

test('S7c: build printing something that is not JSON fails at build with bad-json', () => {
  const { res } = runWrapped("if (verb === 'build') out = 'not json';", 'build-badjson.js');
  assert.equal(res.step, 'build');
  assert.equal(res.reason, 'bad-json');
});

test('S7d: a program that cannot be started fails at build with spawn', () => {
  const root = tmp('sample-site-s7d-');
  const res = mod.runSampleSite({ command: ['/nonexistent/program'], root });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'build');
  assert.match(res.reason, /^spawn ENOENT$/);
  assert.equal(fs.existsSync(path.join(root, '_site')), false);
});

test('S7e: check exiting 2 fails at check, and _site is absent', () => {
  const { res, root } = runWrapped("if (verb === 'check') code = 2;", 'check-exit2.js');
  assert.equal(res.ok, false);
  assert.equal(res.step, 'check');
  assert.equal(res.reason, 'exit 2');
  assert.equal(fs.existsSync(path.join(root, '_site')), false);
});

test('S7f: check exiting 0 but reporting a leak error fails at check with leak-error', () => {
  const body =
    "if (verb === 'check') { const j = JSON.parse(out); j.findings.push({ id: 'leak/l4-output-name', severity: 'error', outputPath: 'index.html' }); out = JSON.stringify(j); code = 0; }";
  const { res, root } = runWrapped(body, 'check-leak.js');
  assert.equal(res.ok, false);
  assert.equal(res.step, 'check');
  assert.equal(res.reason, 'leak-error leak/l4-output-name');
  assert.equal(fs.existsSync(path.join(root, '_site')), false);
});

test('S7g: check exiting 0 but counting an error fails at check with errors', () => {
  const body =
    "if (verb === 'check') { const j = JSON.parse(out); j.counts.error = 1; out = JSON.stringify(j); code = 0; }";
  const { res } = runWrapped(body, 'check-errors.js');
  assert.equal(res.step, 'check');
  assert.equal(res.reason, 'errors 1');
});

test('S7h: check printing something that is not JSON fails at check with bad-json', () => {
  const { res } = runWrapped("if (verb === 'check') out = '';", 'check-badjson.js');
  assert.equal(res.step, 'check');
  assert.equal(res.reason, 'bad-json');
});

// -- S8: no arguments ---------------------------------------------------------------------------------

test('S8: any argument exits 1 with SITE FAIL usage and creates nothing', () => {
  const before = fs.readdirSync(ROOT).sort();
  const res = spawnSync(process.execPath, [SITE_SCRIPT, 'x'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^SITE FAIL usage node scripts\/sample-site\.js$/m);
  assert.deepEqual(fs.readdirSync(ROOT).sort(), before);
});

// -- S9: source pins ------------------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('S9: the pipeline source isolates config, avoids force and deletion, and takes no argument', () => {
  const src = stripComments(fs.readFileSync(SITE_SCRIPT, 'utf8'));
  for (const token of ['env.SCRIPTORIUM_CONFIG = ', 'env.APPDATA = ', 'env.XDG_CONFIG_HOME = ', "'--config'", 'shell: false']) {
    assert.ok(src.includes(token), `source must contain ${token}`);
  }
  assert.match(src, /delete env\.SCRIPTORIUM_PROFILE/);
  for (const bad of ['--force', '--no-check', 'site_config', '--site-config', '--vault', '--out', 'rmSync', 'unlinkSync', 'rmdirSync']) {
    assert.equal(src.includes(bad), false, `source must not contain ${bad}`);
  }
  assert.equal((src.match(/process\.env/g) || []).length, 1);
  assert.ok(src.includes('{ ...process.env }'));
  assert.equal((src.match(/process\.argv/g) || []).length, 1);
  assert.ok(src.includes('function runSampleSite({ command, root })'));
});

test('S9b: neither script holds the withheld name, and the demo generator writes nothing', () => {
  const site = fs.readFileSync(SITE_SCRIPT, 'utf8');
  const demo = fs.readFileSync(DEMO_SCRIPT, 'utf8');
  assert.equal(/ottoline|pardew/i.test(site), false);
  assert.equal(/ottoline|pardew/i.test(demo), false);
  const code = stripComments(demo);
  for (const bad of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'cpSync', 'rmSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'createWriteStream']) {
    assert.equal(code.includes(bad), false, `leak-demo.js must not contain ${bad}`);
  }
});

// -- amendment 1: the staged-copy compare fires ---------------------------------------------------------

function miniTree(files) {
  const d = tmp('sample-site-tree-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  return d;
}

test('A1: compareTrees passes identical trees and counts the files', () => {
  const a = miniTree({ 'a.html': 'one', 'sub/b.css': 'two', 'sub/deep/c.txt': 'three' });
  const b = miniTree({ 'a.html': 'one', 'sub/b.css': 'two', 'sub/deep/c.txt': 'three' });
  assert.deepEqual(mod.compareTrees(a, b), { ok: true, count: 3 });
});

test('A1: compareTrees returns tree-differs for one changed byte, one extra file and one missing file', () => {
  const base = { 'a.html': 'one', 'sub/b.css': 'two' };
  const a = miniTree(base);
  const changed = miniTree({ ...base, 'a.html': 'onf' });
  const extra = miniTree({ ...base, 'sub/more.txt': 'x' });
  const missing = miniTree({ 'a.html': 'one' });
  for (const other of [changed, extra, missing]) {
    const res = mod.compareTrees(a, other);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'tree-differs');
    const rev = mod.compareTrees(other, a);
    assert.equal(rev.ok, false);
    assert.equal(rev.reason, 'tree-differs');
  }
});

// -- amendment 2: the final sweep fires -----------------------------------------------------------------

const GM_RUN = 'keeps a locked room at the top of the counting house, under the roof, that nobody visits.';

function sweepSite(extra, demo = `<p>${NAME} is the name</p>`) {
  const files = {
    'index.html': '<p>Welcome</p>',
    'locations/town.html': '<p>A town</p>',
    'NOTICE.txt': 'Third-party notices',
    ...extra,
  };
  if (demo !== null) files['leak-demo.html'] = demo;
  return miniTree(files);
}

test('A2: sweepSite passes a clean site whose demo holds the name', () => {
  const res = mod.sweepSite({ siteDir: sweepSite({}), name: NAME, runs: [GM_RUN] });
  assert.equal(res.ok, true);
});

test('A2: sweepSite finds the name in a nested page, in NOTICE.txt, and in lower case', () => {
  const nested = mod.sweepSite({ siteDir: sweepSite({ 'locations/deep/page.html': `<p>${NAME}</p>` }), name: NAME, runs: [GM_RUN] });
  assert.deepEqual({ ok: nested.ok, reason: nested.reason }, { ok: false, reason: 'name-in-site locations/deep/page.html' });
  const notice = mod.sweepSite({ siteDir: sweepSite({ 'NOTICE.txt': `credit to ${NAME}` }), name: NAME, runs: [GM_RUN] });
  assert.equal(notice.reason, 'name-in-site NOTICE.txt');
  const lower = mod.sweepSite({ siteDir: sweepSite({ 'index.html': '<p>about ottoline</p>' }), name: NAME, runs: [GM_RUN] });
  assert.equal(lower.reason, 'name-in-site index.html');
  const last = mod.sweepSite({ siteDir: sweepSite({ 'index.html': '<p>the PARDEW case</p>' }), name: NAME, runs: [GM_RUN] });
  assert.equal(last.reason, 'name-in-site index.html');
});

test('A2: sweepSite fails name-not-in-demo for a demo without the name or without a demo', () => {
  const noName = mod.sweepSite({ siteDir: sweepSite({}, '<p>nothing here</p>'), name: NAME, runs: [GM_RUN] });
  assert.deepEqual({ ok: noName.ok, reason: noName.reason }, { ok: false, reason: 'name-not-in-demo' });
  const noDemo = mod.sweepSite({ siteDir: sweepSite({}, null), name: NAME, runs: [GM_RUN] });
  assert.equal(noDemo.reason, 'name-not-in-demo');
});

test('A2: sweepSite finds GM text on any page, even entity-escaped and line-wrapped', () => {
  const plain = mod.sweepSite({ siteDir: sweepSite({ 'locations/town.html': `<p>${GM_RUN}</p>` }), name: NAME, runs: [GM_RUN] });
  assert.deepEqual({ ok: plain.ok, reason: plain.reason }, { ok: false, reason: 'gm-text-in-site locations/town.html' });
  const wrapped = mod.sweepSite({
    siteDir: sweepSite({ 'index.html': `<p>keeps a locked room at the top\n   of the <em>counting</em> house,\n under the roof, that nobody visits.</p>` }),
    name: NAME,
    runs: [GM_RUN],
  });
  assert.equal(wrapped.reason, 'gm-text-in-site index.html');
  const withAmp = 'Tom\'s "quiet" & loud <room> that nobody visits at night';
  const escaped = mod.sweepSite({
    siteDir: sweepSite({ 'index.html': '<p>Tom&#39;s &quot;quiet&quot; &amp;\n loud &lt;room&gt;   that nobody visits at night</p>' }),
    name: NAME,
    runs: [withAmp],
  });
  assert.equal(escaped.reason, 'gm-text-in-site index.html');
});

// -- D: the leak demo -----------------------------------------------------------------------------------

const OUT_PAGE = () => path.join(rootA, '.sample-site', 'out', 'locations', 'summerhythe.html');

/** The minimal vault the generator reads, copied so a case can break one thing. */
function vaultCopy() {
  const v = tmp('sample-site-vault-');
  fs.cpSync(path.join(SAMPLE, '_meta'), path.join(v, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(v, 'Locations'));
  fs.copyFileSync(path.join(SAMPLE, 'Locations', 'Summerhythe.md'), path.join(v, 'Locations', 'Summerhythe.md'));
  fs.mkdirSync(path.join(v, 'Characters', 'NPCs'), { recursive: true });
  fs.copyFileSync(
    path.join(SAMPLE, 'Characters', 'NPCs', 'Ottoline Pardew.md'),
    path.join(v, 'Characters', 'NPCs', 'Ottoline Pardew.md'),
  );
  return v;
}

function siteCopy() {
  const s = tmp('sample-site-site-');
  fs.mkdirSync(path.join(s, 'locations'));
  fs.copyFileSync(OUT_PAGE(), path.join(s, 'locations', 'summerhythe.html'));
  return s;
}

function editFile(file, fn) {
  fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
}

function reasonFor(vault, site) {
  const r = demoMod.buildLeakDemo({ vaultDir: vault, siteDir: site });
  return r.ok ? 'ok' : r.reason;
}

test('D1: the demo on the tracked sample and the built site is ok and has every required part', () => {
  const r = demoMod.buildLeakDemo({ vaultDir: SAMPLE, siteDir: path.join(rootA, '.sample-site', 'out') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.name, NAME);
  const md = fs.readFileSync(path.join(SAMPLE, 'Locations', 'Summerhythe.md'), 'utf8');
  const excerpt = md.slice(md.indexOf('## GM Notes') + '## GM Notes'.length).trim();
  assert.ok(r.html.includes(htmlEscape(excerpt)));
  assert.ok(r.html.includes(htmlEscape(PROBE)));
  for (const href of [
    'href="index.html"',
    'href="locations/summerhythe.html"',
    'href="https://github.com/DrNoisys-Softworks/gm-scriptorium"',
    'href="https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/examples/README.md"',
    'href="https://github.com/DrNoisys-Softworks/gm-scriptorium/blob/main/docs/using.md#leak-checks"',
  ]) {
    assert.ok(r.html.includes(href), href);
  }
  assert.ok(r.html.startsWith('<!DOCTYPE html>'));
  assert.ok(r.html.includes('<html lang="en">'));
  assert.ok(r.html.includes('<meta charset="UTF-8">'));
  assert.ok(r.html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(r.html.includes('pre { white-space: pre-wrap; overflow-wrap: anywhere; }'));
  assert.equal(/<script|<link|<img/i.test(r.html), false);
  assert.equal(/width:\s*\d+px/.test(r.html), false);
  assert.equal(/—/.test(r.html), false, 'no em dash');
  // The sweep agrees with the real site.
  assert.equal((r.html.match(/<style/g) || []).length, 1);
});

test('D2: withheldName reads the single Excluded entry', () => {
  assert.deepEqual(demoMod.withheldName(SAMPLE), { ok: true, name: NAME });
});

test('D3: the name planted in the player page fails with player-page-has-name (any token, any case)', () => {
  for (const planted of ['<p>Ottoline Pardew</p>', '<p>pardew</p>', '<p>OTTOLINE</p>']) {
    const site = siteCopy();
    editFile(path.join(site, 'locations', 'summerhythe.html'), (t) => t.replace('</body>', `${planted}</body>`));
    assert.equal(reasonFor(SAMPLE, site), 'player-page-has-name', planted);
  }
});

test('D4: the name removed from the GM Notes fails with excerpt-missing-name', () => {
  const v = vaultCopy();
  editFile(path.join(v, 'Locations', 'Summerhythe.md'), (t) => t.replace('[[Ottoline Pardew]]', '[[Somebody Else]]'));
  assert.equal(reasonFor(v, siteCopy()), 'excerpt-missing-name');
});

test('D5: the player page deleted fails with player-page-missing', () => {
  const site = siteCopy();
  fs.unlinkSync(path.join(site, 'locations', 'summerhythe.html'));
  assert.equal(reasonFor(SAMPLE, site), 'player-page-missing');
});

test('D6: GM Notes dropped from excludeSections fails with section-not-excluded', () => {
  const v = vaultCopy();
  editFile(path.join(v, '_meta', 'scriptorium', 'vault.config.json'), (t) => {
    const j = JSON.parse(t);
    j.excludeSections = j.excludeSections.filter((s) => s !== 'GM Notes');
    return JSON.stringify(j);
  });
  assert.equal(reasonFor(v, siteCopy()), 'section-not-excluded');
});

test('D7: a GM run planted in the player page fails with player-page-has-gm-text', () => {
  const md = fs.readFileSync(path.join(SAMPLE, 'Locations', 'Summerhythe.md'), 'utf8');
  const run = md.slice(md.indexOf('## GM Notes') + '## GM Notes'.length).trim().replace('[[Ottoline Pardew]] ', '');
  assert.ok(run.length > 100);
  const site = siteCopy();
  editFile(path.join(site, 'locations', 'summerhythe.html'), (t) => t.replace('</body>', `<p>${run}</p></body>`));
  assert.equal(reasonFor(SAMPLE, site), 'player-page-has-gm-text');
  // The heading words alone are enough.
  const site2 = siteCopy();
  editFile(path.join(site2, 'locations', 'summerhythe.html'), (t) => t.replace('</body>', '<h2>GM Notes</h2></body>'));
  assert.equal(reasonFor(SAMPLE, site2), 'player-page-has-gm-text');
});

test('D8: the probe removed from the player page fails with player-page-mismatch', () => {
  const site = siteCopy();
  editFile(path.join(site, 'locations', 'summerhythe.html'), (t) => t.split(PROBE).join('Something else entirely.'));
  assert.equal(reasonFor(SAMPLE, site), 'player-page-mismatch');
});

test('D9: the Excluded entry removed, or doubled, fails; the flag removed fails', () => {
  const v1 = vaultCopy();
  editFile(path.join(v1, '_meta', 'publish-manifest.md'), (t) => t.replace('- [x] Characters/NPCs/Ottoline Pardew.md\n', ''));
  assert.equal(reasonFor(v1, siteCopy()), 'no-withheld-entry');

  const v2 = vaultCopy();
  editFile(path.join(v2, '_meta', 'publish-manifest.md'), (t) => t.trimEnd() + '\n- [x] Characters/NPCs/Another.md\n');
  assert.equal(reasonFor(v2, siteCopy()), 'several-withheld-entries');

  const v3 = vaultCopy();
  editFile(path.join(v3, 'Characters', 'NPCs', 'Ottoline Pardew.md'), (t) => t.replace('withheld: true\n', ''));
  assert.equal(reasonFor(v3, siteCopy()), 'withheld-flag-missing');
});

test('D10: no GM Notes heading, or a probe the source does not hold, fail in order', () => {
  const v1 = vaultCopy();
  editFile(path.join(v1, 'Locations', 'Summerhythe.md'), (t) => t.replace('## GM Notes', '## Other Notes'));
  assert.equal(reasonFor(v1, siteCopy()), 'excerpt-not-found');

  const v2 = vaultCopy();
  editFile(path.join(v2, 'Locations', 'Summerhythe.md'), (t) => t.replace(PROBE, 'Trade is slow.'));
  assert.equal(reasonFor(v2, siteCopy()), 'probe-not-in-source');

  const v3 = vaultCopy();
  editFile(path.join(v3, 'Locations', 'Summerhythe.md'), (t) => t.slice(0, t.indexOf('## GM Notes')) + '## GM Notes\n\n');
  assert.equal(reasonFor(v3, siteCopy()), 'excerpt-not-found');
});

test('D11: a GM run planted entity-escaped and line-wrapped is still found', () => {
  const v = vaultCopy();
  editFile(path.join(v, 'Locations', 'Summerhythe.md'), (t) =>
    t.slice(0, t.indexOf('## GM Notes')) +
    '## GM Notes\n\n[[Ottoline Pardew]] hid Tom\'s "quiet" & loud <room> that nobody visits at night.\n',
  );
  const site = siteCopy();
  editFile(path.join(site, 'locations', 'summerhythe.html'), (t) =>
    t.replace('</body>', '<p>hid Tom&#39;s &quot;quiet&quot; &amp;\n   loud &lt;room&gt; that\nnobody visits at night.</p></body>'),
  );
  assert.equal(reasonFor(v, site), 'player-page-has-gm-text');
  // Control: without the planted copy the same vault is fine.
  assert.equal(reasonFor(v, siteCopy()), 'ok');
});

test('D12: markup in the GM note is escaped in the demo', () => {
  const v = vaultCopy();
  editFile(path.join(v, 'Locations', 'Summerhythe.md'), (t) =>
    t.slice(0, t.indexOf('## GM Notes')) + '## GM Notes\n\n[[Ottoline Pardew]] <script>alert(1)</script> & more.\n',
  );
  const r = demoMod.buildLeakDemo({ vaultDir: v, siteDir: siteCopy() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(/<script/i.test(r.html), false);
  assert.ok(r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more.'));
});

test('D14: the tag stripper leaves no angle bracket, even for nested or overlapping tags', () => {
  for (const sub of [' ', '']) {
    for (const input of ['<scr<script>ipt>alert(1)', '<<b>b>text', 'a <scr<script>ipt>x</scr</script>ipt> b', '<script>x</script>y', '<p>5 < 6 and 7 > 2</p>', '<scr<style>ipt>z']) {
      const out = demoMod.stripTags(input, sub);
      assert.equal(out.includes('<'), false, input);
      assert.equal(out.includes('>'), false, input);
    }
  }
  assert.equal(demoMod.stripTags('<p>Hello <em>there</em></p>', ' ').replace(/\s+/g, ' ').trim(), 'Hello there');
});

test('D13: buildLeakDemo writes nothing', () => {
  const v = vaultCopy();
  const s = siteCopy();
  const vb = hashTree(v);
  const sb = hashTree(s);
  demoMod.buildLeakDemo({ vaultDir: v, siteDir: s });
  assert.deepEqual(hashTree(v), vb);
  assert.deepEqual(hashTree(s), sb);
});

test('the tracked sample was not modified by any test in this file', () => {
  assert.deepEqual(hashTree(SAMPLE), sampleBefore);
});
