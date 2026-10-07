# 0019. Themes, image slots and the asset step

Status: accepted (2026-09-25).

## Summary

A campaign can now choose a theme and supply images for six named places on its site, called slots, through an optional `pack.toml` file in its campaign pack. Scriptorium copies each chosen image to a fixed, predictable location and declares it to the stylesheets as a CSS variable, so a campaign no longer needs the generator's output layout to use its own art. Discovering themes by scanning a folder was rejected, because an unknown theme name should fail loudly and list the valid ones. A campaign with no `pack.toml` builds exactly the same site as before.

## The problem

GM-Scriptorium's product stylesheet and the campaign's own `css/overrides.css` are both static:
neither can name a campaign-supplied image without coupling itself to the generator's own output
layout, and in player mode the pin only copies attachments a *published page* references (pin
`lib/build.js:779-785`, `usedImages` at `:558`). A campaign stylesheet that names
`url("../images/<attachment path>")` directly, for instance, a `<location painting>` used as a
page's background, therefore 404s unless some other published page happens to embed that same
attachment. There was also no way to select between look-and-feel variants at all.

This phase adds an optional `pack.toml`, a literal theme registry (holding only `plain` in this
phase), six validated image "slots" copied to a stable, generator-independent location, and a small
declaration stylesheet that exposes them as CSS custom properties. None of it is required: a
campaign with no `pack.toml` builds a byte-identical site to the one before this change.

## `pack.toml`

- It is optional and lives in the resolved site dir (ADR 0018): the legacy `site_config` directory,
  the `pack` key's directory, or the convention directory, whichever `resolveSiteSource` picked.
- It is read through `read.readText` (the vault chokepoint) and parsed with the already-pinned
  `smol-toml`.
- Top-level keys are `theme` (a string, default `"plain"`) and `[images]` (a table of slot name to
  path). Any other top-level key, and any unrecognised `[images]` key, produces a human-only
  `warning:` line and is otherwise ignored, never a hard error, and never reflected in `--json`.
