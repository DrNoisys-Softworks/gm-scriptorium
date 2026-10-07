'use strict';

// A CSS url() resolver, used by test/example-build.test.js (E6) to prove every url() in a built
// site resolves. A helper, not a test: named *.js, not *.test.js, so npm test's test/**/*.test.js
// glob never runs it directly (precedent: test/fm-harness.js). Its own control suite is
// test/css-urls.test.js.

const fs = require('fs');
const path = require('path');

const COMMENT_RE = /\/\*[\s\S]*?\*\//g;

/**
 * `url()` payloads in source order, comments stripped first, quotes removed. A quoted value is
 * read up to its own matching closing quote, so a quoted data: URI that itself contains the
 * literal text "url(...)" (assets/site/scriptorium.css:792) is returned whole, never split by a
 * naive non-greedy scan of the first ')'.
 * @param {string} cssText
 * @returns {string[]}
 */
function cssUrls(cssText) {
  const text = String(cssText).replace(COMMENT_RE, '');
  const out = [];
  const openRe = /url\(/gi;
  let m;
  while ((m = openRe.exec(text))) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;

    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let buf = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) {
          buf += text[i + 1];
          i += 2;
          continue;
        }
        buf += text[i];
        i += 1;
      }
      out.push(buf);
      openRe.lastIndex = i + 1; // past the closing quote; the ')' that follows is skipped naturally.
    } else {
      let buf = '';
      while (i < text.length && text[i] !== ')') {
        if (text[i] === '\\' && i + 1 < text.length) {
          buf += text[i + 1];
          i += 2;
          continue;
        }
        buf += text[i];
        i += 1;
      }
      out.push(buf.trim());
      openRe.lastIndex = i + 1;
    }
  }
  return out;
}

/**
 * @param {string} u a payload from cssUrls()
 * @returns {'data'|'fragment'|'absolute'|'relative'}
 */
function classifyUrl(u) {
  const s = String(u);
  if (s.startsWith('data:')) return 'data';
  if (s.startsWith('http:') || s.startsWith('https:') || s.startsWith('//')) return 'absolute';
  if (s.startsWith('#')) return 'fragment';
  return 'relative';
}

function walkCssFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && p.toLowerCase().endsWith('.css')) out.push(p);
    }
  }
  walk(root);
  return out;
}

function importTarget(statement) {
  const m = /@import\s+(?:url\(\s*)?["']?([^"')]+)["']?\)?/i.exec(statement);
  return m ? m[1].trim() : statement.trim();
}

/**
 * Walks every `.css` file under `siteRoot` and reports every `url()`/`@import` that doesn't
 * resolve. A relative URL resolves from its own CSS file's directory (never the site root),
 * after its `?...` and `#...` suffixes are stripped and the remainder is percent-decoded.
 * @param {string} siteRoot
 * @returns {{file: string, url: string, reason: 'missing'|'absolute'|'escapes-site'|'import'}[]}
 */
function unresolvedCssUrls(siteRoot) {
  const root = path.resolve(siteRoot);
  const results = [];

  for (const file of walkCssFiles(root)) {
    const relFile = path.relative(root, file);
    const raw = fs.readFileSync(file, 'utf8');
    const noComments = raw.replace(COMMENT_RE, '');

    const importRe = /@import\b[^;]*;/gi;
    let im;
    while ((im = importRe.exec(noComments))) {
      results.push({ file: relFile, url: importTarget(im[0]), reason: 'import' });
    }
    // A url() inside an @import statement (the `@import url(...)` form) is already covered by
    // the 'import' reason above; strip those statements before the general url() scan below so
    // it isn't reported a second time under 'missing'/'absolute'/'escapes-site'.
    const withoutImports = noComments.replace(importRe, '');

    for (const u of cssUrls(withoutImports)) {
      const kind = classifyUrl(u);
      if (kind === 'data' || kind === 'fragment') continue;
      if (kind === 'absolute') {
        results.push({ file: relFile, url: u, reason: 'absolute' });
        continue;
      }

      const withoutHash = u.split('#')[0];
      const withoutQuery = withoutHash.split('?')[0];
      let decoded;
      try {
        decoded = decodeURIComponent(withoutQuery);
      } catch {
        decoded = withoutQuery;
      }

      const resolved = path.resolve(path.dirname(file), decoded);
      const relFromRoot = path.relative(root, resolved);
      const escapes = relFromRoot === '..' || relFromRoot.startsWith('..' + path.sep) || path.isAbsolute(relFromRoot);
      if (escapes) {
        results.push({ file: relFile, url: u, reason: 'escapes-site' });
        continue;
      }
      if (!fs.existsSync(resolved)) {
        results.push({ file: relFile, url: u, reason: 'missing' });
      }
    }
  }

  results.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    return 0;
  });
  return results;
}

module.exports = { cssUrls, classifyUrl, unresolvedCssUrls };
