'use strict';

const fs = require('fs');
const path = require('path');
const { collectRecaps } = require('../build/recaps');
const { TIMELINE_MARKER } = require('../build/timeline');
const { CONNECTIONS_MARKER } = require('../build/connections');
const htmltext = require('../build/htmltext');

/*
 * V1e-3 (SD-18, FR-16, ADR 0035 SS5): which pages the Overview pane offers, resolved from the
 * BUILT TREE ONLY -- never from anything the panel remembers about the vault. Every returned
 * `rel` is a member of this module's own directory walk, so it can never be `..`, never
 * absolute, and never a symlink: there is no separate validation step to forget, because the
 * value never came from anywhere else.
 *
 * The walk mirrors gmlink.js's own pattern exactly (readdirSync withFileTypes, recursing only
 * into isDirectory() entries): a symlinked entry is neither isDirectory() nor isFile() as
 * fs.Dirent reports it, so a symlinked directory is never descended into and a symlinked file is
 * never listed, with no separate check required.
 */

const ROLE_IDS = Object.freeze(['landing', 'recap', 'character', 'timeline', 'notfound']);

// A local copy of recaps.js:18's own PAGE_TITLE_RE (this module must not import recaps.js's
// unexported internals): the page's own <h1 class="page-title"> text.
const PAGE_TITLE_RE = /<h1 class="page-title">([\s\S]*?)<\/h1>/;

const MAX_SEARCH_INDEX_BYTES = 32 * 1024 * 1024;

/**
 * @param {string} siteDir
 * @returns {{ htmlByPath: Record<string, string>, files: Set<string> }} htmlByPath is posix-rel
 *   path -> full HTML text, for every regular *.html file this walk could read. files is every
 *   regular file's posix-rel path, of any extension.
 */
function walkTree(siteDir) {
  const htmlByPath = {};
  const files = new Set();

  (function walk(dir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks: never followed, never listed
      files.add(rel);
      if (entry.name.endsWith('.html')) {
        try {
          htmlByPath[rel] = fs.readFileSync(abs, 'utf8');
        } catch {
          // unreadable: still counted in `files` for membership, just never in htmlByPath.
        }
      }
    }
  })(siteDir, '');

  return { htmlByPath, files };
}

function resolveLandingRole(files) {
  return files.has('index.html') ? { role: 'landing', rel: 'index.html', title: 'Landing page' } : null;
}

function resolveRecapRole(htmlByPath) {
  const bySession = collectRecaps(htmlByPath);
  let best = null;
  for (const entry of bySession.values()) {
    if (!best || entry.n > best.n) best = entry;
  }
  if (!best) return null;
  return { role: 'recap', rel: best.outputPath, title: best.title || 'Latest recap' };
}

function resolveTimelineRole(files, htmlByPath) {
  const marked = Object.keys(htmlByPath)
    .filter((rel) => htmlByPath[rel].includes(TIMELINE_MARKER))
    .sort(htmltext.cmpCodeUnit);

  let rel = marked.length > 0 ? marked[0] : null;
  if (!rel && files.has('timeline.html')) rel = 'timeline.html';
  if (!rel) return null;

  const html = htmlByPath[rel];
  let title = 'Timeline';
  if (html) {
    const m = html.match(PAGE_TITLE_RE);
    const text = m ? htmltext.textOf(m[1]) : '';
    if (text) title = text;
  }
  return { role: 'timeline', rel, title };
}

function readSearchIndexDocuments(siteDir, files) {
  if (!files.has('search-index.json')) return null;
  const abs = path.join(siteDir, 'search-index.json');
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_SEARCH_INDEX_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const documents = parsed.documents;
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return null;
  return documents;
}

/** Candidates of `type`, sorted by href, keeping only hrefs that are EXACT members of htmlByPath. */
function candidatesOfType(documents, htmlByPath, type) {
  return Object.keys(documents)
    .filter((ref) => documents[ref] && documents[ref].type === type)
    .map((ref) => ({ ref, href: documents[ref].href }))
    .filter((c) => typeof c.href === 'string' && Object.prototype.hasOwnProperty.call(htmlByPath, c.href))
    .sort((a, b) => htmltext.cmpCodeUnit(a.href, b.href));
}

function characterTitle(doc, html) {
  if (typeof doc.title === 'string') return doc.title;
  const m = html.match(PAGE_TITLE_RE);
  const text = m ? htmltext.textOf(m[1]) : '';
  return text || 'A character';
}

function resolveCharacterRole(siteDir, files, htmlByPath) {
  const documents = readSearchIndexDocuments(siteDir, files);
  if (!documents) return null;

  const candidates = candidatesOfType(documents, htmlByPath, 'npc').concat(candidatesOfType(documents, htmlByPath, 'pc'));
  if (candidates.length === 0) return null;

  const withMarker = candidates.find((c) => htmlByPath[c.href].includes(CONNECTIONS_MARKER));
  const picked = withMarker || candidates[0];
  const doc = documents[picked.ref];

  return { role: 'character', rel: picked.href, title: characterTitle(doc, htmlByPath[picked.href]) };
}

function resolveNotfoundRole(files) {
  return files.has('404.html') ? { role: 'notfound', rel: '404.html', title: 'Not-found page' } : null;
}

/**
 * @param {string} siteDir the built preview (or theme variant) tree's root
 * @returns {Array<{ role: string, rel: string, title: string }>} in ROLE_IDS order, absent roles
 *   omitted
 */
function resolvePageRoles(siteDir) {
  const { htmlByPath, files } = walkTree(siteDir);

  const byRole = {
    landing: resolveLandingRole(files),
    recap: resolveRecapRole(htmlByPath),
    character: resolveCharacterRole(siteDir, files, htmlByPath),
    timeline: resolveTimelineRole(files, htmlByPath),
    notfound: resolveNotfoundRole(files),
  };

  return ROLE_IDS.filter((role) => byRole[role] !== null).map((role) => byRole[role]);
}

module.exports = { ROLE_IDS, resolvePageRoles };
