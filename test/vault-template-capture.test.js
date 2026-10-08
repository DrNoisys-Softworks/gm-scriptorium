'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tool = require('../scripts/vault-template');
const template = require('../src/setup/template');
const { MARKERS } = require('../scripts/content-markers');
const { writeFakeRun } = require('./helpers/fake-upstream');

/*
 * The pin-time tool (docs/decisions/0048-new-campaign-vault.md, section 3), tested on pretend
 * scaffold runs whose every byte is known (test/helpers/fake-upstream.js). The real scaffold is
 * not run here: `npm test` needs no Python. What these prove is the tool's logic: that it finds
 * the name and date sites, stores shared files once, records the scaffold's own sha256 for the
 * parity runs, and refuses on every surprise. What they cannot prove is anything about the real
 * scaffold's output.
 */

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const RUNS = [
  { id: 'A', name: 'Qzx Capture Alpha', created: '2001-02-03', parity: false, control: false },
  { id: 'B', name: 'Qzx Capture Bravo Ünï', created: '2034-11-29', parity: true, control: false },
  { id: 'D', name: 'Qzx  "Delta": #1', created: '2012-12-12', parity: false, control: false },
  { id: 'E', name: 'Qzx  Echo Ünï:  #1 ---', created: '2031-05-06', parity: true, control: false },
  { id: 'C', name: 'Qzx Capture Alpha', created: '2026-10-08', parity: false, control: true },
];

/** Writes runs/<system>/<id> trees plus runs.json, the shape `capture` leaves behind. */
function makeRuns(t, { systems = ['none', 'dnd-5e-2024'], quirks = () => ({}), parityFlags = {} } = {}) {
  const root = scratch(t);
  const runsDir = path.join(root, 'runs');
  const runs = [];
  for (const system of systems) {
    for (const run of RUNS) {
      const rel = `${system}/${run.id}`;
      const abs = path.join(runsDir, system, run.id);
      writeFakeRun(abs, { system, name: run.name, created: run.created }, quirks(system, run.id));
      runs.push({ system, id: run.id, name: run.name, created: run.created, parity: parityFlags[run.id] ?? run.parity, control: run.control, dir: rel, abs: path.join('/scratch/elsewhere', rel) });
    }
  }
  fs.writeFileSync(
    path.join(runsDir, 'runs.json'),
    JSON.stringify({
      schema: 1,
      upstream: { repository: 'https://example.invalid/fake', commit: 'abcdef0123456789abcdef0123456789abcdef01', script: 'skills/shared/scripts/vault_scaffold.py', pluginVersion: '9.9.9', command: 'fake', clock: 'fake' },
      runs,
    }),
  );
  return { root, runsDir, outDir: path.join(root, 'tpl') };
}

function makeAdditions(root) {
  const dir = path.join(root, 'additions');
  fs.mkdirSync(path.join(dir, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_Campaign'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_meta', 'NOTICE.txt'), 'About this vault.\n');
  fs.writeFileSync(path.join(dir, '_meta', 'publish-manifest.md'), '---\ntype: meta\n---\n\n## Publishing\n\n- [x] _Campaign/Welcome.md\n');
  fs.writeFileSync(path.join(dir, '_Campaign', 'Welcome.md'), '---\ntype: campaign_overview\ntitle: "{{SCRIPTORIUM_CAMPAIGN}}"\n---\n\n# {{SCRIPTORIUM_CAMPAIGN}}\n');
  return dir;
}

const META = {
  templateVersion: 'cap-1',
  license: 'MIT',
  attribution: 'Pretend scaffold output for a test.',
  deviations: [{ file: '_meta/vault-config.md', from: '  site: false', to: '  site: true', why: 'the site is switched on' }],
};

function derive(t, opts = {}) {
  const made = makeRuns(t, opts.runs);
  const res = tool.derive({ runsDir: made.runsDir, outDir: made.outDir, meta: META, additionsDir: makeAdditions(made.root), notes: opts.notes || {}, ...(opts.derive || {}) });
  return { ...made, res };
}

