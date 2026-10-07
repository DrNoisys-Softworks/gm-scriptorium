'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanObsidianComments, stripObsidianComments } = require('../src/vault/comments');
const { scanCommentsInOutput, needlesFor } = require('../src/checks/leak/commentscan');
const bootstrap = require('../src/generator/bootstrap');

/*
 * ADR 0044: Obsidian %%comments%% are withheld. Expected values are written out literally.
 */

// ---- the scanner ----

test('inline comment is removed, the rest of the line kept', () => {
  assert.equal(stripObsidianComments('a %%secret%% b'), 'a  b');
  assert.deepEqual(scanObsidianComments('a %%secret%% b').comments, [{ line: 1, endLine: 1, text: 'secret', unterminated: false }]);
});

test('two inline comments on one line', () => {
  assert.equal(stripObsidianComments('x %%1%% y %%2%% z'), 'x  y  z');
});

test('multi-line block: every line withheld, line count preserved', () => {
  const r = scanObsidianComments('before\n%%\nline one\nline two\n%%\nafter');
  assert.equal(r.text, 'before\n\n\n\n\nafter');
  assert.deepEqual(r.comments, [{ line: 2, endLine: 5, text: '\nline one\nline two\n', unterminated: false }]);
});

test('a comment that opens mid-line and closes on a later line keeps the text on both outer sides', () => {
  assert.equal(stripObsidianComments('keep1 %% hidden\nstill hidden %% keep2'), 'keep1 \n keep2');
});

test('unterminated %% is withheld to the end of the file (fail closed) and flagged', () => {
  const r = scanObsidianComments('visible\n%% never closed\nmore\nmore still');
  assert.equal(r.text, 'visible\n\n\n');
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].unterminated, true);
  assert.equal(r.comments[0].line, 2);
});

test('%% inside a fenced code block is left alone (backtick and tilde fences)', () => {
  const src = '```\n%%keep%%\n```\n~~~\n%%keep2%%\n~~~';
  assert.equal(stripObsidianComments(src), src);
  assert.deepEqual(scanObsidianComments(src).comments, []);
});

test('%% inside an inline code span is left alone; a comment beside it is still removed', () => {
  assert.equal(stripObsidianComments('`%%keep%%` and %%drop%% x'), '`%%keep%%` and  x');
});

test('an unterminated fence swallows the rest as code, so a later %% is not a comment (same as the link scan)', () => {
  const src = '```\n%%x%%';
  assert.equal(stripObsidianComments(src), src);
});

test('a fence marker inside an open comment does not start a fence; the comment still closes', () => {
  assert.equal(stripObsidianComments('%%\n```\n%%\nvisible %%gone%%'), '\n\n\nvisible ');
});

test('the closing line of a block can carry a new comment', () => {
  assert.equal(stripObsidianComments('%% a\nb %% c %%d%% e'), '\n c  e');
});

test('frontmatter is left alone; the body after it is scanned', () => {
  assert.equal(stripObsidianComments('---\nk: 50%% off\n---\nbody %%x%% end'), '---\nk: 50%% off\n---\nbody  end');
});

test('a file with no %% is returned untouched; non-strings pass through', () => {
  assert.equal(stripObsidianComments('plain\ntext'), 'plain\ntext');
  assert.equal(stripObsidianComments(undefined), undefined);
});

test('CRLF files: comments are still removed and nothing is left readable', () => {
  const out = stripObsidianComments('a\r\n%%\r\nsecret\r\n%%\r\nb\r\n');
  assert.ok(!out.includes('secret'));
  assert.ok(out.startsWith('a\r\n') && out.includes('b'));
});

test('adjacent %%%%text%%%% is an empty comment, the text, an empty comment (text stays visible, as in Obsidian)', () => {
  assert.equal(stripObsidianComments('%%%%text%%%%'), 'text');
});

test('%%% is treated as an opener (fail closed), never published', () => {
  assert.ok(!stripObsidianComments('x %%% secret').includes('secret'));
});

// ---- the shim ----

