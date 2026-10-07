'use strict';

const fs = require('fs');
const path = require('path');
const { createFinding } = require('../../report/finding');
const { findWholeWordOccurrences, collectWithheldNames } = require('./l4');
const read = require('../../vault/read');
const pinned = require('../../generator/pinned');

/*
 * Track D2: the leak check that reads what the generator actually EMITTED,
 * not the source markdown L1-L5 read. A withheld name that only reaches the
 * published site through a derived view — a relationship-graph SVG `<text>`
 * label (escapeHtml(truncateGraphemes(node.displayTitle, 15, 13)) inside
 * `<text>`, lib/relationship-graph.js:193-194), an aggregate index card
 * built from a frontmatter field (escapeHtml(leadership) inside
 * `<div class="intel-leadership">`, lib/templates/index-page.js:604,609-611),
 * a recency/landing excerpt (escapeHtml(fm.outcome) inside
 * `<div class="card-excerpt">` on an event card, lib/templates/landing.js:206,210),
 * a copied attachment's own filename, or a lunr stem/possessive term in
 * search-index.json — is structurally invisible to L4 (source-side) and to
 * every other leak check. This module is the whole scanner: two arms
 * (scanOutputTree for text/href/path, scanSearchIndex for the lunr index),
 * both pure apart from reads, both driven by the SAME hidden-name set L4
 * already computes (collectWithheldNames, l4.js:81-99) so a name excluded
 * there as a published-name collision is excluded here too (FR-02 parity).
 *
 * No suppression mechanism of any kind lives here (Structural decision 13):
 * no allowlist, no "known derived views" exception file, no file class is
 * quietly skipped. Generator-shipped static assets (js/**, css/**,
 * js/lunr.js) are scanned exactly like everything else; a hit there is
 * reported like any other hit, not filtered.
 */

// Binary/raster and other non-text output is skipped by extension (FR-07's
// precedent). Everything else emitted by the generator — .html, .svg,
// .json, .js, .css, .txt, .xml, and anything unrecognised — is read as
// utf8 and scanned; `.svg` in particular MUST be scanned (decision 12),
// since the relationship-graph label leak lives inside inline `<svg>`
// markup embedded in the .html pages, but a generator build can also write
// standalone .svg banner assets.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.mp3', '.mp4', '.webm', '.ogg', '.wav',
]);

