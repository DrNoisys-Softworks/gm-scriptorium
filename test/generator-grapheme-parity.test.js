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

function buildGraphemeVault(outDir, vaultPath = VAULT_PATH) {
  const siteConfig = JSON.parse(fs.readFileSync(SITE_CONFIG_SRC, 'utf8'));
  const synthesized = Object.assign({}, siteConfig, { vaultPath, outputDir: outDir });
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

// From publish-v1.18.0 the pin splits graphemes only for initials (lib/templates/landing-data.js:136),
// which an NPC page with no portrait prints. None of the fixture's names starts a word with a cluster
// of more than one code point once NFC has run, so this test adds one, in a scratch copy of the
// fixture: a ZWJ emoji sequence that splits wrongly unless GB11 holds.
const CLUSTER_NPC = '---\ntype: npc\ntitle: "👩‍🔬 Ines"\n---\n\nA synthetic NPC whose initials start with a ZWJ sequence.\n';
const CLUSTER_INITIALS = '👩‍🔬I';

test('grapheme-vault builds identically under plain node and inside installSegmenterShim({force:true})', () => {
  withTmpDir((dir) => {
    const vaultPath = path.join(dir, 'vault');
    fs.cpSync(VAULT_PATH, vaultPath, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'Characters', 'NPCs', 'cluster-initials-npc.md'), CLUSTER_NPC);

    const plainOut = path.join(dir, 'out-plain');
    buildGraphemeVault(plainOut, vaultPath);
    const plainManifest = sha256Manifest(plainOut);

    const shimmedOut = path.join(dir, 'out-shimmed');
    const restore = installSegmenterShim({ force: true });
    try {
      buildGraphemeVault(shimmedOut, vaultPath);
    } finally {
      restore();
    }
    const shimmedManifest = sha256Manifest(shimmedOut);

    assert.deepEqual(shimmedManifest, plainManifest);
    assert.ok(Object.keys(plainManifest).length > 0, 'the build must actually produce files');
    const npcPages = fs.readdirSync(path.join(shimmedOut, 'characters', 'npcs'))
      .map((f) => fs.readFileSync(path.join(shimmedOut, 'characters', 'npcs', f), 'utf8'));
    assert.ok(npcPages.some((html) => html.includes(`>${CLUSTER_INITIALS}</div>`)), 'the shim kept the ZWJ sequence whole in the initials');
  });
});

// Until publish-v1.17.0 this also counted the relationship graph's truncated (ellipsis) labels, the
// shim's main consumer. publish-v1.18.0 removed the graph; the test above now checks the initials.
test('grapheme-vault build embeds the horror theme CSS and no page carries the retired relationship graph', () => {
  withTmpDir((dir) => {
    const outDir = path.join(dir, 'out');
    buildGraphemeVault(outDir);

    assert.equal(fs.existsSync(path.join(outDir, 'css', 'themes', 'horror.css')), true);

    const npcDir = path.join(outDir, 'characters', 'npcs');
    const npcFiles = fs.readdirSync(npcDir).filter((f) => f.endsWith('.html') && f !== 'index.html');
    assert.equal(npcFiles.length, 4);
    for (const file of npcFiles) {
      assert.ok(!fs.readFileSync(path.join(npcDir, file), 'utf8').includes('relationship-graph'), file);
    }
  });
});
