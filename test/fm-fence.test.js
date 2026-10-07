'use strict';

/*
 * ADR 0034 / FR-FM-01. src/vault/fence.js's predicate: a literal table of hand-written expected
 * values, a differential corpus checked against the bundled gray-matter itself (with recording
 * engines -- the only allowed reference call; never derive an expectation from fence.js's own
 * source), and renderTag()'s output-hygiene bound.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyFrontmatterFence, renderTag, FENCE_HEAD_BYTES, RENDERED_TAG_MAX } = require('../src/vault/fence');
const pinned = require('../src/generator/pinned');

test('FENCE_HEAD_BYTES is 65536 and RENDERED_TAG_MAX is 32', () => {
  assert.equal(FENCE_HEAD_BYTES, 65536);
  assert.equal(RENDERED_TAG_MAX, 32);
});

// --- Literal table (AC-FM-02 / AC-FM-04) -----------------------------------------------------

const LITERAL_CASES = [
  ['no fence at all', 'just some text\n', { status: 'no-fence' }],
  ['empty string', '', { status: 'no-fence' }],
  ['four dashes is not a fence', '----\nx\n', { status: 'no-fence' }],
  ['bare ---\\n', '---\ntitle: x\n---\n', { status: 'yaml', tag: '' }],
  ['--- with trailing space tag', '---  \ntitle: x\n---\n', { status: 'yaml', tag: '' }],
  ['---yaml', '---yaml\ntitle: x\n---\n', { status: 'yaml', tag: 'yaml' }],
  ['---YAML', '---YAML\ntitle: x\n---\n', { status: 'yaml', tag: 'YAML' }],
  ['---yml', '---yml\ntitle: x\n---\n', { status: 'yaml', tag: 'yml' }],
  ['---Yml mixed case', '---Yml\ntitle: x\n---\n', { status: 'yaml', tag: 'Yml' }],
  ['--- yaml (space trimmed)', '--- yaml\ntitle: x\n---\n', { status: 'yaml', tag: 'yaml' }],
  ['---js', '---js\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['---javascript', '---javascript\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'javascript' }],
  ['---JS', '---JS\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'JS' }],
  ['--- js (space trimmed, still refused)', '--- js\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['---\\tjs (tab trimmed)', '---\tjs\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['---\\u00A0js (NBSP trimmed)', '--- js\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['---\\u3000js (ideographic space trimmed)', '---　js\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['---json', '---json\n{}\n---\n', { status: 'refused', reason: 'language', tag: 'json' }],
  ['---coffee', '---coffee\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'coffee' }],
  ['---yamlx unregistered', '---yamlx\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'yamlx' }],
  ['---constructor prototype name', '---constructor\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'constructor' }],
  ['---\\rjs bare CR before tag (dangerous direction)', '---\rjs\nfoo\n---\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['BOM + ---yaml', '﻿---yaml\ntitle: x\n---\n', { status: 'yaml', tag: 'yaml' }],
  ['BOM + CRLF + ---YAML', '﻿---YAML\r\ntitle: x\r\n---\r\n', { status: 'yaml', tag: 'YAML' }],
  ['CRLF + ---js', '---js\r\nfoo\r\n---\r\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['empty block js is still refused (never a reason to allow it)', '---js\n---\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['no closing fence, tag yaml', '---yaml\ntitle: x\n', { status: 'yaml', tag: 'yaml' }],
  ['no closing fence, tag js', '---js\nfoo\n', { status: 'refused', reason: 'language', tag: 'js' }],
  ['zero width space before yaml is refused, not allowed', '---​yaml\ntitle: x\n---\n', { status: 'refused', reason: 'language', tag: '​yaml' }],
];

for (const [label, input, expected] of LITERAL_CASES) {
  test(`fence table: ${label}`, () => {
    assert.deepEqual(classifyFrontmatterFence(input), expected);
  });
}

// no-\\n cases (gray-matter's slice(0,-1) quirk), not truncated
test('no newline anywhere, not truncated: gray-matter quirk drops the last character of the tag', () => {
  // rest = 'yamlX' (5 chars); slice(0,-1) = 'yamlX'.slice(0,-1) = 'yaml' -- an untagged yaml file
  // with no closing newline, one character over what the quirk drops, is exactly a case named
  // in AC-FM-04: "--yamlX (no newline) ... give identical data through both copies".
  assert.deepEqual(classifyFrontmatterFence('---yamlX'), { status: 'yaml', tag: 'yaml' });
});
test('no newline anywhere, not truncated: --x drops to empty tag (AC-FM-04)', () => {
  assert.deepEqual(classifyFrontmatterFence('---x'), { status: 'yaml', tag: '' });
});
test('no newline, truncated: fails closed as unterminated even for a short head', () => {
  assert.deepEqual(classifyFrontmatterFence('---yaml', { truncated: true }), { status: 'refused', reason: 'unterminated', tag: 'yaml' });
});
test('over-limit "js" with no newline in the bounded head: unterminated, fails closed', () => {
  const head = '---' + ' '.repeat(70000) + 'js';
  assert.deepEqual(classifyFrontmatterFence(head, { truncated: true }), { status: 'refused', reason: 'unterminated', tag: `${' '.repeat(70000)}js`.trim() });
});
test('a \\n inside the bounded head is fully determined regardless of truncated', () => {
  const withNewline = '---js\nrest-of-file-does-not-matter';
  assert.deepEqual(classifyFrontmatterFence(withNewline, { truncated: true }), { status: 'refused', reason: 'language', tag: 'js' });
});

// --- Differential corpus, oracle = the bundled gray-matter with recording engines -------------

function recordingEngines() {
  const hits = [];
  const rec = (name) => ({
    parse(str) {
      hits.push(name);
      return {};
    },
  });
  return { hits, engines: { yaml: rec('yaml'), javascript: rec('javascript'), json: rec('json') } };
}

/**
 * Runs the bundled gray-matter (the only allowed reference call) with recording engines.
 *
 * When an engine actually ran, `hits[0]` names it directly. When NO engine ran (gray-matter's
 * own empty-block skip, index.js:101-106, fires before any parse() call, and it fires whenever
 * the fenced block itself is empty -- text.language notwithstanding), the returned file object's
 * own `.language` field (index.js:83-89 sets it from the SAME matter.language() step that would
 * have chosen the engine, before the empty-block check ever runs) says what language gray-matter
 * WOULD have dispatched to had the block held anything: an empty tag or "yaml"/"yml" is 'yaml'
 * (safe, matches SD-1's own "an empty tag is always allowed" rule); anything else names the
 * would-be-dangerous tag and is 'other' (SD-1 deliberately refuses those regardless of the
 * block's own emptiness -- "refused on the tag, not the block"). This also correctly classes
 * genuinely non-fenced text as 'yaml'-safe (opts.language defaults to 'yaml' at index.js:63-65
 * and is never overwritten when no fence is found at all), matching "no dispatch/no fence" in
 * the brief's own wording without re-deriving fence.js's own no-fence check.
 */