// Single-pass HTML entity decode over `&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);`
// (Structural decision 6). Single pass is the point: replacing greedily in one
// regex.replace call means an already-decoded "&amp;lt;" becomes "&lt;" (its
// entity form left alone), never "<" — a second pass over the same string
// would double-decode and could fabricate a match that was never really
// there. escapeHtml only ever escapes `& < > "` (lib/processor.js:11-17), so
// `&#39;`/`&#x27;`/`&apos;` are covered defensively for any future escaper,
// not because the pin's own escapeHtml emits them today.
const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntitiesOnce(text) {
  return String(text).replace(ENTITY_RE, (whole, body) => {
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}

// Folds markdown-it's typographer output (`typographer: true`,
// lib/markdown.js:74) back toward the plain source characters a withheld
// name was actually authored with, so a source-side needle still matches
// the rendered HTML byte-for-byte without Scriptorium generating variant
// needles per name (Structural decision 6: normalise the haystack, not the
// needle).
function foldTypographer(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '--')
    .replace(/—/g, '---')
    .replace(/…/g, '...');
}

/**
 * entities > typographer fold > NFC. Applied identically to every haystack
 * this module builds (Structural decision 6). Case is handled separately by
 * findWholeWordOccurrences' own `gi` flags (l4.js:23), not here.
 */
function normaliseEmitted(text) {
  return pinned.canonicalNfc(foldTypographer(decodeEntitiesOnce(String(text == null ? '' : text))));
}

/**
 * Every extra needle form a hidden name needs, beyond its own literal text,
 * each computed with the pin's own functions so it can never drift from
 * what the pin actually renders (Structural decision 7):
 *
 *   - truncated-label: mirrors the relationship-graph SVG label
 *     (`escapeHtml(truncateGraphemes(node.displayTitle, 15, 13))`,
 *     lib/relationship-graph.js:193-194, lib/unicode.js:83-87 for
 *     truncateGraphemes itself). Present only when the name is actually
 *     long enough to be truncated.
 *   - underscored: mirrors the unpublished-target graph-node fallback
 *     (`title.replace(/_/g, ' ')`, lib/relationship-graph.js:47, the same
 *     transform as humanizeName, lib/processor.js:17-19). Present only when
 *     the name contains `_`.
 */
function needleFormsFor(name) {
  const forms = [{ form: 'literal', needle: name }];
  const truncated = pinned.truncateGraphemes(name, 15, 13);
  if (truncated !== name) {
    // truncateGraphemes always appends a literal "…" (lib/unicode.js:86's
    // default ellipsis param), never authored prose markdown-it's
    // typographer would have rendered — the SVG label is built by plain
    // string concatenation, not markdown rendering. normaliseEmitted still
    // folds "…" to "..." on the haystack side (decision 6, for genuinely
    // authored "..." that DID go through the typographer), so this needle
    // must be folded the same way, or the two would never agree on which
    // ellipsis form to compare.
    forms.push({ form: 'truncated-label', needle: foldTypographer(truncated) });
  }
  if (name.includes('_')) {
    forms.push({ form: 'underscored', needle: name.replace(/_/g, ' ') });
  }
  return forms;
}

/**
 * Tries each needle form against `rawText` (unnormalised) first, then
 * `normalisedText`, in the array order needleFormsFor produced (literal
 * before its derived forms), so a match is reported at the least-surprising
 * form that actually explains it: a literal hit in raw bytes is `'literal'`
 * (a plain grep of the file would find it), the same literal needle only
 * reachable after decode/typographer-fold/NFC is `'normalised'`, and the
 * two pin-derived needles keep their own form names regardless of whether
 * the raw or normalised haystack carried them (they are never present
 * un-normalised in practice, since they are built from escaped, rendered
 * HTML text).
 *
 * @returns {{ matchedForm: string, needle: string, haystack: string, index: number } | null}
 */
function findNeedleMatch(needleForms, rawText, normalisedText) {
  const literal = needleForms.find((f) => f.form === 'literal');
  if (literal) {
    const rawHits = findWholeWordOccurrences(rawText, literal.needle);
    if (rawHits.length > 0) {
      return { matchedForm: 'literal', needle: literal.needle, haystack: rawText, index: rawHits[0] };
    }
  }
  for (const { form, needle } of needleForms) {
    const hits = findWholeWordOccurrences(normalisedText, needle);
    if (hits.length > 0) {
      return {
        matchedForm: form === 'literal' ? 'normalised' : form,
        needle,
        haystack: normalisedText,
        index: hits[0],
      };
    }
  }
  return null;
}

function quoteContext(text, index, needle) {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + needle.length + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

// Extracts every href="..."/src="..." attribute VALUE, verbatim (still
// entity-escaped, still percent-encoded), from one file's raw text.
const HREF_SRC_RE = /\b(?:href|src)="([^"]*)"/g;

function extractHrefSrcValues(rawText) {
  const values = [];
  let m;
  HREF_SRC_RE.lastIndex = 0;
  while ((m = HREF_SRC_RE.exec(rawText))) {
    values.push(m[1]);
  }
  return values;
}

/**
 * Undoes escapeHtml (entity decode) then encodeHref (per-segment percent
 * decode, `decodeURIComponent` in a try/catch — malformed encoding is left
 * as-is rather than thrown, decoding is never applied to a whole file,
 * Structural decision 6) on one extracted href/src value.
 */
function decodeHrefValue(rawValue) {
  const entityDecoded = decodeEntitiesOnce(rawValue);
  const segments = entityDecoded.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return pinned.canonicalNfc(segments.join('/'));
}

/**
 * `leak/l4-output-name`: scans every emitted file under `outDir` for every
 * hidden name of every withheld entity, across three arms in precedence
 * order text > href > path (one finding per (outputPath, name)):
 *
 *   - text: the file's own rendered text, normalised (normaliseEmitted).
 *   - href: every href="…"/src="…" attribute value, entity- and
 *     percent-decoded per segment.
 *   - path: the file's own emitted relative path (a copied attachment
 *     whose filename itself carries the withheld name).
 *
 * Traversal is read.walkVault(outDir) (Structural decision 12): sorted,
 * abort-on-EIO, the same guarantee the vault chokepoint gives, reused here
 * for a non-vault tree because src/vault/read.js deliberately exposes no
 * separate general-purpose file walker.
 *
 * @param {{ outDir: string, campaign: string, withheld: ReturnType<typeof collectWithheldNames> }} opts
 * @returns {import('../../report/finding').Finding[]}
 */
