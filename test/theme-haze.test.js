'use strict';

// P3b, S1 (B1) + S3 (B2): the built-in `haze` theme. Reads only assets/themes/haze/, except H8,
// which parses assets/site/scriptorium.css (the product file's own --sc-leaf/tl/on/cx-* default
// declarations). Helpers below are COPIED, not imported, per those files' own instruction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { THEMES, loadTheme } = require('../src/build/themes');
const { runBuildCommand } = require('../src/cli/build');
const { EXIT_CODES } = require('../src/util/exitcodes');

const THEME_DIR = path.join(__dirname, '..', 'assets', 'themes', 'haze');
const THEME_JSON_PATH = path.join(THEME_DIR, 'theme.json');
const THEME_CSS_PATH = path.join(THEME_DIR, 'theme.css');
const SCRIPTORIUM_CSS_PATH = path.join(__dirname, '..', 'assets', 'site', 'scriptorium.css');

function themeJson() {
  return JSON.parse(fs.readFileSync(THEME_JSON_PATH, 'utf8'));
}
function themeCss() {
  return fs.readFileSync(THEME_CSS_PATH, 'utf8');
}

// -- Copied from test/housestyle-story.test.js:28-145 ---------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractMediaBlocks(sec) {
  const blocks = [];
  let outside = '';
  let lastIndex = 0;
  const mediaRe = /@media\s*([^{]*)\{/g;
  let match;
  while ((match = mediaRe.exec(sec))) {
    outside += sec.slice(lastIndex, match.index);
    const bodyStart = mediaRe.lastIndex;
    let depth = 1;
    let j = bodyStart;
    while (depth > 0 && j < sec.length) {
      if (sec[j] === '{') depth++;
      else if (sec[j] === '}') depth--;
      j++;
    }
    blocks.push({ query: match[1].trim(), body: sec.slice(bodyStart, j - 1) });
    lastIndex = j;
    mediaRe.lastIndex = j;
  }
  outside += sec.slice(lastIndex);
  return { blocks, outside };
}

function splitTopLevelCommas(str) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

// -- Copied from test/theme-build.test.js:70-108 ---------------------------------------------

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-haze-'));
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

function findHtmlFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) out.push(full);
    }
  })(dir);
  return out;
}

// -- H1 ----------------------------------------------------------------------------------------

test('H1: theme.json deepEquals the literal', () => {
  assert.deepEqual(themeJson(), { name: 'haze', scheme: 'dark', slots: [], fontsFrom: 'gloam' });
});

// -- H2 ----------------------------------------------------------------------------------------

test('H2: loadTheme("haze") shape; dir is assets/themes/haze, stated independently', () => {
  const expectedDir = path.join(__dirname, '..', 'assets', 'themes', 'haze');
  assert.equal(THEMES.haze.dir, expectedDir);
  const theme = loadTheme('haze');
  assert.equal(theme.name, 'haze');
  assert.equal(theme.dir, expectedDir);
  assert.equal(theme.scheme, 'dark');
  assert.deepEqual(theme.slots, []);
  assert.equal(theme.css, themeCss());
  assert.deepEqual(theme.images, []);
});

// -- H3 ----------------------------------------------------------------------------------------

test('H3 (issue #84): no @import at all; 5 self-hosted @font-face rules, every src a relative scriptorium/theme/fonts/ woff2 that exists on disk', () => {
  const stripped = stripComments(themeCss());
  assert.doesNotMatch(stripped, /@import/);
  const faces = stripped.match(/@font-face\s*\{[^}]*\}/g) || [];
  assert.equal(faces.length, 5);
  const families = faces.map((f) => /font-family:\s*'([^']+)'/.exec(f)[1]).sort();
  assert.deepEqual(families, ['Cormorant Garamond', 'Cormorant Garamond', 'IM Fell English', 'IM Fell English', 'IM Fell English SC']);
  for (const f of faces) {
    const m = /src:\s*url\("\.\.\/scriptorium\/theme\/fonts\/([A-Za-z0-9._-]+\.woff2)"\)\s*format\("woff2"\)/.exec(f);
    assert.ok(m, 'src must be a relative theme font url: ' + f);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'themes', 'gloam', 'fonts', m[1])), m[1] + ' must ship');
    assert.match(f, /font-display:\s*swap/);
    assert.match(f, /unicode-range:\s*U\+0000-00FF,/);
  }
});

// -- H4 ----------------------------------------------------------------------------------------

const SD3_ANCHORS = [
  '.landing-hero',
  '.dashboard-section',
  'body:has(> main.content > .landing-hero)',
  'main.content:has(> .landing-hero)',
  'html:has(.landing-hero)',
];
const H4_EXEMPT_SELECTORS = new Set([':root', '.pull-quote', '.pull-quote::before']);

