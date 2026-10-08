#!/usr/bin/env node
'use strict';

/*
 * The starter template's pin-time tool (docs/decisions/0048-new-campaign-vault.md, section 3).
 * Development only: nothing here ships in the executable, and `npm test` never needs Python.
 *
 *   node scripts/vault-template.js capture --checkout <dir> --out <runs dir> [--systems a,b,c]
 *     Runs gm-apprentice's own vault scaffold, from a FRESH clone at the pinned commit, once per
 *     game system and run (see RUNS), each into its own new folder. Needs python3 (3.10 or later,
 *     standard library only; nothing is installed). The driver replaces the scaffold's clock with
 *     a fixed date; one control run per system uses the scaffold's own command line, to prove
 *     that changes nothing else. Python is run from a scratch folder outside the checkout.
 *
 *   node scripts/vault-template.js derive --runs <runs dir> --out <template dir> --meta <meta.json>
 *                                         [--additions <dir>] [--notes <notes.json>]
 *     Turns the runs into assets/vault-template: the places where the run's campaign name or date
 *     appear become declared placeholders; files every system shares are stored once under
 *     common/, the rest under systems/<id>/; and the manifest records every sha256, the declared
 *     deviations, the scaffold's own sha256 for each parity run, and every rules-content scan hit
 *     with the note a person wrote for it. It refuses, and writes nothing, on any surprise.
 *
 * The starter is the scaffold's output, so no starter file is ever edited by hand. A change to the
 * starter is a new capture, a new derive, and a read of every changed file.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PIN_SCAN_PATTERN, scanBuffer } = require('./content-markers');
const template = require('../src/setup/template');
const { validateStarterTitle } = require('../src/setup/validate');
const { validateStarterRel } = require('../src/vault/vaultcreate');

const SHIPPED_SYSTEMS = Object.freeze(['none', 'dnd-5e-2024', 'pf2e', 'fitd']);
const CAMPAIGN = '{{SCRIPTORIUM_CAMPAIGN}}';
const CREATED = '{{SCRIPTORIUM_CREATED}}';
const SCRIPT = 'skills/shared/scripts/vault_scaffold.py';
const DRIVER = path.join(__dirname, 'vault-template-run.py');

/*
 * Runs per system. A and B differ in name and date, so every place either appears is found.
 * D carries a double space, a quote, a colon and a hash: it proves the scaffold collapses
 * whitespace and does not escape. Its title cannot be written safely into a quoted value, so it
 * is used for finding sites only, never as a parity run. E carries the same oddities in a form
 * that can be written, and is a parity run. B and E are the parity runs.
 */
