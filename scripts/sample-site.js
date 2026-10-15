'use strict';

/*
 * The hosted-sample pipeline, run by .github/workflows/pages.yml and by anyone who wants to
 * reproduce it in a scratch copy of the repository:
 *   node scripts/sample-site.js
 * It takes no arguments and has no setting that could point it at another vault or folder. Every
 * path is a constant in this file. Steps, in order:
 *   prepare  refuse if a scratch or staging folder is already there, then make a scratch copy of
 *            the sample's pack with the Pages address added (the tracked pack is never written)
 *   build    the real CLI builds the tracked sample into scratch; its own pre-build check and
 *            output-leak scan run with no override
 *   check    the real CLI checks that output again; any error, or any leak finding, fails
 *   stage    copy the checked output to the staging folder and prove the copy is identical
 *   demo     add the leak demo page to the staged copy only
 *   final    sweep the staged site for the withheld name and for the GM note's text
 * Any failure prints "SITE FAIL <step> <reason>", exits 1, and leaves no staging folder unless
 * the failure came after the copy. Nothing in this file deletes: a CI runner is thrown away, and
 * on your own machine you delete the scratch and staging folders yourself.
 *
 * It proves the build is clean on this commit. It does not prove the deploy, or the live address.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { buildLeakDemo, DEMO_FILE, excerptRuns, findGmText, hasNameToken } = require('./leak-demo');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'scriptorium.js');
const SAMPLE_VAULT_REL = 'examples/the-long-lease';
const SCRATCH_REL = '.sample-site';
const STAGING_REL = '_site';
const PAGES_SITE_URL = 'https://drnoisys-softworks.github.io/gm-scriptorium/';
const CAMPAIGN = 'sample';
const TIMEOUT_MS = 180000;

function childEnv(scratch) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(scratch, 'config.toml');
  env.APPDATA = path.join(scratch, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(scratch, 'unused-xdg');
  return env;
}

/** Never throws. Returns { code, out, err, error }. */
function spawnCli(command, scratch, args) {
  const argv = [...command.slice(1), ...args, '--config', path.join(scratch, 'config.toml')];
  const res = spawnSync(command[0], argv, {
    env: childEnv(scratch),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    shell: false,
  });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '', error: res.error || null };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tomlPath(p) {
  return `'${p.replace(/\\/g, '/')}'`;
}

/**
 * Copies the tracked pack to packDest and adds the Pages address to the copy's vault.config.json.
 * Refuses if the tracked pack already carries an address, so the copy is the only place it lives.
 */
function preparePack({ packSrc, packDest }) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(packSrc, 'vault.config.json'), 'utf8'));
  } catch (e) {
    return { ok: false, reason: `pack-unreadable ${e.code || 'error'}` };
  }
  if (cfg === null || typeof cfg !== 'object' || 'siteUrl' in cfg) return { ok: false, reason: 'pack-has-siteUrl' };
  fs.cpSync(packSrc, packDest, { recursive: true });
  fs.writeFileSync(
    path.join(packDest, 'vault.config.json'),
    JSON.stringify({ ...cfg, siteUrl: PAGES_SITE_URL }, null, 2) + '\n',
  );
  return { ok: true };
}

/** Every file under root, as { 'a/b.html': sha256 }. Anything that is not a file or folder is marked. */
function hashFiles(root) {
  const map = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) map[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      else map[rel] = `other:${e.name}`;
    }
  })(root);
  return map;
}

/** Pure compare of two trees by file path and content. */
function compareTrees(a, b) {
  const ha = hashFiles(a);
  const hb = hashFiles(b);
  const ka = Object.keys(ha).sort();
  const kb = Object.keys(hb).sort();
  if (ka.length !== kb.length) return { ok: false, reason: 'tree-differs', detail: `file counts ${ka.length} and ${kb.length}` };
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return { ok: false, reason: 'tree-differs', detail: `path ${ka[i]} against ${kb[i]}` };
    if (ha[ka[i]] !== hb[kb[i]]) return { ok: false, reason: 'tree-differs', detail: `content of ${ka[i]}` };
  }
  return { ok: true, count: ka.length };
}

/**
 * Reads the whole staged site and fails on the withheld name (any token, any case) or on the GM
 * note's text anywhere except the demo page, and fails if the demo does not hold the full name.
 */
function sweepSite({ siteDir, name, runs }) {
  let demo = null;
  try {
    demo = fs.readFileSync(path.join(siteDir, DEMO_FILE), 'utf8');
  } catch {
    demo = null;
  }
  if (demo === null || !demo.includes(name)) return { ok: false, reason: 'name-not-in-demo' };
  const files = Object.keys(hashFiles(siteDir)).sort();
  for (const rel of files) {
    if (rel === DEMO_FILE) continue;
    const text = fs.readFileSync(path.join(siteDir, ...rel.split('/')), 'latin1');
    if (hasNameToken(text, name)) return { ok: false, reason: `name-in-site ${rel}` };
    if (findGmText(text, runs)) return { ok: false, reason: `gm-text-in-site ${rel}` };
  }
  return { ok: true, count: files.length };
}

