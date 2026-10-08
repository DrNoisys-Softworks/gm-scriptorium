# Collaborating on GM-Scriptorium

This guide is for the author of the upstream generator (`AntTheLimey/gm-apprentice`, the
`tools/publish` package published as `gm-apprentice-publish`) and for contributors who work near
the generator boundary. It answers two questions: where does Scriptorium depend on the generator,
and what are the ground rules for changing this repository?

**Summary.** Scriptorium does not fork the generator. It vendors one pinned copy, reaches it
through a single facade module, and adds a few runtime patches, post-build HTML transforms and a
stylesheet of its own. Each of those depends on the generator producing a specific shape of output
or reading a specific shape of config, and each would break quietly if that shape changed
upstream. This guide lists every such dependency, so a change on either side can be checked
against the other before it lands. It then gives the procedure for moving the pin to a new
upstream release and the collaboration rules for this repository. If you work with an AI coding
assistant, point it at [`AGENTS.md`](../AGENTS.md).

## What Scriptorium is and how it uses the generator

Scriptorium is a compiled, single-file CLI that validates a gm-apprentice campaign vault, builds a
player-facing static site from it, previews it, and self-updates. It does not fork or edit the
generator. It vendors one pinned copy of `gm-apprentice-publish`, calls its exported functions
through a single facade module, and layers a small number of runtime patches, post-build HTML
transforms and its own stylesheet on top of whatever the generator writes to disk. Everything in
this document exists because one of those layers depends on the generator producing a specific
shape of output, or reading a specific shape of config, and would silently break if that shape
changed upstream.

## The integration surface (where we mesh)

### The pin and its verification

- `vendor/gm-apprentice-publish/PIN.json` is the integrity anchor: repository, `tools/publish`
  path, the 40-character commit SHA (`ea94de7f47f398eb695600653017323ee20caa65`, tag
  `publish-v1.14.0`, package version `1.14.0`), the vendored release tarball's filename and
  sha256, the vendored `SHA256SUMS` filename, a `crossCheck` record (method, npm version,
  `treeSha256` of a reproducible-build cross-check tree), every shipped file's sha256 keyed by
  package-relative POSIX path (560 files, bundled dependencies included), and one `treeSha256` over
  all of them. There is no `omitted` list: the manifest is derived from the extracted release
  tarball directly, with no omit rules of any kind (see "Pin bump procedure" below).
- `vendor/gm-apprentice-publish/gm-apprentice-publish-1.14.0.tgz` is the vendored **release**
  tarball itself (not a locally-`npm pack`ed one), installed via `package.json`'s
  `dependencies["gm-apprentice-publish"]` as
  `file:vendor/gm-apprentice-publish/gm-apprentice-publish-1.14.0.tgz`.
  `vendor/gm-apprentice-publish/SHA256SUMS` is upstream's own release checksum file, vendored
  alongside it.
- `scripts/generator-pin.js` implements the mechanism: `manifestOf()` hashes a tree,
  `verifyInstalled()` compares `node_modules/gm-apprentice-publish` against `PIN.json` (files,
  `treeSha256`, the vendored tarball's own sha256 against `PIN.json`/`SHA256SUMS`, the `crossCheck`
  record, and the `package.json`/`package-lock.json` dependency spec, failing closed if the
  tarball hash or the cross-check record is missing), `parseSha256Sums()` parses upstream's
  `SHA256SUMS` format with no dependency on upstream code, and `derivePinFromTree()` re-derives a
  fresh `PIN.json` from an extracted release tarball, refusing to write on any mismatch against a
  reproducible-build cross-check tree (see "Pin bump procedure").
- `npm run verify-generator` runs `node scripts/generator-pin.js verify`. `npm test` also runs
  `test/generator-pin.test.js`. `scripts/package.js` calls `verifyInstalled()` before invoking the
  packager and refuses to produce an executable on any mismatch.
- **`node_modules/gm-apprentice-publish` must stay byte-identical to upstream at the pinned
  commit.** It is never hand-edited. A generator-side fix goes upstream first, gets merged, and then
  comes into Scriptorium via a pin bump (see "Pin bump procedure" below). **Bundled dependencies
  cannot be patched through Scriptorium's own lockfile**, they are `inBundle: true` entries inside
  the tarball's own dependency tree, with no top-level resolution for `npm audit fix`, an override,
  or a manual bump to act on. A vulnerability in a bundled package can only be fixed by a new
  upstream pin.

### The facade: `src/generator/pinned.js`

This is the **only** Scriptorium module allowed to deep-`require` a `gm-apprentice-publish`
internal path (`gm-apprentice-publish/lib/<file>`). Everything it re-exports is called directly and
unmodified, with one exception: `keepOnlySections` is Scriptorium's guard around the pin's (a withheld
section is excluded first, issue 100, `docs/decisions/0042-stub-section-guard.md`): `stripDataview`, `stripGmOnly`, `stripSpoiler`, `stripHtmlComments`, `stripLeadingH1`,
`stripCallouts`, `filterSections`, `keepOnlySections`, `publishedFrontmatter`, `publishMode`,
`findHeadings`, `renderInline`, `resolveWikiLinks` (all from `lib/processor.js`; the last three are
what `leak/l5-gm-heading-survives` reads headings with, `docs/decisions/0045-leak-checks-read-rendered-headings-and-data-islands.md`), `decidePage`, `publishesPage`, `ALWAYS_EXCLUDE_DIRS` (`lib/publish-decision.js`),
`parseManifest` (`lib/manifest.js`), `PUBLISH_DEFAULTS`, `vaultRelPath`, `scanConfigFor`
(`lib/config.js`), `slugify`, `mapFolder`, `dirIsExcluded` (`lib/scanner.js`), `pairHubs`
(`lib/session-hub.js`), `isWrapUp`, `WRAP_UP_TYPES` (also `lib/session-hub.js`),
`resolveGenrePreset` (`lib/theme.js`), `canonicalNfc`,
`truncateGraphemes` (`lib/unicode.js`), and `metadataBadgesFor`, `TYPE_BADGE_FIELDS`
(`lib/templates/base.js`). It also re-exports `lunr` and `lunr/package.json`'s version, required
here rather than added as a Scriptorium dependency, so the leak scan's own lunr pipeline reproduction
(below) runs against the exact same resolved copy the generator indexed with. At `publish-v1.11.40`
lunr is a **bundled** dependency, no longer hoisted to a top-level `node_modules/lunr`, the facade
requires it by its literal bundled path (`gm-apprentice-publish/node_modules/lunr`), which both
`pkg.assets` and `scripts/pkg-assets.js` also name directly, so the packaged asset and the
runtime-required module are provably the same file. `scanConfigFor`, `dirIsExcluded` and `pairHubs`
were new at `publish-v1.11.40`: `src/vault/publishset.js`'s hand-ported merge logic now defers to
`scanConfigFor`/`dirIsExcluded` rather than re-implementing the pin's own directory-exclusion
matching (which folds case, deliberately, the scanned filesystem may or may not be
case-sensitive), and `src/vault/sessionpairs.js` (`docs/decisions/0036-session-wrap-up-support.md`)
calls `pairHubs` directly, fed by a faithful port of the generator's own note walk, rather than
re-implementing the hub/Wrap-Up pairing rule.

