# 0032. The gloam base theme

## Summary

Scriptorium ships a new built-in theme, gloam, and it becomes what `init` offers a new campaign
by default. The theme carries its own dark colour palette and its own typefaces, packaged inside
the tool so a built site never has to ask a font service for anything. It reuses the existing
`haze` theme's shared rules instead of copying them, so the two stay in step automatically. Every
site that already exists, whether it has no theme set, uses `plain`, or uses `haze`, keeps
producing the exact same bytes it did before this change; only a brand new campaign sees the new
default. The main cost is size: the self-hosted font files add a little over 600 kilobytes to every site
gloam builds and to the packaged program itself (they were shipped as plain TTF at first, adding
closer to 2.5 megabytes; the owner then approved converting them to the standard, more compact
web font format, which is what ships now).

Status: accepted (2026-09-30).

## 1. The problem

`haze` (0023) gave Scriptorium one real, file-backed theme, but a GM who wanted their own visual
identity, a dark reading page with a painted backdrop, still had to hand-write a campaign
stylesheet from scratch and pull in Google-hosted fonts to get it. That stylesheet had already
been drafted once, for a real campaign, and it separated cleanly into a generic part any campaign
could reuse and a handful of campaign-specific values (a folder path, one image crop, a party
size). This decision turns the generic part into a second built-in theme and makes it the
default a new campaign starts with.

## 2. Decision

A new theme, gloam, sits in the registry next to `plain` and `haze`. Its stylesheet is composed at
load time from `haze`'s own file plus gloam's own additions, so the two are never two hand-kept
copies of the same rules. It declares that it owns both the page's colour palette and its type,
so a vault's own palette and font settings never reach a gloam page, and the built-in scheme check
stops treating that as a mismatch. It draws four of the product's six image slots (a banner, a
page backdrop, a paper texture and a not-found backdrop), each of which is optional and, unset,
draws nothing and makes no request. It ships five font files, self-hosted, copied into every
site it builds. `init`'s own default becomes gloam; the separate default a pack file resolves to
when it names no theme at all stays `plain`, so existing sites are unaffected.

## 3. Why compose rather than copy

Copying `haze`'s roughly 600 lines into gloam, including its embedded artwork, would create a
second copy that silently drifts the next time someone edits `haze`. A generated copy behind a
freshness check still leaves two files in the tree and in the packaged program, and adds a
regeneration step every time `haze` changes. Composing at load time keeps `haze`'s own file the
single source of that shared material: gloam's own file adds only what is actually new. The loader
finds where a parent theme's font imports end (skipping over any comment that immediately follows
them) and starts the composed file there, so gloam never inherits `haze`'s own third-party font
requests.

## 4. Ownership

A theme's own definition can now say it owns the palette, the fonts, or both. When it owns the
palette, the built-in check that otherwise warns a GM their palette doesn't match their theme's
light or dark scheme stops firing for that theme, because the vault's palette no longer has any
effect on the page. The admin panel mirrors that same rule on the page it shows a GM before they
save a change, kept in step with the server side by its own cross-check tests, rather than adding
a new field to an endpoint that already ships.

## 5. Content

The theme's colours are a small set of named anchors (a background, an ink colour, an accent, a
header shade and a muted tone, plus one more used only behind the header text) that everything
else derives from. Its status and creature indicator colours use the same small set of anchors.
Every colour value in the file goes through a token or a colour-mix function rather than a raw
literal, matching the discipline `haze`'s own file already follows. The page backdrop, the paper
texture, the hero image and the fallback from a missing not-found image to the site's own hero
image are all controlled by a short list of custom properties a campaign's own stylesheet can
re-declare to fit its own art, exactly the surface the original hand-written campaign stylesheet
needed. A generic multi-column layout for the party roster moves into the theme, closing a gap
`haze` itself had left open for every campaign to solve on its own. Nothing in the theme hides
draft markers, stub badges or a status field; those stay a campaign's own choice, in its own
stylesheet.

