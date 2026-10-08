# Licence provenance audit

Subject: the GM-Scriptorium executables and the sites they build.

**In plain terms.** This page is for anyone who redistributes GM-Scriptorium, or who needs to know
what is inside it and under which licences. It answers one question: may this tool and the sites it
builds be shared, and what notices must travel with them? The short answer is yes. Nothing bundled
is copyleft, so the tool's own source can stay under its own licence. The obligations are notices
(a licence file shipped beside the executable and a notice written into every built site), and
those are met by `THIRD-PARTY-NOTICES.txt` and the `NOTICE.txt` each built site carries. Section
numbers below are cited from the code and from other documents, so they do not change.

**Scope and currency.** The base audit is dated 2026-09-10, against generator `1.2.1`. Section 15
onward covers the vendored, integrity-pinned pin that replaced it. `THIRD-PARTY-NOTICES.txt` is
generated from the lockfile, not from this document.

---

## 1. Verdict

**Not fully compliant as it stands. Compliant after four fixes, none of which require code changes
to the generator and none of which are blocked on anyone else's permission.**

Nothing in the dependency tree is copyleft. There is no share-alike contamination. Every inbound
licence permits keeping GM-Scriptorium's own source closed. The gaps are all notice-and-attribution
defects in what GM-Scriptorium ships, plus one trademark question. In order of severity:

| # | Blocker | Fix |
|---|---------|-----|
| B1 | The executable will embed a Node.js 22 runtime and its 43 bundled components (OpenSSL under Apache-2.0, V8 and zlib under BSD, ICU under the Unicode licence). None of this is currently in scope for the notices file. Apache-2.0 section 4(d) imposes a NOTICE obligation and the BSD-2/3 clauses impose a binary-form reproduction obligation. | Concatenate the Node.js `LICENSE` for the exact runtime version `@yao-pkg/pkg-fetch` supplies into `THIRD-PARTY-NOTICES.txt`. See section 8. |
| B2 | `gm-apprentice-publish@1.2.1` ships **no licence file at all**. The npm tarball contains 53 files and not one is a LICENSE, COPYING or NOTICE. MIT is declared in `package.json` and asserted in one line of the README, but the MIT permission notice text is nowhere in the artefact GM-Scriptorium redistributes. | Reproduce the MIT text with `Copyright (c) 2026 AntTheLimey` in `THIRD-PARTY-NOTICES.txt`, sourced from the upstream repo's `LICENSE-CODE`. Ask upstream to add the file. See section 6. |
| B3 | `markdown-it` depends on `argparse@2.0.1`, which is **not MIT**. It is Python-2.0 (PSF License Agreement v2), a licence not previously identified anywhere in this audit trail. It carries a distinct notice obligation (clause 2), a changes-summary obligation (clause 3) and a no-trademark-endorsement clause (clause 7). | Include the full PSF text and the PSF copyright line. See section 9. |
| B4 | Generated sites redistribute third-party code with an incomplete notice. `lunr.js` carries an `@license MIT` SPDX tag but **not** the MIT permission notice, and the generator's own `css/style.css` and `js/*.js` carry **no copyright header at all**. Every site a GM-Scriptorium user publishes is therefore a technically non-compliant MIT redistribution, caused by GM-Scriptorium. | Have GM-Scriptorium write a `NOTICE.txt` into every generated site and link it from the footer. See section 11. |

One item is a judgement call rather than a blocker:

- **R1, GURPS trademark.** GM-Scriptorium ships `lib/templates/pc-gurps.js` and a `/* GURPS 4e */` CSS
  block. I read both in full. They contain no GURPS rules content, no point costs, no trait lists and
  no page references. This is nominative trademark use, not a content-licensing problem, and the
  Steve Jackson Games Online Policy "not for resale" restriction attaches to game aids that reproduce
  SJG content, which these files do not. **I assess the risk as low but I am not confident enough to
  call it zero.** A disclaimer materially reduces the risk and costs nothing. Exact wording in
  section 7.

Everything else in this document is detail, evidence, or a finding that is not a blocker but that a
technical reviewer or a rights holder could raise.

---

## 2. Method and evidence base

Every statement below was verified against a primary source. Where I could not verify something, I
say so and say what would resolve it.

**What I read, and from where:**

| Source | Path | Why |
|---|---|---|
| The published npm artefact | `gm-apprentice-publish-1.2.1.tgz`, fetched via `npm pack gm-apprentice-publish@1.2.1` | This is what ships. Integrity `sha512-GUvbAPOj+o4guwSWGWQQxaCsESn43lZxmulP5xJe9f6hETj6chpwUZdeKbvq0wEmoFfRxA6S6/QojHiklX6CnA==`, shasum `07f8a0cfece1115dce937f8e99e6e2dee6f4ce05`, 53 files, 65.8 kB packed / 275.7 kB unpacked, published 2026-05-07 |
| npm registry metadata | `npm view gm-apprentice-publish@1.2.1 --json` | Confirms `"license": "MIT"`, `gitHead 67e119910e92847a7c0ec4882dbb77f9c58799f9`, sole maintainer `antthelimey`, 4 published versions |
| Upstream repo checkout | a local checkout of the upstream `gm-apprentice` repository, at commit `d9cae13` | For `LICENSE`, `LICENSE-CODE`, `ATTRIBUTION.md`, `README.md`, `.claude-plugin/plugin.json` |
| Dependency tree | `tools/publish/node_modules/` in that checkout | Read each package's own licence file, not just its `package.json` declaration |
| Node.js runtime licence aggregate | the local Node.js distribution's own `LICENSE` (Node v22.22.3, 2732 lines, 145,485 bytes) | Representative of what `@yao-pkg/pkg` embeds. See section 8 for the caveat |

**Critical caveat on the repo checkout.** The checkout at `d9cae13` is **not** version 1.2.1. A
recursive diff of the tarball against `tools/publish/` shows 15 files differing and 2 files present
only in the checkout (`lib/templates/heritage.js`, `lib/templates/world-domain.js`). The repo's plugin
manifest declares version `1.7.1`; npm's latest is `1.2.1`. Every claim in this document about the
*contents* of 1.2.1 was verified against the tarball. The files I quote from are ones the diff
confirmed byte-identical between tarball and checkout (`css/`, `js/`, `bin/`, `lib/templates/pc-*.js`,
`README.md`, `package.json`) or that I read directly out of the extracted tarball (`lib/theme.js`,
`lib/build.js`).

---

## 3. Component inventory

Three tiers ship. Tier 1 and 2 are inside the executable. Tier 3 is what the user's own published
website contains.

### Tier 1: bundled in the executable via npm (19 components)

| Component | Version | Licence | Licence text read from | Obligation on a redistributor |
|---|---|---|---|---|
| `gm-apprentice-publish` | 1.2.1 | MIT (declared only) | **Not present in the artefact.** Text taken from upstream `LICENSE-CODE`, `Copyright (c) 2026 AntTheLimey` | Reproduce copyright line and full MIT permission notice. See B2 |
| `gray-matter` | 4.0.3 | MIT | `node_modules/gray-matter/LICENSE`, `Copyright (c) 2014-2018, Jon Schlinkert` | Reproduce notice |
| `lunr` | 2.3.9 | MIT | `node_modules/lunr/LICENSE`, `Copyright (C) 2013 by Oliver Nightingale` | Reproduce notice. Also see Tier 3 |
| `markdown-it` | 14.1.1 | MIT | `node_modules/markdown-it/LICENSE`, `Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin` | Reproduce notice |
| `argparse` | 1.0.10 | MIT | `node_modules/argparse/LICENSE`, `Copyright (C) 2012 by Vitaly Puzrin` | Reproduce notice |
| `argparse` | **2.0.1** | **Python-2.0 (PSF v2)** | `node_modules/markdown-it/node_modules/argparse/LICENSE` | Retain PSF copyright line verbatim, include full PSF agreement, include a changes summary, do not use PSF marks. See section 9 |
| `entities` | 4.5.0 | BSD-2-Clause | `node_modules/entities/LICENSE`, `Copyright (c) Felix Böhm` | Reproduce copyright, conditions list and disclaimer in documentation accompanying the binary |
| `esprima` | 4.0.1 | BSD-2-Clause | `node_modules/esprima/LICENSE.BSD`, `Copyright JS Foundation and other contributors` | As above. Verified 2-clause: no "neither the name" clause present |
| `extend-shallow` | 2.0.1 | MIT | `node_modules/extend-shallow/LICENSE`, `Copyright (c) 2014-2015, Jon Schlinkert` | Reproduce notice |
| `is-extendable` | 0.1.1 | MIT | `node_modules/is-extendable/LICENSE`, `Copyright (c) 2015, Jon Schlinkert` | Reproduce notice |
| `js-yaml` | 3.14.2 | MIT | `node_modules/js-yaml/LICENSE`, `Copyright (C) 2011-2015 by Vitaly Puzrin` | Reproduce notice. See section 12 for a security finding |
| `kind-of` | 6.0.3 | MIT | `node_modules/kind-of/LICENSE`, `Copyright (c) 2014-2017, Jon Schlinkert` | Reproduce notice |
| `linkify-it` | 5.0.0 | MIT | `node_modules/linkify-it/LICENSE`, `Copyright (c) 2015 Vitaly Puzrin` | Reproduce notice. See section 12 |
| `mdurl` | 2.0.0 | MIT **plus a second MIT grant** | `node_modules/mdurl/LICENSE`. Two copyright holders: `Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin` and, below a separator, `Copyright Joyent, Inc. and other Node contributors. All rights reserved.` for the `.parse()` code derived from node.js `url` | Reproduce **both** notices. A generated notices file that reads only the first line of each LICENSE will silently drop the Joyent grant |
| `punycode.js` | 2.3.1 | MIT | `node_modules/punycode.js/LICENSE-MIT.txt`, `Copyright Mathias Bynens` | Reproduce notice. Note the non-standard filename: a scanner globbing `LICENSE*` finds it, one globbing exactly `LICENSE` does not |
| `section-matter` | 1.0.0 | MIT | `node_modules/section-matter/LICENSE`, `Copyright (c) 2017, Jon Schlinkert` | Reproduce notice |
| `sprintf-js` | 1.0.3 | **BSD-3-Clause** | `node_modules/sprintf-js/LICENSE`, `Copyright (c) 2007-2014, Alexandru Marasteanu`. Clause 3 verified present at lines 11-12: "Neither the name of this software nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission" | Reproduce notice **and** do not use the sprintf-js name or its contributors' names in GM-Scriptorium marketing. See section 12 |
| `strip-bom-string` | 1.0.0 | MIT | `node_modules/strip-bom-string/LICENSE`, `Copyright (c) 2015, 2017, Jon Schlinkert` | Reproduce notice |
| `uc.micro` | 2.1.0 | MIT | `node_modules/uc.micro/LICENSE.txt`, `Copyright Mathias Bynens` | Reproduce notice **as shipped**. See section 12 for a defect in this attribution |

