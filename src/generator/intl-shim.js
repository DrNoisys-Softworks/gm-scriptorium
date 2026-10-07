'use strict';

/*
 * Scriptorium-owned Intl.Segmenter shim (grapheme granularity only). See
 * docs/decisions/0005-generator-pin.md, "Packaging findings resolved
 * (DEP-a2)".
 *
 * @yao-pkg/pkg 6.22.0's node22-linux-x64/node22-win-x64 base binaries embed
 * a small-icu Node.js build with no break-iterator data. pkg's own prelude
 * (node_modules/@yao-pkg/pkg/prelude/bootstrap-shared.js:372-429) patches
 * Intl.Segmenter.prototype.segment to throw a RangeError on that build
 * rather than let it SIGSEGV (nodejs/node#51752); this module is
 * Scriptorium's own copy of the same idea, scoped to exactly what the
 * pinned generator needs, so a build that hits the gate degrades to a pure
 * JS grapheme splitter instead of failing outright.
 *
 * segmenterDataMissing(): the gate, copied from bootstrap-shared.js:399-415
 * (`process.config.variables.icu_small === true`, and neither `de` nor
 * `ja` resolves in Intl.DateTimeFormat). It never calls native
 * Intl.Segmenter#segment() to probe: on small-icu that call is the
 * uncatchable SIGSEGV described above (bootstrap-shared.js:383-389), not a
 * catchable error, so nothing here may exercise it before the shim is in
 * place.
 *
 * installSegmenterShim(): patches Intl.Segmenter.prototype.segment, not
 * the constructor. The pin constructs its one Intl.Segmenter at module
 * load (node_modules/gm-apprentice-publish/lib/unicode.js:75), and method
 * lookup happens at call time, so an instance constructed before install
 * still picks up the shimmed method the first time it is called. pkg's own
 * prelude relies on the same property (bootstrap-shared.js:419-423).
 *
 * Scope: grapheme granularity only. graphemes()/truncateGraphemes()
 * (unicode.js:77-86) are the pin's only two consumers, reached from
 * templates/landing-data.js:133 and relationship-graph.js:191, and
 * unicode.js:75 is the pin's only Intl.Segmenter construction, always with
 * `{ granularity: 'grapheme' }`. Any other requested granularity throws
 * the same RangeError text pkg's own prelude uses, since this shim does
 * not implement word/sentence segmentation.
 *
 * graphemeSegments(): UAX #29 extended grapheme cluster boundary rules
 * GB1-GB13, implemented with ECMAScript regex Unicode property escapes
 * (`\p{Grapheme_Extend}`, `\p{Extended_Pictographic}`,
 * `\p{Regional_Indicator}`, `\p{Mc}`) plus Hangul syllable arithmetic and
 * U+200D (ZWJ), with two deliberate gaps recorded here and in ADR 0005:
 *   - GB9b (Prepend): rare in practice, and not needed for anything the
 *     pin's own corpus (NPC/location titles) is expected to contain.
 *   - GB9c (Indic conjunct clusters, Unicode 15.1): not expressible with
 *     the binary property escapes ECMAScript regex ships without a
 *     bespoke Indic conjunct-break data table.
 * See test/intl-shim.test.js for the corpus this is checked against
 * (native Intl.Segmenter, on plain node where both are available).
 */

function segmenterDataMissing(env = process) {
  const variables = (env.config && env.config.variables) || {};
  if (variables.icu_small !== true) return false;
  return !(
    new Intl.DateTimeFormat('de').resolvedOptions().locale === 'de'
    && new Intl.DateTimeFormat('ja').resolvedOptions().locale === 'ja'
  );
}

const RE_GRAPHEME_EXTEND = /^\p{Grapheme_Extend}$/u;
const RE_EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const RE_EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const RE_REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
const RE_SPACING_MARK = /^\p{Mc}$/u;
const RE_CONTROL = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;

// Hangul syllable block arithmetic (Unicode 3.0 Hangul Syllables algorithm),
// used to assign the GCB Hangul classes (L, V, T, LV, LVT) the same way the
// real property table does, without shipping the table itself.
const HANGUL_S_BASE = 0xac00;
const HANGUL_L_COUNT = 19;
const HANGUL_V_COUNT = 21;
const HANGUL_T_COUNT = 28;
const HANGUL_N_COUNT = HANGUL_V_COUNT * HANGUL_T_COUNT;
const HANGUL_S_COUNT = HANGUL_L_COUNT * HANGUL_N_COUNT;

function hangulClass(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x1100 && code <= 0x115f) return 'L';
  if (code >= 0xa960 && code <= 0xa97c) return 'L';
  if ((code >= 0x1160 && code <= 0x11a7) || (code >= 0xd7b0 && code <= 0xd7c6)) return 'V';
  if ((code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb)) return 'T';
  if (code >= HANGUL_S_BASE && code < HANGUL_S_BASE + HANGUL_S_COUNT) {
    const sIndex = code - HANGUL_S_BASE;
    return sIndex % HANGUL_T_COUNT === 0 ? 'LV' : 'LVT';
  }
  return null;
}

