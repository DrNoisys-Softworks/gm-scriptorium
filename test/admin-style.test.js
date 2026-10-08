'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ADMIN_ASSET_ROUTES, ADMIN_ASSETS_DIR } = require('../src/admin/assets');

/*
 * Panel v2 V1a, commit C3. New tests (shared design 1.5: "these are new tests. The existing
 * admin constraint tests stay unedited."). Independent literals throughout.
 */

const ROOT = path.join(__dirname, '..');
const ADMIN_CSS_PATH = path.join(ADMIN_ASSETS_DIR, 'admin.css');
const TOKENS_CSS_PATH = path.join(ADMIN_ASSETS_DIR, 'tokens.css');

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

// -- 1. Colour-literal scan over admin.css, plus a positive control -----------------------------

const NAMED_COLORS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond',
  'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue',
  'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon',
  'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia',
  'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink',
  'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue',
  'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink',
  'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
  'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise',
  'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna',
  'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal',
  'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
];
// Bounded on both sides by "not a letter or hyphen", not just \b, so a CSS property name that
// happens to contain a colour word as a prefix/suffix (white-space, lightgray-ish-hypothetical)
// is never mistaken for a colour value.
const NAMED_COLOR_RE = new RegExp(`(?<![a-zA-Z-])(${NAMED_COLORS.join('|')})(?![a-zA-Z-])`, 'i');
const COLOR_FUNC_RE = /\b(rgb|rgba|hsl|hwb|lab|lch|color)\(/i;
const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;

/** @returns {string[]} one finding string per colour literal found, empty if clean */
function findColorLiterals(cssText) {
  const findings = [];
  const stripped = stripCssComments(cssText);
  const lines = stripped.split('\n');
  lines.forEach((line, i) => {
    if (HEX_COLOR_RE.test(line)) findings.push(`line ${i + 1}: hex colour`);
    if (COLOR_FUNC_RE.test(line)) findings.push(`line ${i + 1}: colour function`);
    const named = line.match(NAMED_COLOR_RE);
    if (named) findings.push(`line ${i + 1}: named colour "${named[1]}"`);
  });
  return findings;
}

test('admin.css contains no hex, rgb()/rgba()/hsl()/hwb()/lab()/lch()/color() or named colour literal', () => {
  const css = fs.readFileSync(ADMIN_CSS_PATH, 'utf8');
  const findings = findColorLiterals(css);
  assert.deepEqual(findings, [], `admin.css has ${findings.length} colour-literal finding(s): ${JSON.stringify(findings)}`);
});

test('positive control: the colour-literal scanner flags a planted fixture (hex, function and named colour)', () => {
  const fixture = '.x { color: #ff00ff; background: rgba(1,2,3,0.4); border-color: tomato; }\n';
  const findings = findColorLiterals(fixture);
  assert.ok(findings.length >= 3, `expected at least 3 findings, got ${findings.length}: ${JSON.stringify(findings)}`);
});

test('the scanner does not flag transparent, currentColor or inherit', () => {
  const fixture = '.x { background: transparent; color: currentColor; border-color: inherit; }\n';
  assert.deepEqual(findColorLiterals(fixture), []);
});

test('tokens.css itself is exempt from this scan (it is the one place colour is written) but is non-empty', () => {
  const css = fs.readFileSync(TOKENS_CSS_PATH, 'utf8');
  assert.ok(css.includes(':root'));
  assert.ok(HEX_COLOR_RE.test(stripCssComments(css)), 'tokens.css should carry the hex tokens');
});

// -- 2. Contrast pairs from 1.8, WCAG 2.2 relative luminance, hex tokens only --------------------

function parseHexTokens(tokensCss) {
  const stripped = stripCssComments(tokensCss);
  const map = {};
  const re = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*[;\s]/g;
  let m;
  while ((m = re.exec(stripped))) {
    map[m[1]] = m[2];
  }
  return map;
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  const num = parseInt(h.slice(0, 6), 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function channelLuminance(c) {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG 2.2 contrast ratio, (L1+0.05)/(L2+0.05) with L1 the lighter of the two. */
function contrastRatio(hexA, hexB) {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const TEXT_THRESHOLD = 4.5;
const UI_THRESHOLD = 3;

const TEXT_FOREGROUNDS = ['text', 'text-muted', 'text-faint', 'accent', 'accent-strong', 'pending', 'ok', 'error', 'focus'];
const TEXT_BACKGROUNDS = ['surface-ground', 'surface-glow', 'surface-panel', 'surface-raised', 'surface-sheet'];
const SLIP_FOREGROUNDS = ['slip-ink', 'slip-muted', 'slip-add-ink', 'slip-del-ink', 'slip-link', 'slip-refused-ink'];
const SLIP_BACKGROUNDS = ['slip', 'slip-hi', 'slip-code'];
const UI_PAIRS = [
  ['focus', 'surface-ground'],
  ['focus', 'surface-raised'],
  ['line-control', 'surface-ground'],
  ['line-control', 'surface-glow'],
  ['line-control', 'surface-raised'],
  ['slip-focus', 'slip'],
];

test('contrast: text tokens meet 4.5:1 on the panel surfaces', () => {
  const tokens = parseHexTokens(fs.readFileSync(TOKENS_CSS_PATH, 'utf8'));
  const failures = [];
  for (const fg of TEXT_FOREGROUNDS) {
    for (const bg of TEXT_BACKGROUNDS) {
      const ratio = contrastRatio(tokens[fg], tokens[bg]);
      if (ratio < TEXT_THRESHOLD) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${TEXT_THRESHOLD}`);
    }
  }
  const onAccent = contrastRatio(tokens['on-accent'], tokens.accent);
  if (onAccent < TEXT_THRESHOLD) failures.push(`on-accent on accent: ${onAccent.toFixed(2)} < ${TEXT_THRESHOLD}`);
  assert.deepEqual(failures, []);
});

test('contrast: slip tokens meet 4.5:1 on the slip surfaces', () => {
  const tokens = parseHexTokens(fs.readFileSync(TOKENS_CSS_PATH, 'utf8'));
  const failures = [];
  for (const fg of SLIP_FOREGROUNDS) {
    for (const bg of SLIP_BACKGROUNDS) {
      const ratio = contrastRatio(tokens[fg], tokens[bg]);
      if (ratio < TEXT_THRESHOLD) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${TEXT_THRESHOLD}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('contrast: UI/focus tokens meet 3:1', () => {
  const tokens = parseHexTokens(fs.readFileSync(TOKENS_CSS_PATH, 'utf8'));
  const failures = [];
  for (const [fg, bg] of UI_PAIRS) {
    const ratio = contrastRatio(tokens[fg], tokens[bg]);
    if (ratio < UI_THRESHOLD) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${UI_THRESHOLD}`);
  }
  assert.deepEqual(failures, []);
});

// M11 positive control: the pre-D-7 mock value must fail the exact pair the Architect measured.
test("positive control: the pre-D-7 --text-faint value (#857e71) fails 4.5:1 on the mock's own pairing", () => {
  const ratio = contrastRatio('#857e71', '#1b1916');
  assert.ok(ratio < TEXT_THRESHOLD, `expected #857e71 on #1b1916 to fail 4.5:1, got ${ratio.toFixed(2)}`);
});

test('sanity: contrastRatio() is symmetric and white-on-black is 21:1', () => {
  assert.equal(contrastRatio('#ffffff', '#000000'), contrastRatio('#000000', '#ffffff'));
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01);
});

// -- 3. @font-face: every one of the 8 tuples, swap, no local(), url() names a fonts/ route ------

const FONT_TUPLES = [
  { file: 'IMFeENrm28P.ttf', family: 'IM Fell English', weight: 400, style: 'normal', format: 'truetype' },
  { file: 'IMFeENsc28P.ttf', family: 'IM Fell English SC', weight: 400, style: 'normal', format: 'truetype' },
  { file: 'AlegreyaSans-Regular.ttf', family: 'Alegreya Sans', weight: 400, style: 'normal', format: 'truetype' },
  { file: 'AlegreyaSans-Medium.ttf', family: 'Alegreya Sans', weight: 500, style: 'normal', format: 'truetype' },
  { file: 'AlegreyaSans-Bold.ttf', family: 'Alegreya Sans', weight: 700, style: 'normal', format: 'truetype' },
  { file: 'AlegreyaSans-Italic.ttf', family: 'Alegreya Sans', weight: 400, style: 'italic', format: 'truetype' },
  { file: 'IBMPlexMono-Regular.woff2', family: 'IBM Plex Mono', weight: 400, style: 'normal', format: 'woff2' },
  { file: 'IBMPlexMono-SemiBold.woff2', family: 'IBM Plex Mono', weight: 600, style: 'normal', format: 'woff2' },
];

function extractFontFaceBlocks(cssText) {
  const stripped = stripCssComments(cssText);
  const blocks = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(stripped))) blocks.push(m[1]);
  return blocks;
}

test('admin.css has one @font-face per FONT_TUPLES entry: exact family/weight/style, swap, no local(), url() names a fonts/ route', () => {
  const css = fs.readFileSync(ADMIN_CSS_PATH, 'utf8');
  const blocks = extractFontFaceBlocks(css);
  assert.equal(blocks.length, FONT_TUPLES.length, `expected ${FONT_TUPLES.length} @font-face blocks, found ${blocks.length}`);

  for (const tuple of FONT_TUPLES) {
    const block = blocks.find((b) => b.includes(`url("/assets/fonts/${tuple.file}")`) || b.includes(`url('/assets/fonts/${tuple.file}')`));
    assert.ok(block, `no @font-face block found for ${tuple.file}`);
    assert.match(block, new RegExp(`font-family:\\s*["']${tuple.family}["']`), `${tuple.file}: font-family`);
    assert.match(block, new RegExp(`font-weight:\\s*${tuple.weight}\\b`), `${tuple.file}: font-weight`);
    assert.match(block, new RegExp(`font-style:\\s*${tuple.style}\\b`), `${tuple.file}: font-style`);
    assert.match(block, /font-display:\s*swap/, `${tuple.file}: font-display: swap`);
    assert.doesNotMatch(block, /\blocal\(/, `${tuple.file}: must not use local()`);
    assert.match(block, new RegExp(`format\\(["']${tuple.format}["']\\)`), `${tuple.file}: format()`);
  }
});

// -- 4. Every CSS url() names a route; no @import, data: or http in admin CSS -------------------

test('admin.css: every url() names a route in ADMIN_ASSET_ROUTES; no @import, data: or http(s) scheme', () => {
  const css = fs.readFileSync(ADMIN_CSS_PATH, 'utf8');
  const stripped = stripCssComments(css);
  assert.doesNotMatch(stripped, /@import/);
  assert.doesNotMatch(stripped, /url\(\s*["']?data:/i);
  assert.doesNotMatch(stripped, /url\(\s*["']?https?:/i);

  const urls = [];
  const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
  let m;
  while ((m = re.exec(stripped))) urls.push(m[1]);
  assert.ok(urls.length > 0, 'expected at least one url() in admin.css (the fonts)');
  for (const u of urls) {
    assert.ok(u.startsWith('/assets/'), `${u} does not start with /assets/`);
    const name = u.slice('/assets/'.length);
    assert.ok(Object.prototype.hasOwnProperty.call(ADMIN_ASSET_ROUTES, name), `${u} does not name a route in ADMIN_ASSET_ROUTES`);
  }
});

// -- 5. Forbidden tokens (1.5, extended), fetch( only in app.js, every /api/ literal in the -----
//      17-path literal --------------------------------------------------------------------------

const EXTENDED_FORBIDDEN = [
  "setAttribute('style'",
  'setAttribute("style"',
  '.style.',
  'cssText',
  'DOMParser',
  'createContextualFragment',
  'srcdoc',
  'javascript:',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
];
// `.style\b` from the shared design is a regex fragment (matches `.style` followed by a
// non-word char, e.g. `.style =` or `.style.cssText`, but not `.styleSheets`); represented here
// as its own literal regex rather than folded into the plain-substring list above.
const STYLE_PROPERTY_RE = /\.style\b/;

function jsAssetNames() {
  return Object.keys(ADMIN_ASSET_ROUTES).filter((k) => k.endsWith('.js'));
}

test('every admin JS asset is free of the extended forbidden-token list (1.5), scanned on raw source', () => {
  for (const name of jsAssetNames()) {
    const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, name), 'utf8');
    for (const token of EXTENDED_FORBIDDEN) {
      assert.ok(!src.includes(token), `${name} contains forbidden token "${token}"`);
    }
    assert.doesNotMatch(src, STYLE_PROPERTY_RE, `${name} contains a .style property access`);
  }
});

test('positive control: the extended forbidden-token scan flags a planted fixture for every token', () => {
  for (const token of EXTENDED_FORBIDDEN) {
    assert.ok(`const x = ${token}xyz;`.includes(token));
  }
  assert.match('node.style.cssText = "x";', STYLE_PROPERTY_RE);
});

test('fetch( appears only in app.js among admin JS assets', () => {
  const withFetch = jsAssetNames().filter((name) => fs.readFileSync(path.join(ADMIN_ASSETS_DIR, name), 'utf8').includes('fetch('));
  assert.deepEqual(withFetch, ['app.js']);
});

const API_ROUTE_PATHS = [
  '/auth',
  '/',
  '/api/session',
  '/api/noop',
  '/api/state',
  '/api/check',
  '/api/preview',
  '/api/image',
  '/api/pack/theme',
  '/api/pack/settings',
  '/api/pack/vocab',
  '/api/pack/slots',
  '/api/images/upload',
  // V1e-1 (SD-6, SD-8): the vault-config.md tagline chokepoint's only route.
  '/api/vault-config/tagline',
  // V1e-2 (SD-10, SD-8): per-machine panel preferences (GET and POST share this one path).
  '/api/prefs',
  // V1e-5 (ADR 0038, SD-50): the vault attachments listing and byte routes.
  '/api/vault-art',
  '/api/vault-art/file',
  // V1e-9 (ADR 0033 addendum, SD-99): the guarded vault-config.md editor's own routes.
  '/api/vault-config/backups',
  '/api/vault-config/effects',
  '/api/vault-config/text',
  '/api/vault-config/restore',
  // V1e-10 (ADR 0033 second addendum, SD-110): GET and POST share this one path.
  '/api/vault-config/fields',
  // V1e-7 (ADR 0039, SD-62): builds a private preview copy in a registry theme.
  '/api/variants/theme',
  // V1e-8 (ADR 0039 addendum, SD-70): builds a private preview copy from the saved pack.toml
  // plus the Vocabulary screen's own unsaved edits.
  '/api/variants/vocab',
  // V1.5a (ADR 0029): the read-only Remote access screen's data and its two sign-outs.
  '/api/remote',
  '/api/remote/signout',
  '/api/remote/signout-all',
  // ADR 0028: browser setup's state, live checks and commit, and the Overview welcome's dismissal.
  '/api/setup/state',
  '/api/setup/check',
  '/api/setup/commit',
  '/api/welcome/dismiss',
  // ADR 0049: the folder picker.
  '/api/folders',
  '/api/folders/create',
];

function findApiLiterals(src) {
  return [...src.matchAll(/\/api\/[a-zA-Z0-9/_-]*/g)].map((m) => m[0]);
}

test('every /api/... string literal in the admin JS assets is one of the 33 route paths', () => {
  const found = new Set();
  for (const name of jsAssetNames()) {
    const src = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, name), 'utf8');
    for (const literal of findApiLiterals(src)) {
      found.add(literal);
      assert.ok(API_ROUTE_PATHS.includes(literal), `${name}: "${literal}" is not one of the 33 route paths`);
    }
  }
  // Positive control: the scan actually finds something (not vacuously true).
  assert.ok(found.has('/api/session'), 'expected to find /api/session literally somewhere');
  assert.ok(found.has('/api/state'), 'expected to find /api/state literally somewhere');
  assert.ok(found.has('/api/pack/theme'), 'expected to find /api/pack/theme literally somewhere');
  assert.ok(found.has('/api/folders'), 'expected to find /api/folders literally somewhere');
});

// -- 6. index.html contains data-section="views" (frozen by test/gm-link.test.js:469) -----------

test('index.html contains data-section="views"', () => {
  const html = fs.readFileSync(path.join(ADMIN_ASSETS_DIR, 'index.html'), 'utf8');
  assert.match(html, /data-section="views"/);
});
