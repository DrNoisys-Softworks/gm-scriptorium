# Image slots

This page is for GMs choosing and sizing art for a Scriptorium site. It explains the six image
slots the admin panel offers, which of them the built-in themes already draw, and the sizes to
prepare art at.

A slot is a named place your own art can go. The panel's Images screen shows six, by the name you
see in the panel: Landing banner (`hero`), Page backdrop (`ground`), Paper texture (`paper`),
Emblem frame (`crest-frame`), Character portrait (`portrait`) and Not-found page (`404`). The code
name in brackets is what a theme's own CSS and `overrides.css` use; the panel keeps it as small
print beside the panel name. Setting a slot doesn't do anything by itself unless a theme draws it
or your own `overrides.css` reads it; the panel marks each spot "set, unsaved or empty" depending
on whether it currently has a value, that value hasn't been saved yet, or nothing has been chosen.

## What each slot is for

| Name in the panel | Code name | What it's for |
|---|---|---|
| Landing banner | hero | A wide picture meant for the top of your landing page. No built-in theme puts it there today; see the gloam note below. |
| Page backdrop | ground | A picture fixed behind your pages, showing around the edges of the text. |
| Paper texture | paper | A small image repeated behind text and cards, like paper grain. |
| Emblem frame | crest-frame | A decorative border for faction crests and emblems. The only slot whose convention needs transparency (PNG or WebP). |
| Character portrait | portrait | An upright character portrait (3:4, a "Cover" crop). |
| Not-found page | 404 | The picture on the page players land on when a link goes nowhere. |

The panel's own Images screen shows a small schematic diagram next to each slot's row, sketching
roughly where it sits on a page.

## The built-in gloam theme

The built-in `gloam` theme, which new campaigns get by default, draws four of the six slots:
`hero`, `ground`, `paper` and `404`. `plain` and `haze` draw none. `crest-frame` and `portrait`
only apply once your own `overrides.css` reads them, under any theme.

- **`ground`.** A large image, fixed behind every inner page, crushed dark so its highlights never
  push body text under an easily readable contrast, then faded away below about halfway down the
  page.
- **`paper`.** An optional grain laid over the reading page, blended so it adds texture rather
  than lifting the dark background into blotches.
- **`hero`.** Used as the not-found page's backdrop when no `404` slot is set (see the fallback
  below). The image gets the same colour grade as the landing hero.
- **`404`.** The not-found page's own backdrop, when set. If it isn't set, the `hero` slot is used
  instead; if neither is set, the page stays flat and legible and makes no request for an image at
  all.

An unset slot under gloam never makes a request, exactly like under `plain` or `haze`.

### Campaign-layer knobs

A campaign's own `overrides.css` can re-declare any of these custom properties to fit its own art.
gloam's own defaults are shown.

| Knob | Default |
|---|---|
| `--sc-ground-size` | `cover` |
| `--sc-ground-position` | `50% 0` |
| `--sc-ground-filter` | `saturate(0.45) brightness(0.3) contrast(1.05)` |
| `--sc-ground-opacity` | `0.6` |
| `--sc-ground-fade-from` | `52%` |
| `--sc-ground-fade-to` | `84%` |
| `--sc-hero-filter` | `sepia(0.35) hue-rotate(212deg) saturate(0.8) brightness(0.6) contrast(1.1)` |
| `--sc-hero-position` | `50% 50%` |

## Choosing art from your vault

The Images screen can also show pictures already sitting in your vault, not only ones you upload.
It looks inside one folder: the one named by `attachmentsDir` in your `vault.config.json`,
defaulting to `_attachments` when that key is absent, the same folder and the same default the
site generator itself reads attachments from. Only image files are listed (the same formats
uploads accept); a link inside that folder, or a folder whose name starts with a dot, is never
followed. The list stops at the first 2000 pictures and says so when it does; if the picture you
want isn't shown, you can type its path inside the vault by hand instead.

A picture under a folder your configuration excludes from publishing is still shown, greyed out
and marked "In an excluded folder," by the same rule a build already applies to a slot pointing at
an excluded folder. Choosing a picture from your vault doesn't copy it anywhere by itself; the spot
simply points at it. The copy happens later, only when you build or publish the site: a build
checks the same rules again before it copies anything, and the picture ends up inside the site's
own `scriptorium/slots/` folder, named for the spot it fills.

## Recommended convention

| Slot | Size | Ratio | Behaviour |
|---|---|---|---|
| hero | 2400 x 1350 | 16:9 | Cover; keep the subject in the middle band. |
| ground | 2560 x 1440 | 16:9 | Fixed page background, cover. |
| paper | 1024 x 1024 | 1:1 | Seamless tile. |
| crest-frame | 512 x 512 | 1:1 | Transparent PNG or WebP. |
| portrait | 900 x 1200 | 3:4 | Cover. |
| 404 | 1600 x 900 | 16:9 | Cover. |

This is the size to prepare art at, whether a built-in theme or your own overrides.css draws the slot.

**hero only:** If your overrides.css uses it as the landing banner, plain shows about a 3.2:1 band of it and haze about 1.7:1 on a wide screen.

## Soft warnings

The panel shows a warning under a slot row or in the save review when a picked image:

- is smaller than **three-quarters (0.75)** of the recommended size, in either dimension, or
- has a shape more than **25%** off the recommended ratio, or
- is a `.jpg`/`.jpeg` file for `crest-frame` (that slot's convention is a format with
  transparency: PNG or WebP).

These warnings never block a save. A vault-path value, an SVG, or a measurement that fails for any
other reason shows "Size not checked." instead of a number.

## Accepted formats and limits

Uploaded images accept jpg, jpeg, png, webp, gif, svg and avif, up to 10 MiB per image.

## Using a slot

A slot only does anything once a theme or your own `overrides.css` reads it. To use one yourself,
reference the slot's CSS variable directly, for example:

```css
.landing-hero {
  background-image: var(--sc-img-hero);
}
```

See ADR 0019 for the full list of slot variable names and how they're declared, and ADR 0032 for
what the gloam theme draws with them.
