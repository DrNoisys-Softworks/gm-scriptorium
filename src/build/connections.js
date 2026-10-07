'use strict';

const fs = require('fs');
const path = require('path');
const htmltext = require('./htmltext');
const pinned = require('../generator/pinned');
const { collectRecaps, topLevelListItems } = require('./recaps');
const { linkSiteScript, writeSiteScript, serializeDataIsland } = require('./sitescript');
const { computePublishedSet } = require('../vault/publishset');
const { DEFAULT_VOCAB } = require('./labels');

/*
 * Engineering Brief: "Story timeline + Connections lane" (docs/agent-runs/
 * timeline-connections-engineering-brief-2026-09-24.md), "Interfaces and contracts: connections.js".
 *
 * Replaces the pin's relationship-graph SVG, in place, on every page that carries one, with a
 * ranked, grouped lane built ONLY from the pin's own hop-1 set for that page (parsed from the SVG
 * itself, not re-derived -- Structural decision 3). Collect-then-write (FR-C8): the whole tree is
 * read into memory and every page's model computed before any page is rewritten, so a lane can
 * never quote another page's already-injected lane.
 */

const CONNECTIONS_MARKER = 'data-scriptorium-connections';

const GRAPH_BLOCK_RE = /<div class="relationship-graph"><h2>Connections(?: Graph)?<\/h2><svg/;
const GRAPH_PC_RE = /<h2>Connections<\/h2>\n<div class="relationship-graph"><svg/;
const NODE_RE = /(?:<a href="([^"]*)">)?<g opacity="(1|0\.5)">[\s\S]*?<text\b[^>]*>([^<]*)<\/text>\s*<\/g>/g;
const WHOS_HERE_CX_RE = /<div class="whos-here">\s*<h2>Connections<\/h2>\s*<div class="relationship-cards">/;

const EXCLUDED_TYPES = new Set(['session', 'campaign_overview', 'roster', 'timeline']);

const GROUP_DEFS = [
  { key: 'tie' },
  { key: 'named' },
  { key: 'pc', types: ['pc'] },
  { key: 'npc', types: ['npc'] },
  { key: 'faction', types: ['faction', 'organization'] },
  { key: 'location', types: ['location'] },
  { key: 'thing', types: ['item', 'creature', 'heritage'] },
  { key: 'event', types: ['event'] },
  { key: 'other', types: null },
];

function groupForType(type) {
  for (const g of GROUP_DEFS) {
    if (g.types && g.types.includes(type)) return g.key;
  }
  return 'other';
}

// -- declared relationships (relationship-list, sidebar) -----------------------------------------

/**
 * Array-form relationships as published in `<ul class="relationship-list">`.
 *
 * @param {string} html
 * @returns {{name: string, href: string|null, type: string, description: string|null}[]}
 */
function parseRelationshipList(html) {
  const openMatch = html.match(/<ul class="relationship-list">/);
  if (!openMatch) return [];
  const ulStart = openMatch.index;
  const ulEnd = htmltext.sliceBalanced(html, ulStart, 'ul');
  if (ulEnd === -1) return [];
  const inner = html.slice(ulStart + openMatch[0].length, ulEnd - '</ul>'.length);
  const out = [];
  for (const li of topLevelListItems(inner)) {
    const typeMatch = li.match(/^<strong class="rel-label">([\s\S]*?)<\/strong>\s*/);
    if (!typeMatch) continue;
    const type = htmltext.textOf(typeMatch[1]);
    let rest = li.slice(typeMatch[0].length);
    let description = null;
    const descMatch = rest.match(/ &mdash; ([\s\S]*)$/);
    if (descMatch) {
      description = htmltext.textOf(descMatch[1]);
      rest = rest.slice(0, descMatch.index);
    }
    const linkMatch = rest.match(/^<a href="([^"]*)" class="entity-link">([\s\S]*?)<\/a>$/);
    let href = null;
    let name;
    if (linkMatch) {
      href = linkMatch[1];
      name = htmltext.textOf(linkMatch[2]);
    } else {
      name = htmltext.textOf(rest);
    }
    out.push({ name, href, type, description });
  }
  return out;
}