test('the build shim strips comments and leaves a table-cell escaped pipe to the pin, in vault .md reads only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cmt-shim-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'a.md'), 'a %%hid%% b\n| [[T\\|L]] |\n');
  fs.writeFileSync(path.join(root, 'outside.md'), 'a %%hid%% b\n');
  fs.writeFileSync(path.join(vault, 'a.txt'), 'a %%hid%% b\n');
  const orig = fs.readFileSync;
  const restore = bootstrap.installVaultReadShim(vault, bootstrap.READ_TRANSFORMS_FOR_BUILD);
  try {
    assert.equal(fs.readFileSync(path.join(vault, 'a.md'), 'utf8'), 'a  b\n| [[T\\|L]] |\n');
    assert.equal(fs.readFileSync(path.join(root, 'outside.md'), 'utf8'), 'a %%hid%% b\n');
    assert.equal(fs.readFileSync(path.join(vault, 'a.txt'), 'utf8'), 'a %%hid%% b\n');
    assert.equal(fs.readFileSync(path.join(vault, 'a.md')).toString(), 'a %%hid%% b\n| [[T\\|L]] |\n');
  } finally {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync, orig);
});

test('the build installs exactly one transform, the comment strip (the escaped-pipe rewrite is retired, ADR 0043 addendum)', () => {
  assert.deepEqual(bootstrap.READ_TRANSFORMS_FOR_BUILD, [stripObsidianComments]);
  assert.equal(bootstrap.installEscapedPipeReadShim, undefined);
});

test('the build installs comment stripping first', () => {
  assert.equal(bootstrap.READ_TRANSFORMS_FOR_BUILD[0], stripObsidianComments);
});

// ---- the output scan, on a hand-made tree ----

function outTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cmt-out-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const COMMENT = { relPath: 'Notes/A.md', line: 7, endLine: 7, text: 'the duke is the traitor', unterminated: false };