Copyleft in Tier 1: **none**. Weak copyleft (MPL, EPL, LGPL): **none**. Every licence permits sale,
sublicensing and closed-source distribution of derivative and combined works.

### Tier 2: the embedded Node.js runtime (1 runtime + 43 components)

`@yao-pkg/pkg` 6.22.0 produces a single executable by concatenating a Node.js base binary (supplied by
`@yao-pkg/pkg-fetch` 3.6.6) with a compiled snapshot of the application. **The Node.js binary and
everything statically linked into it is redistributed by GM-Scriptorium.** The Node.js `LICENSE` for
v22.22.3 is 2,732 lines and contains 43 separately-licensed components. The ones that carry
obligations beyond a plain MIT notice:

| Component | Licence | Obligation |
|---|---|---|
| OpenSSL (`deps/openssl`) | Apache-2.0 | Section 4(a) requires giving recipients a copy of the licence. Section 4(d) requires carrying forward the NOTICE file's attribution notices. Also carries an express patent grant with a defensive-termination clause |
| ICU (`deps/icu-small`) | Unicode Licence V3 | Reproduce the Unicode copyright and permission notice |
| V8 (`deps/v8`), zlib, c-ares, nghttp2, ngtcp2, nghttp3, gtest, brotli, zstd, simdjson, simdutf, ada, and others | BSD-2-Clause, BSD-3-Clause, MIT | Binary-form reproduction of copyright, conditions and disclaimer |
| npm (`deps/npm`) | Artistic-2.0 | Reproduce the licence; note it if the shipped runtime includes npm |

**On GPL text inside the Node licence file.** Lines 835 to 881 of the Node.js `LICENSE` contain GNU
GPL v2 and v3 text. I read the surrounding context to establish exactly what it covers. It covers
three ICU4C **build-time files**: `aclocal.m4` (the `pkg.m4` macro section), `config.guess`, and
`install-sh`. Each is accompanied by the Autoconf Exception, quoted in the file as: "As a special
exception to the GNU General Public License, if you distribute this file as part of a program that
contains a configuration script generated by Autoconf, you may include it under the same distribution
terms that you use for the rest of that program." The condition is stated as fulfilled because ICU4C
ships an Autoconf-generated `configure`. These files are source-tree build scaffolding, they are not
linked into a compiled ICU and do not exist in a Node binary. **There is no GPL obligation on
GM-Scriptorium.** I flag it only because a naive licence scanner run against the Node LICENSE will
report "GPL detected" and someone will panic. The answer is written down here so nobody has to
re-derive it.

**What I could not verify.** I did not build the executable, so I cannot state which exact Node.js
version `@yao-pkg/pkg-fetch` 3.6.6 supplies for `node22-win-x64`, and I read v22.22.3's licence from
this machine as a proxy. The aggregate changes between Node patch releases. **Resolution: after the
first successful `pkg` build, take the Node version from the built binary and fetch the matching
`LICENSE` from `https://github.com/nodejs/node/blob/v<exact>/LICENSE`. Do not copy the one from this
machine.**

### Tier 3: copied into every website the user publishes

Established by reading `lib/build.js` from the tarball.

| File written into the site | Source | Licence | Copyright notice present in the copied file? |
|---|---|---|---|
| `js/lunr.js` | `require.resolve('lunr')` then `fs.copyFileSync`, `lib/build.js:293-296`. Only when search is enabled | MIT, Oliver Nightingale | **Partial.** The file opens with `Copyright (C) 2020 Oliver Nightingale` and `@license MIT`. The copyright line is present, the permission notice text is not |
| `css/style.css` | `fs.copyFileSync`, `lib/build.js:61-66` | MIT, AntTheLimey | **No.** Header is a descriptive comment only. Zero occurrences of "copyright" anywhere in the shipped `css/`, `js/`, `lib/`, `bin/` or `templates-scaffold/` trees |
| `css/themes/<preset>.css` | `lib/build.js:68-75` | MIT, AntTheLimey | No |
| `js/filters.js`, `js/lightbox.js`, `js/nav.js`, `js/search.js` | `lib/build.js:77-89` | MIT, AntTheLimey | No |
| `css/theme.css` | Generated at build time by `lib/theme.js` | Output, not third-party code | n/a, but see section 12 on Google Fonts |

No font files, image assets or icon sets ship. The tarball file list contains no `.woff`, `.ttf`,
`.otf`, `.png`, `.jpg` or `.svg` files. SVG markup is generated inline by
`lib/relationship-graph.js:126` and `lib/templates/pc.js:75` using the W3C SVG namespace URI, which is
a namespace identifier and not a fetched resource.

---

## 4. The CC-BY-SA question, answered from the tarball

**Answer: CC-BY-SA-4.0 does not attach to anything GM-Scriptorium bundles. The share-alike obligation
is confined to `skills/`, and `skills/` is not in the npm package. There is no contamination.**

The upstream repo is genuinely dual-licensed, and the strongest statement of that is not the README
but `.claude-plugin/plugin.json`, which declares:

```json
"license": "CC-BY-SA-4.0 AND MIT"
```

That is an SPDX **conjunctive** expression. It means a recipient of the *plugin* must satisfy both
licences simultaneously. `README.md:219-221` narrows what each covers:

> Original content (skills and markdown) is licensed under
> CC-BY-SA 4.0 (`LICENSE`, in the upstream repository). Code (scripts, hooks, and executable
> files) is licensed under MIT (`LICENSE-CODE`, in the upstream repository).

The npm package is a different artefact with a different declaration. `package.json` in the tarball
declares `"license": "MIT"` flat, with no SPDX expression, and the npm registry metadata agrees.

Here is the complete file list of `gm-apprentice-publish-1.2.1.tgz`, all 53 files, as extracted from
the tarball:

```
package/README.md
package/bin/gm-publish.js
package/css/style.css
package/css/themes/fantasy.css
package/css/themes/horror.css
package/css/themes/military.css
package/css/themes/noir.css
package/js/filters.js
package/js/lightbox.js
package/js/nav.js
package/js/search.js
package/lib/backlinks.js
package/lib/breadcrumbs.js
package/lib/build.js
package/lib/config.js
package/lib/index.js
package/lib/init.js
package/lib/manifest.js
package/lib/processor.js
package/lib/recency.js
package/lib/relationship-graph.js
package/lib/scanner.js
package/lib/search-index.js
package/lib/templates/base.js
package/lib/templates/context-sidebar.js
package/lib/templates/creature.js
package/lib/templates/event.js
package/lib/templates/faction.js
package/lib/templates/four-oh-four.js
package/lib/templates/index-page.js
package/lib/templates/index.js
package/lib/templates/item.js
package/lib/templates/landing-data.js
package/lib/templates/landing.js
package/lib/templates/location.js
package/lib/templates/nav.js
package/lib/templates/npc.js
package/lib/templates/pc-coc.js
package/lib/templates/pc-dnd.js
package/lib/templates/pc-fitd.js
package/lib/templates/pc-gurps.js
package/lib/templates/pc-registry.js
package/lib/templates/pc.js
package/lib/templates/timeline-page.js
package/lib/templates/wiki.js
package/lib/theme.js
package/lib/timeline.js
package/package.json
package/templates-scaffold/README.md.tmpl
package/templates-scaffold/css/overrides.css
package/templates-scaffold/dot-gitignore
package/templates-scaffold/package.json.tmpl
package/templates-scaffold/vault.config.json.tmpl
```

There is no `skills/` directory. There is no `ATTRIBUTION.md`. There is no `LICENSE`. There is no
markdown content file of any kind other than `README.md` and the two `.tmpl` scaffolds.

**The one residual ambiguity, and its resolution.** The README's own classification says "skills and
markdown" are CC-BY-SA. `package/README.md` is markdown. Read hyper-literally, the README shipped in
the npm package would be CC-BY-SA-4.0, and because CC-BY-SA is share-alike, bundling it into a
proprietary executable would be a problem. Two things close this:

1. `package/package.json` declares the package MIT with no exception carved out, and npm's stated
   convention is that the `license` field governs the published artefact.
2. The shipped README **self-declares**, at its own line 343-345:

   ```
   ## License

   MIT
   ```

That is the same document asserting its own licence, and it is the more specific statement. The
README is MIT. This is worth writing down because it is the exact shape of trap that sinks a
release's licence compliance, and because it is resolved by a three-line section that a scanner would
never find.

**Standing rule for GM-Scriptorium, going forward:** never bundle anything from the gm-apprentice
repo's `skills/` tree, `ATTRIBUTION.md`, or `docs/`. Everything the ATTRIBUTION obligations attach to
lives there. I confirmed the location of that content: `grep -rl -i gurps` over the repo returns 52
hits under `skills/ttrpg-expert/` and 5 under `tools/publish/` (all of them the layout code discussed
in section 7); SRD 5.2 material lives under `skills/ttrpg-expert/systems/dnd-5e-2024/`
(`spells*.md`, `monsters-cr*.md`, `magic-items*.md`, `classes.md`). If a future GM-Scriptorium feature
wants to bundle skills, this audit must be re-run from scratch and the answer will very likely be
that it cannot be sold as proprietary.

