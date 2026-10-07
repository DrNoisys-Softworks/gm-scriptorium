'use strict';

const { createFinding } = require('../report/finding');
const { parseRequiredRelationships } = require('../vault/entitytypes');
const { stripBrackets } = require('../vault/links');

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

module.exports = { runMissingRequired, runUnknownPredicate };