/**
 * Object-form (or any-form) relationships as published in the context sidebar's "Relationships"
 * section. No description field (the sidebar never carries one).
 *
 * @param {string} html
 * @returns {{name: string, href: string|null, type: string, description: null}[]}
 */
function parseSidebarRelationships(html) {
  const asideMatch = html.match(/<aside class="context-sidebar">/);
  if (!asideMatch) return [];
  const asideEnd = htmltext.sliceBalanced(html, asideMatch.index, 'aside');
  if (asideEnd === -1) return [];
  const asideHtml = html.slice(asideMatch.index, asideEnd);
  const h3m = asideHtml.match(/<h3>Relationships<\/h3>\n<ul>([\s\S]*?)<\/ul>/);
  if (!h3m) return [];
  const out = [];
  for (const li of topLevelListItems(h3m[1])) {
    const badgeMatch = li.match(/<span class="sidebar-badge">([\s\S]*?)<\/span>\s*$/);
    if (!badgeMatch) continue;
    const type = htmltext.textOf(badgeMatch[1]);
    const namePart = li.slice(0, badgeMatch.index).trim();
    const linkMatch = namePart.match(/^<a href="([^"]*)">([\s\S]*?)<\/a>$/);
    let href = null;
    let name;
    if (linkMatch) {
      href = linkMatch[1];
      name = htmltext.textOf(linkMatch[2]);
    } else {
      name = htmltext.textOf(namePart);
    }
    out.push({ name, href, type, description: null });
  }
  return out;
}

function declaredEntries(html) {
  return [...parseRelationshipList(html), ...parseSidebarRelationships(html)];
}

// -- trimLine --------------------------------------------------------------------------------

/**
 * @param {string} s
 * @returns {string}
 */
function trimLine(s) {
  if (s.length <= 190) return s;
  let c = s.slice(0, 190);
  // Back off one if a low surrogate would be split.
  const last = c.charCodeAt(c.length - 1);
  if (last >= 0xdc00 && last <= 0xdfff) c = c.slice(0, -1);

  let cut = -1;
  for (const punct of ['. ', '! ', '? ']) {
    const idx = c.lastIndexOf(punct);
    if (idx > 90 && idx > cut) cut = idx + punct.length - 1; // cut after the punctuation
  }
  if (cut !== -1) return c.slice(0, cut);

  const spaceIdx = c.lastIndexOf(' ');
  if (spaceIdx !== -1) return `${c.slice(0, spaceIdx)}…`;

  return `${s.slice(0, 189)}…`;
}

// -- mention snippet: first prose block linking back to this page --------------------------------

/**
 * The first `<li>`, `<p>` or `<td>` block in proseRegion(targetHtml) whose href resolves to
 * `pageOutputPath`.
 *
 * @param {string} targetHtml
 * @param {string} targetOutputPath
 * @param {string} pageOutputPath
 * @returns {string | null}
 */
function findMentionSnippet(targetHtml, targetOutputPath, pageOutputPath) {
  const region = htmltext.proseRegion(targetHtml);
  const blockRe = /<(li|p|td)\b[^>]*>/g;
  let m;
  while ((m = blockRe.exec(region))) {
    const tag = m[1];
    const end = htmltext.sliceBalanced(region, m.index, tag);
    if (end === -1) continue;
    const blockHtml = region.slice(m.index, end);
    const hrefRe = /<a\s+[^>]*href="([^"]*)"/g;
    let hm;
    let hit = false;
    while ((hm = hrefRe.exec(blockHtml))) {
      if (htmltext.resolveHref(targetOutputPath, hm[1]) === pageOutputPath) {
        hit = true;
        break;
      }
    }
    if (hit) return trimLine(htmltext.textOf(blockHtml));
  }
  return null;
}

