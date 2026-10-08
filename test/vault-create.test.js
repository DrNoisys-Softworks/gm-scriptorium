'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVault, inspectTarget, validateStarterRel, LITTER_FILES, LITTER_DIRS } = require('../src/vault/vaultcreate');
const { VaultUnreachableError } = require('../src/util/errors');

/*
 * The new-vault writer (docs/decisions/0048-new-campaign-vault.md, section 2). Every expected
 * message is written out by hand. Synthetic names only.
 */

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-vc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function where(root) {
  return { configPath: path.join(root, 'cfg', 'config.toml'), panelDir: path.join(root, 'cfg', 'panel') };
}

function starter() {
  return {
    dirs: ['_meta', 'Notes', 'Notes/Deep', 'Factions & Organizations'],
    files: [
      { rel: '_meta/a.md', data: Buffer.from('alpha\n') },
      { rel: 'Notes/Deep/b.md', data: Buffer.from('bravo ü\n') },
      { rel: 'Factions & Organizations/c.md', data: Buffer.from('charlie\n') },
      { rel: 'root.txt', data: Buffer.from('root\n') },
    ],
  };
}

function tree(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(path.join(d, e.name), r);
      } else {
        out.push(r);
      }
    }
  })(dir, '');
  return out.sort();
}

const FULL_TREE = ['Factions & Organizations/', 'Factions & Organizations/c.md', 'Notes/', 'Notes/Deep/', 'Notes/Deep/b.md', '_meta/', '_meta/a.md', 'root.txt'];

function assertRefusal(fn, stem, abs) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof VaultUnreachableError, `${err && err.constructor.name}: ${err && err.message}`);
    assert.equal(err.reason, 'new-vault');
    assert.equal(err.message.startsWith(`refusing to create a vault in ${abs}: ${stem}`), true, err.message);
    return true;
  });
}

/** Runs fn with fs[method] replaced; the replacement gets the call number (1 based) and the real function. */
function patched(t, method, replacement) {
  const real = fs[method];
  let calls = 0;
  fs[method] = function patchedFn(...args) {
    calls += 1;
    return replacement(calls, real, args);
  };
  t.after(() => {
    fs[method] = real;
  });
  return () => calls;
}

// --- the happy paths ---------------------------------------------------------------------------------

test('a folder that does not exist yet, under a parent that does: created, with everything the starter lists', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'New Campaign');
  assert.deepEqual(inspectTarget(target, where(root)), { state: 'missing', litter: [], missingAncestors: [] });
  const res = createVault(target, starter(), where(root));
  assert.equal(res.root, target);
  assert.equal(res.createdRoot, true);
  assert.deepEqual(res.createdAncestors, []);
  assert.deepEqual(tree(target), FULL_TREE);
  assert.equal(fs.readFileSync(path.join(target, 'Notes', 'Deep', 'b.md'), 'utf8'), 'bravo ü\n');
  assert.deepEqual(res.created, ['_meta/', 'Notes/', 'Notes/Deep/', 'Factions & Organizations/', '_meta/a.md', 'Notes/Deep/b.md', 'Factions & Organizations/c.md', 'root.txt']);
});

test('an empty folder is used as it is: createdRoot is false', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'empty');
  fs.mkdirSync(target);
  assert.deepEqual(inspectTarget(target, where(root)), { state: 'empty', litter: [], missingAncestors: [] });
  const res = createVault(target, starter(), where(root));
  assert.equal(res.createdRoot, false);
  assert.deepEqual(tree(target), FULL_TREE);
});

test('a folder holding only .obsidian/ counts as empty, and .obsidian is not touched', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'obs');
  fs.mkdirSync(path.join(target, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(target, '.obsidian', 'app.json'), '{"keep":true}');
  const before = fs.statSync(path.join(target, '.obsidian', 'app.json'));
  assert.deepEqual(inspectTarget(target, where(root)), { state: 'empty', litter: ['.obsidian/'], missingAncestors: [] });
  createVault(target, starter(), where(root));
  assert.equal(fs.readFileSync(path.join(target, '.obsidian', 'app.json'), 'utf8'), '{"keep":true}');
  assert.equal(fs.statSync(path.join(target, '.obsidian', 'app.json')).mtimeMs, before.mtimeMs);
  assert.deepEqual(tree(target), [...FULL_TREE, '.obsidian/', '.obsidian/app.json'].sort());
});

