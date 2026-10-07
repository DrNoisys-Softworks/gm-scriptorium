'use strict';

// The sample campaign in examples/the-long-lease/ is a test fixture (S5 Engineering Brief, SD-8):
// this file pins what the sample is for, not its bytes. Vector-only scope (Amendment A.5): the
// painted art (G1-G19) lands in a later commit, so ART/BANNERS/SLOTS below hold only the rows
// that exist today. Helpers below (withScratchDir, buildThemeVault-style config writers) follow
// test/theme-gloam.test.js:376-427's "copied, not imported" convention.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runBuildCommand } = require('../src/cli/build');
const { runCheckCommand } = require('../src/cli/check');
const { EXIT_CODES } = require('../src/util/exitcodes');
const { unresolvedCssUrls } = require('./css-urls');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');

// -- Literal tables (never derived from the code under test) -----------------------------------

// Every image copied into a built site's images/ folder today. Portraits are 200x280 (5:7),
// sigils 240x300 (4:5); the campaign banner doubles as the landing's campaign_image at 1200x500;
// the three new vector pieces (Fair Terms, Orpiment's Scale, the Tally Cliffs) are this commit's
// own art.
const PORTRAIT_NAMES = [
  'beatrix-holloway',
  'clemency-vare',
  'emlyn-crewe',
  'gammer-tansy-holt',
  'idony-marrable',
  'iveth-ammerly',
  'jory-penwarden',
  'kit-farrow',
  'mags-threlkeld',
  'odda-quarrel',
  'orpiment',
  'oswy-hebden',
  'queen-hesper',
  'queen-maudry',
  'sir-ivo-latchford',
  'wystan-pye',
];
const SIGIL_NAMES = ['marigold-court', 'marrable-and-daughters', 'sealwrights'];

const ART = [
  ...PORTRAIT_NAMES.map((name) => ({
    out: path.join('images', 'portraits', `${name}.svg`),
    width: 200,
    height: 280,
    format: 'svg',
  })),
  ...SIGIL_NAMES.map((name) => ({
    out: path.join('images', 'sigils', `${name}.svg`),
    width: 240,
    height: 300,
    format: 'svg',
  })),
  { out: path.join('images', 'long-lease-banner.svg'), width: 1200, height: 500, format: 'svg' },
  { out: path.join('images', 'items', 'fair-terms-wide.svg'), width: 1200, height: 300, format: 'svg' },
  { out: path.join('images', 'items', 'orpiments-scale-token.svg'), width: 512, height: 512, format: 'svg' },
  { out: path.join('images', 'locations', 'tally-cliffs-wide.svg'), width: 1800, height: 600, format: 'svg' },
];

// Every output page examples/README.md names, plus 404.html (Interfaces and contracts).
const PAGES = [
  'index.html',
  path.join('locations', 'index.html'),
  path.join('factions', 'marigold-court.html'),
  path.join('items', 'fair-terms.html'),
  path.join('items', 'orpiments-scale.html'),
  path.join('locations', 'the-tally-cliffs.html'),
  '404.html',
];

// Section directories carrying an inline <figure class="section-banner"> today. Only `locations`
// (B2, the chart with its live links): the rest wait on painted banners in a later commit.
const BANNERS = ['locations'];
const NO_BANNER_SECTIONS = ['events'];

// Every `publish.banners.*` entry's own source SVG (_meta/vault-config.md), by section directory.
// The vendored lib/banners.js:83-85 inlines this file's bytes verbatim into the built page, with
// no injection point for the configured `alt` text, so role="img"/aria-label must live on the
// source SVG's own root <svg> (E0 below).
const BANNER_SVG_PATHS = {
  locations: path.join('_attachments', 'charts', 'vale-of-quillet.svg'),
};

const SLOTS = ['hero', 'ground', 'paper', '404'];

// -- Local helpers -------------------------------------------------------------------------------

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-example-build-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfigToml(root, { vaultPath, finalOut, campaign = 'lease' }) {
  const configPath = path.join(root, 'config.toml');
  const lines = [
    'config_version = 1',
    `default_campaign = "${campaign}"`,
    '',
    `[campaigns.${campaign}]`,
    `vault = '${vaultPath}'`,
    `output = '${finalOut}'`,
    '',
  ];
  fs.writeFileSync(configPath, lines.join('\n'));
  return configPath;
}

/**
 * PNG IHDR, JPEG SOF0/SOF2, or an SVG root's width/height attributes. Width/height are read
 * independently of attribute order (D1: a swapped read must go red on every non-square entry).
 */
