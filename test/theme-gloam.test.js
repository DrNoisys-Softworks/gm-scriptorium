'use strict';

// ADR 0032: the gloam theme's own structure (T1-T12, T15), plus real-build tests T13/T14
// (buildThemeVault/writeConfigToml/writePackToml/findHtmlFiles below are COPIED from
// test/theme-haze.test.js, not imported, per that file's own convention).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadTheme } = require('../src/build/themes');
const { runBuildCommand } = require('../src/cli/build');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { buildNoticeText } = require('../src/build/notice');

const THEME_DIR = path.join(__dirname, '..', 'assets', 'themes', 'gloam');
const THEME_JSON_PATH = path.join(THEME_DIR, 'theme.json');
const THEME_CSS_PATH = path.join(THEME_DIR, 'theme.css');
const NOTICE_PATH = path.join(THEME_DIR, 'NOTICE.txt');
const FONTS_DIR = path.join(THEME_DIR, 'fonts');
const HAZE_CSS_PATH = path.join(__dirname, '..', 'assets', 'themes', 'haze', 'theme.css');
const SCRIPTORIUM_CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');
const MANIFEST_PATH = path.join(__dirname, '..', 'scripts', 'vendor', 'fonts', 'gloam-FONTS.json');

function themeJson() {
  return JSON.parse(fs.readFileSync(THEME_JSON_PATH, 'utf8'));
}
function ownCss() {
  return fs.readFileSync(THEME_CSS_PATH, 'utf8');
}
function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
function normalizeWs(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// -- T1 -------------------------------------------------------------------------------------

test('T1: theme.json deepEquals the literal', () => {
  assert.deepEqual(themeJson(), {
    name: 'gloam',
    scheme: 'dark',
    slots: ['hero', 'ground', 'paper', '404'],
    extends: 'haze',
    owns: ['fonts', 'palette'],
  });
});

// -- T2: composition oracle, computed in the test, never through the product parser ---------

test('T2: loadTheme("gloam").css equals hazeFile.slice(Tokens marker) + "\\n" + gloamFile', () => {
  const hazeFile = fs.readFileSync(HAZE_CSS_PATH, 'utf8');
  const gloamFile = ownCss();
  const marker = '/* ==== Tokens ==== */';
  const idx = hazeFile.indexOf(marker);
  assert.ok(idx > -1, 'haze theme.css must still carry the Tokens marker comment');
  const expected = hazeFile.slice(idx) + '\n' + gloamFile;
  assert.equal(loadTheme('gloam').css, expected);
});

// -- T3 ---------------------------------------------------------------------------------------

test('T3: composed CSS has 0 @import; every top-level url() is data: or a theme-fonts path; no local()', () => {
  const composed = loadTheme('gloam').css;
  const stripped = stripComments(composed);
  assert.equal((stripped.match(/@import\b/g) || []).length, 0);

  // haze's own data: URIs (SVG art) can themselves contain literal "url(...)" text inside their
  // own percent-encoded payload (an embedded SVG referencing its own fill: url(#id)); mask
  // url("data:...") calls out FIRST so that nested text is never mistaken for a top-level url().
  let dataUrlCount = 0;
  const masked = stripped.replace(/url\("data:[^"]*"\)/g, () => {
    dataUrlCount += 1;
    return 'URL_DATA';
  });
  assert.ok(dataUrlCount > 0, 'expected at least one haze data: URI in the composed CSS');

  let fontUrlCount = 0;
  for (const m of masked.matchAll(/url\((["']?)([^"')]*)\1\)/g)) {
    fontUrlCount += 1;
    assert.match(m[2], /^\.\.\/scriptorium\/theme\/fonts\//, `unexpected top-level url() value: ${m[2].slice(0, 60)}`);
  }
  assert.equal(fontUrlCount, 5);
  assert.doesNotMatch(masked, /\blocal\(/);
});

// -- T4: fonts ----------------------------------------------------------------------------------

test('T4: @font-face src files equal fonts/ listing equal the manifest; font-display swap; 10-face coverage', () => {
  const stripped = stripComments(ownCss());
  const faceBlocks = [...stripped.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(faceBlocks.length, 5);

  const srcFiles = new Set();
  const rules = [];
  for (const block of faceBlocks) {
    assert.match(block, /font-display:\s*swap/, 'every face must be font-display: swap');
    const urlMatch = block.match(/url\("([^"]+)"\)\s*format\("woff2"\)/);
    assert.ok(urlMatch, `expected a woff2 url() in: ${block}`);
    assert.match(urlMatch[1], /^\.\.\/scriptorium\/theme\/fonts\//);
    srcFiles.add(urlMatch[1].split('/').pop());

    const family = block.match(/font-family:\s*'([^']+)'/)[1];
    const style = block.match(/font-style:\s*(\w+)/)[1];
    const weightRaw = block.match(/font-weight:\s*([0-9 ]+);/)[1].trim();
    const weight = weightRaw.includes(' ') ? weightRaw.split(/\s+/).map(Number) : Number(weightRaw);
    rules.push({ family, style, weight });
  }

  const onDisk = fs.readdirSync(FONTS_DIR).sort();
  const manifestFiles = manifest()
    .files.map((f) => f.file)
    .sort();
  assert.deepEqual([...srcFiles].sort(), onDisk);
  assert.deepEqual(onDisk, manifestFiles);

  // Independent literal, typed from haze/theme.css:10-12's own 3 @import families.
  const TEN_FACES = [
    { family: 'IM Fell English', style: 'normal', weight: 400 },
    { family: 'IM Fell English', style: 'italic', weight: 400 },
    { family: 'IM Fell English SC', style: 'normal', weight: 400 },
    { family: 'Cormorant Garamond', style: 'normal', weight: 400 },
    { family: 'Cormorant Garamond', style: 'normal', weight: 500 },
    { family: 'Cormorant Garamond', style: 'normal', weight: 600 },
    { family: 'Cormorant Garamond', style: 'normal', weight: 700 },
    { family: 'Cormorant Garamond', style: 'italic', weight: 400 },
    { family: 'Cormorant Garamond', style: 'italic', weight: 600 },
    { family: 'Cormorant Garamond', style: 'italic', weight: 700 },
  ];
  for (const face of TEN_FACES) {
    const covered = rules.some(
      (r) =>
        r.family === face.family &&
        r.style === face.style &&
        (Array.isArray(r.weight) ? face.weight >= r.weight[0] && face.weight <= r.weight[1] : r.weight === face.weight),
    );
    assert.ok(covered, `face not covered by any @font-face rule: ${JSON.stringify(face)}`);
  }
});

// -- T5: palette completeness ------------------------------------------------------------------

test('T5: every generator palette variable, plus --font-heading/--font-body/--muted/color-scheme, is declared in gloam\'s own :root', () => {
  // eslint-disable-next-line global-require
  const { generateThemeCSS } = require('gm-apprentice-publish/lib/theme');
  const GENERATOR_NAMES = [
    '--bg',
    '--text',
    '--accent',
    '--bg-header',
    '--bg-hero',
    '--bg-card',
    '--text-muted',
    '--border',
    '--accent-dim',
    '--text-on-header',
    '--text-muted-on-header',
  ];
  const EXPECTED = [...GENERATOR_NAMES, '--font-heading', '--font-body'];

  for (const bg of ['#1a1a1a', '#f5f0e6']) {
    const css = generateThemeCSS({
      palette: { background: bg, text: '#cccccc', accent: '#58a6ff', primary: '#0d1117' },
      fonts: { heading: 'Cinzel', body: 'Alegreya' },
    });
    const names = [...css.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]);
    assert.deepEqual(names.slice().sort(), EXPECTED.slice().sort(), `pin var set mismatch for background ${bg}`);
  }

  const rootBlock = ownCss().match(/:root\s*\{([\s\S]*?)\n\}/)[1];
  for (const name of [...EXPECTED, '--muted', 'color-scheme']) {
    assert.match(rootBlock, new RegExp(`(?:^|\\s)${name}\\s*:`), `${name} must be declared in gloam's own :root`);
  }
});

// -- T6 ------------------------------------------------------------------------------------------

test('T6: --font-heading and --font-body name the vendored families first', () => {
  const css = ownCss();
  assert.match(css, /--font-heading:\s*'IM Fell English', Georgia, serif;/);
  assert.match(css, /--font-body:\s*'Cormorant Garamond', Georgia, serif;/);
});

// -- T7: colour discipline (H10/H11 analogue) on gloam's OWN file ------------------------------

test('T7: colour discipline -- no raw hex except #000/#fff inside color-mix(in srgb, ...); no rgba/hsl/etc; no named colours; every --sc-base-* is one #rrggbb; declared/used parity', () => {
  const css = ownCss();
  let disciplined = stripComments(css);
  disciplined = disciplined.replace(/--sc-base-[a-z-]+:\s*[^;]+;/g, (decl) => decl.replace(/:\s*[^;]+;/, ': TOKEN;'));

  // Extract every balanced color-mix(in srgb, ...) call (paren-depth aware, so a var(--x) call
  // nested inside one doesn't truncate it early), mask them all out of the text, then: (a) the
  // masked remainder must have zero raw hex literals at all, and (b) any hex literal found
  // *inside* a call must be #000 or #fff -- it may be either argument, not only the first.
  const calls = [];
  let scanFrom = 0;
  for (;;) {
    const markerIdx = disciplined.indexOf('color-mix(in srgb,', scanFrom);
    if (markerIdx === -1) break;
    const openParen = disciplined.indexOf('(', markerIdx);
    let depth = 1;
    let j = openParen + 1;
    while (j < disciplined.length && depth > 0) {
      if (disciplined[j] === '(') depth++;
      else if (disciplined[j] === ')') depth--;
      j++;
    }
    calls.push(disciplined.slice(markerIdx, j));
    scanFrom = j;
  }
  for (const call of calls) {
    for (const m of call.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      assert.ok(m[0] === '#000' || m[0] === '#fff', `unexpected hex literal ${m[0]} inside ${call}`);
    }
  }
  let outside = disciplined;
  for (const call of calls) outside = outside.replace(call, 'COLOR_MIX_CALL');
  for (const m of outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    assert.fail(`hex literal ${m[0]} found outside any color-mix(in srgb, ...) call`);
  }

  assert.doesNotMatch(disciplined, /\brgba?\(/);
  assert.doesNotMatch(disciplined, /\bhsla?\(/);
  assert.doesNotMatch(disciplined, /\bhwb\(/);
  assert.doesNotMatch(disciplined, /\blab\(/);
  assert.doesNotMatch(disciplined, /\blch\(/);
  assert.doesNotMatch(disciplined, /\boklab\(/);
  assert.doesNotMatch(disciplined, /\boklch\(/);

  const NAMED_COLOURS = ['red', 'blue', 'green', 'black', 'white', 'yellow', 'orange', 'purple', 'gold', 'silver', 'brown'];
  for (const name of NAMED_COLOURS) {
    assert.doesNotMatch(disciplined, new RegExp(`:\\s*${name}\\b`), `named colour "${name}" used in value position`);
  }

  const stripped = stripComments(css);
  for (const m of stripped.matchAll(/--sc-base-[a-z0-9-]+:\s*([^;]+);/g)) {
    assert.match(m[1].trim(), /^#[0-9a-fA-F]{6}$/, `--sc-base-* value "${m[1]}" is not a single #rrggbb literal`);
  }

  const declared = new Set([...stripped.matchAll(/--sc-base-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...stripped.matchAll(/var\(--sc-base-([a-z0-9-]+)\)/g)].map((m) => m[1]));
  assert.equal(declared.size, 16, 'expected 6 anchors + 10 pill tokens');
  for (const u of used) assert.ok(declared.has(u), `var(--sc-base-${u}) has no matching declaration`);
  for (const d of declared) assert.ok(used.has(d), `--sc-base-${d} is declared but never consumed`);
});

// -- T8: knobs -------------------------------------------------------------------------------

test('T8: the 8 knobs are declared with Part A\'s literal defaults, and each is consumed by a var()', () => {
  const css = ownCss();
  const KNOBS = {
    '--sc-ground-size': 'cover',
    '--sc-ground-position': '50% 0',
    '--sc-ground-filter': 'saturate(0.45) brightness(0.3) contrast(1.05)',
    '--sc-ground-opacity': '0.6',
    '--sc-ground-fade-from': '52%',
    '--sc-ground-fade-to': '84%',
    '--sc-hero-filter': 'sepia(0.35) hue-rotate(212deg) saturate(0.8) brightness(0.6) contrast(1.1)',
    '--sc-hero-position': '50% 50%',
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [name, value] of Object.entries(KNOBS)) {
    assert.match(css, new RegExp(`${escapeRe(name)}:\\s*${escapeRe(value)};`), `${name} must equal its literal default`);
    assert.match(css, new RegExp(`var\\(${escapeRe(name)}\\)`), `${name} must be consumed by a var()`);
  }
});

// -- T9: SD-7 fallback strings, literally ------------------------------------------------------

test('T9: the SD-7 fallback strings appear literally', () => {
  const css = ownCss();
  assert.ok(css.includes('var(--sc-img-404, var(--sc-img-hero, none))'));
  assert.ok(css.includes('var(--sc-img-ground, none)'));
  assert.ok(css.includes('var(--sc-img-paper, none)'));
});

// -- T10: roster ------------------------------------------------------------------------------

function pcRosterBlocks(css) {
  const stripped = stripComments(css);
  const out = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(stripped))) {
    if (m[1].trim().endsWith('.pc-roster')) out.push(m[2]);
  }
  return out;
}

test('T10: gloam has the auto-fill roster rule; haze\'s own .pc-roster rules have no grid-template-columns', () => {
  const gloamBlocks = pcRosterBlocks(ownCss());
  assert.ok(gloamBlocks.some((b) => /grid-template-columns:\s*repeat\(auto-fill/.test(b)));

  const hazeBlocks = pcRosterBlocks(fs.readFileSync(HAZE_CSS_PATH, 'utf8'));
  assert.ok(hazeBlocks.length > 0, 'expected at least one .pc-roster rule in haze');
  for (const b of hazeBlocks) assert.doesNotMatch(b, /grid-template-columns/);
});

// -- T11: editorial hides stay out ---------------------------------------------------------------

function hasForbiddenSelector(css, forbidden) {
  const stripped = stripComments(css);
  const ruleRe = /([^{}]+)\{[^{}]*\}/g;
  let m;
  while ((m = ruleRe.exec(stripped))) {
    if (forbidden.some((f) => m[1].includes(f))) return true;
  }
  return false;
}

test('T11: no gloam rule targets the editorial-hide selectors (E1/E2 stay in the campaign layer); positive control', () => {
  const FORBIDDEN = ['.badge-draft', '.badge-stub', '.threat-badge', '[data-field="status"]', '[data-field="session_number"]'];
  assert.equal(hasForbiddenSelector(ownCss(), FORBIDDEN), false);
  assert.equal(hasForbiddenSelector('.badge-draft { display: none; }', FORBIDDEN), true, 'positive control must fire');
});

// -- T12 --------------------------------------------------------------------------------------

test('T12a: the composed CSS contains haze\'s reduced-motion block', () => {
  assert.match(loadTheme('gloam').css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('T12b: gloam\'s own file declares no animation or transition', () => {
  const stripped = stripComments(ownCss());
  assert.doesNotMatch(stripped, /\banimation\s*:/);
  assert.doesNotMatch(stripped, /\btransition\s*:/);
});

test('T12c: paper drift guard -- gloam\'s last two paper background layers restate assets/site/scriptorium.css\'s own leaf background, whitespace-normalised', () => {
  const LAYER_TEXT =
    'linear-gradient(to right, color-mix(in srgb, #000 34%, transparent), transparent 6%), ' +
    'radial-gradient(120% 70% at 50% 0%, var(--sc-leaf-paper-hi), var(--sc-leaf-paper) 62%)';
  const gloamCss = ownCss();
  const scriptoriumCss = fs.readFileSync(SCRIPTORIUM_CSS_PATH, 'utf8');
  assert.ok(normalizeWs(gloamCss).includes(normalizeWs(LAYER_TEXT)), "gloam's paper rule must restate the product leaf background");
  assert.ok(normalizeWs(scriptoriumCss).includes(normalizeWs(LAYER_TEXT)), 'drift guard: scriptorium.css must still contain the same leaf background');
});

test('T12d (SD-11): the word "gloam" appears in no emitted file -- composed CSS or the theme NOTICE.txt', () => {
  assert.doesNotMatch(loadTheme('gloam').css, /\bgloam\b/i);
  assert.doesNotMatch(fs.readFileSync(NOTICE_PATH, 'utf8'), /\bgloam\b/i);
});

// -- T15: theme NOTICE.txt content --------------------------------------------------------------

test('T15: NOTICE.txt first two lines are exact; carries each family\'s copyright, RFN, file names and full OFL text', () => {
  const notice = fs.readFileSync(NOTICE_PATH, 'utf8');
  const lines = notice.split('\n');
  assert.equal(lines[0], '');
  assert.equal(lines[1], '-'.repeat(70));

  const m = manifest();
  for (const family of m.families) {
    assert.ok(notice.includes(family.copyright), `missing copyright line for ${family.family}`);
    assert.ok(notice.includes(`Reserved Font Name: ${family.reservedFontName}`), `missing RFN line for ${family.family}`);
    const licenseText = fs
      .readFileSync(path.join(__dirname, '..', 'scripts', 'vendor', 'fonts', family.licenseFile), 'utf8')
      .trimEnd();
    assert.ok(notice.includes(licenseText), `missing full OFL text for ${family.family}`);
  }
  for (const f of m.files) {
    assert.ok(notice.includes(f.file), `missing vendored file name ${f.file}`);
  }
});

// ==== T13/T14: real builds ========================================================================
// Copied from test/theme-haze.test.js (itself copied from test/theme-build.test.js:70-108), per
// those files' own "helpers are copied, not imported" convention.

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-gloam-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildThemeVault(root, opts = {}) {
  const { excludeDirs = [], folderMap = { NPCs: 'npcs' }, publishExcludeDirs = [], convention = true, campaign = 'alpha' } = opts;

  const vaultPath = path.join(root, 'vault');
  fs.mkdirSync(path.join(vaultPath, 'NPCs'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_attachments'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });

  const publishBlock = publishExcludeDirs.length
    ? `  exclude_dirs:\n${publishExcludeDirs.map((d) => `    - ${d}`).join('\n')}\n`
    : '';
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    `---\ntype: meta\npublish:\n  mode: player\n${publishBlock}---\n\n# Vault config\n`,
  );
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'publish-manifest.md'),
    '---\ntype: meta\n---\n\n# Publish manifest\n\n## Publishing\n\n- [x] NPCs/Public.md\n',
  );
  fs.writeFileSync(path.join(vaultPath, 'NPCs', 'Public.md'), '---\ntype: npc\ntitle: Public Page\n---\nAn ordinary published page.\n');
  fs.writeFileSync(path.join(vaultPath, '_attachments', 'ground.webp'), Buffer.from('ground-image-bytes'));

  const siteDir = convention ? path.join(vaultPath, '_meta', 'scriptorium') : path.join(root, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const jsonConfig = { siteTitle: 'Theme Vault', siteUrl: 'https://example.invalid', attachmentsDir: '_attachments', excludeDirs, folderMap };
  fs.writeFileSync(path.join(siteDir, 'vault.config.json'), JSON.stringify(jsonConfig, null, 2));

  const finalOut = path.join(root, 'out');
  return { vaultPath, siteDir, jsonConfig, finalOut, campaign };
}

function writeConfigToml(root, { vaultPath, finalOut, campaign = 'alpha', siteConfig }) {
  const configPath = path.join(root, 'config.toml');
  const lines = ['config_version = 1', `default_campaign = "${campaign}"`, '', `[campaigns.${campaign}]`, `vault = '${vaultPath}'`];
  if (siteConfig) lines.push(`site_config = '${siteConfig}'`);
  lines.push(`output = '${finalOut}'`, '');
  fs.writeFileSync(configPath, lines.join('\n'));
  return configPath;
}

function writePackToml(siteDir, text) {
  fs.writeFileSync(path.join(siteDir, 'pack.toml'), text);
}

// -- T13 --------------------------------------------------------------------------------------

test('T13a: a real gloam build copies each font file byte-equal to its source', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "gloam"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);

    const theme = loadTheme('gloam');
    assert.ok(theme.fonts.length > 0);
    for (const font of theme.fonts) {
      const built = fs.readFileSync(path.join(finalOut, 'scriptorium', 'theme', 'fonts', font.rel));
      const source = fs.readFileSync(font.abs);
      assert.deepEqual(built, source, `${font.rel} must be byte-equal to its source`);
    }
  });
});

test('T13b: css/scriptorium-theme.css equals the T2 oracle plus the slot block, when a slot is set', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "gloam"\n[images]\nground = "vault:_attachments/ground.webp"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);

    const cssPath = path.join(finalOut, 'css', 'scriptorium-theme.css');
    const expected = `${loadTheme('gloam').css}\n:root {\n  --sc-img-ground: url("../scriptorium/slots/ground.webp");\n}\n`;
    assert.equal(fs.readFileSync(cssPath, 'utf8'), expected);
  });
});

test('T13c: a slotless gloam build\'s theme CSS equals the composed CSS bytes exactly', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "gloam"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);

    const cssPath = path.join(finalOut, 'css', 'scriptorium-theme.css');
    assert.equal(fs.readFileSync(cssPath, 'utf8'), loadTheme('gloam').css);
  });
});

test('T13d: NOTICE.txt equals buildNoticeText({searchEnabled}) plus the theme NOTICE.txt bytes', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "gloam"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);

    const searchEnabled = jsonConfig.searchEnabled !== false;
    const expected = buildNoticeText({ searchEnabled }) + loadTheme('gloam').notice;
    assert.equal(fs.readFileSync(path.join(finalOut, 'NOTICE.txt'), 'utf8'), expected);
  });
});

test('T13e (issue #84): a haze build\'s NOTICE.txt equals buildNoticeText plus the haze theme NOTICE.txt bytes, and its font files are copied into the site', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "haze"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);

    const searchEnabled = jsonConfig.searchEnabled !== false;
    assert.equal(fs.readFileSync(path.join(finalOut, 'NOTICE.txt'), 'utf8'), buildNoticeText({ searchEnabled }) + loadTheme('haze').notice);
    for (const f of loadTheme('haze').fonts) {
      assert.ok(fs.readFileSync(path.join(finalOut, 'scriptorium', 'theme', 'fonts', f.rel)).equals(fs.readFileSync(f.abs)), f.rel);
    }
  });
});

