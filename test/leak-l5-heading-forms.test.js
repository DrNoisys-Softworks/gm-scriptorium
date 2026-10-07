'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pinned = require('../src/generator/pinned');
const { runGmHeadingSurvives } = require('../src/checks/leak/l5');
const { extractHeadings, readRenderedHeadings, displayTextOf } = require('../src/checks/leak/textmodel');

/*
 * ADR 0045: L5 reads headings the way the pinned generator parses and renders them, in the body
 * and in the paired _Story.md. Expected values are written out literally; nothing is derived from
 * the code under test. The locked emoji form is written as an escape so no literal emoji is in source.
 */

const SENTINEL = 'ZQXSENTINEL-BODY';
const ID = 'leak/l5-gm-heading-survives';

function basePublishConfig(overrides = {}) {
  return {
    mode: 'player',
    exclude_drafts: false,
    exclude_callouts: false,
    exclude_sections: ['GM Notes'],
    exclude_fields: [],
    exclude_dirs: [],
    overrides: { fields: {} },
    ...overrides,
  };
}

function minimalPage(overrides = {}) {
  return {
    sourcePath: '/vault/Page.md',
    relPath: 'Page.md',
    rel: 'Page.md',
    title: 'Page',
    displayTitle: 'Page',
    slug: 'page',
    outputPath: 'page.html',
    outputDir: '',
    frontmatter: { type: 'npc' },
    markdown: '',
    bodyLineOffset: 0,
    storyMarkdown: undefined,
    storySourcePath: undefined,
    storyRelPath: undefined,
    storyLineOffset: undefined,
    storyOutputPath: undefined,
    verdict: null,
    ...overrides,
  };
}

function ctxFor(pages, { exclude = ['GM Notes'], jsonExclude = [] } = {}) {
  return {
    campaign: 'unit',
    index: { files: [] },
    jsonConfig: { excludeSections: jsonExclude },
    publishSet: { publishedPages: pages, publishConfig: basePublishConfig({ exclude_sections: exclude }) },
  };
}

/** A section as markdown: intro, the heading form, then a sentinel line. The heading is on line 3. */
function section(form) {
  return `Intro.\n\n${form}\n${SENTINEL}\n`;
}

function bodyPage(markdown) {
  return minimalPage({ markdown });
}

function storyPage(storyMarkdown) {
  return minimalPage({
    relPath: 'Party/Pc.md',
    frontmatter: { type: 'pc' },
    markdown: 'Clean body.\n',
    storyMarkdown,
    storyRelPath: 'Party/Pc_Story.md',
    storyLineOffset: 2,
  });
}

function l5(findings, source) {
  return findings.filter((f) => f.id === ID && f.data && f.data.source === source);
}

// F1..F10: forms the generator publishes, because its exclusion test is exact equality on the raw title.
const SURVIVING_FORMS = [
  ['F1 trailing words', '## GM Notes (spoilers)'],
  ['F2 bold', '## **GM Notes**'],
  ['F3 bold with trailing words', '## **GM Notes** (spoilers)'],
  ['F4 emphasis with suffix', '## _GM Notes_ - session 3'],
  ['F5 link text', '## [GM Notes](x) extra'],
  ['F6 entity space', '## GM&nbsp;Notes extra'],
  ['F7 indented', '   ## GM Notes (spoilers)'],
  ['F8 setext', 'GM Notes (spoilers)\n---'],
  ['F9 blockquote', '> ## GM Notes (spoilers)'],
  ['F10 leading symbol', '## \u{1F512} GM Notes'],
];

// --- AC-04 premise (passes before the fix; proves the premise only, not the fix) ---

for (const [name, form] of SURVIVING_FORMS) {
  test(`premise only, passes before the fix: the generator publishes the ${name} section body`, () => {
    const out = pinned.filterSections(section(form), ['GM Notes'], { type: 'npc' });
    assert.ok(out.includes(SENTINEL), `${name}: expected the pin to publish the body`);
  });
}

// --- AC-02 body forms ---

for (const [name, form] of SURVIVING_FORMS) {
  test(`AC-02 ${name}: exactly one body error`, () => {
    const found = l5(runGmHeadingSurvives(ctxFor([bodyPage(section(form))])), 'body');
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'error');
    assert.equal(found[0].path, 'Page.md');
    assert.equal(found[0].line, 3);
    assert.equal(found[0].data.matchedExclusion, 'gm notes');
  });
}