- Every other problem, bad TOML, a non-string `theme`, an unknown theme, a wrong-shaped `[images]`
  table, a malformed slot path, is a one-line `ConfigError` naming the file, in the same family as
  every other config error this codebase raises (`errors.js`'s `ConfigError`, carrying `{ path,
  campaign }`).
- **It is the opt-in for the whole asset step.** No `pack.toml` means the plan is empty and nothing
  is read, copied or linked, not even the pack's own `images/` folder, which is what makes "no
  `pack.toml` is byte-identical" true by construction, and what protects a legacy site dir (also a
  "resolved site dir" under ADR 0018) from suddenly growing a scan of a folder it never had reason
  to have.

## Registry and `plain`

- `THEMES` is a frozen literal, `{ plain: { name: 'plain', dir: null } }`, looked up **own-property
  only**, never `'name' in registry`, which would also see inherited `Object.prototype` members
  such as `toString`.
- `plain` is the default and has no files: `loadTheme('plain')` does no filesystem access at all and
  returns `{ name, dir: null, scheme: null, slots: [], css: null, images: [] }`.
- An unknown or wrong-case theme name is refused during `pack.toml` parsing, and the error lists the
  registry's own valid names (sorted), so a typo is diagnosable without reading source.
- The file-backed path exists, `theme.json` (`name`, `scheme: "dark"|"light"`, `slots`: an array of
  distinct slot names), a required `theme.css`, and an optional, recursively walked `images/` folder
  (sorted, symlinks refused, non-allowlisted files refused), but no theme ships with one in this
  phase (G6, below). It is proven only with a test-injected fixture theme, because every function
  that touches a theme takes `registry = THEMES` as a parameter: a test can hand it a throwaway
  registry pointing at a scratch directory, and the product registry never has to hold more than
  `plain` for that to be exercised.
- **Rejected: discovering themes by walking a directory.** The registry literal is the manifest,
  the same argument ADR 0012's SD-6 already made for a different literal-vs-directory-walk choice in
  this codebase: an unknown theme should fail loudly and list what *is* valid, not silently skip a
  folder that doesn't parse.

## Slots and validation

The six slots are `hero`, `ground`, `paper`, `crest-frame`, `portrait` and `404`. A slot value is
either a path relative to the pack (e.g. `"images/example.webp"`) or a vault path prefixed
`"vault:"` (e.g. `"vault:<attachment path>"`).

**Syntax refusals** (pure, no filesystem access, run during `pack.toml` parsing, so `check`,
`build` and `status` all refuse alike): a backslash anywhere in the value; an absolute path (a
leading `/`, or a Windows drive letter); a URL scheme; a `..` path segment; an empty or `.` path
segment; and, for a `vault:` value only, a first segment (case-folded on win32/darwin) equal to
`_meta`.

**File refusals**, run in `planThemeAssets` (P3a-FR06), in a fixed, tested order: the requested
path's extension; the exclusion rule (`vault:` values only, both the requested path and, again,
after resolving symlinks, the real path); the target exists; the target is a regular file; real-path
containment inside the vault (or the pack, for a pack-relative value); the real path's own extension
(a symlink can point somewhere with a different extension than its own name suggests); and the size,
checked twice, once from `stat`, once from the byte length actually read, so a file that changes
between the two never slips through under the limit. The limit is 10 MiB (10485760 bytes), inclusive.

**Everything happens before staging** (Structural decision 4): syntax validation lives inside
`resolveVaultContext`, and the file-check pass (`planThemeAssets`) is called by `build` before
`runAtomicBuild`, before `sweepStaleSiblings`, before anything is written. `--force` never reaches
either stage: forcing overrides a *scan hit*, not a config refusal, and there is nothing here for it
to override.

**The exclusion rule** reuses L2's own semantics (`src/vault/exclusions.js`, extracted from
`src/checks/leak/l2.js` verbatim, so the two never drift), the union of `vault.config.json`'s
`excludeDirs` and `_meta/vault-config.md`'s `publish.exclude_dirs`, plus the pin's own
always-excluded directory names (`_meta`, `_Templates`, `_templates`, `personal`), unioned with two
asset-step-only additions: a single-segment union entry matching at *any* depth (not just as a
prefix, which is all L2's own matcher does, a multi-segment entry such as the live vault's own
`_attachments/maps` needs the prefix form, but a single-segment entry like `personal` should also
catch `NPCs/personal/x.webp`, not only a root-level `personal/`), and any path segment starting with
a dot. Both fold case on win32 and darwin (the same `process.platform` proxy `src/build/plan.js`
already uses, evaluated fresh per call so tests can force it).

**Pack images are exempt from the exclusion rule.** A `vault:` slot is the GM naming something from
inside their own private notes vault, where the exclusion rule protects genuinely-private folders
from an accidental publish; a pack image is already sitting in the GM's own deliberate publish
folder, by convention `_meta/scriptorium/images/`, which the exclusion rule's own `_meta` entry
would otherwise refuse outright, defeating the convention location entirely.

**The plan holds the bytes** (Structural decision 5): each accepted image is read exactly once,
through the vault chokepoint's `readBytes`, during validation, never re-read at write time. There is
no time-of-check/time-of-use window on content, and a slot's output sha256 equals its source's by
construction, not by a separate copy step that could race.

## Output layout

```
<out>/css/scriptorium-theme.css      only when a slot is set or the theme has files
<out>/scriptorium/slots/<slot>.<ext>  one per set slot
<out>/scriptorium/campaign/<rel>      every allowlisted image under the pack's images/ folder
<out>/scriptorium/theme/<rel>         the theme's own images/ folder
```

Nothing is ever written under `images/`, because L2 already reconstructs `images/<rel>` back to
`<attachmentsDir>/<rel>` to check it for leaks (`l2.js:93-124`); writing slot or pack images there
would make L2 misattribute them to a vault path that was never their source.

A slot is renamed to `scriptorium/slots/<slot><lowercased source extension>`, never the source
filename, so a private filename never reaches the built site by accident, and so the declaration
stylesheet's `url()` values are stable regardless of what the GM happened to name the file.

**The collision rule** (Structural decision 6) is a `ConfigError` if and only if the plan has files
to write **and** `<stagingOut>/scriptorium` already exists (most likely because a `folderMap` entry
maps some vault folder's output directly to `scriptorium`). It is checked before any write, and
`runAtomicBuild` does a best-effort, swallowed removal of the staging tree and rethrows, the same
pattern the output-leak scan's own refusal path already uses, so a Windows file lock on the staging
tree can never turn a clean refusal into an uncaught crash. **It is conditional deliberately**: a
plan with no files (a theme with no images and no slots set) never touches `scriptorium/` at all, so
it never refuses on that account either, otherwise a vault whose `folderMap` happens to map a folder
to `scriptorium` would break the moment this phase shipped, even for a campaign with no `pack.toml`
at all, which would violate "no `pack.toml` is byte-identical" (P3a-FR03).

## The declaration stylesheet

`css/scriptorium-theme.css` holds the theme's own CSS verbatim (if any, only a file-backed theme
has any), followed by a `:root { --sc-img-<slot>: url("..."); }` rule listing every slot that is
actually set, in slot-list order. It is emitted if and only if there is something to put in it: a
slot is set, or the theme has CSS of its own (`plain` has neither).

It is one file, not two, and it is linked once per page, not twice (Structural decision 1). A
separate `css/scriptorium-slots.css` was rejected: it would mean two `<link>` tags per page once a
future theme has its own CSS, and a second file to reason about for no benefit, the two things
(a theme's look, and which images fill which slots) are both "how does this campaign visually differ
from the product default", and a page needing both regardless makes one file strictly simpler.
Writing into the product's own `css/scriptorium.css` was rejected: that file is sha-pinned to the
embedded asset and must hold true for *every* vault, pack-having or not. Appending to the campaign's
own `css/overrides.css` was rejected: that file is copied byte for byte from the campaign's own
input, and the slot declarations must exist *before* `overrides.css` is even parsed, so a rule inside
it can consume `var(--sc-img-ground)`. An inline `<style>` block per page was rejected: a relative
`url()` inside it would resolve against the *page's* own URL, which differs by depth and is
undefined for a 404 served at an arbitrary path, exactly the problem the product stylesheet's own
injector (`src/build/housestyle.js`'s SD-3) already solved once by anchoring on an existing `<link>`
instead of computing depth, and this phase reuses that solution rather than reintroducing the problem.
Root-absolute `/scriptorium/...` URLs were rejected: they break a basePath-prefixed site and a local
file:// preview alike.

`@import` stays first in the composed CSS (when the theme has one) because the `:root` rule is
appended *after* the theme's own CSS, never interleaved, CSS requires `@import` to be the first
thing in a stylesheet, and this phase never has reason to put anything before it.

**`url()` inside a custom property**: engines have historically disagreed on whether a relative
`url()` written inside a custom property resolves against the stylesheet that *declares* the custom
property or the one that *consumes* it via `var()`. This phase sidesteps the question rather than
resolving it: both `css/scriptorium-theme.css` and `css/overrides.css` live in the same `css/`
directory, so the two possible resolution bases are identical, and the question is moot for every
`css/`-directory consumer. Consuming `--sc-img-*` from anywhere else (an inline `style=""`, a page
that isn't in `css/`) is out of scope and named below.

## The link

The link is inserted immediately after the `>` that closes the product stylesheet's own
`data-scriptorium-housestyle` link tag, as `\n  <link rel="stylesheet" href="H" data-scriptorium-theme>`,
where `H` is that same tag's own href with its trailing `scriptorium.css` replaced by
`scriptorium-theme.css`. This reuses `findLinkTag`/`deriveHref` from `src/build/housestyle.js`
directly (`deriveHref` gained an optional second parameter, its default, one-argument behaviour is
byte-identical, and its own structural test stays unedited) rather than duplicating housestyle's
depth-free anchoring trick a second time. Because it anchors on an *existing* tag rather than
computing depth or basePath itself, it lands correctly on every page shape the housestyle injector
already handles, a page at any depth, and the differently-cascaded 404 page, with or without a
campaign `overrides.css` link to further anchor on. The marker (`data-scriptorium-theme`) makes a
second pass idempotent, the same way housestyle's own marker does, and a page never carrying the
housestyle tag in the first place is simply never linked, SD-2 does no depth arithmetic of its own
(ADR 0012's SD-3 precedent).

One risk this ordering creates and this phase must never violate: `findLinkTag(html, 'theme.css')`
(housestyle's own SD-3 fallback anchor) also matches `scriptorium-theme.css` by suffix. This is only
safe because housestyle always runs, and completes, before the theme pass ever touches a page.
Nothing in or after this phase may call that fallback again once a page could already carry
`scriptorium-theme.css`.

## The permitted diff

Take a campaign built before this change and build it again with this change. The pack gets exactly
two edits:
- a `pack.toml` of `theme = "plain"` with `[images] ground = "vault:<path to a .webp under the
  attachments folder>"`