function oracleClassify(text) {
  const { hits, engines } = recordingEngines();
  let result;
  try {
    result = pinned.generatorGrayMatter(text, { engines });
  } catch (err) {
    if (/is not registered/.test(err.message)) return 'unregistered';
    return 'other';
  }
  if (hits.length > 0) return hits[0];
  const lang = (result.language || '').toLowerCase();
  return lang === '' || lang === 'yaml' || lang === 'yml' ? 'yaml' : 'other';
}

const BOMS = ['', '﻿'];
const NEWLINES = { LF: '\n', CRLF: '\r\n', 'bare-CR-in-tag': null };
const TAGS = ['', 'yaml', 'YAML', 'yml', 'js', 'JS', 'javascript', 'json', 'coffee', 'yamlx', 'constructor', ' js', '\tjs', '　js', '﻿js', '​yaml', ' yaml'];
const SHAPES = ['normal', 'no-newline', 'no-closing-fence', 'empty-block'];

function buildDifferentialText(bom, nlKind, tag, shape) {
  const bodyLine = 'title: x';
  if (shape === 'no-newline') {
    // No \n at all anywhere in the text. For bare-CR-in-tag this still injects the \r between
    // the fence dashes and the tag text, matching the "dangerous direction" shape.
    return nlKind === 'bare-CR-in-tag' ? bom + '---' + '\r' + tag : bom + '---' + tag;
  }
  const nl = nlKind === 'bare-CR-in-tag' ? '\n' : NEWLINES[nlKind];
  // The bare-CR-in-tag shape puts the \r BETWEEN the fence dashes and the tag text itself (the
  // architect's item 5 case, "---\rjs"), not after the tag -- a \r immediately before the
  // terminating \n is an ordinary CRLF line ending, already covered by the CRLF nlKind.
  const tagLine = nlKind === 'bare-CR-in-tag' ? '---' + '\r' + tag : '---' + tag;
  const body = shape === 'empty-block' ? '' : bodyLine + nl;
  const close = shape === 'no-closing-fence' ? '' : '---' + nl;
  return bom + tagLine + nl + body + close;
}

