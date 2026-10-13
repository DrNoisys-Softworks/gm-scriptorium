'use strict';

/*
 * The packaged-binary smoke (rc.4 #9). CI packages both targets on a push to main, then runs
 * the real linux-x64 binary through this script:
 *   1. --version
 *   2. build the public example vault into a scratch output
 *   3. check it: exact pinned counts, no leak error
 *   4. plant a withheld name in the built output; check must find it (scanner liveness)
 * It takes any argv prefix, so `npm test` runs the same steps against the source on every PR
 * (test/packaged-smoke.test.js), and CI runs them against the packaged binary:
 *   node scripts/packaged-smoke.js <path-to-binary>
 * It proves nothing about Windows: the win-x64 exe stays a release gate on the test machine
 * (runbook criterion C184).
 *
 * EXPECTED is a pin measured from the source at commit 7f14a25, so it is NOT independent of
 * the code under test. test/packaged-smoke.test.js (a) is its drift detector: edit the example
 * vault or a check and that test goes red on the PR. The planted-step assertions below (exit 2,
 * exactly one leak/l4-output-name naming index.html and PLANTED_NAME, no leak error on the
 * clean check) are literals and do not depend on the pin.
 *
 * Isolation: every spawn sets SCRIPTORIUM_CONFIG to the scratch config, deletes
 * SCRIPTORIUM_PROFILE, points APPDATA and XDG_CONFIG_HOME into the scratch folder, and passes
 * --config. No shell, no port, a 180 second timeout per spawn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EXAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const VERSION = require('../package.json').version;

const PLANTED_NAME = 'Ottoline Pardew';

const EXPECTED = Object.freeze({
  clean: Object.freeze({ exit: 0, error: 0, warn: 0, info: 1 }),
  planted: Object.freeze({ exit: 2, error: 1, warn: 0, info: 1 }),
});

const TIMEOUT_MS = 180000;

function childEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');
  return env;
}

/** Never throws. Returns { code, out, err, error }. */
function spawnCli(command, root, args) {
  const argv = [...command.slice(1), ...args, '--config', path.join(root, 'config.toml')];
  const res = spawnSync(command[0], argv, {
    env: childEnv(root),
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

function runSmoke({ command, plant = true }) {
  const lines = [];
  const fail = (step, reason) => ({ ok: false, step, reason, lines });
  const pass = (step, note) => lines.push(`SMOKE ${step} ok ${note}`);

  let root = null;
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-smoke-'));

    // 1. version. Run with the scratch root so even this spawn is isolated.
    const ver = spawnCli(command, root, ['--version']);
    if (ver.error) return fail('version', `spawn ${ver.error.code || ver.error.message}`);
    if (ver.code !== 0) return fail('version', `exit ${ver.code}`);
    const first = ver.out.split(/\r?\n/)[0];
    if (first !== VERSION) return fail('version', `bad-version got ${JSON.stringify(first)} want ${VERSION}`);
    pass('version', first);

    // 2. build a scratch copy of the example vault.
    const vault = path.join(root, 'vault');
    const out = path.join(root, 'out');
    fs.cpSync(EXAMPLE, vault, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config.toml'),
      [
        'config_version = 1',
        'default_campaign = "smoke"',
        '',
        '[campaigns.smoke]',
        `vault = ${tomlPath(vault)}`,
        `output = ${tomlPath(out)}`,
        '',
      ].join('\n'),
    );
    const build = spawnCli(command, root, ['build', 'smoke', '--json']);
    if (build.error) return fail('build', `spawn ${build.error.code || build.error.message}`);
    const buildJson = parseJson(build.out);
    if (!buildJson) return fail('build', 'bad-json');
    if (build.code !== 0 || buildJson.ok !== true) return fail('build', `exit ${build.code}`);
    pass('build', 'exit 0');

    // 3. clean check.
    const clean = checkStep(command, root, 'check-clean', EXPECTED.clean);
    if (!clean.ok) return fail('check-clean', clean.reason);
    if (clean.env.findings.some((f) => String(f.id).startsWith('leak/') && f.severity === 'error')) {
      return fail('check-clean', 'marker-extra leak error on the clean output');
    }
    pass('check-clean', `exit ${EXPECTED.clean.exit} counts ${countText(clean.env.counts)}`);

    // 4. plant a withheld name; check must find it.
    if (plant) {
      fs.appendFileSync(path.join(out, 'index.html'), `\n<p>${PLANTED_NAME}</p>\n`);
    }
    const planted = checkStep(command, root, 'check-planted', EXPECTED.planted);
    if (!planted.ok) return fail('check-planted', planted.reason);
    // Independent literal (A9-2): a planted leak must exit 2, whatever EXPECTED says.
    if (planted.code !== 2) return fail('check-planted', `exit got ${planted.code} want 2`);
    const hits = planted.env.findings.filter((f) => f.id === 'leak/l4-output-name');
    if (hits.length === 0) return fail('check-planted', 'marker-not-found');
    if (hits.length !== 1) return fail('check-planted', `marker-extra ${hits.length} findings`);
    if (hits[0].outputPath !== 'index.html' || !hits[0].data || hits[0].data.hiddenName !== PLANTED_NAME) {
      return fail('check-planted', 'marker-not-found wrong path or name');
    }
    pass('check-planted', `exit ${EXPECTED.planted.exit} one leak/l4-output-name in index.html`);

    lines.push('SMOKE PASS');
    return { ok: true, step: null, reason: null, lines };
  } catch (e) {
    return fail('spawn', e && e.message ? e.message : String(e));
  } finally {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
}

function countText(c) {
  return `error=${c.error} warn=${c.warn} info=${c.info}`;
}

/**
 * Runs `check smoke --json` and compares exit and counts to the pin. Returns
 * { ok, reason } or { ok: true, env }. The marker-not-found case (nothing planted, so exit 0
 * and zero errors) is reported as that reason, not as a generic exit mismatch.
 */
function checkStep(command, root, step, want) {
  const res = spawnCli(command, root, ['check', 'smoke', '--json']);
  if (res.error) return { ok: false, reason: `spawn ${res.error.code || res.error.message}` };
  const env = parseJson(res.out);
  if (!env || !env.counts || !Array.isArray(env.findings)) return { ok: false, reason: 'bad-json' };
  if (step === 'check-planted' && !env.findings.some((f) => f.id === 'leak/l4-output-name')) {
    return { ok: false, reason: 'marker-not-found' };
  }
  if (res.code !== want.exit) return { ok: false, reason: `exit got ${res.code} want ${want.exit}` };
  const c = env.counts;
  if (c.error !== want.error || c.warn !== want.warn || c.info !== want.info) {
    return { ok: false, reason: `counts got ${countText(c)} want error=${want.error} warn=${want.warn} info=${want.info}` };
  }
  return { ok: true, env, code: res.code };
}

function main(argv) {
  if (argv.length !== 1) {
    console.log('SMOKE FAIL version usage: node scripts/packaged-smoke.js <binary>');
    return 1;
  }
  const res = runSmoke({ command: [path.resolve(argv[0])] });
  for (const l of res.lines) console.log(l);
  if (!res.ok) {
    console.log(`SMOKE FAIL ${res.step} ${res.reason}`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { EXPECTED, PLANTED_NAME, runSmoke };