/** Extracts top-level and @media-nested selectors, keyframe stops excluded (returned separately). */
function extractSelectors(css) {
  const stripped = stripComments(css);
  let noKeyframes = '';
  let i = 0;
  const kfRe = /@(?:-webkit-)?keyframes\s+[^{]+\{/g;
  let kfMatch;
  while ((kfMatch = kfRe.exec(stripped))) {
    noKeyframes += stripped.slice(i, kfMatch.index);
    let depth = 1;
    let j = kfRe.lastIndex;
    while (depth > 0 && j < stripped.length) {
      if (stripped[j] === '{') depth++;
      else if (stripped[j] === '}') depth--;
      j++;
    }
    i = j;
    kfRe.lastIndex = j;
  }
  noKeyframes += stripped.slice(i);

  const { blocks: mediaBlocks, outside } = extractMediaBlocks(noKeyframes);
  const out = [];
  const collect = (text) => {
    for (const m of text.matchAll(/([^{}]+)\{/g)) {
      const raw = m[1].trim();
      if (raw.startsWith('@')) continue;
      for (const sel of splitTopLevelCommas(raw)) {
        const trimmed = sel.trim().replace(/\s+/g, ' ');
        if (trimmed) out.push(trimmed);
      }
    }
  };
  collect(outside);
  for (const b of mediaBlocks) collect(b.body);
  return out;
}

test('H4: every non-exempt selector starts with one of the 5 SD-3 anchors', () => {
  const selectors = extractSelectors(themeCss());
  assert.ok(selectors.length > 20, 'sanity: many selectors extracted');
  for (const sel of selectors) {
    if (H4_EXEMPT_SELECTORS.has(sel)) continue;
    const ok = SD3_ANCHORS.some((a) => sel.startsWith(a));
    assert.ok(ok, `selector "${sel}" does not start with any SD-3 anchor`);
  }
});

// -- H5 ----------------------------------------------------------------------------------------

test('H5: no 100vw, no overflow-x', () => {
  const css = themeCss();
  assert.doesNotMatch(css, /100vw/);
  assert.doesNotMatch(css, /overflow-x/);
});

// -- H6 ----------------------------------------------------------------------------------------

test('H6: a prefers-reduced-motion block turns off .landing-hero > h1 and .landing-hero::before animation, no !important', () => {
  const css = themeCss();
  const { blocks } = extractMediaBlocks(stripComments(css));
  const reduced = blocks.find((b) => b.query.includes('prefers-reduced-motion') && b.query.includes('reduce'));
  assert.ok(reduced, 'expected an @media (prefers-reduced-motion: reduce) block');
  assert.match(reduced.body, /\.landing-hero\s*>\s*h1/);
  assert.match(reduced.body, /\.landing-hero::before/);
  assert.match(reduced.body, /animation:\s*none;/);
  assert.doesNotMatch(reduced.body, /!important/);
});

// -- H7 ----------------------------------------------------------------------------------------

test('H7: !important appears only in .dashboard-section h2 span[style]', () => {
  const css = stripComments(themeCss());
  const lines = css.split('\n');
  const importantLines = lines.filter((l) => l.includes('!important'));
  assert.ok(importantLines.length > 0, 'sanity: at least one !important exists');
  // Find the enclosing rule for each !important declaration by scanning backwards for the last
  // unmatched selector header before it.
  for (const line of importantLines) {
    assert.match(line, /font-size:\s*18px\s*!important;/);
  }
  // And structurally: the only rule with `!important` anywhere in its body is that one selector.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  const offenders = [];
  while ((m = ruleRe.exec(css))) {
    const [, header, body] = m;
    if (body.includes('!important') && header.trim() !== '.dashboard-section h2 span[style]') {
      offenders.push(header.trim());
    }
  }
  assert.deepEqual(offenders, []);
});

// -- H8 ----------------------------------------------------------------------------------------

test('H8: scriptorium.css declares exactly 34 --sc-leaf/tl/on/cx-* names, each declared in the theme', () => {
  const productCss = fs.readFileSync(SCRIPTORIUM_CSS_PATH, 'utf8');
  const names = new Set();
  for (const m of productCss.matchAll(/^\s*(--sc-(?:leaf|tl|on|cx)-[a-z0-9-]+)\s*:/gm)) {
    names.add(m[1]);
  }
  assert.equal(names.size, 34);

  const themeNames = new Set();
  for (const m of themeCss().matchAll(/(--sc-(?:leaf|tl|on|cx)-[a-z0-9-]+)\s*:/g)) {
    themeNames.add(m[1]);
  }
  for (const name of names) {
    assert.ok(themeNames.has(name), `${name} is declared in scriptorium.css but not in the theme`);
  }
});

// -- H9 ----------------------------------------------------------------------------------------

test('H9: a synthetic haze build with a ground slot and a withheld NPC: OK, unscanned-clean, exact CSS, one theme link per page', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, jsonConfig, finalOut } = buildThemeVault(root);
    fs.writeFileSync(
      path.join(vaultPath, 'NPCs', 'Withheld-Synth.md'),
      '---\ntype: npc\ntitle: Withheld Synthetic Fixture\nwithheld: true\n---\nNever meant to reach a player.\n',
    );
    writePackToml(siteDir, 'theme = "haze"\n[images]\nground = "vault:_attachments/ground.webp"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(result.envelope.refusedByScan, false);
    assert.deepEqual(result.envelope.outputScan.findings, []);

    const cssPath = path.join(finalOut, 'css', 'scriptorium-theme.css');
    const expectedWithSlot = `${themeCss()}\n:root {\n  --sc-img-ground: url("../scriptorium/slots/ground.webp");\n}\n`;
    assert.equal(fs.readFileSync(cssPath, 'utf8'), expectedWithSlot);

    const htmlFiles = findHtmlFiles(finalOut);
    assert.ok(htmlFiles.length > 0);
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      if (!html.includes('data-scriptorium-housestyle')) continue;
      const themeMatches = html.match(/data-scriptorium-theme/g) || [];
      assert.equal(themeMatches.length, 1, `${file}: exactly one theme link`);
    }
    void jsonConfig;
  });
});

