'use strict';

/*
 * S4 Engineering Brief, "Interfaces and contracts": covers README.md, docs/README.md,
 * CONTRIBUTING.md and SECURITY.md.
 *   - Every relative `[text](path)` resolves from THAT FILE'S OWN DIRECTORY, never the repo
 *     root (D1's red line: `../LICENSE` written in docs/README.md means `docs/../LICENSE`, not
 *     `<root>/../LICENSE`).
 *   - Every `docs/decisions/*.md` on disk is linked from docs/README.md (D2's red line: an ADR
 *     added to the directory but never added to the index).
 *   - AC-R11 / Amendment R.9: each ADR's link text in the index equals its own H1 line with the
 *     leading `# ` removed -- a full-string comparison, not a number-prefix match (D3's red
 *     line: a scratch index entry that gets the `NNNN` right but the rest of the title wrong
 *     must still be caught).
 *   - The index links no agent material beyond its one AGENTS.md pointer line (D-AUD; `.agents/` and
 *     `docs/agent-runs` now exist; the check is written against
 *     the link text itself, not "does the path exist", so it doesn't go stale when they land).
 *
 * D-AUD (S4b) extends this file: more files in scope, every `@import` in the root CLAUDE.md
 * resolves, every `.agents/` file is linked from AGENTS.md, no human doc cites `docs/agent-runs`,
 * and no tracked file cites an ADR by line number. Each new check has a planted-defect control.
 *
 * Tests named per the brief's "tests that prove nothing" convention are called out below, not
 * silently included as if they were real coverage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCOPED_FILES = [
  'README.md',
  'docs/README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  // D-AUD (S4b): the audience split adds the agent index, the agent folder, the developer guide
  // and the other human docs.
  'AGENTS.md',
  'docs/DEVELOPING.md',
  'docs/COLLABORATING.md',
  'docs/PROVENANCE.md',
  'docs/image-slots.md',
  'docs/issues/README.md',
  'examples/README.md',
];

/** Every `.agents/*.md`, as repo-relative POSIX paths. */
function agentFiles(root = ROOT) {
  const dir = path.join(root, '.agents');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `.agents/${f}`);
}

/** Every markdown inline link `[text](target)` in `text`, in document order. */
function extractLinks(text) {
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ text: m[1], target: m[2] });
  }
  return out;
}

/** A link target that's never checked against the filesystem: it has a URI scheme (`https:`,
 * `mailto:`, ...) or is a bare in-page anchor. */
function isExternalOrAnchor(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#');
}

/** Resolves `target` from `fileDir` -- the directory of the file the link is WRITTEN IN, never
 * the repository root (D1). Strips a trailing `#fragment`, which is a target.md section anchor,
 * not part of the path. */
function resolveFromDir(fileDir, target) {
  const withoutFragment = target.split('#')[0];
  return path.resolve(fileDir, withoutFragment);
}

/** Every relative link target in `absFile` that doesn't resolve to something on disk. */
function brokenLinks(absFile) {
  const fileDir = path.dirname(absFile);
  const text = fs.readFileSync(absFile, 'utf8');
  const broken = [];
  for (const { target } of extractLinks(text)) {
    if (isExternalOrAnchor(target)) continue;
    if (!fs.existsSync(resolveFromDir(fileDir, target))) broken.push(target);
  }
  return broken;
}

for (const relFile of SCOPED_FILES) {
  test(`docs-links: every relative link in ${relFile} resolves from its own directory`, () => {
    assert.deepEqual(brokenLinks(path.join(ROOT, relFile)), []);
  });
}

/** The ADR's own index link text, by the house convention: its H1 line with the leading `# `
 * removed. 0017 keeps its own colon (it was never written with a period) -- this function makes
 * no assumption either way, it just strips the marker. */