function scanOutputTree({ outDir, campaign, withheld }) {
  const rows = withheld.filter((row) => row.hiddenNames.length > 0);
  if (rows.length === 0) return [];

  const findings = [];
  const files = read.walkVault(outDir);

  for (const file of files) {
    const ext = path.extname(file.relPath).toLowerCase();
    // Binary rasters/fonts skip the CONTENT arms only (text, href — both need
    // to read and interpret bytes as text). The path arm never reads file
    // content at all, so it must still run for a binary file: a copied
    // attachment's own filename (e.g. images/wendeline-ashcombe.png) is
    // exactly the leak this arm exists to catch, and it would be invisible
    // if a binary extension skipped the whole file rather than just its
    // unreadable-as-text bytes.
    const isBinary = BINARY_EXTENSIONS.has(ext);

    const rawText = isBinary ? '' : fs.readFileSync(file.absPath, 'utf8');
    const normalisedText = isBinary ? '' : normaliseEmitted(rawText);
    const hrefValues = isBinary ? [] : extractHrefSrcValues(rawText);
    const normalisedPath = pinned.canonicalNfc(file.relPath);

    for (const { entity, hiddenNames } of rows) {
      for (const name of hiddenNames) {
        const forms = needleFormsFor(name);
        const rawContains = !isBinary && findWholeWordOccurrences(rawText, name).length > 0;

        let arm = 'text';
        let match = isBinary ? null : findNeedleMatch(forms, rawText, normalisedText);

        if (!match && !isBinary) {
          arm = 'href';
          for (const rawHref of hrefValues) {
            match = findNeedleMatch(forms, rawHref, decodeHrefValue(rawHref));
            if (match) break;
          }
        }

        if (!match) {
          arm = 'path';
          match = findNeedleMatch(forms, file.relPath, normalisedPath);
        }

        if (!match) continue;

        findings.push(
          createFinding({
            id: 'leak/l4-output-name',
            severity: 'error',
            category: 'leak',
            campaign,
            path: entity.relPath,
            line: null,
            outputPath: file.relPath,
            message: `${file.relPath}: withheld name "${name}" (from ${entity.relPath}) appears in built output (${arm} arm)`,
            detail: quoteContext(match.haystack, match.index, match.needle),
            data: {
              hiddenName: name,
              withheldEntity: entity.relPath,
              arm,
              matchedForm: match.matchedForm,
              rawContains,
            },
          }),
        );
      }
    }
  }

  return findings;
}

function refsAndFieldsForTerm(postings) {
  const fields = [];
  const refs = new Set();
  for (const field of Object.keys(postings)) {
    if (field === '_index') continue;
    const fieldRefs = Object.keys(postings[field]);
    if (fieldRefs.length > 0) {
      fields.push(field);
      for (const r of fieldRefs) refs.add(r);
    }
  }
  return { fields, refs };
}

/**
 * FR-18/SD-18 (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md): at publish-v1.11.40
 * the generator's search pipeline no longer stems (Δ: lunr.js:1963-1964 drop the stemmer from both
 * `pipeline` and `searchPipeline`). Lunr serialises the index's own `pipeline` from the builder's
 * `searchPipeline` (node_modules/lunr/lunr.js:2269, :2657); at this pin that is therefore `[]` --
 * the old pin's was `["stemmer"]`. This table names every serialised-`pipeline` shape this check
 * knows how to interpret. Rejected: re-deriving the whole pipeline from the serialised field alone
 * (the index pipeline used for the SEARCH tokens isn't itself serialised as a reproducible
 * function list -- only the name is; this table is the map from name to behaviour, read by hand
 * once per pin, not derived automatically).
 */
const RECOGNISED_PIPELINES = new Map([[JSON.stringify([]), { stems: false }]]);

/**
 * `^<token>(?:['’]?s)?[^\p{L}\p{N}]*$` — the exact token, optionally followed by a
 * possessive/plural "'s"/"s" form, then trailing punctuation only. Never a prefix match (SD-18):
 * "brimble" must not match the index term "brimstone".
 */
function indexTermRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:['’]?s)?[^\\p{L}\\p{N}]*$`, 'u');
}

/**
 * Maps a base-36 `invertedIndex` ref through `documents[ref].href` (Δ: refs are opaque ids,
 * `i.toString(36)`, with the output path moved to `documents[ref].href` -- never the ref itself).
 * An unmapped ref (documents has no entry, or no href) is kept RAW rather than dropped, so a
 * finding never silently loses a hit; the caller counts how many came back unmapped.
 */
function mapRefsToHrefs(refs, documents) {
  const mapped = [];
  let unmappedCount = 0;
  for (const ref of refs) {
    const doc = documents && documents[ref];
    if (doc && typeof doc.href === 'string') {
      mapped.push(doc.href);
    } else {
      mapped.push(ref);
      unmappedCount += 1;
    }
  }
  return { documentRefs: mapped.sort(), unmappedRefs: unmappedCount };
}

