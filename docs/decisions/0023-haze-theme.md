# 0023. The built-in `haze` theme

Status: accepted (2026-09-25).

## Summary

Scriptorium now ships `haze`, its first real built-in theme. A GM selects it with `theme = "haze"` in `pack.toml` and gets a hero treatment, a recap panel, timeline and connections colours and typography fixes without writing any CSS. Only the generic two-thirds of one campaign's hand-written stylesheet became the theme. The campaign-specific rest never enters this repository and stays in that campaign's own stylesheet. Keeping a second, dormant copy of the generic CSS in the repository until a later phase was rejected, because two copies drift apart.

## 1. The problem

ADR 0019 built the theme registry, image slots and the asset step, but shipped it holding only
`plain`, a deliberately empty placeholder (`dir: null`, no CSS at all). Every vault that wants a
distinctive look-and-feel today still has to carry its own campaign `css/overrides.css`, hand-
authored from scratch, including the parts that have nothing to do with that vault: pull-quote
brass, the landing-page hero treatment, the recap "slip" ornament, the Story-timeline and
Connections-lane token palette, focus/motion fixes. None of that depends on a particular
campaign's content. It was drafted once, for one real campaign, sitting in this repo's own tree
at `docs/handoff/campaign-ui/css/overrides.css` as a hand-off artefact, a 1335-line file
mixing genuinely generic material with vault-specific literals (a folder path, an asset filename,
a palette fix) in the same rules, the same `:root` blocks, sometimes the same declaration list.

