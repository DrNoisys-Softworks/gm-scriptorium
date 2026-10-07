'use strict';

/*
 * ADR 0036 (docs/agent-runs/r2-session-wrap-architect-2026-09-30.md, SD-1): the build-side half of
 * session pairing. Reads the pairing the generator ACTUALLY made in this build, straight off the
 * raw staged output, before any Scriptorium transform touches a page -- so FR-02 (build-side
 * pairing equals what the generator did) holds by construction, and vault text can never forge it
 * (bodies render with `html: false`, lib/markdown.js:74).
 *
 * `compareSessionPairs` is the runtime half of the equality proof (SD-1's proof (e)): every real
 * build recomputes the check-side pairing too (src/vault/sessionpairs.js) and compares it against
 * what was just read here, so a divergence between the two note sources is named, not silent.
 */

const fs = require('fs');
const path = require('path');
const htmltext = require('./htmltext');

const SESSION_RECAP_MARKER = 'class="recap session-recap"';

// lib/templates/session.js:36's own literal open tag (the change detector in
// test/session-pairing.test.js pins this against the installed pin).
const OPEN_DIV_RE = /<div class="recap session-recap">/;
// lib/templates/session.js:34's own literal recap-link anchor.
const RECAP_LINK_RE = /<a class="recap-link" href="([^"]*)">/;

/**
 * Reads the staged (about-to-swap) output tree and finds every hub page the pin itself withheld
 * and replaced with a Wrap-Up recap (`<div class="recap session-recap">`, lib/templates/
 * session.js:36), then resolves that block's own `<a class="recap-link">` (`:34`) to the
 * Wrap-Up's own output-relative path. A hub page carrying the marker but no resolvable,
 * existing link goes to `unreadable` instead of `wrapUpByHub` -- this can only happen if the pin's
 * own markup changes shape underneath this reader (a change detector pins the two literals).
 *
 * @param {string} stagingOut absolute path to the staged output tree
 * @returns {{ wrapUpByHub: Map<string, string>, unreadable: string[] }} posix, sorted
 */
function captureWithheldHubs(stagingOut) {
  const found = [];
  const unreadable = [];

  (function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, entryRel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(full, 'utf8');
      if (!html.includes(SESSION_RECAP_MARKER)) continue;

      const openMatch = html.match(OPEN_DIV_RE);
      if (!openMatch) {
        unreadable.push(entryRel);
        continue;
      }
      const divEnd = htmltext.sliceBalanced(html, openMatch.index, 'div');
      const block = divEnd === -1 ? html.slice(openMatch.index) : html.slice(openMatch.index, divEnd);
      const linkMatch = block.match(RECAP_LINK_RE);
      if (!linkMatch) {
        unreadable.push(entryRel);
        continue;
      }
      const resolved = htmltext.resolveHref(entryRel, linkMatch[1]);
      if (!resolved || !fs.existsSync(path.join(stagingOut, resolved))) {
        unreadable.push(entryRel);
        continue;
      }
      found.push([entryRel, resolved]);
    }
  })(stagingOut, '');

  found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  unreadable.sort();
  return { wrapUpByHub: new Map(found), unreadable };
}

/**
 * SD-1's proof (e): compares what the build just read off its own pages (`wrapUpByHub`, keyed by
 * hub output path) against the check-side pairing recomputed through the pin's own `pairHubs`
 * (`pairing.pairs`, filtered to published hubs). Pure -- no filesystem access. Only disagreements
 * are returned (site !== check for that hub); an empty array means the two sides agree on every
 * hub either side named.
 *
 * @param {Map<string,string>} wrapUpByHub
 * @param {object} pairing sessionpairs.computeSessionPairing's result
 * @returns {{ hub: string, site: string|null, check: string|null }[]} sorted by hub
 */
function compareSessionPairs(wrapUpByHub, pairing) {
  const checkByHub = new Map();
  for (const pair of pairing.pairs) {
    if (pair.hub.published && pair.hub.outputPath) checkByHub.set(pair.hub.outputPath, pair.wrapUp.outputPath);
  }

  const hubs = new Set([...wrapUpByHub.keys(), ...checkByHub.keys()]);
  const out = [];
  for (const hub of hubs) {
    const site = wrapUpByHub.has(hub) ? wrapUpByHub.get(hub) : null;
    const check = checkByHub.has(hub) ? checkByHub.get(hub) : null;
    if (site !== check) out.push({ hub, site, check });
  }
  out.sort((a, b) => (a.hub < b.hub ? -1 : a.hub > b.hub ? 1 : 0));
  return out;
}

module.exports = { SESSION_RECAP_MARKER, captureWithheldHubs, compareSessionPairs };