## 6. Fonts

The theme embeds five font files, sourced from unmodified copies of files Google's own font
collection publishes under the SIL Open Font Licence, at one fixed, recorded source commit. Two of
the three type families were already embedded elsewhere in the product for the admin panel, and
this reuses the exact same upstream bytes rather than shipping a second copy; the third family's
two files are new. The files are walked from the theme's own folder the same way its images are,
with the same symlink refusal and the same size limit, and copied into every site the theme
builds. Every site's own third-party notice file gets the fonts' licence text appended, and the
program's own bundled notices gain a matching section.

The five files ship as WOFF2, not as the plain TTF files they started from. This was a later
decision: an early measurement showed 2.3 to 2.5 megabytes of fonts on a page's first view,
against a few hundred kilobytes for a font service's own compressed subsets. The owner installed a
standard, freely available conversion tool and approved converting all five faces. This is a
lossless repackaging, not a rewrite of the font data, and it cuts the shipped bytes by about
three-quarters; the measurements section below has the exact numbers. The unmodified TTFs are not
kept anywhere in this tree; the pinned upstream commit, the converter's own name and version, and
both the TTF's and the WOFF2's own checksums are recorded instead, which is enough for anyone to
reproduce the exact same output.

## 7. Rejected alternatives

For sharing `haze`'s rules: copying the file (the drift problem above), a generated copy kept
fresh by a build step, and splitting `haze` itself into shared and unshared files, which would
touch a file this product's own tests currently pin unedited.

For ownership: a single string field naming which concern a theme owns, rejected because it grows
the shape for one campaign's worth of themes without buying anything; reporting no scheme at all
for an owning theme, which would break the one place the admin panel already needs a theme's real
scheme; and boosting the theme's own selector specificity to force a win, which would also stop a
campaign's own stylesheet from overriding the theme, the opposite of what a campaign layer is for.

