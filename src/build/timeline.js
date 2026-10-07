'use strict';

const fs = require('fs');
const path = require('path');
const htmltext = require('./htmltext');
const { collectRecaps } = require('./recaps');
const { linkSiteScript, serializeDataIsland } = require('./sitescript');
const { computePublishedSet } = require('../vault/publishset');

/*
 * Engineering Brief: "Story timeline + Connections lane" (docs/agent-runs/
 * timeline-connections-engineering-brief-2026-09-24.md), "Interfaces and contracts: timeline.js".
 *
 * The transform of the authored Timeline page: two opted-in tables (Backstory and setting, The
 * campaign) carrying Title/Kind/Weight/Place helper columns, plus a separate "Learned anchors"
 * table, become one static+JS widget. See the ADR (docs/decisions/0017-...) for the rejected
 * alternatives (the pin's own timeline, a recap-marker anchor, a per-row column).
 */

const { DEFAULT_VOCAB } = require('./labels');

const TIMELINE_MARKER = 'data-scriptorium-timeline';

const T = '\\d{1,2}:\\d{2}(?::\\d{2})?';
const TIMESTAMP_RE = new RegExp(`(?<![\\d:])${T}(?:\\s*[-–]\\s*${T})?(?![\\d:])`, 'g');

/**
 * @param {string} s
 * @returns {string}
 */
function stripTimestamps(s) {
  s = s.replace(TIMESTAMP_RE, '').replace(/[ \t]+/g, ' ');
  s = s.replace(/\(\s*[,;:\-–]?\s*\)/g, '');
  s = s.replace(/\(\s*[,;]\s*/g, '(').replace(/\s*[,;]\s*\)/g, ')');
  s = s.replace(/\s+([,;:.!?])/g, '$1');
  s = s.replace(/([,;:])(?:\s*[,;:])+/g, '$1');
  s = s.replace(/([,;:])\s*([.!?])/g, '$2');
  s = s.replace(/^\s*[,;:]\s*/, '').replace(/\s*[,;:]\s*$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

// -- table extraction --------------------------------------------------------------------------

function findTables(html) {
  const out = [];
  const re = /<table(?:\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(html))) {
    const end = htmltext.sliceBalanced(html, m.index, 'table');
    if (end === -1) continue;
    out.push({ start: m.index, end, html: html.slice(m.index, end) });
  }
  return out;
}

function findRows(tableHtml) {
  const out = [];
  const re = /<tr(?:\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(tableHtml))) {
    const end = htmltext.sliceBalanced(tableHtml, m.index, 'tr');
    if (end === -1) continue;
    out.push(tableHtml.slice(m.index, end));
  }
  return out;
}

function findCells(rowHtml) {
  const out = [];
  const re = /<t([hd])(\s[^>]*)?>([\s\S]*?)<\/t\1>/g;
  let m;
  while ((m = re.exec(rowHtml))) {
    out.push({ kind: m[1], html: m[3] });
  }
  return out;
}

/**
 * @param {string} tableHtml
 * @returns {{ headerCols: string[] | null, rows: {kind:string,html:string}[][] }}
 */
function parseTable(tableHtml) {
  let headerCols = null;
  const rows = [];
  for (const rowHtml of findRows(tableHtml)) {
    const cells = findCells(rowHtml);
    if (cells.length === 0) continue;
    if (cells.every((c) => c.kind === 'h')) {
      if (headerCols === null) headerCols = cells.map((c) => htmltext.textOf(c.html).trim().toLowerCase());
      continue;
    }
    rows.push(cells);
  }
  return { headerCols, rows };
}

/**
 * The leftmost header in `headerCols` that matches any of `names` (ADR 0020, [timeline.columns]:
 * "the column is the leftmost header that matches any of its names").
 *
 * @param {string[]|null} headerCols
 * @param {string[]} names
 * @returns {number}
 */
function colIdx(headerCols, names) {
  if (!headerCols) return -1;
  for (let i = 0; i < headerCols.length; i++) {
    if (names.includes(headerCols[i])) return i;
  }
  return -1;
}

function cellText(cells, idx) {
  if (idx < 0 || idx >= cells.length) return '';
  return htmltext.textOf(cells[idx].html);
}

// -- segment labels -----------------------------------------------------------------------------

