'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { ROLE_IDS, resolvePageRoles } = require('../src/admin/pageroles');

/*
 * V1e-3 (SD-18, FR-16, ADR 0035 SS5). Hand-written trees in scratch, plus one real build of a
 * test/fixtures/vocab-vault scratch copy (its rels are then typed as literals -- never re-derived
 * from resolvePageRoles's own output).
 */

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-pageroles-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function pageHtml({ title = 'Untitled', extra = '' } = {}) {
  return `<!doctype html><html><body><h1 class="page-title">${title}</h1>${extra}</body></html>`;
}

test('ROLE_IDS is the exact frozen literal, in order', () => {
  assert.deepEqual(ROLE_IDS, ['landing', 'recap', 'character', 'timeline', 'notfound']);
});

test('each role present: a typed literal for every field', () => {
  withScratchDir((root) => {
    write(root, 'index.html', pageHtml({ title: 'Landing' }));
    write(root, '404.html', pageHtml({ title: 'Oops' }));
    write(
      root,
      'episodes/ep1.html',
      pageHtml({ title: 'Episode One', extra: '<span data-field="session_number">1</span>' }),
    );
    write(root, 'timeline.html', pageHtml({ title: 'The Timeline', extra: '<div data-scriptorium-timeline></div>' }));
    write(root, 'people/hero.html', pageHtml({ title: 'Hero Page', extra: '<div data-scriptorium-connections></div>' }));
    write(
      root,
      'search-index.json',
      JSON.stringify({ documents: { a: { type: 'npc', title: 'Hero Doc', href: 'people/hero.html' } } }),
    );

    const roles = resolvePageRoles(root);
    assert.deepEqual(roles, [
      { role: 'landing', rel: 'index.html', title: 'Landing page' },
      { role: 'recap', rel: 'episodes/ep1.html', title: 'Episode One' },
      { role: 'character', rel: 'people/hero.html', title: 'Hero Doc' },
      { role: 'timeline', rel: 'timeline.html', title: 'The Timeline' },
      { role: 'notfound', rel: '404.html', title: 'Not-found page' },
    ]);
  });
});

test('each role absent: an empty tree gives an empty array', () => {
  withScratchDir((root) => {
    fs.mkdirSync(root, { recursive: true });
    assert.deepEqual(resolvePageRoles(root), []);
  });
});

test('recap: the highest session number wins, not the lowest (G1 mutation guard)', () => {
  withScratchDir((root) => {
    write(root, 'ep1.html', pageHtml({ title: 'First', extra: '<span data-field="session_number">1</span>' }));
    write(root, 'ep9.html', pageHtml({ title: 'Ninth', extra: '<span data-field="session_number">9</span>' }));
    write(root, 'ep3.html', pageHtml({ title: 'Third', extra: '<span data-field="session_number">3</span>' }));
    const roles = resolvePageRoles(root);
    const recap = roles.find((r) => r.role === 'recap');
    assert.deepEqual(recap, { role: 'recap', rel: 'ep9.html', title: 'Ninth' });
  });
});

test('recap: an empty page title falls back to "Latest recap" (|| , not "is a string")', () => {
  withScratchDir((root) => {
    write(root, 'ep1.html', '<html><body><h1 class="page-title"></h1><span data-field="session_number">1</span></body></html>');
    const recap = resolvePageRoles(root).find((r) => r.role === 'recap');
    assert.deepEqual(recap, { role: 'recap', rel: 'ep1.html', title: 'Latest recap' });
  });
});

test('timeline: G4 -- the marker-carrying page beats a root timeline.html with no marker', () => {
  withScratchDir((root) => {
    write(root, 'timeline.html', pageHtml({ title: 'Plain Timeline' })); // no marker
    write(root, 'chronicle/real.html', pageHtml({ title: 'Real Chronology', extra: '<div data-scriptorium-timeline></div>' }));
    const timeline = resolvePageRoles(root).find((r) => r.role === 'timeline');
    assert.deepEqual(timeline, { role: 'timeline', rel: 'chronicle/real.html', title: 'Real Chronology' });
  });
});

