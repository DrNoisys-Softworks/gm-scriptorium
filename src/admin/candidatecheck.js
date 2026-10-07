'use strict';

const { ScriptoriumError } = require('../util/errors');
// Every dependency below is called through its module object (never destructured at require
// time), so a test can inject a throw or a wrong return value deterministically at exactly one
// call site (SD-92; the same convention src/admin/handlers/vaultconfig.js already follows).
const read = require('../vault/read');
const checkcli = require('../cli/check');
const publishset = require('../vault/publishset');
const vaultconfigwrite = require('../vault/vaultconfigwrite');

/*
 * V1e-9 (ADR 0041, SD-92): runs a real `check` against an edited copy of _meta/vault-config.md
 * that is never written to disk, by handing the candidate's bytes to src/vault/read.js's one-file
 * overlay (SD-90) for the length of one check run. The panel compares that run with one over the
 * file as it is now, and only ever shows what is NEW -- the "equivalence oracle" this module's
 * own tests (test/admin-candidate-check.test.js) hold it to is that a candidate's findings are
 * exactly what a real check would report if the candidate had actually been written.
 *
 * Never writes. The overlay itself is cleared in SD-90's own `finally`, so there is no cleanup
 * I/O here either.
 */

/** frontmatter/non-yaml-language and frontmatter/parse-error: no "Save anyway" tick overrides these. */
const UNFORCEABLE_IDS = Object.freeze(['frontmatter/non-yaml-language', 'frontmatter/parse-error']);

const VAULT_CONFIG_REL = '_meta/vault-config.md';

/** The first this many "new" findings are shown in full; the rest are only counted. */
const NEW_FINDINGS_CAP = 50;

/**
 * Finding ids whose message is never redacted for vault-config.md, because they are specifically
 * about this file (or its own divergence from the json-side config) and the message itself is
 * already the useful part of what the panel shows.
 */
const MESSAGE_KEEP_IDS = Object.freeze([
  'frontmatter/non-yaml-language',
  'frontmatter/parse-error',
  'frontmatter/missing-type',
  'config/exclude-sections-divergence',
  'config/exclude-dirs-divergence',
  'config/exclude-fields-divergence',
  'config/theme-scheme-mismatch',
]);

const REDACTED_MESSAGE = 'Check reports this for vault-config.md. Run Check after saving to see the detail.';

const HITS_MESSAGE = 'The check on the edited copy did not read it, so the panel will not trust the result.';

class CandidateCheckError extends ScriptoriumError {}

/**
 * @param {{id, severity, path, line, message, detail?, data?, human?}} finding
 * @returns {{id, severity, path, line, message}} `detail`, `data` and `human` are never returned.
 *   The message becomes REDACTED_MESSAGE when the finding is about vault-config.md itself and its
 *   id isn't in MESSAGE_KEEP_IDS.
 */
function redact(finding) {
  const redactThis = finding.path === VAULT_CONFIG_REL && !MESSAGE_KEEP_IDS.includes(finding.id);
  return {
    id: finding.id,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    message: redactThis ? REDACTED_MESSAGE : finding.message,
  };
}

function findingKey(f) {
  return [f.id, f.path, f.severity, f.message].join('\u0000');
}

/**
 * A multiset difference, `candidate` minus `baseline` (`baseline` treated as `[]` when null),
 * keyed `id\u0000path\u0000severity\u0000message`. Returns full (unredacted) finding objects, in
 * `candidate`'s own order (the envelope is already sorted deterministically).
 *
 * @param {object[]|null} baseline
 * @param {object[]} candidate
 * @returns {object[]}
 */
