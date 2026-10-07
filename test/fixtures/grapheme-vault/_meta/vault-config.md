---
type: meta
publish:
  mode: player
  exclude_sections:
    - GM Notes
  theme:
    genre: horror
---

# Vault config

Synthetic fixture for DEP-a2's Intl.Segmenter shim parity proof
(test/generator-grapheme-parity.test.js and, formerly, spike/run-pin-proof.sh, retained in the private archive at b5b48b4). Not a
real campaign. `publish.theme.genre: horror` exercises the same
template-literal theme-CSS path (`copyGenreCSS`,
`../css/themes/${genrePreset}.css`) that ADR 0001's pkg-asset-inclusion
gotcha was found against.
