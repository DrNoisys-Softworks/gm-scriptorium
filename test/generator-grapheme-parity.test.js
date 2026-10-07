'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { installSegmenterShim } = require('../src/generator/intl-shim');

const VAULT_PATH = path.join(__dirname, 'fixtures', 'grapheme-vault');
const SITE_CONFIG_SRC = path.join(__dirname, 'fixtures', 'grapheme-vault-site-config.json');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-grapheme-parity-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildGraphemeVault(outDir) {
  const siteConfig = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  const synthesized = Object.assign({}, siteConfig, { vaultPath: VAULT_PATH, outputDir: outDir });
  const tmpConfigPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-grapheme-config-')),
    'vault.config.json',
  );
  fs.writeFileSync(tmpConfigPath, JSON.stringify(synthesized, null, 2));

  // test-only require of the pinned generator's own module, per src/generator/bootstrap.js's
  // interface (require('gm-apprentice-publish').build({configPath})). This test exercises the
  // shim directly against the real generator, rather than through the full
  // check/build CLI+TOML layer already covered by test/build-site-mirror.test.js.
  // eslint-disable-next-line global-require
  const { build } = require('gm-apprentice-publish');
  build({ configPath: tmpConfigPath });
}

function sha256Manifest(dir) {
  const files = [];
  (function walk(current, rel) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  })(dir, '');
  files.sort();
  const out = {};
  for (const relPath of files) {
    out[relPath] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, relPath))).digest('hex');
  }
  return out;
}

test('grapheme-vault builds identically under plain node and inside installSegmenterShim({force:true})', () => {
  withTmpDir((dir) => {
    const plainOut = path.join(dir, 'out-plain');
    buildGraphemeVault(plainOut);
    const plainManifest = sha256Manifest(plainOut);

    const shimmedOut = path.join(dir, 'out-shimmed');
    const restore = installSegmenterShim({ force: true });
    try {
      buildGraphemeVault(shimmedOut);
    } finally {
      restore();
    }
    const shimmedManifest = sha256Manifest(shimmedOut);

    assert.deepEqual(shimmedManifest, plainManifest);
    assert.ok(Object.keys(plainManifest).length > 0, 'the build must actually produce files');
  });
});

test('grapheme-vault build embeds the horror theme CSS and truncated (ellipsis) graph labels', () => {
  withTmpDir((dir) => {
    const outDir = path.join(dir, 'out');
    buildGraphemeVault(outDir);

    assert.equal(fs.existsSync(path.join(outDir, 'css', 'themes', 'horror.css')), true);

    const npcDir = path.join(outDir, 'characters', 'npcs');
    const npcFiles = fs.readdirSync(npcDir).filter((f) => f.endsWith('.html') && f !== 'index.html');
    assert.equal(npcFiles.length, 4);

    let ellipsisCount = 0;
    for (const file of npcFiles) {
      const html = fs.readFileSync(path.join(npcDir, file), 'utf8');
      if (html.includes('…')) ellipsisCount++;
    }
    assert.equal(ellipsisCount, 4, 'every NPC page in the relationship ring should render at least one truncated graph label');
  });
});