---

## 5. What the ATTRIBUTION.md obligations do and do not reach

`ATTRIBUTION.md` carries five sets of obligations. None reach GM-Scriptorium, for the following
specific reasons:

| Obligation | Attaches to | Reaches GM-Scriptorium? |
|---|---|---|
| SRD 5.2, CC-BY-4.0, Wizards of the Coast | "spell indexes and descriptions, magic item indexes and descriptions, and full monster stat blocks ... for 235 creatures" | No. Grep of the shipped `css/`, `js/`, `lib/`, `bin/`, `templates-scaffold/` finds no spell, monster or magic-item data. The only D&D-derived thing is `lib/templates/pc-dnd.js:3` `const ABILITIES = ['STR','DEX','CON','INT','WIS','CHA']` and line 6 `Math.floor((score - 10) / 2)`. See below |
| Blades in the Dark, CC-BY-3.0, One Seven Design / John Harper | Action ratings, position and effect, faction mechanics, etc., all in skill files | No. `lib/templates/pc-fitd.js` contains no hardcoded rules data at all |
| Basic Roleplaying ORC Licence, Chaosium | BRP rules content in skill files | No. `lib/templates/pc-coc.js:3` has `const COC_CHARACTERISTICS = ['STR','CON','SIZ','DEX','APP','INT','POW','EDU']` and nothing else |
| GURPS, SJG Online Policy | "trait names, point costs, page references, and short mechanical notes" in `skills/ttrpg-expert/systems/gurps-4e/` | Not for content. See section 7 for the trademark question |
| Referenced frameworks (Three Clue Rule, Lazy DM, etc.) | Skill files | No |

**On the D&D ability modifier formula.** `pc-dnd.js:6` implements `Math.floor((score - 10) / 2)`.
This is a rule, and it appears in SRD 5.2. Two reasons it is not a problem: a mathematical formula is
a method of operation and not copyrightable expression under 17 U.S.C. 102(b), and even if it were,
SRD 5.2 is CC-BY-4.0, which requires attribution and nothing else. **Attribution is cheap here.** I
recommend including the standard SRD 5.2 attribution line in `THIRD-PARTY-NOTICES.txt` regardless.
It costs one paragraph and removes the argument entirely. Wording in section 13.

The same reasoning covers the attribute abbreviation lists. `ST/DX/IQ/HT`, `STR/DEX/CON/INT/WIS/CHA`
and `STR/CON/SIZ/DEX/APP/INT/POW/EDU` are short words and abbreviations, uncopyrightable under
37 C.F.R. 202.1(a).

---

## 6. The missing LICENSE file

**Established fact: `gm-apprentice-publish@1.2.1` ships no licence text.** I searched the extracted
tarball for `*licen*`, `*copying*`, `*notice*` and `*attribu*`, case-insensitively. Zero results
across all 53 files. Zero occurrences of the string "copyright" anywhere in `js/`, `css/`, `lib/`,
`bin/` or `templates-scaffold/`.

**Why it happened.** `tools/publish/package.json` has no `files` field, so publication is driven
entirely by `.npmignore`, which contains exactly four lines:

```
test/
docs/
.github/
*.test.js
```

That is an exclude-list, so a licence file would have been included had one existed in
`tools/publish/`. It does not exist. The repo's licence files live at the repo root, two levels up,
and npm does not walk upward.

**Is this a blocker?** No. The MIT grant is validly made. `package.json` carries
`"license": "MIT"`, the npm registry records `"license": "MIT"`, the README asserts MIT, and the
upstream repo has an unambiguous `LICENSE-CODE` reading `MIT License / Copyright (c) 2026
AntTheLimey`. A licence is a grant of permission, not a file. The permission was granted.

**What it does do** is transfer the notice obligation entirely onto GM-Scriptorium with no upstream
help. MIT's operative sentence is:

> The above copyright notice and this permission notice shall be included in all copies or substantial
> portions of the Software.

GM-Scriptorium ships a substantial portion of the Software (all of it), so GM-Scriptorium must include
both. It cannot do so by copying a file that does not exist.

**Do this:**

1. Put the full MIT text into `THIRD-PARTY-NOTICES.txt` under the heading
   `gm-apprentice-publish 1.2.1`, with the copyright line `Copyright (c) 2026 AntTheLimey`,
   transcribed from the upstream repo's `LICENSE-CODE` at commit `d9cae13`.
2. Add a provenance sentence immediately under it, because the source is not the artefact:
   "The npm package gm-apprentice-publish@1.2.1 does not ship a licence file. It declares MIT in its
   package.json and README. The text below is reproduced from LICENSE-CODE in the upstream repository
   at https://github.com/AntTheLimey/gm-apprentice."
3. Raise an issue upstream asking for a `LICENSE` file in `tools/publish/`. This is a 30-second fix
   for the maintainer and it removes an audit finding for everyone downstream, including any future
   adopter of GM-Scriptorium.
4. Pin by integrity, not just version. Because there is no `files` field, any file added to
   `tools/publish/` in a future release ships automatically. GM-Scriptorium's lockfile must pin
   `gm-apprentice-publish@1.2.1` with integrity
   `sha512-GUvbAPOj+o4guwSWGWQQxaCsESn43lZxmulP5xJe9f6hETj6chpwUZdeKbvq0wEmoFfRxA6S6/QojHiklX6CnA==`
   and any version bump must re-run this audit's tarball file-list check.

---

## 7. GURPS and the Steve Jackson Games Online Policy

### What actually ships

Two things reference GURPS in the bundled artefact:

**`lib/templates/pc-gurps.js`, 8,108 bytes.** I read it in full. It contains:

- `const PRIMARY_ATTRS = ['ST', 'DX', 'IQ', 'HT']`
- Regex-based HTML table parsers (`parseTableRows`, `extractSubsectionHtml`)
- Extractors that look up section headings by name: "Stat Sheet", "Secondary Characteristics",
  "Active Defenses", "Ranged Weapons", "Melee Weapons", "Encumbrance", "Equipment"
- Label strings for display: `HP`, `FP`, `Speed`, `Move`, `Dodge`, `Parry (...)`, `Ranged`, `Melee`,
  `Advantages`, `Disadvantages`, `Skills`
- HTML emission with class names `gurps-sheet`, `gurps-combat-bar`, `gurps-primary-attrs`,
  `gurps-attr-card`, `gurps-trait-list`

Every value rendered comes from the user's own YAML frontmatter or their own markdown tables. There
are no point costs, no trait definitions, no skill lists, no difficulty levels, no page references, no
tables of GURPS data. `frontmatter.advantages`, `frontmatter.disadvantages` and `frontmatter.skills`
are read from the user's file and echoed. The only computation in the file is picking the highest
number out of a user-supplied table.

**`css/style.css` lines 2552-2624, headed `/* GURPS 4e */`.** Pure presentation: flexbox, borders,
border-radius, font sizes, CSS custom property references. Nothing else.

### The SJG Online Policy question

The Online Policy, as quoted in the repo's own `ATTRIBUTION.md`, is invoked for material "released for
free distribution, and not for resale". The repo relies on it for the GURPS skill files, which
`ATTRIBUTION.md` says "contain trait names, point costs, page references, and short mechanical notes
as permitted by the SJG Online Policy" and which are "curated from the GURPS Basic Set".

**The key distinction: the Online Policy's "not for resale" condition is a condition on the permission
it grants. It is only binding on you if you need that permission.** You need it if you are reproducing
SJG's copyrighted content. GM-Scriptorium reproduces none. The skill files that do need it are not in
the npm package and are not in GM-Scriptorium.

**So the residual question is trademark, not copyright.** GM-Scriptorium uses the word "GURPS" in a
filename, in CSS class names, and in a source comment. None of these are user-visible. The generated
HTML emits `class="gurps-sheet"`, which is visible in page source but not on screen. Whether
GM-Scriptorium's own marketing says "supports GURPS 4e" is a separate decision and the more important
one.

My assessment:

- **Using "GURPS" in class names and internal identifiers: very low risk.** This is functional
  identification of a data format, not source identification of the product.
- **Saying "supports GURPS 4e" in marketing: low risk, and it is classic nominative fair use.** Under
  the US test (New Kar Motors v. Lexus, 971 F.2d 302), it is permitted where the product is not
  readily identifiable without the mark, only so much of the mark is used as is reasonably necessary,
  and nothing suggests sponsorship or endorsement. GM-Scriptorium meets all three if it uses the word
  plainly and does not use SJG's logo, trade dress or the distinctive GURPS wordmark styling.
- **Naming the product something GURPS-adjacent, or using SJG's logo or wordmark art: do not.**

### Would a disclaimer resolve it?

**A disclaimer does not create a right you do not have, but here you already have the right, and a
disclaimer removes the "suggests sponsorship" leg of the nominative-fair-use test.** It converts a
low risk into a very low one and it costs nothing. It should appear in `THIRD-PARTY-NOTICES.txt`, in
the product's About screen or `--version` output, and on any page that mentions GURPS.

Required wording, adapted from SJG's own standard form:

> GURPS is a trademark of Steve Jackson Games Incorporated, and its rules and art are copyrighted by
> Steve Jackson Games Incorporated. All rights are reserved by Steve Jackson Games Incorporated.
> GM-Scriptorium is not affiliated with, endorsed by, or sponsored by Steve Jackson Games Incorporated.
> GM-Scriptorium contains no GURPS rules content. It formats character data supplied by the user.

Note the deliberate difference from the repo's `ATTRIBUTION.md`: **do not** copy the repo's sentence
"This game aid is the original creation of AntTheLimey and is released for free distribution, and not
for resale, under the permissions granted in the Steve Jackson Games Online Policy." Copying that
sentence would be an admission that the product relies on a permission whose condition it is
breaching. GM-Scriptorium does not rely on the Online Policy and must not claim to.

