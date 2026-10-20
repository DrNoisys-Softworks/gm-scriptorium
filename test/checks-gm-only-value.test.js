'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildCheckContext } = require('../src/checks/context');
const { runChecks } = require('../src/checks/run');
const read = require('../src/vault/read');
const pinned = require('../src/generator/pinned');

/*
 * Behavioural tests for relationship/gm-only-value (issue 186). Synthetic
 * inline temp vaults, invented words. Findings come through
 * runChecks(buildCheckContext(...)) filtered on the exact id, so before the
 * check is registered the finding assertions are red by assertion.
 *
 * Tests that pass on main today and so prove nothing about the new check:
 *   - T2 (parse parity: it only compares the two parsers),
 *   - the "no finding" rows of T1 / T5 / T6 and T3 steps (e) and (f)
 *     considered alone (an absent check also gives no finding). They matter
 *     only next to the rows that do fire.
 *
 * The ERROR literals below are 1.14.0-specific: at the 1.21.0 repin the pin
 * holds such an edge back and they become WARN by design, changing in that
 * PR. T3 (real build, severity iff the word is in the built page) is the
 * proof that holds across pins.
 */

const ID = 'relationship/gm-only-value';
const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');

function scratch(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(vaultPath, relPath, content) {
  const full = path.join(vaultPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function jsonConfig(vaultPath, extra = {}) {
  return {
    siteTitle: 'Test',
    siteUrl: 'https://example.invalid',
    vaultPath,
    outputDir: './out',
    attachmentsDir: '_attachments',
    folderMap: {},
    excludeDirs: ['_meta'],
    excludeSections: [],
    ...extra,
  };
}

function findingsFor(vaultPath, extra) {
  const ctx = buildCheckContext({ campaign: 'fixture', vaultPath, jsonConfig: jsonConfig(vaultPath, extra), graph: false });
  return runChecks(ctx).filter((f) => f.id === ID);
}

const FIX = 'Write gm_only: true to hide it, or remove gm_only to show it.';

// ---- T1: unit table -------------------------------------------------------

// [yaml text after "gm_only: " or null for absent, expected finding?]
const FLAGGED = ['yes', '"yes"', 'on', 'no', '"True"', '"TRUE"', '"False"', '1', '0', '', '~', '[true]', '{a: 1}'];
const ACCEPTED = ['true', 'false', 'True', 'TRUE', 'False', 'FALSE', '"true"', "'false'", null];

function edgeYaml(v) {
  const head = '  - type: r\n    target: "[[Gate]]"\n';
  if (v === null) return head;
  return `${head}    gm_only:${v === '' ? '' : ` ${v}`}\n`;
}

function probeText() {
  let rels = '';
  for (const v of FLAGGED) rels += edgeYaml(v);
  for (const v of ACCEPTED) rels += edgeYaml(v);
  rels += '  - target: "[[Gate]]"\n    gm_only: yes\n'; // idx 22, no type
  rels += '  - type: r\n    gm_only: 1\n'; // idx 23, no target
  return `---\ntype: widget\nrelationships:\n${rels}---\nBody.\n`;
}

test('T1: gm_only values that are not true or false are reported, one finding per edge, with literal messages', () => {
  scratch('scriptorium-186-t1-', (dir) => {
    const vault = path.join(dir, 'vault');
    writeFile(vault, 'Probe.md', probeText());
    const found = findingsFor(vault);
    assert.deepEqual(
      found.map((f) => f.data.index),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23],
    );
    assert.equal(found.length, 14);
    for (const f of found) {
      assert.equal(f.severity, 'error');
      assert.equal(f.path, 'Probe.md');
      assert.equal(f.data.published, true);
    }
    const byIndex = new Map(found.map((f) => [f.data.index, f]));
    assert.equal(
      byIndex.get(0).message,
      `Probe.md: relationship 1 (to "Gate") has gm_only set to "yes", which is not true or false, so the build publishes this relationship. ${FIX}`,
    );
    assert.equal(
      byIndex.get(23).message,
      `Probe.md: relationship 24 (no target) has gm_only set to 1, which is not true or false, so the build publishes this relationship. ${FIX}`,
    );
    assert.ok(byIndex.get(9).message.includes('set to nothing'), byIndex.get(9).message);
    assert.ok(byIndex.get(11).message.includes('set to [true]'), byIndex.get(11).message);
    assert.equal(byIndex.get(10).data.value, 'nothing');
    assert.equal(byIndex.get(7).data.value, '1');
    assert.equal(byIndex.get(12).data.value, '{"a":1}');
  });
});

// ---- T2: parse parity -----------------------------------------------------

test('T2: the check parser and the generator parser read every gm_only value identically, as literals', () => {
  const written = [...FLAGGED, ...ACCEPTED];
  const literal = [
    'yes', 'yes', 'on', 'no', 'True', 'TRUE', 'False',
    1, 0, null, null, [true], { a: 1 },
    true, false, true, true, false, false,
    'true', 'false',
    undefined,
  ];
  assert.equal(written.length, literal.length);
  written.forEach((v, i) => {
    const raw = `---\ntype: widget\nrelationships:\n  - type: r\n${v === null ? '' : `    gm_only:${v === '' ? '' : ` ${v}`}\n`}---\n`;
    const mine = read.parseFrontmatterText(raw).data.relationships[0];
    const theirs = pinned.generatorGrayMatter(raw, {}).data.relationships[0];
    assert.deepEqual(mine.gm_only, theirs.gm_only, `parsers disagree on ${JSON.stringify(v)}`);
    assert.deepEqual(mine.gm_only, literal[i], `unexpected value for ${JSON.stringify(v)}`);
    assert.equal('gm_only' in mine, literal[i] !== undefined || v !== null);
  });
});

// ---- T3: real build, check == generator ----------------------------------

function cli(root, name, vault) {
  const cfg = path.join(root, 'cfg.toml');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  delete env.SCRIPTORIUM_PROFILE;
  const run = (args) => spawnSync(process.execPath, [BIN, ...args, '--config', cfg], { encoding: 'utf8', env });
  const add = run(['config', 'add', name, '--vault', vault, '--out', path.join(root, `out-${name}`)]);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  return run;
}

function allFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  })(dir);
  return out;
}