test('timeline: no marker anywhere falls back to timeline.html if present', () => {
  withScratchDir((root) => {
    write(root, 'timeline.html', pageHtml({ title: 'Just Timeline' }));
    const timeline = resolvePageRoles(root).find((r) => r.role === 'timeline');
    assert.deepEqual(timeline, { role: 'timeline', rel: 'timeline.html', title: 'Just Timeline' });
  });
});

test('timeline: multiple marker pages -- cmpCodeUnit ("a.html" before "b.html") picks the first, never the last', () => {
  withScratchDir((root) => {
    write(root, 'b.html', pageHtml({ title: 'B', extra: '<div data-scriptorium-timeline></div>' }));
    write(root, 'a.html', pageHtml({ title: 'A', extra: '<div data-scriptorium-timeline></div>' }));
    const timeline = resolvePageRoles(root).find((r) => r.role === 'timeline');
    assert.equal(timeline.rel, 'a.html');
  });
});

test('timeline: no marker and no timeline.html gives absent', () => {
  withScratchDir((root) => {
    write(root, 'index.html', pageHtml());
    const timeline = resolvePageRoles(root).find((r) => r.role === 'timeline');
    assert.equal(timeline, undefined);
  });
});

test('G3: a search-index href NOT in the tree, including a "../x.html" ancestor-escape attempt, is ignored -- ghost hrefs never resolve', () => {
  withScratchDir((root) => {
    write(root, 'people/real.html', pageHtml({ title: 'Real' }));
    write(
      root,
      'search-index.json',
      JSON.stringify({
        documents: {
          ghost1: { type: 'npc', title: 'Ghost', href: 'people/does-not-exist.html' },
          ghost2: { type: 'npc', title: 'Escape', href: '../x.html' },
        },
      }),
    );
    const character = resolvePageRoles(root).find((r) => r.role === 'character');
    assert.equal(character, undefined, 'neither ghost href may ever resolve to a page');
  });
});