// -- SVG hop-1 extraction ----------------------------------------------------------------------

function findGraphRegion(html) {
  const blockMatch = html.match(GRAPH_BLOCK_RE);
  if (blockMatch) {
    const divStart = blockMatch.index;
    const end = htmltext.sliceBalanced(html, divStart, 'div');
    if (end !== -1) return { start: divStart, end, shape: 'standard' };
  }
  const pcMatch = html.match(GRAPH_PC_RE);
  if (pcMatch) {
    const h2Len = '<h2>Connections</h2>\n'.length;
    const divStart = pcMatch.index + h2Len;
    const end = htmltext.sliceBalanced(html, divStart, 'div');
    if (end !== -1) return { start: pcMatch.index, end, shape: 'pc' };
  }
  return null;
}

/**
 * @param {string} regionHtml
 * @returns {{ rawHref: string|null, label: string }[]}
 */
function extractHop1Nodes(regionHtml) {
  const matches = [...regionHtml.matchAll(NODE_RE)];
  if (matches.length === 0) return [];
  return matches
    .slice(1)
    .filter((m) => m[2] === '1')
    .map((m) => ({ rawHref: m[1] || null, label: htmltext.decodeEntities(m[3]) }));
}

// -- Phase 1: collect --------------------------------------------------------------------------

/**
 * Reads the whole staged tree into memory and builds one connection model per page that carries
 * a graph. Never writes anything.
 *
 * @param {Object<string,string>} htmlByPath outputPath -> full page HTML
 * @param {Map<string,{displayTitle:string,type:string}>} published outputPath -> {displayTitle, type}
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @param {Map<string,string>} [wrapUpByHub] hub outputPath -> paired Wrap-Up outputPath (src/build/sessionmodel.js)
 * @returns {{ pageModels: object[], warnings: string[] }}
 */