const RUNS = Object.freeze([
  { id: 'A', name: 'Qzx Capture Alpha', created: '2001-02-03', parity: false },
  { id: 'B', name: 'Qzx Capture Bravo Ünï', created: '2034-11-29', parity: true },
  { id: 'D', name: 'Qzx  "Delta": #1', created: '2012-12-12', parity: false },
  { id: 'E', name: 'Qzx  Echo Ünï:  #1 ---', created: '2031-05-06', parity: true },
]);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fail(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

function normaliseName(name) {
  return name.trim().split(/\s+/).join(' ');
}

// --- capture ---------------------------------------------------------------------------------------

/** @returns {{ system: string, id: string, name: string, created: string, parity: boolean, control: boolean, rel: string }[]} */
function planRuns(systems, today) {
  const plan = [];
  for (const system of systems) {
    for (const run of RUNS) plan.push({ system, ...run, control: false, rel: `${system}/${run.id}` });
    plan.push({ system, id: 'C', name: RUNS[0].name, created: today, parity: false, control: true, rel: `${system}/C` });
  }
  return plan;
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {{ checkout: string, outDir: string, systems?: string[], today?: string,
 *   repository?: string, exec?: Function, workDir?: string }} opts exec is injected by tests
 */
function capture({ checkout, outDir, systems = SHIPPED_SYSTEMS, today, repository = 'https://github.com/AntTheLimey/gm-apprentice', exec = execFileSync, workDir }) {
  const checkoutAbs = path.resolve(checkout);
  const out = path.resolve(outDir);
  if (fs.existsSync(out)) throw fail(`${out} already exists; capture writes only into a new folder`);
  if (isInside(checkoutAbs, out)) throw fail('the output folder must be outside the checkout');
  const scriptPath = path.join(checkoutAbs, ...SCRIPT.split('/'));
  if (!fs.existsSync(scriptPath)) throw fail(`${checkoutAbs} has no ${SCRIPT}; is it a gm-apprentice checkout?`);
  let pluginVersion;
  try {
    pluginVersion = JSON.parse(fs.readFileSync(path.join(checkoutAbs, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch {
    throw fail(`${checkoutAbs} has no readable .claude-plugin/plugin.json`);
  }
  if (typeof pluginVersion !== 'string' || pluginVersion === '') throw fail('plugin.json has no version');
  const env = { PATH: process.env.PATH || '', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };

  // The scratch working folder must be outside the checkout: Python is never run inside it.
  const cwd = workDir ? path.resolve(workDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-capture-'));
  if (isInside(checkoutAbs, cwd)) throw fail('the working folder must be outside the checkout');

  const version = String(exec('python3', ['-c', 'import sys; print("%d.%d" % sys.version_info[:2]); sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { cwd, env, encoding: 'utf8' })).trim();
  const commit = String(exec('git', ['-C', checkoutAbs, 'rev-parse', 'HEAD'], { cwd, env, encoding: 'utf8' })).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw fail('could not read the checkout commit');

  const date = today || template.localDate(new Date());
  fs.mkdirSync(out, { recursive: true });
  const runs = [];
  for (const run of planRuns(systems, date)) {
    const abs = path.join(out, ...run.rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const which = run.system === 'none' ? ['--no-system'] : ['--system', run.system];
    if (run.control) {
      exec('python3', ['-E', '-s', scriptPath, abs, ...which, `--name=${run.name}`, '--write'], { cwd, env, encoding: 'utf8' });
    } else {
      exec('python3', ['-I', DRIVER, checkoutAbs, abs, run.system, run.name, run.created], { cwd, env, encoding: 'utf8' });
    }
    runs.push({ system: run.system, id: run.id, name: run.name, created: run.created, parity: run.parity, control: run.control, dir: run.rel, abs });
  }
  fs.writeFileSync(
    path.join(out, 'runs.json'),
    `${JSON.stringify(
      {
        schema: 1,
        upstream: {
          repository,
          commit,
          script: SCRIPT,
          pluginVersion,
          command: 'python3 -I scripts/vault-template-run.py <checkout> <vault> <system or none> <name> <date>',
          clock: 'the scaffold module\'s datetime is replaced by a fixed date in the driver; a control run per system uses the scaffold command line with the date of capture',
        },
        python: version,
        runs,
      },
      null,
      2,
    )}\n`,
  );
  return { runs: runs.length, commit, pluginVersion };
}

// --- derive ----------------------------------------------------------------------------------------

function readTree(dir) {
  const files = new Map();
  const dirs = new Set();
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.add(r);
        walk(path.join(d, entry.name), r);
      } else if (entry.isFile()) {
        files.set(r, fs.readFileSync(path.join(d, entry.name)));
      } else {
        throw fail(`${path.join(d, entry.name)} is a link or an odd file; the scaffold does not make those`);
      }
    }
  })(dir, '');
  return { files, dirs };
}

function decode(buf, where) {
  if (buf.includes(0)) throw fail(`${where} holds a NUL byte; binary files are not part of the starter`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw fail(`${where} is not UTF-8; binary files are not part of the starter`);
  }
  return text;
}

function countOf(text, token) {
  return text.split(token).length - 1;
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw fail(`${file} is not readable JSON (${what})`);
  }
}

function parentDirs(rel) {
  const out = [];
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

function reverseDeviations(deviations, rel, text) {
  let out = text;
  for (const dev of deviations) {
    if (dev.file !== rel) continue;
    if (countOf(out, dev.to) !== 1) throw fail(`${rel}: the deviation text must occur exactly once in the rendered file`);
    out = out.replace(dev.to, () => dev.from);
  }
  return out;
}

/**
 * @param {{ runsDir: string, outDir: string, meta: object, additionsDir?: string, notes?: Record<string, string> }} opts
 * @returns {{ systems: string[], files: number, stored: number, rulesScan: number }}
 */
function derive({ runsDir, outDir, meta, additionsDir, notes = {} }) {
  const out = path.resolve(outDir);
  const partial = `${out}.partial`;
  if (fs.existsSync(out) && (!fs.statSync(out).isDirectory() || fs.readdirSync(out).length > 0)) throw fail(`${out} already exists and is not empty`);
  if (fs.existsSync(partial)) throw fail(`${partial} is left over from an earlier run; remove it first`);
  for (const key of ['templateVersion', 'license', 'attribution']) {
    if (typeof meta[key] !== 'string' || meta[key] === '') throw fail(`the meta file needs "${key}"`);
  }
  const deviations = Array.isArray(meta.deviations) ? meta.deviations : [];

  const runsFile = readJson(path.join(runsDir, 'runs.json'), 'runs.json');
  if (!runsFile || runsFile.schema !== 1 || !Array.isArray(runsFile.runs) || runsFile.runs.length === 0) throw fail('runs.json is not a capture record');

  // 1. Load every run, check it, and normalise it.
  const bySystem = new Map();
  for (const run of runsFile.runs) {
    const tree = readTree(path.join(runsDir, ...run.dir.split('/')));
    const norm = normaliseName(run.name);
    const normalised = new Map();
    for (const [rel, buf] of tree.files) {
      const where = `${run.dir}/${rel}`;
      const text = decode(buf, where);
      if (text.includes('\r')) throw fail(`${where} uses CRLF line ends; the starter is LF only`);
      if (text.includes('{{SCRIPTORIUM_')) throw fail(`${where} already holds a {{SCRIPTORIUM_ placeholder`);
      if (scanBuffer(buf).length > 0) throw fail(`${where} holds rules content that must never be shipped`);
      for (const leak of [run.abs, path.dirname(run.abs)]) {
        if (leak && text.includes(leak)) throw fail(`${where} holds the scratch path ${leak}`);
      }
      normalised.set(rel, text.split(norm).join(CAMPAIGN).split(run.created).join(CREATED));
    }
    if (!bySystem.has(run.system)) bySystem.set(run.system, []);
    bySystem.get(run.system).push({ run, tree, normalised });
  }
  if (!bySystem.has('none')) throw fail('the runs must include the system "none"');

  // 2. Within a system every run must agree, once the name and date are replaced.
  const perSystem = new Map();
  for (const [system, list] of bySystem) {
    const first = list[0];
    for (const other of list.slice(1)) {
      if (!sameSet(new Set(first.tree.files.keys()), new Set(other.tree.files.keys())) || !sameSet(first.tree.dirs, other.tree.dirs)) {
        throw fail(`${system}: the files or folders of run ${first.run.id} and run ${other.run.id} differ`);
      }
      for (const [rel, text] of first.normalised) {
        if (other.normalised.get(rel) !== text) throw fail(`${system}: ${rel} differs between run ${first.run.id} and run ${other.run.id} other than at the name or date`);
      }
    }
    perSystem.set(system, { files: first.normalised, dirs: first.tree.dirs, list });
  }

  // 3. The Scriptorium-authored additions.
  const additions = new Map();
  if (additionsDir) {
    const tree = readTree(path.resolve(additionsDir));
    for (const [rel, buf] of tree.files) {
      if (!validateStarterRel(rel)) throw fail(`the addition ${rel} is not a safe path`);
      for (const [system, data] of perSystem) {
        if (data.files.has(rel)) throw fail(`the addition ${rel} collides with a file the scaffold wrote (${system})`);
      }
      additions.set(rel, decode(buf, `addition ${rel}`));
    }
  }

  // 4. Store: shared files once, the rest per system.
  const systemIds = [...perSystem.keys()].sort();
  const stored = new Map(); // store path > text
  const manifestSystems = {};
  const origins = new Map(); // rel > 'upstream' | 'scriptorium'
  for (const system of systemIds) {
    const data = perSystem.get(system);
    const files = {};
    const dirs = new Set(data.dirs);
    for (const rel of data.files.keys()) for (const p of parentDirs(rel)) dirs.add(p);
    for (const rel of additions.keys()) for (const p of parentDirs(rel)) dirs.add(p);
    const entries = [...data.files.entries()].map(([rel, text]) => [rel, text, 'upstream']).concat([...additions.entries()].map(([rel, text]) => [rel, text, 'scriptorium']));
    for (const [rel, text, origin] of entries) {
      const shared = systemIds.every((id) => (origin === 'scriptorium' ? true : perSystem.get(id).files.get(rel) === text));
      const store = shared ? `common/${rel}` : `systems/${system}/${rel}`;
      stored.set(store, text);
      origins.set(rel, origin);
      const tokens = {};
      for (const token of [CAMPAIGN, CREATED]) {
        const n = countOf(text, token);
        if (n > 0) tokens[token] = n;
      }
      files[rel] = { store, sha256: sha256(Buffer.from(text, 'utf8')), origin, tokens };
    }
    const sorted = {};
    for (const rel of Object.keys(files).sort()) sorted[rel] = files[rel];
    manifestSystems[system] = { dirs: [...dirs].sort(), files: sorted };
  }

  // 5. Rules-content scan: every hit needs a note a person wrote.
  const rulesScan = [];
  const unreviewed = [];
  for (const [store, text] of [...stored.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    text.split('\n').forEach((line, i) => {
      PIN_SCAN_PATTERN.lastIndex = 0;
      if (!PIN_SCAN_PATTERN.test(line)) return;
      const key = `${store}:${i + 1}`;
      if (typeof notes[key] === 'string' && notes[key].trim() !== '') rulesScan.push({ store, line: i + 1, note: notes[key].trim() });
      else unreviewed.push(key);
    });
  }
  if (unreviewed.length > 0) throw fail(`these lines match the rules-content scan and need a note written by hand (--notes): ${unreviewed.join(', ')}`);

  // 6. Parity vectors: the scaffold's own bytes for each parity run.
  const parity = [];
  for (const system of systemIds) {
    for (const { run, tree } of perSystem.get(system).list) {
      if (!run.parity) continue;
      const files = {};
      for (const [rel, buf] of [...tree.files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) files[rel] = sha256(buf);
      parity.push({ system, name: run.name, campaign: normaliseName(run.name), created: run.created, files });
    }
  }

  const upstream = runsFile.upstream || {};
  const manifest = {
    schema: 1,
    templateVersion: meta.templateVersion,
    upstream: { repository: upstream.repository, commit: upstream.commit, script: upstream.script, pluginVersion: upstream.pluginVersion, command: upstream.command, clock: upstream.clock },
    gm_apprentice_version: meta.gm_apprentice_version || upstream.pluginVersion,
    license: meta.license,
    attribution: meta.attribution,
    placeholders: [
      { token: CAMPAIGN, value: 'campaign', rule: 'the site title with every run of whitespace collapsed to one space' },
      { token: CREATED, value: 'created', rule: 'the local date of creation as YYYY-MM-DD' },
    ],
    systems: manifestSystems,
    deviations,
    parity,
    rulesScan,
  };

  // 7. Write beside the target, check the result as the program will, then move it into place.
  fs.mkdirSync(partial, { recursive: true });
  try {
    for (const [store, text] of stored) {
      const full = path.join(partial, ...store.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    selfCheck(partial, perSystem);
    if (fs.existsSync(out)) fs.rmdirSync(out);
    fs.renameSync(partial, out);
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  return { systems: systemIds, files: Object.keys(manifest.systems.none.files).length, stored: stored.size, rulesScan: rulesScan.length };
}

/** The output must verify as a tree, and every parity run must render back to the scaffold's bytes. */
function selfCheck(dir, perSystem) {
  const { problems } = template.verifyTemplateTree(dir);
  if (problems.length > 0) throw fail(`the derived template fails its own check: ${problems.join(', ')}`);
  const tpl = template.loadTemplate({ dir });
  for (const vector of tpl.manifest.parity) {
    let rendered;
    try {
      const title = validateStarterTitle(vector.name);
      if (title !== vector.campaign) throw new Error(`the title normalises to "${title}", not "${vector.campaign}"`);
      rendered = template.renderStarter(tpl, { system: vector.system, title, created: vector.created });
    } catch (err) {
      throw fail(`parity run ${vector.system} "${vector.name}" cannot be rendered: ${err.message}`);
    }
    const byRel = new Map(rendered.files.map((f) => [f.rel, f.data.toString('utf8')]));
    for (const [rel, expected] of Object.entries(vector.files)) {
      const got = byRel.get(rel);
      const bytes = got === undefined ? null : Buffer.from(reverseDeviations(tpl.manifest.deviations, rel, got), 'utf8');
      if (bytes === null || sha256(bytes) !== expected) throw fail(`parity run ${vector.system} "${vector.name}": ${rel} does not render back to the scaffold's bytes`);
    }
    const extra = [...byRel.keys()].filter((rel) => tpl.manifest.systems[vector.system].files[rel].origin === 'upstream' && !(rel in vector.files));
    if (extra.length > 0) throw fail(`parity run ${vector.system} "${vector.name}": the starter has files the scaffold did not write: ${extra.join(', ')}`);
  }
  void perSystem;
}

// --- command line ------------------------------------------------------------------------------------

const USAGE = [
  'usage:',
  '  node scripts/vault-template.js capture --checkout <dir> --out <runs dir> [--systems none,dnd-5e-2024,pf2e,fitd]',
  '  node scripts/vault-template.js derive --runs <runs dir> --out <template dir> --meta <meta.json> [--additions <dir>] [--notes <notes.json>]',
].join('\n');

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw fail(USAGE);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

function main(argv) {
  const [command, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    if (command === 'capture') {
      if (!flags.checkout || !flags.out) throw fail(USAGE);
      const systems = flags.systems ? flags.systems.split(',') : SHIPPED_SYSTEMS;
      const res = capture({ checkout: flags.checkout, outDir: flags.out, systems });
      process.stdout.write(`captured ${res.runs} runs at ${res.commit} (plugin ${res.pluginVersion}) into ${path.resolve(flags.out)}\n`);
      return 0;
    }
    if (command === 'derive') {
      if (!flags.runs || !flags.out || !flags.meta) throw fail(USAGE);
      const res = derive({
        runsDir: flags.runs,
        outDir: flags.out,
        meta: readJson(flags.meta, 'meta'),
        additionsDir: flags.additions,
        notes: flags.notes ? readJson(flags.notes, 'notes') : {},
      });
      process.stdout.write(`derived ${res.stored} stored files for ${res.systems.join(', ')} into ${path.resolve(flags.out)}; ${res.rulesScan} rules-scan hits noted\n`);
      return 0;
    }
    throw fail(USAGE);
  } catch (err) {
    if (!err.userFacing) throw err;
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

module.exports = { SHIPPED_SYSTEMS, RUNS, planRuns, capture, derive, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