function adrLinkText(absAdrFile) {
  const h1 = fs.readFileSync(absAdrFile, 'utf8').split('\n')[0];
  return h1.replace(/^#\s+/, '');
}

function listAdrBasenames(decisionsDir) {
  return fs
    .readdirSync(decisionsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

/** Every link in `indexText` whose target's basename names one of `adrBasenames`, keyed by that
 * basename -- so links to Contributing/Licensing/etc. in the same index file are never mistaken
 * for an ADR entry. */
function indexedAdrLinkText(indexText, adrBasenames) {
  const basenameSet = new Set(adrBasenames);
  const map = new Map();
  for (const { text, target } of extractLinks(indexText)) {
    const base = path.basename(target.split('#')[0]);
    if (basenameSet.has(base)) map.set(base, text);
  }
  return map;
}

/**
 * Every ADR on disk (`decisionsDir`) that's missing from `indexText` entirely, or whose index
 * link text isn't an EXACT match for its own H1 minus `# ` (D3: never a number-prefix match --
 * `linked.get(base)` is compared to the WHOLE expected string, not just its leading digits).
 */
function adrIndexMismatches(indexText, decisionsDir) {
  const basenames = listAdrBasenames(decisionsDir);
  const linked = indexedAdrLinkText(indexText, basenames);
  const mismatches = [];
  for (const base of basenames) {
    const expected = adrLinkText(path.join(decisionsDir, base));
    const actual = linked.get(base);
    if (actual === undefined) {
      mismatches.push({ base, reason: 'missing' });
    } else if (actual !== expected) {
      mismatches.push({ base, reason: 'wrong-title', expected, actual });
    }
  }
  return mismatches;
}

test('docs-links: every docs/decisions/*.md is linked from docs/README.md, with the exact H1 title (D2, AC-R11)', () => {
  const decisionsDir = path.join(ROOT, 'docs', 'decisions');
  const indexText = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
  assert.deepEqual(adrIndexMismatches(indexText, decisionsDir), []);
});

test('docs-links: the index links no agent-facing material', () => {
  const indexText = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
  for (const { target } of extractLinks(indexText)) {
    assert.ok(!target.includes('agent-runs'), `unexpected docs/agent-runs link: ${target}`);
    // D-AUD: the index carries ONE pointer line to AGENTS.md for AI assistants; nothing else
    // agent-facing (no `.agents/` file, no HANDOVER, no agent-runs).
    assert.ok(!target.includes('.agents/'), `unexpected .agents/ link: ${target}`);
    assert.ok(!/HANDOVER/i.test(target), `unexpected HANDOVER link: ${target}`);
  }
});

function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-docslinks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('D1 control: a planted link one directory up only resolves from the LINKING file\'s own directory', (t) => {
  const dir = mkTmp(t);
  fs.writeFileSync(path.join(dir, 'target.txt'), 'x');
  const subDir = path.join(dir, 'sub');
  fs.mkdirSync(subDir);
  const indexFile = path.join(subDir, 'index.md');
  fs.writeFileSync(indexFile, "[target](../target.txt)\n");

  // Correct: resolved from sub/'s own directory, ../target.txt lands on the real file.
  assert.deepEqual(brokenLinks(indexFile), []);

  // The D1 shape, made explicit: resolving the SAME target from a DIFFERENT base (what "resolve
  // from the repo root" would do for a file that isn't AT the root) finds nothing on disk --
  // proving resolveFromDir's choice of base is what makes the real check pass, not luck.
  assert.ok(!fs.existsSync(resolveFromDir(dir, '../target.txt')));
});

test('D2 control: an ADR on disk but absent from a scratch index is reported missing', (t) => {
  const dir = mkTmp(t);
  const decisionsDir = path.join(dir, 'decisions');
  fs.mkdirSync(decisionsDir);
  fs.writeFileSync(path.join(decisionsDir, '0001-example.md'), '# 0001. A title\n');
  const indexText = '# Index\n\nNo ADR links here.\n';
  const mismatches = adrIndexMismatches(indexText, decisionsDir);
  assert.deepEqual(mismatches, [{ base: '0001-example.md', reason: 'missing' }]);
});

test('D3 control: a scratch index entry with the right NNNN prefix but a wrong title is caught, not number-matched', (t) => {
  const dir = mkTmp(t);
  const decisionsDir = path.join(dir, 'decisions');
  fs.mkdirSync(decisionsDir);
  fs.writeFileSync(path.join(decisionsDir, '0001-example.md'), '# 0001. The real title\n');
  // Deliberately correct prefix ("0001."), deliberately wrong rest of the title -- a
  // number-prefix-only check would wrongly call this a match.
  const indexText = '# Index\n\n- [0001. A completely different title](decisions/0001-example.md)\n';
  const mismatches = adrIndexMismatches(indexText, decisionsDir);
  assert.deepEqual(mismatches, [
    { base: '0001-example.md', reason: 'wrong-title', expected: '0001. The real title', actual: '0001. A completely different title' },
  ]);
});

test('D3 positive control: a scratch index entry with the exact title is not reported', (t) => {
  const dir = mkTmp(t);
  const decisionsDir = path.join(dir, 'decisions');
  fs.mkdirSync(decisionsDir);
  fs.writeFileSync(path.join(decisionsDir, '0017-colon-title.md'), '# 0017: Keeps its own colon\n');
  const indexText = '# Index\n\n- [0017: Keeps its own colon](decisions/0017-colon-title.md)\n';
  assert.deepEqual(adrIndexMismatches(indexText, decisionsDir), []);
});

// Tests that pass today and prove nothing on their own (CLAUDE.md's testing standard): SECURITY.md
// currently has no markdown links at all, so its "every relative link resolves" test is
// vacuously true until a link is added; it stays in the loop above so it starts proving
// something the moment one is.

// ---------------------------------------------------------------------------
// D-AUD (S4b) checks. Each is a pure function over text or a directory, so a planted-defect
// control can prove the check goes red, not just that the real repo passes.
// ---------------------------------------------------------------------------

/** Every `@path` import line in a CLAUDE.md-style file that does NOT resolve from `fileDir`. */
function brokenImports(text, fileDir) {
  const broken = [];
  for (const line of text.split('\n')) {
    const m = /^@(\S+)\s*$/.exec(line);
    if (!m) continue;
    if (!fs.existsSync(path.resolve(fileDir, m[1]))) broken.push(m[1]);
  }
  return broken;
}

/** Every `.agents/` file (repo-relative) that `agentsText` does not link. */
function orphanAgentFiles(agentsText, files) {
  const linked = new Set(
    extractLinks(agentsText)
      .map(({ target }) => target.split('#')[0])
      .filter((t) => !isExternalOrAnchor(t))
      .map((t) => path.posix.normalize(t))
  );
  return files.filter((f) => !linked.has(f));
}

/** `docs/agent-runs` anywhere in `text`, except the bare rule statement "`docs/agent-runs/`"
 * (the developer guide must be able to NAME the folder it says never to commit). */
function agentRunsCitations(text) {
  return text.match(/docs\/agent-runs(?!\/`)[^\s`)]*/g) || [];
}

/** A citation of an ADR by line number: `00NN-name.md:12`, or "ADR 00NN" followed within a few
 * words by `:12`. Section names are the only sanctioned form. */
function adrLineCitations(text) {
  const out = [];
  const byFile = /\b00\d{2}-[a-z][a-z0-9-]*\.md:\d+/g;
  const byNumber = /\bADR 00\d{2}\b[^\n.]{0,25}`?:\d+/g;
  for (const re of [byFile, byNumber]) {
    let m;
    while ((m = re.exec(text))) out.push(m[0]);
  }
  return out;
}

test('docs-links: every @import in the root CLAUDE.md resolves', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.ok(/^@\S+/m.test(text), 'CLAUDE.md must import the rule set');
  assert.deepEqual(brokenImports(text, ROOT), []);
});

test('docs-links: every .agents/ file is linked from AGENTS.md', () => {
  const files = agentFiles();
  assert.ok(files.length >= 4, 'the agent folder holds its files');
  const text = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.deepEqual(orphanAgentFiles(text, files), []);
});

const HUMAN_DOC_FILES = () => {
  const out = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md', 'examples/README.md'];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'agent-runs') walk(r);
      } else if (e.name.endsWith('.md')) out.push(r);
    }
  };
  walk('docs');
  return out;
};

test('docs-links: no human doc cites docs/agent-runs', () => {
  const hits = [];
  for (const rel of HUMAN_DOC_FILES()) {
    const found = agentRunsCitations(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (found.length) hits.push({ rel, found });
  }
  assert.deepEqual(hits, []);
});

/** Tracked files outside docs/agent-runs, test fixtures and this test file. */
function trackedFilesForCitationScan() {
  const { execFileSync } = require('child_process');
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return names.filter(
    (n) =>
      !n.startsWith('docs/agent-runs/') &&
      !n.startsWith('test/fixtures/') &&
      !n.startsWith('node_modules/') &&
      !n.startsWith('vendor/') &&
      n !== 'package-lock.json' &&
      n !== 'test/docs-links.test.js' &&
      /\.(md|js|css|json|txt|toml|yml)$/.test(n)
  );
}

test('docs-links: no tracked file cites an ADR by line number', () => {
  const hits = [];
  for (const rel of trackedFilesForCitationScan()) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue; // staged for deletion
    const found = adrLineCitations(fs.readFileSync(abs, 'utf8'));
    if (found.length) hits.push({ rel, found });
  }
  assert.deepEqual(hits, []);
});

test('D-AUD control: a broken @import in a CLAUDE.md-style file is reported', (t) => {
  const dir = mkTmp(t);
  fs.writeFileSync(path.join(dir, 'real.md'), 'x');
  const text = '# x\n\n@real.md\n@missing/rules.md\n';
  assert.deepEqual(brokenImports(text, dir), ['missing/rules.md']);
  assert.deepEqual(brokenImports('@real.md\n', dir), []);
});

test('D-AUD control: an agent file AGENTS.md never links is reported as an orphan', () => {
  const text = '[a](.agents/a.md)\n[web](https://example.com/.agents/b.md)\n';
  assert.deepEqual(orphanAgentFiles(text, ['.agents/a.md', '.agents/b.md']), ['.agents/b.md']);
  // String-prefix sibling: linking .agents/a.md.bak must not count as linking .agents/a.md.
  assert.deepEqual(orphanAgentFiles('[a](.agents/a.md.bak)\n', ['.agents/a.md']), ['.agents/a.md']);
});

test('D-AUD control: a planted docs/agent-runs citation is caught, the bare rule statement is not', () => {
  assert.deepEqual(agentRunsCitations('see docs/agent-runs/brief-2026.md for detail'), ['docs/agent-runs/brief-2026.md']);
  assert.deepEqual(agentRunsCitations('(docs/agent-runs corrections)'), ['docs/agent-runs']);
  assert.deepEqual(agentRunsCitations('`docs/agent-runs/` is gitignored and must stay that way'), []);
});

test('D-AUD control: a planted ADR line-number citation is caught, a section citation is not', () => {
  assert.deepEqual(adrLineCitations('docs/decisions/0018-campaign-pack.md:12-13'), ['0018-campaign-pack.md:12']);
  assert.equal(adrLineCitations('ADR 0022 (:1013) lists it').length, 1);
  assert.equal(adrLineCitations('ADR 0019 `:278-282`').length, 1);
  assert.deepEqual(adrLineCitations('docs/decisions/0018-campaign-pack.md, section "Decision"'), []);
  assert.deepEqual(adrLineCitations('ADR 0022 section 8: unconditional'), []);
  // A line citation of a non-ADR file is not this check's business.
  assert.deepEqual(adrLineCitations('v1-restyle-lead-requirements-2026-09-29.md:43'), []);
});
