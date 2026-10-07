'use strict';

// Issue #46: assets/site/scriptorium.css:759 read `--sc-space-*/--sc-step-*` inside a
// prose comment. The literal `*/` there closed the comment mid-sentence; a browser's error
// recovery then threw away everything up to the next rule boundary, which ate the
// `:root { --sc-grain; --sc-lip; --sc-floor }` block that followed and silenced every rule
// depending on those custom properties (the Vellum lip never rendered on any .hero-banner).
//
// The existing Vellum tests (e.g. test/theme-haze.test.js's H8) read the source text and see
// the rule sitting right there in the file, so they pass regardless of whether a browser can
// actually reach it. Nothing in the suite tokenized the CSS the way a parser does. This test
// does that: a small hand-rolled single-pass tokenizer (postcss is not a devDependency here --
// checked via `require.resolve('postcss')`, which throws -- so no parser is available without
// adding a new runtime/dev dependency, which CLAUDE.md gates explicitly) that mirrors real CSS
// comment semantics: a comment opens at `/*` and closes at the very NEXT `*/`, no nesting.
//
// Two signatures it flags, both requested by the issue:
//   - "orphan-close": a `*/` encountered outside any comment and outside any quoted string.
//     This can never appear in valid CSS on its own -- it is the direct fingerprint of a
//     comment that closed early, leaving its own tail prose (which often itself contains a
//     `*/`, as line 760's banner rule did here) sitting in code context.
//   - "nested-open": a `/*` encountered while already inside a comment. Harmless to a real
//     CSS parser (comments do not nest, so this text is inert), but it is exactly the kind of
//     authoring mistake that produces an orphan-close one token later, and the issue asks for
//     it to be flagged too.
//
// What this test does NOT catch (residual, stated up front per CLAUDE.md's testing standards):
// a comment that closes early but whose swallowed tail happens to contain neither `/*` nor `*/`
// itself, and where no other `*/`-shaped token ever turns up before the next legitimate comment
// or end of file. That shape produces no orphan/nested signature for this tokenizer to catch --
// only a real CSS parser (rejecting the resulting invalid top-level tokens, e.g. postcss) or a
// rendered-computed-style assertion (e.g. `--sc-lip` non-empty, which the issue's own evidence
// used) would catch it. This repo's CSS is hand-authored prose-in-comments, not machine
// generated, so that gap is judged acceptable for a guard rather than a full parser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { FIRST_PARTY_SITE_ASSETS } = require('../scripts/pkg-assets');

const ROOT = path.join(__dirname, '..');

// Reuses the same hand-maintained manifest scripts/pkg-assets.js and npm run package both trust
// (test/package-config.test.js's own change-detector keeps it honest against assets/site/ and
// assets/themes/ on disk), rather than re-deriving a glob here -- a second, independent glob
// walking the same directories would just be another copy of the thing under test.
const SHIPPED_CSS_ASSETS = FIRST_PARTY_SITE_ASSETS.filter((rel) => rel.endsWith('.css'));

/**
 * Tokenizes `text` the way a real CSS parser does for comments: a comment opens at the first
 * `/*` outside a string and closes at the very NEXT `*\/`, full stop, no nesting. Quoted
 * strings (single or double, with backslash escapes) are tracked so a `*\/`-shaped substring
 * inside e.g. a data-URI `url("...")` is never mistaken for a comment token.
 *
 * @param {string} text
 * @returns {{type: 'orphan-close'|'nested-open'|'unterminated-comment', line: number, col: number}[]}
 */
function findCssCommentIntegrityIssues(text) {
  const findings = [];
  let state = 'code'; // 'code' | 'comment' | 'string'
  let stringChar = null;
  let commentStart = null;
  let line = 1;
  let col = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }

    if (state === 'string') {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === stringChar) {
        state = 'code';
        stringChar = null;
      }
      continue;
    }

    if (state === 'comment') {
      if (c === '/' && text[i + 1] === '*') {
        findings.push({ type: 'nested-open', line, col });
      }
      if (c === '*' && text[i + 1] === '/') {
        state = 'code';
        i++;
        col++;
        commentStart = null;
      }
      continue;
    }

    // state === 'code'
    if (c === '"' || c === "'") {
      state = 'string';
      stringChar = c;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      state = 'comment';
      commentStart = { line, col };
      i++;
      col++;
      continue;
    }
    if (c === '*' && text[i + 1] === '/') {
      findings.push({ type: 'orphan-close', line, col });
      i++;
      col++;
      continue;
    }
  }

  if (state === 'comment') {
    findings.push({ type: 'unterminated-comment', line: commentStart.line, col: commentStart.col });
  }

  return findings;
}

test('SHIPPED_CSS_ASSETS is non-empty (change detector: a rename that empties this would pass vacuously below)', () => {
  assert.ok(SHIPPED_CSS_ASSETS.length >= 2, `expected at least assets/site + assets/themes css, got ${SHIPPED_CSS_ASSETS.length}`);
});

for (const rel of SHIPPED_CSS_ASSETS) {
  test(`${rel}: no orphan */ and no nested /* inside any comment`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const findings = findCssCommentIntegrityIssues(text);
    assert.deepEqual(
      findings,
      [],
      `${rel} has ${findings.length} comment-integrity finding(s): ${JSON.stringify(findings)}`,
    );
  });
}

test('tokenizer sanity: flags an orphan close (regression fixture matching issue #46\'s exact shape)', () => {
  const fixture = '/* start of comment, --sc-space-*/--sc-step-* looked like prose but is not */\n:root { --x: 1; }\n';
  const findings = findCssCommentIntegrityIssues(fixture);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'orphan-close');
});

test('tokenizer sanity: flags a nested /* inside an otherwise well-formed comment', () => {
  const fixture = '/* see css/themes/*.css for the others */\n.a { color: red; }\n';
  const findings = findCssCommentIntegrityIssues(fixture);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'nested-open');
});

test('tokenizer sanity: a */-shaped substring inside a quoted string is not flagged', () => {
  const fixture = '.a { content: "*/"; background: url("data:image/svg+xml,%3Csvg/%3E"); }\n';
  const findings = findCssCommentIntegrityIssues(fixture);
  assert.deepEqual(findings, []);
});

test('tokenizer sanity: a well-formed multi-line comment with no embedded */ or /* is clean', () => {
  const fixture = '/*\n * line one\n * line two, still fine\n */\n.a { color: red; }\n';
  const findings = findCssCommentIntegrityIssues(fixture);
  assert.deepEqual(findings, []);
});
