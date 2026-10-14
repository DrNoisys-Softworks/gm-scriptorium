'use strict';

/*
 * One shared reader for the documentation criteria. The table in docs/WRITING-DOCS.md is the
 * single list of pages written for GMs; the tests that check those pages all read it from here.
 * Pure functions over text, except userDocFiles, which reads the criteria page.
 */

const fs = require('fs');
const path = require('path');

const SECTIONS = ['Tutorial', 'How-to guides', 'Reference', 'Explanation'];

/**
 * The index's four sections, each with the repo-relative POSIX paths it links to. Links resolve
 * from `docs/`; a `#fragment` is stripped and a link with a URI scheme is skipped.
 */
function indexSections(indexText) {
  const out = new Map(SECTIONS.map((s) => [s, []]));
  let current = null;
  for (const line of indexText.split('\n')) {
    const h = line.match(/^##\s+(.*?)\s*$/);
    if (h) {
      current = out.has(h[1]) ? h[1] : null;
      continue;
    }
    if (!current) continue;
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      out.get(current).push(path.posix.normalize(path.posix.join('docs', target)));
    }
  }
  return out;
}

/** Rows of the first table under `## The user pages`: `[{ file, section, stepsRunOn }]`. */
function criteriaRows(writingDocsText) {
  const lines = writingDocsText.split('\n');
  const start = lines.findIndex((l) => /^##\s+The user pages\s*$/.test(l));
  if (start === -1) return [];
  const rows = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0].replace(/[:\s]/g, '')) || cells[0] === 'Page') continue;
    const link = cells[0].match(/\]\(([^)]+)\)/);
    if (!link) continue;
    const target = link[1].split('#')[0];
    rows.push({
      file: path.posix.normalize(path.posix.join('docs', target)),
      section: cells[1],
      stepsRunOn: cells[2],
    });
  }
  return rows;
}

/** The first non-empty block after the H1, its lines joined with single spaces. */
function firstParagraph(text) {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => /^#\s/.test(l));
  i = i === -1 ? 0 : i + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const block = [];
  while (i < lines.length && lines[i].trim() !== '') block.push(lines[i++].trim());
  return block.join(' ');
}

/** Every page on the criteria table, as repo-relative POSIX paths. */
function userDocFiles(root) {
  const text = fs.readFileSync(path.join(root, 'docs', 'WRITING-DOCS.md'), 'utf8');
  return criteriaRows(text).map((r) => r.file);
}

module.exports = { SECTIONS, indexSections, criteriaRows, firstParagraph, userDocFiles };
