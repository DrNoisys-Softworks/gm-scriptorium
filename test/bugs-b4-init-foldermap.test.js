'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run, copySampleWithoutPack } = require('./helpers/b4-cli');
const { deriveFolderMapAdditions } = require('../src/setup/foldermap');

/*
 * Issue #103: `init` wrote a folderMap with no Sessions entry, so the generator silently dropped
 * every session page, and `build` exited 0 without a word. Expected values below are stated by
 * hand from the sample vault (Sessions/ holds 3 session notes), never read back from the code.
 */

function pageFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
}

test('B4-103-1: init on the sample without its pack maps Sessions, and build publishes all 3 session pages', () => {
  withScratch((root) => {
    const vault = copySampleWithoutPack(root);
    const out = path.join(root, 'site');
    const init = run(root, ['init', '--vault', vault, '--name', 'v2', '--yes', '--out', out]);
    assert.equal(init.code, 0, init.all);

    const written = JSON.parse(fs.readFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
    assert.equal(written.folderMap.Sessions, 'sessions');

    const build = run(root, ['build', 'v2']);
    assert.equal(build.code, 0, build.all);
    assert.doesNotMatch(build.out, /not published/);
    assert.deepEqual(pageFiles(path.join(out, 'sessions')), [
      'index.html',
      'session-01-a-dragon-at-the-fair.html',
      'session-02-the-wax-vaults.html',
      'session-03-under-the-sallow-hills.html',
    ]);
  });
});

test('B4-103-2: init maps a folder the vault added itself (Adventures/), derived from its typed pages', () => {
  withScratch((root) => {
    const vault = copySampleWithoutPack(root);
    fs.mkdirSync(path.join(vault, 'Adventures', 'Side Quests'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Adventures', 'Mill.md'), '---\ntype: event\n---\n\n# Mill\n');
    fs.writeFileSync(path.join(vault, 'Adventures', 'Side Quests', 'Well.md'), '---\ntype: event\n---\n\n# Well\n');
    const init = run(root, ['init', '--vault', vault, '--name', 'v3', '--yes', '--out', path.join(root, 'site')]);
    assert.equal(init.code, 0, init.all);
    const { folderMap } = JSON.parse(fs.readFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
    assert.equal(folderMap.Adventures, 'adventures');
    assert.equal(folderMap['Adventures/Side Quests'], undefined, 'a child of a mapped folder needs no entry of its own');
  });
});

test('B4-103-3: an excluded folder and an untyped-only folder get no entry', () => {
  withScratch((root) => {
    const vault = copySampleWithoutPack(root);
    fs.mkdirSync(path.join(vault, '_Templates'), { recursive: true });
    fs.writeFileSync(path.join(vault, '_Templates', 'T.md'), '---\ntype: npc\n---\n');
    fs.mkdirSync(path.join(vault, 'Scratch'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Scratch', 'n.md'), '# no frontmatter type\n');
    const adds = deriveFolderMapAdditions(vault, { folderMap: { 'Characters/PCs': 'characters/pcs' }, excludeDirs: ['_meta', '_Templates'] });
    assert.equal(adds._Templates, undefined);
    assert.equal(adds.Scratch, undefined);
    assert.equal(adds.Sessions, 'sessions');
  });
});

test('B4-103-4: build warns, naming the folder and the page count, when a typed folder is unmapped (exit stays 0)', () => {
  withScratch((root) => {
    const vault = copySampleWithoutPack(root);
    const out = path.join(root, 'site');
    assert.equal(run(root, ['init', '--vault', vault, '--name', 'v4', '--yes', '--out', out]).code, 0);
    const cfgPath = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    delete cfg.folderMap.Sessions;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    for (const extra of [[], ['--no-check']]) {
      const build = run(root, ['build', 'v4', ...extra]);
      assert.equal(build.code, 0, build.all);
      assert.match(build.out, /warning: 3 page\(s\) in "Sessions" were not published/, extra.join(' '));
      assert.match(build.out, /"Sessions": "sessions"/);
    }
  });
});

test('B4-103-5: a vault with every folder mapped builds with no unmapped-folder warning', () => {
  withScratch((root) => {
    const vault = copySampleWithoutPack(root);
    assert.equal(run(root, ['init', '--vault', vault, '--name', 'v5', '--yes', '--out', path.join(root, 'site')]).code, 0);
    const build = run(root, ['build', 'v5', '--no-check']);
    assert.equal(build.code, 0, build.all);
    assert.doesNotMatch(build.out, /were not published/);
  });
});