Any change to one of these exported functions' name, signature, or return shape is a break. A
rename or removed export is the single most disruptive kind of upstream change from Scriptorium's
side, because every consumer of the facade goes through this one file.

### Runtime patches and shims

These are applied at module load, before anything requires the generator, by `require`-cache
seeding, by `Object.defineProperty` on `globalThis` (the network guard), or by deleting and
freezing an in-memory registry object the generator itself resolves at parse time (the
frontmatter engine guard). None of them touch a byte on disk in `node_modules/gm-apprentice-publish`.

- **The nested-section-exclusion patch is retired as of `publish-v1.11.40`**
  (`docs/decisions/0013-nested-section-exclusion-patch.md`'s own "Retired" addendum has the full
  before/after trace). It used to seed a recompiled `lib/processor.js` into `require.cache` to fix
  an unconditional `excludeLevel = level` assignment that let a nested excluded heading re-open its
  parent region early (upstream #228). At `78696167`, `lib/processor.js` itself now guards that
  whole assignment block with `if (!excluding && ...)`, confirmed correct by hand, not by trusting
  the old patch module's own `classifySource()` heuristic alone, which this guide already warned
  might not distinguish a genuine structural fix from a superficially similar one.
  `src/generator/sectionfilter.js` and its two install call sites and unit test are deleted;
  `test/section-filter-build.test.js` (the real-build regression proof) is kept, now proving the
  pin's own unpatched behaviour.

- **`src/generator/netguard.js`** (new). At `publish-v1.11.40` two generator code paths reach
  `globalThis.fetch`/an injected `fetchFn`, `lib/fonts.js`'s self-host font prefetch and
  `lib/update-pin.js`'s release-pin updater, neither of which Scriptorium ever calls (see "Network
  posture" below). This module installs a process-lifetime, idempotent guard on
  `globalThis.fetch`/`WebSocket` via `Object.defineProperty` (so a later plain reassignment cannot
  remove it): a guarded call throws a `ScriptoriumError` and increments a counter (`attempts()`).
  Installed at module load in both `src/generator/pinned.js` (the facade) and
  `src/generator/bootstrap.js` (the direct `build()` call site), the same way the two shims below
  install, whichever loads first performs the real install.

- **`src/generator/redactions.js`** (`docs/decisions/0007-rules-content-redaction.md`). Two upstream
  files reproduce third-party rules content into every character page of their system with no
  config gate: `lib/templates/gurps/blocks/reference.js` (two literal GURPS combat-reference tables
  under a licence that forbids resale) and `lib/templates/coc/skills-data.js` (the named Call of
  Cthulhu 7th Edition skill list and starting percentages). `applyRedactions()` seeds
  `require.cache` with a Scriptorium-authored stub for each, keyed and guarded by an
  `expectedSha256` per file (bound to `PIN.json.files` by `test/redactions.test.js`, so a pin move
  that changes either file fails that binding until a human re-reads it). Reversible by deleting the
  entry, its `pkg.patches` key, and its notices paragraph.

- **`src/generator/intl-shim.js`**. `@yao-pkg/pkg`'s small-icu Node build has no break-iterator
  data, so the generator's own `Intl.Segmenter` construction (`lib/unicode.js:75`, grapheme
  granularity only, feeding `graphemes()`/`truncateGraphemes()` at `lib/unicode.js:77-86`) would
  crash inside the packaged executable. This module patches
  `Intl.Segmenter.prototype.segment` with a pure-JS grapheme splitter, scoped to exactly the
  granularity the generator uses. Its only two upstream consumers are
  `lib/templates/landing-data.js:72` and `lib/relationship-graph.js:193`.

- **`src/generator/fmguard.js`** (new, `docs/decisions/0034-executable-frontmatter-guard.md`). The
  generator's bundled `gray-matter` (`node_modules/gm-apprentice-publish/node_modules/gray-matter`,
  the same literal `pinned.generatorGrayMatter` handle used for the vault-config write guard's
  identity check) picks its frontmatter parser from the text after a note's opening `---`; `js` or
  `javascript` dispatches to `eval`. `installFrontmatterEngineGuard()` deletes every key of that
  copy's `matter.engines` except `yaml`, then freezes it, so every later uncached parse (which
  rebuilds its own engine table from that same object, `lib/defaults.js:16`) can only ever resolve
  `yaml`. Installed at module load in both `src/generator/pinned.js` and
  `src/generator/bootstrap.js`, the same idempotent, whichever-loads-first pattern the network
  guard uses. `verifyFrontmatterEngineGuard()` immediately self-checks the freeze THROUGH the
  generator's own `parseManifest`, not merely against this module's own reference to the handle,
  proving the freeze reached the exact copy the generator itself resolves; any failure throws and
  fails the process closed. The freeze is bound by `expectedSha256` to four of that copy's own
  files (`index.js`, `lib/defaults.js`, `lib/engine.js`, `lib/engines.js`), the same
  `PIN.json.files`-bound pattern `src/generator/redactions.js` uses, so a pin move that touches
  parser-engine dispatch fails that binding until a human re-reads it. Nothing on disk changes.

### Post-build transforms that match upstream markup

Each of these is a string or regex match against HTML the generator wrote, applied after `build()`
runs and before the atomic swap. Every one is idempotent (checked by its own marker first) and skips
cleanly (patches nothing) if the anchor it looks for is not found, rather than guessing.

- **`src/build/pageturn.js`**: `TOP_NAV_MARKER = '<header class="top-nav">'`, plus `LANDING_HERO_MARKER
  = 'class="landing-hero"'`, `MAIN_OPEN = '<main class="content">'`, `MAIN_CLOSE = '</main>'`, and its
  own idempotency marker `PAGETURN_MARKER = 'data-scriptorium-pageturn'`. Inserts a view-transition
  direction/scroll script before `</head>` on every page, and (only on "leaf" pages: has the top-nav
  header, has no landing-hero class) a `<div class="vt-fx" aria-hidden="true"></div>` immediately
  before the first `</main>`.