/** Never throws. Returns { ok, step, reason, lines }. */
function runSampleSite({ command, root }) {
  const lines = [];
  const fail = (step, reason) => ({ ok: false, step, reason, lines });
  const pass = (step, note) => lines.push(`SITE ${step} ok ${note}`);

  try {
    const vault = path.join(REPO_ROOT, ...SAMPLE_VAULT_REL.split('/'));
    const scratch = path.join(root, SCRATCH_REL);
    const staging = path.join(root, STAGING_REL);
    const out = path.join(scratch, 'out');

    // 1. prepare
    if (fs.existsSync(scratch)) return fail('prepare', 'scratch-exists');
    if (fs.existsSync(staging)) return fail('prepare', 'staging-exists');
    const packDir = path.join(scratch, 'pack');
    const packSrc = path.join(vault, '_meta', 'scriptorium');
    fs.mkdirSync(scratch);
    const pack = preparePack({ packSrc, packDest: packDir });
    if (!pack.ok) return fail('prepare', pack.reason);
    fs.writeFileSync(
      path.join(scratch, 'config.toml'),
      [
        'config_version = 1',
        `default_campaign = "${CAMPAIGN}"`,
        '',
        `[campaigns.${CAMPAIGN}]`,
        `vault = ${tomlPath(vault)}`,
        `output = ${tomlPath(out)}`,
        `pack = ${tomlPath(packDir)}`,
        '',
      ].join('\n'),
    );
    pass('prepare', 'pack copied with the Pages address');

    // 2. build
    const build = spawnCli(command, scratch, ['build', CAMPAIGN, '--json']);
    if (build.error) return fail('build', `spawn ${build.error.code || build.error.message}`);
    const buildJson = parseJson(build.out);
    if (!buildJson) return fail('build', 'bad-json');
    if (build.code !== 0 || buildJson.ok !== true) return fail('build', `exit ${build.code}`);
    pass('build', 'exit 0');

    // 3. check. Judged on the findings as well as the exit code.
    const check = spawnCli(command, scratch, ['check', CAMPAIGN, '--json']);
    if (check.error) return fail('check', `spawn ${check.error.code || check.error.message}`);
    const env = parseJson(check.out);
    if (!env || !env.counts || !Array.isArray(env.findings)) return fail('check', 'bad-json');
    const leak = env.findings.find((f) => String(f.id).startsWith('leak/') && f.severity === 'error');
    if (leak) return fail('check', `leak-error ${leak.id}`);
    if (check.code !== 0) return fail('check', `exit ${check.code}`);
    if (env.counts.error !== 0) return fail('check', `errors ${env.counts.error}`);
    pass('check', `exit 0 error=${env.counts.error} warn=${env.counts.warn} info=${env.counts.info}`);

    // 4. stage
    fs.cpSync(out, staging, { recursive: true });
    const same = compareTrees(out, staging);
    if (!same.ok) return fail('stage', same.reason);
    pass('stage', `${same.count} files identical`);

    // 5. demo
    const demo = buildLeakDemo({ vaultDir: vault, siteDir: staging });
    if (!demo.ok) return fail('demo', demo.reason);
    try {
      fs.writeFileSync(path.join(staging, DEMO_FILE), demo.html, { flag: 'wx' });
    } catch (e) {
      return fail('demo', e && e.code === 'EEXIST' ? 'demo-exists' : `write ${e && e.code}`);
    }
    pass('demo', DEMO_FILE);

    // 6. final sweep
    const swept = sweepSite({ siteDir: staging, name: demo.name, runs: demo.runs });
    if (!swept.ok) return fail('final', swept.reason);
    pass('final', `${swept.count} files swept`);

    lines.push('SITE PASS');
    return { ok: true, step: null, reason: null, lines };
  } catch (e) {
    return fail('spawn', e && e.message ? e.message : String(e));
  }
}

function main(argv) {
  if (argv.length !== 0) {
    console.log('SITE FAIL usage node scripts/sample-site.js');
    return 1;
  }
  const res = runSampleSite({ command: [process.execPath, BIN], root: REPO_ROOT });
  for (const l of res.lines) console.log(l);
  if (!res.ok) {
    console.log(`SITE FAIL ${res.step} ${res.reason}`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  SAMPLE_VAULT_REL,
  SCRATCH_REL,
  STAGING_REL,
  PAGES_SITE_URL,
  runSampleSite,
  preparePack,
  compareTrees,
  sweepSite,
  excerptRuns,
};
