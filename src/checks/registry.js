'use strict';

/*
 * The check-id registry. Frozen in phase 1: ids are stable and greppable
 * and are never renumbered (Engineering Brief section 9), even though the
 * check *implementations* are phase 2 work (src/checks/*.js,
 * src/checks/leak/l1..l6.js) this Engineer does not build yet.
 *
 * `defaultSeverity` is the severity most implementations report. A few
 * checks compute a per-instance severity instead of a single fixed one:
 *
 *   - leak/l3-unpublished-link: WARN unless the resolved target carries
 *     `withheld: true`, in which case ERROR (Decisions Addendum section 1
 *     narrows this from the Engineering Brief's flat ERROR).
 *   - config/exclude-sections-divergence and config/exclude-dirs-divergence:
 *     ERROR if the divergence actually reached rendered output, WARN
 *     otherwise (Engineering Brief section 7, "L6").
 *
 * For those, `defaultSeverity` names the *lower* bound (the severity used
 * when the check does not escalate), and `dynamicSeverity: true` flags that
 * the implementation may report a higher severity per finding. This is
 * documented here so phase 2 does not have to rediscover it from the brief.
 *
 * `defaultEnabled: false` + `requiresFlag` marks the --graph checks: WARN
 * only, off by default, and must stay off by default (Engineering Brief
 * section 14: "Do not turn --graph on by default").
 */