test('OS litter alone counts as empty, and its bytes and modified times never change', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'litter');
  fs.mkdirSync(target);
  const old = new Date('2001-02-03T04:05:06Z');
  const bytes = {};
  for (const name of ['desktop.ini', 'Thumbs.db', '.DS_Store']) {
    fs.writeFileSync(path.join(target, name), `litter ${name}`);
    fs.utimesSync(path.join(target, name), old, old);
    bytes[name] = `litter ${name}`;
  }
  assert.deepEqual(inspectTarget(target, where(root)).litter, ['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  createVault(target, starter(), where(root));
  for (const [name, text] of Object.entries(bytes)) {
    assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), text);
    assert.equal(fs.statSync(path.join(target, name)).mtime.getTime(), old.getTime(), name);
  }
});

test('the litter lists are frozen and hold exactly what the rules name', () => {
  assert.deepEqual([...LITTER_FILES], ['desktop.ini', 'Thumbs.db', '.DS_Store']);
  assert.deepEqual([...LITTER_DIRS], ['.obsidian']);
  assert.ok(Object.isFrozen(LITTER_FILES) && Object.isFrozen(LITTER_DIRS));
});

// --- the folder refusals -----------------------------------------------------------------------------

test('a folder that holds anything else is refused and left exactly as it was', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'busy');
  fs.mkdirSync(target);
  for (const name of ['zeta.md', 'alpha.md', 'mid.md', 'beta.md']) fs.writeFileSync(path.join(target, name), name);
  const before = tree(target);
  assertRefusal(() => createVault(target, starter(), where(root)), 'it is not empty (it holds alpha.md, beta.md, mid.md and 1 more)', target);
  assert.deepEqual(tree(target), before);
});

test('a folder with one stray file names it', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'one');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'notes.md'), 'x');
  fs.writeFileSync(path.join(target, 'desktop.ini'), 'x');
  assertRefusal(() => inspectTarget(target, where(root)), 'it is not empty (it holds notes.md)', target);
});

test('a file where the folder should be is refused', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'afile');
  fs.writeFileSync(target, 'x');
  assertRefusal(() => createVault(target, starter(), where(root)), 'it is a file', target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
});

test('a symbolic link, even to an empty folder, is refused', (t) => {
  const root = scratch(t);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link, 'dir');
  assertRefusal(() => createVault(link, starter(), where(root)), 'it is a link or junction', link);
  assert.deepEqual(tree(real), []);
});

test('a filesystem root is refused', (t) => {
  const root = scratch(t);
  const fsRoot = path.parse(root).root;
  assertRefusal(() => inspectTarget(fsRoot, where(root)), 'it is a filesystem root', fsRoot);
});

test('a relative path is refused', (t) => {
  const root = scratch(t);
  assert.throws(() => inspectTarget('relative/dir', where(root)), (err) => err instanceof VaultUnreachableError && /it is not a full path/.test(err.message));
});

test('a folder inside an existing vault is refused, at any depth', (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  fs.mkdirSync(path.join(vault, 'Notes'));
  assertRefusal(() => createVault(path.join(vault, 'Notes'), starter(), where(root)), `it is inside the vault at ${vault}`, path.join(vault, 'Notes'));
  assertRefusal(() => createVault(path.join(vault, 'new'), starter(), where(root)), `it is inside the vault at ${vault}`, path.join(vault, 'new'));
  assertRefusal(() => createVault(path.join(vault, 'a', 'b', 'c'), starter(), where(root)), `it is inside the vault at ${vault}`, path.join(vault, 'a', 'b', 'c'));
  assert.equal(fs.existsSync(path.join(vault, 'a')), false, 'no level of a refused path is created');
});

test('a folder inside the vault is refused when the path reaches it through a symlink', (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(vault, alias, 'dir');
  const target = path.join(alias, 'new');
  assertRefusal(() => createVault(target, starter(), where(root)), `it is inside the vault at ${vault}`, target);
  assert.deepEqual(tree(vault), ['_meta/', '_meta/vault-config.md']);
});