This phase ships that generic two-thirds as GM-Scriptorium's first real, file-backed theme:
`haze`. Any vault can select it (`theme = "haze"` in `pack.toml`) and get that same visual
language, hero treatment, recap slip, timeline/connections colours, typography fixes, without
writing a line of CSS. The remaining third (the genuinely campaign-specific rules: a vault
folder-path selector, an asset-specific mask, a palette override tuned to one vault's colours) is
not part of the theme, is never generalised, and never enters this repository or its history: it
is checked separately (privately, under NFR-11) and left for the real vault's own campaign
stylesheet.

## 2. Decision, and NFR-11

Ship `assets/themes/haze/{theme.json,theme.css}` as GM-Scriptorium's own first-party code, wired
into the existing ADR 0019 registry (`plain` stays the default; `haze` is added, key order
`plain` then `haze`). The split is done in two steps:

- **B1 (S1, this phase's first commit):** move every THEME-classified declaration verbatim (same
  literal colour values, same selectors) into `theme.css`, in strict source order. A private
  script does the extraction; the theme.css bytes are the only artefact that matters, and they
  are checked byte-for-byte against an independently-typed oracle (below).
- **B2 (S3):** tokenise every colour literal in `theme.css` into `var(--sc-th-*)` or
  `color-mix()` over a small anchor set, so the theme's palette becomes a single, greppable block
  a future variant theme could plausibly re-derive from, instead of 47 scattered literals.

**NFR-11, in force for the whole phase and mechanically checked at every commit:** the campaign
remainder (the CAMPAIGN-classified two-thirds, private grouping tools, the equivalence table, the
cascade-audit script) is written only under a private QC folder (not in this repo), and is
never committed. Commit messages, theme comments, and test file contents are
all grepped against a private NFR-11(f) term list built from the real vault's own frontmatter
(filenames, `title:`, `aliases:`) before every commit in this phase; the grep is empty every time
(recorded per commit in the Engineer report). Theme comments cite only tracked repository files
(this ADR, ADR 0012, ADR 0015, ADR 0019), never the private, gitignored working folder (it holds real
character names) and never a design-exploration mockup path.

## 3. Classification

Every declaration in the extraction source (a real vault's
`_meta/scriptorium/css/overrides.css`, confirmed byte-identical to this repo's pre-3b
`docs/handoff/campaign-ui/css/overrides.css` copy by `cmp` before any edit) falls into one of
three classes:

- **THEME**, holds for any vault. Typography fixes (pull-quote brass), the three font
  `@import`s, the whole landing-page hero/recap/roster/register treatment (scoped under five
  `:has()`/class anchors: `.landing-hero`, `.dashboard-section`,
  `body:has(> main.content > .landing-hero)`, `main.content:has(> .landing-hero)`,
  `html:has(.landing-hero)`), and the two trailing `:root` token blocks (19 `--sc-leaf-*`, 13
  `--sc-tl-*`/`--sc-on-*`/`--sc-cx-*` names, the same 32 names `assets/site/scriptorium.css`
  already declares its own generic defaults for).
- **CAMPAIGN**, depends on this one vault: a palette fix (`--text-muted` etc.), editorial
  hide/caption rules keyed to a `data-field` value, image masks keyed to `<vault path>` (redacted
  here), the Atlas ground treatment (keyed to a vault asset path), and grid-column counts sized
  to this vault's actual roster size (`<party size>` PCs).
- **SPLIT**, three rules where most declarations are THEME but one value is tuned to this
  vault's specific content: the hero image's `object-position` (a crop chosen for one painting),
  and the PC-roster grid's `grid-template-columns` at two breakpoints (column counts sized to
  this vault's own party size). In each, the THEME declarations stay in `theme.css`; the tuned value moves to
  the (private) campaign remainder under the same selector.

The full row-by-row table (line ranges against the extraction source, redacted to `<vault path>`
where a row names one, no campaign literal values) is Appendix A.

**Declaration conservation** is checked by a private tool
(the private QC folder's `tools/css-conserve.js`), whose oracle is typed independently from
this table (re-reading the source at the table's own line ranges), not derived from the
Engineer's own split, so a bug in the split's line ranges and a bug in the oracle's ranges would
have to agree by coincidence to hide a real conservation defect. At S1: 410 THEME + 76 CAMPAIGN
declarations, multiset- and source-order-equal on both sides of the split. At S3 (after B2's
literal-to-token rewrite): 407 declarations unchanged by (selector, property), 3 removed (the
dead `--haze-paper*` trio), 36 added (the new token block), exactly and only the changes B2
intends.

## 4. Cascade audit (FR-14)

After the move, `assets/site/scriptorium.css` loads first (generic product defaults for all 32
shared token names), then `css/scriptorium-theme.css` (haze's own values), then a campaign's own
`css/overrides.css` last. The only way this reorder could change what actually renders is a
CAMPAIGN rule and a THEME rule matching the *same* DOM element, on the *same or overlapping*
CSS property, with *equal specificity*, anything else keeps the same winner it had when campaign
and theme content lived in one file with campaign always last.

By hand: C8 (`.landing-hero-img` masks) against the S-A theme portion share no properties (masks
vs. `object-fit`/`filter`/etc.); all three SPLIT selectors are disjoint-property by construction;
C1's three campaign tokens (`--text-muted`, `--text-on-header`, `--muted`) share no name with any
`--sc-leaf-*`/`--sc-tl-*`/`--sc-on-*`/`--sc-cx-*` token; no THEME rule targets any C2–C7, C9, C11,
C13 or C14 selector at all (disjoint elements); C10's `html::before`/`::after` (Atlas ground)
share the `content` property with T3's `html:has(.landing-hero)::before`/`::after` (the landing-
page ground suppression) on the *same* element, but at unequal specificity, `:has()` counts as a
class, so T3 is `(0,1,2)` against C10's `(0,0,2)` and wins regardless of source order, both before
and after the move.

**Confirmed mechanically**, not just by hand: a private script
(the private QC folder's `tools/cascade-audit.js`) loads a real built page in Chromium, checks
each pair's selector actually matches a DOM element (pseudo-elements mapped to their host),
computes CSS specificity (with shorthand/longhand expansion for `background`, `mask`, `border*`,
`margin`, `padding`, `inset`, `font`, `gap`, `grid*`), and reports the winner before and after.
**Result: zero equal-specificity, overlapping-property collisions.** The two unequal-specificity
pairs (C10 vs T3, `::before` and `::after`) are both won by T3, unchanged by the move. Full table
in Appendix, the private QC folder's `gates/cascade-audit/report.json`.

`@font-face` order is unchanged: the theme's three `@import`s still load after the pin's own
`theme.css` import (product stylesheet order: pin styles, `scriptorium.css`, theme, campaign), so
they remain the last-defined faces.

## 5. B1 method

A private extraction script reads the source at the classification table's own line ranges and
concatenates every THEME row in ascending source order into `theme.css`, replacing every original
comment with the four structural markers the theme keeps (the generic file header, three section
banners, and the "slip slot: begin/end" pair, which an S5 checklist step will still want to find)
original comments are dropped wholesale rather than sanitised, since several of them cite
private working-folder paths or design-round jargon NFR-11 forbids reproducing, and a generic
rewrite of prose that specific would be indistinguishable from just not having the comment. The
CAMPAIGN rows go to the private remainder in the same order, comments intact (no NFR-11
constraint applies off-repo).

**A found, pre-existing defect, not introduced by this phase:** the source's own "Story timeline
and Connections" section-banner comment contains, in its own prose, the literal token-name
pattern `--sc-tl-*/--sc-on-*/--sc-cx-*`, which embeds the two-character sequence `*/` twice. CSS
comments have no escape mechanism; a real parser closes the comment at the *first* `*/` it meets,
mid-word, and the rest of the intended comment (through its real closing marker) becomes live,
unparseable CSS text immediately in front of `:root {`, which makes the whole rule (a valid
13-declaration block, but attached to a garbage selector prelude) invalid and dropped. Confirmed
with `getComputedStyle` against an actual pre-3b build: `--sc-tl-fight` resolves to the *product
default* (`var(--sc-leaf-ink)`), never the campaign's own `#d99a86`. This means the Story-
timeline "Fight"/"Journey" colours and the Connections-lane gradients have always silently
rendered in generic defaults on the real site, not the intended campaign palette, a real,
previously undiscovered bug, unrelated to and predating this phase. B1's comment rewrite (forced
by NFR-11 regardless) does not reproduce the landmine, so `theme.css`'s own token block parses and
applies correctly.

**Accepted as a visible change, decided by the owner 2026-09-25**, after the Reviewer escalated it
rather than left silent. What actually changes on the built site: the Story-timeline "Fight" icon
goes from the generic product default (cream, `var(--sc-leaf-ink)` = `#e8e1d2`) to the campaign's
own intended dusty rose (`--sc-th-fight` = `#d99a86`); "Journey" goes from a muted grey-tan
(`var(--sc-leaf-muted)` = `#a8a092`) to a warmer parchment tan (`--sc-th-journey` = `#d6cbb4`); the
ink on the Connections-lane "brass"/"named" studs goes from a near-black leaf tone
(`var(--sc-leaf-paper)` = `#2a2723`) to the intended `on-dark`/`on-named` values; and the
stud/named/iron/seal gradients move from generic `--accent`-derived washes to the campaign's own
brass, violet and iron gradients. **Evidence the ONE root cause explains the whole diff**: the
Reviewer's own control build, with only this one comment fixed (nothing else touched, still the
pre-3b codebase otherwise), renders **48/48 at exact 0/0** against the same pixel-gate page set,
proof that this single root cause is the entire explanation, with nothing left unaccounted for.
Full writeup, evidence and the S1 pixel-gate accounting: 
the private QC folder's `gates/S1/found-defect-sc-tl-on-cx-comment-landmine.md`.

## 6. B2 method, token list and count

Every colour literal (hex or `rgba()`) collapses onto its base RGB, ignoring alpha: **47 real
distinct bases** (50 raw bases minus 3 whose only occurrence is inside the three dead
`--haze-paper*` declarations B2 also deletes, per SD-5 below).

**24 anchor tokens**, named and defaulted exactly as specified going in:

| Token | Default | Token | Default | Token | Default |
|---|---|---|---|---|---|
| brass | #c9a55a | slip-link | #2a1c52 | on-dark | #1f1c18 |
| glow | #b9a1e6 | scorch | #785028 | gilt | #f0d99a |
| desk | #1b1f1a | leaf | #2a2723 | named | #5b4a82 |
| ground | #24221e | edge | #34312b | iron | #5a5347 |
| ink | #e8e1d2 | crease | #4b453b | seal | #7a61ad |
| muted | #a8a092 | initial | #4a3770 | | |
| nav-ink | #ddd5c6 | fight | #d99a86 | | |
| drift | #c4aaf0 | journey | #d6cbb4 | | |
| vignette | #0e0c12 | slip | #d7cbb1 | | |
| slip-ink | #2e2013 | | | | |

Of the remaining 23 non-anchor bases: **12 are promoted** to their own `--sc-th-<family>-<n>`
token (no anchor pair reached the ≤1 channel delta bar, so exactness beats approximation),
`stud-ink`, `seal-dark`, `stud-edge`, `drift-2`, `drift-3`, `slip-shade`, `seal-bright`,
`slip-mid`, `named-bright`, `iron-ink`, `slip-halo`, `initial-ink`. Every new word here (`shade`,
`mid`, `bright`, `dark`, `halo`, and the compound names themselves) already appears somewhere in
pre-3b emitted CSS, clearing the output-leak scan's term check without a separate allowlist
entry. **11 resolve purely as `color-mix(in srgb, var(--sc-th-A) P%, var(--sc-th-B))`** over two
anchors, at an integer percentage, chosen by a private greedy search (D-14,
the private QC folder's `tools/b2-group.js`) over all anchor pairs and 0–100%, re-verified
against a real browser rather than trusted from the search's own (float) prediction, one case
(`#26221e`) needed hand-tuning from the predicted 50% to the measured 51% after Chromium's actual
rounding differed from the prediction by one unit.

**Total: 36 new `--sc-th-*` tokens** (24 + 12). `--haze-*` names are kept unrenamed, only their
literal values are tokenised (rejected: renaming them, pure churn with no gate value). The three
unread `--haze-paper`, `--haze-paper-ink` and `--haze-paper-link` (zero `var()` consumers
anywhere) are deleted outright rather than tokenised.

Alpha (SD-5): `color-mix(in srgb, <base-expr> N%, transparent)`, N the original alpha × 100 (all
values in this file were already clean two-decimal fractions, so no rounding was needed there).
Black alphas (`rgba(0,0,0,N)`) use the literal `#000` directly inside `color-mix()`, the
precedent at `scriptorium.css:1277`, since `#000`/`#fff` are the one exception the colour-
discipline test (H10) allows outside a token. Alpha-0 literals (two of them,
`rgba(27,31,26,0)` and `rgba(36,34,30,0)`) become the literal `transparent`.

**Equivalence table** (the private QC folder's `b2/equivalence.md`, Appendix B): one row per
changed literal (63 rows, every distinct literal string in the pre-B2 theme, minus the three
deleted), each resolved in both Chromium and Firefox through a probe element
(`<div style="color: <expr>">`, tokens declared on `<html>`), 8-bit quantised, alpha scaled ×255.
**Max channel delta: 1, on both engines, across every row.** Alpha-0 rows compare alpha only (a
fully transparent colour's RGB channels never paint a pixel, and the two engines canonicalise
`transparent` to `rgba(0,0,0,0)` regardless of the literal's own, also-invisible, RGB).

**A found, confirmed residual: B2's `color-mix()` substitution itself causes a deterministic,
sub-pixel (≤2), imperceptible rendering shift.** Diffing S1 (literal colours) directly against S3
(tokenised) on the same vault-haze build, isolated from the reference-vault switch and the §5
comment-landmine defect, shows 17 of 48 page/width checks differ, every one at `changedPixels: 0`
(pixelmatch's own perceptual comparator finds nothing a viewer would notice) and
`maxChannelDelta: 2` (the separate, non-perceptual raw-channel scan). T11/T12's 19+13 tokens are
consumed broadly, on nearly every page via the `LEAF`-scoped selectors, not only the landing-page
hero; a `color-mix()` result is not guaranteed to share a literal colour's exact internal
representation once actually painted (CSS Color 4 does not require it), so a value the
equivalence table itself measures at 0 or 1 delta in isolation can still round by up to 1 further
channel unit once composited on a real page. This is a real, deterministic, and reproducible
effect of B2's own substitution, confirmed on repeated runs and unchanged before and after two
rebases, not incidental cross-build noise, and not something to revert (reverting would mean
keeping raw literals in the shared token blocks, defeating B2's point for a difference nothing
can see). Full writeup: the private QC folder's `gates/S3/found-residual-subpixel-filter-noise.md`.

**Token blocks move (SD-4):** the three custom-property-only blocks, the new `--sc-th-*` block,
the (trimmed) `--haze-*` block, and the two pre-existing `--sc-leaf-*`/`--sc-tl-on-cx-*` blocks,
move to directly after the imports, in that order, keeping their own relative order. This is
cascade-neutral (§4) and is what lets a future theme variant's palette live in one place a reader
finds first.

## 7. `--sc-hero-h`

`assets/site/scriptorium.css`'s Full-bleed hero rule now reads
`height: var(--sc-hero-h, calc(var(--sc-space-8) * 7))`. Nothing declares `--sc-hero-h` in this
phase, it is a product-only hook for a future theme or campaign to override the hero's fixed
height without duplicating the whole rule, so every pixel gate involving it stays at exact 0/0.

## 8. The rename, with no alias

`--sc-on-haze` becomes `--sc-on-named` throughout (`assets/site/scriptorium.css`'s own default
declaration and its two consumers, and the haze theme's own T12 override), in one commit, with no
transition alias (D-15): the old name was product-internal (never read by campaign CSS, per the
classification table, T12 owns the only other declaration of it, moved in the same phase), so
there is no external consumer to break.

## 9. `config/theme-scheme-mismatch`

New `src/checks/themescheme.js` (SD-6), registered as `config/theme-scheme-mismatch` (info,
default-enabled). Reproduces the pin's own palette merge (`lib/config.js:257-262`) and light/dark
rule (`lib/theme.js:96-110`) directly from `_meta/vault-config.md`, through
`src/vault/read.js`'s read-only chokepoint, never the pin's own `loadPublishConfig` (bypasses
that chokepoint, writes warnings to stderr) and never `generateThemeCSS`'s emitted text (parsing
colours back out of generated CSS is fragile, and was rejected explicitly). `parseHex`/`luminance`
are a cited, verbatim port of `lib/theme.js:48-63` (neither is exported by the pin), kept honest
by a parity test that deep-requires the pin's real `lib/config.js` and `lib/theme.js` and compares
outputs across nine cases including genre presets and an exact-luminance-0.5 boundary value.

**Default-background correction (deviation 1, decided going in):** the requirements' literal
`'#1a1f25'` default is the pin's own *pre-merge* fallback inside `generateThemeCSS`, but the
merge in `lib/config.js` always runs first in real use, and fills a palette with no
`background` key from `PUBLISH_DEFAULTS.theme.palette.background`, which is **`'#e8f0f3'`, a
light colour**. Using `'#1a1f25'` as "the" default would make this check silent for the single
most likely real mismatch (a vault with no `theme:` block at all, selecting `haze`, a dark theme).
The check follows the pin's real, full two-stage pipeline instead, and its own parity test proves
that reading matches the pin's, not a hand-picked literal.

`SCHEMA_VERSION` stays 1; the `--json` envelope shape is unchanged (a new finding id, same shape
every other check already produces).

## 10. Packaging: 34 to 36; G6 closed

`assets/themes/haze/{theme.css,theme.json}` join `pkg.assets` (a new
`"assets/themes/**/*"` glob) and the hand-maintained `FIRST_PARTY_SITE_ASSETS` literal
(`scripts/pkg-assets.js`) that literal drives, 34 embedded assets becomes 36. A Linux packaged-
binary snapshot proof (`node scripts/package.js --target node22-linux-x64`) builds a synthetic
haze fixture from the packaged executable and confirms its `css/scriptorium-theme.css` matches
the source `theme.css` bytes exactly, closing ADR 0019's G6 ("no file-backed theme has ever been
proven to survive packaging") for Linux. Windows packaging is unverified by construction (this
repo's toolchain cross-compiles, never runs, a Windows binary) and stays OPEN, C36 below.

## 11. What 3b removed; the NFR-11(e) residue list; D-09

Removed: `docs/handoff/campaign-ui/` (its `css/overrides.css`, `vault-config.patch`,
`APPLY.md`) and the three tests that guarded its now-gone structure
(`test/handoff-campaign-ui.test.js`, `test/handoff-bookleaves.test.js`,
`test/handoff-story.test.js`). **D-09 supersedes ADR 0018's lockstep rule**: ADR 0018 required the
handoff file and the repo's product stylesheet to move in lockstep; that requirement is retired
along with the file it was protecting; `assets/themes/haze/theme.css` is now the sole successor
and needs no lockstep partner.

**NFR-11(e) residue**, verbatim, for whoever next touches the private QC tree or the real vault:
the patch and `APPLY.md` content (the vault-config edit that previously turned on the handoff
file) becomes an S5 checklist item, updating the real vault's `pack.toml` to `theme = "haze"`
and removing its now-redundant `css/overrides.css` content is a live-runbook, human action, not
automated by this phase (S5 itself is out of scope here and was never run).

## 12. Rejected

- **Keeping the repo copy until phase 6.** Two copies of the same generic CSS (one live in the
  theme, one dormant in `docs/handoff/`) is a drift trap with no compensating benefit once the
  theme exists.
- **Atlas in the theme.** The ground treatment names a vault asset path start to finish; it is
  CAMPAIGN by SD-7's own test and stays out.
- **Tokenising the data-URI art.** The two `--haze-h-mask`/`--haze-h-marks` SVG data URIs are
  raw asset bytes, not colour, and are excluded from every B2 pass by construction (protected
  before substitution, restored after, byte-identical).
- **A separate `FIRST_PARTY_THEME_ASSETS` literal.** One literal, one gate; a second list for the
  same packaging check is a second place to forget to update.
- **Renaming `--haze-*` to `--sc-th-*`.** Churn with no gate value (§6).
- **Parsing `generateThemeCSS`'s emitted CSS text to recover the scheme.** Fragile string
  matching against a generator internal that owes this module no contract (§9).

## 13. Will catch / will not catch, deliberately

- **Will catch:** a vault selecting `haze` whose palette resolves light (the check fires); a
  future theme mismatched the same way (the check is theme-agnostic, keyed on `theme.json`'s own
  `scheme`).
- **Will not catch:** `:hover`, `:focus-visible` or view-transition pseudo-state colours (out of
  the token/equivalence-table scope, and out of H9's pixel-coverage scope, inherited from S0's
  own selector-coverage residuals, carried forward unchanged). H9's ten data-dependent selector
  residuals (no entity in the real vault currently has the affected statuses, and one location is
  DRAFT-confidence and never published), see S0's own README for the full list; nothing in this
  phase changes them. `haze` inherits whatever font family the vault's own config or genre
  supplies; it does not enforce its own. One-column PC roster on a vault whose party size differs
  from this one's, since the grid's own column counts are CAMPAIGN by design (§11's residual). Genre-preset
  palettes are undetermined by `paletteScheme()` (returns `{scheme: null}`) whenever a genre
  resolves, this is deliberate (§9's rejected alternative), not a gap to close later. **Windows
  packaging is OPEN** (C36, `.agents/windows-verification.md`), this repo's own toolchain never runs a
  Windows binary, only cross-compiles one; every "packaging proven" claim in this ADR is scoped to
  the Linux target actually executed.

## 14. Appendices

**Appendix A, the classification table.** Reproduced verbatim from the Engineering Brief
(a private working document, not in this repository; this ADR is the
durable copy). Line numbers refer to the extraction source; no campaign values, vault paths
redacted to `<vault path>`.

| Row | Lines | Selector | Class, and why |
|---|---|---|---|
| I | :36, :37, :43 | three `@import`s | THEME: fonts (D-10) |
| C1 | :47-76 | `:root` | CAMPAIGN: palette fix |
| T1 | :91-93, :103-106, :107-117 | `.pull-quote`, `::before` | THEME: pull-quote brass |
| C2 | :129-131 | `.breadcrumbs .sep` | CAMPAIGN: palette fix |
| C3 | :162-166 | badge classes | CAMPAIGN: editorial hide |
| C4 | :184-189 | six `.status-*` rules | CAMPAIGN: status pills |
| C5 | :200-201 | creature pills | CAMPAIGN: creature pills |
| C6 | :223-225 | `.metadata-badge` | CAMPAIGN: palette fix |
| C7 | :250-253 | `.four-oh-four-image` | CAMPAIGN: image mask |
| C8 | :266-275 | `.landing-hero-img` | CAMPAIGN: image mask |
| C9 | :338-344, :425-454 | crest rules | CAMPAIGN: vault folder path |
| C10 | :517-555 | `html::before/::after` | CAMPAIGN: ground, vault asset path |
| C11 | :580-583 | ground suppression | CAMPAIGN: vault asset path |
| T2 | :611-622 | `body:has(...)` | THEME: 10 `--haze-*` tokens (7 after S3's dead-code deletion) |
| T3 | :648-651 | `html:has(.landing-hero)::before/::after` | THEME: landing guard |
| T4 | :659-750 | 11 rules | THEME |
| T5 | :771-787 | `main.content:has(...) > .landing-hero` | THEME |
| S-A | :788-800 | `.landing-hero > .landing-hero-img` | SPLIT: `object-position` CAMPAIGN, rest THEME |
| T6 | :801-911 | hero pseudo-elements, keyframes, h1, tagline, dates | THEME |
| T7 | :915-1025 | recap br/em; slip slot | THEME |
| T8 | :1029-1080 | pc-card, portrait | THEME |
| S-B | :1081-1085 | `.pc-roster` | SPLIT: `grid-template-columns` CAMPAIGN, rest THEME |
| C12 | :1086-1090 | `@media (max-width:1100px) .pc-roster` | CAMPAIGN |
| S-C | :1091-1096 | `@media (max-width:600px) .pc-roster` | SPLIT: `grid-template-columns` CAMPAIGN, `gap` THEME |
| T9 | :1099-1233 | registers | THEME |
| T10 | :1236-1250 | `@media (max-width:600px)` narrow-screen | THEME |
| T11 | :1267-1289 | `:root` `--sc-leaf-*` (19) | THEME |
| C13 | :1298-1300 | `data-field="status"` | CAMPAIGN: editorial |
| C14 | :1306-1308 | `data-field="session_number"::before` | CAMPAIGN: caption |
| T12 | :1321-1335 | `:root` `--sc-tl/on/cx-*` (13) | THEME |

**Appendix B, the equivalence table.** 63 rows, private
(the private QC folder's `b2/equivalence.md`, `.json`), max channel delta 1 on Chromium and
Firefox alike. Not reproduced here (it is old-literal-to-new-expression detail with no reader
value beyond the phase that produced it); the summary in §6 states the result the gate cares
about.

## Addendum (issue #84): fonts are self-hosted

The three Google Fonts `@import`s are gone. haze uses the same five woff2 files gloam ships, unmodified,
and a `NOTICE.txt` (both now shared with gloam, see the `fontsFrom` addendum below), and declares them
with `@font-face` rules at the top of `theme.css`.
Chosen over the generator's `fonts.source: self-host` (publish 1.11.40) because that downloads fonts
at build time into the vault, so builds would need the network and would not be reproducible.
Loader consequence (src/build/themes.js): a child theme's composition skips a parent's leading
`@font-face` blocks like its leading `@import`s, and a parent's `fonts/` and `NOTICE.txt` are accepted
when the child has its own (gloam does); a parent's `images/` is still refused. (As first built, haze
carried its own copies of the files; the next addendum replaces that.)

## Addendum (issue #84 follow-up): `fontsFrom`, one shared copy of the fonts

Summary: haze no longer carries its own `fonts/` or `NOTICE.txt`. Its `theme.json` says
`"fontsFrom": "gloam"`, and the loader reads gloam's five woff2 files and NOTICE instead. Built sites are
byte-identical to before, because the files still emit under `scriptorium/theme/fonts/` and the notice
still reaches the site's `NOTICE.txt`; a haze-only site still gets working fonts.

What the field does (src/build/themes.js): `fontsFrom` is an optional string naming another registry theme.
That theme's `fonts/` folder and `NOTICE.txt` are used as if the naming theme owned them.

Failure modes, each a `theme "<name>" is broken` error covered by test/theme-fonts-from.test.js:
- a value that is not a string, or names no registered theme;
- a theme naming itself;
- naming `plain` (or any theme with no files);
- naming a theme that itself has `fontsFrom` (one level only, no chains);
- a theme that sets `fontsFrom` and also carries its own `fonts/` or `NOTICE.txt` (ambiguous).

Why share instead of duplicate: the two copies were byte-identical (same sha256), so the privacy guard's
pinned font residual doubled (`font-binary=33 files=9` against `=17 files=5`) and the public tree carried
five more binaries for no gain. One copy keeps the residual and the binary smaller (the packaged asset count
drops 78 to 72) and leaves one attribution per font family in THIRD-PARTY-NOTICES (Section 7 covers both
themes; the separate haze Section 8 is gone). Cost: haze now depends on gloam's folder; the tests assert
the shared files exist, match gloam-FONTS.json and load for haze.