For fonts: reusing the admin panel's own font copies directly, which a separate test already
forbids; adding the new files to the admin panel's own font list, which is pinned to exactly its
own eight files; subsetting the fonts (still not approved: a Latin-only subset would cut bytes
further, but it raises the OFL's Reserved Font Name question the WOFF2 repackaging avoids); and
using the underlying page generator's own font self-hosting option, which needs a network-filled
cache this product deliberately never builds.

For the default: flipping the existing resolution default itself to gloam, which would change the
output of every site that names no theme at all, breaking the guarantee ADR 0019 gives those
sites.

## 8. Will catch

- A theme's `extends` value naming a theme that doesn't exist, that names itself, that has no
  files, or that itself extends another theme.
- A parent theme carrying its own images, fonts or licence notice, none of which a child theme
  inherits.
- An `@import` anywhere in a child theme's own file, or outside a parent's own leading run of
  imports.
- A malformed ownership declaration.
- A font file behind a symlink, an unrecognised extension, or over the existing size limit.
- A missing generator colour variable, an unshipped or unreferenced font face, a raw colour
  literal outside a colour-mix function, or the word "gloam" itself, in the composed stylesheet.
- A light palette meeting gloam (no finding, by design) against the same palette meeting `haze`
  (which still fires).
- A site missing its font licence text.

### What the theme adds to a built site

Everything gloam puts into a built site is drawn from this fixed, small vocabulary, none of it
depending on any campaign's own content, which is what makes it possible to tell the theme's own
material apart from anything a campaign layer or a vault might add.

The five font files, each copied into the site's own `scriptorium/theme/fonts/` folder:
`IMFeENrm28P.woff2`, `IMFeENit28P.woff2`, `IMFeENsc28P.woff2`, `CormorantGaramond-wght.woff2` and
`CormorantGaramond-Italic-wght.woff2`. Every one of the five embedded font rules reads the same
way: `font-display: swap`, and a source in `format("woff2")`, the compact web format described in
section 6 above, not the plain TTF format the files started as. Behind those files sit three type
family names: IM Fell English, IM Fell English SC, and Cormorant Garamond.

Sixteen named colour anchors, each starting `--sc-base-`: `--sc-base-bg`, `--sc-base-ink`,
`--sc-base-accent`, `--sc-base-desk`, `--sc-base-muted`, `--sc-base-nav-muted`, `--sc-base-alive`,
`--sc-base-alive-ink`, `--sc-base-dead`, `--sc-base-missing`, `--sc-base-captured`,
`--sc-base-captured-ink`, `--sc-base-retired`, `--sc-base-retired-ink`, `--sc-base-killed` and
`--sc-base-active`. These are the palette itself, plus every status and creature indicator colour.

Eight named knobs a campaign's own stylesheet may re-declare to fit its own art: the page
backdrop's `--sc-ground-size`, `--sc-ground-position`, `--sc-ground-filter`, `--sc-ground-opacity`,
and the two points its fade runs between, `--sc-ground-fade-from` and `--sc-ground-fade-to`, plus
the hero image's own `--sc-hero-filter` and `--sc-hero-position`.

Four named image fallbacks, each starting `--sc-img-`, one per optional slot the theme draws:
`--sc-img-ground`, `--sc-img-paper`, `--sc-img-hero` and `--sc-img-404`, the last of which falls
back to the hero image's own name before falling back to nothing.

## 9. Will not catch

- A vault that names a specific Google-hosted font family in its own settings still causes the
  page generator to request it, regardless of theme; so does the separate "sci-fi" genre preset's
  own imported family. Neither is this theme's own request.
- A handful of colour variables and light-mode element rules that only exist on a genre-preset
  vault with the colour-mode toggle; those are measured at merge, not caught structurally.
- Hover and focus colours, inherited from `haze` unchanged.
- Rendering differences between the self-hosted files and a font service's own served subset;
  these are measured, not asserted as identical.
- Font file content beyond its file extension; the loader doesn't parse font files.
- A withheld name that happens to equal an ordinary font-related word; this product never
  suppresses a real finding to avoid a coincidence.
- A site whose own output folder mapping collides with the folder theme assets are written under;
  this already refuses today, for any theme with files to write.
- Windows-specific behaviour, open until confirmed there.

## Evidence

- Composition and the ownership declaration: `src/build/themes.js`.
- The scheme check's ownership branch: `src/checks/themescheme.js`.
- The admin panel's mirrored check: `assets/admin/slip.js`, cross-checked against a real server
  response by `test/admin-v1b-server.test.js`.
- The theme's own files: `assets/themes/gloam/theme.json`, `theme.css`, `NOTICE.txt`, `fonts/`.
- The font provenance record, including the converter's own name, version and licence, and each
  file's source TTF sha256 alongside its shipped WOFF2 sha256: `scripts/vendor/fonts/gloam-FONTS.json`.
- The OFL's own position on WOFF/WOFF2 repackaging: the OFL FAQ, `openfontlicense.org/ofl-faq/`,
  questions 2.2 ("Can I make and use WOFF (Web Open Font Format) versions of OFL fonts?"), 2.2.1
  ("How can I make sure that a WOFF/WOFF2 version is not considered modification?") and 2.2.2
  ("Do WOFF conversion tools and services automatically meet these requirements?"). The condition
  in 2.2.1 (unchanged font data except for the compression itself, and unaltered WOFF metadata)
  was checked here by decompressing each shipped file and comparing its SFNT table checksums
  against the source TTF, not merely assumed from the FAQ answer alone, in light of 2.2.2's
  warning that not every tool qualifies.
- The asset step's font handling: `src/build/themeassets.js`.
- `init`'s default split: `src/build/themes.js`'s two default constants, `src/cli/init.js`.
- The admin panel's slot notes: `assets/admin/images.js`.
- Tests: `test/theme-extends.test.js`, `test/theme-gloam.test.js`, `test/theme-gloam-fonts.test.js`,
  plus updated cases across the registry, packtoml, build, init, admin and package-config suites.
