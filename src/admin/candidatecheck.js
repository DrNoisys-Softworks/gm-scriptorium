'use strict';

const path = require('path');
const { isDeepStrictEqual } = require('util');
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

const VAULT_SETTINGS_REL = '_meta/vault-config.yaml';

const YAML_REDACTED_MESSAGE = 'Check reports this for vault-config.yaml. Run Check after saving to see the detail.';

const HITS_MESSAGE = 'The check on the edited copy did not read it, so the panel will not trust the result.';

class CandidateCheckError extends ScriptoriumError {}

/**
 * @param {{id, severity, path, line, message, detail?, data?, human?}} finding
 * @param {string} [rel] the settings file under review, relative to the vault
 * @returns {{id, severity, path, line, message}} `detail`, `data` and `human` are never returned.
 *   For vault-config.md the message becomes REDACTED_MESSAGE when the finding is about that file
 *   and its id isn't in MESSAGE_KEEP_IDS. For vault-config.yaml it becomes YAML_REDACTED_MESSAGE
 *   when the finding is about that file, unless it is config/settings-fault, the finding that
 *   explains a bad value there. A finding about a vault-config.md left on a moved vault is redacted
 *   by the vault-config.md rule in either case, since its body can hold the GM's notes.
 */
function redact(finding, rel = VAULT_CONFIG_REL) {
  const aboutYaml = rel === VAULT_SETTINGS_REL && finding.path === VAULT_SETTINGS_REL;
  const redactThis = aboutYaml
    ? finding.id !== 'config/settings-fault'
    : finding.path === VAULT_CONFIG_REL && !MESSAGE_KEEP_IDS.includes(finding.id);
  const redacted = aboutYaml ? YAML_REDACTED_MESSAGE : REDACTED_MESSAGE;
  return {
    id: finding.id,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    message: redactThis ? redacted : finding.message,
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

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Entries of folder map `b` that `a` lacks, or maps to another output, as `{folder, output}`. */
function foldersAddedIn(a = {}, b = {}) {
  return Object.entries(b).filter(([folder, output]) => !hasOwn(a, folder) || a[folder] !== output).map(([folder, output]) => ({ folder, output }));
}

/** Entries of folder map `a` that `b` no longer names at all. */
function foldersDroppedFrom(a = {}, b = {}) {
  return Object.entries(a).filter(([folder]) => !hasOwn(b, folder)).map(([folder, output]) => ({ folder, output }));
}

function publishedSetFor(ctx, vaultCtx) {
  return publishset.computePublishedSet(ctx.vaultPath, vaultCtx.jsonConfig, vaultCtx.rawSiteConfig);
}

/**
 * Which pages the site would publish with the file as it is now and with the candidate, each side
 * read the way the generator reads it: the candidate's context is resolved inside the overlay, so
 * its own folder map is the one scanned. Pages are compared by `rel`; folders by the two folder maps
 * (an entry whose output changed counts as added).
 *
 * @returns {{ diff: null | { newlyPublished: {rel, title}[], foldersAdded: {folder, output}[],
 *   foldersRemoved: {folder, output}[] }, reason: string|null }} `diff` is null when either side
 *   cannot be resolved, and `reason` is then the first line of that side's error
 * @throws {CandidateCheckError} the candidate side resolved without ever reading the candidate
 */
function computePublishDiff(ctx, target, candidateBytes) {
  let cur;
  try {
    const curCtx = checkcli.resolveVaultContext(ctx.ctxInfo);
    cur = { folderMap: curCtx.jsonConfig.folderMap, set: publishedSetFor(ctx, curCtx) };
  } catch (err) {
    return { diff: null, reason: firstLineOf(err) };
  }

  const { value: cand, hits } = read.withCandidateFile(target, candidateBytes, () => {
    try {
      const candCtx = checkcli.resolveVaultContext(ctx.ctxInfo);
      return { ok: true, folderMap: candCtx.jsonConfig.folderMap, set: publishedSetFor(ctx, candCtx) };
    } catch (err) {
      return { ok: false, reason: firstLineOf(err) };
    }
  });
  if (!cand.ok) return { diff: null, reason: cand.reason };
  if (hits < 1) {
    throw new CandidateCheckError(HITS_MESSAGE);
  }

  const curRels = new Set(cur.set.publishedPages.map((p) => p.rel));
  const newlyPublished = cand.set.publishedPages
    .filter((p) => !curRels.has(p.rel))
    .map((p) => ({ rel: p.rel, title: p.displayTitle }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    diff: {
      newlyPublished,
      foldersAdded: foldersAddedIn(cur.folderMap, cand.folderMap),
      foldersRemoved: foldersDroppedFrom(cur.folderMap, cand.folderMap),
    },
    reason: null,
  };
}

/** The first line of an error's message, short enough to show the GM. */
function firstLineOf(err) {
  const message = err && typeof err.message === 'string' ? err.message : String(err);
  return message.split(/\r?\n/)[0].trim() || 'no reason given';
}

/**
 * The Review's note when the page comparison failed, so the GM can see why the tick is needed.
 *
 * @param {string|null} reason runReview's `publishDiffReason`
 * @returns {string|null} null when there is nothing to say
 */
function publishDiffNote(reason) {
  return reason ? `The page comparison could not run (${reason}), so this save needs your tick.` : null;
}

/** The effective publish settings that decide which pages publish: the hide lists, drafts, callouts, field exceptions and mode. */
const PAGE_DECIDING_KEYS = Object.freeze(['mode', 'exclude_drafts', 'exclude_callouts', 'exclude_sections', 'exclude_fields', 'exclude_dirs', 'overrides']);

/**
 * Whether the candidate can change which pages publish, judged from the settings as the generator
 * reads them, never from the text: the effective publish settings both sides already hold, and the
 * folder map of each side's resolved context. A candidate side that cannot be resolved counts as a
 * change, so the comparison runs and decides for itself.
 *
 * @returns {boolean}
 */
function publishMayChange(ctx, target, candidateBytes, jsonConfig, curPublish, candPublish) {
  const curEff = curPublish.publishConfig;
  const candEff = candPublish.publishConfig;
  if (PAGE_DECIDING_KEYS.some((k) => !isDeepStrictEqual(curEff[k], candEff[k]))) return true;
  if (jsonConfig === null) return true;
  const { value: candMap } = read.withCandidateFile(target, candidateBytes, () => {
    try {
      return { ok: true, map: checkcli.resolveVaultContext(ctx.ctxInfo).jsonConfig.folderMap };
    } catch {
      return { ok: false };
    }
  });
  return !candMap.ok || !isDeepStrictEqual(jsonConfig.folderMap, candMap.map);
}

const REASON_ORDER = Object.freeze(['privacy', 'new-errors', 'check-did-not-run', 'current-unreadable']);

/**
 * Why a reviewed edit needs the "Save anyway" tick, in a fixed order. Shared by both settings
 * editors. `publishDiff` null means the review could not compare what the site would publish, which
 * counts as the check not having run.
 *
 * @param {{ effects: object[], check: object, curData: object|null, publishDiff: object|null }} opts
 * @returns {string[]}
 */
function computeReasons({ effects, check, curData, publishDiff }) {
  const present = new Set();
  if (effects.some((e) => e.level === 'bad')) present.add('privacy');
  if (check.ran && check.newErrorCount > 0) present.add('new-errors');
  if (!check.ran || publishDiff === null) present.add('check-did-not-run');
  if (curData === null) present.add('current-unreadable');
  return REASON_ORDER.filter((r) => present.has(r));
}

/**
 * @param {object} ctx an admin context (only `ctx.vaultPath` and `ctx.ctxInfo` are read)
 * @param {{ candidateBytes: Buffer, withCheck: boolean, targetRel?: string, publishDiffWhenItCanChange?: boolean }} opts
 *   `targetRel` is the settings file the candidate stands in for, relative to the vault
 *   (vault-config.md by default). `publishDiffWhenItCanChange` (the live pane, without the check)
 *   computes the publish comparison only when the edit can change which pages publish (see
 *   publishMayChange), and leaves it null, never throwing, when that comparison fails.
 * @returns {{ jsonConfig: object|null, jsonError: string|null, curPublish: object,
 *   candPublish: object, candPublishSet: object|null, publishDiff: object|null,
 *   publishDiffReason: string|null,
 *   check: null | { ran:false, message:string } | { ran:true, exitCode:number, counts:object,
 *     newFindings:object[], newCount:number, newErrorCount:number, unforceable:object[] } }}
 *   `publishDiff` (see computePublishDiff) is computed with the check, or without it under
 *   `publishDiffWhenItCanChange`, and is null otherwise or when either side cannot be resolved.
 *   `publishDiffReason` is the first line of that failure's error under the check, and null
 *   otherwise; publishDiffNote turns it into the Review's note.
 * @throws {CandidateCheckError} the overlay was never actually read (`hits < 1`): the panel will
 *   not trust a result it cannot prove came from the candidate.
 */
function runReview(ctx, { candidateBytes, withCheck, targetRel = VAULT_CONFIG_REL, publishDiffWhenItCanChange = false }) {
  // The default target keeps going through the markdown writer's own path, the one seam a test
  // injects to prove a review that never read its candidate is refused.
  const target = targetRel === VAULT_CONFIG_REL ? vaultconfigwrite.targetPathFor(ctx.vaultPath) : path.join(ctx.vaultPath, targetRel);

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
  let publishDiff = null;
  let publishDiffReason = null;

  if (!withCheck && publishDiffWhenItCanChange && publishMayChange(ctx, target, candidateBytes, jsonConfig, curPublish, candPublish)) {
    // The live pane only informs: the review at save time runs the comparison again and fails closed.
    try {
      publishDiff = computePublishDiff(ctx, target, candidateBytes).diff;
    } catch {
      publishDiff = null;
    }
  }

  if (withCheck) {
    ({ diff: publishDiff, reason: publishDiffReason } = computePublishDiff(ctx, target, candidateBytes));

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
        .map((f) => redact(f, targetRel));
      check = {
        ran: true,
        exitCode: candidateResult.exitCode,
        counts: candidateResult.envelope.counts,
        newFindings: newFindingsRaw.slice(0, NEW_FINDINGS_CAP).map((f) => redact(f, targetRel)),
        newCount: newFindingsRaw.length,
        newErrorCount,
        unforceable,
      };
      candPublishSet = candidateResult.checkCtx.publishSet;
    }
  }

  return { jsonConfig, jsonError, curPublish, candPublish, candPublishSet, publishDiff, publishDiffReason, check };
}

module.exports = {
  UNFORCEABLE_IDS,
  VAULT_CONFIG_REL,
  NEW_FINDINGS_CAP,
  MESSAGE_KEEP_IDS,
  REDACTED_MESSAGE,
  VAULT_SETTINGS_REL,
  YAML_REDACTED_MESSAGE,
  CandidateCheckError,
  redact,
  diffFindings,
  runReview,
  computeReasons,
  publishDiffNote,
};
