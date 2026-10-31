'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

/*
 * The structure of the vault-config.yaml writer: it is a chokepoint of its own, a sibling of
 * vaultconfigwrite.js that never imports it (ADR 0033 section 4), and the build and check paths
 * never reach it.
 */

const ROOT = path.join(__dirname, '..');
const WRITER = path.join(ROOT, 'src', 'vault', 'vaultsettingswrite.js');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function scanRequires(source) {
  const specs = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  const stripped = stripComments(source);
  while ((m = re.exec(stripped))) specs.push(m[1]);
  return specs;
}

function jsFilesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFilesUnder(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function sourceFiles() {
  return ['src', 'bin', 'scripts'].flatMap((d) => jsFilesUnder(path.join(ROOT, d)));
}

function graphReaches(startFile, target) {
  const seen = new Set();
  const queue = [startFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === target) return true;
    let source;
    let req;
    try {
      source = fs.readFileSync(file, 'utf8');
      req = Module.createRequire(file);
    } catch {
      continue;
    }
    for (const spec of scanRequires(source)) {
      if (!spec.startsWith('.')) continue;
      let full;
      try {
        full = req.resolve(spec);
      } catch {
        continue;
      }
      if (full.startsWith(path.join(ROOT, 'src'))) queue.push(full);
    }
  }
  return false;
}

test('structural: one wx openSync, one each of writeSync/fsyncSync/renameSync/unlinkSync, no forbidden tokens', () => {
  const source = stripComments(fs.readFileSync(WRITER, 'utf8'));
  const forbidden = ['writeFileSync', 'appendFile', 'copyFile', 'rmSync', 'rm(', 'rmdir', 'truncate', 'chmod', 'createWriteStream', 'recursive', 'mkdir'];
  assert.deepEqual(
    forbidden.filter((t) => source.includes(t)),
    [],
  );
  const openCalls = source.match(/openSync\([^)]*\)/g) || [];
  assert.equal(openCalls.length, 1);
  assert.match(openCalls[0], /'wx'/);
  for (const token of ['writeSync(', 'fsyncSync(', 'renameSync(', 'unlinkSync(']) {
    const count = (source.match(new RegExp(token.replace('(', '\\('), 'g')) || []).length;
    assert.equal(count, 1, `expected exactly one ${token}, found ${count}`);
  }
});

test('vaultsettingswrite.js requires neither vaultconfigwrite, packreplace nor packwrite', () => {
  const specs = scanRequires(fs.readFileSync(WRITER, 'utf8'));
  for (const name of ['vaultconfigwrite', 'packreplace', 'packwrite']) {
    assert.deepEqual(
      specs.filter((s) => s.includes(name)),
      [],
      `must not require ${name}`,
    );
  }
});

test('only the settings editor and settings handlers require vaultsettingswrite', () => {
  const allowed = [path.join(ROOT, 'src', 'admin', 'handlers', 'vaultsettingseditor.js'), path.join(ROOT, 'src', 'admin', 'handlers', 'vaultsettings.js')];
  const users = sourceFiles().filter((f) => scanRequires(fs.readFileSync(f, 'utf8')).some((s) => /(^|\/)vaultsettingswrite(\.js)?$/.test(s)));
  assert.deepEqual(users.sort(), allowed.sort());
});

test('only the facade and the plan module name planSettingsText', () => {
  const allowed = [path.join(ROOT, 'src', 'generator', 'pinned.js'), path.join(ROOT, 'src', 'admin', 'vaultsettingsplan.js')];
  const users = sourceFiles().filter((f) => stripComments(fs.readFileSync(f, 'utf8')).includes('planSettingsText'));
  assert.deepEqual(users.sort(), allowed.sort());
});

test('graph walk: build, check, init and carry never reach the writer; serve-admin does (positive control)', () => {
  for (const entry of ['build.js', 'check.js', 'init.js', 'carry.js']) {
    const file = path.join(ROOT, 'src', 'cli', entry);
    assert.ok(fs.existsSync(file), `src/cli/${entry} must exist`);
    assert.equal(graphReaches(file, WRITER), false, `${entry} must never reach vaultsettingswrite.js`);
  }
  assert.equal(graphReaches(path.join(ROOT, 'src', 'cli', 'serve-admin.js'), WRITER), true, 'positive control: serve-admin.js must reach the writer');
});
