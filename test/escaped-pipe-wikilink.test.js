'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractWikiLinks } = require('../src/vault/links');

/*
 * Issue #48: [[Target\|Label]] inside a markdown table row (where | is the column delimiter).
 * Expected values are written out literally, never derived from the code under test.
 */

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');

test('extractWikiLinks: table-row escaped pipe splits target and alias', () => {
  const [l] = extractWikiLinks('| Who | Owes |\n|---|---|\n| [[Town Square\\|The Square]] | rent |\n');
  assert.equal(l.target, 'Town Square');
  assert.equal(l.alias, 'The Square');
  assert.equal(l.line, 3);
});

test('extractWikiLinks: heading plus escaped pipe in a table row', () => {
  const [l] = extractWikiLinks('| [[Town Square#History\\|old square]] |');
  assert.equal(l.target, 'Town Square');
  assert.equal(l.heading, 'History');
  assert.equal(l.alias, 'old square');
});

test('extractWikiLinks: an unescaped pipe in a table row is untouched', () => {
  const [l] = extractWikiLinks('| [[Town Square|The Square]] |');
  assert.equal(l.target, 'Town Square');
  assert.equal(l.alias, 'The Square');
});

test('extractWikiLinks: outside a table, a backslash-pipe is not rewritten', () => {
  const [l] = extractWikiLinks('Prose [[Town Square\\|x]] here');
  assert.equal(l.target, 'Town Square\\');
});

test('extractWikiLinks: escaped pipe inside inline code in a table row is not a link (ignoreCode)', () => {
  assert.equal(extractWikiLinks('| `[[Nowhere\\|x]]` |', { ignoreCode: true }).length, 0);
});

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-epipe-'));
  const vault = path.join(root, 'vault');
  fs.cpSync(LEASE, vault, { recursive: true });
  // Orpiment is a published page of the example vault (player mode, fail-closed manifest).
  fs.appendFileSync(
    path.join(vault, 'Characters', 'NPCs', 'Orpiment.md'),
    '\n\n## Debts\n\n| Who | Owes |\n|---|---|\n| [[Emlyn Crewe\\|Label Zqx]] | pennies |\n',
  );
  const cfg = path.join(root, 'cfg.toml');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  delete env.SCRIPTORIUM_PROFILE;
  const run = (args) => spawnSync(process.execPath, [BIN, ...args, '--config', cfg], { encoding: 'utf8', env });
  const add = run(['config', 'add', 'epipe', '--vault', vault, '--out', path.join(root, 'out')]);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  return { root, run };
}

test('CLI: with the pin\'s own reader alone (no build-side rewrite), check resolves a table-cell escaped-pipe link and build renders a real link with the label and indexes it', () => {
  const { root, run } = scratch();
  try {
    const check = run(['check', 'epipe', '--json']);
    const env = JSON.parse(check.stdout);
    assert.ok(!JSON.stringify(env).includes('does not resolve'), `check must report no unresolved link: ${check.stdout}`);
    assert.equal(check.status, 0, check.stdout);

    const build = run(['build', 'epipe', '--no-check']);
    assert.equal(build.status, 0, build.stderr + build.stdout);
    const html = fs.readFileSync(path.join(root, 'out', 'characters', 'npcs', 'orpiment.html'), 'utf8');
    const m = /<td><a href="([^"]+)">Label Zqx<\/a><\/td>/.exec(html);
    assert.ok(m, `expected a link cell, got: ${html.slice(html.indexOf('<table'), html.indexOf('</table>') + 8)}`);
    assert.equal(m[1], 'emlyn-crewe.html');
    assert.ok(!html.includes('[['), 'no raw wikilink syntax may leak');
    assert.ok(!html.includes('Emlyn Crewe\\'), 'no stray backslash target');
    const idx = fs.readFileSync(path.join(root, 'out', 'search-index.json'), 'utf8');
    assert.ok(idx.includes('"zqx"'), 'search index must contain the label term');
    assert.ok(!idx.includes('crewe\\\\'), 'search index must not contain a backslash term');
    // Backlinks: the linked page lists Orpiment as a mention (the pin's backlink reader, same escaped pipe).
    const target = fs.readFileSync(path.join(root, 'out', 'characters', 'npcs', 'emlyn-crewe.html'), 'utf8');
    assert.ok(/orpiment\.html/.test(target), 'the linked page must list the table-cell mention as a backlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- rework: code masking, restore lifecycle, vault scoping (ADR 0043) ----

const { rewriteEscapedPipeLinksOutsideCode: rw } = require('../src/vault/links');
const bootstrap = require('../src/generator/bootstrap');

test('rewrite: a table row inside a fenced block is left alone', () => {
  const src = '```\n| a | [[X\\|Y]] |\n```\n';
  assert.equal(rw(src), src);
});

test('rewrite: an inline code span in a table cell is left alone, prose link beside it is rewritten', () => {
  assert.equal(rw('| `[[X\\|Y]]` | [[A\\|B]] |'), '| `[[X\\|Y]]` | [[A|B]] |');
});

test('rewrite: a table row after a closed fence is rewritten again', () => {
  assert.equal(rw('```\nx\n```\n| [[A\\|B]] |'), '```\nx\n```\n| [[A|B]] |');
});

function scratchVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-shim-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'in.md'), '| [[A\\|B]] |\n');
  return { root, vault };
}

// ADR 0043 addendum (publish-v1.14.0): the build half of the escaped-pipe rewrite is retired. The
// shim infrastructure stays (vault scope, restore, comment stripping: test/obsidian-comments.test.js),
// but a table-cell escaped pipe now reaches the pin byte for byte, and the pin's own reader
// (lib/wikilink.js) resolves it. The CLI test above is the proof of that, on a real build.
test('the build read shim leaves a table-cell escaped pipe alone (the pin reads it itself)', () => {
  const { root, vault } = scratchVault();
  const restore = bootstrap.installVaultReadShim(vault, bootstrap.READ_TRANSFORMS_FOR_BUILD);
  try {
    assert.equal(fs.readFileSync(path.join(vault, 'in.md'), 'utf8'), '| [[A\\|B]] |\n');
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runGeneratorBuild restores fs.readFileSync after a throw and after a success', () => {
  const orig = fs.readFileSync;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-shim-run-'));
  try {
    // throw: a config path that does not exist
    const thrown = bootstrap.runGeneratorBuild(path.join(root, 'nope', 'vault.config.json'));
    assert.ok(thrown.error, 'build of a missing config must error');
    assert.equal(fs.readFileSync, orig, 'restored after a throw');

    // success: real staged build of a tiny vault
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes', 'A.md'), '---\ntype: note\ntitle: A\n---\n\nhello\n');
    const cfgPath = path.join(root, 'vault.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      siteTitle: 'T', siteUrl: 'https://example.invalid', vaultPath: vault, outputDir: path.join(root, 'out'),
      attachmentsDir: '_attachments', folderMap: { Notes: 'notes' }, excludeDirs: ['_meta'], excludeSections: [],
    }));
    const ok = bootstrap.runGeneratorBuild(cfgPath);
    assert.equal(ok.error, null, String(ok.error && ok.error.stack));
    assert.equal(fs.readFileSync, orig, 'restored after a success');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