function assertRefused(t, opts, pattern) {
  const made = makeRuns(t, opts.runs);
  assert.throws(
    () => tool.derive({ runsDir: made.runsDir, outDir: made.outDir, meta: opts.meta || META, additionsDir: makeAdditions(made.root), notes: opts.notes || {} }),
    (err) => {
      assert.match(err.message, pattern);
      return true;
    },
  );
  assert.equal(fs.existsSync(made.outDir), false, 'nothing is written on a refusal');
  assert.equal(fs.existsSync(`${made.outDir}.partial`), false, 'no partial folder is left behind');
}

// --- derive: what it finds and stores ---------------------------------------------------------------------

test('derive finds the name and date sites, declares them, and stores shared files once', (t) => {
  const { outDir, res } = derive(t);
  assert.deepEqual(res.systems, ['dnd-5e-2024', 'none']);
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.templateVersion, 'cap-1');
  assert.equal(manifest.upstream.commit, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(manifest.gm_apprentice_version, '9.9.9');
  assert.deepEqual(manifest.placeholders.map((p) => [p.token, p.value]), [['{{SCRIPTORIUM_CAMPAIGN}}', 'campaign'], ['{{SCRIPTORIUM_CREATED}}', 'created']]);

  const none = manifest.systems.none;
  assert.deepEqual(none.dirs, ['Locations', '_Campaign', '_Templates', '_attachments', '_attachments/characters', '_meta']);
  assert.deepEqual(Object.keys(none.files), ['_Campaign/Timeline.md', '_Campaign/Welcome.md', '_Templates/pc.md', '_meta/NOTICE.txt', '_meta/entity-types.md', '_meta/index.md', '_meta/publish-manifest.md', '_meta/vault-config.md']);
  const stores = Object.fromEntries(Object.entries(none.files).map(([rel, e]) => [rel, e.store]));
  assert.deepEqual(stores, {
    '_Campaign/Timeline.md': 'common/_Campaign/Timeline.md',
    '_Campaign/Welcome.md': 'common/_Campaign/Welcome.md',
    '_Templates/pc.md': 'systems/none/_Templates/pc.md',
    '_meta/NOTICE.txt': 'common/_meta/NOTICE.txt',
    '_meta/entity-types.md': 'common/_meta/entity-types.md',
    '_meta/index.md': 'common/_meta/index.md',
    '_meta/publish-manifest.md': 'common/_meta/publish-manifest.md',
    '_meta/vault-config.md': 'systems/none/_meta/vault-config.md',
  });
  assert.equal(manifest.systems['dnd-5e-2024'].files['_Templates/pc.md'].store, 'systems/dnd-5e-2024/_Templates/pc.md');
  assert.deepEqual(Object.fromEntries(Object.entries(none.files).map(([rel, e]) => [rel, e.origin])), {
    '_Campaign/Timeline.md': 'upstream',
    '_Campaign/Welcome.md': 'scriptorium',
    '_Templates/pc.md': 'upstream',
    '_meta/NOTICE.txt': 'scriptorium',
    '_meta/entity-types.md': 'upstream',
    '_meta/index.md': 'upstream',
    '_meta/publish-manifest.md': 'scriptorium',
    '_meta/vault-config.md': 'upstream',
  });
  assert.deepEqual(none.files['_Campaign/Timeline.md'].tokens, { '{{SCRIPTORIUM_CAMPAIGN}}': 2 });
  assert.deepEqual(none.files['_meta/index.md'].tokens, { '{{SCRIPTORIUM_CREATED}}': 2 });
  assert.deepEqual(none.files['_meta/vault-config.md'].tokens, { '{{SCRIPTORIUM_CAMPAIGN}}': 1 });
  assert.deepEqual(none.files['_meta/entity-types.md'].tokens, {});

  const timeline = fs.readFileSync(path.join(outDir, 'common', '_Campaign', 'Timeline.md'), 'utf8');
  assert.equal(timeline, '---\ntype: timeline\ncampaign: "{{SCRIPTORIUM_CAMPAIGN}}"\n---\n\n# {{SCRIPTORIUM_CAMPAIGN}}: Timeline\n');
  const settings = fs.readFileSync(path.join(outDir, 'systems', 'dnd-5e-2024', '_meta', 'vault-config.md'), 'utf8');
  assert.equal(settings, '---\ntype: meta\ngm_apprentice_version: "9.9.9"\npublish:\n  site: false\n  system: "dnd-5e-2024"\n---\n\n# {{SCRIPTORIUM_CAMPAIGN}}: vault settings\n');
  assert.deepEqual(manifest.deviations, META.deviations);
  assert.deepEqual(manifest.rulesScan, []);
});

