'use strict';

const path = require('path');
const { createFinding } = require('../../report/finding');
const { deriveRenderedText, buildPublishedNameIndex, alignStrippedToSource } = require('./textmodel');
const pinned = require('../../generator/pinned');
const { hubBodyWithheld } = require('../sessionmodel');

/** Count of `\n` in `text` before `offset`, i.e. the 0-based line index `offset` falls on. */
function lineIndexForOffset(text, offset) {
  let count = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Unicode- and punctuation-aware whole-word match: a plain \b breaks on apostrophes/hyphens inside the name itself. */
function findWholeWordOccurrences(text, name) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu');
  const hits = [];
  let m;
  while ((m = pattern.exec(text))) {
    hits.push(m.index);
    if (m[0].length === 0) pattern.lastIndex++; // guard against zero-length matches looping forever
  }
  return hits;
}

function isDistinctiveAlias(alias) {
  const trimmed = String(alias).trim();
  if (trimmed.length < 3) return false;
  if (/^[a-z]/.test(trimmed)) return false; // "the scout", "a rival" style generic alias
  if (/^(the|a|an)\s+/i.test(trimmed)) return false; // "The Scout" style, capitalised but still an article
  return true;
}

function quoteContext(text, index, name) {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + name.length + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Every candidate hidden name for one `withheld: true` entity: its
 * filename stem, its frontmatter `title` if present, and every distinctive
 * alias (>=3 chars, not a leading-lowercase or leading-article generic
 * description — `isDistinctiveAlias`).
 */
function candidateNamesFor(entity) {
  const title = path.basename(entity.relPath, '.md');
  const names = new Set([title]);
  if (entity.data.title) names.add(String(entity.data.title));
  const aliases = Array.isArray(entity.data.aliases) ? entity.data.aliases : [];
  for (const alias of aliases) {
    if (isDistinctiveAlias(alias)) names.add(String(alias).trim());
  }
  return [...names].filter((n) => n.length >= 3);
}

/**
 * Track D1, Structural decision 2: one computation feeds both
 * runHiddenName and runNameCollision. For every `withheld: true` entity,
 * partitions its candidate names into `hiddenNames` (genuinely hidden —
 * not identical to any published page's own title or alias) and
 * `collisions` (identical to a published page's title or alias). Before
 * D1, a colliding name was simply filtered out of the search and nothing
 * was reported at all (the fail-open this track exists to close);
 * `runNameCollision` now reports each one loudly instead.
 *
 * `hiddenNames` and `collisions[].name` always partition `candidateNames`
 * exactly — every candidate name lands in exactly one bucket, never both,
 * never neither (test: AC-D1-04).
 *
 * @returns {{ entity: object, candidateNames: string[], hiddenNames: string[],
 *   collisions: { name: string, page: object, via: 'title'|'alias' }[] }[]}
 */
function collectWithheldNames(ctx) {
  const publishedByName = buildPublishedNameIndex(ctx.publishSet.publishedPages);
  const withheldEntities = ctx.index.files.filter((f) => f.ok && f.data.withheld === true);

  return withheldEntities.map((entity) => {
    const candidateNames = candidateNamesFor(entity);
    const hiddenNames = [];
    const collisions = [];
    for (const name of candidateNames) {
      const match = publishedByName.get(pinned.canonicalNfc(name).toLowerCase());
      if (match) {
        collisions.push({ name, page: match.page, via: match.via });
      } else {
        hiddenNames.push(name);
      }
    }
    return { entity, candidateNames, hiddenNames, collisions };
  });
}

/**
 * Track D1: a withheld entity's name collides with a published page's own
 * title or alias. Before this check existed, `runHiddenName` simply
 * dropped any hidden name that was also a published name from its search
 * (silent fail-open: the one case a leak check must never go quiet on).
 * Once a name is ambiguous — it could denote either the public page or the
 * secret entity — continuing to search for it as a hidden-name leak is not
 * meaningful either way, so this reports the ambiguity itself as an ERROR
 * instead, naming both files, the colliding name, and whether the match
 * was via the published page's title or one of its aliases. When the
 * withheld entity IS the matched published page (it was marked withheld
 * but never removed from the manifest), `data.selfPublished` is true and
 * the message says so in words.
 */
function runNameCollision(ctx) {
  const findings = [];

  for (const { entity, collisions } of collectWithheldNames(ctx)) {
    for (const { name, page, via } of collisions) {
      const selfPublished = page.relPath === entity.relPath;
      const message = selfPublished
        ? `${entity.relPath}: withheld name "${name}" is the ${via} of its own published page (${page.relPath}) — the withheld entity is itself published`
        : `${entity.relPath}: withheld name "${name}" collides with published page ${page.relPath}'s ${via}, so it cannot be searched for as a hidden-name leak`;
      findings.push(
        createFinding({
          id: 'leak/l4-name-collision',
          severity: 'error',
          category: 'leak',
          campaign: ctx.campaign,
          path: entity.relPath,
          line: null,
          outputPath: page.outputPath,
          message,
          data: { hiddenName: name, withheldEntity: entity.relPath, publishedPath: page.relPath, via, selfPublished },
        }),
      );
    }
  }

  return findings;
}

/**
 * L4: a `withheld: true` entity's name appears in published rendered text.
 * Decisions Addendum section 1 narrows this from every `source: prep`
 * entity (629 pairs on the real vault) to only entities explicitly marked
 * withheld (roughly two dozen), because most unmet NPCs are not secrets.
 *
 * Hidden-name set per withheld entity comes from `collectWithheldNames`
 * (Track D1): a candidate name that collides with a published page's own
 * title or alias is reported by `runNameCollision` instead and excluded
 * from this search entirely (FR-02 — the two never overlap).
 *
 * Track D3: every arm reads the pin's own rendered text, never raw
 * markdown — `rendered.bodyText`/`rendered.storyText` (Structural decision
 * 4). A withheld name only under an excluded section, only inside a
 * gm-only/spoiler block, an HTML comment, an excluded callout, a dataview
 * block, the author's leading H1, or a section a `publish: stub` page
 * never included, is correctly absent from these and gives no finding —
 * the false positives that kept the real vault's count at 39 through every
 * prior commit. A name inside a fenced code block still renders and still
 * fires (fences survive the strip chain).
 *
 * Three arms, in precedence order body > story > frontmatter (FR-06): at
 * most one finding per (page, name), the first arm that actually contains
 * it.
 *
 * - **Body.** `rendered.bodyText`, loop-inverted so `deriveRenderedText`
 *   runs once per page rather than once per (page, withheld entity) — the
 *   NFR-05 win the Architect surfaced (`l4.js:76-77`, pre-D3, ran it inside
 *   the withheld-entity loop). The hit's line is found by
 *   `alignStrippedToSource(page.markdown, rendered.bodyText)` against the
 *   RAW source body (Structural decision 7 — never the stub-reduced text),
 *   plus `page.bodyLineOffset` for the frontmatter gray-matter consumed.
 *   Alignment failure never suppresses the finding (Structural decision
 *   6): `line: null` instead of a guess.
 * - **Story.** A PC's paired `_Story.md` renders in TWO places (the
 *   Architect's other finding before this brief): `story/characters/<slug>.html`
 *   AND inlined into the PC's own page (`lib/build.js:856-942,1253-1255`).
 *   Before D3 this path was a total fail-open — `page.storyMarkdown` was
 *   never searched at all. `path` is `page.storyRelPath`, `line` uses
 *   `page.storyLineOffset`, and `data.renderedAt` names both output paths
 *   because both really do carry the text.
 * - **Frontmatter.** Unchanged from D1: `rendered.frontmatterText` reads
 *   through the pin's own publishedFrontmatter (lib/processor.js:1099-1132,
 *   required via src/generator/pinned.js): a withheld name reachable ONLY
 *   through a gm_only relationship edge or a publish_exclude_fields field
 *   is already absent from frontmatterText, so it gives no finding here.
 *   `line` is always `null` — frontmatter text has no single source line.
 */
function runHiddenName(ctx) {
  const withheldList = collectWithheldNames(ctx).filter((row) => row.hiddenNames.length > 0);
  if (withheldList.length === 0) return [];

  const findings = [];

  for (const page of ctx.publishSet.publishedPages) {
    const rendered = deriveRenderedText(page, ctx.publishSet.publishConfig, { bodyWithheld: hubBodyWithheld(ctx, page) });
    let bodyAlignment = null;
    let storyAlignment = null;

    for (const { entity, hiddenNames } of withheldList) {
      for (const name of hiddenNames) {
        const bodyHits = findWholeWordOccurrences(rendered.bodyText, name);
        if (bodyHits.length > 0) {
          if (bodyAlignment === null) {
            bodyAlignment = alignStrippedToSource(page.markdown, rendered.bodyText);
          }
          const lineIdx = lineIndexForOffset(rendered.bodyText, bodyHits[0]);
          const mapped = bodyAlignment[lineIdx];
          findings.push(
            createFinding({
              id: 'leak/l4-hidden-name',
              severity: 'error',
              category: 'leak',
              campaign: ctx.campaign,
              path: page.relPath,
              line: mapped == null ? null : page.bodyLineOffset + mapped,
              outputPath: page.outputPath,
              message: `${page.relPath}: withheld name "${name}" (from ${entity.relPath}) appears in published text`,
              detail: quoteContext(rendered.bodyText, bodyHits[0], name),
              data: { hiddenName: name, withheldEntity: entity.relPath, arm: 'body' },
            }),
          );
          continue;
        }

        if (page.storyMarkdown && rendered.storyText) {
          const storyHits = findWholeWordOccurrences(rendered.storyText, name);
          if (storyHits.length > 0) {
            if (storyAlignment === null) {
              storyAlignment = alignStrippedToSource(page.storyMarkdown, rendered.storyText);
            }
            const lineIdx = lineIndexForOffset(rendered.storyText, storyHits[0]);
            const mapped = storyAlignment[lineIdx];
            findings.push(
              createFinding({
                id: 'leak/l4-hidden-name',
                severity: 'error',
                category: 'leak',
                campaign: ctx.campaign,
                path: page.storyRelPath,
                line: mapped == null ? null : page.storyLineOffset + mapped,
                outputPath: page.outputPath,
                message: `${page.storyRelPath}: withheld name "${name}" (from ${entity.relPath}) appears in the published story body`,
                detail: quoteContext(rendered.storyText, storyHits[0], name),
                data: {
                  hiddenName: name,
                  withheldEntity: entity.relPath,
                  arm: 'story',
                  renderedAt: [page.outputPath, page.storyOutputPath],
                },
              }),
            );
            continue;
          }
        }

        const otherHits = findWholeWordOccurrences(rendered.frontmatterText, name);
        if (otherHits.length > 0) {
          findings.push(
            createFinding({
              id: 'leak/l4-hidden-name',
              severity: 'error',
              category: 'leak',
              campaign: ctx.campaign,
              path: page.relPath,
              line: null,
              outputPath: page.outputPath,
              message: `${page.relPath}: withheld name "${name}" (from ${entity.relPath}) appears in published frontmatter/relationship text`,
              detail: quoteContext(rendered.frontmatterText, otherHits[0], name),
              data: { hiddenName: name, withheldEntity: entity.relPath, arm: 'frontmatter' },
            }),
          );
        }
      }
    }
  }

  return findings;
}

module.exports = {
  runHiddenName,
  runNameCollision,
  collectWithheldNames,
  findWholeWordOccurrences,
  isDistinctiveAlias,
};