- **The Story nav split toggle** is retired (`docs/decisions/0014-story-nav-split-toggle.md`'s
  addendum): upstream's `publish-v1.12.4` renders the grouped Story toggle as a `<button>` with "Story so
  far" as the menu's first entry. `test/story-nav-pin.test.js` proves that on a real build, so a regression in
  the pin shows up by name. One downstream shim remains, `src/build/storyfocus.js` (Escape inside the Story
  dropdown returns focus to the toggle; retire when the pin does it).
- **The Sessions index page writer** (`src/build/sessions-index.js`,
  `docs/decisions/0006-post-build-page-writer.md`): the generator's `DIR_LABELS`
  (`lib/templates/base.js:3-20` at the pinned commit) omits `sessions`, so it never writes
  `sessions/index.html`, though the nav always links to it. This module writes it by splicing new
  content between the first `<main class="content">` and the following `</main>` of a donor
  `sessions/*.html` page. **Self-retirement here is a plain existence check, not a source-text
  match**: if `sessions/index.html` already exists on disk before this module runs (whether from a
  prior run of this same writer, or from the generator's own `DIR_LABELS` output once fixed
  upstream), it returns `{ written: false, reason: 'already-generated' }` and never overwrites it.
  This is the same bug: upstream has fixed it. `lib/templates/base.js`'s `DIR_LABELS` on `main`
  today includes `'sessions': 'Sessions'`, with a comment citing
  [#214](https://github.com/AntTheLimey/gm-apprentice/issues/214) directly, and `lib/build.js`
  (around lines 874-912 at the pinned commit) now writes it the same way as every other section
  index. Once a pin bump brings that in, this module's existence-check makes it retire itself
  automatically, with no further code change needed, the cleaner outcome of the two self-retiring
  patches in this repo, contrasted with `sectionfilter.js` above.
- **The `events/index.html` redirect-stub exception** (`src/build/pageturn.js`'s own comment, and
  its test in `test/build-pageturn.test.js`): the generator's `lib/build.js` writes `events/index.html`
  as a bare `<meta http-equiv="refresh">` redirect stub straight to the campaign timeline whenever
  one exists, with no nav and no `<main>`. `pageturn.js`'s leaf-page test (`TOP_NAV_MARKER` present)
  correctly never matches it, so it falls into the same "gets the head script, no `.vt-fx` div"
  bucket as a 404 page. This is documented so nobody mistakes the missing `.vt-fx` on that one page
  for a bug.
- **`src/build/accordions.js`**: `ACCORDION_RE` matches the PC template's exact accordion markup
  (`lib/templates/pc.js:369-375` at the pinned commit) byte-for-byte, including the literal
  `onclick="const o=this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',o)"`
  attribute value, to flip the Background/Notes accordions open-on-arrival while leaving the
  existing toggle behaviour intact. This is the most literal, most brittle upstream-markup
  dependency in the transform set: any whitespace or attribute-order change to that template block
  breaks the match silently (it returns `null` and just doesn't patch, rather than erroring).
- **`src/build/sessionbadges.js`**: re-derives the exact metadata-badge block
  `lib/templates/base.js:135` emits (`<span class="metadata-badge">value</span>`, positional, no
  field name in the markup, fixed order `session_number, play_date, status, stage`, skipping empty
  fields) via the pinned facade's own `metadataBadgesFor`, and only rewrites it with a `data-field`
  attribute per span when it finds that exact re-derived string in the built page.
- **`src/build/housestyle.js`**: injects Scriptorium's own `css/scriptorium.css` `<link>` by finding
  the generator's own `overrides.css` (or, failing that, `theme.css`, or `style.css`) `<link>` tag
  via `findLinkTag()` and deriving Scriptorium's href from that tag's own href, rather than
  computing site depth itself. This depends on the generator continuing to emit those `<link>` tags
  in that cascade order (`lib/templates/base.js:62-63`: `style.css` -> `[genre]` -> `theme.css` ->
  `[overrides]`), and on `four-oh-four.js`'s different, basePath-prefixed cascade continuing to hold
  the "after the generated theme, before the page-local `<style>`" ordering it documents.
- **`src/build/themestyle.js`**: anchors immediately after `housestyle.js`'s own `<link>` tag
  (never re-derives from `theme.css`'s href directly, to avoid matching its own tag).

### CSS that styles upstream classes

- **The product stylesheet** (`assets/site/scriptorium.css`, `docs/decisions/0012-product-stylesheet.md`):
  ships as `css/scriptorium.css`, embedded in the executable, written into every built site after
  the generator's own stylesheets and before the campaign's `overrides.css`. It styles the
  generator's own template classes directly, `.card-grid`, `.entity-card`, `.dashboard-section`,
  `.hero-banner`, `.nav-group`, `.nav-group-toggle`, `.pc-card`, `.npc-card`,
  `.relationship-graph`, `.stat-block`, `.search-result-item`, among others, so a class rename in
  any generator template is a silent styling break, not a build failure. It also now depends on
  two more specific shapes: a Sessions-typed card carrying `data-entity-type="session"` sitting
  directly inside `main.content > .card-grid`, and the header's `.nav-search-icon-btn` sitting
  inside `.top-nav`. Renaming or moving either one quietly turns off the rule that depends on it,
  with no build failure to flag it. It now also depends on the 404 page's button sitting at
  `main.content > .four-oh-four-hero > .four-oh-four-home`, and on the story landing page's
  button sitting at `main.content > .story-branch > p > .story-begin`, with the generator's own
  page-local style block naming each button by a single class only; changing either markup shape,
  or widening either button's own selector in that style block, quietly turns off the matching
  readable-button rule, with no build failure to flag it.
- **Themes and image slots** (`docs/decisions/0019-themes-image-slots-and-asset-step.md`): the
  optional `pack.toml` theme registry and six validated image "slots," addressing the fact that the
  generator's player-mode build only copies attachments a *published page* actually references
  (`lib/build.js:871-877`, `usedImages` at `lib/build.js:642`), so a campaign stylesheet cannot
  safely reference an arbitrary vault image by path.
- **The built-in `gloam` theme** (`docs/decisions/0032-base-theme.md`): reads the generator's own
  palette and font custom properties directly (`--bg`, `--text`, `--accent`, `--bg-header`,
  `--bg-hero`, `--bg-card`, `--text-muted`, `--border`, `--accent-dim`, `--text-on-header`,
  `--text-muted-on-header`, `--font-heading`, `--font-body`, plus `color-scheme` and `--muted`)
  and overrides every one of them, since the theme owns the page's palette. It also styles a
  handful of the generator's own template classes directly: `.four-oh-four-hero`,
  `.four-oh-four-image`, `.landing-hero-img`, `.breadcrumbs .sep`, `.metadata-badge`, the
  `.status-*` and `.creature-*` state pills, and `.pc-roster`. A rename of any of these in a
  generator template is a silent styling break for gloam, the same risk the product stylesheet
  above already carries for its own classes.
- **Labels and vocabulary** (`docs/decisions/0020-labels-and-vocabulary.md`): `pack.toml`'s
  `[labels]`/`[timeline]`/`[recaps]` tables let a campaign rename emitted nouns, but explicitly do
  **not** touch the strings that are matchers against the generator's own output (e.g.
  `connections.js`'s `GRAPH_BLOCK_RE`, the literal "Connections" heading the generator itself
  emits), those are fixed, because they name a contract with `gm-apprentice-publish`, not the
  campaign's vocabulary.

### The vault config contract Scriptorium reads or validates

- **`vault.config.json`**: the generator's own `scanVaultReport`/`mapFolder`
  (`lib/scanner.js:37-54,287`) consume `config.excludeDirs` (via `.some(...)`) and `config.folderMap`
  (via `Object.entries(...)`) with **no defaulting of its own**, neither key has a fallback
  anywhere in `lib/config.js` or `PUBLISH_DEFAULTS`. `src/cli/check.js`'s `assertScanKeysPresent()`
  refuses early, before `check` or `build` ever reaches the generator, when either key is missing or
  wrongly typed: a **missing `folderMap` still throws** `TypeError: Cannot convert undefined or null
  to object` at `mapFolder`'s own `Object.entries(folderMap)` (`lib/scanner.js:39`) if this guard
  were ever bypassed, and a **missing `excludeDirs`** throws `TypeError: excludeDirs.some is not a
  function` at `lib/scanner.js:81`. This is a required-keys contract on the generator's side, not an
  optional-with-defaults one, and Scriptorium's check exists to fail loudly on the Scriptorium side
  first, with a readable error, rather than let the generator's raw exception surface.
- **`vault-config.md`** frontmatter (a vault's `_meta/vault-config.md`, see the fixtures under
  `test/fixtures/*/​_meta/vault-config.md`): the `publish.exclude_sections` list a campaign author
  writes there is unioned case-insensitively with the generator's own `PUBLISH_DEFAULTS.exclude_sections`
  (`lib/config.js:17`: `['GM Notes', 'DM Notes', 'Player Notes', 'Source References',
  'Reconciliation Context', 'Handoff to Reconcile']`) at `lib/config.js:192-246` and `:414-416`. `GM Notes`
  specifically is in both the generator's own defaults and every real campaign's own config, which
  is exactly the combination `sectionfilter.js`'s patch exists to fix (a nested excluded heading
  inside `## GM Notes`).
- **A handout's Keeper sections are withheld by page type, not by config.** From
  `publish-v1.11.41` (upstream #280), on a page whose own frontmatter says `type: document` (or
  `handout`) the pin's `filterSections` withholds four `## ` sections whatever
  `publish.exclude_sections` lists: Context, any heading starting "Clues", Prop Notes (or Physical
  Prop Notes), and Delivery (or Delivery Notes) (`lib/processor.js:106-149`). It reads the type from
  a third `frontmatter` argument, which the build passes for a page's body (`lib/build.js:583`,
  `lib/processor.js:1014`): the file's original frontmatter, kept as `page.sourceFrontmatter`
  (`lib/build.js:536`) so that hiding `type` with `exclude_fields` cannot switch the rule off. Story
  text is rendered from a page object whose frontmatter is `{}` (`lib/build.js:857-861`, `:1245`),
  so the rule never applies to it. `src/checks/leak/textmodel.js`'s `renderChain` does the same:
  the page's raw frontmatter for the body, none for story text, so `check` reads what a build
  publishes; without it the model keeps
  those sections and reports a withheld name inside one as a leak the site never has. A new
  argument on a facade function is the quiet kind of break: nothing fails, the model just stops
  matching the build.