- one declaration in `css/overrides.css` changed from
  `background-image: url("../images/<same path below the attachments folder>");` to
  `background-image: var(--sc-img-ground);`

Compared with the earlier build, the output tree differs in exactly these ways:
1. `scriptorium/slots/ground.webp` is added, byte-identical to the vault file the slot names.
2. `css/scriptorium-theme.css` is added. Its entire content is `:root {\n  --sc-img-ground:
   url("../scriptorium/slots/ground.webp");\n}\n`.
3. `css/overrides.css` differs in exactly the one edited line.
4. Every `.html` page carrying the `data-scriptorium-housestyle` link gains exactly the bytes
   `\n  <link rel="stylesheet" href="H" data-scriptorium-theme>` immediately after the `>` that
   closes that link. `H` is that link's own href with its final `scriptorium.css` replaced by
   `scriptorium-theme.css`.
   - Pages without that link are byte-unchanged.
   - No page gains more than one such link.
5. Nothing is removed and nothing else is added or changed; in particular, nothing appears under
   `images/`.

In the `build --json` envelope only `pagesWritten` moves, by exactly +2. `check --json` is unchanged.

## G6

No theme *assets* ship in this phase: no `assets/themes/` directory, no `THEMES_ROOT` constant, and
the registry's only entry (`plain`) has `dir: null`. `package.json`'s `pkg.assets` globs and
`scripts/pkg-assets.js`'s `FIRST_PARTY_SITE_ASSETS` are therefore both unchanged, and the embedded
asset count stays at the same figure `npm run package`'s own gate already enforced before this
phase. A later phase that ships a real, file-backed theme (`haze`) will add its own assets under
`assets/themes/**/*` and its own Windows verification criterion for that; this phase's own Windows
criterion below is explicit that it does not cover that case, because it cannot yet exist.