test('a folder inside the settings folder, or the panel folder, is refused; so is one that would hold them', (t) => {
  const root = scratch(t);
  const w = where(root);
  fs.mkdirSync(w.panelDir, { recursive: true });
  const cfgDir = path.dirname(w.configPath);
  assertRefusal(() => createVault(path.join(cfgDir, 'vault'), starter(), w), `it is inside GM-Scriptorium's own settings folder (${cfgDir})`, path.join(cfgDir, 'vault'));
  assertRefusal(() => inspectTarget(path.join(w.panelDir, 'x'), { configPath: path.join(root, 'elsewhere', 'config.toml'), panelDir: w.panelDir }), `it is inside GM-Scriptorium's own settings folder (${w.panelDir})`, path.join(w.panelDir, 'x'));
  // the target holds the config file, and the panel folder
  assertRefusal(() => inspectTarget(root, w), `it would hold GM-Scriptorium's own settings folder (`, root);
  assert.deepEqual(fs.readdirSync(cfgDir).sort(), ['panel']);
});

// --- missing ancestor folders (created level by level, at commit only) ---------------------------------

test('missing ancestor folders are listed by inspectTarget, top first, and created level by level', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'one', 'two', 'New Campaign');
  assert.deepEqual(inspectTarget(target, where(root)), {
    state: 'missing',
    litter: [],
    missingAncestors: [path.join(root, 'one'), path.join(root, 'one', 'two')],
  });
  assert.equal(fs.existsSync(path.join(root, 'one')), false, 'inspecting creates nothing');
  const calls = [];
  const real = fs.mkdirSync;
  fs.mkdirSync = function spy(...args) {
    calls.push(args);
    return real.apply(this, args);
  };
  t.after(() => {
    fs.mkdirSync = real;
  });
  const res = createVault(target, starter(), where(root));
  fs.mkdirSync = real;
  assert.deepEqual(res.createdAncestors, [path.join(root, 'one'), path.join(root, 'one', 'two')]);
  assert.equal(res.createdRoot, true);
  assert.deepEqual(tree(target), FULL_TREE);
  assert.deepEqual(calls.slice(0, 3).map((a) => a[0]), [path.join(root, 'one'), path.join(root, 'one', 'two'), target]);
  for (const args of calls) assert.equal(args.length, 1, `mkdirSync was called with options: ${JSON.stringify(args)}`);
});

test('an ancestor that appears before its level is made (EEXIST) is a refusal that lists what was created', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'one', 'two', 'three', 'New');
  const real = fs.mkdirSync;
  patched(t, 'mkdirSync', (n, original, args) => {
    // the second level is taken by someone else just before we make it
    if (n === 2) {
      original(args[0]);
      return original(args[0]);
    }
    return original(...args);
  });
  assert.throws(
    () => createVault(target, starter(), where(root)),
    (err) => {
      assert.ok(err instanceof VaultUnreachableError);
      assert.equal(err.reason, 'new-vault');
      assert.equal(
        err.message,
        `stopped creating the vault in ${target}: ${path.join(root, 'one', 'two')} already exists; created before stopping: ${path.join(root, 'one')}. Nothing was removed. Delete that folder, or choose a new one, and try again.`,
      );
      return true;
    },
  );
  fs.mkdirSync = real;
  assert.deepEqual(tree(root), ['one/', 'one/two/']);
});

test('an ancestor level that resolves somewhere other than a new folder inside its parent stops the creation', (t) => {
  const root = scratch(t);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const target = path.join(root, 'one', 'two', 'New');
  const realpath = fs.realpathSync;
  patched(t, 'realpathSync', (n, original, args) => {
    if (args[0] === path.join(root, 'one')) return elsewhere;
    return original(...args);
  });
  assert.throws(() => createVault(target, starter(), where(root)), (err) => {
    assert.ok(err instanceof VaultUnreachableError);
    assert.match(err.message, /^stopped creating the vault in /);
    assert.ok(err.message.includes(`created before stopping: ${path.join(root, 'one')}.`), err.message);
    return true;
  });
  fs.realpathSync = realpath;
  assert.equal(fs.existsSync(path.join(root, 'one', 'two')), false);
});

test('an existing ancestor that is a file is refused, and nothing is created', (t) => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'plain'), 'x');
  const target = path.join(root, 'plain', 'sub', 'New');
  assertRefusal(() => createVault(target, starter(), where(root)), `${path.join(root, 'plain')} is a file, not a folder`, target);
  assert.deepEqual(tree(root), ['plain']);
});

