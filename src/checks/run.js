'use strict';

const { defaultEnabledChecks } = require('./registry');
const frontmatter = require('./frontmatter');
const census = require('./census');
const link = require('./link');
const relationship = require('./relationship');
const unmapped = require('./unmapped');
const sessionmodel = require('./sessionmodel');
const configdiv = require('./configdiv');
const themescheme = require('./themescheme');
const l1 = require('./leak/l1');
const l2 = require('./leak/l2');
const l3 = require('./leak/l3');
const l4 = require('./leak/l4');
const l5 = require('./leak/l5');
const outputscan = require('./leak/outputscan');
const commentscan = require('./leak/commentscan');
const graph = require('./graph');

const RUNNERS = {
  'frontmatter/non-yaml-language': frontmatter.runNonYamlLanguage,
  'frontmatter/parse-error': frontmatter.runParseError,
  'frontmatter/missing-type': frontmatter.runMissingType,
  'census/type': census.runTypeCensus,
  'census/unrecognised-type': census.runUnrecognisedType,
  'census/session-wrap-hub-unpublished': sessionmodel.runWrapUpHubUnpublished,
  'census/session-wrap-link-unpaired': sessionmodel.runWrapUpLinkUnpaired,
  'census/session-wrap-learned-missing': sessionmodel.runWrapUpLearnedMissing,
  'link/unresolved': link.runUnresolved,
  'link/in-code': link.runInCode,
  'link/ambiguous-target': link.runAmbiguousTarget,
  'relationship/missing-required': relationship.runMissingRequired,
  'relationship/unknown-predicate': relationship.runUnknownPredicate,
  'vault/unmapped-directory': unmapped.runUnmappedDirectory,
  'config/exclude-sections-divergence': configdiv.runExcludeSectionsDivergence,
  'config/exclude-dirs-divergence': configdiv.runExcludeDirsDivergence,
  'config/exclude-fields-divergence': configdiv.runExcludeFieldsDivergence,
  'config/site-vault-path-mismatch': configdiv.runSiteVaultPathMismatch,
  'config/pack-shadowed': configdiv.runPackShadowed,
  'config/theme-scheme-mismatch': themescheme.runThemeSchemeMismatch,
  'leak/l1-no-manifest': l1.runNoManifest,
  'leak/l2-excluded-dir-in-output': l2.runExcludedDirInOutput,
  'leak/l3-unpublished-link': l3.runUnpublishedLink,
  'leak/l4-hidden-name': l4.runHiddenName,
  'leak/l4-name-collision': l4.runNameCollision,
  'leak/l4-output-name': outputscan.runOutputName,
  'leak/l4-index-term': outputscan.runIndexTerm,
  'leak/l5-gm-heading-survives': l5.runGmHeadingSurvives,
  'leak/l6-comment-withheld': commentscan.runCommentWithheld,
  'leak/l6-comment-unterminated': commentscan.runCommentUnterminated,
  'leak/l6-comment-in-output': commentscan.runCommentInOutput,
  'graph/orphan': graph.runOrphan,
  'graph/hub-overload': graph.runHubOverload,
  'graph/generic-relationship-type': graph.runGenericRelationshipType,
  'graph/double-stored-edge': graph.runDoubleStoredEdge,
};

/**
 * Runs every check enabled for this invocation (defaultEnabledChecks(),
 * widened to include --graph checks when ctx.graph is true) against the
 * shared context, and returns the flat list of findings. The check-id
 * registry (src/checks/registry.js) is the single source of truth for
 * which checks exist and whether they are on by default; this module only
 * dispatches to their implementations.
 */
function runChecks(ctx) {
  const enabled = defaultEnabledChecks({ graph: ctx.graph });
  const findings = [];
  for (const check of enabled) {
    const runner = RUNNERS[check.id];
    if (!runner) {
      throw new Error(`no implementation registered for check id: ${check.id}`);
    }
    findings.push(...runner(ctx));
  }
  return findings;
}

module.exports = { runChecks, RUNNERS };
