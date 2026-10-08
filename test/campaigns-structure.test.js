'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * ADR 0050: the structural pins on the new admin modules. src/admin/campaignstate.js is pure data
 * and requires nothing; src/admin/handlers/campaigns.js holds no write of its own and requires
 * exactly the modules listed here, so the only route from it to the config file is
 * src/setup/register.js. The token list is copied from test/setup-structure.test.js (PW15), not
 * required. Every scan has a positive control.
 */

const ROOT = path.join(__dirname, '..');
const CAMPAIGNS_HANDLER = path.join(ROOT, 'src', 'admin', 'handlers', 'campaigns.js');
const CAMPAIGN_STATE = path.join(ROOT, 'src', 'admin', 'campaignstate.js');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractRequireSpecs(source) {
  const specs = [];
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  const stripped = stripComments(source);
  while ((m = re.exec(stripped))) specs.push(m[2]);
  return specs;
}

const WRITE_TOKENS = [
  'writeFileSync', 'writeFile(', 'appendFileSync', 'appendFile(', 'copyFileSync', 'copyFile(', 'rmSync', 'rm(', 'unlinkSync', 'unlink(',
  'mkdirSync', 'mkdir(', 'renameSync', 'rename(', 'chmodSync', 'chmod(', 'truncateSync', 'truncate(', 'createWriteStream',
];

function writeTokensIn(source) {
  const stripped = stripComments(source);
  return WRITE_TOKENS.filter((t) => stripped.includes(t));
}

const DYNAMIC_RE = /\brequire\(\s*[^'"\s]|\bmodule\.require\b|\brequire\.cache\b|\bprocess\.mainModule\b|\brequire\.resolve\b|\bimport\(/;

test('PW15 write tokens are absent from handlers/campaigns.js and campaignstate.js (every write goes through register.js and preview.js)', () => {
  for (const f of [CAMPAIGNS_HANDLER, CAMPAIGN_STATE]) {
    assert.deepEqual(writeTokensIn(fs.readFileSync(f, 'utf8')), [], path.relative(ROOT, f));
  }
});

test('positive control: the token scan finds a planted write and ignores a comment', () => {
  assert.deepEqual(writeTokensIn("fs.writeFileSync('x', 'y');"), ['writeFileSync']);
  assert.deepEqual(writeTokensIn("const ok = confirm('sure');"), ['rm(']);
  assert.deepEqual(writeTokensIn('// never rmSync here\nconst a = 1;'), []);
});

test('campaignstate.js requires nothing', () => {
  assert.deepEqual(extractRequireSpecs(fs.readFileSync(CAMPAIGN_STATE, 'utf8')), []);
  assert.deepEqual(extractRequireSpecs("const a = require('./b'); const c = require('fs');"), ['./b', 'fs'], 'positive control');
  assert.equal(DYNAMIC_RE.test(stripComments(fs.readFileSync(CAMPAIGN_STATE, 'utf8'))), false);
});

test('handlers/campaigns.js requires exactly the listed modules, in order, and no computed require', () => {
  const source = fs.readFileSync(CAMPAIGNS_HANDLER, 'utf8');
  assert.deepEqual(extractRequireSpecs(source), [
    'path',
    '../respond',
    '../body',
    '../context',
    '../setupmode',
    '../campaignstate',
    '../preview',
    '../../setup/register',
    '../../setup/probe',
    '../../cli/args',
    '../../config/resolve',
    '../assets',
    './remote',
    '../../setup/checks',
  ]);
  assert.equal(DYNAMIC_RE.test(stripComments(source)), false);
  assert.equal(DYNAMIC_RE.test('const x = require(name);'), true, 'positive control');
});

test('the campaigns handler never names the config writer, the emitter or fs', () => {
  const source = stripComments(fs.readFileSync(CAMPAIGNS_HANDLER, 'utf8'));
  for (const name of ['writeConfigFile', 'serializeConfig', 'addCampaign', 'removeCampaign(config', 'setDefaultCampaign']) {
    assert.equal(source.includes(name), false, name);
  }
  assert.equal(/\brequire\(\s*['"](?:node:)?fs['"]/.test(source), false);
});

test('positive control: a planted require list is detected as different', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-campaigns-structure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planted = path.join(dir, 'planted.js');
  fs.writeFileSync(planted, "const fs = require('fs');\nconst w = require('../../config/write');\n");
  assert.ok(extractRequireSpecs(fs.readFileSync(planted, 'utf8')).includes('../../config/write'));
  assert.notDeepEqual(extractRequireSpecs(fs.readFileSync(planted, 'utf8')), extractRequireSpecs(fs.readFileSync(CAMPAIGNS_HANDLER, 'utf8')));
});