// --- AC-03 story forms ---

for (const [name, form] of SURVIVING_FORMS) {
  test(`AC-03 ${name}: exactly one story error on the _Story.md path`, () => {
    const all = runGmHeadingSurvives(ctxFor([storyPage(section(form))]));
    assert.equal(l5(all, 'body').length, 0);
    const found = l5(all, 'story');
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'error');
    assert.equal(found[0].path, 'Party/Pc_Story.md');
    // Heading is on source line 3 of the story; the story body starts after 2 frontmatter lines.
    assert.ok(found[0].line === null || found[0].line === 5, `line was ${found[0].line}`);
  });
}

// --- AC-04 forms the generator withholds: no finding ---

const WITHHELD_FORMS = [
  ['plain', '## GM Notes'],
  ['indented', '   ## GM Notes'],
  ['setext', 'GM Notes\n---'],
  ['blockquote', '> ## GM Notes'],
  ['closed ATX', '## GM Notes ##'],
];

for (const [name, form] of WITHHELD_FORMS) {
  test(`AC-04 ${name}: the generator withholds the section and L5 gives 0, body and story`, () => {
    const md = section(form);
    const out = pinned.filterSections(md, ['GM Notes'], { type: 'npc' });
    assert.ok(!out.includes(SENTINEL), `${name}: premise failed, the pin published the body`);
    assert.equal(l5(runGmHeadingSurvives(ctxFor([bodyPage(md)])), 'body').length, 0);
    assert.equal(l5(runGmHeadingSurvives(ctxFor([storyPage(md)])), 'story').length, 0);
  });
}

// --- AC-05 negative controls ---

for (const form of ['## Innkeeper Notes', '## Notes for the GM', '## The GM Notes']) {
  test(`AC-05 negative control "${form}": 0 findings, body and story (an empty entry beside it matches nothing)`, () => {
    const opts = { exclude: ['GM Notes', ''] };
    assert.equal(l5(runGmHeadingSurvives(ctxFor([bodyPage(section(form))], opts)), 'body').length, 0);
    assert.equal(l5(runGmHeadingSurvives(ctxFor([storyPage(section(form))], opts)), 'story').length, 0);
  });
}

// --- AC-06 semantics ---

function oneBody(form, exclude) {
  return l5(runGmHeadingSurvives(ctxFor([bodyPage(section(form))], { exclude })), 'body');
}

test('AC-06 case: "## gm NOTES extra" gives one finding', () => {
  assert.equal(oneBody('## gm NOTES extra', ['GM Notes']).length, 1);
});

test('AC-06 wikilink alias: "## [[Lore|GM Notes]] extra" gives one finding', () => {
  assert.equal(oneBody('## [[Lore|GM Notes]] extra', ['GM Notes']).length, 1);
});

test('AC-06 typographer: entry "Players\' Secrets" against "## **Players\' Secrets** (x)" gives one finding', () => {
  assert.equal(oneBody("## **Players' Secrets** (x)", ["Players' Secrets"]).length, 1);
});

test('AC-06 NFC: a composed entry against a decomposed heading gives one finding', () => {
  const composed = 'Café Notes';
  const decomposed = 'Café Notes';
  assert.notEqual(composed, decomposed);
  assert.equal(oneBody(`## ${decomposed} extra`, [composed]).length, 1);
});

test('AC-06 an empty-string entry matches nothing', () => {
  assert.equal(oneBody('## Anything At All', ['']).length, 0);
  assert.equal(oneBody('## GM Notes (spoilers)', ['', 'GM Notes']).length, 1);
});

test('AC-06 an entry from the json config surface also matches', () => {
  const found = l5(runGmHeadingSurvives(ctxFor([bodyPage(section('## Secret Plans (v2)'))], { exclude: [], jsonExclude: ['Secret Plans'] })), 'body');
  assert.equal(found.length, 1);
});

test('data.heading stays the raw title and data.display is the rendered text', () => {
  const [f] = oneBody('## **GM Notes** (spoilers)', ['GM Notes']);
  assert.equal(f.data.heading, '**GM Notes** (spoilers)');
  assert.equal(f.data.display, 'GM Notes (spoilers)');
});