- **`src/cli/check.js`'s shape check** (`assertScanKeysPresent`, described above) is the
  Scriptorium-side gate on this contract.
- **`src/vault/publishset.js`** is a **hand-ported re-implementation** of the generator's own
  `lib/config.js` merge logic (`unionExcludeList`, the `PUBLISH_DEFAULTS` precedence chain) and its
  `lib/scanner.js`/`lib/build.js` verdict loop, not a call into the generator. It exists because the
  generator's own file-reading entry points (`loadPublishConfig`, `loadManifest`, `scanVaultReport`)
  bypass Scriptorium's read-only, abort-on-EIO chokepoint and write straight to stderr, which
  `check` cannot allow. Only the *pure* functions (`decidePage`, `publishesPage`, `slugify`,
  `mapFolder`, `dirIsExcluded`, `vaultRelPath`, `scanConfigFor`, `canonicalNfc`, `parseManifest`,
  `PUBLISH_DEFAULTS`) are required through the facade and called directly; everything else in this
  file is logic someone re-typed
  from `lib/config.js` by hand and has to be re-checked, not re-verified automatically, on every pin
  move. **This is the single largest place a silent, undetected drift could happen**: an upstream
  change to the merge precedence in `lib/config.js` that isn't one of the exported pure functions
  will not fail `npm run verify-generator` (the pin's bytes still match); it will only surface if
  someone reads the diff by hand, or if `scripts/equivalence-check.js` (below) is run against a real
  build and catches the mismatch in output.
- **The publish manifest**: `parseManifest` (`lib/manifest.js:99`), read from
  `_meta/publish-manifest.md` by the generator's own `loadManifest` (not called by Scriptorium
  directly; only the pure `parseManifest` is, via the facade).