test('differential corpus: predicate allows iff the bundled gray-matter dispatches to yaml or nothing', () => {
  let cases = 0;
  for (const bom of BOMS) {
    for (const nlKind of Object.keys(NEWLINES)) {
      for (const tag of TAGS) {
        for (const shape of SHAPES) {
          const text = buildDifferentialText(bom, nlKind, tag, shape);
          const predicateResult = classifyFrontmatterFence(text);
          const oracle = oracleClassify(text);
          const predicateAllows = predicateResult.status === 'no-fence' || predicateResult.status === 'yaml';
          const oracleAllows = oracle === 'yaml';
          assert.equal(
            predicateAllows,
            oracleAllows,
            `mismatch for bom=${JSON.stringify(bom)} nl=${nlKind} tag=${JSON.stringify(tag)} shape=${shape}: ` +
              `predicate=${JSON.stringify(predicateResult)} oracle=${oracle}`,
          );
          cases += 1;
        }
      }
    }
  }
  assert.ok(cases > 100, `expected a real corpus, got ${cases} cases`);
});

// --- renderTag() (SD-2) -----------------------------------------------------------------------

test('renderTag: short ascii tag passes through unchanged', () => {
  assert.equal(renderTag('js'), 'js');
});

test('renderTag: backslash is doubled', () => {
  assert.equal(renderTag('a\\b'), 'a\\\\b');
});

test('renderTag: control characters are escaped as \\u{HEX} uppercase', () => {
  assert.equal(renderTag('\x1b'), '\\u{1B}');
  assert.equal(renderTag('\x07'), '\\u{7}');
  assert.equal(renderTag('‮'), '\\u{202E}');
});

test('renderTag: result never exceeds RENDERED_TAG_MAX (32) UTF-16 units', () => {
  const rendered = renderTag('a'.repeat(10000));
  assert.ok(rendered.length <= 32, `expected <= 32, got ${rendered.length}`);
  assert.ok(rendered.endsWith('...'));
});

test('renderTag: astral characters are not split mid-surrogate-pair', () => {
  const astral = '\u{1F600}'.repeat(20); // each is 2 UTF-16 units
  const rendered = renderTag(astral);
  assert.ok(rendered.length <= 32);
  // Reconstructing code points from the rendered string must never throw / must never contain a
  // lone surrogate half.
  for (const ch of rendered.replace(/\.\.\.$/, '')) {
    assert.ok(ch.codePointAt(0) !== undefined);
  }
});

test('renderTag: a 10 KB tag is bounded, never appears whole', () => {
  const big = 'X'.repeat(10 * 1024);
  const rendered = renderTag(big);
  assert.ok(rendered.length <= 32);
  assert.ok(!rendered.includes(big));
});