const NPC_HEAD = (title) =>
  `---\ntype: npc\ntitle: ${title}\ncampaign: "The Long Lease"\nsource: play\nsource_confidence: AUTHORITATIVE\n`;

test('T3: on a real build the check says ERROR exactly when the relationship word is on the built page', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-186-'));
  try {
    const vault = path.join(root, 'v');
    fs.cpSync(LEASE, vault, { recursive: true });
    const word = (n) => `zqxr${String(n).padStart(2, '0')}`;
    let rels = '';
    FLAGGED.forEach((v, i) => {
      rels += `  - type: ${word(i + 1)}\n    target: "[[Oswy Hebden]]"\n    gm_only:${v === '' ? '' : ` ${v}`}\n`;
    });
    rels += `  - type: ${word(14)}\n    target: "[[Oswy Hebden]]"\n    gm_only: true\n`;
    rels += `  - type: ${word(15)}\n    target: "[[Oswy Hebden]]"\n    gm_only: "true"\n`;
    rels += `  - type: ${word(16)}\n    target: "[[Oswy Hebden]]"\n    gm_only: false\n`;
    rels += `  - type: ${word(17)}\n    target: "[[Oswy Hebden]]"\n`;
    writeFile(vault, 'Characters/NPCs/Zqx Edge Probe.md', `${NPC_HEAD('Zqx Edge Probe')}relationships:\n${rels}---\n\nA paragraph about the probe.\n`);
    writeFile(
      vault,
      'Characters/NPCs/Zqx Edge Field.md',
      `${NPC_HEAD('Zqx Edge Field')}publish_exclude_fields: [relationships]\nrelationships:\n  - type: ${word(18)}\n    target: "[[Oswy Hebden]]"\n    gm_only: yes\n---\n\nA paragraph about the field.\n`,
    );
    const man = path.join(vault, '_meta', 'publish-manifest.md');
    fs.writeFileSync(
      man,
      fs.readFileSync(man, 'utf8').replace('## Publishing\n', '## Publishing\n\n- [x] Characters/NPCs/Zqx Edge Probe.md\n- [x] Characters/NPCs/Zqx Edge Field.md'),
    );
    const run = cli(root, 'v', vault);

    // (a) the only error findings are the new id: 13 on the probe, one warn for zqxr18.
    const chk = run(['check', 'v', '--json']);
    const env = JSON.parse(chk.stdout);
    const all = env.findings;
    const errors = all.filter((f) => f.severity === 'error');
    assert.ok(errors.length > 0, 'expected error findings');
    assert.ok(errors.every((f) => f.id === ID), JSON.stringify(errors.filter((f) => f.id !== ID)));
    const mine = all.filter((f) => f.id === ID);
    const probeFindings = mine.filter((f) => f.path === 'Characters/NPCs/Zqx Edge Probe.md');
    assert.equal(probeFindings.length, 13);
    assert.ok(probeFindings.every((f) => f.severity === 'error'));
    const fieldFindings = mine.filter((f) => f.path === 'Characters/NPCs/Zqx Edge Field.md');
    assert.equal(fieldFindings.length, 1);
    assert.equal(fieldFindings[0].severity, 'warn');
    assert.equal(mine.length, 14);

    // (b) a plain build is blocked, (c) --force-check builds.
    const blocked = run(['build', 'v']);
    assert.equal(blocked.status, 2, blocked.stderr + blocked.stdout);
    assert.ok((blocked.stdout + blocked.stderr).includes(ID));
    assert.ok(!fs.existsSync(path.join(root, 'out-v', 'index.html')));
    const forced = run(['build', 'v', '--force-check']);
    assert.equal(forced.status, 0, forced.stderr + forced.stdout);

    // (d) severity is error iff the word is on the built probe page.
    const ctx = buildCheckContext({
      campaign: 'v',
      vaultPath: vault,
      jsonConfig: { ...JSON.parse(fs.readFileSync(path.join(LEASE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8')), vaultPath: vault },
    });
    const page = ctx.publishSet.publishedPages.find((p) => p.relPath === 'Characters/NPCs/Zqx Edge Probe.md');
    assert.ok(page, 'probe page must be a published page');
    const html = fs.readFileSync(path.join(root, 'out-v', page.outputPath), 'utf8').toLowerCase();
    const seen = {};
    for (let n = 1; n <= 13; n++) {
      const f = probeFindings.find((x) => x.data.index === n - 1);
      assert.ok(f, `finding for ${word(n)}`);
      seen[word(n)] = html.includes(word(n));
      assert.equal(f.severity === 'error', seen[word(n)], `${word(n)}: severity ${f.severity}, on page ${seen[word(n)]}`);
      assert.equal(seen[word(n)], true, `${word(n)} must be on the 1.14.0 page`);
    }

    // (e) true, "true" and the excluded-field edge: no error finding and the word is in no output file.
    const outFiles = allFiles(path.join(root, 'out-v')).map((p) => fs.readFileSync(p).toString('utf8').toLowerCase());
    for (const w of [word(14), word(15), word(18)]) {
      assert.ok(!mine.some((f) => f.severity === 'error' && f.data.index !== undefined && f.message.includes(w)));
      assert.ok(!outFiles.some((t) => t.includes(w)), `${w} must not be in any output file`);
    }
    assert.ok(!errors.some((f) => f.path === 'Characters/NPCs/Zqx Edge Field.md'));

    // (f) false and absent: not flagged. They are shown (the edge is not hidden).
    for (const idx of [15, 16]) assert.ok(!probeFindings.some((f) => f.data.index === idx));
    assert.ok(html.includes(word(16)) && html.includes(word(17)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- T4: unpublished ------------------------------------------------------

test('T4: an unpublished page with gm_only: yes gives exactly one WARN with the literal message', () => {
  scratch('scriptorium-186-t4-', (dir) => {
    const vault = path.join(dir, 'vault');
    writeFile(vault, 'Probe.md', '---\ntype: widget\npublish: false\nrelationships:\n  - type: r\n    target: "[[Gate]]"\n    gm_only: yes\n---\nBody.\n');
    const found = findingsFor(vault);
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'warn');
    assert.equal(
      found[0].message,
      `Probe.md: relationship 1 (to "Gate") has gm_only set to "yes", which is not true or false. This relationship is not published today, but only gm_only: true is sure to hide it. ${FIX}`,
    );
  });
});

// ---- T4b: severity branches ----------------------------------------------

const ONE_EDGE = '  - type: r\n    target: "[[Gate]]"\n    gm_only: yes\n---\nBody.\n';

function severityOf(found) {
  assert.equal(found.length, 1);
  return found[0].severity;
}

test('T4b: a stub page is published, so the edge is an ERROR', () => {
  scratch('scriptorium-186-stub-', (dir) => {
    const vault = path.join(dir, 'vault');
    writeFile(vault, 'Probe.md', `---\ntype: widget\npublish: stub\nrelationships:\n${ONE_EDGE}`);
    const ctx = buildCheckContext({ campaign: 'fixture', vaultPath: vault, jsonConfig: jsonConfig(vault) });
    assert.ok(ctx.publishSet.publishedPages.some((p) => p.relPath === 'Probe.md'), 'stub page must be in the published set');
    assert.equal(severityOf(findingsFor(vault)), 'error');
  });
});

test('T4b: per-file publish_exclude_fields: [relationships] gives WARN', () => {
  scratch('scriptorium-186-pef-', (dir) => {
    const vault = path.join(dir, 'vault');
    writeFile(vault, 'Probe.md', `---\ntype: widget\npublish_exclude_fields: [relationships]\nrelationships:\n${ONE_EDGE}`);
    assert.equal(severityOf(findingsFor(vault)), 'warn');
  });
});

test('T4b: a global excludeFields containing relationships gives WARN, and a per-file include override restores ERROR', () => {
  scratch('scriptorium-186-glob-', (dir) => {
    const vault = path.join(dir, 'vault');
    writeFile(vault, 'Probe.md', `---\ntype: widget\nrelationships:\n${ONE_EDGE}`);
    const extra = { excludeFields: ['relationships'] };
    const ctx = buildCheckContext({ campaign: 'fixture', vaultPath: vault, jsonConfig: jsonConfig(vault, extra) });
    assert.ok(ctx.publishSet.publishConfig.exclude_fields.includes('relationships'));
    assert.equal(severityOf(findingsFor(vault, extra)), 'warn');

    writeFile(
      vault,
      '_meta/vault-config.md',
      '---\npublish:\n  overrides:\n    fields:\n      "Probe.md":\n        include: [relationships]\n---\n',
    );
    const ctx2 = buildCheckContext({ campaign: 'fixture', vaultPath: vault, jsonConfig: jsonConfig(vault, extra) });
    assert.deepEqual(ctx2.publishSet.publishConfig.overrides.fields['Probe.md'], { include: ['relationships'] });
    assert.equal(severityOf(findingsFor(vault, extra)), 'error');
  });
});

// ---- T5: object form ------------------------------------------------------

test('T5: object-form relationships give no finding', () => {
  scratch('scriptorium-186-t5-', (dir) => {
    const vault = path.join(dir, 'vault');
    writeFile(vault, 'Probe.md', '---\ntype: widget\nrelationships:\n  allied_with: [Gate]\n---\nBody.\n');
    assert.deepEqual(findingsFor(vault), []);
  });
});

// ---- T6: no new findings on the existing corpora -------------------------

test('T6: no findings of the new id on the pin vault or the long lease', () => {
  const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
  const pinCfg = { ...require('./fixtures/pin-vault-site-config.json'), vaultPath: PIN_VAULT };
  const a = runChecks(buildCheckContext({ campaign: 'pin-vault', vaultPath: PIN_VAULT, jsonConfig: pinCfg })).filter((f) => f.id === ID);
  assert.deepEqual(a, []);
  const leaseCfg = { ...JSON.parse(fs.readFileSync(path.join(LEASE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8')), vaultPath: LEASE };
  const b = runChecks(buildCheckContext({ campaign: 'lease', vaultPath: LEASE, jsonConfig: leaseCfg })).filter((f) => f.id === ID);
  assert.deepEqual(b, []);
});