const CHECKS = Object.freeze([
  {
    // ADR 0034 / SD-6: inserted first so it dispatches first -- a walk failure (VaultReadError,
    // propagated unchanged) aborts the whole check before any other check runs.
    id: 'frontmatter/non-yaml-language',
    category: 'frontmatter',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A tracked file\'s opening frontmatter fence declares a language other than YAML (docs/decisions/0034-executable-frontmatter-guard.md). Scriptorium refuses to read or build this file; the refusal cannot be overridden by --force or --no-check.',
  },
  {
    id: 'frontmatter/parse-error',
    category: 'frontmatter',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'gray-matter failed to parse a file\'s frontmatter. The generator silently skips such a file (lib/scanner.js); Scriptorium reports it instead of losing it.',
  },
  {
    id: 'frontmatter/missing-type',
    category: 'frontmatter',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A file has no frontmatter `type`. scanVault silently skips such a file (lib/scanner.js:117); this is how content disappears without a message.',
  },
  {
    id: 'census/type',
    category: 'census',
    defaultSeverity: 'info',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'Type census across the vault, validated against the union of _meta/entity-types.md\'s hierarchy block, the folder-mapping table, and character-story (src/vault/entitytypes.js).',
  },
  {
    id: 'census/unrecognised-type',
    category: 'census',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description: 'A frontmatter `type` outside the recognised union (see census/type).',
  },
  {
    // ADR 0036 (R2): retires census/session-wrap-unsupported, never reused. Scriptorium now
    // follows the pin's own hub/Wrap-Up pairing (timeline, recaps, Connections, and the leak
    // model's withheld-hub-body rule); these three read-only pre-flight WARNs replace the old
    // "not supported yet" notice.
    id: 'census/session-wrap-hub-unpublished',
    category: 'census',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A published Wrap-Up (lib/session-hub.js\'s pairHubs) is linked to a session hub that is not itself published, so the site has no session page for it at all: no session badges, no Latest Session recap, and nothing on the timeline or in Connections.',
  },
  {
    id: 'census/session-wrap-link-unpaired',
    category: 'census',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A published Wrap-Up carries an explicit pairing link (its own `session:`, or a hub\'s `documents.wrap_up` naming it) that never resolved to exactly one session hub -- an ambiguous link or a chapter mismatch (lib/session-hub.js\'s own `nearest`).',
  },
  {
    id: 'census/session-wrap-learned-missing',
    category: 'census',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A published session hub paired with a Wrap-Up still carries the vault\'s learned-items heading in its own (unpublished) body, but the paired Wrap-Up that now supplies the site\'s learned items does not -- those items will never reach the timeline once the pairing withholds the hub\'s body.',
  },
  {
    id: 'link/unresolved',
    category: 'link',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A [[target]], [[target|alias]] or [[target#heading]] does not resolve against any filename stem or frontmatter alias.',
  },
  {
    id: 'link/in-code',
    category: 'link',
    defaultSeverity: 'info',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A [[target]], [[target|alias]] or [[target#heading]] found only inside an inline code span or fenced code block, AND whose target does not resolve. A resolving in-code link (Leaflet marker/image syntax, a GM changelog quoting an old value, ...) stays silent; only a broken one surfaces, at INFO, never blocking a build.',
  },
  {
    id: 'link/ambiguous-target',
    category: 'link',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'Two files resolve the same [[name]]. Regression guard for a past incident where two folders produced colliding page names, making a large number of links ambiguous.',
  },
  {
    id: 'relationship/missing-required',
    category: 'frontmatter',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A file\'s type is missing a relationship type that _meta/entity-types.md\'s "Required relationships" table (src/vault/entitytypes.js) says that type requires. One INFO instead, requiring nothing, when the file, its frontmatter, or the table is absent.',
  },
  {
    id: 'relationship/unknown-predicate',
    category: 'frontmatter',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A relationship uses a word that is not in the vault\'s own _meta/relationship-types.md (its "Types" table and bold "Symmetric" line, read by src/vault/relationshiptypes.js). The generator still shows the relationship, but its word-matched features (a faction\'s member list, landing-page NPC roles) only recognise exact words. Suggests the listed word for a case, space or hyphen slip. One INFO instead, checking nothing, when the file, its frontmatter, or its Types table is missing or empty.',
  },
  {
    id: 'vault/unmapped-directory',
    category: 'frontmatter',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A directory has no folderMap entry and is not the vault root, so scanVault silently drops every file under it (lib/scanner.js:119-129). A third silent-drop path found during the Architect pass.',
  },
  {
    id: 'config/exclude-sections-divergence',
    category: 'config',
    defaultSeverity: 'warn',
    dynamicSeverity: true,
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A pin default excluded section (lib/config.js:17) is silently dropped because vault.config.json or _meta/vault-config.md supplies its own exclude_sections list, which replaces the defaults instead of extending them (lib/config.js:192-246, :414-416). ERROR if the heading actually renders in a published page.',
  },
  {
    id: 'config/exclude-dirs-divergence',
    category: 'config',
    defaultSeverity: 'warn',
    dynamicSeverity: true,
    defaultEnabled: true,
    requiresFlag: null,
    description:
      "A vault-side publish.exclude_dirs entry never gates the scan; only vault.config.json's excludeDirs does (lib/scanner.js:77,264). ERROR if the vault-only directory would have contributed files to output.",
  },
  {
    id: 'config/exclude-fields-divergence',
    category: 'config',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A list from either config surface replaces the pin\'s default exclude_fields (lib/config.js:18: secrets, current_plan, plan_progress, gm_notes, prep_notes, reliability) instead of extending it, so an un-renamed default is no longer filtered.',
  },
  {
    id: 'config/site-vault-path-mismatch',
    category: 'config',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'The site config\'s own vaultPath points somewhere other than the vault Scriptorium resolved (--vault > matched profile > campaign block); the resolved vault is what is used, this is reported only, never fatal (FR-18).',
  },
  {
    id: 'config/pack-shadowed',
    category: 'config',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'The legacy site_config key is set and a campaign pack also exists (the pack key\'s directory, or <vault>/_meta/scriptorium/ by convention, holding vault.config.json). site_config wins and the pack is ignored; reported only, never fatal (docs/decisions/0018-campaign-pack.md). Remove site_config to build from the pack.',
  },
  {
    id: 'config/theme-scheme-mismatch',
    category: 'config',
    defaultSeverity: 'info',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'The pack.toml theme is built for one colour scheme (theme.json "scheme") but the vault palette resolves to the other, by the generator\'s own light/dark rule (lib/theme.js:188) applied after its palette merge (lib/config.js:428-430). Text and surfaces may clash. Never fires for the plain theme, without a pack.toml, or when a genre preset owns the palette.',
  },
  {
    id: 'leak/l1-no-manifest',
    category: 'leak',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'Effective publish.mode is player and _meta/publish-manifest.md is absent, so build.js\'s image filter (gated on manifest && mode === player) is dead and every attachment is copied. Fires today.',
  },
  {
    id: 'leak/l2-excluded-dir-in-output',
    category: 'leak',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      "A built page or image is sourced from a directory in the union of vault.config.json:excludeDirs and _meta/vault-config.md:publish.exclude_dirs, or under one of the pin's always-excluded directories (_meta, _Templates, _templates, personal; lib/publish-decision.js:46).",
  },
  {
    id: 'leak/l3-unpublished-link',
    category: 'leak',
    defaultSeverity: 'warn',
    dynamicSeverity: true,
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A published page (source markdown, after stripGmOnly/filterSections) wiki-links an entity that is not published. WARN unless the target carries withheld: true, in which case ERROR (Decisions Addendum section 1 narrows this from the brief\'s flat ERROR: most unmet NPCs are not secrets).',
  },
  {
    id: 'leak/l4-hidden-name',
    category: 'leak',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A withheld: true entity\'s filename stem, title, or a distinctive alias appears in a published page\'s rendered body text, its paired _Story.md body, or its published frontmatter/relationship text — never raw source markdown, so a name correctly hidden under an excluded section, a gm-only/spoiler block, a comment, an excluded callout, a dataview block, or a publish: stub-dropped section gives no finding (Track D3). Decisions Addendum section 1: only withheld entities are checked, not every source: prep entity, which cuts the expected finding count down to roughly the real leaks. A candidate name identical to a published page\'s own title or alias is reported by leak/l4-name-collision instead, never silently dropped here. No suppression mechanism; see brief section 14.',
  },
  {
    id: 'leak/l4-name-collision',
    category: 'leak',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A withheld: true entity\'s filename stem, title, or a distinctive alias is identical to a published page\'s own title or alias, so leak/l4-hidden-name cannot meaningfully search for it. Names both files, the colliding name, and whether the match was via the published page\'s title or alias; flags the case where the withheld entity is itself the published page. Track D1: before this check existed the collision was silently dropped from leak/l4-hidden-name\'s search and reported nowhere.',
  },
  {
    id: 'leak/l4-output-name',
    category: 'leak',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'Track D2: a withheld: true entity\'s hidden name reaches the generator\'s ACTUAL emitted output — a relationship-graph SVG <text> label, an aggregate index card built from a frontmatter field, a recency/landing excerpt, a copied attachment\'s own filename — even though no source-side check (L1-L5) can see it, because these are derived views the pin builds from published data, not renderings of one page\'s own markdown. Reads the real built tree (ctx.outputPath) when a build exists, one INFO when it does not (leak/l2\'s posture, reused verbatim), and the staging tree before the swap during `build` (src/build/outputgate.js). No suppression mechanism of any kind; see docs/decisions/0009-output-leak-scan.md.',
  },
  {
    id: 'leak/l4-index-term',
    category: 'leak',
    defaultSeverity: 'error',
    dynamicSeverity: true,
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'Track D2: a withheld: true entity\'s hidden name is reachable as a stemmed or possessive lunr index TERM in search-index.json, which a literal text scan cannot see (the generator\'s own Porter-stemmer pipeline can turn a possessive like "Example\'s lair" into the literal index term "example\'"). Downgrades to WARN when search-index.json\'s lunr version does not match the resolved lunr copy (cannot safely interpret its terms) and to INFO when no search-index.json exists on a real build (legitimate when searchEnabled: false); otherwise ERROR. See docs/decisions/0009-output-leak-scan.md.',
  },
  {
    id: 'leak/l5-gm-heading-survives',
    category: 'leak',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'A rendered heading equals or starts with an entry in the union of both exclude_sections surfaces (the "starts with" arm catches "GM Notes (spoilers)", which filterSections\' exact-match misses). Also flags a surviving <!-- gm-only --> marker. ADR 0044: on a type: document handout page, also flags a still-rendered Keeper heading (Context, Clues..., Prop Notes, Delivery), which the pinned generator withholds itself, so this is a safety net.',
  },
  {
    id: 'leak/l6-comment-withheld',
    category: 'leak',
    defaultSeverity: 'info',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'ADR 0044: a published page (or its paired story) contains an Obsidian %%comment%% (inline or multi-line, outside code). The build removes every such comment before the generator reads the note; this lists the files so the GM knows text is being withheld.',
  },
  {
    id: 'leak/l6-comment-unterminated',
    category: 'leak',
    defaultSeverity: 'warn',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'ADR 0044: a %% comment opener with no closing %%. Fail closed: the build withholds everything from it to the end of the file. The WARN names the line so the GM can close the comment where it should end.',
  },
  {
    id: 'leak/l6-comment-in-output',
    category: 'leak',
    defaultSeverity: 'error',
    defaultEnabled: true,
    requiresFlag: null,
    description:
      'ADR 0044: text from an Obsidian %% comment, or a literal %% outside code, reached the built output (page, search index, backlinks, excerpts). Reads the real built tree when a build exists (INFO when none), and the staging tree before the swap during build, where --force cannot override it.',
  },
  {
    id: 'graph/orphan',
    category: 'graph',
    defaultSeverity: 'warn',
    defaultEnabled: false,
    requiresFlag: '--graph',
    description: 'An entity with no relationship edges. Not inherently a defect.',
  },
  {
    id: 'graph/hub-overload',
    category: 'graph',
    defaultSeverity: 'warn',
    defaultEnabled: false,
    requiresFlag: '--graph',
    description: 'An entity with degree >= 12. Not inherently a defect.',
  },
  {
    id: 'graph/generic-relationship-type',
    category: 'graph',
    defaultSeverity: 'warn',
    defaultEnabled: false,
    requiresFlag: '--graph',
    description:
      'A relationship using a generic, non-distinctive type name. When the vault\'s _meta/relationship-types.md loads, a generic word that is not on that list is reported once, by relationship/unknown-predicate, instead of here.',
  },
  {
    id: 'graph/double-stored-edge',
    category: 'graph',
    defaultSeverity: 'warn',
    defaultEnabled: false,
    requiresFlag: '--graph',
    description: 'The same relationship stored on both ends redundantly.',
  },
]);

// category "build" (per-page render errors, e.g. "ERROR rendering <page>"
// captured from gm-apprentice-publish's console output during `build`) is
// deliberately not in this registry: those findings are synthesized by the
// build pipeline itself (phase 2 chunk C), not produced by a `check` run,
// and are not gated by --graph or any on/off default. They reuse the same
// Finding shape (src/report/finding.js) and the "build" category value.

const CHECKS_BY_ID = Object.freeze(
  Object.fromEntries(CHECKS.map((c) => [c.id, c])),
);

function getCheck(id) {
  const check = CHECKS_BY_ID[id];
  if (!check) {
    throw new Error(`unknown check id: ${id}`);
  }
  return check;
}

function defaultEnabledChecks({ graph = false } = {}) {
  return CHECKS.filter((c) => c.defaultEnabled || (graph && c.requiresFlag === '--graph'));
}

module.exports = { CHECKS, CHECKS_BY_ID, getCheck, defaultEnabledChecks };