### Where I am not confident

**I am giving you a reasoned analysis, not a legal opinion, and the distinction matters here more than
anywhere else in this document.** Trademark risk is not determined by the strength of the argument, it
is determined by whether a rights holder decides to send a letter, and SJG has a documented history of
active enforcement of the GURPS mark. Everything else in this audit I can settle by reading text. This
one I cannot.

**What would resolve it, in increasing order of cost:**

1. Remove the word GURPS from user-visible surfaces. Rename the CSS classes to `system-sheet`
   or similar and describe the feature as "supports the GURPS character sheet format" rather than as
   a GURPS feature. Cheap, changes nothing functional. Note this requires a change to
   `gm-apprentice-publish` upstream, or a post-processing step in GM-Scriptorium, since the class names
   come from the bundled generator.
2. Email SJG's licensing contact describing exactly what the product does and asking whether they
   object to the nominative use. Free, and a written non-objection is worth more than any analysis.
3. A short opinion from a solicitor with trademark practice, covering both the relevant local
   trade marks position and the US position given SJG is a Texas company. **This is what I recommend
   before relying on the analysis above for anything more than internal risk-tracking.**

---

## 8. The embedded Node.js runtime, the largest gap in the audit as scoped

**This was not in the brief and it is the single biggest item.** The audit as commissioned covers the
npm dependency tree. It does not cover the runtime that `@yao-pkg/pkg` bakes into the executable, and
that runtime is by volume the overwhelming majority of the third-party code GM-Scriptorium ships.

A `pkg`-built executable is a Node.js binary with an appended snapshot. The Node.js binary statically
links OpenSSL, V8, ICU, libuv, zlib, nghttp2, ngtcp2, nghttp3, c-ares, brotli, zstd, simdjson,
simdutf, ada, llhttp, uvwasi, HdrHistogram and roughly two dozen more. Node.js's own `LICENSE` file
enumerates 43 such components. **Distributing the executable distributes all of them, and their notice
obligations attach to GM-Scriptorium exactly as `lunr`'s does.**

The obligations that are not satisfied by a plain MIT-style notice:

- **OpenSSL, Apache-2.0.** Section 4(a): "You must give any other recipients of the Work or Derivative
  Works a copy of this License." Section 4(d): if the work includes a NOTICE file, you must include a
  readable copy of its attribution notices in the distribution. This is a positive obligation with a
  specific mechanism, not just a copyright line.
- **OpenSSL patent grant.** Apache-2.0 section 3 grants a patent licence and terminates it if the
  licensee initiates patent litigation alleging the work infringes. This is the only express patent
  grant anywhere in GM-Scriptorium's inbound stack. It is a benefit, not a burden, but is worth
  recording.
- **ICU, Unicode Licence V3.** Requires the Unicode copyright notice and permission notice to appear
  in the documentation accompanying the distribution.
- **npm, Artistic-2.0.** Applies only if the shipped runtime bundles npm. Verify against the built
  binary.
- **BSD-3-Clause components.** Same no-endorsement constraint as `sprintf-js`.

**Do this:**

1. After the first successful `pkg` build for `node22-win-x64`, determine the exact Node.js version
   from the binary.
2. Fetch `https://raw.githubusercontent.com/nodejs/node/v<exact-version>/LICENSE`.
3. Append it verbatim to `THIRD-PARTY-NOTICES.txt` under a heading that states what it covers and why:
   "Node.js runtime, embedded by @yao-pkg/pkg. The following covers Node.js v<x.y.z> and the 43
   third-party components statically linked into it."
4. Do not summarise, do not extract, do not deduplicate against the npm-level entries. Apache-2.0
   4(a) says a copy of the licence, and the Node file is the canonical aggregate.
5. Add a line to the release checklist: if the Node version changes, re-fetch.

**One non-licence consequence, flagged because it is a genuine commercial obstacle and nobody has
raised it.** Statically-linked OpenSSL makes GM-Scriptorium a product containing strong cryptography.
For distribution from or into most jurisdictions this is routine, and under the US EAR it typically
falls under the mass-market or publicly-available exceptions, but the answer is jurisdiction-specific
and some distribution channels ask the question at onboarding. Apple's App Store and some enterprise
procurement forms ask it explicitly. **This is not a blocker. It is a form field you should know the
answer to before someone asks.** If GM-Scriptorium is distributed direct from a website to end users,
it will almost certainly never come up.

---

## 9. `argparse@2.0.1` is Python-2.0, not MIT

**This component was missed by the previous pass, which reported 16 transitive dependencies all
permissive-MIT-or-BSD.** The count is wrong and one of the licences is wrong.

The dependency tree contains **two different versions of `argparse` under two different licences**:

- `node_modules/argparse` at 1.0.10, MIT, `Copyright (C) 2012 by Vitaly Puzrin`, pulled in by
  `js-yaml@3.14.2`
- `node_modules/markdown-it/node_modules/argparse` at **2.0.1**, `"license": "Python-2.0"`, pulled in
  by `markdown-it@14.1.1`

The second is nested, which is why a flat listing of `node_modules/*` misses it. `package-lock.json`
records it correctly:

```json
"node_modules/markdown-it/node_modules/argparse": {
  "version": "2.0.1",
  "license": "Python-2.0"
```

Its `LICENSE` is 12,775 bytes and is the full Python licence stack: the PSF License Agreement v2, the
BeOpen Python Open Source License Agreement v1, the CNRI Open Source GPL-Compatible License
Agreement, and the CWI Permissions Statement. The reason is that argparse 2.0.1 is a direct port of
CPython's `argparse.py` from v3.9.0, which its README states.

The operative obligations, quoted from `LICENSE` lines 62-110:

**Clause 2, the notice obligation.** The permission is granted:

> provided, however, that PSF's License Agreement and PSF's notice of copyright, i.e., "Copyright (c)
> 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016,
> 2017, 2018, 2019, 2020 Python Software Foundation; All Rights Reserved" are retained in Python alone
> or in any derivative version prepared by Licensee.

That copyright line must be reproduced **verbatim, with every year listed**. Truncating it to
"Copyright (c) 2001-2020 Python Software Foundation" does not satisfy a clause that specifies the
exact string.

**Clause 3, the changes-summary obligation.** This one has no analogue anywhere else in the tree:

> In the event Licensee prepares a derivative work that is based on or incorporates Python or any part
> thereof, and wants to make the derivative work available to others as provided herein, then Licensee
> hereby agrees to include in any such work a brief summary of the changes made to Python.

The argparse maintainers already discharge this. `README.md` carries a section headed "**Difference
with original.**" listing three deviations (no keyword arguments, string-typed type names, `%r` uses
`util.inspect()`). **GM-Scriptorium's obligation is satisfied by preserving that summary**, so the
notices entry must include it or point to it. Do not just paste the licence and move on.

**Clause 7, no trademark endorsement.** "This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote products or services of Licensee."
Do not say GM-Scriptorium is Python-powered or use Python branding. It is not, so this is free.

**Is it actually reachable?** `argparse@2.0.1` is imported only by `markdown-it/bin/markdown-it.mjs`,
the command-line entry point, which GM-Scriptorium never invokes. **This does not remove the
obligation.** Notice obligations attach to distribution, not execution. Whether the file physically
lands in the executable depends on whether `pkg`'s static analysis traces it, which I cannot determine
without building. **Include it in the notices regardless.** The cost of including a component you do
not ship is nothing. The cost of omitting one you do ship is the finding you are trying to avoid.

Compatibility: PSF License Agreement v2 is a permissive licence, is GPL-compatible per the FSF, and
imposes no source-disclosure or copyleft obligation. **It does not affect the verdict.** It affects
the notices file only.

---

## 10. What the user's published website redistributes, and what they owe

Every site built with GM-Scriptorium contains third-party code. **The site owner, not GM-Scriptorium,
is the redistributor.** They almost certainly do not know that.

Under `lib/build.js`, a built site receives:

- `js/lunr.js`, copied verbatim from `node_modules/lunr` at `lib/build.js:293-296`, only when search
  is enabled. MIT, Oliver Nightingale. The copied file's first four lines are
  `/** lunr - http://lunrjs.com - ... - 2.3.9 / * Copyright (C) 2020 Oliver Nightingale / * @license
  MIT / */`. **The copyright notice is present. The permission notice is not.** MIT requires both.
- `css/style.css`, `css/themes/<preset>.css`, `js/filters.js`, `js/lightbox.js`, `js/nav.js`,
  `js/search.js`, all MIT, Copyright (c) 2026 AntTheLimey. **None of these carries any copyright
  notice at all.** I grepped: zero occurrences of "copyright" across the entire shipped `css/`, `js/`,
  `lib/`, `bin/` and `templates-scaffold/` trees.
- `css/scriptorium.css` (`src/build/housestyle.js`, docs/decisions/0012-product-stylesheet.md), copied
  verbatim from the repo's own embedded `assets/site/scriptorium.css`. **First-party: GM-Scriptorium's
  own code, not a third-party redistribution.** No new notice obligation follows from it; it is listed
  here only so this section's "what a built site receives" enumeration stays complete and does not
  silently fall out of date the next time someone reads it.
- `css/scriptorium-theme.css` (`src/build/themestyle.js`; ADRs 0019, 0023) is written only when a pack
  sets a slot or selects a file-backed theme. With `theme = "haze"` it begins with
  `assets/themes/haze/theme.css`, copied verbatim from the executable, including its inline SVG
  data-URI art. **First-party: GM-Scriptorium's own code and art.** No notice obligation follows. It
  names three Google Fonts families in `@import` rules; no font file is redistributed (§12 F2).

So a site published today is a non-compliant MIT redistribution on two counts, and GM-Scriptorium is
the proximate cause. Nobody is going to sue a hobbyist over a missing lunr notice. **The reason to fix
it is not that the risk is high, it is that a compliance defect in a user's published output is
exactly the kind of thing a technical reviewer notices.** It also happens to be a two-hour fix that
makes GM-Scriptorium visibly more professional than the free tool it wraps.