test('a symlinked dir pointing at the tree\'s parent is not walked (the walk terminates, no cycle)', () => {
  withScratchDir((root) => {
    const siteDir = path.join(root, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    write(siteDir, 'index.html', pageHtml({ title: 'Real landing' }));
    // A symlinked dir pointing at the tree's own parent (a cycle/escape attempt): if ever
    // followed, the walk would recurse into itself without bound.
    fs.symlinkSync(root, path.join(siteDir, 'up-link'));

    const roles = resolvePageRoles(siteDir);
    // Landing's title is always the fixed literal 'Landing page' (SD-18), never derived from the
    // page's own H1.
    assert.deepEqual(roles, [{ role: 'landing', rel: 'index.html', title: 'Landing page' }]);
  });
});

test('G2: a symlinked FILE named exactly like a role trigger, pointing outside the tree, is never listed or resolved (statSync-vs-Dirent guard)', () => {
  withScratchDir((root) => {
    const siteDir = path.join(root, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    write(siteDir, 'index.html', pageHtml({ title: 'Real landing' }));
    // The outside target a symlink would (wrongly) expose if the walk ever followed it: named
    // EXACTLY '404.html', matching resolveNotfoundRole's own exact top-level check, so any
    // resolution here is unambiguous proof the symlink was followed, not just present.
    fs.writeFileSync(path.join(root, 'outside-404.html'), pageHtml({ title: 'Should never be listed' }));
    fs.symlinkSync(path.join(root, 'outside-404.html'), path.join(siteDir, '404.html'));
    // Also a symlinked .html under a nested dir, again at the EXACT expected top-level name for a
    // different role, so both the notfound and the (already-covered-elsewhere) timeline checks
    // have a same-shaped positive-control sibling here.
    fs.symlinkSync(path.join(root, 'outside-404.html'), path.join(siteDir, 'timeline.html'));

    const roles = resolvePageRoles(siteDir);
    assert.deepEqual(roles, [{ role: 'landing', rel: 'index.html', title: 'Landing page' }]);
    assert.equal(roles.find((r) => r.role === 'notfound'), undefined, 'a symlinked 404.html must never resolve a notfound role');
    assert.equal(roles.find((r) => r.role === 'timeline'), undefined, 'a symlinked timeline.html must never resolve a timeline role');
  });
});

test('sub/index.html alone gives no landing role (G5: exact membership, not endsWith)', () => {
  withScratchDir((root) => {
    write(root, 'sub/index.html', pageHtml({ title: 'Nested' }));
    const landing = resolvePageRoles(root).find((r) => r.role === 'landing');
    assert.equal(landing, undefined);
  });
});

test('character: npc before pc, with the Connections marker preferred over plain href order', () => {
  withScratchDir((root) => {
    write(root, 'people/a-pc.html', pageHtml({ title: 'A PC', extra: '<div data-scriptorium-connections></div>' }));
    write(root, 'people/z-npc.html', pageHtml({ title: 'Z NPC' })); // no marker, but npc beats pc
    write(root, 'people/a-npc.html', pageHtml({ title: 'A NPC', extra: '<div data-scriptorium-connections></div>' }));
    write(
      root,
      'search-index.json',
      JSON.stringify({
        documents: {
          pc1: { type: 'pc', title: 'A PC', href: 'people/a-pc.html' },
          npc1: { type: 'npc', title: 'Z NPC', href: 'people/z-npc.html' },
          npc2: { type: 'npc', title: 'A NPC', href: 'people/a-npc.html' },
        },
      }),
    );
    const character = resolvePageRoles(root).find((r) => r.role === 'character');
    // npc candidates sorted by href: a-npc.html, z-npc.html. First WITH the marker wins: a-npc.html.
    assert.deepEqual(character, { role: 'character', rel: 'people/a-npc.html', title: 'A NPC' });
  });
});

test('character: no npc or pc carries the marker -- falls back to the first candidate (npc, href-sorted)', () => {
  withScratchDir((root) => {
    write(root, 'people/z-npc.html', pageHtml({ title: 'Z NPC' }));
    write(root, 'people/a-npc.html', pageHtml({ title: 'A NPC' }));
    write(
      root,
      'search-index.json',
      JSON.stringify({
        documents: {
          npc1: { type: 'npc', title: 'Z NPC', href: 'people/z-npc.html' },
          npc2: { type: 'npc', title: 'A NPC', href: 'people/a-npc.html' },
        },
      }),
    );
    const character = resolvePageRoles(root).find((r) => r.role === 'character');
    assert.deepEqual(character, { role: 'character', rel: 'people/a-npc.html', title: 'A NPC' });
  });
});

test('character: only pc entries (no npc at all) still resolves, from the pc pool', () => {
  withScratchDir((root) => {
    write(root, 'people/only-pc.html', pageHtml({ title: 'Only PC' }));
    write(root, 'search-index.json', JSON.stringify({ documents: { pc1: { type: 'pc', title: 'Only PC', href: 'people/only-pc.html' } } }));
    const character = resolvePageRoles(root).find((r) => r.role === 'character');
    assert.deepEqual(character, { role: 'character', rel: 'people/only-pc.html', title: 'Only PC' });
  });
});

test('character: title falls back to the page\'s own <h1 class="page-title"> when documents[ref].title is not a string, else "A character"', () => {
  withScratchDir((root) => {
    write(root, 'people/no-title-field.html', pageHtml({ title: 'Page H1 Title' }));
    write(root, 'people/no-title-at-all.html', '<html><body>no h1 here</body></html>');
    write(
      root,
      'search-index.json',
      JSON.stringify({
        documents: {
          npc1: { type: 'npc', href: 'people/no-title-field.html' }, // title missing (not a string)
        },
      }),
    );
    const character1 = resolvePageRoles(root).find((r) => r.role === 'character');
    assert.deepEqual(character1, { role: 'character', rel: 'people/no-title-field.html', title: 'Page H1 Title' });
  });

  withScratchDir((root) => {
    write(root, 'people/no-title-at-all.html', '<html><body>no h1 here</body></html>');
    write(root, 'search-index.json', JSON.stringify({ documents: { npc1: { type: 'npc', href: 'people/no-title-at-all.html' } } }));
    const character2 = resolvePageRoles(root).find((r) => r.role === 'character');
    assert.deepEqual(character2, { role: 'character', rel: 'people/no-title-at-all.html', title: 'A character' });
  });
});

test('character: search disabled (no search-index.json at all) gives no character role', () => {
  withScratchDir((root) => {
    write(root, 'people/hero.html', pageHtml({ title: 'Hero' }));
    // No search-index.json written.
    const character = resolvePageRoles(root).find((r) => r.role === 'character');
    assert.equal(character, undefined);
  });
});

test('character: a non-object/array search-index.json, and one over the size cap, both give no character role', () => {
  withScratchDir((root) => {
    write(root, 'people/hero.html', pageHtml({ title: 'Hero' }));
    write(root, 'search-index.json', JSON.stringify(['not', 'an', 'object']));
    assert.equal(resolvePageRoles(root).find((r) => r.role === 'character'), undefined);
  });

  withScratchDir((root) => {
    write(root, 'people/hero.html', pageHtml({ title: 'Hero' }));
    write(root, 'search-index.json', '{not json');
    assert.equal(resolvePageRoles(root).find((r) => r.role === 'character'), undefined);
  });

  withScratchDir((root) => {
    write(root, 'people/hero.html', pageHtml({ title: 'Hero' }));
    // Over the 32 MiB cap: pad with a huge unknown field so the file itself is oversized.
    const huge = 'x'.repeat(33 * 1024 * 1024);
    fs.writeFileSync(
      path.join(root, 'search-index.json'),
      JSON.stringify({ documents: { npc1: { type: 'npc', title: 'Hero', href: 'people/hero.html' } } }).slice(0, -1) + `,"pad":"${huge}"}`,
    );
    assert.equal(resolvePageRoles(root).find((r) => r.role === 'character'), undefined);
  });
});

test('every returned rel is an exact member of the walk\'s own file set -- never "..", never absolute, never a symlink', () => {
  withScratchDir((root) => {
    write(root, 'index.html', pageHtml({ title: 'Landing' }));
    write(root, '404.html', pageHtml({ title: 'Oops' }));
    for (const { rel } of resolvePageRoles(root)) {
      assert.ok(!rel.startsWith('/'), `${rel} must not be absolute`);
      assert.ok(!rel.includes('..'), `${rel} must never contain ..`);
      assert.ok(fs.existsSync(path.join(root, rel)) && !fs.lstatSync(path.join(root, rel)).isSymbolicLink());
    }
  });
});

// =================================================================================================
// One real build of test/fixtures/vocab-vault, typed literals from its own known output.
// =================================================================================================

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const VOCAB_VAULT_SRC = path.join(__dirname, 'fixtures', 'vocab-vault');

test('a real build of test/fixtures/vocab-vault resolves the typed, independently-confirmed literal roles', () => {
  withScratchDir((root) => {
    const vaultPath = path.join(root, 'vault');
    fs.cpSync(VOCAB_VAULT_SRC, vaultPath, { recursive: true });
    const outDir = path.join(root, 'out');
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(
      configPath,
      ['config_version = 1', 'default_campaign = "alpha"', '', '[campaigns.alpha]', `vault = '${vaultPath}'`, `output = '${outDir}'`, ''].join('\n'),
    );
    const env = { ...process.env };
    env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-config.toml');
    env.APPDATA = path.join(root, 'unused-appdata');
    env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg');
    const res = spawnSync(process.execPath, [BIN, 'build', '--config', configPath, 'alpha'], { encoding: 'utf8', env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);

    // Typed independently from the fixture's own known content (People/Sera Wick.md is an npc
    // with a Connections lane; People/Doran Vex.md is a pc; Episodes/Episode-02.md is the
    // higher-numbered session; Chronicle/Chronology.md is the only timeline page) -- never
    // re-derived from resolvePageRoles's own output.
    const roles = resolvePageRoles(outDir);
    assert.deepEqual(roles, [
      { role: 'landing', rel: 'index.html', title: 'Landing page' },
      { role: 'recap', rel: 'episodes/episode-02.html', title: 'Episode 02' },
      { role: 'character', rel: 'people/sera-wick.html', title: 'Sera Wick' },
      { role: 'timeline', rel: 'chronicle/chronology.html', title: 'Chronology' },
      { role: 'notfound', rel: '404.html', title: 'Not-found page' },
    ]);
  });
});