function collectConnections(htmlByPath, published, vocab = DEFAULT_VOCAB, wrapUpByHub = new Map()) {
  const warnings = [];
  const recaps = collectRecaps(htmlByPath, vocab, wrapUpByHub);
  warnings.push(...recaps.warnings);

  const pageModels = [];

  const sortedPaths = Object.keys(htmlByPath).sort(htmltext.cmpCodeUnit);
  for (const outputPath of sortedPaths) {
    const html = htmlByPath[outputPath];
    const region = findGraphRegion(html);
    if (!region) continue;

    const pageInfo = published.get(outputPath) || { displayTitle: outputPath, type: '' };
    const listEntries = parseRelationshipList(html);
    const sidebarEntries = parseSidebarRelationships(html);
    const declared = [...listEntries, ...sidebarEntries];

    const rawNodes = extractHop1Nodes(html.slice(region.start, region.end));

    const hop1OutputPaths = new Set();
    const rawItems = [];
    for (const node of rawNodes) {
      const resolvedPath = node.rawHref ? htmltext.resolveHref(outputPath, node.rawHref) : null;
      const targetInfo = resolvedPath ? published.get(resolvedPath) : null;
      // ADR 0036: a Wrap-Up is never a lane item either -- it stands in for its paired session's
      // recap, but it is never itself a hop-1 entity a lane should list.
      if (targetInfo && (EXCLUDED_TYPES.has(targetInfo.type) || pinned.WRAP_UP_TYPES.has(targetInfo.type))) continue;
      if (resolvedPath) hop1OutputPaths.add(resolvedPath);
      rawItems.push({ resolvedPath, label: node.label, targetInfo });
    }

    const items = [];
    for (const it of rawItems) {
      let tieEntry = null;
      if (it.resolvedPath) {
        tieEntry =
          listEntries.find((e) => e.href && htmltext.resolveHref(outputPath, e.href) === it.resolvedPath) ||
          sidebarEntries.find((e) => e.href && htmltext.resolveHref(outputPath, e.href) === it.resolvedPath);
      } else {
        tieEntry =
          declared.find((e) => pinned.truncateGraphemes(e.name, 15, 13) === it.label) || null;
      }

      let kind;
      let rel = null;
      let line = null;
      let src = null;
      let name;
      let targetDeclared = [];

      if (tieEntry) {
        kind = 'tie';
        rel = tieEntry.type.toLowerCase();
        line = tieEntry.description;
        src = outputPath;
        name = tieEntry.name;
      } else {
        name = it.targetInfo ? it.targetInfo.displayTitle : it.label;
        if (it.resolvedPath && htmlByPath[it.resolvedPath] !== undefined) {
          targetDeclared = declaredEntries(htmlByPath[it.resolvedPath]);
          const backlink = targetDeclared.find(
            (e) => e.href && htmltext.resolveHref(it.resolvedPath, e.href) === outputPath,
          );
          if (backlink) {
            kind = 'named';
            rel = `${backlink.type.toLowerCase()} ${pageInfo.displayTitle}`;
            line = backlink.description;
            src = it.resolvedPath;
          } else {
            kind = 'mention';
            src = it.resolvedPath;
            line = findMentionSnippet(htmlByPath[it.resolvedPath], it.resolvedPath, outputPath);
          }
        } else {
          kind = 'mention';
        }
      }

      const type = it.targetInfo ? it.targetInfo.type : '';
      const group = kind === 'mention' ? groupForType(type) : kind;

      let shared = [];
      if (it.resolvedPath) {
        shared = Array.from(recaps.entries())
          .filter(([, r]) => r.links.has(outputPath) && r.links.has(it.resolvedPath))
          .map(([n]) => n)
          .sort((a, b) => a - b);
      }

      let externalTie = 0;
      if (it.resolvedPath) {
        if (targetDeclared.length === 0 && htmlByPath[it.resolvedPath] !== undefined) {
          targetDeclared = declaredEntries(htmlByPath[it.resolvedPath]);
        }
        const hasExternal = targetDeclared.some((e) => {
          if (!e.href) return false;
          const resolved = htmltext.resolveHref(it.resolvedPath, e.href);
          return resolved && resolved !== outputPath && !hop1OutputPaths.has(resolved);
        });
        if (hasExternal) externalTie = 1;
      }

      const score = (kind === 'tie' ? 100 : kind === 'named' ? 50 : 0) + 5 * shared.length + externalTie;

      items.push({
        name,
        href: it.resolvedPath || null,
        type,
        group,
        kind,
        rel,
        line,
        src,
        shared,
        score,
      });
    }

    // rank: score desc, then name, then href||''
    const scoreSorted = items
      .slice()
      .sort(
        (a, b) =>
          b.score - a.score || htmltext.cmpCodeUnit(a.name, b.name) || htmltext.cmpCodeUnit(a.href || '', b.href || ''),
      );
    const rankOf = new Map();
    scoreSorted.forEach((it, i) => rankOf.set(it, i + 1));
    for (const it of items) it.rank = rankOf.get(it);

    // display order: group order, then within-group shared desc then name
    const groupIndex = new Map(GROUP_DEFS.map((g, i) => [g.key, i]));
    const displayItems = items
      .slice()
      .sort(
        (a, b) =>
          groupIndex.get(a.group) - groupIndex.get(b.group) ||
          b.shared.length - a.shared.length ||
          htmltext.cmpCodeUnit(a.name, b.name),
      );
    for (const it of displayItems) delete it.score;

    const sessions = Array.from(recaps.entries())
      .filter(([, r]) => r.links.has(outputPath))
      .map(([n]) => n)
      .sort((a, b) => a - b);

    pageModels.push({
      outputPath,
      shape: region.shape,
      start: region.start,
      end: region.end,
      name: pageInfo.displayTitle,
      items: displayItems,
      sessions: sessions.map((n) => recaps.get(n)),
    });
  }

  return { pageModels, warnings };
}

// -- Phase 2: render + write --------------------------------------------------------------------