- **`vault.config.json`'s `landingTagline` isn't read by the pinned generator's `lib/` at all.** The
  landing hero's tagline comes only from `publish.theme.tagline` in `_meta/vault-config.md`
  (`lib/templates/landing.js:70`, merged at `lib/config.js:425-436`; there is no `landingTagline`
  fallback anywhere in that merge). Upstream's own README (`:147`) and scaffold template
  (`templates-scaffold/vault.config.json.tmpl:3`) still name the key, so it looks live from the
  upstream side even though nothing downstream of `init` ever reads it. The admin panel edits
  the whole frontmatter of `vault-config.md` (`docs/decisions/0033-vaultconfig-write-exception.md`),
  and never writes `landingTagline`. Its field layout edits exactly seven keys, line by line, and
  nothing else in the file: `publish.exclude_fields`, `publish.exclude_sections`,
  `publish.exclude_dirs`, `publish.landing.featured_npcs`, `publish.landing.quick_links`,
  `publish.landing.max_npcs` and `publish.four_oh_four.message`. Line numbers above are re-verified against `publish-v1.11.40`
  (`78696167`, the `publish-v1.11.40` pin); re-verify them again if you rebase across a further pin move.
- **A frontmatter field suppressed via `publish.exclude_fields` in `_meta/vault-config.md`
  (for example `in_game_date`) is stripped from `page.frontmatter` at build time, before any
  template or derived widget runs** (`lib/build.js:115,534-535`, `lib/processor.js:1054-1077`). A
  derived widget with no other source for that data loses it entirely, the generated timeline's
  own `in_game_date || date` fallback is one example, while a separate field the vault still
  authors directly is unaffected. This is a generator build-order fact, not a Scriptorium one:
  worth knowing before assuming a suppressed field is merely hidden from the *site* rather than
  from every derived widget too.
- **`_meta/relationship-types.md`** is a vault's own list of the relationship words its author
  uses, plus which of those words are symmetric (used the same way from either end). The generator
  itself never reads this file; only `check` does, and only its "Types" table and its bold
  "Symmetric" line, through `src/vault/relationshiptypes.js`. At `publish-v1.11.40` a relationship
  using a word off that list still renders everywhere the generator shows relationships; only
  `lib/templates/faction.js:65` (a faction's member list) and `lib/templates/landing-data.js:154,158`
  (the home page's character roles) match against the exact word. A file in a layout this check
  doesn't recognise degrades to a single note that nothing was checked, rather than a per-relationship
  warning. See ADR 0037, section "What the check reads".
- **The generator builds a campaign id from the site title**, `slugify(config.siteTitle ||
  'campaign')` (`lib/build.js:827,865`), used to namespace anything a backend feature stores. The
  admin panel's title review warns, through the pinned `slugify` facade and never a
  re-implementation of the function, when `vault.config.json`'s own `backend.statusBar` or
  `backend.inbox` is `true` and a rename would change that id. The save is never blocked.
- The admin panel's Images screen lists pictures from the folder `attachmentsDir` names, defaulting
  to `_attachments` exactly as the generator's `scanAttachments` does (`lib/scanner.js:263-265`).
  It is a hand-typed mirror of that default, not a call into the generator, so re-check it on a pin
  move.

### Output that Scriptorium scans

- **The output-leak scan** (`src/checks/leak/outputscan.js`, `docs/decisions/0009-output-leak-scan.md`):
  reads the *built* site tree rather than source, because several leak surfaces are derived views
  the generator assembles at render time and a source-side scan structurally cannot see them:
  relationship-graph SVG `<text>` labels (`lib/relationship-graph.js:193-194`, including the
  truncation at `truncateGraphemes(name, 15, 13)`, `lib/unicode.js:83-87`, and the de-underscoring
  fallback `title.replace(/_/g, ' ')` at `lib/relationship-graph.js:47`), aggregate index cards built
  from another page's frontmatter (e.g. `factions/index.html`'s `escapeHtml(leadership)`,
  `lib/templates/index-page.js:604,609-611`), and the landing page's recency-widget excerpt
  (`escapeHtml(fm.outcome)`, `lib/templates/landing.js:200,204`).
- **`search-index.json`**: `leak/l4-index-term` reproduces the generator's own search pipeline
  against the same resolved bundled `lunr` copy the facade re-exports, to decide whether a
  withheld name is reachable in the index's `invertedIndex` (a sorted array of `[term, postings]`
  pairs, `lunr.js:2253-2257`, never an object). At `publish-v1.11.40` the pipeline is **trimmer and
  stopWordFilter only** (`lib/search-index.js:54-55` removes the stemmer from both `pipeline` and
  `searchPipeline`, upstream #267, "this is a wiki of proper names"), the whole page body is
  indexed, and refs are opaque base-36 ids (`i.toString(36)`) with the output path moved to
  `documents[ref].href`; findings map refs through that href, keeping an unmapped ref raw and
  counting it in `data.unmappedRefs`. It checks the index's own recorded lunr version against
  `pinned.LUNR_VERSION` first, then its serialised `pipeline` field against a recognised-pipelines
  table (`[]` = no stemmer at this pin), refusing to interpret terms on either mismatch rather than
  guess.
- **Backlinks**: reached the same way as the search index, `lib/build.js:403`'s
  `page.publishedMarkdown` feeds `publishedSource` (`lib/processor.js:824-827`), which in turn feeds
  `lib/search-index.js`, `lib/backlinks.js`, `lib/recency.js`, `lib/story-spine.js` and
  `lib/templates/npc.js`. This is exactly why `sectionfilter.js`'s patch has to work at the
  `require.cache` level rather than by reassigning an export: two of `filterSections`'s three call
  sites (`lib/processor.js:860`, `:885`) are module-internal closure bindings a facade-level patch
  could never reach, and this chain of consumers is what would keep leaking through the search
  index and backlinks even if the page HTML itself were fixed some other way.
- **The admin panel's own live preview** (`src/admin/pageroles.js`) resolves which built pages to
  offer by reading `search-index.json`'s `documents` entries (`title`, `type`, `subtitle`, `href`;
  `lib/search-index.js:37-46`) and by walking the built tree for `404.html` and `search-index.json`
  themselves (`lib/build.js:319,784-785`). It shares the `session_number` frontmatter marker with
  `src/build/recaps.js`'s own reading of it, rather than introducing a second, independent parse of
  the same field.
- **A paired hub's recap, and which Wrap-Up it was paired with** (`docs/decisions/0036-session-wrap-up-support.md`):
  read straight off the built page rather than recomputed, because the pairing a real build made is
  the one thing Scriptorium must never disagree with. `src/build/sessionmodel.js` finds the pin's
  own `<div class="recap session-recap">` marker (`lib/templates/session.js:36`) and, inside it, the
  `<a class="recap-link" href="…">` anchor (`:34`), and resolves that href to the Wrap-Up's own
  output path. Both literals are pinned by a change detector in `test/session-pairing.test.js`; a
  markup change that moves or renames either one degrades (the hub reports as `unreadable`, never a
  wrong pairing) rather than erroring.
