'use strict';

/*
 * publish-v1.14.0 (D&D playable sheet) and the earlier GURPS/CoC live sheets can save player state to
 * a site backend (`/api/loadout`, `/api/loadout-list`) when `publish.live_stats` is on AND the site has a
 * KV store wired (wrangler.toml with a real INBOX namespace id beside the site config). Scriptorium
 * serves static output with no backend, so this proves, on a real build with a D&D PC and a party page:
 *
 *   1. Default (switch unset): no page references a live script, and nothing in the output names the API.
 *   2. Switch on, no KV store (what a Scriptorium site is): still none, and the pin says so.
 *   3. Positive control, switch on AND a KV store wired: the live scripts are referenced, so tests 1 and 2
 *      are not vacuous; and every network call in the scripts a page loads is same-origin (a root-relative
 *      /api/ path), with no absolute http(s) or protocol-relative URL anywhere in the shipped js/.
 *
 * Scriptorium's own scaffold and admin panel never set the switch (nothing under src/ or assets/ names it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');

const LIVE_SCRIPTS = /live-state\.js|dnd-live\.js|dnd-party\.js|party-core\.js|gurps-live\.js|coc-live\.js/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function build({ liveStats, kv }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-live-stats-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Characters', 'PCs'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '_meta', 'vault-config.md'),
    `---\ntype: meta\npublish:\n  system: dnd-5e-2024\n  mode: gm\n${liveStats ? '  live_stats: true\n' : ''}---\n# Config\n`
  );
  fs.writeFileSync(
    path.join(vault, 'Characters', 'PCs', 'Tamsin.md'),
    '---\ntype: pc\ntitle: Tamsin\n---\n## Stat Sheet\n\n| Ability | Score | Mod |\n|---|---|---|\n| STR | 10 | +0 |\n| DEX | 14 | +2 |\n\n**HP** 12/12  **AC** 15\n\n## Public Bio\nA cautious scout.\n'
  );
  fs.writeFileSync(
    path.join(vault, 'Characters', 'PCs', 'Party.md'),
    '---\ntype: pc_roster\ntitle: The Party\n---\n## Party\nTamsin\n'
  );
  const siteDir = path.join(root, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  if (kv) fs.writeFileSync(path.join(siteDir, 'wrangler.toml'), '[[kv_namespaces]]\nbinding = "INBOX"\nid = "abc123realid"\n');
  const finalOut = path.join(root, 'out');
  const result = runAtomicBuild({
    vaultPath: vault,
    userJsonConfig: {
      siteTitle: 'Live', siteUrl: 'https://example.invalid', vaultPath: vault, outputDir: './out',
      attachmentsDir: '_attachments', folderMap: { 'Characters/PCs': 'characters/pcs' }, excludeDirs: ['_meta'],
    },
    finalOut,
    siteDir,
    campaign: 'live-stats',
    force: true,
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.renderErrors));
  return { root, finalOut, result };
}

function pagesReferencing(finalOut, re) {
  return walk(finalOut).filter((f) => f.endsWith('.html')).filter((f) => re.test(fs.readFileSync(f, 'utf8')));
}

test('live_stats unset (the default): no page loads a live script or names the backend API', () => {
  const { root, finalOut } = build({ liveStats: false, kv: false });
  try {
    const pcPage = path.join(finalOut, 'characters', 'pcs', 'tamsin.html');
    assert.ok(fs.existsSync(pcPage) && fs.existsSync(path.join(finalOut, 'characters', 'pcs', 'party.html')), 'positive control: the PC and party pages were built');
    assert.deepEqual(pagesReferencing(finalOut, LIVE_SCRIPTS), [], 'a page loads a live script with the switch unset');
    assert.deepEqual(pagesReferencing(finalOut, /\/api\/(loadout|request)/), [], 'a page names the backend API with the switch unset');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live_stats on but no KV store wired (a Scriptorium site): still no live script, and the pin says it was withheld', () => {
  const { root, finalOut, result } = build({ liveStats: true, kv: false });
  try {
    assert.deepEqual(pagesReferencing(finalOut, LIVE_SCRIPTS), []);
    assert.deepEqual(pagesReferencing(finalOut, /\/api\/(loadout|request)/), []);
    assert.match(JSON.stringify(result.detail), /live_stats is on but this site has no KV store wired; live stats are not published/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('positive control: live_stats on AND a KV store wired loads the live scripts, and every call they make is same-origin', () => {
  const { root, finalOut } = build({ liveStats: true, kv: true });
  try {
    const withLive = pagesReferencing(finalOut, /js\/dnd-live\.js/);
    assert.ok(withLive.length >= 2, 'with the switch and a KV store, the PC page and the party page must load dnd-live.js');
    const loaded = new Set();
    for (const f of withLive) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/<script[^>]*src="[^"]*js\/([\w.-]+\.js)"/g)) loaded.add(m[1]);
    }
    assert.ok(loaded.has('live-state.js') && loaded.has('dnd-live.js'));
    for (const name of loaded) {
      const src = fs.readFileSync(path.join(finalOut, 'js', name), 'utf8');
      // Every fetch target literal is a root-relative path (same origin).
      for (const m of src.matchAll(/fetch\w*\(\s*'([^']*)'/g)) {
        assert.match(m[1], /^\/api\//, `${name}: a network call goes somewhere other than the site's own /api/: ${m[1]}`);
      }
    }
    // No shipped script anywhere in js/ names an absolute or protocol-relative URL as code (comments skipped).
    for (const f of walk(path.join(finalOut, 'js')).filter((p) => p.endsWith('.js'))) {
      const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      assert.doesNotMatch(code, /['"`](https?:)?\/\/[\w.-]+/, `${path.basename(f)} names a cross-origin URL`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Scriptorium never sets the live_stats switch itself (scaffold, admin panel, pack settings)', () => {
  const offenders = [];
  for (const dir of ['src', 'assets']) {
    for (const f of walk(path.join(__dirname, '..', dir))) {
      if (!/\.(js|json|toml|md|html)$/.test(f)) continue;
      if (/live_stats|liveStats/.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(path.join(__dirname, '..'), f));
    }
  }
  assert.deepEqual(offenders, [], 'src/ or assets/ now names the live_stats switch; decide whether it must be off by default');
});