// -- T14 --------------------------------------------------------------------------------------

test('T14a (H9 analogue): a gloam build with a withheld invented NPC gives exit OK and 0 output-scan findings', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, finalOut } = buildThemeVault(root);
    fs.writeFileSync(
      path.join(vaultPath, 'NPCs', 'Withheld-Synth.md'),
      '---\ntype: npc\ntitle: Withheld Synthetic Fixture\nwithheld: true\n---\nNever meant to reach a player.\n',
    );
    writePackToml(siteDir, 'theme = "gloam"\n[images]\nground = "vault:_attachments/ground.webp"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(result.envelope.refusedByScan, false);
    assert.deepEqual(result.envelope.outputScan.findings, []);
  });
});

const T14_WITHHELD_NAME = 'Quiet Keeper';

test('T14b (B8 analogue): a pack slot SVG carrying an invented withheld name still fires the output-leak scan under gloam', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, finalOut } = buildThemeVault(root);
    fs.writeFileSync(
      path.join(vaultPath, 'NPCs', 'Quiet-Keeper.md'),
      `---\ntype: npc\ntitle: ${T14_WITHHELD_NAME}\nwithheld: true\n---\nNever meant to reach a player.\n`,
    );
    fs.mkdirSync(path.join(siteDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'images', 'hero.svg'), `<svg><text>${T14_WITHHELD_NAME}</text></svg>`);
    writePackToml(siteDir, 'theme = "gloam"\n[images]\nhero = "images/hero.svg"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.equal(result.envelope.refusedByScan, true);
    const findings = result.envelope.outputScanFindings;
    assert.ok(findings.some((f) => f.outputPath === 'scriptorium/slots/hero.svg'));
  });
});