**What GM-Scriptorium should do:**

1. **Write a `NOTICE.txt` into every generated site**, at the site root, alongside `.nojekyll`.
   Contents: the full MIT text with `Copyright (c) 2013 Oliver Nightingale` for lunr, and the full MIT
   text with `Copyright (c) 2026 AntTheLimey` for the generator's CSS and JS. Two entries, about 40
   lines. Write it unconditionally, and include the lunr entry only when search is enabled so the file
   matches reality.
2. **Link it from the site footer.** `lib/templates/base.js:33` renders `config.footer` escaped, so
   HTML cannot be injected there. GM-Scriptorium should either append a small `<a href="/NOTICE.txt">`
   after `${footerHtml}` in its own post-processing, or, better, raise this upstream as a generator
   feature. A plain-text file at a discoverable path with a footer link is the settled convention for
   discharging MIT notice obligations in a static site.

   > **Annotation, 2026-09-17 (Site UI Engineering Brief, Chunk A):** as built, `src/build/notice.js`'s
   > `injectFooterLinks` does not append after `${footerHtml}`; it replaces the page's `</body>` tag
   > directly (`footerSnippet`), since `footer` is frequently unset. It originally wrapped the link in
   > an inline `style="font-size:0.8em;opacity:0.7"`, which sat outside `<main>` and could not be
   > restyled from `overrides.css` without `!important`. As of Chunk A the snippet is wrapped in the
   > pin's own `.content` column class instead (`css/style.css:270-274`), so it inherits the page's
   > normal typography and cascade. The `scriptorium-notice-link` marker class named above (the
   > idempotence guard) is unchanged. This paragraph is left as originally written; it is the audit
   > finding that motivated the fix, not a description of the current code.
3. **Tell the user.** One line in GM-Scriptorium's build output: "Wrote NOTICE.txt. It lists the
   third-party code in your site. Keep it when you publish." This converts a silent obligation into an
   informed one and is the difference between a tool that creates a problem and one that solves it.
4. **Do not** add a "Powered by GM-Scriptorium" badge to discharge this. Attribution notices and
   marketing badges are different things, and conflating them annoys users without satisfying the
   licence.

---

## 11. Specification for `THIRD-PARTY-NOTICES.txt`

This is the checklist. An engineer should be able to work through it and produce a complete file
without making judgement calls.

### Generation

- **Source of truth is GM-Scriptorium's own `package-lock.json`**, not this document and not a manual
  list. `gm-apprentice-publish@1.2.1` declares its dependencies with caret ranges
  (`gray-matter ^4.0.3`, `lunr ^2.3.9`, `markdown-it ^14.1.0`), so the resolved set can drift on any
  fresh install. GM-Scriptorium's lockfile is what pins them.
- **Walk nested `node_modules`.** A flat scan of top-level `node_modules/*` misses
  `markdown-it/node_modules/argparse@2.0.1`. That omission is how the Python-2.0 licence went
  unnoticed until this audit.
- **Glob `LICEN[CS]E*`, `COPYING*`, `NOTICE*` case-insensitively.** `punycode.js` ships
  `LICENSE-MIT.txt`, `esprima` ships `LICENSE.BSD`, `uc.micro` ships `LICENSE.txt`. A generator
  matching only the exact filename `LICENSE` misses three of nineteen.
- **Read whole licence files, never just the first paragraph.** `mdurl/LICENSE` contains a second,
  separate grant below a horizontal rule for Joyent-derived code. Truncation drops it.
- **Fail the build, do not warn, if a resolved package yields no licence text.** Today exactly one
  package trips this: `gm-apprentice-publish` itself. It needs a hardcoded override entry with the
  provenance note from section 6. Every future occurrence should stop the release.
- **Regenerate on every lockfile change and diff in CI.** A stale notices file is worse than none
  because it asserts completeness it does not have.

### Required contents, in order

**Section 0, header.**
- Product name and version.
- One sentence: "GM-Scriptorium incorporates the third-party software listed below. Each component is
  provided under its own licence, reproduced in full."
- Generation date and the lockfile hash it was generated from.

**Section 1, the generator.**
- `gm-apprentice-publish 1.2.1`, MIT, `Copyright (c) 2026 AntTheLimey`.
- Full MIT permission notice text.
- The provenance sentence from section 6 item 2, because the text does not come from the artefact.

**Section 2, the npm dependency tree.** One entry per resolved package. Each entry needs:
- Package name and exact resolved version.
- SPDX identifier.
- The complete licence text as shipped by that package.

The current resolved set, 18 entries, is the table in section 3 Tier 1 minus the generator. Specific
traps within it:

| Trap | Entry | Requirement |
|---|---|---|
| Two versions of the same package under different licences | `argparse` | Two separate entries: `argparse 1.0.10 (MIT)` and `argparse 2.0.1 (Python-2.0)`. Do not deduplicate by package name |
| Second copyright holder inside one file | `mdurl 2.0.0` | Both the Puzrin/Kocharin grant and the `Copyright Joyent, Inc. and other Node contributors` grant |
| Exact-string copyright requirement | `argparse 2.0.1` | The PSF copyright line with all twenty years enumerated, verbatim, per PSF clause 2 |
| Changes-summary requirement | `argparse 2.0.1` | Reproduce or link the "Difference with original" section from its README, per PSF clause 3 |
| No-endorsement clause | `sprintf-js 1.0.3`, plus BSD-3 components in the Node aggregate | Reproduce clause 3. Then check GM-Scriptorium's marketing copy against it |

**Section 3, the Node.js runtime.**
- Heading naming the exact embedded Node.js version and stating it covers 43 statically linked
  components.
- The complete, unedited Node.js `LICENSE` for that version, fetched from the nodejs/node tag.
- Do not summarise or extract. Apache-2.0 section 4(a) requires a copy of the licence.

**Section 4, trademark and attribution notices.**
- The GURPS / Steve Jackson Games disclaimer, verbatim from section 7 of this document.
- The SRD 5.2 attribution, for the ability-modifier formula. Standard CC-BY-4.0 form:
  "This work includes material from the System Reference Document 5.2 ('SRD 5.2') by Wizards of the
  Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative
  Commons Attribution 4.0 International License, available at
  https://creativecommons.org/licenses/by/4.0/legalcode."
- A general non-affiliation line covering the other systems GM-Scriptorium names in its themes and
  templates: "Dungeons & Dragons, Call of Cthulhu, Blades in the Dark, Pathfinder and GURPS are
  trademarks of their respective owners. GM-Scriptorium is not affiliated with, endorsed by or
  sponsored by any of them."

**Section 5, a pointer for site owners.**
- One paragraph: sites generated by GM-Scriptorium include third-party code, GM-Scriptorium writes a
  `NOTICE.txt` into each site listing it, keep that file when you publish.

### Shipping

- Install the file next to the executable, and make it reachable from inside the product. A
  `scriptorium notices` subcommand, or an About screen, or at minimum a line in `--version` output
  naming the file's path.