## Will catch

- Every refusal class above, in both the syntax stage (`pack.toml` parsing) and the file-check stage
  (`planThemeAssets`): wrong extension (requested and real path), missing target, a directory where
  a file was named, a `..` or absolute or URL-schemed or backslashed or empty/dot-segment path, a
  `vault:` path into `_meta/` (directly, or via a symlink whose real path lands there), an oversized
  file (checked twice), a symlink escaping the vault or the pack, a symlink in the pack's `images/`
  folder, and an unknown theme.
- A withheld name inside an SVG slot or an SVG pack image: SVG is not a binary extension to the
  output-leak scan, so it is read as text like any other emitted file (the text arm).
- A withheld name in a pack or theme image's own *filename*: the output-leak scan's path arm reads
  every emitted file's path regardless of its extension, so `scriptorium/campaign/<withheld
  name>.png` is caught even though `.png` itself is never read as text.

## Will not catch, deliberately

- A case variant on a case-insensitive Linux mount: the fold is keyed on `process.platform`, a proxy
  for filesystem case sensitivity, not the mount's actual behaviour (the same residual
  `src/build/plan.js`'s own case-fold guard already documents).
- Image *content*: the allowlist check is on the file extension only. There is no EXIF or embedded
  metadata scan.
- A pack image, or a pack-relative slot: both are exempt from the exclusion rule by design (see
  above).
- A slot whose source also happens to live under the pack's own `images/` folder: it is copied
  twice, once as the named slot and once as an ordinary pack image, because the two arms of
  `planThemeAssets` do not deduplicate against each other.
- A `--sc-img-*` consumer written into an inline `<style>` block or a `style=""` attribute on a page
  outside `css/`: a relative `url()` there resolves against the *page's* own URL, not against
  `css/scriptorium-theme.css`'s.
- A pack `images` folder that is itself a symlink resolving inside the pack: only the *entries inside
  it* are checked for being symlinks; the folder itself being a symlink is not specially detected
  (though its target must still resolve inside the pack for anything under it to pass containment).
- An `ENOTDIR` path (a segment of a slot's path exists as a file, not a directory): this surfaces as
  an ordinary filesystem read failure (`VaultReadError`), exit 1, not one of the named refusal
  messages above.
- Accepted images: they are held in memory (as `Buffer`s) from validation until the write pass, not
  streamed, per SD-5.
- An older Scriptorium version, which simply ignores `pack.toml` entirely and renders the campaign
  with no image in the slot's place (the `var()` is undefined; nothing crashes).
- `check` and `status`: neither validates slot *files* in this phase, only `pack.toml`'s own syntax.
  File validation, and therefore any finding about a missing or oversized image, exists only inside
  `build`, until a later phase adds it to `check`.
- A real-path swap that happens between the `realPath` containment check and the later `readBytes`
  call (a TOCTOU window on the *filesystem path itself*, as distinct from content, SD-5 already
  closes the content-level TOCTOU by reading bytes exactly once).

## Not decided here

A file-backed theme beyond the registry mechanism proven by a test fixture (a real theme, `haze`,
with its own `assets/themes/` shipment); the dark/light scheme becoming an actual `check` finding;
a `--sc-hero-h` custom property or any CSS consuming the `hero`, `paper`, `crest-frame`, `portrait`
or `404` slots specifically; a remote (http/https) image source; and `pack.toml` findings surfacing
in `check`. All are out of scope for this phase.

## Addendum: exclude-dir matching now always folds case (2026-09-30)

`src/vault/publishset.js`'s `isExcludedDir` no longer hand-rolls a case-sensitive
`relPath === ex || relPath.startsWith(ex + '/')` comparison. It now defers to the facade's
`dirIsExcluded` (`gm-apprentice-publish/lib/scanner.js`'s own `matchExcludedDir`), which
lowercases both sides before comparing, deliberate on the pin's side, because the filesystem the
scanner walks may or may not itself be case-sensitive (macOS/Windows: usually not; Linux: usually
so), and a vault-config entry spelled with different casing than the on-disk folder must still
exclude it consistently regardless of platform. `computePublishedSet` also now passes the pin's own
`scanConfigFor(config, publishConfig)` output into the scan, not the raw site-config object, so the
walk sees the same merged, unioned `exclude_dirs` a real build's `lib/build.js` does (Δ, upstream's
own #209 follow-up, see the ADR 0005 addendum's publishset-drift note for the full story). Neither
change touches containment folding (`isInsideReal`/`platformFoldsCase`), which is unrelated and
frozen for this track.
