'use strict';

const { createFinding } = require('../report/finding');
const { parseRequiredRelationships } = require('../vault/entitytypes');
const { stripBrackets } = require('../vault/links');
const pinned = require('../generator/pinned');

// The required relationship TYPES are read from _meta/entity-types.md's own
// "Required relationships" table (src/vault/entitytypes.js), not hardcoded
// here: they must appear somewhere in an entity's `relationships:` array,
// not as a top-level frontmatter field.

function hasRelationshipType(frontmatter, relType) {
  const rels = frontmatter.relationships;
  if (!Array.isArray(rels)) return false;
  return rels.some((r) => r && r.type === relType);
}

const NO_TABLE_REASON_MESSAGE = {
  'no-file': '_meta/entity-types.md does not exist',
  'parse-error': "_meta/entity-types.md's frontmatter failed to parse",
  'no-table': '_meta/entity-types.md has no "Required relationships" table',
};

/** relationship/missing-required: table-driven per _meta/entity-types.md (P1-FR03/FR04). */
function runMissingRequired(ctx) {
  const table = parseRequiredRelationships(ctx.vaultPath);
  if (!table.ok) {
    return [
      createFinding({
        id: 'relationship/missing-required',
        severity: 'info',
        category: 'frontmatter',
        campaign: ctx.campaign,
        message: `${NO_TABLE_REASON_MESSAGE[table.reason]}; relationship/missing-required requires nothing`,
      }),
    ];
  }

  const findings = [];
  for (const f of ctx.index.files) {
    if (!f.ok || !f.data.type) continue;
    const required = table.requiredByType.get(String(f.data.type));
    if (!required) continue;
    for (const relType of required) {
      if (hasRelationshipType(f.data, relType)) continue;
      findings.push(
        createFinding({
          id: 'relationship/missing-required',
          severity: 'warn',
          category: 'frontmatter',
          campaign: ctx.campaign,
          path: f.relPath,
          message: `${f.relPath}: type "${f.data.type}" has no "${relType}" relationship`,
          data: { type: f.data.type, required: relType },
        }),
      );
    }
  }
  return findings;
}

// --- relationship/unknown-predicate (ADR 0037, SD-3 to SD-6) ---------------
//
// Checks every relationship edge's predicate word against the vault's own
// _meta/relationship-types.md (ctx.relationshipTypes, src/vault/relationshiptypes.js),
// read once per check context (src/checks/context.js) rather than here.

const NO_VOCAB_REASON_MESSAGE = {
  'no-file': '_meta/relationship-types.md does not exist',
  'parse-error': "_meta/relationship-types.md's frontmatter failed to parse",
  'no-table': '_meta/relationship-types.md has no table with a "Types" column',
  'empty-table': '_meta/relationship-types.md\'s "Types" column lists no words',
};

// SD-5: a fixed, generic hint attached to every WARN that has no near-miss
// suggestion (owner decision A: no reverse-word or synonym table).
const GENERIC_HINT =
  'Use the closest word from that list; if this word describes the link from the other side, put the listed word on the other note instead, so the relationship is stored once, from one end.';

/** SD-4: case, whitespace and hyphen/underscore folding for near-miss suggestions. Never toLocaleLowerCase (no Intl). */
function normalisePredicate(p) {
  return String(p).trim().toLowerCase().replace(/[\s-]/g, '_');
}

/** SD-4: Map<normalised key, string[] of distinct vocabulary words>, built once per run. */
function buildSuggestionIndex(words) {
  const map = new Map();
  for (const w of words) {
    const key = normalisePredicate(w);
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    if (!list.includes(w)) list.push(w);
  }
  return map;
}

/** SD-4: suggest the single candidate only when the predicate's normalised key maps to exactly one word. */
function suggestionFor(predicate, suggestionIndex) {
  const candidates = suggestionIndex.get(normalisePredicate(predicate));
  return candidates && candidates.length === 1 ? candidates[0] : null;
}

/**
 * SD-3: every relationship edge a typed, parsed file declares, in the array
 * or object (map) form. No filter on gm_only, on whether the target
 * resolves, or on the target being present (FR-05, FR-09).
 */
function relationshipEdges(data) {
  const edges = [];
  const rels = data.relationships;

  if (Array.isArray(rels)) {
    for (let i = 0; i < rels.length; i++) {
      const r = rels[i];
      if (r === null || typeof r !== 'object' || Array.isArray(r)) continue; // not a plain object
      if (r.type === undefined || r.type === null || String(r.type) === '') continue;
      edges.push({
        predicate: String(r.type),
        target: r.target == null ? null : stripBrackets(r.target),
        index: i,
        form: 'array',
      });
    }
  } else if (rels && typeof rels === 'object') {
    let n = 0;
    for (const [key, value] of Object.entries(rels)) {
      const targets = Array.isArray(value) ? value : [value];
      for (const t of targets) {
        edges.push({
          predicate: key,
          target: t == null ? null : stripBrackets(t),
          index: n,
          form: 'object',
        });
        n++;
      }
    }
  }

  return edges;
}