- Commit it to the repo. Include it in the release artefact and in any installer or archive.
- A notices file the user never receives discharges nothing.

  > **Annotation, 2026-09-18 (licence-compliance gap fix):** v0.2.1 shipped exactly the failure mode
  > this bullet warns about. `THIRD-PARTY-NOTICES.txt` was not in `package.json`'s `pkg.assets`, so it
  > was never embedded; `bin/scriptorium.js --version` nonetheless printed a path next to the
  > executable, and nothing had ever written anything there. Distributing an executable that asserts a
  > notices file exists, when it does not and never will, discharges nothing and is worse than printing
  > nothing at all. Found by the Windows verifier running the real Windows binary.
  >
  > Fixed as built (v0.2.2): `THIRD-PARTY-NOTICES.txt` is now a plain `pkg.assets` entry (embedded
  > verbatim, `src/util/notices.js`), so it travels inside the exe regardless of how the exe was
  > obtained. `--version` now writes that embedded copy next to the running executable before naming
  > the path, and only names a path it actually just wrote; if the write fails (read-only location,
  > permissions), it says so and points at `--notices` instead, which prints the full text to stdout
  > unconditionally, no filesystem write involved. `scripts/package.js` also copies
  > `THIRD-PARTY-NOTICES.txt` into `dist/v<version>/` next to the exe and lists it in `SHA256SUMS`, for
  > anyone who obtains the exe without this repo. A new gate, `scripts/notices-freshness.js`, compares
  > the committed file against what `scripts/generate-notices.js` would produce right now and refuses
  > the build if they have drifted, on the same shape as `scripts/pkg-assets.js`'s
  > `assertAssetsEmbedded()` and `scripts/content-markers.js`'s `assertNoRulesContent()`. Verified
  > against a real packaged Linux binary: pkg's own `--debug` log shows `Adding asset : ....
  > THIRD-PARTY-NOTICES.txt`; running the exe's `--version` writes a byte-identical copy next to it;
  > `--notices` prints the full text; a simulated read-only destination directory produces the honest
  > failure message instead of a false path. The Windows behaviour still needs confirming by the
  > Windows verifier on the real `.exe`.

---

## 12. Findings nobody asked about

Ordered by how likely they are to matter.

**F1. Three known DoS vulnerabilities ship in the dependency tree.** `npm audit` against the resolved
tree reports 2 high and 1 moderate, all algorithmic-complexity denial of service:

- `js-yaml <= 3.15.1`, high. Four advisories: GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m,
  GHSA-5p4m-2wfm-xmqj (CVE-2026-59870, explicitly not backported to 3.x), GHSA-2883-xcg3-v3hh.
- `linkify-it <= 5.0.1`, high. GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm.
- `markdown-it <= 14.1.1`, moderate. GHSA-6v5v-wf23-fmfq.

Not a licence finding. It is in this document because an `npm audit` or an SCA scan against
GM-Scriptorium's lockfile will surface these, and shipping a product with four unpatched
high-severity advisories in it is a conversation worth having deliberately rather than by accident.
The real-world exposure is genuinely low: all four are quadratic-complexity DoS reachable only through
the vault content the user themselves authored, on a local single-user build. The mitigation is
`npm audit fix`, which upgrades `js-yaml` to 3.15.x or later; whether `gm-apprentice-publish`'s caret
range permits that without a `gray-matter` bump needs checking. **Recommendation: decide explicitly,
record the decision, and if you accept the risk write one line in the release notes saying why.**

**F2. Generated sites can hotlink Google Fonts, with a GDPR consequence.** The previous pass reported
"no remote font or CDN references in `css/`, `js/` or `templates-scaffold/`". That is true of the
static assets and it is misleading, because the reference is generated at build time.
`lib/theme.js:33-40`:

```js
function googleFontsImport(fonts) {
  const toImport = Object.values(fonts)
    .filter(f => f && !GENERIC_FAMILIES.has(f))
    .filter((v, i, a) => a.indexOf(v) === i);
  if (toImport.length === 0) return '';
  const families = toImport.map(f => `family=${f.replace(/ /g, '+')}`).join('&');
  return `@import url('https://fonts.googleapis.com/css2?${families}&display=swap');\n\n`;
}
```

If the user sets `fonts.heading` or `fonts.body` in `vault.config.json` to a non-generic family, the
generated `css/theme.css` opens with an `@import` from `fonts.googleapis.com`. Every visitor's browser
then sends its IP address to Google.

Licence impact: **none.** No font files are redistributed, the fonts are fetched at runtime by the
visitor, and CSS `font-family` names are not a licensed artefact. The four built-in presets are clean:
`fantasy.css` uses Palatino/Book Antiqua, `horror.css` uses Georgia/Times New Roman, `noir.css` uses
Fira Code, `military.css` uses `system-ui`. All are locally-installed-or-fallback references and none
triggers the import.

Privacy impact: **real, and an EU site operator could object.** The Munich Regional Court held in
January 2022 (LG München I, 3 O 17493/20) that embedding Google Fonts without consent violates GDPR
and awarded damages against the site operator. A wave of demand letters followed. **Recommendation:
when a user configures a custom font, GM-Scriptorium should say so, in one line: "Custom fonts are
loaded from Google Fonts at page load. Visitors' IP addresses are sent to Google. Some jurisdictions
require consent for this. Use a system font to avoid it." That is a product-quality decision as much
as a compliance one.**

**Addendum (ADR 0023):** the built-in `haze` theme's stylesheet opens with three `@import`s from
`fonts.googleapis.com`, carried into every page of a site that selects it. Choosing `theme = "haze"`
therefore sends every visitor's IP address to Google regardless of the vault's font settings, and the
one-line notice recommended above should cover it. `plain` writes no stylesheet. Licence impact: none.

**Resolved for `haze` (issue #84):** `haze` no longer imports anything from Google. It bundles the same
three OFL-1.1 families as `gloam`, as one shared copy (5 woff2 files in `assets/themes/gloam/fonts/`;
`haze`'s `theme.json` names it with `fontsFrom`), copies them into every built site and appends their
licence to the site's `NOTICE.txt`. Attribution is in THIRD-PARTY-NOTICES Section 7 (one entry per family). The files are unsubset and unrenamed, so no Reserved Font Name question arises (none is
declared by any of the three). A test fails if any shipped theme CSS imports a remote URL.

**F3. `uc.micro`'s shipped licence file names the wrong copyright holder.** `uc.micro@2.1.0` is a
markdown-it project (`"repository": "markdown-it/uc.micro"`, Vitaly Puzrin's organisation), but its
`LICENSE.txt` reads `Copyright Mathias Bynens <https://mathiasbynens.be/>`, byte-identical to
`punycode.js`'s licence file. This is an upstream packaging error. **Reproduce it exactly as shipped
anyway.** MIT says reproduce "the above copyright notice", meaning the one the licensor attached. You
cannot correct someone else's copyright line for them, and substituting your own guess would be worse.
Worth one line in the notices generator's comments so a future reader does not "fix" it.

**F4. No express patent grant anywhere in the npm tree.** MIT, BSD-2-Clause, BSD-3-Clause and the PSF
agreement all grant copyright rights and are silent on patents. There is a well-established argument
that MIT's "deal in the Software without restriction" carries an implied patent licence, but it is not
express. This is a straightforward difference from Apache-2.0 and it is worth recording for future
technical or legal review. The only express patent grant in the whole product is OpenSSL's, inside the
Node.js runtime, and it comes with Apache-2.0's defensive-termination clause: initiate patent
litigation alleging OpenSSL infringes and your OpenSSL patent licence ends. That is not a constraint
GM-Scriptorium is realistically going to trip.

**F5. No field-of-use restrictions, no non-commercial clauses, no ethical-source clauses anywhere.** I
checked for them specifically. No JSON-style "do no evil" clause, no Commons Clause, no BSL, no
SSPL, no "not for use in nuclear facilities". The one non-commercial term in the whole provenance
picture is the SJG Online Policy's "not for resale", and section 7 establishes that GM-Scriptorium
does not rely on that permission.

**F6. Single-maintainer supply-chain concentration.** `gm-apprentice-publish` has one maintainer
(`antthelimey`), four published versions, and latest published 2026-05-07. The whole product depends
on it. Not a licence issue. It is a due-diligence question worth an answer ready in advance: the
version is pinned by integrity hash, the source is MIT so it can be forked at any time, and the code
is 275 kB of dependency-light CommonJS that one person could maintain if upstream went dark. That is a
good answer. It is worth having it written down.

**F7.** GM-Scriptorium is MIT-licensed (`LICENSE`) and no inbound licence constrains that.

**F8. The upstream repo's version numbering is a trap for future audits.** The plugin manifest at
`.claude-plugin/plugin.json` reads `"version": "1.7.1"` and the repo's only git tag is `v1.7.1`, while
the npm package's latest is `1.2.1`. These are two independent version streams over the same
repository. Anyone re-running this audit against "the latest version" needs to know which artefact
they mean. The npm tarball is the one that ships.

---

## 13. Remediation checklist

Retained in the private archive at `b5b48b4`.

B1-B4 (section 1) are implemented: B1 is `scripts/vendor/node-v22.23.2-LICENSE.txt`, concatenated by
`scripts/generate-notices.js`; B2 is the `gm-apprentice-publish` entry in `THIRD-PARTY-NOTICES.txt`;
B3 is `scripts/generate-notices.js:238`; B4 is `src/build/notice.js`.

## 14. What this audit does not cover

Stated plainly so nobody mistakes its scope.

- **This is not a legal opinion.** It is a documentary audit by someone who read every licence file in
  the tree. On section 7 in particular, get a lawyer.
- **The Node.js aggregate was read from this machine's v22.22.3, not from the binary that will ship.**
  B1 exists precisely to close that gap.
- **The dependency tree audited is the one resolved on this machine on 2026-09-10.** The upstream
  package uses caret ranges. GM-Scriptorium's own lockfile is what makes this reproducible, and the
  notices file must be generated from it, not from this document.
- **GM-Scriptorium's own source was not audited**, only its bundling plan as described in the
  engineering brief. If GM-Scriptorium vendors any code not listed here, this audit does not cover it.
- **No trademark register searches were run.** The GURPS analysis is based on the SJG Online Policy
  text as quoted in the upstream `ATTRIBUTION.md` and on the general nominative-fair-use test.

## 15. Pin-move addendum (2026-09-17): NEW-1 and NEW-2, resolved

Everything above audited `gm-apprentice-publish@1.2.1` from npm, since replaced by the vendored,
integrity-pinned tree at `vendor/gm-apprentice-publish/PIN.json` (`docs/decisions/0005-generator-pin.md`).
A re-assessment pass against that pin (read-only, dated 2026-09-17) found this document's R1 verdict ("no point costs, no trait lists, no page references, no
tables of GURPS data") **no longer held**: the pin adds two files absent from 1.2.1 that this section's
1.2.1-era analysis never saw.

- **NEW-1.** `lib/templates/gurps/blocks/reference.js` reproduces two literal *GURPS Basic Set 4th
  Edition* data tables (Humanoid Hit Location, p. B552; Size & Speed/Range, p. B550), with page
  citations, rendered unconditionally into every GURPS character page. Upstream's own
  `ATTRIBUTION.md` licenses this exact file under the SJG Online Policy, whose permission is "for
  free distribution, and not for resale", a condition a sold Scriptorium would breach by shipping
  the file. This was a content-licensing blocker, not the trademark-nominative-use question section 7
  above analysed; that question genuinely did not exist for 1.2.1.
- **NEW-2.** `lib/templates/coc/skills-data.js` hardcodes the named Call of Cthulhu 7th Edition (and
  Regency variant) skill list with starting percentages, merged unconditionally into every CoC
  character page. Lower-confidence than NEW-1 (upstream's ORC grant for generic BRP mechanics may or
  may not extend to CoC-specific skill naming), but new since the 1.2.1 audit and worth recording
  regardless of the confidence level.

**Resolution.** Both are RESOLVED by Track DEP-c/R (`docs/decisions/0007-rules-content-redaction.md`):
`src/generator/redactions.js` neutralises both files at runtime (a require-cache seed before the pin's
template tree loads) and `package.json`'s `pkg.patches` erases both files' bodies at packaging time, so
neither the packaged executable nor any site it builds contains either module's content. NEW-1's
removal is not optional; for NEW-2, the owner chose to ship it redacted rather than drop it (its
primary use is D&D 5e, not GURPS or CoC, and the redacted form can be restored later),
reversible later by deleting one registry entry, one `pkg.patches` key and one
`THIRD-PARTY-NOTICES.txt` paragraph, per that ADR's record of the decision. `scripts/generate-notices.js`
Section 4's now-false "Scriptorium contains no GURPS rules content" sentence (originating from this
document's own section 7 disclaimer wording) is corrected in the same ADR.

## 16. Packaging addendum (2026-09-17): bytecode dropped, packaged JS is now readable