/**
 * `leak/l4-index-term`: reproduces the generator's own search pipeline (trimmer, stopWordFilter --
 * no stemmer at this pin, RECOGNISED_PIPELINES above) against every hidden name, then checks
 * whether the resulting token(s) are reachable in search-index.json's `invertedIndex`, a SORTED
 * ARRAY of `[term, postings]` pairs (lunr.js:2253-2257), never an object -- the single most likely
 * way for this arm to fail quietly (Risk areas), guarded by test/leak-index-term.test.js feeding a
 * real built search-index.json.
 *
 * Checks run in order: version (unchanged), then pipeline (an unrecognised serialised `pipeline`
 * gives one WARN naming it and interprets no terms), then terms.
 *
 * Single-word names report one finding per matching index TERM (so "hollin" and the possessive
 * "hollin's" are two separate findings, each with its own documentRefs). Multi-word names only
 * fire when every non-stop-word token has at least one matching term, AND those terms'
 * document-ref sets share at least one ref (no positions are stored, so "share a document" is the
 * strongest claim the index itself supports); a shared ref means the finding's `term` is the
 * space-joined tokens and `documentRefs` is the shared-ref intersection, mapped through hrefs.
 *
 * @param {{ outDir: string, campaign: string, withheld: ReturnType<typeof collectWithheldNames> }} opts
 */