function imageSize(buf, ext) {
  if (ext === 'svg') {
    const text = buf.toString('utf8');
    const tagMatch = /<svg\b[^>]*>/i.exec(text);
    if (!tagMatch) throw new Error('imageSize: no <svg> root element found');
    const tag = tagMatch[0];
    const w = /\swidth="(\d+(?:\.\d+)?)"/i.exec(tag);
    const h = /\sheight="(\d+(?:\.\d+)?)"/i.exec(tag);
    if (!w || !h) throw new Error('imageSize: <svg> root is missing width or height');
    return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
  }
  if (ext === 'png') {
    if (buf.length < 24 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
      throw new Error('imageSize: not a PNG signature');
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('imageSize: not a JPEG SOI');
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        i += 2;
        continue;
      }
      const length = buf.readUInt16BE(i + 2);
      const isSof = marker === 0xc0 || marker === 0xc2;
      if (isSof) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { width, height };
      }
      i += 2 + length;
    }
    throw new Error('imageSize: no SOF0/SOF2 segment found');
  }
  throw new Error(`imageSize: unsupported extension "${ext}"`);
}

function extOf(p) {
  return path.extname(p).slice(1).toLowerCase();
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function hashTree(root) {
  const map = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) map[path.relative(root, p)] = sha256File(p);
    }
  }
  walk(root);
  return map;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function findHtmlFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && p.endsWith('.html')) out.push(path.relative(root, p));
    }
  }
  walk(root);
  return out.sort();
}

function containsNul(buf) {
  return buf.includes(0);
}

function crlfifyTree(root) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      const buf = fs.readFileSync(p);
      if (containsNul(buf)) continue;
      const text = buf.toString('utf8');
      const converted = text.replace(/\r\n|\r|\n/g, '\r\n');
      fs.writeFileSync(p, converted);
    }
  }
  walk(root);
}

// Checked before anything else in this file touches the filesystem, so a missing sample fails
// on a clear assertion rather than a raw ENOENT from inside a later helper.
const SAMPLE_EXISTS = fs.existsSync(SAMPLE);

test('the sample vault exists at examples/the-long-lease', () => {
  assert.ok(SAMPLE_EXISTS, `expected a sample vault at ${SAMPLE}`);
});

// Captured before any test in this file builds anything, compared again at the very end (E7).
const sampleHashBefore = SAMPLE_EXISTS ? hashTree(SAMPLE) : null;

function runBuild(root, vaultPath) {
  const finalOut = path.join(root, 'out');
  const configPath = writeConfigToml(root, { vaultPath, finalOut });
  const result = runBuildCommand({ config: configPath }, 'lease');
  return { result, finalOut, configPath };
}

// -- E0: static guards on the committed folder ---------------------------------------------------

test('E0: no SVG under examples/ contains a forbidden element, attribute, or bad href', () => {
  const forbidden = /<script|<style|<foreignObject|<image\s|<text|on[a-z]+\s*=/i;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.toLowerCase().endsWith('.svg')) continue;
      const text = fs.readFileSync(p, 'utf8');
      assert.ok(!forbidden.test(text), `${p} contains forbidden SVG content`);
      for (const hrefMatch of text.matchAll(/(?:xlink:)?href="([^"]*)"/g)) {
        const target = hrefMatch[1];
        assert.ok(
          target.startsWith('#') || /^[\w.-]+\.html$/.test(target),
          `${p} has a href that is neither a fragment nor a relative *.html: ${target}`,
        );
      }
      const tagMatch = /<svg\b[^>]*>/.exec(text);
      assert.ok(tagMatch, `${p} has no <svg> root`);
      const w = /\swidth="(\d+)"/.exec(tagMatch[0]);
      const h = /\sheight="(\d+)"/.exec(tagMatch[0]);
      const vb = /\sviewBox="0 0 (\d+) (\d+)"/.exec(tagMatch[0]);
      assert.ok(w && h && vb, `${p}'s root <svg> is missing an integer width/height/viewBox`);
      assert.equal(w[1], vb[1], `${p}: width does not match viewBox`);
      assert.equal(h[1], vb[2], `${p}: height does not match viewBox`);
    }
  }
  walk(SAMPLE);
});

test('E0: every publish.banners.* SVG carries role="img" and a non-empty aria-label', () => {
  for (const [dir, rel] of Object.entries(BANNER_SVG_PATHS)) {
    const p = path.join(SAMPLE, rel);
    const text = fs.readFileSync(p, 'utf8');
    const tagMatch = /<svg\b[^>]*>/.exec(text);
    assert.ok(tagMatch, `${rel} has no <svg> root`);
    assert.match(tagMatch[0], /\srole="img"/, `${dir}'s banner SVG (${rel}) is missing role="img"`);
    const label = /\saria-label="([^"]*)"/.exec(tagMatch[0]);
    assert.ok(label, `${dir}'s banner SVG (${rel}) is missing aria-label`);
    assert.ok(label[1].trim().length > 0, `${dir}'s banner SVG (${rel}) has an empty aria-label`);
  }
});