`docs/decisions/0010-no-bytecode-packaging.md` fixes a packaging defect (no published Windows exe had
ever started, pkg was compiling V8 bytecode for the win-x64 target on this Linux build host, which the
embedded Windows Node rejected at load) by building with `--no-bytecode --public --public-packages "*"`
instead. This is a licence-provenance-adjacent fact worth recording here, not just in the ADR: the
packaged executable now embeds Scriptorium's own JavaScript source as plain, readable text, comments,
identifiers, control flow all extractable with a plain `strings` pass, rather than as a V8 serialised
code cache. This changes nothing about the third-party component inventory above or the notices
obligations it analyses; it is Scriptorium's own first-party code that is now readable, not any
third-party dependency's. It does bear on the redaction work in section 15/`docs/decisions/0007-rules-content-redaction.md`:
that track's ship gate (`scripts/content-markers.js`'s `scanBuffer()`) was re-run against a binary built
under the new flags, both with `package.json`'s `pkg.patches` removed (all five marker strings found,
the gate still has teeth) and restored (zero hits, the shipped configuration). See 0010 for the full
control re-run and the binary-size comparison.

## 17. Admin panel addendum

The admin panel adds `assets/admin/`, the GM-only admin panel UI (`docs/decisions/0022-gm-admin-panel.md`): 9 files, all first-party
Scriptorium code (vanilla HTML/CSS/JS, no third-party script or library). They join the existing
`FIRST_PARTY_SITE_ASSETS` literal (`scripts/pkg-assets.js`) rather than a second list, per ADR
0023 section 12's precedent, and are embedded into the executable the same way `assets/site/` and
`assets/themes/` already are.

Unlike `assets/site/` and `assets/themes/`, nothing under `assets/admin/` is ever copied into a
built site, published or preview. It is served only over 127.0.0.1 by `scriptorium serve --admin`
(the admin and preview listeners, `src/admin/router.js`), and only while that command is running.
No admin asset is reachable from `src/build/` or `src/generator/`'s module graph (the no-reach rule); a
structural test in `test/admin-assets.test.js` guards this.

This adds nothing to the third-party component inventory above, and carries no notice obligation:
it is Scriptorium's own code, distributed the same way its own CLI is. Section 10's analysis of
what a *published site* redistributes is unchanged; `assets/admin/` is never in that path.

**Panel redesign update:** `assets/admin/` now also includes eight third-party font files (four
families under OFL-1.1), embedded the same way as the rest of `assets/admin/`. Unlike the
first-party code above, these do carry a notice obligation. See section 18.

## 18. Admin panel fonts (panel redesign)

The restyled admin panel embeds four font families as same-origin files, so `@font-face` can load
under the panel's `'self'`-only CSP (`font-src 'self'`, section 17 / `docs/decisions/0022-gm-admin-panel.md`
section 3). Every file ships byte-for-byte as its upstream publisher distributes it: no local
conversion, no subsetting, for any family, whether or not it declares a Reserved Font Name. This is
deliberate: it keeps every embedded byte re-checkable against an immutable upstream URL, and it
means the OFL's "Modified Version" clause never applies to anything Scriptorium ships here. Six of
the eight files are TTF rather than woff2, because IM Fell English, IM Fell English SC and Alegreya
Sans are published by `google/fonts` as TTF only; only IBM Plex Mono publishes a woff2 build.
Manifest: `scripts/vendor/fonts/FONTS.json`. Vendored licence texts: `scripts/vendor/fonts/*-OFL.txt`.

| File | Family | Source (at commit) | Version / commit | sha256 | Copyright (verbatim) | Reserved Font Name |
|---|---|---|---|---|---|---|
| `IMFeENrm28P.ttf` | IM Fell English | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/imfellenglish/IMFeENrm28P.ttf` | `google/fonts@23e54b51ddffbc7713c583748e3bd86f62b1fa4a` | `fe9705bbde51af802719246d4608d08d37bde956ab99d9a590da996a5221a24c` | Copyright (c) 2010, Igino Marini (mail@iginomarini.com) | none declared |
| `IMFeENsc28P.ttf` | IM Fell English SC | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/imfellenglishsc/IMFeENsc28P.ttf` | `google/fonts@23e54b51ddffbc7713c583748e3bd86f62b1fa4a` | `102324fb5434bb5da7963533426b0ad44c85bbc9e7755067535c9d11464a176b` | Copyright (c) 2010, Igino Marini (mail@iginomarini.com) | none declared |
| `AlegreyaSans-Regular.ttf` | Alegreya Sans | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/alegreyasans/AlegreyaSans-Regular.ttf` | `google/fonts@23e54b51ddffbc7713c583748e3bd86f62b1fa4a` | `8fab634196007afca839f1e5a6fb300976daff55d8528b590ef032f01b14ea10` | Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans) | none declared |
| `AlegreyaSans-Medium.ttf` | Alegreya Sans | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/alegreyasans/AlegreyaSans-Medium.ttf` | `google/fonts@23e54b51ddffbc7713c583748e3bd86f62b1fa4a` | `4b89fe7804fd1485ec2757795a53ffdb66e1206dd56f844c2d72b3c944815b43` | Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans) | none declared |
| `AlegreyaSans-Bold.ttf` | Alegreya Sans | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/alegreyasans/AlegreyaSans-Bold.ttf` | `google/fonts@23e54b51ddffbc7713c583748e3bd86f62b1fa4a` | `a3055a1893759bdbd7504bb22abc583769e7974c49353176eac0b03792c9fb8e` | Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans) | none declared |
| `AlegreyaSans-Italic.ttf` | Alegreya Sans | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/alegreyasans/AlegreyaSans-Italic.ttf` | `google/fonts@23e54b51ddffbc7713c583748e3bd86f62b1fa4a` | `f49f6f2bdd84df850b25b0f8185d8a051e1d1eb2dd08e2f91b8c7b86d9a9e1a6` | Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans) | none declared |
| `IBMPlexMono-Regular.woff2` | IBM Plex Mono | `https://raw.githubusercontent.com/IBM/plex/2f9ba1b25957d958db71a849e85d72e3ecfb845a/packages/plex-mono/fonts/complete/woff2/IBMPlexMono-Regular.woff2` | `IBM/plex@ibm/plex-mono@2.5.0 (2f9ba1b25957d958db71a849e85d72e3ecfb845a)` | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" | Plex |
| `IBMPlexMono-SemiBold.woff2` | IBM Plex Mono | `https://raw.githubusercontent.com/IBM/plex/2f9ba1b25957d958db71a849e85d72e3ecfb845a/packages/plex-mono/fonts/complete/woff2/IBMPlexMono-SemiBold.woff2` | `IBM/plex@ibm/plex-mono@2.5.0 (2f9ba1b25957d958db71a849e85d72e3ecfb845a)` | `6a825b4824c01cbb401e829e5a066a1818411bcb3538b5a5792c5ca9b82343c3` | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" | Plex |

- **Unmodified.** Every byte above is the exact upstream-published file; the sha256 column is
  reproducible today by fetching the URL in the same row. `test/admin-fonts.test.js` recomputes
  each hash from the checked-in copy under `assets/admin/fonts/` and fails if either has moved.
- **Why six files are TTF.** `google/fonts` (IM Fell English, IM Fell English SC, Alegreya Sans)
  publishes OFL fonts as TTF; it does not publish a woff2 build for these families. Converting to
  woff2 locally was rejected (a new tool in the chain, and the OFL's "Modified Version" question
  for the one family with a Reserved Font Name). Only IBM Plex Mono ships woff2 upstream.
- **OFL condition 2 is discharged here.** The OFL requires the licence text to accompany the font
  software "whether in its original or in any modified form". Each family's full, unmodified OFL
  1.1 text is reproduced verbatim in `scripts/generate-notices.js`'s Section 6, embedded verbatim
  into the packaged executable's `THIRD-PARTY-NOTICES.txt` and shipped beside every release
  binary (release procedure, `docs/DEVELOPING.md`), satisfying the accompanying-licence condition wherever
  the executable goes, not just in this source tree.
- **Never reach a published site.** These fonts are served only by the admin listener on
  127.0.0.1, the same as every other `assets/admin/` file (section 17). No build, preview or
  publish path reads `assets/admin/fonts/`; `test/admin-assets.test.js`'s scan guards this.

## Repin to publish-v1.11.40 (78696167), 2026-09-30

### Bundled-dependency re-audit

At this pin, `gray-matter`, `lunr` and `markdown-it` are `bundleDependencies` shipped inside the
vendored tarball itself (`node_modules/gm-apprentice-publish/node_modules/**`), rather than
resolved by Scriptorium's own lockfile as before. Every `name@version` and licence below is read
directly from the regenerated `THIRD-PARTY-NOTICES.txt` (Section 2), which in turn reads the
installed tree, not asserted from memory:

| Package | Version | Licence |
|---|---|---|
| `argparse` | `1.0.10` | MIT |
| `argparse` (nested under `markdown-it`) | `2.0.1` | Python-2.0 |
| `entities` | `4.5.0` | BSD-2-Clause |
| `esprima` | `4.0.1` | BSD-2-Clause |
| `extend-shallow` | `2.0.1` | MIT |
| `gray-matter` (bundled copy) | `4.0.3` | MIT |
| `is-extendable` | `0.1.1` | MIT |
| `js-yaml` (bundled copy) | `3.14.2` | MIT |
| `kind-of` | `6.0.3` | MIT |
| `linkify-it` | `5.0.0` | MIT |
| `lunr` | `2.3.9` | MIT |
| `markdown-it` | `14.1.1` | MIT |
| `mdurl` | `2.0.0` | MIT |
| `punycode.js` | `2.3.1` | MIT |
| `section-matter` | `1.0.0` | MIT |
| `sprintf-js` | `1.0.3` | BSD-3-Clause |
| `strip-bom-string` | `1.0.0` | MIT |
| `uc.micro` | `2.1.0` | MIT |

