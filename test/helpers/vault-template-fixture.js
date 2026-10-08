'use strict';

/*
 * The test fixture starter template (test/fixtures/vault-template) and its manifest.
 *
 * The files under common/ and systems/ are hand-written. This helper only computes the manifest
 * from them: sha256 of every stored file, the per-file token counts, the folder lists and the
 * parity vector. The parity vector's sha256 values come from the hand-written expected trees in
 * test/fixtures/vault-template-expected, never from the template files, so a renderer bug
 * cannot hide in both. After changing a fixture file, run:
 *
 *   node test/helpers/vault-template-fixture.js
 *
 * and read the diff. The test suite fails until the manifest agrees with the files.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'vault-template');
const EXPECTED_DIR = path.join(__dirname, '..', 'fixtures', 'vault-template-expected');

const CAMPAIGN = '{{SCRIPTORIUM_CAMPAIGN}}';
const CREATED = '{{SCRIPTORIUM_CREATED}}';

/** Files this program writes itself, as opposed to files the (pretend) upstream scaffold wrote. */
const OWN_FILES = new Set(['_meta/publish-manifest.md', '_Campaign/Welcome.md', '_meta/NOTICE.txt']);

const EMPTY_DIRS = ['_attachments', '_attachments/characters', 'Characters', 'Characters/NPCs', 'Characters/PCs', 'Locations', 'Factions & Organizations', 'Items & Artifacts'];

const PARITY_RAW_NAME = 'Qzx  Echo Ünï:  #1 ---';
const PARITY_CAMPAIGN = 'Qzx Echo Ünï: #1 ---';
const PARITY_CREATED = '2034-11-29';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walkFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  })(dir, '');
  return out.sort();
}

function count(text, token) {
  return text.split(token).length - 1;
}

function entryFor(dir, store, rel) {
  const data = fs.readFileSync(path.join(dir, ...store.split('/')));
  const text = data.toString('utf8');
  const tokens = {};
  for (const token of [CAMPAIGN, CREATED]) {
    const n = count(text, token);
    if (n > 0) tokens[token] = n;
  }
  return { store, sha256: sha(data), origin: OWN_FILES.has(rel) ? 'scriptorium' : 'upstream', tokens };
}

function dirsFor(rels) {
  const set = new Set(EMPTY_DIRS);
  for (const rel of rels) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) set.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...set]) {
    const parts = d.split('/');
    for (let i = 1; i < parts.length; i += 1) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort();
}

function buildManifest(dir = FIXTURE_DIR, expectedDir = EXPECTED_DIR) {
  const common = walkFiles(path.join(dir, 'common'));
  const systems = {};
  const parity = [];
  for (const id of fs.readdirSync(path.join(dir, 'systems')).sort()) {
    const own = walkFiles(path.join(dir, 'systems', id));
    const files = {};
    for (const rel of common) files[rel] = entryFor(dir, `common/${rel}`, rel);
    for (const rel of own) files[rel] = entryFor(dir, `systems/${id}/${rel}`, rel);
    const sorted = {};
    for (const rel of Object.keys(files).sort()) sorted[rel] = files[rel];
    systems[id] = { dirs: dirsFor(Object.keys(sorted)), files: sorted };

    const expected = {};
    for (const rel of walkFiles(path.join(expectedDir, id))) expected[rel] = sha(fs.readFileSync(path.join(expectedDir, id, ...rel.split('/'))));
    parity.push({ system: id, name: PARITY_RAW_NAME, campaign: PARITY_CAMPAIGN, created: PARITY_CREATED, files: expected });
  }
  return {
    schema: 1,
    templateVersion: 'fixture-1',
    upstream: {
      repository: 'https://example.invalid/gm-apprentice-fixture',
      commit: '0123456789abcdef0123456789abcdef01234567',
      script: 'skills/shared/scripts/vault_scaffold.py',
      pluginVersion: '9.9.9',
      command: 'fixture: hand-written, not captured',
      clock: 'fixture: hand-written, not captured',
    },
    gm_apprentice_version: '9.9.9',
    license: 'MIT',
    attribution: 'Test fixture written for this repository. It is not upstream content.',
    placeholders: [
      { token: CAMPAIGN, value: 'campaign', rule: 'the site title with every run of whitespace collapsed to one space' },
      { token: CREATED, value: 'created', rule: 'the local date of creation as YYYY-MM-DD' },
    ],
    systems,
    deviations: [
      {
        file: '_meta/vault-config.md',
        from: '  site: false',
        to: '  site: true',
        why: 'a new vault has to build as soon as it is created, so the site switch is turned on',
      },
    ],
    parity,
    rulesScan: [],
  };
}

function writeManifest(dir = FIXTURE_DIR) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(buildManifest(dir), null, 2)}\n`);
}

module.exports = {
  FIXTURE_DIR,
  EXPECTED_DIR,
  OWN_FILES,
  PARITY_RAW_NAME,
  PARITY_CAMPAIGN,
  PARITY_CREATED,
  sha,
  walkFiles,
  buildManifest,
  writeManifest,
};

if (require.main === module) {
  writeManifest();
  process.stdout.write(`wrote ${path.join(FIXTURE_DIR, 'manifest.json')}\n`);
}