- **The panel's preview copies** are full builds served under a sub-path of the preview address.
  They rely on the generator's page links being relative (`lib/templates/base.js:27-40`,
  `cssPath`/`rootPath`). The not-found page is the exception: it uses `siteUrl`'s path when that is
  set (`lib/templates/four-oh-four.js:9-10`).

### Tests that pin upstream behaviour by name

A pin bump that breaks Scriptorium will show up as a failure in one of these, by name, rather than a
generic test failure:

- `test/generator-pin.test.js`, the pin mechanism itself.
- `test/story-nav-pin.test.js`, the pin's grouped Story toggle on a real build: a button, "Story so far"
  first, click opens and stays open, Escape closes with focus kept on the toggle (replaces our retired
  Story transform, ADR 0014's addendum).
- `test/live-stats-off.test.js`, `publish.live_stats` off by default, no live script and no `/api/` in the
  output unless a KV store is wired, and every call the live scripts make is same-origin.
- `test/pin-citations.test.js`, every `lib/<path>.js:<line>` citation anywhere under `src/` must
  name a real file and a real line range in the *installed* pin.
- `test/generator-module-graph.test.js`, no network builtin anywhere in the require graph from
  `bin/scriptorium.js` except the allowlisted `src/serve/server.js`, plus additive network-token
  (`fetch`/`WebSocket`/etc) and forbidden-capability-name assertions (see "Network posture").
- `test/generator-no-network.test.js`, `src/generator/netguard.js`'s runtime guard: throws,
  counts, survives reassignment, installs from both `pinned.js` and `bootstrap.js`, and a real
  build+check+preview of a self-host-fonts fixture makes zero guarded calls.
- `test/generator-bootstrap.test.js`, `test/generator-pinned-segmenter-shim.test.js`,
  `test/generator-grapheme-parity.test.js`, the Intl.Segmenter shim and bootstrap install path.
- `test/section-filter-build.test.js`, retired's the wrong word: this now proves the *pin's own*
  nested-exclusion behaviour on a real build (the patch and its own unit test are deleted; see
  `docs/decisions/0013-nested-section-exclusion-patch.md`'s "Retired" addendum).
- `test/redactions.test.js`, `test/redaction-gurps-build.test.js`, `test/redaction-coc-build.test.js`
 , the two redacted files' `expectedSha256` bindings and their build-time effect.
- `test/publishset-pin.test.js`, the hand-ported `publishset.js` logic checked directly against
  the pin's own `lib/templates/base.js` (`getCanonStatus`) and other pin exports.
- `test/publish-equivalence.test.js`, `computePublishedSet` matches a real build exactly,
  including exclude-dir handling now that both sides call the pin's own `scanConfigFor`.
- `test/checks-pin-semantics.test.js`, `test/textmodel-pin.test.js`, the leak checks' semantics
  pinned against real pin behaviour.
- `test/leak-output-scan.test.js`, `test/leak-index-term.test.js`, `test/leak-l2.test.js`,
  `test/leak-l4-collision.test.js`, `test/leak-l4-rendered.test.js`, the output-side leak scan,
  including the (now unstemmed, href-mapped) search index-term reproduction.
- `test/build-landing-recap.test.js`, a real build proves the pin's own `extractRecapHtml`
  renders emphasis (`src/build/recap-emphasis.js` is retired; upstream #269).
- `test/session-pairing.test.js`, `test/session-chain-leak.test.js`,
  `test/session-chain-recaps.test.js`, `test/session-wrap-guard.test.js`: the session Wrap-Up
  model (`docs/decisions/0036-session-wrap-up-support.md`): the pairing port against the pin's own
  note walk and `pairHubs`, the withheld-body leak suppression, and recap/timeline/Connections
  sourcing from a paired Wrap-Up's own built page.
- `test/update-module-graph.test.js`, unrelated to the generator pin (it guards `src/update/*`
  against acquiring a network call or a build-tree dependency); listed here only so it isn't
  mistaken for one when scanning `test/*module-graph*`.

## Compatibility hotspots

Ranked by how likely an upstream change is to break something here, and what would make that
easier to catch or avoid:

1. **`src/vault/publishset.js`'s hand-ported merge logic** (above) is the biggest blind spot. It is
   not bound to the pin by a hash or an export list, so a `lib/config.js` precedence change can drift
   silently. This is not hypothetical: the `publish-v1.11.40` repin found exactly this class of
   drift (`computePublishedSet` was handing the scan its raw site-config `excludeDirs`, never the
   merged list, because `lib/build.js` now calls the pin's own `scanConfigFor` first and the
   hand-port never adopted it, `test/publish-equivalence.test.js` caught it). The fix now calls
   `scanConfigFor`/`dirIsExcluded` through the facade rather than re-implementing them, which
   narrows the remaining blind spot to whatever `publishset.js` still hand-ports (the scan walk and
   the verdict loop's own shape), but does not eliminate it. `scripts/equivalence-check.js` (see
   "Pin bump procedure") is the only thing that would catch a future drift here, and it is not run
   automatically on every change today, only as part of a pin bump.
2. **The session Wrap-Up model.** `lib/session-hub.js`'s `pairHubs` runs on every real build,
   withholding a paired hub's body and replacing its recap with the Wrap-Up's. Scriptorium now
   follows that pairing rather than warning about it (`docs/decisions/0036-session-wrap-up-support.md`):
   the build reads which Wrap-Up a hub paired with straight off the built page (the two markup
   literals above, in "Output that Scriptorium scans"), and recaps, the timeline and Connections
   source from the Wrap-Up's own page; `check` asks the pin's own `pairHubs` again, fed by a ported
   note walk (`src/vault/sessionpairs.js`), to decide which published hub bodies the leak checks
   should read as empty. What would break this:
   - a change to either markup literal (the recap `<div>` or the `recap-link` anchor): caught by
     the change detector named above, and fails closed (the hub is reported unreadable, never
     mis-paired);
   - a change to `lib/scanner.js`'s note-walk gates or skip rules, or to `WRAP_UP_TYPES`: caught by
     `test/session-pairing.test.js`'s port-parity matrix and its change detectors against the
     installed pin;
   - a change to `pairHubs`'s own link-resolution rule: caught by the same file's pairing-parity
     tests, which compare the port against the pin's own `vaultPath`-based walk on every fixture
     variant.
   The ported note walk can only ever be MORE cautious than a real build, never less: on a
   divergence it can't resolve (a symlinked note in the vault) it stops suppressing anything rather
   than guessing, and every real build independently recomputes and compares both sides, naming any
   session where they disagree in a human-only warning.
3. **Byte-literal markup matches** (`accordions.js`'s `ACCORDION_RE`, `sessionbadges.js`'s re-derived badge string, `pageturn.js`'s `MAIN_OPEN`/`MAIN_CLOSE`,
   `sessions-index.js`'s donor-page splice) all fail closed (skip, don't error) on a markup change,
   so a template refactor degrades a specific page feature quietly rather than breaking the build.
   That is deliberate and safe, but it also means these can drift unnoticed without a visual check.
   Stable `class="..."`/`data-*` hooks on nav, accordion and badge markup, rather than exact
   whitespace/attribute-order matches, would make these transforms far less brittle.
4. **`vault.config.json`'s required, undefaulted `excludeDirs`/`folderMap`** (above): a default (even
   an empty array/object) at the generator's own `lib/config.js`/`lib/scanner.js` level would remove
   the need for Scriptorium's own pre-flight shape check entirely.
5. **No `LICENSE` file inside `tools/publish` itself.** The vendored tarball's own `package.json`
   declares `"license": "MIT"`, but the package directory ships no `LICENSE` text; Scriptorium has to
   separately vendor a copy of the repository root's `LICENSE-CODE` file
   (`scripts/vendor/gm-apprentice-publish-LICENSE-CODE.txt`) to produce a compliant notices file at
   all. A `LICENSE` file inside `tools/publish` (even a copy of the root one) would remove that
   separate vendoring step.
6. **A renamed or removed export** from any of the modules the facade re-exports
   (`lib/processor.js`, `lib/publish-decision.js`, `lib/manifest.js`, `lib/config.js`,
   `lib/scanner.js`, `lib/theme.js`, `lib/unicode.js`, `lib/templates/base.js`) is the highest-blast-radius
   single change, because every current and future Scriptorium consumer of that function goes
   through the one facade file.

## Pin bump procedure

This is `docs/decisions/0005-generator-pin.md`'s own pin-move procedure (written for the
release-tarball pin source at `publish-v1.11.40`); do not re-derive a different one.

**If upstream ever stops publishing a release tarball for a future tag**, this whole procedure
needs the maintainers' sign-off before falling back to a source-tree `npm pack`, that path is
provenance-weaker (it cannot prove the artefact upstream actually released, only what a checkout
plus `npm pack` would produce) and is not proven safe for a package with `bundleDependencies`.

1. **Get the release tarball and its `SHA256SUMS`** from the GitHub release page for the new tag.
   `sha256sum -c SHA256SUMS` against the downloaded tarball. Re-download both files from the
   release URL a second, independent time and `cmp`, two legs, not one.
2. **Clone and extract.**
   - Fresh clone the upstream repository; `checkout --detach <new SHA>`; confirm
     `git cat-file -t <new tag>` says `commit` (a lightweight tag; `publish-v*` tags are immutable
     per upstream's own README, but are still labels here, never the pin of record).
   - Extract the release tarball.
   - **The reproducible-build cross-check** (authoritative, see the addendum's "rejected"
     reasoning above for why a plain-checkout pack is not): a *second* fresh checkout, `cd
     tools/publish && npm ci --ignore-scripts` (never the git-committed `node_modules`), then
     `npm pack`. Extract that too.
   - The two extracted trees (release vs. reproducible-build pack) must be identical in files and
     `treeSha256` (`diff -rq` clean). **A mismatch is a stop.**
3. **Vendor.** Copy the release `.tgz` and `SHA256SUMS` into `vendor/gm-apprentice-publish/`; `cmp`
   each against the source. `git rm` the old tarball.
4. **Derive**, only after step 2's cross-check passes:
   ```
   node scripts/generator-pin.js derive --tree <extracted-release>/package \
     --cross-check-tree <extracted-reproducible-pack>/package \
     --tarball vendor/gm-apprentice-publish/<new tarball> \
     --sums vendor/gm-apprentice-publish/SHA256SUMS \
     --commit <SHA> --tag <tag> --package-version <version> \
     --cross-check-method npm-ci-pack --npm-version <recorded> \
     --out vendor/gm-apprentice-publish/PIN.json
   ```
   Refuses to write on any tarball-hash or cross-check-tree mismatch. No omit rules exist or are
   accepted, the manifest is every file in the extracted release tree, bundled dependencies
   included.
5. `npm install --save file:vendor/gm-apprentice-publish/<new tarball>.tgz`. Allowed lockfile hunks
   only: the root dependency spec, the `gm-apprentice-publish` entry, new
   `node_modules/gm-apprentice-publish/node_modules/**` entries (each `inBundle: true`), and removal
   of any top-level entry whose only dependant traced to the generator (prove each with a
   lockfile-graph read against the old pin, mirroring `npm ls <name>`). Restore the lockfile's root
   `"version"` if `npm install` rewrote it (Scriptorium's release procedure keeps it deliberately
   stale). Anything else is a stop.
6. `npm run verify-generator`, then `rm -rf node_modules && npm ci && npm run verify-generator`
   again, must reproduce exactly. Record whether a top-level `node_modules/lunr` exists (expected:
   absent if lunr is bundled at the new pin) and where the bundled copy lives.
7. `git diff <old SHA> <new SHA> -- tools/publish` to bound which `lib/X.js:N`-style citations in
   this repo's ADRs and source comments need re-checking.
8. Re-run `test/redactions.test.js`, `test/redaction-gurps-build.test.js`,
   `test/redaction-coc-build.test.js`, and re-derive the redaction scan baseline
   (`scripts/content-markers.js`'s `scanPinTree()`, now also covering bundled `node_modules/**`,
   read every hit by hand). Re-verify `REDACTIONS`' two `expectedSha256` values against the new
   `PIN.json.files`.
8b. Re-verify `src/generator/fmguard.js`'s `BOUND_PIN_FILES` (four `expectedSha256` values) against
    the new `PIN.json.files`; any mismatch is expected and means the four files below need a
    by-hand re-read, not a hash update to make a test pass. Re-read `index.js`'s own language
    detection and its content cache, `lib/defaults.js`'s engine-table merge, `lib/engine.js`'s
    engine lookup and its name aliases, and `lib/engines.js` itself if its hash changed. Re-check
    every reading point in `docs/decisions/0034-executable-frontmatter-guard.md`'s own table
    against the new version, in case it gained one.
9. Re-run `test/section-filter-build.test.js` (the patch module and its own unit test are retired
   as of `78696167`, see `docs/decisions/0013-nested-section-exclusion-patch.md`'s addendum for
   the by-hand confirmation this required, and re-do the same by-hand read at any future pin move
   that touches `lib/processor.js`'s `filterSections` again).
10. Run `scripts/equivalence-check.js --vault <dir> --site-config <vault.config.json> --out
    <scratch-out-dir>` against a real fixture vault: it builds the vault through Scriptorium's own
    pipeline and compares the built tree against `computePublishedSet()`'s own predicted published-page
    list, subtracting the pages the generator writes that have no single vault-source page behind
    them (landing, 404, timeline, story index and its per-unit pages, each section's own index). A
    mismatch here is the A/B check that catches a `publishset.js` drift `verify-generator` cannot
    see, the `publish-v1.11.40` repin used this exact mismatch to find the `scanConfigFor` drift
    documented above.
10b. Re-run `test/session-pairing.test.js`. If a change detector goes red (the pin's own
    `SESSION_TYPE_LINE` literal or note-walk gate, or either of `lib/templates/session.js`'s two
    markup literals), re-port `src/vault/sessionpairs.js`'s note walk or `src/build/sessionmodel.js`'s
    page reader to match the new pin, before anything else in this procedure.
11. If bundled dependencies changed, regenerate notices (`npm run notices`) and re-audit provenance
    for every bundled `name@version` and licence; run `npm audit --omit=dev --json`, bundled
    entries included (a scratch package audit if npm skips them).
12. Re-run `npm test` and `npm run package` in full.
13. Amend `docs/decisions/0005-generator-pin.md` with the new pin, the dependency-set deltas, and
    the packaging proof result.

## Starter template pin bump procedure

New vaults are made from a starter template, captured from gm-apprentice's own vault scaffold at one
pinned upstream commit and kept in `assets/vault-template/` ([ADR 0048](decisions/0048-new-campaign-vault.md)).
No file in that folder is ever edited by hand. To move the pin:

1. Fetch the new commit twice, by two routes: `git clone`, and `gh api repos/AntTheLimey/gm-apprentice/tarball/<sha>`.
   `diff -rq` their `skills/shared` and `.claude-plugin` trees. Any difference is a stop. A commit is
   weaker provenance than a release tarball; say so in the record.
2. Read `LICENSE`, `LICENSE-CODE`, `ATTRIBUTION.md` and `.claude-plugin/plugin.json`. Any third-party
   licence named for `skills/shared/templates/`, `skills/shared/scaffold/`, `entity-schema.md`,
   `gm-apprentice-ontology.json` or `vault-structure.md` is a stop. Check each game system against
   [ADR 0007](decisions/0007-rules-content-redaction.md): a system whose templates carry rules content is held back.
3. `git diff <old> <new> --` over the scaffold script, `scaffold/`, `templates/`, the three schema files,
   `index_build.py`, `migrate_vault.py` and `vaultlib.py`. Stop if the output now uses CRLF or the platform
   line end, depends on the target path, differs between two runs with the same inputs, or the index no longer
   skips `meta` and `campaign_overview`.
4. `node scripts/vault-template.js capture --checkout <fresh clone> --out <runs folder>`. It needs Python 3.10
   or later with the standard library only; nothing is installed. Python runs from a scratch folder outside the clone.
5. The derive inputs are kept in `scripts/vault-template-inputs/`: `meta.json` (version, licence, attribution text, the deviation), `additions/` (the three files this program writes) and `notes.json` (one by-hand note per rules-scan hit). `_meta/NOTICE.txt` in `additions/` names the commit; update it for the new commit. Then `node scripts/vault-template.js derive --runs <runs folder> --out <template folder> --meta <meta.json>
   --additions <folder> --notes <notes.json>`. It refuses on any surprise and renders its own output back
   against the scaffold's bytes.
6. Read every changed file, every rules-scan hit (each needs a note you wrote after reading the line) and
   every deviation.
7. Update the notices (`npm run notices`), `docs/PROVENANCE.md` and `templateVersion`.
8. Run `npm test`, `npm run verify-generator` and `npm run package`; run the packaged binary's
   `init --yes --new-vault` for each system and `check` and `build` the result.
9. Amend [ADR 0048](decisions/0048-new-campaign-vault.md).

## Collaboration rules

These are the owner's rules for this repository:

- **Changes reach `main` by pull request only.** Nobody pushes directly to `main`, and that
  includes the owner. Branch from the latest `main`, open a pull request against it, and keep
  the change to one concern. Pull requests are squash merged, so add a `Co-authored-by:` line
  at the end of the description for anyone who shares the credit.
- **CI must pass.** Two checks gate every pull request: `test` (runs `npm test` and
  `npm run verify-generator`) and `hygiene` (the public privacy check). Run both commands
  yourself before you open the pull request.
- **A written review is required.** Every pull request carries a review in its description or a
  comment: what was looked at, what was run, what was found. GitHub does not ask for an approval
  click, because the owner cannot approve their own pull requests. A second maintainer or a
  separate reviewer account may be added later, and then one approval will also be required.
  The full steps are in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **Never force-push or rewrite `main`'s history, and never delete or move tags.**
- **If you have a clone of the earlier private repository, don't reuse it: clone this repository
  fresh, never add it as a remote to the old clone, and never push a branch that descends from the
  old history.**
- **Releases, tags, version bumps and deploys are the owner's.** Please don't cut a release or push
  a tag yourself.
- **Never edit `vendor/gm-apprentice-publish/` or `node_modules/gm-apprentice-publish/` directly.**
  A generator-side change goes upstream first, gets merged there, and then comes into this repo via
  a pin bump (above).
- **Never commit campaign content, vault files, secrets or credentials.**
- **No real campaign names, player or character names from a real game, or personal names in repo
  text, test fixtures or commit messages.** Use neutral, made-up example names instead. This
  repository is public. Two CI checks on every push to `main` and every pull request look for private paths, private
  IP addresses, personal email addresses and files that must never be committed, and checks that
  the history starts at this repository's first commit. Maintainers also scan pushes and releases
  against private word lists kept outside the repository. These checks catch a lot but not
  everything, so please hold yourself to the rule rather than rely on a check catching it.
- **Flag breaking upstream changes.** An `upstream` label exists on this repository for
  issues and pull requests that track a change on the `AntTheLimey/gm-apprentice` side that affects
  (or might affect) one of the integration points above.
- **Licensing of contributions.** Contributions are accepted under this repository's MIT licence
  (see `LICENSE`), with no CLA.

## For AI coding assistants

If you work with an AI coding assistant, point it at [`AGENTS.md`](../AGENTS.md).
