'use strict';

const fs = require('fs');
const path = require('path');
const htmltext = require('./htmltext');
const pinned = require('../generator/pinned');
const { collectRecaps, topLevelListItems } = require('./recaps');
const { linkSiteScript, writeSiteScript, serializeDataIsland } = require('./sitescript');
const { computePublishedSet } = require('../vault/publishset');
const { scanAllNotesForPairing } = require('../vault/sessionpairs');
const { DEFAULT_VOCAB } = require('./labels');

/*
 * Engineering Brief: "Story timeline + Connections lane" (docs/agent-runs/
 * timeline-connections-engineering-brief-2026-09-24.md), "Interfaces and contracts: connections.js".
 *
 * Replaces the pin's Connections section, in place, on every page that carries one, with a
 * ranked, grouped lane built ONLY from what that section publishes (read from its own data block,
 * not re-derived -- Structural decision 3). Until publish-v1.17.0 the lane replaced the
 * relationship-graph SVG and read its items from the graph, the relationship list and the sidebar. Collect-then-write (FR-C8): the whole tree is
 * read into memory and every page's model computed before any page is rewritten, so a lane can
 * never quote another page's already-injected lane.
 */

const CONNECTIONS_MARKER = 'data-scriptorium-connections';

// From publish-v1.18.0 the pin draws a page's Connections as one section (lib/templates/connections.js),
// carrying the same content as data. The lane replaces that section in place and reads only that data:
// what the pin published, already reduced for the reader (lib/connections.js).
const CX_SECTION_RE = /<section class="cx"[\s>]/;
const CX_DATA_RE = /<script type="application\/json" class="cx-data">([\s\S]*?)<\/script>/;
// The pin's own script for that section. A page whose section the lane replaced has no use for it.
const CX_SCRIPT_RE = /<script src="[^"]*js\/connections\.js"><\/script>\n?/;

// How a named item words the two group labels the pin makes up, before this page's name.
const PIN_LABEL_WORDING = { Family: 'family of', Connected: 'connected to' };

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

// -- the pin's Connections section ---------------------------------------------------------------

/**
 * Where the page's Connections section starts and ends, or null.
 *
 * @param {string} html
 * @returns {{ start: number, end: number } | null}
 */
function findCxRegion(html) {
  const m = CX_SECTION_RE.exec(html);
  if (!m) return null;
  const end = htmltext.sliceBalanced(html, m.index, 'section');
  return end === -1 ? null : { start: m.index, end };
}

/**
 * The section's data, as the items and mentions the lane needs. Relationship items keep their group
 * label (the pin's own wording, already in this page's direction), their lines and how many of those
 * lines come from this page's own note. A data block that does not parse gives null: the page is
 * left as the pin wrote it.
 *
 * @param {string} regionHtml
 * @returns {{ subject: string, items: {title: string, rawHref: string|null, label: string, lines: string[], own: number}[], mentions: {title: string, rawHref: string}[] } | null}
 */