test('recursive mkdir is never used: not even to make the missing levels', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'a', 'b', 'c', 'New');
  const seen = [];
  patched(t, 'mkdirSync', (n, original, args) => {
    seen.push(args);
    return original(...args);
  });
  createVault(target, starter(), where(root));
  assert.ok(seen.length >= 8);
  assert.ok(seen.every((a) => a.length === 1));
});

// --- failures part-way ---------------------------------------------------------------------------------

function failureMessage(target, created) {
  return `stopped creating the vault in ${target}: REASON; created before stopping: ${created.join(', ')}. Nothing was removed. Delete that folder, or choose a new one, and try again.`;
}

test('an I/O error on the third write stops, lists exactly what was created, and removes nothing', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'half');
  patched(t, 'writeFileSync', (n, original, args) => {
    if (n === 3) throw Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: 'EACCES' });
    return original(...args);
  });
  assert.throws(
    () => createVault(target, starter(), where(root)),
    (err) => {
      assert.ok(err instanceof VaultUnreachableError);
      assert.equal(err.reason, 'new-vault');
      const created = [target, 'a', 'b', 'c', 'd', 'e', 'f'];
      void created;
      assert.equal(
        err.message,
        failureMessage(target, [
          target,
          path.join(target, '_meta'),
          path.join(target, 'Notes'),
          path.join(target, 'Notes', 'Deep'),
          path.join(target, 'Factions & Organizations'),
          path.join(target, '_meta', 'a.md'),
          path.join(target, 'Notes', 'Deep', 'b.md'),
        ]).replace('REASON', "EACCES: permission denied, open 'x'"),
      );
      return true;
    },
  );
  assert.deepEqual(tree(target), ['Factions & Organizations/', 'Notes/', 'Notes/Deep/', 'Notes/Deep/b.md', '_meta/', '_meta/a.md']);
});

test('EBUSY on a folder is reported the same way', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'busy');
  patched(t, 'mkdirSync', (n, original, args) => {
    if (n === 3) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return original(...args);
  });
  assert.throws(() => createVault(target, starter(), where(root)), (err) => {
    assert.ok(err instanceof VaultUnreachableError);
    assert.equal(err.message, failureMessage(target, [target, path.join(target, '_meta')]).replace('REASON', 'EBUSY: resource busy or locked'));
    return true;
  });
  assert.deepEqual(tree(target), ['_meta/']);
});

test('a file that appears before it is written (EEXIST) is a refusal, and its content is never replaced', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'raced');
  patched(t, 'mkdirSync', (n, original, args) => {
    const out = original(...args);
    if (args[0] === path.join(target, '_meta')) fs.writeFileSync(path.join(target, '_meta', 'a.md'), 'KEEP');
    return out;
  });
  assert.throws(() => createVault(target, starter(), where(root)), (err) => {
    assert.ok(err instanceof VaultUnreachableError);
    assert.match(err.message, new RegExp(`^stopped creating the vault in .*: .*a\\.md already exists; created before stopping: `));
    assert.ok(err.message.endsWith('Nothing was removed. Delete that folder, or choose a new one, and try again.'));
    return true;
  });
  assert.equal(fs.readFileSync(path.join(target, '_meta', 'a.md'), 'utf8'), 'KEEP');
});

test('a folder that appears before it is made is a refusal, not a tolerated EEXIST', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'raced2');
  fs.mkdirSync(target);
  patched(t, 'mkdirSync', (n, original, args) => {
    if (args[0] === path.join(target, 'Notes')) original(args[0]);
    return original(...args);
  });
  assert.throws(() => createVault(target, starter(), where(root)), (err) => err instanceof VaultUnreachableError && /already exists/.test(err.message));
});

test('a parent that resolves outside the new vault stops the write', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'escape');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const realpath = fs.realpathSync;
  patched(t, 'realpathSync', (n, original, args) => {
    if (args[0] === path.join(target, 'Notes')) return outside;
    return original(...args);
  });
  assert.throws(() => createVault(target, starter(), where(root)), (err) => err instanceof VaultUnreachableError && /resolves outside the new vault/.test(err.message));
  fs.realpathSync = realpath;
  assert.deepEqual(fs.readdirSync(outside), []);
});

// --- the paths the starter lists are checked before anything is written ----------------------------------

