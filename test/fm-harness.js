'use strict';

/*
 * ADR 0034 test harness. Not a test file itself (test/**\/*.test.js does not match this name),
 * shared by every fm-*.test.js file.
 *
 * NFR-FM-07 / project NFR-11: every planted file is written at TEST TIME into
 * fs.mkdtempSync(...), with explicit bytes (never relying on the checkout's own line endings for
 * '\r\n', a BOM, or a bare '\r'). Names are invented (Planted, Hero, Note, Secret, Scribe) --
 * never a real campaign name. The payload text below is the only executable text anywhere in this
 * suite, and it does nothing beyond writing one marked sentinel file inside the mkdtemp root: this
 * is authorised defensive testing of Scriptorium's own software, never run against a real vault or
 * a real config.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'scriptorium.js');
const CRLF = '\r\n';
const LF = '\n';
const BOM = '﻿';

/** A fresh scratch root: <tmp>/scriptorium-fm-XXXXXX. Caller removes it (recursive, force). */
function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fm-'));
}

function sentinelsDir(root) {
  const dir = path.join(root, 'sentinels');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** One marker per call: 'FMMARK' + 12 random hex characters, for AC-FM-11 hygiene grepping. */
function makeMarker() {
  return `FMMARK${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * The payload: the only executable text allowed anywhere in this suite. Writes `sentinelAbs`
 * (JSON.stringify'd, so any path is safe) with content 'ran', then a trailing comment carrying
 * the marker for grep-based attribution. Callers use one sentinel path per (location, variant,
 * command) tuple so a hit can be attributed to exactly one cell.
 */
function payload(sentinelAbs, marker) {
  return `require('fs').writeFileSync(${JSON.stringify(sentinelAbs)}, 'ran'); /* ${marker} */`;
}

/**
 * Same payload, plus a syntactically-inert `aliases: 0;` labelled-statement line, needed for
 * every fixture that must also satisfy the generator's own scanAllNotes aliases regex
 * (/^(gm_)?aliases:/m against the raw file text -- scanner.js:341-361).
 *
 * Why the ";" and the extra line, not a plain "aliases: [...]" mixed into the payload: gray-
 * matter's javascript engine wraps the fenced block as `(function(){ return <block>; }())`
 * (lib/engines.js:36-54). A block whose first statement reads as `aliases: <expr>` makes that
 * wrap a SyntaxError ("return label:" is not valid JS), and gray-matter's own "retry unwrapped"
 * catch path does not actually recover (it re-evals the same already-wrapped string), so the
 * parse throws and scanAllNotes's try/catch silently drops the payload without running it
 * (confirmed live against PARENT while gathering AC-FM-01 evidence). Terminating the payload
 * statement with an explicit ";" first, then a separate "aliases: 0;" line (a harmless labelled
 * expression statement) keeps the wrap valid.
 */
function payloadWithAliases(sentinelAbs, marker) {
  return `${payload(sentinelAbs, marker)}\naliases: 0;`;
}

function gmAliasesPayload(sentinelAbs, marker) {
  return `${payload(sentinelAbs, marker)}\ngm_aliases: 0;`;
}

/**
 * Builds a frontmatter-fenced file's exact bytes.
 *
 * @param {object} opts
 * @param {string} opts.tag raw fence tag text (e.g. 'js', ' js', '', 'yaml')
 * @param {string} [opts.body] the block body (default a harmless YAML-shaped comment; irrelevant
 *   for a refused tag, since the predicate never looks at the block)
 * @param {boolean} [opts.crlf] use \r\n as every line terminator
 * @param {boolean} [opts.bom] prepend one U+FEFF
 * @param {boolean} [opts.bareCr] append a bare \r immediately after the tag, before the \n
 *   (the `---\rjs` dangerous-direction case)
 * @param {boolean} [opts.noClose] omit the closing fence entirely (the tag line's own \n IS
 *   still present unless opts.noNewline is also set)
 * @param {boolean} [opts.noNewline] the tag line has no trailing \n at all (gray-matter's
 *   slice(0,-1) quirk / the fence predicate's "no \n anywhere" branch)
 * @returns {Buffer}
 */
function fenceFile({ tag, body = 'type: npc\ntitle: Planted\n', crlf = false, bom = false, bareCr = false, noClose = false, noNewline = false }) {
  const nl = crlf ? CRLF : LF;
  let out = bom ? BOM : '';
  out += '---' + tag;
  if (bareCr) out += '\r';
  if (noNewline) {
    return Buffer.from(out, 'utf8');
  }
  out += nl;
  out += body.split('\n').join(nl);
  if (!noClose) {
    out += '---' + nl;
  }
  return Buffer.from(out, 'utf8');
}

/** Writes `buf` (Buffer or string) to `absPath`, creating parent directories. */
function writeBytes(absPath, buf) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buf);
}

/** Writes a plain (non-fenced) markdown file with ordinary YAML frontmatter. */
function writePlainMd(absPath, { type = 'npc', title = 'Placeholder', extra = '' } = {}) {
  writeBytes(absPath, `---\ntype: ${type}\ntitle: ${title}\n${extra}---\nAn ordinary page.\n`);
}

/** The site config (vault.config.json), outside the vault. check.js requires both folderMap and excludeDirs. */
function siteConfigJson({ vaultPath, outputDir, folderMap = { NPCs: 'npcs', PCs: 'pcs', GM: 'gm' }, excludeDirs = [] }) {
  return {
    siteTitle: 'FM Hardening Fixture',
    siteUrl: 'https://example.invalid',
    vaultPath,
    outputDir,
    attachmentsDir: '_attachments',
    folderMap,
    excludeDirs,
  };
}

/** Writes vault.config.json + config.toml for one campaign, returns { configPath, finalOut, siteConfigPath }. */
function writeCampaignConfig(root, { campaign = 'fm', vaultPath, folderMap, excludeDirs }) {
  const siteDir = path.join(root, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const siteConfigPath = path.join(siteDir, 'vault.config.json');
  const finalOut = path.join(root, 'out');
  fs.writeFileSync(siteConfigPath, JSON.stringify(siteConfigJson({ vaultPath, outputDir: path.join(root, 'site-declared-out'), folderMap, excludeDirs }), null, 2));
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      'config_version = 1',
      `default_campaign = "${campaign}"`,
      '',
      `[campaigns.${campaign}]`,
      `vault = '${vaultPath}'`,
      `site_config = '${siteConfigPath}'`,
      `output = '${finalOut}'`,
      '',
    ].join('\n'),
  );
  return { configPath, finalOut, siteConfigPath, campaign };
}

/** Env isolation identical to test/gm-link-gate.test.js's scratchEnv: never touch a real config.toml. */
function scratchEnv(root) {
  const env = { ...process.env };
  delete env.SCRIPTORIUM_PROFILE;
  env.SCRIPTORIUM_CONFIG = path.join(root, 'unused-scriptorium-config.toml');
  env.APPDATA = path.join(root, 'unused-appdata');
  env.XDG_CONFIG_HOME = path.join(root, 'unused-xdg-config-home');
  return env;
}

/** Spawns `node bin/scriptorium.js <args>` with an isolated env (merged over scratchEnv(root)). */
function run(root, args, opts = {}) {
  const env = { ...scratchEnv(root), ...(opts.env || {}) };
  const res = spawnSync(process.execPath, [BIN, ...args], {
    timeout: 60000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    ...opts,
    env,
  });
  return res;
}

module.exports = {
  BIN,
  CRLF,
  LF,
  BOM,
  mkRoot,
  sentinelsDir,
  makeMarker,
  payload,
  payloadWithAliases,
  gmAliasesPayload,
  fenceFile,
  writeBytes,
  writePlainMd,
  siteConfigJson,
  writeCampaignConfig,
  scratchEnv,
  run,
};