No copyleft, no licence requiring source disclosure, no licence incompatible with keeping this
repository private. Bundled dependencies cannot be patched through Scriptorium's own lockfile
(`docs/decisions/0005-generator-pin.md`'s addendum), a vulnerability in one can only be fixed by a
new upstream pin, not an override here.

### Two gray-matter/js-yaml copies

`src/vault/read.js` still uses Scriptorium's own top-level `gray-matter@4.0.3` (unchanged, and
which itself resolves `js-yaml@3.15.2`, kept, listed separately above from the bundled
`js-yaml@3.14.2`). The generator now parses frontmatter with its own bundled `gray-matter@4.0.3`
copy instead of a shared, hoisted one. Same version, two separate installed packages from here on;
a residual, not a defect, nothing requires the two copies to be identical, and no code path
crosses between them.

### F2 (font provenance) at this pin

- **OD-1: Google-served fonts are still the default; `self-host` is not adopted in this slice.**
  `theme.fonts.source: self-host` is new upstream (#270) and reads a vault-resident
  `_meta/font-cache/` that only a network prefetch can fill, Scriptorium never prefetches
  (`docs/decisions/0005-generator-pin.md`'s "Network posture" addendum), so a campaign that sets
  `self-host` without externally filling that cache gets the generator's own fallback CSS stack
  plus its new cache-miss warning line, proven not to make a network call
  (`test/generator-no-network.test.js`'s FR-19 runtime test builds exactly this scenario).
- **`scifi.css:5`'s Rajdhani Google Fonts `@import` is unchanged at this pin**, present in the
  vendored tree exactly as before, with its own upstream comment explaining the choice
  ("no system stack reproduces a condensed technical face cross-platform").
- **The built-in `haze` theme's three Google Fonts `@import`s (IM Fell English, Cormorant
  Garamond, IM Fell English SC) are untouched by this repin.** Self-hosting them as embedded OFL
  assets (matching the admin panel's own already-vendored IM Fell English/IM Fell English SC
  copies above, plus a new Cormorant Garamond) is out of scope here, routed as its own future
  slice (R3, upstream issue #84).

No owner, campaign or player name appears anywhere above.

## Base theme (`gloam`) fonts, 2026-09-30

The built-in `gloam` theme embeds five font files, converted to WOFF2 from unmodified `google/fonts`
TTF files at the same pinned commit the admin panel fonts above already use. Two families (IM Fell
English, IM Fell English SC) trace to the exact same upstream bytes already audited in section 18;
only Cormorant Garamond's two files are newly vendored here.

**Owner decision, 2026-09-30 (after the first-view byte measurement below showed 2.3-2.5 MiB per
page): ship WOFF2, not the TTFs.** The owner installed Debian's `woff2` package
(`/usr/bin/woff2_compress`, version `1.0.2-2`, upstream `google/woff2`, Expat/MIT licence) and
approved converting all five faces. The TTFs are not shipped; the table below records both the
upstream TTF's own sha256 (the reproducibility source) and the shipped WOFF2's sha256, so anyone
can re-fetch the exact upstream file at the pinned commit and re-run the same converter version to
reproduce the shipped bytes. The TTFs are not kept in this tree either, for the same reason: nothing
here needs the raw bytes once the commit, the converter version and both hashes are on record.

| File shipped | Family | Shipped sha256 (woff2) | Source TTF (at commit) | Source sha256 (ttf) | Copyright (verbatim) | Reserved Font Name |
|---|---|---|---|---|---|---|
| `IMFeENrm28P.woff2` | IM Fell English | `bc324725e1dead508a492ffd50ef51d8b4a0d4d58016da008bd9ec81ef8458d3` | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/imfellenglish/IMFeENrm28P.ttf` | `fe9705bbde51af802719246d4608d08d37bde956ab99d9a590da996a5221a24c` | Copyright (c) 2010, Igino Marini (mail@iginomarini.com) | none declared |
| `IMFeENit28P.woff2` | IM Fell English | `25595dfb8a14b6486013c02157750c490c2b6e996c39e0b3144f00949889e7ab` | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/imfellenglish/IMFeENit28P.ttf` | `47cd75dce54b1f2e0831359d22d5e688f519d68ae45706b664fd310fd0e3ccf7` | Copyright (c) 2010, Igino Marini (mail@iginomarini.com) | none declared |
| `IMFeENsc28P.woff2` | IM Fell English SC | `2e31919e93cb72dc957d9da8a1e4788569490f3cfb7abd52f53ca933792937a3` | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/imfellenglishsc/IMFeENsc28P.ttf` | `102324fb5434bb5da7963533426b0ad44c85bbc9e7755067535c9d11464a176b` | Copyright (c) 2010, Igino Marini (mail@iginomarini.com) | none declared |
| `CormorantGaramond-wght.woff2` (source `CormorantGaramond[wght].ttf`) | Cormorant Garamond | `cf41b906ec483c10451416db623a5d32f26dfd781a388241fb5cadc9a8e56419` | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf` | `b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0` | Copyright 2015 the Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) | none declared |
| `CormorantGaramond-Italic-wght.woff2` (source `CormorantGaramond-Italic[wght].ttf`) | Cormorant Garamond | `115c1ccec1e93f3fc3e8553a0fda713c6c054fad826a7d08da7d7526a82fa72d` | `https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/cormorantgaramond/CormorantGaramond-Italic%5Bwght%5D.ttf` | `0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d` | Copyright 2015 the Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) | none declared |

Manifest: `scripts/vendor/fonts/gloam-FONTS.json` (a top-level `converter` block records the tool,
its source, package version and licence; each file's `source` object records the upstream TTF's
own file name, URL and sha256). Vendored licence texts: `scripts/vendor/fonts/im-fell-english-OFL.txt`,
`im-fell-english-sc-OFL.txt` (both shared with section 18) and the new `cormorant-garamond-OFL.txt`.

- **Not a Modified Version under the OFL.** The OFL FAQ (`openfontlicense.org/ofl-faq/`, questions
  2.2 to 2.2.2) allows a WOFF/WOFF2 repackaging without a name change provided the original font
  data is unchanged except for the compression itself, and the WOFF metadata is either omitted or
  left unaltered; it also warns that not every conversion tool meets this. Verified here, not just
  asserted: each WOFF2 file was decompressed back to TTF with `woff2_decompress` and every SFNT
  table's checksum was compared against the source TTF. The `name` table (the copyright and
  licensing metadata the FAQ's second condition is about) was byte-identical on all 5 faces. Every
  table matched on the 3 static faces; on the 2 variable Cormorant faces, `glyf`/`loca` differ,
  which is the standard, specification-defined WOFF2 transform for TrueType outline data, not an
  unauthorised change, and `head`'s own whole-file checksum field changed only because it is
  recalculated whenever a font's tables are physically reordered, which container-level repackaging
  does by design. See `docs/decisions/0032-base-theme.md`'s evidence section.
- **Cormorant Garamond vendors as two variable files**, not one file per static weight. Each
  declares a `wght` axis range of 300 to 700, covering every weight and style the theme's CSS uses.
- **OFL condition 2 is discharged the same way as section 18**: each family's full OFL 1.1 text is
  reproduced in `scripts/generate-notices.js`'s new Section 7, embedded in the packaged
  executable's `THIRD-PARTY-NOTICES.txt`, which also now names the converter (tool, version,
  licence) as a build-time-only tool, not itself redistributed.
- **Copied into built sites, unlike section 18's admin fonts.** Every site built with the `gloam`
  theme copies all five files into that site's own `scriptorium/theme/fonts/`, and appends the
  same licence text to that site's own `NOTICE.txt`, so the obligation travels with the published
  site, not just with the packaged executable.
- **Measured bytes, before and after the woff2 conversion.** The five TTFs totalled 2,492,496 bytes
  (about 2.4 MiB); the five shipped woff2 files total **629,548 bytes** (about 615 KiB), a 74.7%
  reduction. A real-browser first view of the sample campaign's landing page requests four of the
  five faces: was 2,308,564 bytes, now **543,704 bytes**. An inner page that also uses the small
  caps face requests all five: was 2,492,496 bytes, now **629,548 bytes** (both a ~76% cut).

## Sample campaign in `examples/`, 2026-10-01

The sample campaign, `examples/the-long-lease/`, is text and hand-drawn vector art made for this
repository, with AI assistance. None of it copies a published setting, book, module or artwork.

**Licence.** Everything in `examples/` is offered under this repository's own MIT licence
(`LICENSE`), the same as the rest of the repository.

**SRD 5.2 inbound.** The sample's text uses rules terms from the System Reference Document 5.2
("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd, licensed
under the Creative Commons Attribution 4.0 International License
(https://creativecommons.org/licenses/by/4.0/legalcode). The full attribution sentence is on the
sample's campaign front page (`examples/the-long-lease/_Campaign/The Long Lease.md`) and is
restated in `examples/README.md`.

This commit ships vector art only. A later addition to this section will cover the sample's
painted raster pictures and the README screenshots, once they exist, along with how each one was
made and checked.

## Lantern branding art, 2026-10-08

The README banner and the social preview picture are placeholder art made for this repository, with
AI assistance. Each is a hand-written SVG drawing (a lantern lighting a page) rendered to PNG with
Playwright and Chromium, using Alegreya and Alegreya Sans from Google Fonts (SIL Open Font License
1.1). The fonts are drawn into the pixels and not shipped. Neither copies a published logo or
artwork. Both are offered under this repository's MIT licence (`LICENSE`).

| File | sha256 |
|---|---|
| `docs/images/banner.png` | `35a1e1acf30bdc0565cce1722bbcb10c1868d2528bdeeaf5b06e09ae75045275` |
| `docs/images/social-preview.png` | `ba43761f8e5ca0d0f4478f4e80036c60839adef98e3b2a81f02d0140f224c515` |

The admin panel favicon (`assets/admin/favicon.svg` and `favicon-32.png`) is the same lantern in a
smaller drawing, with the PNG rendered from the SVG.