function scanSearchIndex({ outDir, campaign, withheld }) {
  const indexPath = path.join(outDir, 'search-index.json');

  if (!read.pathExists(indexPath)) {
    return [
      createFinding({
        id: 'leak/l4-index-term',
        severity: 'info',
        category: 'leak',
        campaign,
        message:
          'no search-index.json in the built output; leak/l4-index-term cannot check the search index yet (legitimate if searchEnabled: false)',
      }),
    ];
  }

  let json;
  try {
    json = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (err) {
    return [
      createFinding({
        id: 'leak/l4-index-term',
        severity: 'warn',
        category: 'leak',
        campaign,
        message: `search-index.json could not be parsed as JSON (${err.message}); leak/l4-index-term cannot interpret it`,
      }),
    ];
  }

  const indexVersion = (json.index && json.index.version) || null;
  if (indexVersion !== pinned.LUNR_VERSION) {
    return [
      createFinding({
        id: 'leak/l4-index-term',
        severity: 'warn',
        category: 'leak',
        campaign,
        message: `search-index.json's lunr index version ("${indexVersion}") does not match the resolved lunr copy ("${pinned.LUNR_VERSION}"); leak/l4-index-term cannot safely interpret its terms and did not try`,
        data: { indexVersion, expectedVersion: pinned.LUNR_VERSION },
      }),
    ];
  }

  const serialisedPipeline = (json.index && json.index.pipeline) || [];
  const pipelineKey = JSON.stringify(serialisedPipeline);
  const recognised = RECOGNISED_PIPELINES.get(pipelineKey);
  if (!recognised) {
    return [
      createFinding({
        id: 'leak/l4-index-term',
        severity: 'warn',
        category: 'leak',
        campaign,
        message: `search-index.json's serialised pipeline (${pipelineKey}) is not one leak/l4-index-term recognises; it cannot safely interpret terms and did not try`,
        data: { serialisedPipeline },
      }),
    ];
  }

  const rows = withheld.filter((row) => row.hiddenNames.length > 0);
  if (rows.length === 0) return [];

  const invertedPairs = (json.index && json.index.invertedIndex) || [];
  const termPostings = new Map(invertedPairs);
  const documents = json.documents || {};

  const pipeline = new pinned.lunr.Pipeline();
  pipeline.add(pinned.lunr.trimmer, pinned.lunr.stopWordFilter);

  const findings = [];

  for (const { entity, hiddenNames } of rows) {
    for (const name of hiddenNames) {
      const rawTokens = pinned.lunr.tokenizer(pinned.canonicalNfc(name));
      const pipelineTokens = pipeline
        .run(rawTokens)
        .map((t) => t.toString())
        .filter((s) => s.length > 0);
      if (pipelineTokens.length === 0) continue; // every word of this name was a stop word

      if (pipelineTokens.length === 1) {
        const termRe = indexTermRegex(pipelineTokens[0]);
        for (const [term, postings] of termPostings) {
          if (!termRe.test(term)) continue;
          const { fields, refs } = refsAndFieldsForTerm(postings);
          if (refs.size === 0) continue;
          const { documentRefs, unmappedRefs } = mapRefsToHrefs(refs, documents);
          findings.push(
            createFinding({
              id: 'leak/l4-index-term',
              severity: 'error',
              category: 'leak',
              campaign,
              path: entity.relPath,
              line: null,
              outputPath: 'search-index.json',
              message: `search-index.json: withheld name "${name}" (from ${entity.relPath}) is reachable via lunr index term "${term}"`,
              data: {
                hiddenName: name,
                withheldEntity: entity.relPath,
                term,
                documentRefs,
                unmappedRefs,
                fields: [...fields].sort(),
              },
            }),
          );
        }
        continue;
      }

      // Multi-word: every token needs at least one matching term, and their
      // document-ref sets need a non-empty intersection.
      const perToken = pipelineTokens.map((token) => {
        const termRe = indexTermRegex(token);
        const refs = new Set();
        const fields = new Set();
        for (const [term, postings] of termPostings) {
          if (!termRe.test(term)) continue;
          const hit = refsAndFieldsForTerm(postings);
          for (const r of hit.refs) refs.add(r);
          for (const f of hit.fields) fields.add(f);
        }
        return { refs, fields };
      });

      if (perToken.some((s) => s.refs.size === 0)) continue;

      let shared = perToken[0].refs;
      for (let i = 1; i < perToken.length; i++) {
        shared = new Set([...shared].filter((r) => perToken[i].refs.has(r)));
      }
      if (shared.size === 0) continue;

      const fields = new Set();
      for (const s of perToken) for (const f of s.fields) fields.add(f);

      const { documentRefs, unmappedRefs } = mapRefsToHrefs(shared, documents);
      findings.push(
        createFinding({
          id: 'leak/l4-index-term',
          severity: 'error',
          category: 'leak',
          campaign,
          path: entity.relPath,
          line: null,
          outputPath: 'search-index.json',
          message: `search-index.json: withheld name "${name}" (from ${entity.relPath}) is reachable via lunr index terms "${pipelineTokens.join(' ')}", sharing document ref(s) ${documentRefs.join(', ')}`,
          data: {
            hiddenName: name,
            withheldEntity: entity.relPath,
            term: pipelineTokens.join(' '),
            documentRefs,
            unmappedRefs,
            fields: [...fields].sort(),
          },
        }),
      );
    }
  }

  return findings;
}

/**
 * Mirrors leak/l2's no-build contract exactly (l2.js:47-61): two distinct
 * INFO messages so a user knows whether to create the output directory or
 * just run `build`, never silence.
 */
function noBuildInfo(id, ctx) {
  const configuredButEmpty = Boolean(ctx.outputPathConfigured) && read.pathExists(ctx.outputPathConfigured);
  return createFinding({
    id,
    severity: 'info',
    category: 'leak',
    campaign: ctx.campaign,
    message: configuredButEmpty
      ? `the output directory (${ctx.outputPathConfigured}) exists but has no build in it; ${id} cannot check built output yet, run "build" first`
      : `no output directory exists at the configured path; ${id} cannot check built output yet`,
  });
}

/**
 * FR-16 / Structural decision 4: the pre-build `check` inside `build` must
 * not judge the OLD finalOut it is about to replace. When deferred, this is
 * the only finding either id ever produces here: never silent, always says
 * in words that the real scan runs against this build's own staging tree
 * before the swap (src/build/outputgate.js), and still gates the build.
 */
function deferredInfo(id, ctx) {
  return createFinding({
    id,
    severity: 'info',
    category: 'leak',
    campaign: ctx.campaign,
    message: `${id}: the output scan is deferred to this build's own staging tree (it runs before the swap, not against the existing, about-to-be-replaced output)`,
  });
}

function runOutputName(ctx) {
  if (ctx.deferOutputScan) return [deferredInfo('leak/l4-output-name', ctx)];
  if (!ctx.outputPath) return [noBuildInfo('leak/l4-output-name', ctx)];
  return scanOutputTree({ outDir: ctx.outputPath, campaign: ctx.campaign, withheld: collectWithheldNames(ctx) });
}

function runIndexTerm(ctx) {
  if (ctx.deferOutputScan) return [deferredInfo('leak/l4-index-term', ctx)];
  if (!ctx.outputPath) return [noBuildInfo('leak/l4-index-term', ctx)];
  return scanSearchIndex({ outDir: ctx.outputPath, campaign: ctx.campaign, withheld: collectWithheldNames(ctx) });
}

module.exports = {
  normaliseEmitted,
  needleFormsFor,
  scanOutputTree,
  scanSearchIndex,
  runOutputName,
  runIndexTerm,
  noBuildInfo,
  deferredInfo,
};