const BAD_RELS = [
  ['a parent segment', '../x.md'],
  ['a parent segment in the middle', 'a/../x.md'],
  ['an absolute path', '/a.md'],
  ['a drive letter', 'C:a.md'],
  ['a backslash', 'a\\b.md'],
  ['a reserved name', 'CON'],
  ['a reserved name with an extension', 'con.md'],
  ['a reserved name in a folder', 'sub/LPT1.txt'],
  ['a trailing dot', 'a.'],
  ['a trailing space', 'a '],
  ['a colon', 'a:b'],
  ['an asterisk', 'a*b.md'],
  ['a question mark', 'a?b.md'],
  ['a quote', 'a"b.md'],
  ['an angle bracket', 'a<b.md'],
  ['a pipe', 'a|b.md'],
  ['a control character', 'a\u0001b.md'],
  ['a console device', 'CONIN$'],
  ['a console device with an extension', 'conout$.md'],
  ['a litter name', 'desktop.ini'],
  ['a litter folder', '.obsidian/app.json'],
  ['an empty segment', 'a//b.md'],
  ['an empty path', ''],
];

for (const [label, rel] of BAD_RELS) {
  test(`a starter path with ${label} is refused before anything exists: ${JSON.stringify(rel)}`, (t) => {
    const root = scratch(t);
    const target = path.join(root, 'New', 'Deeper');
    const s = starter();
    s.files.push({ rel, data: Buffer.from('x') });
    assert.equal(validateStarterRel(rel), false);
    assert.throws(() => createVault(target, s, where(root)), (err) => {
      assert.ok(err instanceof VaultUnreachableError);
      assert.equal(err.reason, 'new-vault');
      assert.match(err.message, /^refusing to create a vault in .*: its starter holds a path that is not safe to create /);
      return true;
    });
    assert.deepEqual(tree(root), [], 'not even the root or an ancestor exists');
  });
}

test('two starter paths that differ only by case are refused, and so is a file named like a folder', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'New');
  const s = starter();
  s.files.push({ rel: 'ROOT.txt', data: Buffer.from('x') });
  assert.throws(() => createVault(target, s, where(root)), /not safe to create/);
  const s2 = starter();
  s2.files.push({ rel: 'notes', data: Buffer.from('x') });
  assert.throws(() => createVault(target, s2, where(root)), /not safe to create/);
  assert.deepEqual(tree(root), []);
});

test('a file whose folder the starter never lists is refused; so is a folder listed before its parent', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'New');
  const s = starter();
  s.files.push({ rel: 'Unlisted/x.md', data: Buffer.from('x') });
  assert.throws(() => createVault(target, s, where(root)), /not safe to create/);
  assert.throws(() => createVault(target, { dirs: ['A/B', 'A'], files: [] }, where(root)), /not safe to create/);
  assert.deepEqual(tree(root), []);
});

test('good starter paths are accepted: ampersands, spaces, non-ASCII and dotted names', () => {
  for (const rel of ['Factions & Organizations', 'Items & Artifacts/x.md', 'a b/c d.md', 'üï/é.md', 'v1.2/notes.txt', 'conx.md', '_meta/NOTICE.txt']) {
    assert.equal(validateStarterRel(rel), true, rel);
  }
});

test('a parent swapped for a link between the check and the write is a listed failure, and nothing is removed', (t) => {
  const root = scratch(t);
  const target = path.join(root, 'swapped');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  patched(t, 'writeFileSync', (n, original, args) => {
    if (String(args[0]).endsWith(path.join('Deep', 'b.md'))) {
      const deep = path.join(target, 'Notes', 'Deep');
      fs.rmdirSync(deep);
      fs.symlinkSync(outside, deep, 'dir');
    }
    return original(...args);
  });
  assert.throws(() => createVault(target, starter(), where(root)), (err) => {
    assert.ok(err instanceof VaultUnreachableError);
    assert.match(err.message, /^stopped creating the vault in .*: .*b\.md landed outside the new vault \(.*outside.*b\.md\); it was not removed; created before stopping: /);
    assert.ok(err.message.includes(path.join(target, 'Notes', 'Deep', 'b.md')), 'the file is in the list');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(outside, 'b.md'), 'utf8'), 'bravo \u00fc\n', 'the escaped file is left, never deleted');
});