function diffFindings(baseline, candidate) {
  const counts = new Map();
  for (const f of baseline || []) {
    const k = findingKey(f);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = [];
  for (const f of candidate) {
    const k = findingKey(f);
    const remaining = counts.get(k) || 0;
    if (remaining > 0) {
      counts.set(k, remaining - 1);
    } else {
      out.push(f);
    }
  }
  return out;
}

/**
 * Runs the candidate check under the overlay, catching a throw from the check itself so `hits` is
 * always available regardless of whether the check run succeeded.
 *
 * @returns {{ value: {ok:true, result:object} | {ok:false, message:string}, hits: number }}
 */
function runCandidateCheck(ctx, target, candidateBytes) {
  return read.withCandidateFile(target, candidateBytes, () => {
    try {
      return { ok: true, result: checkcli.runCheckForContextWithContext(ctx.ctxInfo, {}, {}) };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
}

/**
 * @param {object} ctx an admin context (only `ctx.vaultPath` and `ctx.ctxInfo` are read)
 * @param {{ candidateBytes: Buffer, withCheck: boolean }} opts
 * @returns {{ jsonConfig: object|null, jsonError: string|null, curPublish: object,
 *   candPublish: object, candPublishSet: object|null,
 *   check: null | { ran:false, message:string } | { ran:true, exitCode:number, counts:object,
 *     newFindings:object[], newCount:number, newErrorCount:number, unforceable:object[] } }}
 * @throws {CandidateCheckError} the overlay was never actually read (`hits < 1`): the panel will
 *   not trust a result it cannot prove came from the candidate.
 */
function runReview(ctx, { candidateBytes, withCheck }) {
  const target = vaultconfigwrite.targetPathFor(ctx.vaultPath);

  let jsonConfig = null;
  let jsonError = null;
  try {
    jsonConfig = checkcli.resolveVaultContext(ctx.ctxInfo).jsonConfig;
  } catch (err) {
    jsonError = err.message;
  }

  const curPublish = publishset.loadPublishConfig(ctx.vaultPath, jsonConfig || {});

  const { value: candPublish, hits: publishHits } = read.withCandidateFile(target, candidateBytes, () =>
    publishset.loadPublishConfig(ctx.vaultPath, jsonConfig || {}),
  );
  if (publishHits < 1) {
    throw new CandidateCheckError(HITS_MESSAGE);
  }

  let check = null;
  let candPublishSet = null;

  if (withCheck) {
    let baseline = null;
    try {
      baseline = checkcli.runCheckForContextWithContext(ctx.ctxInfo, {}, {});
    } catch {
      baseline = null;
    }

    const { value: candOutcome, hits: checkHits } = runCandidateCheck(ctx, target, candidateBytes);
    if (checkHits < 1) {
      throw new CandidateCheckError(HITS_MESSAGE);
    }

    if (!candOutcome.ok) {
      check = { ran: false, message: candOutcome.message };
    } else {
      const candidateResult = candOutcome.result;
      const baselineFindings = baseline ? baseline.envelope.findings : [];
      const newFindingsRaw = diffFindings(baselineFindings, candidateResult.envelope.findings);
      const newErrorCount = newFindingsRaw.filter((f) => f.severity === 'error').length;
      const unforceable = candidateResult.envelope.findings
        .filter((f) => UNFORCEABLE_IDS.includes(f.id) && f.path === VAULT_CONFIG_REL)
        .map(redact);
      check = {
        ran: true,
        exitCode: candidateResult.exitCode,
        counts: candidateResult.envelope.counts,
        newFindings: newFindingsRaw.slice(0, NEW_FINDINGS_CAP).map(redact),
        newCount: newFindingsRaw.length,
        newErrorCount,
        unforceable,
      };
      candPublishSet = candidateResult.checkCtx.publishSet;
    }
  }

  return { jsonConfig, jsonError, curPublish, candPublish, candPublishSet, check };
}

module.exports = {
  UNFORCEABLE_IDS,
  VAULT_CONFIG_REL,
  NEW_FINDINGS_CAP,
  MESSAGE_KEEP_IDS,
  REDACTED_MESSAGE,
  CandidateCheckError,
  redact,
  diffFindings,
  runReview,
};