test('derive records the scaffold\'s own sha256 for each parity run, and the output renders back to those bytes', (t) => {
  const { outDir, runsDir } = derive(t);
  const tpl = template.loadTemplate({ dir: outDir });
  assert.deepEqual(template.verifyTemplateTree(outDir).problems, []);
  assert.deepEqual(tpl.manifest.parity.map((v) => [v.system, v.name, v.campaign, v.created]), [
    ['dnd-5e-2024', 'Qzx Capture Bravo Ünï', 'Qzx Capture Bravo Ünï', '2034-11-29'],
    ['dnd-5e-2024', 'Qzx  Echo Ünï:  #1 ---', 'Qzx Echo Ünï: #1 ---', '2031-05-06'],
    ['none', 'Qzx Capture Bravo Ünï', 'Qzx Capture Bravo Ünï', '2034-11-29'],
    ['none', 'Qzx  Echo Ünï:  #1 ---', 'Qzx Echo Ünï: #1 ---', '2031-05-06'],
  ]);
  for (const vector of tpl.manifest.parity) {
    const runId = vector.created === '2034-11-29' ? 'B' : 'E';
    const dir = path.join(runsDir, vector.system, runId);
    const recorded = {};
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else recorded[r] = sha(fs.readFileSync(path.join(d, e.name)));
      }
    })(dir, '');
    assert.deepEqual(vector.files, Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => (a < b ? -1 : 1))));
    // and render it, reverse the deviation, and compare with the run's own file, read here, not derived
    const out = template.renderStarter(tpl, { system: vector.system, title: vector.campaign, created: vector.created });
    const settings = out.files.find((f) => f.rel === '_meta/vault-config.md').data.toString('utf8');
    assert.equal(settings.replace('  site: true', '  site: false'), fs.readFileSync(path.join(dir, '_meta', 'vault-config.md'), 'utf8'));
  }
});

test('the D run (a quote, a hash, a double space) is used to find sites but is never a parity run', (t) => {
  const { outDir } = derive(t);
  const names = template.loadTemplate({ dir: outDir }).manifest.parity.map((v) => v.name);
  assert.equal(names.some((n) => n.includes('"')), false);
});

// --- derive: every surprise is a refusal -----------------------------------------------------------------

test('derive refuses when two runs of one system write different sets of files', (t) => {
  assertRefused(t, { runs: { quirks: (s, id) => (s === 'none' && id === 'B' ? { extraFile: true } : {}) } }, /none: the files or folders of run A and run B differ/);
});

test('derive refuses a file that differs between runs other than at the name or date', (t) => {
  assertRefused(t, { runs: { quirks: (s, id) => ({ stray: id }) } }, /_meta\/stray\.md differs between run A and run B other than at the name or date/);
});

test('derive refuses when the scaffold escapes the title, because that is a difference it cannot place', (t) => {
  assertRefused(t, { runs: { quirks: (s, id) => (id === 'D' ? { escapeQuotes: true } : {}) } }, /differs between run A and run D other than at the name or date/);
});

