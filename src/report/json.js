'use strict';

const { sortFindings } = require('./finding');

/*
 * The --json envelope. Frozen in phase 1 (Engineering Brief section 9):
 *
 * {
 *   schemaVersion: 1,
 *   tool: { name, version },
 *   campaign, vaultPath, outputPath,
 *   generatedAt,
 *   counts: { error, warn, info },
 *   findings: [ ... ]
 * }
 *
 * Determinism: findings are sorted before emitting (see finding.js), and
 * two runs against an unchanged vault must produce a byte-identical
 * `findings` array. `generatedAt` is the only field permitted to vary.
 */

const SCHEMA_VERSION = 1;

function countBySeverity(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  return counts;
}

/**
 * @param {object} opts
 * @param {{name: string, version: string}} opts.tool
 * @param {string} opts.campaign
 * @param {string|null} opts.vaultPath
 * @param {string|null} opts.outputPath
 * @param {object[]} opts.findings
 * @param {() => string} [opts.now] injected clock for deterministic tests
 */
function buildEnvelope({ tool, campaign, vaultPath, outputPath, findings, now }) {
  const sorted = sortFindings(findings);
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: tool.name, version: tool.version },
    campaign,
    vaultPath: vaultPath ?? null,
    outputPath: outputPath ?? null,
    generatedAt: (now || (() => new Date().toISOString()))(),
    counts: countBySeverity(sorted),
    findings: sorted,
  };
}

/**
 * Two envelopes are "the same run" if everything but generatedAt matches.
 * Used by tests, and by anything that wants to confirm a check run is
 * deterministic without caring what second it happened to run in.
 */
function envelopeWithoutTimestamp(envelope) {
  const { generatedAt, ...rest } = envelope;
  return rest;
}

module.exports = { SCHEMA_VERSION, buildEnvelope, envelopeWithoutTimestamp };
