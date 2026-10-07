'use strict';

const { createFinding } = require('../report/finding');
const { scanFrontmatterFences } = require('../vault/fencescan');
const { FrontmatterLanguageError } = require('../util/errors');

const NON_YAML_LANGUAGE_ID = 'frontmatter/non-yaml-language';

/** frontmatter/parse-error: gray-matter failed to parse a file's frontmatter (scanner.js silently skips it). */
function runParseError(ctx) {
  const findings = [];
  for (const f of ctx.index.files) {
    if (f.ok) continue;
    // ADR 0034 / SD-6: a refused (non-YAML) fence is reported once, as
    // frontmatter/non-yaml-language, never a second time here.
    if (f.error instanceof FrontmatterLanguageError) continue;
    findings.push(
      createFinding({
        id: 'frontmatter/parse-error',
        severity: 'error',
        category: 'frontmatter',
        campaign: ctx.campaign,
        path: f.relPath,
        message: `${f.relPath}: frontmatter failed to parse (${f.error.message})`,
        detail: f.error.message,
      }),
    );
  }
  return findings;
}

/**
 * ADR 0034 / FR-FM-05: one finding per file, across the whole vault (FR-FM-04's walk set, a
 * documented superset of every generator parse site), whose opening frontmatter fence declares a
 * language other than YAML. Uses the SAME predicate and the SAME walk set the build guard uses
 * (src/build/run.js), so a clean `check` means the build guard will pass.
 *
 * @param {{ vaultPath: string, campaign: string }} opts
 * @returns {object[]} Finding[], sorted by relPath (scanFrontmatterFences' own sort)
 * @throws {VaultReadError} propagated unchanged from the underlying walk
 */
function nonYamlLanguageFindings({ vaultPath, campaign }) {
  const fences = scanFrontmatterFences(vaultPath);
  return fences.map(({ relPath, tag, reason }) =>
    createFinding({
      id: NON_YAML_LANGUAGE_ID,
      severity: 'error',
      category: 'frontmatter',
      campaign,
      path: relPath,
      detail: null,
      data: { tag, reason },
      message:
        reason === 'unterminated'
          ? `${relPath}: the first line after the opening --- has no line break within 65536 bytes, so Scriptorium cannot confirm the frontmatter is YAML; it will not read or build this file`
          : `${relPath}: frontmatter declares the language "${tag}" after its opening ---; Scriptorium reads YAML frontmatter only and will not read or build this file`,
    }),
  );
}

/** The check-registry runner (src/checks/registry.js, src/checks/run.js's RUNNERS). */
function runNonYamlLanguage(ctx) {
  return nonYamlLanguageFindings({ vaultPath: ctx.vaultPath, campaign: ctx.campaign });
}

/** frontmatter/missing-type: a file has no frontmatter `type` (lib/scanner.js:117 silently skips it). */
function runMissingType(ctx) {
  const findings = [];
  for (const f of ctx.index.files) {
    if (!f.ok) continue; // already reported by frontmatter/parse-error
    if (f.data.type) continue;
    findings.push(
      createFinding({
        id: 'frontmatter/missing-type',
        severity: 'error',
        category: 'frontmatter',
        campaign: ctx.campaign,
        path: f.relPath,
        message: `${f.relPath}: no frontmatter "type"; the generator silently skips this file`,
      }),
    );
  }
  return findings;
}

module.exports = { runParseError, runMissingType, NON_YAML_LANGUAGE_ID, nonYamlLanguageFindings, runNonYamlLanguage };