test('E0: no siteUrl key in vault.config.json', () => {
  const config = JSON.parse(fs.readFileSync(path.join(SAMPLE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
  assert.equal('siteUrl' in config, false);
});

test('E0: fonts are generic in vault-config.md', () => {
  const text = fs.readFileSync(path.join(SAMPLE, '_meta', 'vault-config.md'), 'utf8');
  assert.match(text, /heading:\s*"serif"/);
  assert.match(text, /body:\s*"serif"/);
});

test('E0: overrides.css has no .hero-tagline or .hero-dates selector (the old #47 workaround is gone)', () => {
  const css = fs.readFileSync(path.join(SAMPLE, '_meta', 'scriptorium', 'css', 'overrides.css'), 'utf8');
  assert.ok(!css.includes('.hero-tagline'));
  assert.ok(!css.includes('.hero-dates'));
});

test('E0: every basename under _attachments/ is unique', () => {
  const basenames = new Map();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else basenames.set(entry.name, (basenames.get(entry.name) || 0) + 1);
    }
  }
  walk(path.join(SAMPLE, '_attachments'));
  const dupes = [...basenames.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(dupes, []);
});

// -- E1: check -------------------------------------------------------------------------------

test('E1: check gives exitCode OK, counts.error 0, counts.warn 0', () => {
  withScratchDir((root) => {
    const finalOut = path.join(root, 'out');
    const configPath = writeConfigToml(root, { vaultPath: SAMPLE, finalOut });
    const result = runCheckCommand({ config: configPath }, 'lease');
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(result.envelope.counts.error, 0);
    assert.equal(result.envelope.counts.warn, 0);
  });
});

// -- E2: build ----------------------------------------------------------------------------------

test('E2: build exits OK; every PAGES entry exists; the withheld NPC never appears', () => {
  withScratchDir((root) => {
    const { result, finalOut } = runBuild(root, SAMPLE);
    assert.equal(result.exitCode, EXIT_CODES.OK);

    for (const page of PAGES) {
      assert.ok(fs.existsSync(path.join(finalOut, page)), `missing output page: ${page}`);
    }

    assert.equal(fs.existsSync(path.join(finalOut, 'characters', 'npcs', 'ottoline-pardew.html')), false);
    assert.equal(fs.existsSync(path.join(finalOut, 'images', 'portraits', 'ottoline-pardew.svg')), false);

    for (const rel of findHtmlFiles(finalOut)) {
      const text = fs.readFileSync(path.join(finalOut, rel), 'utf8');
      assert.ok(!/ottoline/i.test(text), `"Ottoline" leaked into ${rel}`);
      assert.ok(!/pardew/i.test(text), `"Pardew" leaked into ${rel}`);
    }
  });
});

// -- E3: art ------------------------------------------------------------------------------------

test('E3: every ART output exists, is byte-equal to its source, and has the literal size', () => {
  withScratchDir((root) => {
    const { result, finalOut } = runBuild(root, SAMPLE);
    assert.equal(result.exitCode, EXIT_CODES.OK);

    for (const art of ART) {
      const outPath = path.join(finalOut, art.out);
      assert.ok(fs.existsSync(outPath), `missing art output: ${art.out}`);
      const outBuf = fs.readFileSync(outPath);

      // The source file lives somewhere under _attachments/; basenames are unique (E0), so a
      // direct basename search is unambiguous.
      const basename = path.basename(art.out);
      const sourcePath = findSourceByBasename(SAMPLE, basename);
      assert.ok(sourcePath, `no source found for ${basename}`);
      const sourceBuf = fs.readFileSync(sourcePath);
      assert.ok(outBuf.equals(sourceBuf), `${art.out} is not byte-equal to its source`);

      const size = imageSize(outBuf, extOf(art.out));
      assert.equal(size.width, art.width, `${art.out} width`);
      assert.equal(size.height, art.height, `${art.out} height`);
    }
  });
});

function findSourceByBasename(root, basename) {
  let found = null;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === basename) found = p;
    }
  }
  walk(path.join(root, '_attachments'));
  return found;
}

// -- E4: banners ----------------------------------------------------------------------------

test('E4: each BANNERS index has exactly one inline section banner; events/index.html has none', () => {
  withScratchDir((root) => {
    const { result, finalOut } = runBuild(root, SAMPLE);
    assert.equal(result.exitCode, EXIT_CODES.OK);

    for (const dir of BANNERS) {
      const text = fs.readFileSync(path.join(finalOut, dir, 'index.html'), 'utf8');
      const count = (text.match(/<figure class="section-banner(?:\s|")/g) || []).length;
      assert.equal(count, 1, `${dir}/index.html should have exactly one section banner`);
    }
    for (const dir of NO_BANNER_SECTIONS) {
      const text = fs.readFileSync(path.join(finalOut, dir, 'index.html'), 'utf8');
      assert.ok(!text.includes('section-banner'), `${dir}/index.html should have no section banner`);
    }
  });
});

