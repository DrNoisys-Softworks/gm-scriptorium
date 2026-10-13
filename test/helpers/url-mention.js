'use strict';

/*
 * Does a piece of text name a given URL? Parsed comparison, not a substring check: every
 * http(s) token in the text is run through new URL() and compared to the wanted URL on protocol,
 * host and pathname exactly. A lookalike host (github.com.evil.example) or a wanted URL buried
 * inside another URL's path or query does not count.
 */
function urlsIn(text) {
  const out = [];
  for (const raw of String(text).match(/https?:\/\/[^\s'"<>)]+/g) || []) {
    const token = raw.replace(/[.,;:!?]+$/, '');
    try { out.push(new URL(token)); } catch (_) { /* not a URL */ }
  }
  return out;
}

function mentionsUrl(text, wanted) {
  const w = new URL(wanted);
  return urlsIn(text).some((u) => u.protocol === w.protocol && u.host === w.host && u.pathname === w.pathname);
}

module.exports = { urlsIn, mentionsUrl };