test('derive refuses a scratch path in the output', (t) => {
  const made = makeRuns(t, { quirks: (s, id) => (s === 'none' && id === 'A' ? { leakPath: true } : {}) });
  // the leak is the run's own capture-time path: rewrite runs.json so that path is what the file holds
  const file = path.join(made.runsDir, 'runs.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = record.runs.find((r) => r.system === 'none' && r.id === 'A');
  run.abs = path.join(made.runsDir, 'none', 'A');
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => tool.derive({ runsDir: made.runsDir, outDir: made.outDir, meta: META }), /holds the scratch path /);
  assert.equal(fs.existsSync(made.outDir), false);
});

test('derive refuses a file that already holds a placeholder', (t) => {
  assertRefused(t, { runs: { quirks: () => ({ rawToken: true }) } }, /already holds a \{\{SCRIPTORIUM_ placeholder/);
});

test('derive refuses a binary file, a NUL byte, and a file that is not UTF-8', (t) => {
  assertRefused(t, { runs: { quirks: () => ({ binary: true }) } }, /blob\.bin holds a NUL byte/);
});

test('derive refuses CRLF line ends', (t) => {
  assertRefused(t, { runs: { quirks: () => ({ crlf: true }) } }, /uses CRLF line ends/);
});

test('derive refuses a rules-content marker string (planted from the marker list, never written out here)', (t) => {
  const marker = MARKERS[1].strings[1];
  assertRefused(t, { runs: { quirks: () => ({ marker }) } }, /holds rules content that must never be shipped/);
});

test('derive refuses a rules-scan hit with no note, and records one that has a note', (t) => {
  const quirks = () => ({ hit: 'Source: Pretend Book, p. 12' });
  assertRefused(t, { runs: { quirks } }, /common\/_meta\/hit\.md:2/);
  const { outDir } = derive(t, { runs: { quirks }, notes: { 'common/_meta/hit.md:2': 'a made-up citation line in a test' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).rulesScan, [{ store: 'common/_meta/hit.md', line: 2, note: 'a made-up citation line in a test' }]);
});

test('derive refuses an empty note for a hit', (t) => {
  assertRefused(t, { runs: { quirks: () => ({ hit: 'Source: Pretend Book, p. 12' }) }, notes: { 'common/_meta/hit.md:2': '   ' } }, /need a note written by hand/);
});

test('derive refuses a parity run whose title cannot be written back (the D title)', (t) => {
  assertRefused(t, { runs: { parityFlags: { D: true } } }, /parity run .* cannot be rendered: site title can't be written/);
});

test('derive refuses an addition that collides with a scaffold file, and an unsafe addition path', (t) => {
  const made = makeRuns(t);
  const adds = makeAdditions(made.root);
  fs.writeFileSync(path.join(adds, '_meta', 'index.md'), 'x');
  assert.throws(() => tool.derive({ runsDir: made.runsDir, outDir: made.outDir, meta: META, additionsDir: adds }), /collides with a file the scaffold wrote/);
  fs.rmSync(path.join(adds, '_meta', 'index.md'));
  fs.writeFileSync(path.join(adds, '_meta', 'con.md'), 'x');
  assert.throws(() => tool.derive({ runsDir: made.runsDir, outDir: made.outDir, meta: META, additionsDir: adds }), /is not a safe path/);
  assert.equal(fs.existsSync(made.outDir), false);
});

test('derive refuses a deviation whose "from" text is not in the file exactly once', (t) => {
  assertRefused(t, { meta: { ...META, deviations: [{ ...META.deviations[0], from: '  site: perhaps' }] } }, /deviations/);
});

test('derive refuses to write into a folder that is not empty, and needs the system none', (t) => {
  const made = makeRuns(t);
  fs.mkdirSync(made.outDir);
  fs.writeFileSync(path.join(made.outDir, 'x'), 'x');
  assert.throws(() => tool.derive({ runsDir: made.runsDir, outDir: made.outDir, meta: META }), /already exists and is not empty/);
  assertRefused(t, { runs: { systems: ['dnd-5e-2024'] } }, /must include the system "none"/);
});

test('derive writes into an existing empty folder', (t) => {
  const made = makeRuns(t);
  fs.mkdirSync(made.outDir);
  tool.derive({ runsDir: made.runsDir, outDir: made.outDir, meta: META, additionsDir: makeAdditions(made.root) });
  assert.equal(fs.existsSync(path.join(made.outDir, 'manifest.json')), true);
});

// --- capture ---------------------------------------------------------------------------------------------

function fakeCheckout(t) {
  const dir = scratch(t);
  const checkout = path.join(dir, 'gm-apprentice');
  fs.mkdirSync(path.join(checkout, 'skills', 'shared', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(checkout, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'skills', 'shared', 'scripts', 'vault_scaffold.py'), '# stand-in\n');
  fs.writeFileSync(path.join(checkout, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
  return { dir, checkout };
}

/** An exec stand-in that records calls and writes the pretend scaffold's output where python3 would. */
function fakeExec(calls, { failOn } = {}) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === 'git') return 'abcdef0123456789abcdef0123456789abcdef01\n';
    if (args[0] === '-c') return '3.12\n';
    const control = args[0] === '-E';
    const target = args[3];
    const system = control ? (args.includes('--no-system') ? 'none' : args[args.indexOf('--system') + 1]) : args[4];
    const name = control ? args.find((a) => a.startsWith('--name=')).slice(7) : args[5];
    const created = control ? '2026-10-08' : args[6];
    if (failOn && failOn(args)) throw new Error('python3 failed');
    writeFakeRun(target, { system, name, created });
    return '';
  };
}

test('capture runs the driver for A, B, D and E and the control for each system, outside the checkout, with -I', (t) => {
  const { dir, checkout } = fakeCheckout(t);
  const outDir = path.join(dir, 'runs');
  const calls = [];
  const res = tool.capture({ checkout, outDir, systems: ['none', 'pf2e'], today: '2026-10-08', exec: fakeExec(calls) });
  assert.equal(res.runs, 10);
  const python = calls.filter((c) => c.file === 'python3' && c.args[0] !== '-c');
  assert.equal(python.length, 10);
  const driver = path.join(__dirname, '..', 'scripts', 'vault-template-run.py');
  const patched = python.filter((c) => c.args[0] === '-I');
  assert.equal(patched.length, 8);
  assert.deepEqual(patched[0].args, ['-I', driver, checkout, path.join(outDir, 'none', 'A'), 'none', 'Qzx Capture Alpha', '2001-02-03']);
  assert.deepEqual(patched[5].args, ['-I', driver, checkout, path.join(outDir, 'pf2e', 'B'), 'pf2e', 'Qzx Capture Bravo Ünï', '2034-11-29']);
  const controls = python.filter((c) => c.args[0] === '-E');
  assert.deepEqual(controls[0].args, ['-E', '-s', path.join(checkout, 'skills', 'shared', 'scripts', 'vault_scaffold.py'), path.join(outDir, 'none', 'C'), '--no-system', '--name=Qzx Capture Alpha', '--write']);
  assert.deepEqual(controls[1].args, ['-E', '-s', path.join(checkout, 'skills', 'shared', 'scripts', 'vault_scaffold.py'), path.join(outDir, 'pf2e', 'C'), '--system', 'pf2e', '--name=Qzx Capture Alpha', '--write']);
  for (const c of python) {
    assert.equal(path.relative(checkout, c.opts.cwd).startsWith('..'), true, 'python is never run inside the checkout');
    assert.equal(c.opts.env.PYTHONPATH, undefined);
    assert.equal(c.opts.env.PYTHONDONTWRITEBYTECODE, '1');
    assert.equal(c.opts.shell, undefined, 'no shell');
  }
  const record = JSON.parse(fs.readFileSync(path.join(outDir, 'runs.json'), 'utf8'));
  assert.equal(record.upstream.commit, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(record.upstream.pluginVersion, '9.9.9');
  assert.deepEqual(record.runs.map((r) => r.dir), ['none/A', 'none/B', 'none/D', 'none/E', 'none/C', 'pf2e/A', 'pf2e/B', 'pf2e/D', 'pf2e/E', 'pf2e/C']);
  assert.equal(record.runs.find((r) => r.dir === 'none/C').created, '2026-10-08');
  assert.deepEqual(record.runs.filter((r) => r.parity).map((r) => r.dir), ['none/B', 'none/E', 'pf2e/B', 'pf2e/E']);
});

test('capture then derive, end to end on the pretend scaffold, gives a template that verifies', (t) => {
  const { dir, checkout } = fakeCheckout(t);
  const runsDir = path.join(dir, 'runs');
  tool.capture({ checkout, outDir: runsDir, systems: ['none', 'dnd-5e-2024'], today: '2026-10-08', exec: fakeExec([]) });
  const adds = makeAdditions(dir);
  const outDir = path.join(dir, 'tpl');
  tool.derive({ runsDir, outDir, meta: META, additionsDir: adds });
  assert.deepEqual(template.verifyTemplateTree(outDir).problems, []);
});

test('capture refuses an existing output folder, an output inside the checkout, and a non-checkout', (t) => {
  const { dir, checkout } = fakeCheckout(t);
  fs.mkdirSync(path.join(dir, 'taken'));
  assert.throws(() => tool.capture({ checkout, outDir: path.join(dir, 'taken'), exec: fakeExec([]) }), /already exists/);
  assert.throws(() => tool.capture({ checkout, outDir: path.join(checkout, 'runs'), exec: fakeExec([]) }), /outside the checkout/);
  assert.throws(() => tool.capture({ checkout: dir, outDir: path.join(scratch(t), 'x'), exec: fakeExec([]) }), /is it a gm-apprentice checkout/);
  assert.throws(() => tool.capture({ checkout, outDir: path.join(dir, 'y'), workDir: path.join(checkout, 'skills'), exec: fakeExec([]) }), /working folder must be outside the checkout/);
});

test('capture stops on the first failing python run', (t) => {
  const { dir, checkout } = fakeCheckout(t);
  const calls = [];
  assert.throws(() => tool.capture({ checkout, outDir: path.join(dir, 'runs'), systems: ['none'], today: '2026-10-08', exec: fakeExec(calls, { failOn: (args) => args[0] === '-I' && args[4] === 'none' && args[6] === '2034-11-29' }) }), /python3 failed/);
  assert.equal(calls.filter((c) => c.file === 'python3' && c.args[0] === '-I').length, 2);
});

test('the command line: an unknown subcommand and a missing flag print the usage and exit 1', () => {
  const { main } = tool;
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (s) => {
    written.push(String(s));
    return true;
  };
  try {
    assert.equal(main(['frobnicate']), 1);
    assert.equal(main(['derive', '--runs', 'x']), 1);
    assert.equal(main(['capture']), 1);
  } finally {
    process.stderr.write = real;
  }
  assert.equal(written.length, 3);
  assert.match(written[0], /^usage:/);
});

test('the fake upstream escapes a backslash before a quote, so a name like a\\b and a"c\\"d both come out as valid quoted YAML', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-upstream-esc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = (name, sub) => {
    const d = path.join(dir, sub);
    writeFakeRun(d, { system: 'none', name, created: '2026-01-01' }, { escapeQuotes: true });
    return fs.readFileSync(path.join(d, '_Campaign', 'Timeline.md'), 'utf8').split('\n').find((l) => l.startsWith('campaign: '));
  };
  assert.equal(out('a\\b', 'one'), 'campaign: "a\\\\b"');
  assert.equal(out('a"c\\"d', 'two'), 'campaign: "a\\"c\\\\\\"d"');
  assert.equal(JSON.parse(out('a"c\\"d', 'three').slice('campaign: '.length)), 'a"c\\"d');
});