/** relationship/unknown-predicate: every edge whose predicate isn't exactly on the vault's own word list (ADR 0037). */
function runUnknownPredicate(ctx) {
  const types = ctx.relationshipTypes;

  if (!types.ok) {
    return [
      createFinding({
        id: 'relationship/unknown-predicate',
        severity: 'info',
        category: 'frontmatter',
        campaign: ctx.campaign,
        message: `${NO_VOCAB_REASON_MESSAGE[types.reason]}; relationship words were not checked`,
        data: { reason: types.reason },
      }),
    ];
  }

  const suggestionIndex = buildSuggestionIndex(types.words);
  const findings = [];

  for (const f of ctx.index.files) {
    if (!f.ok || !f.data.type) continue;

    for (const edge of relationshipEdges(f.data)) {
      if (types.words.has(edge.predicate)) continue; // exact, case-sensitive match (FR-06)

      const suggestion = suggestionFor(edge.predicate, suggestionIndex);
      const n = edge.index + 1;
      const targetText = edge.target === null || edge.target === '' ? 'no target' : `to "${edge.target}"`;
      const base = `${f.relPath}: relationship ${n} (${targetText}) uses "${edge.predicate}", which is not in _meta/relationship-types.md.`;
      const message = suggestion ? `${base} Did you mean "${suggestion}"?` : `${base} ${GENERIC_HINT}`;

      findings.push(
        createFinding({
          id: 'relationship/unknown-predicate',
          severity: 'warn',
          category: 'frontmatter',
          campaign: ctx.campaign,
          path: f.relPath,
          line: null,
          message,
          data: { predicate: edge.predicate, target: edge.target, index: edge.index, form: edge.form, suggestion },
        }),
      );
    }
  }

  return findings;
}

// --- relationship/gm-only-value --------------------------------------------
//
// Will catch: every gm_only value that is not true or false on an array-form
// edge of a typed note. The pinned generator hides an edge only for exactly
// true or the string "true" (lib/processor.js:1085-1087), so yes, on, "True",
// 1 or an empty value all publish it. The severity is decided by the pin
// itself: pinned.publishedFrontmatter is run on the page with the same
// exclude_fields and per-file overrides the build uses, and the edge is an
// ERROR only if it survives that filter on a published page. WARN otherwise.
//
// Will not catch, deliberately:
//   - Object-form (map) relationships, which have no per-edge flag.
//   - The edge's type word in built output. No output-side check searches
//     relationship words; leak/l4-output-name searches only withheld names.
//   - Quoted versus unquoted: yes and "yes" parse to the same value, so they
//     cannot be told apart after parsing (and are not re-read from raw YAML).
//   - A target-less edge on a published page is still an ERROR, although
//     renderRelationships skips it. This is a known over-report.

/** Accepted gm_only values: the check's own rule, not the pin's verdict. */
function isAcceptedGmOnly(v) {
  return v === true || v === false || v === 'true' || v === 'false';
}

/** The value as the GM wrote it, for messages. Never throws. */
function shownGmOnly(v) {
  try {
    if (v === null || v === undefined) return 'nothing';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const j = JSON.stringify(v);
    return j === undefined ? String(v) : j;
  } catch (_) {
    return String(v);
  }
}

/** relationship/gm-only-value: any array-form edge whose gm_only is not true or false. */
function runGmOnlyValue(ctx) {
  const pc = ctx.publishSet.publishConfig;
  const pages = new Map();
  for (const page of ctx.publishSet.publishedPages) pages.set(page.relPath, page);

  const findings = [];
  for (const f of ctx.index.files) {
    if (!f.ok || !f.data.type) continue;

    let flagged = null;
    for (const edge of relationshipEdges(f.data)) {
      if (edge.form !== 'array') continue;
      const entry = f.data.relationships[edge.index];
      if (!Object.prototype.hasOwnProperty.call(entry, 'gm_only')) continue;
      if (isAcceptedGmOnly(entry.gm_only)) continue;
      (flagged = flagged || []).push({ edge, value: entry.gm_only });
    }
    if (!flagged) continue;

    // Ask the pin once per file; element identity comes from the page's own parse.
    const page = pages.get(f.relPath);
    let out = null;
    if (page) {
      const overridesForFile = (pc.overrides && pc.overrides.fields && pc.overrides.fields[page.rel]) || {};
      out = pinned.publishedFrontmatter(page.frontmatter, pc.exclude_fields, overridesForFile);
    }

    for (const { edge, value } of flagged) {
      const published =
        !!page &&
        Array.isArray(out.relationships) &&
        Array.isArray(page.frontmatter.relationships) &&
        out.relationships.includes(page.frontmatter.relationships[edge.index]);
      const shown = shownGmOnly(value);
      const n = edge.index + 1;
      const targetText = edge.target === null || edge.target === '' ? 'no target' : `to "${edge.target}"`;
      const head = `${f.relPath}: relationship ${n} (${targetText}) has gm_only set to ${shown}, which is not true or false`;
      const fix = 'Write gm_only: true to hide it, or remove gm_only to show it.';
      const message = published
        ? `${head}, so the build publishes this relationship. ${fix}`
        : `${head}. This relationship is not published today, but only gm_only: true is sure to hide it. ${fix}`;

      findings.push(
        createFinding({
          id: 'relationship/gm-only-value',
          severity: published ? 'error' : 'warn',
          category: 'frontmatter',
          campaign: ctx.campaign,
          path: f.relPath,
          line: null,
          message,
          data: { predicate: edge.predicate, target: edge.target, index: edge.index, value: shown, published },
        }),
      );
    }
  }
  return findings;
}

module.exports = { runMissingRequired, runUnknownPredicate, runGmOnlyValue };