function readCxData(regionHtml) {
  const m = CX_DATA_RE.exec(regionHtml);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
  const items = [];
  const seen = new Set();
  for (const tab of Array.isArray(data.t) ? data.t : []) {
    for (const group of Array.isArray(tab.g) ? tab.g : []) {
      for (const d of Array.isArray(group.d) ? group.d : []) {
        const key = d.h || `\u0000${d.t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          title: String(d.t),
          rawHref: d.h || null,
          label: String(group.n || ''),
          lines: Array.isArray(d.l) ? d.l.map(String) : [],
          own: Number.isInteger(d.f) ? d.f : 0,
        });
      }
    }
  }
  const mentions = [];
  for (const group of Array.isArray(data.m) ? data.m : []) {
    for (const d of Array.isArray(group.d) ? group.d : []) {
      if (Array.isArray(d) && d[1]) mentions.push({ title: String(d[0]), rawHref: String(d[1]) });
    }
  }
  return { subject: String(data.s || ''), items, mentions };
}

// -- which pages a page's own note names in its relationships ---------------------------------------

/**
 * The relationship targets of each published page's reader-visible frontmatter, resolved to output
 * paths the way the pin's Connections model resolves them (lib/connections.js:159-169), against the
 * pin's own link table. Decides only whether a connection is this page's own (a tie) or the other
 * page's (named by); every word the lane prints comes from the pin's section. As in the pin, the link
 * table is built from the raw frontmatter (lib/build.js:535), then every GM alias is rewritten to its
 * owner's title (`rewriter`, lib/build.js:546), then the frontmatter is reduced to its published view.
 *
 * @param {object[]} publishedPages
 * @param {object} publishConfig
 * @param {{ frontmatter: function(object): object } | null} [rewriter] the pin's gmAliasRewriter, or null when the vault has no GM alias
 * @returns {Map<string, Set<string>>} outputPath -> output paths its own relationships name
 */
function ownTargets(publishedPages, publishConfig, rewriter = null) {
  const linkMap = pinned.buildLinkMap(
    publishedPages.map((p) => ({ title: p.title, frontmatter: p.frontmatter, outputPath: p.outputPath, vaultPath: p.rel.replace(/\.md$/i, '') })),
  );
  const resolve = (value) => {
    const ref = pinned.linkText(value, { humanize: true });
    const links = String(value).match(pinned.wikilinkRe('g')) || [];
    const key = !ref.labelled && links.length === 1
      ? pinned.parseWikilink(pinned.wikilinkRe('').exec(links[0])[1]).name.trim()
      : ref.key;
    const name = pinned.canonicalNfc(key.split(/[#^]/)[0].replace(/\.md$/i, '').trim());
    const out = name ? linkMap[name] : undefined;
    return typeof out === 'string' ? out : null;
  };
  const fieldOverrides = (publishConfig.overrides && publishConfig.overrides.fields) || {};
  const out = new Map();
  for (const p of publishedPages) {
    const written = rewriter ? rewriter.frontmatter(p.frontmatter) : p.frontmatter;
    const fm = pinned.publishedFrontmatter(written, publishConfig.exclude_fields || [], fieldOverrides[p.rel] || {});
    const raw = fm.relationships;
    const targets = [];
    if (Array.isArray(raw)) {
      for (const r of raw) if (r && typeof r === 'object' && !Array.isArray(r)) targets.push(r.target);
    } else if (raw && typeof raw === 'object') {
      for (const value of Object.values(raw)) targets.push(...(Array.isArray(value) ? value : [value]));
    }
    const set = new Set();
    for (const t of targets) {
      if (typeof t !== 'string' || !t.trim()) continue;
      const resolved = resolve(t);
      if (resolved) set.add(resolved);
    }
    out.set(p.outputPath, set);
  }
  return out;
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

// -- Phase 1: collect --------------------------------------------------------------------------

/**
 * Reads the whole staged tree into memory and builds one connection model per page that carries
 * the pin's Connections section. Never writes anything.
 *
 * @param {Object<string,string>} htmlByPath outputPath -> full page HTML
 * @param {Map<string,{displayTitle:string,type:string}>} published outputPath -> {displayTitle, type}
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @param {Map<string,string>} [wrapUpByHub] hub outputPath -> paired Wrap-Up outputPath (src/build/sessionmodel.js)
 * @param {Map<string,Set<string>>} [ownByPath] outputPath -> the pages its own relationships name (ownTargets)
 * @returns {{ pageModels: object[], warnings: string[] }}
 */
function collectConnections(htmlByPath, published, vocab = DEFAULT_VOCAB, wrapUpByHub = new Map(), ownByPath = new Map()) {
  const warnings = [];
  const recaps = collectRecaps(htmlByPath, vocab, wrapUpByHub);
  warnings.push(...recaps.warnings);

  // Every page's section, read once: a lane also reads the other page's (its wording, its ties).
  const cxByPath = new Map();
  for (const outputPath of Object.keys(htmlByPath).sort(htmltext.cmpCodeUnit)) {
    const html = htmlByPath[outputPath];
    const region = findCxRegion(html);
    if (!region) continue;
    const data = readCxData(html.slice(region.start, region.end));
    if (!data) {
      warnings.push(`${outputPath}: the Connections section's data could not be read; the page keeps the generator's own section`);
      continue;
    }
    cxByPath.set(outputPath, { region, data });
  }

  const pageModels = [];
  for (const [outputPath, { region, data }] of cxByPath) {
    const pageInfo = published.get(outputPath) || { displayTitle: outputPath, type: '' };
    const mine = ownByPath.get(outputPath) || new Set();

    const candidates = [
      ...data.items.map((it) => ({ ...it, mention: false })),
      ...data.mentions.map((m) => ({ title: m.title, rawHref: m.rawHref, label: '', lines: [], own: 0, mention: true })),
    ];
    const hop1OutputPaths = new Set();
    const rawItems = [];
    for (const it of candidates) {
      const resolvedPath = it.rawHref ? htmltext.resolveHref(outputPath, it.rawHref) : null;
      const targetInfo = resolvedPath ? published.get(resolvedPath) : null;
      // ADR 0036: a Wrap-Up is never a lane item either -- it stands in for its paired session's
      // recap, but it is never itself a hop-1 entity a lane should list.
      if (targetInfo && (EXCLUDED_TYPES.has(targetInfo.type) || pinned.WRAP_UP_TYPES.has(targetInfo.type))) continue;
      if (resolvedPath) hop1OutputPaths.add(resolvedPath);
      rawItems.push({ ...it, resolvedPath, targetInfo });
    }

    const items = [];
    for (const it of rawItems) {
      const name = it.targetInfo ? it.targetInfo.displayTitle : it.title;
      let kind;
      let rel = null;
      let line = null;
      let src = null;

      // The other page's own section lists this page back only when one of the two declared a
      // relationship. With no such item, the connection is this page's own whatever its kind: a
      // relationship, a parent place, or what the pin adds itself, such as a session's NPCs.
      const theirs = it.resolvedPath ? cxByPath.get(it.resolvedPath) : null;
      const back = theirs
        ? theirs.data.items.find((x) => x.rawHref && htmltext.resolveHref(it.resolvedPath, x.rawHref) === outputPath)
        : null;
      if (!it.mention && (!back || mine.has(it.resolvedPath))) {
        // This page's own. The pin's group label is its type, worded for this page.
        kind = 'tie';
        rel = it.label ? it.label.toLowerCase() : null;
        line = it.own > 0 ? it.lines[0] : null;
        src = outputPath;
      } else if (!it.mention) {
        // The other page's relationship to this one, in that page's own wording: its section lists
        // this page under the label it wrote. Two labels are the pin's own, not a type the GM wrote
        // (lib/ontology.js groupLabel): every kinship type is "Family", no type at all is "Connected".
        kind = 'named';
        const label = back.label ? (PIN_LABEL_WORDING[back.label] || back.label.toLowerCase()) : '';
        rel = label ? `${label} ${pageInfo.displayTitle}` : null;
        line = it.lines.length > it.own ? it.lines[it.own] : null;
        src = it.resolvedPath;
      } else {
        kind = 'mention';
        src = it.resolvedPath;
        if (htmlByPath[it.resolvedPath] !== undefined) line = findMentionSnippet(htmlByPath[it.resolvedPath], it.resolvedPath, outputPath);
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

      // One point when the other page has a relationship of its own beyond this page and its lane.
      let externalTie = 0;
      if (it.resolvedPath) {
        const theirs = ownByPath.get(it.resolvedPath) || new Set();
        if ([...theirs].some((p) => p !== outputPath && !hop1OutputPaths.has(p))) externalTie = 1;
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
 * Computes the patched HTML for one page, or null if it carries no Connections section (byte-untouched).
 *
 * @param {string} html
 * @param {object} model this page's model (or undefined if collectConnections found no section)
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {string | null}
 */
function transformConnections(html, model, vocab = DEFAULT_VOCAB) {
  if (!model) return null;
  if (html.includes(CONNECTIONS_MARKER)) return null;

  const rendered = renderLane(model, vocab);
  let out = html.slice(0, model.start) + rendered.html + html.slice(model.end);

  // The pin's own section script draws nothing once its section is gone.
  out = out.replace(CX_SCRIPT_RE, '');

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
  const { publishedPages, unpublishedPages, publishConfig } = computePublishedSet(vaultPath, jsonConfig);
  // The notes pairHubs hands the pin's rewriter (lib/session-hub.js:147-152): every scanned page,
  // published or not, then every note the scan skipped.
  const corpus = publishedPages.concat(unpublishedPages);
  const { notes } = scanAllNotesForPairing(vaultPath);
  const scanned = new Set(corpus.map((p) => p.sourcePath));
  const rewriter = pinned.gmAliasRewriter(corpus.concat(notes.filter((n) => !scanned.has(n.sourcePath))), publishedPages, notes);
  const ownByPath = ownTargets(publishedPages, publishConfig, rewriter);
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

  const { pageModels, warnings } = collectConnections(htmlByPath, published, vocab, wrapUpByHub, ownByPath);
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
      warnings.push(`${model.outputPath}: no declared ties, backlinks, mentions or shared recaps; the Connections section was removed`);
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
  CX_SECTION_RE,
  trimLine,
  findCxRegion,
  readCxData,
  ownTargets,
  findMentionSnippet,
  collectConnections,
  renderLane,
  transformConnections,
  applyConnections,
};
