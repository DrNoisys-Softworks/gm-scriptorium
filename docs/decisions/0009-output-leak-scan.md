# 0009. The output-leak scan: read what the generator actually emitted

Status: accepted (Track D2, 2026-09-17).

## Summary

A withheld name can reach a built site through views the generator assembles from other pages, such as relationship graph labels, index cards and the search index, and no check that reads source notes can see those. Two new checks now read the built site itself and report any withheld name found there. `build` runs them on a staging copy before anything is published, so a leak is caught before it can reach a published site. The limit is that `check` alone cannot find these leaks until a build exists, and it says so in plain words instead of staying silent.

## The problem

L1-L5 (and D1/D3's rewrite of L4) are all source-side: they read a page's own frontmatter and its own
rendered body/story text, never what the generator actually wrote to disk. That is enough to catch a
withheld name typed into a page's own prose or its own relationship targets, but it structurally cannot
see a name that only reaches the site through a **derived view**, content the generator assembles from
*other* pages' data, or a transform the generator itself applies at render time:

- a relationship-graph SVG `<text>` label (`lib/relationship-graph.js:191-192`), including the two
  transforms the label goes through that a source-side scan never sees: truncation past 15 graphemes
  (`truncateGraphemes(name, 15, 13)`, `lib/unicode.js:83-87`) and de-underscoring an unpublished
  target's fallback label (`title.replace(/_/g, ' ')`, `lib/relationship-graph.js:46`);
- an aggregate index card built from a frontmatter field on a page other than the one being viewed
  (e.g. `factions/index.html`'s `escapeHtml(leadership)`, `lib/templates/index-page.js:603,608-610`);
- the landing page's recency-widget excerpt (`escapeHtml(fm.outcome)` on an event card,
  `lib/templates/landing.js:199,203`);
- `search-index.json`'s lunr inverted index, which can carry a withheld name as a **stemmed or
  possessive term** (a possessive phrase such as "NPC A's horde" tokenises and stems to a bare
  possessive stem) that no literal text search would ever construct as a needle.

On a real campaign vault, seven confirmed occurrences of withheld names reach
the built site today through exactly these views, with `leak/l4-hidden-name` correctly reporting
nothing for any of them, not a bug in L4, a structural limit of reading source instead of output.

## Decision: two new checks, in the L4 family, that read the built tree

`leak/l4-output-name` (ERROR) and `leak/l4-index-term` (ERROR, `dynamicSeverity: true`) are new ids in
the L4 family (same hidden-name set via `collectWithheldNames`, same Unicode word-boundary semantics via
`findWholeWordOccurrences`, different haystack). Not a new command, not a `check` mode: they are
ordinary registered checks (`src/checks/registry.js`), dispatched like any other
(`src/checks/run.js`), implemented in one scanner module (`src/checks/leak/outputscan.js`).

**The build dependency is resolved by scope, not suppressed:**

- `scriptorium check` with a build present (`ctx.outputPath` set, L2's own "is there really a build
  here" signal, `src/checks/leak/l2.js:47-61`, reused verbatim): the scan runs, read-only, against the
  real built tree.
- `scriptorium check` with no build present: each id emits exactly one INFO naming, in words, what is
  not covered, the same two-message contract L2 already established (no directory at all, vs. a
  directory that exists but was never built into). Never silence.
- `scriptorium build`: the scan runs against the fully-built **staging tree**
  (`.scriptorium-build-<pid>-<ts>/out`), after the generator, the sessions-index write, and the NOTICE
  pass, **before** `swapIntoPlace` (`src/build/run.js`).

**The honest failure mode, stated once, in the code, the INFO message, and here:** a user who never
runs `build` never learns about a derived-view leak, because the artefact that would carry it does not
exist yet. D2 cannot be a source-side check, the whole point is that a generator's derived views are
not derivable from page prose. What D2 guarantees instead is that **no leak reaches a published tree
unnoticed**, because `build` is the only thing that produces a published tree, and `build` always scans
it before publishing.

**A leak found after the generator run still blocks meaningfully.** The staging tree is a sibling of
`finalOut`, never the published location. On a hit without `--force`: no swap, `finalOut` stays
byte-unchanged, the staging tree is removed, exit 2. `finalOut` is the thing a user serves or copies,
it never contains the leak. The publishing act is the swap, not the generator run.

**FR-16 (a stale, about-to-be-replaced build must not gate the build that is about to fix it).** Solved
by scope selection, not suppression. `buildCheckContext` gains `deferOutputScan = false`;
`runCheckCommand(flags, campaignArg, opts = {})` threads `opts.deferOutputScan`; **only**
`src/cli/build.js`'s own pre-build `check` call passes `true`. When deferred, each id emits exactly one
INFO saying the scan is deferred to this build's own staging tree, nothing is suppressed, the scan
still runs (against the tree the command is actually deciding about) and still gates the build; it is
just not run twice against a tree about to be discarded. No CLI flag, config key, or environment
variable reaches `deferOutputScan`, it is reachable from exactly one call site
(`test/leak-output-scan.test.js`'s structural test greps for this).

**The scan always runs inside `runAtomicBuild`; `--force` overrides the result, never the scan.**
`runAtomicBuild` gained required `campaign` and optional `force = false`. There is no parameter,
callback, or code path that can build without scanning, only to override what the scan found, and an
override is recorded (`envelope.overriddenFindings`, printed as `OVERRIDDEN` lines). Consequence,
accepted deliberately: the three non-product callers that build vaults known to leak,
`scripts/equivalence-check.js`, `scripts/l4-render-audit.js`, `test/publish-equivalence.test.js`, all
pass `force: true` now. That is a loud, greppable statement of exactly what they override, not a
silent bypass. Rejected: an injected `preSwapGate` callback, which is fail-open by omission, the exact
failure class this track exists to close.

**Normalise the haystack toward source form; never generate variant needles per name.** One
`normaliseEmitted(text)`, entity decode (single regex pass, so `&amp;lt;` cannot double-decode into
`<`), markdown-it typographer fold (`’ ‘ → '`, `“ ” → "`, `– → --`, `— → ---`, `… → ...`), NFC, applied
identically to every haystack. Two extra needles per hidden name, both computed with the pin's own
functions rather than guessed: the SVG-truncated form (only when `truncateGraphemes(name, 15, 13) !==
name`) and the de-underscored form (only when the name contains `_`). Percent-decoding is never applied
to a whole file (decoding arbitrary HTML text is wrong); it applies only to extracted `href="…"`/
`src="…"` attribute values, per path segment, `decodeURIComponent` in a try/catch.

**The index arm reproduces the generator's own lunr pipeline; it does not re-derive it from the
serialised `pipeline` field.** `trimmer, stopWordFilter, stemmer`, in that order, run against
`lunr.tokenizer(pinned.canonicalNfc(name))`. A term hits when it equals the stem, or is the stem
followed only by non-alphanumerics (the live NPC A possessive-stem case), never a prefix match. `invertedIndex`
is read as the sorted **array** of `[term, postings]` pairs it actually is
(`lunr.js:2253-2257`), reading it with `Object.keys()` is the single most likely way for this arm to
fail quietly (it would silently enumerate `"0","1","2"…` instead of terms), and is guarded by a test
that feeds a real built `search-index.json`, not a hand-written one
(`test/leak-index-term.test.js`, AC-D2-06). A multi-word name only fires when every non-stop-word
stem's matching term(s) share at least one document ref (no positions are stored, so "share a
document" is the strongest claim the index supports). `lunr` is required through
`src/generator/pinned.js`, the same resolved copy the generator itself indexes with
(`require.resolve('lunr')` from both locations resolves to the same file, a second resolved copy
would let the pipeline reproduction silently drift from what the generator actually indexed with).
`lunr` is **not** added to `package.json`'s own `dependencies`, to guarantee there is only ever one
resolved copy on disk.

**`scripts/l4-render-audit.js` stays a separate, unmodified oracle.** Its coarse, lowercased
`String.includes` matcher (`:49-99`) is untouched. Sharing D2's matcher with it would make the
cross-check worthless: a bug in that matcher would then be invisible to both, and Bucket B (a name
genuinely in the built HTML with no finding accounting for it) would stop meaning anything. Its only
permitted change was the `runAtomicBuild` call-site update (passing `campaign` and `force: true`) and
printing the overridden scan findings.

**No suppression surface of any kind.** No allowlist, no exception file, no `--acknowledge`, no "known
derived views" data file. `--force` is the only escape hatch and it always records what it overrode.
Generator-shipped static assets (`js/**`, `css/**`, `js/lunr.js`) are scanned exactly like every other
emitted file; on the real vault this produced zero hits, every one of the 43 `leak/l4-output-name` and
7 `leak/l4-index-term` findings landed on a real page, `search-index.json`, or a copied attachment path,
never on a generator-shipped static asset. Had a short or common withheld name collided there, that
would have been reported like anything else, not filtered.

## What D2 will and will not catch

**Will catch:** a withheld name in any emitted text file, including relationship-graph SVG `<text>`
labels (literal, truncated, or de-underscored form), aggregate index cards built from a frontmatter
field, recency/landing-widget excerpts, a name only present in HTML-escaped or typographer-substituted
form, a name in a percent-encoded `href`/`src`, a name in an emitted relative path (including a copied
attachment's own filename), and a name reachable only as a lunr stem or possessive term in
`search-index.json`.

**Will not catch, deliberately:**

- **Any leak at all, if the user never builds.** `check` says so in an INFO; it cannot do better, the
  artefact the leak lives in does not exist yet.
- A name inside binary raster content or image metadata (the path arm still catches the filename
  itself; L1/L2 own attachments by directory).
- A name broken across HTML tags inside the word (e.g. `Gow<em>alga</em>`) — the same exclusion ADR
  0008 already made for markdown syntax inside a word: stripping tags before matching would fabricate
  names by concatenating adjacent cells, buying a false-positive surface for no real coverage gain.
- A display transform the pin might add later that this module does not model. Only two are modelled,
  both computed with the pin's own functions, so a pin move re-verifies them by construction
  (`docs/decisions/0005-generator-pin.md`'s pin-move procedure).
- A name assembled at runtime by client JavaScript rather than present statically in a file.
- A semantic leak: prose that identifies a withheld entity without naming it. Same limit as L4, forever.
- A name in a page hand-edited after the build, or a tree built by something other than Scriptorium.
- A withheld name that collides with a published title or alias: excluded from `hiddenNames` by
  construction (same partition L4/D1 already made) and reported by `leak/l4-name-collision` instead;
  searching output for it would fire on every page legitimately naming the public entity.

## Evidence (a real campaign vault export, built and grepped in the same pass)

All seven of the previously-known occurrences fire, each independently confirmed by a direct `grep` of
the real built file (not taken from the tool's own report):

| # | outputPath | name | confirmed by |
|---|---|---|---|
| 1 | a faction page | **NPC A** (not NPC B, see correction below) | `grep` confirmed |
| 2 | a location page | **NPC A** (not NPC B, see correction below) | `grep` confirmed |
| 3 | a second location page | NPC B | `grep` confirmed |
| 4 | a third location page | NPC B (body text) and NPC A (graph label) | `grep` confirmed |
| 5 | a fourth location page | NPC B | `grep` confirmed |
| 6 | the faction-index page | NPC A | `grep` confirmed |
| 7 | the site landing page | NPC B | `grep` confirmed |

**Correction to the Engineering Brief's own table (#1 and #2).** The brief's table named NPC B at
the faction page and the location page above. A direct grep for NPC B against both real built
files returns **0**; a direct grep for NPC A returns exactly one hit in each, the
relationship-graph `<text>` label. This ADR corrects the record: the withheld entity genuinely
leaking at those two output paths is **NPC A**, not NPC B. `docs/KNOWN-VAULT-FINDINGS.md` (retained
in the private archive at `b5b48b4`) is updated to match. This is not a reasoning-based claim,
it follows the Reviewer Brief's own instruction to grep the real build, not to trust a prior table.

**Reconciliation #3 (Pass 1 AC-03 vs the finding's own output path).** The vault has two distinct
pages with similar names. Only one of the two pages' built HTML contains NPC B (confirmed by grep;
the other page's built HTML does not). Pass 1 AC-03 named the wrong one; the page that actually
fires is the one matching the finding above (row 3 of the table).

**Reconciliation #7 (the landing card-excerpt's real source).** `docs/KNOWN-VAULT-FINDINGS.md`
(retained in the private archive at `b5b48b4`) attributed the landing page's NPC-B-carrying
`card-excerpt` to a recap page. That file does contain an alias-form wiki-link, but its rendered
text says the alias, never NPC B's real name (confirmed by grep of the built page, this is
exactly the Bucket C direction, and D2 fires no finding there). The excerpt actually reaching the
landing page is `escapeHtml(fm.outcome)` on an **event** card, whose `outcome` frontmatter field
literally names both NPC B and another withheld entity. `docs/KNOWN-VAULT-FINDINGS.md` is corrected.

**Every other finding is itemised.** All 50 D2 findings on this export (43 `leak/l4-output-name`, 7
`leak/l4-index-term`) map to the same five withheld entities `docs/KNOWN-VAULT-FINDINGS.md`
(retained in the private archive at `b5b48b4`) already names, five NPCs, one with a distinctive
alias. No previously-undocumented withheld name surfaced. `leak/l4-index-term` additionally
confirms a possessive-stem term persists for one of them (`documentRefs` naming the three pages
it is reachable from), as pass 2 AC-04 predicted it would until the vault's own relationship
edges change (the owner's call, not Scriptorium's).

**Bucket B (fail-open candidates: a name genuinely in the built HTML with no `leak/l4-hidden-name`
finding covering it) is fully explained.** All 7 pre-D2 Bucket B entries now have a matching
`leak/l4-output-name` finding at the exact same output path and name. None left unexplained.

**Bucket C (the clean direction) stays clean.** A roster page and a recap page, both carrying
an alias-form wiki-link for NPC B, produce **zero** `leak/l4-output-name` findings for NPC B at
their own output paths, confirmed by grep: both built pages say the alias, never NPC B's real
name.

**No hit on generator-shipped static assets.** `js/lunr.js` and the theme CSS were scanned like every
other file; neither produced a finding on this export.

**Timings** (this scratch build, local disk, not the CIFS-backed NAS path the NFR-05 baseline was
measured against): `check` against the real built tree, three runs, 284-296 ms (NFR-05 baseline 349 ms).
`scanStagingOutput` alone (the staging scan's own cost, isolated): 179 ms for 89 published pages / ~315
source files. Both are "seconds, not minutes."

## Consequence

- `README.md`'s `check`/`build` rows describe the output scan and the staging refusal; "L1-L5" wording
  stays accurate (D2 is two more ids inside the L4 family, not a renumbered or new-lettered check).
- `docs/KNOWN-VAULT-FINDINGS.md` (retained in the private archive at `b5b48b4`) gains a new numbered
  section with the real post-D2 counts and the two corrections above, and separately resolves FR-19
  (sections 1, 2, and "Other unrecognised-type" are now 0 and 0, marked resolved, history kept).
- `package.json`'s version is flagged to the orchestrator for the owner's confirmation
  (`0.1.1` → `0.2.0`, per pass 2's "Decisions for the owner" item 1) before the release push; not
  blocking this phase.
- No suppression mechanism, allowlist, exception list, or `--acknowledge` flag exists or was added.
  `--force` remains the only escape hatch, and it always records what it overrode.

## Addendum: the index-term arm rebuilt for publish-v1.11.40's unstemmed index (2026-09-30)

At `78696167` the generator's search pipeline no longer stems (`lunr.js:53-54`,
`this.pipeline.remove(lunr.stemmer)` / `this.searchPipeline.remove(lunr.stemmer)`, upstream #267,
"this is a wiki of proper names, and the English stemmer mangles them"), the whole page body is
indexed rather than a 500-character excerpt, and `invertedIndex` refs are opaque base-36 ids
(`i.toString(36)`) with the output path moved to `documents[ref].href`. `leak/l4-index-term`
(`src/checks/leak/outputscan.js`) is rebuilt around this, not patched:

- **A recognised-pipelines table**, keyed by the index's own serialised `pipeline` field
  (`json.index.pipeline`, distinct from `json.index.version`): at this pin, `[]` means "trimmer +
  stopWordFilter, no stemmer." Checks run in order, version, then pipeline, then terms, and an
  unrecognised serialised pipeline gives one WARN naming it (`data.serialisedPipeline`) and
  interprets no terms, the same fail-closed shape the version check already had. Rejected (SD-18):
  re-deriving the whole pipeline from the serialised field alone, only the *name* is serialised,
  not a reproducible function list, so this table is the hand-read map from name to behaviour, not
  something the code derives automatically.
- **The term rule**: `^<token>(?:['’]?s)?[^\p{L}\p{N}]*$`, the exact token (trimmer +
  stopWordFilter only, no stemming), optionally a possessive or plain "s" form, then trailing
  punctuation only. Never a prefix match: proven both against an unrelated word sharing a letter
  prefix ("brimstone" vs "brimble") and against a genuine prefix relationship ("brimbleson" vs
  "brimble", the M26 discriminator — a lost anchor would wrongly fire here where the unrelated-word
  case would not). (The example names above were renamed for the public repo.)
- **Refs are mapped through `documents[ref].href`.** An unmapped ref (no `documents[ref]`, or no
  `href` on it) is kept raw rather than dropped, and counted in `data.unmappedRefs`, so a mapping
  gap is visible rather than silently losing a finding.
- **Lunr identity.** The pipeline functions used here (`pinned.lunr.trimmer`,
  `pinned.lunr.stopWordFilter`) are the same bundled `lunr` module `src/generator/pinned.js`
  requires by literal path (`gm-apprentice-publish/node_modules/lunr`) and re-exports, the same
  resolved copy the generator's own `lib/search-index.js` indexed with (AC-D2-09), never a second,
  independently-resolved lunr that could drift in tokenizer behaviour.

**Red-first, on a real v1.11.40 build** (`test/fixtures/index-term-vault`, new): a withheld
(`withheld: true`, `publish: false`) NPC with an invented name ("Thornwicke") whose real lunr stem
differs from the raw word (proven as a precondition), named in a published page's body. The
pre-fix, stemmer-based check, re-run against this exact real build by temporarily restoring the
old `outputscan.js`, returns **zero findings**: a confirmed silent miss, not a hypothetical one.
The rebuilt check returns one ERROR, `documentRefs: ['locations/old-watch.html']` (an href, not a
base-36 ref), `unmappedRefs: 0`.

`test/leak-index-term.test.js`'s `AC-D2-05`-labelled tests were rewritten, not just re-pointed:
`buildRealIndex`'s synthetic builder now mirrors `lib/search-index.js:53-54` explicitly (removing
the stemmer from both `pipeline` and `searchPipeline`), because bundled lunr's own default builder
pipeline still includes the stemmer, only the generator's own construction code removes it, so a
synthetic index built without that same removal would silently test the wrong pipeline.