function sessSpan(sessions, pageOutputPath, vocab) {
  if (!sessions.length) return '';
  const links = sessions
    .map((r) => {
      const href = relativeHref(pageOutputPath, r.outputPath);
      return `<a href="${htmltext.escapeHtml(href)}" title="${htmltext.escapeHtml(vocab.labels.recap)} ${htmltext.escapeHtml(r.num)}, ${htmltext.escapeHtml(r.title)}">${htmltext.escapeHtml(r.num)}</a>`;
    })
    .join(' ');
  return ` <span class="sc-cx-sess">${links}</span>`;
}

function relativeHref(fromOutputPath, toOutputPath) {
  const fromDir = path.posix.dirname(fromOutputPath);
  const rel = path.posix.relative(fromDir, toOutputPath);
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function renderGroupList(title, items, pageOutputPath, withFleuron) {
  if (!items.length) return '';
  const lis = items
    .map((it) => {
      const href = it.href ? relativeHref(pageOutputPath, it.href) : null;
      const target = href
        ? `<a href="${htmltext.escapeHtml(href)}">${htmltext.escapeHtml(it.name)}</a>`
        : `<span class="sc-cx-nolink">${htmltext.escapeHtml(it.name)}</span>`;
      const rel = it.rel ? ` <span class="sc-cx-rel">${htmltext.escapeHtml(it.rel)}</span>` : '';
      return `<li class="sc-cx-kind-${it.kind}">${target}${rel}</li>`;
    })
    .join('');
  const fleuron = withFleuron ? '<i class="sc-cx-fleuron" aria-hidden="true">&#10086;</i> ' : '';
  return `<h3 class="sc-cx-gh">${fleuron}${htmltext.escapeHtml(title)}</h3><ul class="sc-cx-list">${lis}</ul>`;
}

/**
 * @param {object} model one entry from collectConnections().pageModels
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {{ html: string, linkScript: boolean, removedOnly: boolean }}
 */
function renderLane(model, vocab = DEFAULT_VOCAB) {
  if (model.items.length === 0 && model.sessions.length === 0) {
    return { html: '', linkScript: false, removedOnly: true };
  }

  const hubSess = sessSpan(model.sessions, model.outputPath, vocab);
  const seal = String.fromCodePoint(model.name.codePointAt(0));
  // Canon-check's raw-text extractor only inserts a phrase boundary on block-level tag closes
  // (div/p/li/... -- never span/a), and its name-run regex spans a bare space, including into a
  // trailing session numeral. The seal and the name are block elements, and the whole hub is a
  // div rather than a <p> (a <p> cannot legally contain a nested <div>), for exactly that reason.
  // `.sc-cx-hub` is `display: flex`, so the tag swap from <span>/<p> has no visible effect.
  const hub =
    `<div class="sc-cx-hub"><div class="sc-cx-hub-seal" aria-hidden="true">${htmltext.escapeHtml(seal)}</div>` +
    `<div class="sc-cx-hub-name">${htmltext.escapeHtml(model.name)}</div>${hubSess}</div>`;

  let groupsHtml = '';
  let gi = 0;
  if (model.items.length > 0) {
    for (const g of GROUP_DEFS) {
      const groupItems = model.items.filter((it) => it.group === g.key);
      if (groupItems.length === 0) continue;
      groupsHtml += renderGroupList(vocab.labels[`group_${g.key}`], groupItems, model.outputPath, gi > 0);
      gi++;
    }
  }

  const island = {
    v: 1,
    name: model.name,
    seal: String.fromCodePoint(model.name.codePointAt(0)),
    sessions: model.sessions.map((r) => ({ n: r.n, num: r.num, title: r.title, href: relativeHref(model.outputPath, r.outputPath) })),
    items: model.items.map((it) => ({
      name: it.name,
      href: it.href ? relativeHref(model.outputPath, it.href) : null,
      type: it.type,
      group: it.group,
      kind: it.kind,
      rel: it.rel,
      line: it.line,
      src: it.src,
      shared: it.shared,
      rank: it.rank,
    })),
  };
  if (vocab.cxVoc !== null) island.voc = vocab.cxVoc;

  const html =
    `<section class="sc-cx" ${CONNECTIONS_MARKER}>\n` +
    `<h2>${htmltext.escapeHtml(vocab.labels.connections_heading)}</h2>\n` +
    `<div class="sc-cx-static">\n` +
    `${hub}\n` +
    `${groupsHtml}\n` +
    `</div>\n` +
    `<script type="application/json" class="sc-cx-data">${serializeDataIsland(island)}</script>\n` +
    `</section>`;

  return { html, linkScript: true, removedOnly: false };
}

/**
 * Computes the patched HTML for one page, or null if it carries no graph (byte-untouched).
 *
 * @param {string} html
 * @param {object} model this page's model (or undefined if collectConnections found no graph)
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {string | null}
 */
function transformConnections(html, model, vocab = DEFAULT_VOCAB) {
  if (!model) return null;
  if (html.includes(CONNECTIONS_MARKER)) return null;

  const rendered = renderLane(model, vocab);
  let out = html.slice(0, model.start) + rendered.html + html.slice(model.end);

  const whosHereMatch = out.match(WHOS_HERE_CX_RE);
  if (whosHereMatch) {
    const end = htmltext.sliceBalanced(out, whosHereMatch.index, 'div');
    if (end !== -1) out = out.slice(0, whosHereMatch.index) + out.slice(end);
  }

  if (rendered.linkScript) {
    const linked = linkSiteScript(out);
    if (linked !== null) out = linked;
  }

  return { html: out, removedOnly: rendered.removedOnly, hubOnly: model.items.length === 0 && model.sessions.length > 0 };
}

/**
 * @param {string} siteRoot
 * @param {{ vaultPath: string, jsonConfig: object, vocab: object, wrapUpByHub?: Map<string,string> }} opts
 * @returns {{ pagesPatched: number, lanes: number, hubOnly: number, removedOnly: string[], warnings: string[] }}
 */
function applyConnections(siteRoot, { vaultPath, jsonConfig, vocab = DEFAULT_VOCAB, wrapUpByHub = new Map() }) {
  const { publishedPages } = computePublishedSet(vaultPath, jsonConfig);
  const published = new Map();
  for (const p of publishedPages) {
    published.set(p.outputPath, { displayTitle: p.displayTitle, type: p.frontmatter.type || '' });
  }

  const htmlByPath = {};
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, entryRel);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      htmlByPath[entryRel] = fs.readFileSync(full, 'utf8');
    }
  })(siteRoot, '');

  const { pageModels, warnings } = collectConnections(htmlByPath, published, vocab, wrapUpByHub);
  const modelByPath = new Map(pageModels.map((m) => [m.outputPath, m]));

  let pagesPatched = 0;
  let lanes = 0;
  let hubOnly = 0;
  const removedOnly = [];

  for (const model of pageModels) {
    const html = htmlByPath[model.outputPath];
    const result = transformConnections(html, model, vocab);
    if (result === null) continue;
    fs.writeFileSync(path.join(siteRoot, model.outputPath), result.html);
    pagesPatched++;
    if (result.removedOnly) {
      removedOnly.push(model.outputPath);
      warnings.push(`${model.outputPath}: no declared ties, backlinks, mentions or shared recaps; the graph was removed`);
    } else if (result.hubOnly) {
      hubOnly++;
    } else {
      lanes++;
    }
  }

  return { pagesPatched, lanes, hubOnly, removedOnly, warnings };
}

module.exports = {
  CONNECTIONS_MARKER,
  GRAPH_BLOCK_RE,
  GRAPH_PC_RE,
  NODE_RE,
  WHOS_HERE_CX_RE,
  trimLine,
  parseRelationshipList,
  parseSidebarRelationships,
  findMentionSnippet,
  collectConnections,
  renderLane,
  transformConnections,
  applyConnections,
};
