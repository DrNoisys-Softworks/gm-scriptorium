'use strict';

/*
 * The Finding shape. Frozen in phase 1 (Engineering Brief section 9):
 * every check, in every phase-2 module, and the build pipeline's captured
 * render errors, all produce this same shape so both renderers (human,
 * json) and the sort/determinism rules in this file apply uniformly.
 *
 * {
 *   id,          stable, greppable, never renumbered (e.g. "leak/l4-hidden-name")
 *   severity,    "error" | "warn" | "info"
 *   category,    "leak" | "link" | "frontmatter" | "config" | "graph" | "census" | "build"
 *   campaign,
 *   path,        vault-relative, POSIX separators, or null
 *   line,        1-based, or null
 *   outputPath,  set when the finding is about built output, else null
 *   message,     one line, names campaign/path/what
 *   detail,      optional, quoted context
 *   data         typed per check id
 * }
 */

const SEVERITIES = Object.freeze(['error', 'warn', 'info']);
const CATEGORIES = Object.freeze([
  'leak',
  'link',
  'frontmatter',
  'config',
  'graph',
  'census',
  'build',
]);

// Sort rank for severity: error first, then warn, then info. Used both by
// the --json envelope's determinism requirement and by any human-readable
// summary that wants the worst news first.
const SEVERITY_RANK = Object.freeze({ error: 0, warn: 1, info: 2 });

class FindingValidationError extends Error {}

function assertValidFinding(f) {
  const missing = ['id', 'severity', 'category', 'campaign', 'message'].filter(
    (k) => f[k] === undefined || f[k] === null || f[k] === '',
  );
  if (missing.length > 0) {
    throw new FindingValidationError(
      `finding is missing required field(s): ${missing.join(', ')}`,
    );
  }
  if (!SEVERITIES.includes(f.severity)) {
    throw new FindingValidationError(
      `finding "${f.id}" has invalid severity "${f.severity}", must be one of ${SEVERITIES.join(', ')}`,
    );
  }
  if (!CATEGORIES.includes(f.category)) {
    throw new FindingValidationError(
      `finding "${f.id}" has invalid category "${f.category}", must be one of ${CATEGORIES.join(', ')}`,
    );
  }
  if (f.line !== null && f.line !== undefined && !(Number.isInteger(f.line) && f.line >= 1)) {
    throw new FindingValidationError(
      `finding "${f.id}" has invalid line "${f.line}", must be a 1-based integer or null`,
    );
  }
}

/**
 * Build a validated Finding. Fields not supplied default to null so every
 * Finding object has every key, which keeps the json renderer's output
 * shape stable regardless of which check produced it.
 */
function createFinding(fields) {
  const finding = {
    id: fields.id,
    severity: fields.severity,
    category: fields.category,
    campaign: fields.campaign,
    path: fields.path ?? null,
    line: fields.line ?? null,
    outputPath: fields.outputPath ?? null,
    message: fields.message,
    detail: fields.detail ?? null,
    data: fields.data ?? {},
  };
  assertValidFinding(finding);
  return finding;
}

/**
 * The sort the --json envelope and any deterministic summary must apply:
 * (severity rank, id, path, line, message). Two `check` runs against an
 * unchanged vault must produce byte-identical `findings` arrays; this
 * comparator is the one place that ordering is decided, so nothing else
 * may re-sort findings a different way.
 */
function compareFindings(a, b) {
  const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (rankDiff !== 0) return rankDiff;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  const pathA = a.path ?? '';
  const pathB = b.path ?? '';
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  const lineA = a.line ?? -1;
  const lineB = b.line ?? -1;
  if (lineA !== lineB) return lineA - lineB;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

function sortFindings(findings) {
  return [...findings].sort(compareFindings);
}

module.exports = {
  SEVERITIES,
  CATEGORIES,
  SEVERITY_RANK,
  FindingValidationError,
  createFinding,
  compareFindings,
  sortFindings,
};