test('H9b: the slotless variant equals the theme.css bytes exactly', () => {
  withScratchDir((root) => {
    const { vaultPath, siteDir, finalOut } = buildThemeVault(root);
    writePackToml(siteDir, 'theme = "haze"\n');
    const configPath = writeConfigToml(root, { vaultPath, finalOut });

    const result = runBuildCommand({ config: configPath, 'no-check': true }, 'alpha');
    assert.equal(result.exitCode, EXIT_CODES.OK);

    const cssPath = path.join(finalOut, 'css', 'scriptorium-theme.css');
    assert.equal(fs.readFileSync(cssPath, 'utf8'), themeCss());
  });
});

// ==== S3 (B2): colour discipline =================================================================

/** Strips comments, data-URI art, and every --sc-th-*: declaration's own value. */
function colourDisciplineText(css) {
  let t = stripComments(css);
  t = t.replace(/url\("data:[^"]*"\)/g, 'URL_DATA');
  t = t.replace(/--sc-th-[a-z0-9-]+:\s*[^;]+;/g, (decl) => decl.replace(/:\s*[^;]+;/, ': TOKEN;'));
  return t;
}

test('H10: colour discipline -- no raw hex except #000/#fff inside color-mix(in srgb, ...); no rgba/hsl/etc; no named colours but transparent/currentColor; every --sc-th-* value is one #rrggbb', () => {
  const css = themeCss();
  const disciplined = colourDisciplineText(css);

  for (const m of disciplined.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const hex = m[0];
    assert.ok(hex === '#000' || hex === '#fff', `unexpected hex literal ${hex}`);
    const before = disciplined.slice(Math.max(0, m.index - 40), m.index);
    assert.match(before, /color-mix\(\s*in\s+srgb,\s*$/, `${hex} must sit directly inside color-mix(in srgb, ...)`);
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
    const re = new RegExp(`:\\s*${name}\\b`);
    assert.doesNotMatch(disciplined, re, `named colour "${name}" used in value position`);
  }

  const stripped = stripComments(css).replace(/url\("data:[^"]*"\)/g, 'URL_DATA');
  for (const m of stripped.matchAll(/--sc-th-[a-z0-9-]+:\s*([^;]+);/g)) {
    assert.match(m[1].trim(), /^#[0-9a-fA-F]{6}$/, `--sc-th-* value "${m[1]}" is not a single #rrggbb literal`);
  }
});

// ==== S3 (B2): token declared/used parity ========================================================

test('H11: every var(--sc-th-X) is declared, and every declared --sc-th-X is used', () => {
  const css = stripComments(themeCss()).replace(/url\("data:[^"]*"\)/g, 'URL_DATA');
  const declared = new Set([...css.matchAll(/--sc-th-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\(--sc-th-([a-z0-9-]+)\)/g)].map((m) => m[1]));
  for (const u of used) assert.ok(declared.has(u), `var(--sc-th-${u}) has no matching declaration`);
  for (const d of declared) assert.ok(used.has(d), `--sc-th-${d} is declared but never consumed`);
});

// ==== S3 (B2): token block ordering ===============================================================

test('H12: every custom-property-only block (the Tokens block, T2, T11, T12) comes before the first non-custom-property rule', () => {
  const css = stripComments(themeCss()).replace(/url\("data:[^"]*"\)/g, 'URL_DATA');
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let firstNonCustomIndex = -1;
  let lastCustomOnlyIndex = -1;
  let m;
  while ((m = ruleRe.exec(css))) {
    if (/^\s*@font-face\s*$/.test(m[1])) continue; // self-hosted faces (issue #84) carry no custom properties
    const body = m[2];
    const decls = body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
    if (decls.length === 0) continue;
    const allCustom = decls.every((d) => d.startsWith('--'));
    if (allCustom) {
      lastCustomOnlyIndex = m.index;
    } else if (firstNonCustomIndex === -1) {
      firstNonCustomIndex = m.index;
    }
  }
  assert.ok(firstNonCustomIndex !== -1, 'expected at least one non-custom-property rule');
  assert.ok(lastCustomOnlyIndex !== -1, 'expected at least one custom-property-only block');
  assert.ok(
    lastCustomOnlyIndex < firstNonCustomIndex,
    'a custom-property-only block appears after the first non-custom-property rule',
  );
});
