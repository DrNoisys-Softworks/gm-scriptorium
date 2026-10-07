'use strict';

const htmltext = require('./htmltext');
const { DEFAULT_VOCAB } = require('./labels');

/*
 * Engineering Brief: "Story timeline + Connections lane" (docs/agent-runs/
 * timeline-connections-engineering-brief-2026-09-24.md), "Interfaces and contracts: recaps.js".
 *
 * Recap facts shared by timeline.js (session numeral/title/date, and learned-item lead/body for
 * anchor matching) and connections.js (which recaps link to which page, for the hub numerals and
 * the shared-recap score term). Reads whole-tree HTML the caller already collected; touches no
 * filesystem itself.
 */

const SESSION_NUMBER_RE = /data-field="session_number">(\d+)</;
const PLAY_DATE_RE = /data-field="play_date">([\s\S]*?)<\/span>/;
const PAGE_TITLE_RE = /<h1 class="page-title">([\s\S]*?)<\/h1>/;

/**
 * Returns the text of every top-level `<li ...>...</li>` inside `html` (balanced on nested
 * `<li>`, so a rare nested list does not fracture the split).
 *
 * @param {string} html
 * @returns {string[]}
 */
function topLevelListItems(html) {
  const tokenRe = /<li\b[^>]*>|<\/li>/g;
  let depth = 0;
  let start = -1;
  const items = [];
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[0] === '</li>') {
      depth--;
      if (depth === 0 && start !== -1) {
        items.push(html.slice(start, m.index));
        start = -1;
      }
    } else {
      if (depth === 0) start = m.index + m[0].length;
      depth++;
    }
  }
  return items;
}

/**
 * @param {string} regionHtml a proseRegion() result
 * @param {string} fromOutputPath
 * @returns {Set<string>}
 */
function extractResolvedHrefs(regionHtml, fromOutputPath) {
  const out = new Set();
  const re = /<a\s+[^>]*href="([^"]*)"/g;
  let m;
  while ((m = re.exec(regionHtml))) {
    const resolved = htmltext.resolveHref(fromOutputPath, m[1]);
    if (resolved) out.add(resolved);
  }
  return out;
}

/**
 * Parses one recap page's "What the Party Learned" list into `{key, title, body}` items.
 *
 * @param {string} html
 * @param {string} outputPath for warning messages
 * @param {string[]} warnings pushed to in place
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {{key: string, title: string, body: string}[]}
 */
function parseLearned(html, outputPath, warnings, vocab = DEFAULT_VOCAB) {
  const out = [];
  // Every <h2>...</h2> pair, matched individually (H2_RE alone, no nesting) so an earlier,
  // unrelated heading not immediately followed by <ul> can never make the lazy match skip past
  // it and swallow everything up to the real "What the Party Learned" <ul> as if it were that
  // earlier heading's own text.
  const H2_RE = /<h2>([\s\S]*?)<\/h2>/g;
  H2_RE.lastIndex = 0;
  const learnedHeading = vocab.learnedHeading.toLowerCase();
  let hm;
  while ((hm = H2_RE.exec(html))) {
    if (htmltext.textOf(hm[1]).toLowerCase() !== learnedHeading) continue;
    const afterH2 = hm.index + hm[0].length;
    const ulMatch = html.slice(afterH2).match(/^\s*<ul>/);
    if (!ulMatch) continue;
    const ulOpenIdx = afterH2 + ulMatch[0].length - '<ul>'.length;
    const endIdx = htmltext.sliceBalanced(html, ulOpenIdx, 'ul');
    if (endIdx === -1) continue;
    const inner = html.slice(ulOpenIdx + '<ul>'.length, endIdx - '</ul>'.length);
    for (const li of topLevelListItems(inner)) {
      const leadMatch = li.match(/^\s*<strong>([\s\S]*?)<\/strong>/);
      let leadHtml;
      let restHtml;
      if (leadMatch) {
        leadHtml = leadMatch[1];
        restHtml = li.slice(leadMatch[0].length);
      } else {
        leadHtml = li;
        restHtml = '';
        warnings.push(`recaps: ${outputPath}: a "What the Party Learned" item has no leading <strong>; using the whole item as the lead`);
      }
      const key = htmltext.foldKey(leadHtml);
      const title = htmltext.textOf(leadHtml).replace(/[.:]\s*$/, '');
      const body = htmltext.textOf(restHtml).replace(/^[\s—–:.\-]+/, '');
      out.push({ key, title, body });
    }
  }
  return out;
}

/**
 * Collects every recap in `htmlByPath` into a Map keyed by session number. Extra property
 * `.warnings` (human-readable strings) is attached to the returned Map.
 *
 * ADR 0036: for a hub whose `outputPath` is a key of `wrapUpByHub`, AND whose named Wrap-Up page
 * is present in `htmlByPath`, the recap's `title`/`learned`/`links` and `outputPath` all come from
 * the Wrap-Up's own built page instead of the hub's -- `n` and `date` still come from the hub
 * (its badges carry those, unaffected by pairing). The hub's own teaser and `recap-link`
 * contribute nothing once a Wrap-Up sources the recap.
 *
 * @param {Object<string, string>} htmlByPath outputPath -> full page HTML
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @param {Map<string,string>} [wrapUpByHub] hub outputPath -> paired Wrap-Up outputPath (src/build/sessionmodel.js)
 * @returns {Map<number, {outputPath: string, n: number, num: string, title: string, date: string, learned: {key: string, title: string, body: string}[], links: Set<string>}>}
 */
function collectRecaps(htmlByPath, vocab = DEFAULT_VOCAB, wrapUpByHub = new Map()) {
  const warnings = [];
  const bySession = new Map();
  const sortedPaths = Object.keys(htmlByPath).sort(htmltext.cmpCodeUnit);

  for (const outputPath of sortedPaths) {
    const html = htmlByPath[outputPath];
    const sm = html.match(SESSION_NUMBER_RE);
    if (!sm) continue;
    const n = parseInt(sm[1], 10);
    if (bySession.has(n)) {
      warnings.push(`recaps: duplicate session_number ${n} at ${outputPath}; keeping ${bySession.get(n).outputPath}`);
      continue;
    }

    const dateMatch = html.match(PLAY_DATE_RE);
    const date = dateMatch ? htmltext.textOf(dateMatch[1]) : '';

    const wrapUpPath = wrapUpByHub.get(outputPath);
    const wrapUpHtml = wrapUpPath !== undefined ? htmlByPath[wrapUpPath] : undefined;

    let recapOutputPath = outputPath;
    let title;
    let learned;
    let links;
    if (wrapUpHtml !== undefined) {
      recapOutputPath = wrapUpPath;
      const wrapUpTitleMatch = wrapUpHtml.match(PAGE_TITLE_RE);
      title = wrapUpTitleMatch ? htmltext.textOf(wrapUpTitleMatch[1]) : '';
      learned = parseLearned(wrapUpHtml, wrapUpPath, warnings, vocab);
      links = extractResolvedHrefs(htmltext.proseRegion(wrapUpHtml), wrapUpPath);
    } else {
      const titleMatch = html.match(PAGE_TITLE_RE);
      title = titleMatch ? htmltext.textOf(titleMatch[1]) : '';
      learned = parseLearned(html, outputPath, warnings, vocab);
      links = extractResolvedHrefs(htmltext.proseRegion(html), outputPath);
    }

    bySession.set(n, { outputPath: recapOutputPath, n, num: htmltext.toRoman(n), title, date, learned, links });
  }

  bySession.warnings = warnings;
  return bySession;
}

module.exports = { collectRecaps, topLevelListItems, parseLearned };