test('closed ATX with trailing words: one finding, not one per reading', () => {
  assert.equal(oneBody('## GM Notes (spoilers) ##', ['GM Notes']).length, 1);
});

// --- AC-07 fail closed ---

test('AC-07 a parser failure still emits an error for the source and still matches margin headings', () => {
  const original = pinned.findHeadings;
  pinned.findHeadings = () => {
    throw new Error('BOOM-parser-detail Intro.');
  };
  try {
    const body = l5(runGmHeadingSurvives(ctxFor([bodyPage(section('## GM Notes (spoilers)'))])), 'body');
    const parseErr = body.filter((f) => f.data.parseError === true);
    const heading = body.filter((f) => f.data.parseError !== true);
    assert.equal(parseErr.length, 1);
    assert.equal(heading.length, 1, 'the margin heading is still matched');
    assert.equal(parseErr[0].severity, 'error');
    assert.ok(!parseErr[0].message.includes('BOOM'), 'the parser error text must not be copied');
    assert.ok(!parseErr[0].message.includes('Intro.'), 'no page text in the finding');

    const story = l5(runGmHeadingSurvives(ctxFor([storyPage(section('## GM Notes (spoilers)'))])), 'story');
    assert.equal(story.filter((f) => f.data.parseError === true).length, 1);
    assert.equal(story[0].path, 'Party/Pc_Story.md');
  } finally {
    pinned.findHeadings = original;
  }
});

// --- reader units ---

test('readRenderedHeadings: one entry per line with the parser title first', () => {
  const r = readRenderedHeadings('## GM Notes ##\n\nGM Notes (x)\n---\n\n> ## Quote\n');
  assert.equal(r.parseError, false);
  assert.deepEqual(
    r.headings.map((h) => [h.line, h.level, h.titles, h.nested]),
    [
      [1, 2, ['GM Notes', 'GM Notes ##'], false],
      [3, 2, ['GM Notes (x)'], false],
      [6, 2, ['Quote'], true],
    ],
  );
});

test('readRenderedHeadings keeps a margin heading inside code, as the generator does', () => {
  const r = readRenderedHeadings('```\n## GM Notes\n```\n');
  assert.deepEqual(r.headings.map((h) => [h.line, h.titles]), [[2, ['GM Notes']]]);
});

test('extractHeadings is unchanged: margin-only, raw title', () => {
  assert.deepEqual(extractHeadings('   ## Indented\n## Margin ##\n'), [{ level: 2, title: 'Margin ##', line: 2 }]);
});

test('displayTextOf: alias, emphasis, entities, typographer, and no prototype lookup', () => {
  assert.equal(displayTextOf('[[Lore|GM Notes]] extra'), 'GM Notes extra');
  assert.equal(displayTextOf('**Bold** _em_ [l](x)'), 'Bold em l');
  assert.equal(displayTextOf('A&nbsp;B'), 'A B');
  assert.equal(displayTextOf("It's"), 'It’s');
  assert.equal(displayTextOf('[[constructor]]'), 'constructor');
});

// --- AC-12 exit code ---

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const LEASE = path.join(__dirname, '..', 'examples', 'the-long-lease');

test('AC-12 CLI: an NPC "## **GM Notes**" makes check exit 2 and list the L5 finding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l5-cli-'));
  try {
    const vault = path.join(root, 'v');
    fs.cpSync(LEASE, vault, { recursive: true });
    const npc = path.join(vault, 'Characters', 'NPCs', 'Oswy Hebden.md');
    fs.appendFileSync(npc, `\n## **GM Notes**\n\n${SENTINEL}\n`);
    const cfg = path.join(root, 'cfg.toml');
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'xdg'), APPDATA: path.join(root, 'ad'), SCRIPTORIUM_CONFIG: cfg };
    delete env.SCRIPTORIUM_PROFILE;
    const run = (args) => spawnSync(process.execPath, [BIN, ...args, '--config', cfg], { encoding: 'utf8', env });
    const add = run(['config', 'add', 'v', '--vault', vault, '--out', path.join(root, 'out-v')]);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const r = run(['check', 'v', '--json']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const env2 = JSON.parse(r.stdout);
    const hits = JSON.stringify(env2).split('leak/l5-gm-heading-survives').length - 1;
    assert.ok(hits >= 1, 'the L5 finding must be listed');
    assert.ok(JSON.stringify(env2).includes('Oswy Hebden.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
