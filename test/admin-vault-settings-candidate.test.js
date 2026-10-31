'use strict';

/*
 * The whole-file text helpers for _meta/vault-config.yaml: the browser edits the file as plain
 * lines, and the candidate written back keeps the file's own byte order mark and line endings.
 * Expected bytes and messages are typed out by hand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  YAML_EDITOR_REASON,
  splitYamlFile,
  yamlEditorText,
  yamlLoneCrLine,
  buildYamlTextCandidate,
  buildYamlRestoreCandidate,
} = require('../src/admin/vaultsettingscandidate');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test('the reasons read like the vault-config.md ones, about the yaml file', () => {
  assert.deepEqual(YAML_EDITOR_REASON, {
    'not-utf8': "vault-config.yaml isn't valid UTF-8 text, so the panel won't edit it.",
    'mixed-eol': "vault-config.yaml mixes line endings in the file, so the panel won't edit it. Edit it by hand.",
    'too-large': 'vault-config.yaml is larger than the 64 KiB the panel can edit.',
    'lone-cr':
      "Line <N> of vault-config.yaml has a stray carriage return that the browser's editor would change, so the panel won't edit it. Edit it by hand.",
  });
});

test('a file with a BOM and CRLF line endings round-trips through the editor text unchanged', () => {
  const bytes = Buffer.concat([BOM, Buffer.from('version: 1\r\nplayer_site:\r\n  title: A\r\n')]);
  const split = splitYamlFile(bytes);
  assert.equal(split.ok, true);
  assert.equal(split.bom, true);
  assert.equal(split.eol, '\r\n');
  const text = yamlEditorText(split);
  assert.equal(text, 'version: 1\nplayer_site:\n  title: A');
  const cand = buildYamlTextCandidate(split, text);
  assert.equal(cand.ok, true);
  assert.ok(cand.bytes.equals(bytes));
});

test('an edit keeps the file\'s BOM and CRLF endings', () => {
  const bytes = Buffer.concat([BOM, Buffer.from('version: 1\r\nplayer_site:\r\n  title: A\r\n')]);
  const cand = buildYamlTextCandidate(splitYamlFile(bytes), 'version: 1\nplayer_site:\n  title: B\n');
  assert.equal(cand.ok, true);
  assert.ok(cand.bytes.equals(Buffer.concat([BOM, Buffer.from('version: 1\r\nplayer_site:\r\n  title: B\r\n')])));
  assert.equal(cand.text, 'version: 1\r\nplayer_site:\r\n  title: B\r\n');
});

test('a plain LF file without a BOM stays that way', () => {
  const bytes = Buffer.from('version: 1\nvault:\n  campaign: X\n');
  const split = splitYamlFile(bytes);
  assert.equal(split.bom, false);
  assert.equal(split.eol, '\n');
  assert.ok(buildYamlTextCandidate(split, yamlEditorText(split)).bytes.equals(bytes));
});

test('a stray carriage return on line 4 is found on line 4', () => {
  const split = splitYamlFile(Buffer.from('version: 1\nvault:\n  campaign: X\n  system: a\rb\n'));
  assert.equal(split.ok, true);
  assert.equal(yamlLoneCrLine(split), 4);
  assert.equal(yamlLoneCrLine(splitYamlFile(Buffer.from('version: 1\r\nvault: {}\r\n'))), null);
});

test('a file over 64 KiB is too large', () => {
  const big = Buffer.from('version: 1\n# ' + 'a'.repeat(65 * 1024) + '\n');
  assert.deepEqual(splitYamlFile(big), { ok: false, code: 'too-large' });
});

test('a file of exactly 64 KiB is not too large', () => {
  const head = 'version: 1\n# ';
  const exact = Buffer.from(head + 'a'.repeat(65536 - head.length - 1) + '\n');
  assert.equal(exact.length, 65536);
  assert.equal(splitYamlFile(exact).ok, true);
});

test('mixed line endings and invalid UTF-8 are refused with their codes', () => {
  assert.deepEqual(splitYamlFile(Buffer.from('version: 1\r\nvault:\n')), { ok: false, code: 'mixed-eol' });
  assert.deepEqual(splitYamlFile(Buffer.from([0x76, 0xff, 0x0a])), { ok: false, code: 'not-utf8' });
});

test('edited text with a carriage return, or that is not text, is refused with the vault-config.md messages', () => {
  const split = splitYamlFile(Buffer.from('version: 1\n'));
  assert.deepEqual(buildYamlTextCandidate(split, 'version: 1\r\n'), { ok: false, line: null, message: 'The edited text must use plain line breaks.' });
  assert.deepEqual(buildYamlTextCandidate(split, 42), { ok: false, line: null, message: "The edited text isn't valid text." });
  assert.deepEqual(buildYamlTextCandidate(split, 'a\uD800b'), { ok: false, line: null, message: "The edited text isn't valid text." });
});

test('a restore takes the backup\'s lines with the current file\'s BOM and line endings', () => {
  const cur = splitYamlFile(Buffer.concat([BOM, Buffer.from('version: 1\r\nvault: {}\r\n')]));
  const backup = Buffer.from('version: 1\nplayer_site:\n  title: Old\n');
  const r = buildYamlRestoreCandidate(cur, backup);
  assert.equal(r.ok, true);
  assert.equal(r.eolChanged, true);
  assert.ok(r.bytes.equals(Buffer.concat([BOM, Buffer.from('version: 1\r\nplayer_site:\r\n  title: Old\r\n')])));

  const same = buildYamlRestoreCandidate(splitYamlFile(Buffer.from('version: 1\n')), backup);
  assert.equal(same.eolChanged, false);
  assert.ok(same.bytes.equals(backup));
});

test('a restore from a backup that cannot be split is refused with its code', () => {
  const cur = splitYamlFile(Buffer.from('version: 1\n'));
  assert.deepEqual(buildYamlRestoreCandidate(cur, Buffer.from([0xff])), { ok: false, code: 'not-utf8' });
});