test('output scan: comment text in HTML is an error', () => {
  const dir = outTree({ 'a.html': '<p>The <em>Duke</em> is fine. the duke is the traitor</p>' });
  try {
    const f = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [COMMENT] });
    assert.equal(f.length, 1);
    assert.equal(f[0].id, 'leak/l6-comment-in-output');
    assert.equal(f[0].severity, 'error');
    assert.equal(f[0].outputPath, 'a.html');
    assert.equal(f[0].path, 'Notes/A.md');
    assert.equal(f[0].line, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('output scan: comment text in the search index is an error, and JSON escaping does not hide it', () => {
  const dir = outTree({ 'search-index.json': JSON.stringify({ documents: [{ text: 'x "the duke is\nthe traitor" y' }] }) });
  try {
    const f = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [{ ...COMMENT, text: 'the duke is\nthe traitor' }] });
    assert.ok(f.some((x) => x.outputPath === 'search-index.json' && x.severity === 'error'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('output scan: a literal %% in prose is an error, in <code>/<pre> it is not', () => {
  const dir = outTree({
    'bad.html': '<p>hello %%oops</p>',
    'ok.html': '<p>x</p><pre><code>%%fine%%</code></pre><p><code>%%also%%</code></p><style>a{width:100%%}</style>',
  });
  try {
    const f = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [] });
    assert.deepEqual(f.map((x) => x.outputPath), ['bad.html']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('output scan: clean output and very short comments give no finding', () => {
  const dir = outTree({ 'a.html': '<p>todo list</p>' });
  try {
    assert.deepEqual(scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [{ ...COMMENT, text: 'todo' }] }), []);
    assert.deepEqual(scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [COMMENT] }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(needlesFor({ text: 'todo' }), []);
  assert.deepEqual(needlesFor({ text: '\nFirst line here\nsecond line here\n' }), ['first line here second line here', 'first line here', 'second line here']);
});

// ---- ADR 0045: JSON data islands ----

const { serializeDataIsland } = require('../src/build/sitescript');

const island = (v, attrs = 'class="sc-tl-data"') => `<script type="application/json" ${attrs}>${serializeDataIsland(v)}</script>`;

test('islands (text arm): comment text only inside a sc-tl-data island is an error with the right outputPath', () => {
  const dir = outTree({ 'timeline/index.html': `<p>clean</p>${island({ events: [{ title: 'The Duke Is The Traitor', note: 'the duke is the traitor' }] })}` });
  try {
    const f = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [COMMENT] });
    assert.equal(f.length, 1);
    assert.equal(f[0].data.arm, 'text');
    assert.equal(f[0].severity, 'error');
    assert.equal(f[0].outputPath, 'timeline/index.html');
    assert.equal(f[0].path, 'Notes/A.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('islands (text arm): a connections island and an id-keyed generator island are searched too', () => {
  const dir = outTree({
    'cx.html': island({ nodes: ['the duke is the traitor'] }, 'class="sc-cx-data"'),
    'party.html': `<script id="party-data" type="application/json">${serializeDataIsland({ members: [{ bio: 'the duke is the traitor' }] })}</script>`,
  });
  try {
    const f = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [COMMENT] });
    assert.deepEqual(f.map((x) => [x.outputPath, x.data.arm]).sort(), [['cx.html', 'text'], ['party.html', 'text']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('islands (marks arm): a %% in an island string is an error; one finding per file', () => {
  const dir = outTree({ 'a.html': `<p>x</p>${island({ rows: [{ t: 'oops %% leaked' }, { t: 'and %% again' }] })}` });
  try {
    const f = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [] });
    assert.equal(f.length, 1);
    assert.equal(f[0].data.arm, 'marks');
    assert.equal(f[0].outputPath, 'a.html');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('islands (exclusions kept): %% in pre, code, style, a non-JSON script, or an island with no %% gives 0', () => {
  const dir = outTree({
    'ok.html': `<pre>%%a%%</pre><code>%%b%%</code><style>a{width:100%%}</style><script>var x = "%% the duke is the traitor";</script><script type="text/template">%%c%%</script>${island({ t: 'fine' })}`,
  });
  try {
    assert.deepEqual(scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [COMMENT] }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('islands (fail closed): invalid JSON is an island-unparsable error with no island text, and its raw body is still searched', () => {
  const dir = outTree({ 'a.html': '<p>x</p><script type="application/json" class="sc-tl-data">{"a": "the duke is the traitor", ZQXBROKEN</script>' });
  try {
    const f = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [COMMENT] });
    const un = f.filter((x) => x.data.arm === 'island-unparsable');
    assert.equal(un.length, 1);
    assert.equal(un[0].severity, 'error');
    assert.equal(un[0].outputPath, 'a.html');
    assert.ok(!JSON.stringify(un[0]).includes('ZQXBROKEN'), 'no island text in the finding');
    assert.ok(!JSON.stringify(un[0]).includes('traitor'), 'no island text in the finding');
    assert.ok(!/position|Unexpected|JSON\.parse/i.test(JSON.stringify(un[0])), 'no parser message in the finding');
    assert.equal(f.filter((x) => x.data.arm === 'text').length, 1, 'comment text inside the broken island is still found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('islands (fail closed): a %% inside an unparsable island is also a marks error', () => {
  const dir = outTree({ 'a.html': '<script type="application/json" id="d">{ %% broken</script>' });
  try {
    const arms = scanCommentsInOutput({ outDir: dir, campaign: 'c', comments: [] }).map((x) => x.data.arm).sort();
    assert.deepEqual(arms, ['island-unparsable', 'marks']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ADR 0045: odd script tag forms (CodeQL: bad HTML filtering regexp, incomplete multi-character sanitization) ----

function scanOne(html, comments = [COMMENT]) {
  const dir = outTree({ 'a.html': html });
  try {
    return scanCommentsInOutput({ outDir: dir, campaign: 'c', comments });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const arms = (f) => f.map((x) => x.data.arm).sort();

for (const [name, open, close] of [
  ['uppercase tags', '<SCRIPT TYPE="Application/JSON" ID="d">', '</SCRIPT>'],
  ['end tag with a space', '<script type="application/json" id="d">', '</script >'],
  ['end tag with tab, newline and an attribute', '<script type="application/json" id="d">', '</script\t\nfoo>'],
  ['unquoted type attribute', '<script id=d type=application/json>', '</script>'],
]) {
  test(`island forms: ${name}: a valid island is read (text arm, no unparsable finding)`, () => {
    const f = scanOne(`<p>x</p>${open}${serializeDataIsland({ n: 'the duke is the traitor' })}${close}`);
    assert.deepEqual(arms(f), ['text']);
  });

  test(`island forms: ${name}: a broken island fails closed`, () => {
    const f = scanOne(`<p>x</p>${open}{"n": "the duke is the traitor", ZQXBROKEN${close}`);
    assert.deepEqual(arms(f), ['island-unparsable', 'text']);
    assert.ok(!JSON.stringify(f).includes('ZQXBROKEN'));
  });

  test(`island forms: ${name}: a %% in a valid island is a marks error`, () => {
    assert.deepEqual(arms(scanOne(`${open}${serializeDataIsland({ n: 'oops %% here' })}${close}`, [])), ['marks']);
  });
}

test('island forms: an unterminated JSON island fails closed, and its text is still searched', () => {
  const f = scanOne('<p>x</p><script type="application/json" id="d">{"n": "the duke is the traitor"');
  assert.deepEqual(arms(f), ['island-unparsable', 'text']);
});

test('island forms: an unterminated island whose body is valid JSON still fails closed', () => {
  assert.deepEqual(arms(scanOne('<p>x</p><script type="application/json" id="d">{"n": "fine"}', [])), ['island-unparsable']);
});

test('island forms: an unterminated island with a %% is also a marks error', () => {
  assert.deepEqual(arms(scanOne('<script type="application/json">{"n": "a %% b"', [])), ['island-unparsable', 'marks']);
});

test('island forms: a reconstructed <script (<scr<script></script>ipt>) cannot hide an island or its text', () => {
  const html = `<scr<script></script>ipt type="application/json">{"n": "the duke is the traitor"}</script>`;
  assert.ok(arms(scanOne(html)).includes('text'));
});

test('island forms: a tag reconstructed by stripping (<<b>b>) cannot hide comment text', () => {
  assert.deepEqual(arms(scanOne('<p><<b>i>the duke is the traitor</i></p>')), ['text']);
});

test('island forms: a non-JSON script closed with an odd end tag is still left out of the search', () => {
  assert.deepEqual(scanOne('<script>var a = "the duke is the traitor %%";</script\t\nfoo><p>fine</p>'), []);
  assert.deepEqual(scanOne('<STYLE>a{width:100%%}</STYLE ><p>fine</p>'), []);
});

// ---- end to end: the CLI on a vault full of comments ----

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');

const EDITS = [
  // [file, find, (c) => replacement]
  ['Events/The Cut Page.md', /^(---\n[\s\S]*?\n---\n)/, (c) => `$1${c('%%ZQXCMT-EVENT first line%% ')}`],
  ['Sessions/Session 02 - The Wax Vaults.md', '*The Wardens traced', (c) => `*The Wardens ${c('%%ZQXCMT-RECAP inline%%')} traced`],
  ['Characters/NPCs/Orpiment.md', /^(---\n[\s\S]*?\n---\n)/, (c) => `$1\nOrpiment keeps ZQXKEEP-A.${c(' %%ZQXCMT-INLINE see [[Emlyn Crewe]]%%')}\n\n${c('%%\nZQXCMT-MULTI one\nZQXCMT-MULTI two [[Kit Farrow]]\n%%')}\n\n\`\`\`\n%%ZQXKEEP-FENCE%%\n\`\`\`\n\nInline \`%%ZQXKEEP-CODE%%\` stays.\n\n`],
  ['Characters/PCs/Kit Farrow_Story.md', /\s*$/, (c) => `\n\nKit says ZQXKEEP-B.${c(' %%ZQXCMT-STORY private%%')}\n`],
];

function makeVault(root, name, withComments) {
  const vault = path.join(root, name);
  fs.cpSync(LEASE, vault, { recursive: true });
  const c = (text) => (withComments ? text : text.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, '')).replace(/%%[\s\S]*$/, (m) => m.replace(/[^\n]/g, '')));
  for (const [rel, find, make] of EDITS) {
    const file = path.join(vault, rel);
    const src = fs.readFileSync(file, 'utf8');
    const replacement = make(c);
    const next = typeof find === 'string' ? src.replace(find, () => replacement.replace('$1', '')) : src.replace(find, replacement);
    assert.notEqual(next, src, `edit did not apply to ${rel}`);
    fs.writeFileSync(file, next);
  }
  // An unterminated comment must be last in its file for the two vaults to compare equal.
  const tail = fs.readFileSync(path.join(vault, 'Characters', 'NPCs', 'Oswy Hebden.md'), 'utf8').match(/^---\n[\s\S]*?\n---\n/)[0].replace(/title: .*/, 'title: Zed Tail');
  fs.writeFileSync(path.join(vault, 'Characters', 'NPCs', 'Zed Tail.md'), `${tail}\nZed says ZQXKEEP-C.\n${c('\n%% ZQXCMT-UNTERM never closed\n\nZQXCMT-AFTER text lost\n')}`);
  const man = path.join(vault, '_meta', 'publish-manifest.md');
  fs.writeFileSync(man, fs.readFileSync(man, 'utf8').replace('## Publishing\n', '## Publishing\n\n- [x] Characters/NPCs/Zed Tail.md'));
  return vault;
}

function cli(root, name, vault) {
  const cfg = path.join(root, 'cfg.toml');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg };
  delete env.SCRIPTORIUM_PROFILE;
  const run = (args) => spawnSync(process.execPath, [BIN, ...args, '--config', cfg], { encoding: 'utf8', env });
  const add = run(['config', 'add', name, '--vault', vault, '--out', path.join(root, `out-${name}`)]);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  return run;
}

function allOutput(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), fs.readFileSync(p)]);
    }
  })(dir);
  return out;
}

test('CLI: no comment text reaches any published file; code-fenced and inline-code %% survive; output equals a vault with the comments deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cmt-e2e-'));
  try {
    const withC = makeVault(root, 'with', true);
    const without = makeVault(root, 'without', false);
    const runA = cli(root, 'with', withC);
    const runB = cli(root, 'without', without);

    const check = runA(['check', 'with', '--json']);
    const env = JSON.parse(check.stdout);
    const ids = JSON.stringify(env);
    assert.ok(ids.includes('leak/l6-comment-withheld'), 'check must list files with comments');
    assert.ok(ids.includes('leak/l6-comment-unterminated'), 'check must warn on the unterminated comment');
    assert.ok(!ids.includes('ZQXCMT-INLINE see'), 'check must not echo withheld text');

    const buildA = runA(['build', 'with', '--no-check']);
    assert.equal(buildA.status, 0, buildA.stderr + buildA.stdout);
    const buildB = runB(['build', 'without', '--no-check']);
    assert.equal(buildB.status, 0, buildB.stderr + buildB.stdout);

    const filesA = allOutput(path.join(root, 'out-with'));
    for (const [rel, bytes] of filesA) {
      assert.ok(!bytes.includes('ZQXCMT'), `${rel} carries comment text`);
      assert.ok(!bytes.includes('ZQXCMT'.toLowerCase()), `${rel} carries lowercased comment text`);
    }
    const html = (rel) => fs.readFileSync(path.join(root, 'out-with', rel), 'utf8');
    const orp = html('characters/npcs/orpiment.html');
    for (const k of ['ZQXKEEP-A', 'ZQXKEEP-FENCE', 'ZQXKEEP-CODE']) assert.ok(orp.includes(k), `${k} must survive on Orpiment`);
    assert.ok(html('characters/npcs/zed-tail.html').includes('ZQXKEEP-C'), 'text before an unterminated comment is kept');
    assert.ok(!html('characters/npcs/zed-tail.html').includes('ZQXCMT-AFTER'));
    const idx = fs.readFileSync(path.join(root, 'out-with', 'search-index.json'), 'utf8');
    assert.ok(idx.includes('zqxkeep'), 'the search index must still index kept text');

    // Differential: deleting the comments by hand must publish the same bytes (backlinks, excerpts,
    // search index, landing and recap included).
    const filesB = allOutput(path.join(root, 'out-without'));
    assert.deepEqual(filesA.map(([r]) => r), filesB.map(([r]) => r));
    for (let i = 0; i < filesA.length; i++) {
      assert.equal(filesA[i][1].toString('utf8'), filesB[i][1].toString('utf8'), `${filesA[i][0]} differs from the comment-free build`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: with the 1.12.3 pin the generator withholds handout Keeper sections itself, so L5 does not double-report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cmt-l5-'));
  try {
    const vault = path.join(root, 'v');
    fs.cpSync(LEASE, vault, { recursive: true });
    const doc = (title, body, type = 'document') =>
      fs.writeFileSync(path.join(vault, 'Items & Artifacts', `${title}.md`), `---\ntype: ${type}\ntitle: ${title}\ncampaign: "The Long Lease"\nsource: play\nsource_confidence: AUTHORITATIVE\n---\n\n# ${title}\n\n${body}\n`);
    doc('ZH One', '## Context\n\nk\n\n## Clues and Hooks\n\nk\n\n## Prop Notes\n\nk\n\n## Delivery\n\nk\n\n## Innkeeper Notes\n\nfine\n\n## Contextual Detail\n\nfine\n');
    doc('ZH Two', '## Context\n\nnot a handout\n', 'item');
    const man = path.join(vault, '_meta', 'publish-manifest.md');
    fs.writeFileSync(man, fs.readFileSync(man, 'utf8').replace('## Publishing\n', '## Publishing\n\n- [x] Items & Artifacts/ZH One.md\n- [x] Items & Artifacts/ZH Two.md'));
    const run = cli(root, 'v', vault);
    const env = JSON.parse(run(['check', 'v', '--json']).stdout);
    const l5 = JSON.stringify(env);
    const hits = (l5.match(/handout Keeper heading \\"([^"\\]+)\\"/g) || []).map((m) => m.replace(/.*\\"([^"\\]+)\\"/, '$1')).sort();
    assert.deepEqual(hits, []);
    run(['build', 'v', '--no-check']);
    const found = allOutput(path.join(root, 'out-v')).find(([rel]) => rel.endsWith('zh-one.html'));
    assert.ok(found, 'handout page must be published');
    const out = found[1].toString('utf8');
    assert.ok(!out.includes('Clues and Hooks') && !out.includes('Prop Notes'), 'generator withholds the Keeper sections');
    assert.ok(out.includes('Innkeeper Notes') && out.includes('Contextual Detail'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: if the read shim failed, the output gate refuses the build and --force cannot override it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cmt-gate-'));
  try {
    const vault = makeVault(root, 'with', true);
    const run = cli(root, 'with', vault);
    // A preload that empties the shim's transform list, standing in for "the shim stopped working".
    const breaker = path.join(root, 'break.js');
    fs.writeFileSync(breaker, `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'generator', 'bootstrap.js'))}).READ_TRANSFORMS_FOR_BUILD.length = 0;\n`);
    const cfg = path.join(root, 'cfg.toml');
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg, NODE_OPTIONS: `--require ${breaker}` };
    delete env.SCRIPTORIUM_PROFILE;
    for (const extra of [[], ['--force']]) {
      const r = spawnSync(process.execPath, [BIN, 'build', 'with', '--no-check', ...extra, '--config', cfg], { encoding: 'utf8', env });
      assert.equal(r.status, 2, `exit 2 (refused) expected, got ${r.status}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.includes('leak/l6-comment-in-output') || r.stderr.includes('leak/l6-comment-in-output'), r.stdout + r.stderr);
      assert.ok(!fs.existsSync(path.join(root, 'out-with', 'index.html')), 'nothing may be swapped into place');
    }
    // And the same vault builds fine without the breaker.
    assert.equal(run(['build', 'with', '--no-check']).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: a comment that reaches only a timeline data island is refused by the output gate, and --force cannot override it (ADR 0045)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-cmt-island-'));
  try {
    const vault = path.join(root, 'v');
    fs.cpSync(LEASE, vault, { recursive: true });
    // A comment in a timeline Title cell: the helper columns are removed from the visible table, so
    // with the read shim emptied the text can only surface inside the sc-tl-data island.
    const tl = path.join(vault, '_Campaign', 'Timeline.md');
    const src = fs.readFileSync(tl, 'utf8');
    const next = src.replace('| The Signing | backstory', '| The Signing %%ZQXISLAND-LEAK private note%% | backstory');
    assert.notEqual(next, src, 'edit did not apply');
    fs.writeFileSync(tl, next);
    const run = cli(root, 'v', vault);
    const breaker = path.join(root, 'break.js');
    fs.writeFileSync(breaker, `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'generator', 'bootstrap.js'))}).READ_TRANSFORMS_FOR_BUILD.length = 0;\n`);
    const cfg = path.join(root, 'cfg.toml');
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg, NODE_OPTIONS: `--require ${breaker}` };
    delete env.SCRIPTORIUM_PROFILE;
    for (const extra of [[], ['--force']]) {
      const r = spawnSync(process.execPath, [BIN, 'build', 'v', '--no-check', ...extra, '--config', cfg], { encoding: 'utf8', env });
      assert.equal(r.status, 2, `exit 2 (refused) expected, got ${r.status}: ${r.stdout}${r.stderr}`);
      assert.ok((r.stdout + r.stderr).includes('leak/l6-comment-in-output'), r.stdout + r.stderr);
      assert.ok(!fs.existsSync(path.join(root, 'out-v', 'index.html')), 'nothing may be swapped into place');
    }
    // Without the breaker the shim removes the comment and the same vault builds.
    assert.equal(run(['build', 'v', '--no-check']).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source-side checks see the page the way the build does: a withheld name only inside a comment is not an L4 hit', () => {
  const { deriveRenderedText } = require('../src/checks/leak/textmodel');
  const page = { markdown: 'Public line.\n%% the secret is Ottoline %%\nMore.', frontmatter: { type: 'npc' }, relPath: 'x.md' };
  const r = deriveRenderedText(page, { exclude_sections: [], exclude_callouts: [], exclude_fields: [] });
  assert.ok(!r.fullText.includes('Ottoline'));
  assert.ok(r.fullText.includes('Public line.'));
});
