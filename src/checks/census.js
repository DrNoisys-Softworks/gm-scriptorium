'use strict';

const { createFinding } = require('../report/finding');
const { parseRecognisedTypes } = require('../vault/entitytypes');

/** census/type: INFO, a count of pages by frontmatter type. */
function runTypeCensus(ctx) {
  const counts = new Map();
  for (const f of ctx.index.files) {
    if (!f.ok || !f.data.type) continue;
    const t = String(f.data.type);
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const byType = Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [
    createFinding({
      id: 'census/type',
      severity: 'info',
      category: 'census',
      campaign: ctx.campaign,
      message: `${total} typed file(s) across ${counts.size} type(s)`,
      data: { byType },
    }),
  ];
}

/** census/unrecognised-type: WARN per file whose type is outside the recognised union. */
function runUnrecognisedType(ctx) {
  const recognised = parseRecognisedTypes(ctx.vaultPath);
  const findings = [];
  for (const f of ctx.index.files) {
    if (!f.ok || !f.data.type) continue;
    const t = String(f.data.type);
    if (recognised.has(t)) continue;
    findings.push(
      createFinding({
        id: 'census/unrecognised-type',
        severity: 'warn',
        category: 'census',
        campaign: ctx.campaign,
        path: f.relPath,
        message: `${f.relPath}: type "${t}" is not in the recognised union (hierarchy + folder-mapping + character-story)`,
        data: { type: t },
      }),
    );
  }
  return findings;
}

module.exports = { parseRecognisedTypes, runTypeCensus, runUnrecognisedType };