// -- E5: theme css --------------------------------------------------------------------------

test('E5: css/scriptorium-theme.css declares every SLOTS custom property', () => {
  withScratchDir((root) => {
    const { result, finalOut } = runBuild(root, SAMPLE);
    assert.equal(result.exitCode, EXIT_CODES.OK);
    const css = fs.readFileSync(path.join(finalOut, 'css', 'scriptorium-theme.css'), 'utf8');
    for (const slot of SLOTS) {
      assert.match(css, new RegExp(`--sc-img-${slot}\\b`), `missing --sc-img-${slot}`);
    }
  });
});

// -- E6: every url() resolves -----------------------------------------------------------------

test('E6: unresolvedCssUrls(out) is empty', () => {
  withScratchDir((root) => {
    const { result, finalOut } = runBuild(root, SAMPLE);
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.deepEqual(unresolvedCssUrls(finalOut), []);
  });
});

// -- E8: planted control (vacuity guards included) -------------------------------------------

test('E8: planting the withheld name into a published page makes check refuse', () => {
  withScratchDir((root) => {
    const scratchVault = path.join(root, 'vault');
    copyDir(SAMPLE, scratchVault);

    const manifestPath = path.join(scratchVault, '_meta', 'publish-manifest.md');
    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    // Vacuity guard: the page we're about to plant into really is published.
    assert.match(manifestText, /## Publishing[\s\S]*Characters\/NPCs\/Orpiment\.md/);
    // Vacuity guard: the withheld page is still marked withheld.
    const withheldPath = path.join(scratchVault, 'Characters', 'NPCs', 'Ottoline Pardew.md');
    assert.match(fs.readFileSync(withheldPath, 'utf8'), /withheld:\s*true/);

    // Planted right after the opening paragraph, in the published body -- never at end of file,
    // which in this page falls inside the excluded "## GM Notes" section and would correctly
    // give no finding at all (a vacuous control, not a real one).
    const targetPath = path.join(scratchVault, 'Characters', 'NPCs', 'Orpiment.md');
    const targetText = fs.readFileSync(targetPath, 'utf8');
    const marker = '## What she is like';
    assert.ok(targetText.includes(marker), 'Orpiment.md no longer has the expected published heading');
    const planted = targetText.replace(marker, 'She once met Ottoline Pardew at the fair.\n\n' + marker);
    fs.writeFileSync(targetPath, planted);

    const finalOut = path.join(root, 'out');
    const configPath = writeConfigToml(root, { vaultPath: scratchVault, finalOut });
    const result = runCheckCommand({ config: configPath }, 'lease');

    assert.equal(result.exitCode, EXIT_CODES.CHECK_FAILED);
    assert.ok(
      result.envelope.findings.some((f) => f.id === 'leak/l4-hidden-name'),
      `expected a leak/l4-hidden-name finding; got: ${JSON.stringify(result.envelope.findings.map((f) => f.id))}`,
    );
  });
});

// -- E9: CRLF checkout ------------------------------------------------------------------------

test('E9: a CRLF copy still gives 0 errors and builds the same page set', () => {
  withScratchDir((root) => {
    const scratchVault = path.join(root, 'vault');
    copyDir(SAMPLE, scratchVault);
    crlfifyTree(scratchVault);

    const configPath = path.join(scratchVault, '_meta', 'vault-config.md');
    const text = fs.readFileSync(configPath, 'utf8');
    const firstFrontmatterLine = text.split('\r\n')[0];
    assert.equal(firstFrontmatterLine, '---');
    assert.ok(text.startsWith('---\r\n'), 'frontmatter fence must now end in CRLF');

    const finalOut = path.join(root, 'out');
    const cfgPath = writeConfigToml(root, { vaultPath: scratchVault, finalOut });
    const checkResult = runCheckCommand({ config: cfgPath }, 'lease');
    assert.equal(checkResult.envelope.counts.error, 0);

    const buildResult = runBuildCommand({ config: cfgPath }, 'lease');
    assert.equal(buildResult.exitCode, EXIT_CODES.OK);

    const crlfPages = findHtmlFiles(finalOut);

    withScratchDir((lfRoot) => {
      const { result: lfResult, finalOut: lfOut } = runBuild(lfRoot, SAMPLE);
      assert.equal(lfResult.exitCode, EXIT_CODES.OK);
      assert.deepEqual(crlfPages, findHtmlFiles(lfOut));
    });
  });
});

// -- E7: the vault is never mutated, across every build above (must run last) -----------------

test('E7: a sha256 map of every file under the sample is unchanged by every build above', () => {
  assert.deepEqual(hashTree(SAMPLE), sampleHashBefore);
});