// -- T16 (AC-12): ADR 0032's own literal word/path list, cross-checked against the built CSS ----

const ADR_0032_PATH = path.join(__dirname, '..', 'docs', 'decisions', '0032-base-theme.md');

test('T16: ADR 0032 names every --sc-base-*, --sc-img-* and knob variable, every font file, family and format literally, and each one is real', () => {
  const adr = fs.readFileSync(ADR_0032_PATH, 'utf8');
  const css = ownCss();

  const scBaseNames = [...new Set(css.match(/--sc-base-[a-z-]+/g))];
  const scImgNames = [...new Set(css.match(/--sc-img-[a-z0-9-]+/g))];
  const knobNames = [...new Set(css.match(/--sc-(?:ground|hero)-[a-z-]+/g))];
  assert.equal(scBaseNames.length, 16, 'fixture drift: gloam is expected to declare 16 --sc-base-* variables');
  assert.equal(scImgNames.length, 4, 'fixture drift: gloam is expected to declare 4 --sc-img-* fallbacks');
  assert.equal(knobNames.length, 8, 'fixture drift: gloam is expected to declare 8 ground/hero knobs');

  for (const name of [...scBaseNames, ...scImgNames, ...knobNames]) {
    assert.ok(adr.includes(name), `ADR 0032 must name the literal ${name}`);
  }

  const m = manifest();
  for (const f of m.files) {
    assert.ok(adr.includes(f.file), `ADR 0032 must name the shipped font path ${f.file}`);
    assert.ok(css.includes(f.file), `${f.file} must actually be a font src in theme.css`);
  }
  for (const family of ['IM Fell English', 'IM Fell English SC', 'Cormorant Garamond']) {
    assert.ok(adr.includes(family), `ADR 0032 must name the family ${family}`);
    assert.ok(css.includes(`'${family}'`), `${family} must actually be declared in theme.css`);
  }

  assert.ok(adr.includes('font-display: swap'), 'ADR 0032 must name the font-display: swap literal');
  assert.ok(adr.includes('format("woff2")'), 'ADR 0032 must name the actual format() value, woff2');
  assert.equal(css.match(/format\("truetype"\)/g), null, 'no @font-face may still claim truetype');
});