/**
 * @param {string} whenText
 * @param {object} vocab
 * @returns {string}
 */
function segmentLabel(whenText, vocab) {
  const m = whenText.match(vocab.segmentUnits);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
  }
  return whenText.split(',')[0].trim();
}

// -- links in the What cell ----------------------------------------------------------------------

function extractCellLinks(cellHtml) {
  const seen = new Map();
  const re = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(cellHtml))) {
    const href = htmltext.decodeEntities(m[1]);
    if (!seen.has(href)) seen.set(href, htmltext.textOf(m[2]));
  }
  return Array.from(seen, ([href, text]) => [text, href]);
}

/**
 * @param {string} fromOutputPath
 * @param {string} toOutputPath
 * @returns {string}
 */
function relativeHref(fromOutputPath, toOutputPath) {
  const fromDir = path.posix.dirname(fromOutputPath);
  const rel = path.posix.relative(fromDir, toOutputPath);
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// -- point extraction -----------------------------------------------------------------------------

/**
 * Extracts every point from every opted-in (Title+Kind) table in `html`, in document order,
 * inheriting Place across tables.
 *
 * @param {string} html
 * @param {string} outputPath the page's own output path (for recap hrefs)
 * @param {Map} recaps collectRecaps() output
 * @param {string[]} warnings pushed to in place
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {{ points: object[], segments: object[], chapters: Map<number,object>, opted: object[], anchorTable: object|null }}
 */
function extractPoints(html, outputPath, recaps, warnings, vocab = DEFAULT_VOCAB) {
  const tables = findTables(html);
  const points = [];
  const segments = [];
  const chapters = new Map();
  const opted = [];
  let anchorTable = null;
  let lastPlace = '';
  let lastSegKey = null;
  let curSeg = null;
  let segCounter = 0;
  let pointCounter = 0;

  for (const table of tables) {
    const parsed = parseTable(table.html);
    const headerCols = parsed.headerCols || [];
    const titleIdx = colIdx(headerCols, vocab.columns.title);
    const kindIdx = colIdx(headerCols, vocab.columns.kind);
    const isData = titleIdx !== -1 && kindIdx !== -1;
    const sessionColIdx = colIdx(headerCols, vocab.columns.session);
    const learnedColIdx = colIdx(headerCols, vocab.columns.learned);
    const afterColIdx = colIdx(headerCols, vocab.columns.after);
    const isAnchor = sessionColIdx !== -1 && learnedColIdx !== -1 && afterColIdx !== -1;

    if (isAnchor) {
      if (anchorTable) {
        warnings.push('more than one Learned-anchors table found; using the first');
      } else {
        anchorTable = {
          start: table.start,
          end: table.end,
          rows: parsed.rows,
          headerCols,
          sessionIdx: sessionColIdx,
          learnedIdx: learnedColIdx,
          afterIdx: afterColIdx,
        };
      }
      continue;
    }

    if (!isData) continue;

    const inGameIdx = colIdx(headerCols, vocab.columns.in_game);
    const whenIdx = inGameIdx !== -1 ? inGameIdx : colIdx(headerCols, vocab.columns.when);
    const realWorldIdx = colIdx(headerCols, vocab.columns.real_world);
    const whatIdx = colIdx(headerCols, vocab.columns.what);
    const weightIdx = colIdx(headerCols, vocab.columns.weight);
    const placeIdx = colIdx(headerCols, vocab.columns.place);

    if (weightIdx === -1) {
      warnings.push(`a table (headers: ${headerCols.join(', ')}) has no Weight column; every row defaults to weight 2`);
    }

    for (const cells of parsed.rows) {
      const when = cellText(cells, whenIdx);

      let kind = cellText(cells, kindIdx).trim().toLowerCase();
      if (!vocab.kindByName.has(kind)) {
        warnings.push(`unknown Kind "${cellText(cells, kindIdx)}" for row "${when}"; treated as neutral`);
        kind = '';
      } else {
        kind = vocab.kindByName.get(kind);
      }

      let weight = 2;
      if (weightIdx !== -1) {
        const raw = cellText(cells, weightIdx).trim();
        if (/^[123]$/.test(raw)) {
          weight = parseInt(raw, 10);
        } else {
          warnings.push(`invalid Weight "${raw}" for row "${when}"; defaulted to 2`);
        }
      }

      let title = cellText(cells, titleIdx).trim();
      if (!title) {
        warnings.push(`empty Title for row "${when}"; falling back to the when-label`);
        title = when;
      }

      let place = placeIdx !== -1 ? cellText(cells, placeIdx).trim() : '';
      if (!place) place = lastPlace;
      lastPlace = place;

      let s = 0;
      if (realWorldIdx !== -1) {
        const sm = cellText(cells, realWorldIdx).match(vocab.sessionToken);
        if (sm && /^\d+$/.test(sm[1] || '')) s = parseInt(sm[1], 10);
        else warnings.push(`no session token (S<n>) found for row "${when}"; treated as session 0`);
      } else {
        warnings.push(`no Real-world column; row "${when}" treated as session 0`);
      }

      const whatCellHtml = whatIdx !== -1 && cells[whatIdx] ? cells[whatIdx].html : '';
      const x = stripTimestamps(htmltext.textOf(whatCellHtml));
      const links = extractCellLinks(whatCellHtml);

      const label = segmentLabel(when, vocab);
      const segKey = `${place}\u0000${label}`;
      if (segKey !== lastSegKey) {
        segCounter++;
        curSeg = { id: `s${segCounter}`, tier: place, label, allBackstory: true };
        segments.push(curSeg);
        lastSegKey = segKey;
      }
      if (!vocab.beforeKinds.has(kind)) curSeg.allBackstory = false;

      pointCounter++;
      const id = `p${pointCounter}`;

      if (s > 0 && recaps.has(s)) {
        const recap = recaps.get(s);
        if (!chapters.has(s)) chapters.set(s, recap);
        links.push([`${vocab.labels.recap} ${recap.num}, ${recap.title}`, relativeHref(outputPath, recap.outputPath)]);
      }

      points.push({ id, seg: curSeg.id, s, w: weight, k: kind, t: title, when, x, links });
    }

    opted.push({ start: table.start, end: table.end, titleIdx, kindIdx, weightIdx, placeIdx });
  }

  const finalSegments = segments.map((seg) => ({ id: seg.id, tier: seg.tier, label: seg.label, before: seg.allBackstory }));

  return { points, segments: finalSegments, chapters, opted, anchorTable };
}

// -- anchor placement -----------------------------------------------------------------------------

/**
 * @param {object} extracted result of extractPoints
 * @param {Map} recaps
 * @param {string} outputPath the page's own output path (for recap hrefs)
 * @param {string[]} warnings
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {{ learned: object[], total: number, placed: number, unanchored: number }}
 */
function placeLearnedItems(extracted, recaps, outputPath, warnings, vocab = DEFAULT_VOCAB) {
  const { points, anchorTable } = extracted;

  const titleKeyToPoint = new Map();
  for (const p of points) {
    const key = htmltext.foldKey(p.t);
    if (titleKeyToPoint.has(key)) {
      warnings.push(`two rows fold to the same Title "${p.t}"; anchors match the first`);
      continue;
    }
    titleKeyToPoint.set(key, p.id);
  }

  const anchorMap = new Map();
  if (anchorTable) {
    const sessionIdx = anchorTable.sessionIdx;
    const learnedIdx = anchorTable.learnedIdx;
    const afterIdx = anchorTable.afterIdx;
    for (const cells of anchorTable.rows) {
      const sessionText = cellText(cells, sessionIdx);
      const sm = sessionText.match(/\d+/);
      if (!sm) continue;
      const sess = parseInt(sm[0], 10);
      const learnedKey = htmltext.foldKey(cellText(cells, learnedIdx));
      const afterKey = htmltext.foldKey(cellText(cells, afterIdx));
      anchorMap.set(`${sess}\u0000${learnedKey}`, afterKey);
    }
  }

  const lastPointOverall = points.length ? points[points.length - 1].id : null;
  function lastPointOfSession(sess) {
    let last = null;
    for (const p of points) if (p.s === sess) last = p.id;
    return last || lastPointOverall;
  }

  let total = 0;
  let placed = 0;
  const learnedOut = [];
  let counter = 0;

  const sessions = Array.from(recaps.keys()).sort((a, b) => a - b);
  for (const n of sessions) {
    const recap = recaps.get(n);
    const recapHref = relativeHref(outputPath, recap.outputPath);
    for (const item of recap.learned) {
      total++;
      counter++;
      const id = `l${counter}`;
      let afterId;
      const mapKey = `${n}\u0000${item.key}`;
      if (anchorMap.has(mapKey)) {
        const afterKey = anchorMap.get(mapKey);
        const pointId = titleKeyToPoint.get(afterKey);
        if (pointId) {
          afterId = pointId;
          placed++;
        } else {
          warnings.push(`anchor "${item.title}" (session ${n}) names an After row that does not match any Title; placed after the last row of its session`);
          afterId = lastPointOfSession(n);
        }
      } else {
        warnings.push(`learned item "${item.title}" (session ${n}) has no matching anchor row; placed after the last row of its session`);
        afterId = lastPointOfSession(n);
      }

      learnedOut.push({
        id,
        after: afterId,
        s: n,
        t: item.title,
        x: item.body,
        links: [[`${vocab.labels.recap} ${recap.num}, ${recap.title}: ${vocab.labels.recap_learned_link}`, recapHref]],
      });
    }
  }

  return { learned: learnedOut, total, placed, unanchored: total - placed };
}

// -- text edits -------------------------------------------------------------------------------

function precedingH2Start(html, tableStart) {
  const beforeTable = html.slice(0, tableStart);
  const trimmed = beforeTable.replace(/\s+$/, '');
  if (!trimmed.endsWith('</h2>')) return tableStart;
  const h2Start = trimmed.lastIndexOf('<h2>');
  if (h2Start === -1) return tableStart;
  return h2Start;
}

/**
 * Removes the (Title, Kind, Weight, Place) helper `<th>`/`<td>` cells from `tableHtml`, each with
 * one following '\n', resetting the column index at each row boundary.
 *
 * @param {string} tableHtml
 * @param {number[]} helperIdx column indices to strip
 * @returns {string}
 */
function stripHelperCells(tableHtml, helperIdx) {
  const rowRe = /<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/g;
  return tableHtml.replace(rowRe, (rowHtml) => {
    let idx = -1;
    return rowHtml.replace(/<t([hd])(\s[^>]*)?>[\s\S]*?<\/t\1>\n?/g, (whole) => {
      idx++;
      return helperIdx.includes(idx) ? '' : whole;
    });
  });
}

/**
 * Builds the full timeline model for one page: extracted points/segments/chapters/learned, the
 * serialised data island, and the ordered list of text edits (right-to-left safe) the transform
 * needs to apply. Returns null when the page has no opted-in table (byte-untouched, FR-T9/AC-10).
 *
 * @param {string} html
 * @param {string} outputPath
 * @param {Map} recaps
 * @param {string[]} warnings
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {object | null}
 */
function buildTimelineModel(html, outputPath, recaps, warnings, vocab = DEFAULT_VOCAB) {
  const extracted = extractPoints(html, outputPath, recaps, warnings, vocab);
  if (extracted.opted.length === 0) return null;

  const { learned, total, placed, unanchored } = placeLearnedItems(extracted, recaps, outputPath, warnings, vocab);

  const ch = {};
  for (const [n, recap] of extracted.chapters) {
    ch[String(n)] = { num: recap.num, title: recap.title, date: recap.date, href: relativeHref(outputPath, recap.outputPath) };
  }

  const island = {
    v: 1,
    segs: extracted.segments,
    ch,
    points: extracted.points,
    learned,
  };
  if (vocab.tlVoc !== null) island.voc = vocab.tlVoc;

  const edits = [];

  for (const table of extracted.opted) {
    const helperIdx = [table.titleIdx, table.kindIdx, table.weightIdx, table.placeIdx].filter((i) => i !== -1);
    const wrapStart = precedingH2Start(html, table.start);
    const heading = html.slice(wrapStart, table.start); // unchanged h2 + whitespace, or ''
    const strippedTable = helperIdx.length ? stripHelperCells(html.slice(table.start, table.end), helperIdx) : html.slice(table.start, table.end);
    edits.push({ start: wrapStart, end: table.end, replacement: `<div class="sc-tl-src">${heading}${strippedTable}</div>` });
  }

  if (extracted.anchorTable) {
    const wrapStart = precedingH2Start(html, extracted.anchorTable.start);
    let end = extracted.anchorTable.end;
    if (html.slice(end, end + 1) === '\n') end += 1;
    edits.push({ start: wrapStart, end, replacement: '' });
  }

  edits.sort((a, b) => a.start - b.start);
  const widgetPrefix = `<div class="sc-tl" ${TIMELINE_MARKER}></div>\n<script type="application/json" class="sc-tl-data">${serializeDataIsland(island)}</script>\n`;
  if (edits.length) edits[0].replacement = widgetPrefix + edits[0].replacement;

  return { points: extracted.points, learned: { total, placed, unanchored }, island, edits };
}

/**
 * @param {object[]} edits sorted ascending by start, non-overlapping
 * @param {string} html
 * @returns {string}
 */
function applyEdits(html, edits) {
  let out = html;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

/**
 * Computes the patched HTML for the timeline page, or null when there is no opted-in table.
 *
 * @param {string} html
 * @param {string} outputPath
 * @param {Map} recaps
 * @param {string[]} warnings
 * @param {object} [vocab] ADR 0020; defaults to DEFAULT_VOCAB
 * @returns {string | null}
 */
function transformTimeline(html, outputPath, recaps, warnings, vocab = DEFAULT_VOCAB) {
  if (html.includes(TIMELINE_MARKER)) return null;
  const model = buildTimelineModel(html, outputPath, recaps, warnings, vocab);
  if (!model) return null;
  const patched = applyEdits(html, model.edits);
  const linked = linkSiteScript(patched);
  return linked === null ? patched : linked;
}

/**
 * Walks the staged output tree, selects the target timeline page the same way the pin does
 * (published type: timeline, else the first output named timeline.html), collects recap data
 * from the whole tree, and patches the target page in place.
 *
 * @param {string} siteRoot
 * @param {{ vaultPath: string, jsonConfig: object, vocab: object, wrapUpByHub?: Map<string,string> }} opts
 * @returns {{ pagesPatched: number, target: string|null, points: number, learned: {total:number,placed:number,unanchored:number}, warnings: string[] }}
 */
function applyTimeline(siteRoot, { vaultPath, jsonConfig, vocab = DEFAULT_VOCAB, wrapUpByHub = new Map() }) {
  const warnings = [];
  const { publishedPages } = computePublishedSet(vaultPath, jsonConfig);

  let typeMatches = publishedPages.filter((p) => p.frontmatter.type === 'timeline').map((p) => p.outputPath).sort(htmltext.cmpCodeUnit);
  let target = null;
  if (typeMatches.length > 0) {
    target = typeMatches[0];
    if (typeMatches.length > 1) warnings.push(`multiple pages declare type: timeline; using ${target}`);
  } else {
    const nameMatches = publishedPages
      .map((p) => p.outputPath)
      .filter((p) => p === 'timeline.html' || p.endsWith('/timeline.html'))
      .sort(htmltext.cmpCodeUnit);
    if (nameMatches.length > 0) {
      target = nameMatches[0];
      if (nameMatches.length > 1) warnings.push(`multiple outputs named timeline.html; using ${target}`);
    }
  }

  if (!target) {
    return { pagesPatched: 0, target: null, points: 0, learned: { total: 0, placed: 0, unanchored: 0 }, warnings };
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

  const recaps = collectRecaps(htmlByPath, vocab, wrapUpByHub);
  warnings.push(...recaps.warnings);

  const targetHtml = htmlByPath[target];
  if (targetHtml === undefined) {
    warnings.push(`target page ${target} was not found in the staged output`);
    return { pagesPatched: 0, target, points: 0, learned: { total: 0, placed: 0, unanchored: 0 }, warnings };
  }

  const patched = transformTimeline(targetHtml, target, recaps, warnings, vocab);
  if (patched === null) {
    return { pagesPatched: 0, target, points: 0, learned: { total: 0, placed: 0, unanchored: 0 }, warnings };
  }

  fs.writeFileSync(path.join(siteRoot, target), patched);

  const statsWarnings = [];
  const model = buildTimelineModel(targetHtml, target, recaps, statsWarnings, vocab);

  return {
    pagesPatched: 1,
    target,
    points: model.points.length,
    learned: model.learned,
    warnings,
  };
}

module.exports = {
  TIMELINE_MARKER,
  TIMESTAMP_RE,
  stripTimestamps,
  extractPoints,
  placeLearnedItems,
  buildTimelineModel,
  transformTimeline,
  applyTimeline,
};