function classify(ch) {
  if (ch === '\r') return 'CR';
  if (ch === '\n') return 'LF';
  const hangul = hangulClass(ch);
  if (hangul) return hangul;
  if (ch === '‍') return 'ZWJ';
  if (RE_REGIONAL_INDICATOR.test(ch)) return 'RI';
  if (RE_CONTROL.test(ch)) return 'Control';
  if (RE_GRAPHEME_EXTEND.test(ch) || RE_EMOJI_MODIFIER.test(ch)) return 'Extend';
  if (RE_SPACING_MARK.test(ch)) return 'SpacingMark';
  return 'Other';
}

/**
 * True when there is a grapheme cluster boundary between `prev` and `cur`.
 * `extPictRun` tracks whether `prev` ends a (possibly empty) run of
 * `\p{Extended_Pictographic} Extend*` immediately followed by a ZWJ (GB11).
 * `riCount` is the length of the run of consecutive Regional_Indicator
 * characters ending at `prev` (GB12/GB13).
 */
function breaksBetween(prevClass, curClass, curExtPict, extPictRun, riCount) {
  if (prevClass === 'CR' && curClass === 'LF') return false; // GB3
  if (prevClass === 'CR' || prevClass === 'LF' || prevClass === 'Control') return true; // GB4
  if (curClass === 'CR' || curClass === 'LF' || curClass === 'Control') return true; // GB5
  if (prevClass === 'L' && (curClass === 'L' || curClass === 'V' || curClass === 'LV' || curClass === 'LVT')) return false; // GB6
  if ((prevClass === 'LV' || prevClass === 'V') && (curClass === 'V' || curClass === 'T')) return false; // GB7
  if ((prevClass === 'LVT' || prevClass === 'T') && curClass === 'T') return false; // GB8
  if (curClass === 'Extend' || curClass === 'ZWJ') return false; // GB9
  if (curClass === 'SpacingMark') return false; // GB9a
  // GB9b (Prepend) omitted: see the module header and ADR 0005.
  if (curExtPict && prevClass === 'ZWJ' && extPictRun) return false; // GB11
  if (prevClass === 'RI' && curClass === 'RI' && riCount % 2 === 1) return false; // GB12/GB13
  return true; // GB999
}

/**
 * Splits `str` into extended grapheme clusters per UAX #29 (GB1-GB13,
 * minus GB9b/GB9c; see the module header). Returns `string[]`.
 */
function graphemeSegments(str) {
  const chars = Array.from(String(str));
  if (chars.length === 0) return [];

  const classes = chars.map(classify);
  const extPicts = chars.map((ch) => RE_EXTENDED_PICTOGRAPHIC.test(ch));

  const clusters = [];
  let clusterStart = 0;
  let extPictRun = extPicts[0];
  let riCount = classes[0] === 'RI' ? 1 : 0;

  for (let i = 1; i < chars.length; i++) {
    const brk = breaksBetween(classes[i - 1], classes[i], extPicts[i], extPictRun, riCount);
    if (brk) {
      clusters.push(chars.slice(clusterStart, i).join(''));
      clusterStart = i;
      extPictRun = extPicts[i];
      riCount = classes[i] === 'RI' ? 1 : 0;
    } else {
      if (classes[i] === 'Extend' || classes[i] === 'ZWJ') {
        // extPictRun carries through Extend* and a single ZWJ unchanged.
      } else {
        extPictRun = extPicts[i];
      }
      riCount = classes[i] === 'RI' ? riCount + 1 : 0;
    }
  }
  clusters.push(chars.slice(clusterStart).join(''));
  return clusters;
}

function unsupportedGranularityError() {
  const variables = (process.config && process.config.variables) || {};
  const dat = `icudt${variables.icu_ver_major || ''}l.dat`;
  return new RangeError(
    'pkg: Intl.Segmenter is unavailable in this executable. It embeds a '
      + 'small-icu Node.js build with no break-iterator data, where calling '
      + 'segment() would crash the process (nodejs/node#51752). Re-package '
      + 'with --sea, which uses full-icu official Node.js binaries, or set '
      + 'NODE_ICU_DATA to a directory containing '
      + dat
      + '.',
  );
}

/**
 * Installs the shim on Intl.Segmenter.prototype.segment. Only installs
 * when `force` is true or segmenterDataMissing() is true; otherwise it is
 * a no-op (native ICU segmentation stays exact). Returns `restore()`.
 */
function installSegmenterShim({ force = false } = {}) {
  if (!force && !segmenterDataMissing()) {
    return function restore() {};
  }

  const original = Intl.Segmenter.prototype.segment;
  Intl.Segmenter.prototype.segment = function segment(input) {
    const { granularity } = this.resolvedOptions();
    if (granularity !== 'grapheme') {
      throw unsupportedGranularityError();
    }
    const str = String(input);
    let index = 0;
    return graphemeSegments(str).map((segment) => {
      const item = { segment, index, input: str };
      index += segment.length;
      return item;
    });
  };

  return function restore() {
    Intl.Segmenter.prototype.segment = original;
  };
}

module.exports = { segmenterDataMissing, graphemeSegments, installSegmenterShim };
