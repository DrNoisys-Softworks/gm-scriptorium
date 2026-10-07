'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractWikiLinks } = require('../src/vault/links');

/*
 * #77's leak-check guardrail (leak/l3-unpublished-link, src/checks/leak/l3.js)
 * must NOT lose coverage: it calls extractWikiLinks(markdown) with no second
 * argument, exactly as it did before this fix. This file is a golden-master
 * check for that call shape specifically: a self-contained reimplementation
 * of the PRE-#77 extractWikiLinks (the version l3.js always ran against,
 * copied verbatim rather than derived from src/vault/links.js) is compared
 * against the current extractWikiLinks() called with no options, across a
 * range of inputs including ones #77 changes the *opted-in* behaviour for.
 * A regression that let ignoreCode-style masking leak into the no-args path
 * would show up here as a mismatch, independent of anything in
 * src/vault/links.js itself.
 */

// Verbatim copy of extractWikiLinks as it existed immediately before #77
// (git blame src/vault/links.js at d2938a7, this worktree's base commit).
function goldenExtractWikiLinks(markdown) {
  const WIKI_LINK_RE = /(!?)\[\[([^\]]+)\]\]/g;
  function parseInner(inner) {
    let rest = inner;
    let alias = null;
    const pipeIdx = rest.indexOf('|');
    if (pipeIdx !== -1) {
      alias = rest.slice(pipeIdx + 1).trim();
      rest = rest.slice(0, pipeIdx);
    }
    let heading = null;
    const hashIdx = rest.indexOf('#');
    if (hashIdx !== -1) {
      heading = rest.slice(hashIdx + 1).trim();
      rest = rest.slice(0, hashIdx);
    }
    return { target: rest.trim(), alias, heading };
  }
  const lines = markdown.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    WIKI_LINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKI_LINK_RE.exec(line))) {
      const isEmbed = m[1] === '!';
      const { target, alias, heading } = parseInner(m[2]);
      results.push({ raw: m[0], target, alias, heading, isEmbed, line: i + 1 });
    }
  }
  return results;
}

const SAMPLES = [
  'plain prose, no links at all',
  'See [[Alice]] and [[Cal|the Bandit]].',
  'A code span the leak scan must still catch: `[[Withheld_Name]]`',
  'Fenced doc, also must still be caught:\n```\n[[Withheld_Name]]\n```',
  '~~~\n[[Withheld_Name]]\n~~~',
  'Embed: ![[portrait.png]]',
  '[[Target#Heading|Alias]] with heading and alias',
  'Unterminated ` backtick then [[Missing]].',
  '``double `` then [[Missing]].',
  'multi\nline\n[[Cross_Line]]\nsource',
];

test('extractWikiLinks with no options matches the pre-#77 implementation, sample by sample', () => {
  for (const sample of SAMPLES) {
    assert.deepEqual(extractWikiLinks(sample), goldenExtractWikiLinks(sample), `mismatch for: ${JSON.stringify(sample)}`);
  }
});

test('extractWikiLinks with { ignoreCode: false } explicitly also matches the pre-#77 implementation', () => {
  for (const sample of SAMPLES) {
    assert.deepEqual(
      extractWikiLinks(sample, { ignoreCode: false }),
      goldenExtractWikiLinks(sample),
      `mismatch for: ${JSON.stringify(sample)}`,
    );
  }
});
