'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ConfigError, ScriptoriumError } = require('../util/errors');
const { validateStarterRel } = require('../vault/vaultcreate');
const { parseFrontmatterText } = require('../vault/read');
const { validateSystem } = require('./validate');

/*
 * docs/decisions/0048-new-campaign-vault.md, sections 1 and 3: the starter template. This module is
 * READ-ONLY: it loads and checks the template folder, then renders one system's starter in memory.
 * The only module that writes the result to disk is src/vault/vaultcreate.js.
 *
 * The template is a folder shipped inside the executable: manifest.json, files shared by every
 * game system under common/, and files that differ under systems/<id>/. Every file is checked
 * against the manifest's sha256 and token counts before anything is rendered, so a template that
 * does not match its manifest refuses to create anything.
 *
 * Rendering replaces only the placeholders the manifest declares, in one pass, so what the GM
 * typed is never scanned again. The title is never escaped. The upstream scaffold does not
 * escape it either, and byte parity with the scaffold is the point. Instead every render is
 * read back: the pages are parsed, and the title must come back exactly as typed, or the title
 * is refused before anything is written.
 */

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'assets', 'vault-template');
const MANIFEST = 'manifest.json';
const PROBE = 'Probe';
const PROBE_DATE = '2000-01-01';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^\{\{SCRIPTORIUM_[A-Z_]+\}\}$/;
const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const TITLE_REFUSAL = "site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes";

const cache = new Map();

function integrityError(rel) {
  return new ScriptoriumError(`the new-campaign starter in this executable failed its integrity check: ${rel}; nothing was written`);
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isText(x) {
  return typeof x === 'string' && x !== '';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function countOf(text, token) {
  return text.split(token).length - 1;
}

function readManifest(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new ScriptoriumError('this build has no new-campaign starter');
    throw integrityError(MANIFEST);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw integrityError(MANIFEST);
  }
}

/** Shape checks on the manifest itself. Throws integrityError(<field>) for the first defect. */
function validateManifest(m) {
  if (!isObject(m) || m.schema !== 1) throw integrityError('schema');
  for (const key of ['templateVersion', 'gm_apprentice_version', 'license', 'attribution']) {
    if (!isText(m[key])) throw integrityError(key);
  }
  if (!isObject(m.upstream)) throw integrityError('upstream');
  for (const key of ['repository', 'script', 'pluginVersion', 'command', 'clock']) {
    if (!isText(m.upstream[key])) throw integrityError(`upstream.${key}`);
  }
  if (typeof m.upstream.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.upstream.commit)) throw integrityError('upstream.commit');

  if (!Array.isArray(m.placeholders) || m.placeholders.length === 0) throw integrityError('placeholders');
  const tokens = new Set();
  const values = new Set();
  for (const p of m.placeholders) {
    if (!isObject(p) || typeof p.token !== 'string' || !TOKEN_RE.test(p.token) || !['campaign', 'created'].includes(p.value) || !isText(p.rule)) {
      throw integrityError('placeholders');
    }
    if (tokens.has(p.token) || values.has(p.value)) throw integrityError('placeholders');
    tokens.add(p.token);
    values.add(p.value);
  }

  if (!isObject(m.systems) || !isObject(m.systems.none)) throw integrityError('systems');
  for (const [id, system] of Object.entries(m.systems)) {
    if (!SYSTEM_ID_RE.test(id) || !isObject(system) || !Array.isArray(system.dirs) || !isObject(system.files)) throw integrityError('systems');
    const dirs = new Set();
    for (const d of system.dirs) {
      if (!validateStarterRel(d)) throw integrityError(String(d));
      const at = d.lastIndexOf('/');
      if (at >= 0 && !dirs.has(d.slice(0, at))) throw integrityError(d);
      dirs.add(d);
    }
    const lowered = new Set();
    for (const [rel, entry] of Object.entries(system.files)) {
      if (!validateStarterRel(rel) || lowered.has(rel.toLowerCase()) || dirs.has(rel)) throw integrityError(rel);
      lowered.add(rel.toLowerCase());
      const at = rel.lastIndexOf('/');
      if (at >= 0 && !dirs.has(rel.slice(0, at))) throw integrityError(rel);
      const stored = isObject(entry) ? entry.store : null;
      if (typeof stored !== 'string' || (stored !== `common/${rel}` && stored !== `systems/${id}/${rel}`) || !validateStarterRel(stored)) {
        throw integrityError(rel);
      }
      if (typeof entry.sha256 !== 'string' || !SHA_RE.test(entry.sha256) || !['upstream', 'scriptorium'].includes(entry.origin) || !isObject(entry.tokens)) {
        throw integrityError(rel);
      }
      for (const [token, n] of Object.entries(entry.tokens)) {
        if (!tokens.has(token) || !Number.isInteger(n) || n < 1) throw integrityError(rel);
      }
    }
  }

  if (!Array.isArray(m.deviations)) throw integrityError('deviations');
  for (const d of m.deviations) {
    if (!isObject(d) || !isText(d.file) || !isText(d.from) || typeof d.to !== 'string' || !isText(d.why) || d.from === d.to) throw integrityError('deviations');
    if (d.from.includes('{{SCRIPTORIUM_') || d.to.includes('{{SCRIPTORIUM_')) throw integrityError('deviations');
  }
  if (!Array.isArray(m.parity)) throw integrityError('parity');
  for (const v of m.parity) {
    if (!isObject(v) || !Object.prototype.hasOwnProperty.call(m.systems, v.system) || !isText(v.name) || !isText(v.campaign) || !DATE_RE.test(v.created) || !isObject(v.files)) {
      throw integrityError('parity');
    }
    for (const s of Object.values(v.files)) if (typeof s !== 'string' || !SHA_RE.test(s)) throw integrityError('parity');
  }
  if (!Array.isArray(m.rulesScan)) throw integrityError('rulesScan');
  for (const r of m.rulesScan) {
    if (!isObject(r) || !isText(r.store) || !isText(r.note)) throw integrityError('rulesScan');
  }
}

/**
 * Reads every listed file and checks it. File-level defects are collected as store paths; they do
 * not stop the walk, so the full check can report them together.
 *
 * @returns {{ manifest: object, loaded: Map<string, { buf: Buffer, text: string }>, problems: Set<string> }}
 */
function readAndCheck(dir) {
  const manifest = readManifest(dir);
  validateManifest(manifest);
  const tokens = manifest.placeholders.map((p) => p.token);
  const problems = new Set();
  const loaded = new Map();
  const claimed = new Map();

  for (const system of Object.values(manifest.systems)) {
    for (const entry of Object.values(system.files)) {
      const first = claimed.get(entry.store);
      if (first) {
        if (first.sha256 !== entry.sha256 || JSON.stringify(first.tokens) !== JSON.stringify(entry.tokens)) problems.add(entry.store);
        continue;
      }
      claimed.set(entry.store, entry);
      const full = path.join(dir, ...entry.store.split('/'));
      let buf;
      try {
        if (!fs.lstatSync(full).isFile()) throw new Error('not a file');
        buf = fs.readFileSync(full);
      } catch {
        problems.add(entry.store);
        continue;
      }
      if (sha256(buf) !== entry.sha256) {
        problems.add(entry.store);
        continue;
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
      } catch {
        problems.add(entry.store);
        continue;
      }
      let rest = text;
      for (const token of tokens) {
        const expected = entry.tokens[token] || 0;
        if (countOf(text, token) !== expected) problems.add(entry.store);
        rest = rest.split(token).join('');
      }
      if (rest.includes('{{SCRIPTORIUM_')) problems.add(entry.store);
      loaded.set(entry.store, { buf, text });
    }
  }

  // Every deviation must apply exactly once, to the stored text of its file, in every system.
  for (const dev of manifest.deviations) {
    for (const system of Object.values(manifest.systems)) {
      const entry = system.files[dev.file];
      if (!entry) throw integrityError('deviations');
      const file = loaded.get(entry.store);
      if (file && countOf(file.text, dev.from) !== 1) throw integrityError('deviations');
    }
  }
  return { manifest, loaded, problems };
}

function buildTemplate(dir, manifest, loaded) {
  const placeholders = manifest.placeholders.map((p) => ({ token: p.token, value: p.value }));
  const systems = new Map();
  for (const [id, system] of Object.entries(manifest.systems)) {
    const files = Object.keys(system.files)
      .sort()
      .map((rel) => {
        const entry = system.files[rel];
        const file = loaded.get(entry.store);
        return { rel, origin: entry.origin, text: file.text, buf: file.buf };
      });
    systems.set(id, { dirs: [...system.dirs], files });
  }
  return { dir, manifest, placeholders, systems, deviations: manifest.deviations.map((d) => ({ ...d })) };
}

/**
 * Loads the template, checking every listed file's sha256 and token counts. Cached by folder.
 * It reads only the files the manifest lists (never a directory listing), so it behaves the
 * same inside the packaged executable.
 *
 * @param {{ dir?: string }} [opts]
 * @throws {ScriptoriumError} "this build has no new-campaign starter", or the integrity message
 */
function loadTemplate({ dir } = {}) {
  const resolved = path.resolve(dir || TEMPLATE_DIR);
  if (cache.has(resolved)) return cache.get(resolved);
  const { manifest, loaded, problems } = readAndCheck(resolved);
  if (problems.size > 0) throw integrityError([...problems].sort()[0]);
  const built = buildTemplate(resolved, manifest, loaded);
  cache.set(resolved, built);
  return built;
}

function clearTemplateCache() {
  cache.clear();
}

/** Every file under dir, relative and POSIX; anything that is not a plain file is reported as itself. */
function walkTree(dir) {
  const files = [];
  const odd = [];
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), r);
      else if (entry.isFile()) files.push(r);
      else odd.push(r);
    }
  })(dir, '');
  return { files, odd };
}

/**
 * The same checks as loadTemplate, plus: no file on disk that the manifest does not list, and no
 * link or other odd entry. Used by the tests and by `npm run package`. Never cached.
 *
 * @returns {{ problems: string[] }} the store paths that failed, sorted; empty means the tree is sound
 * @throws {ScriptoriumError} when the manifest itself is missing or unsound
 */
function verifyTemplateTree(dir) {
  const resolved = path.resolve(dir);
  const { manifest, problems } = readAndCheck(resolved);
  const listed = new Set([MANIFEST]);
  for (const system of Object.values(manifest.systems)) for (const entry of Object.values(system.files)) listed.add(entry.store);
  const { files, odd } = walkTree(resolved);
  for (const rel of files) if (!listed.has(rel)) problems.add(rel);
  for (const rel of odd) problems.add(rel);
  return { problems: [...problems].sort() };
}

/** @returns {string[]} the game system ids the starter ships, sorted, without "none" */
function starterSystems(tpl) {
  return [...tpl.systems.keys()].filter((id) => id !== 'none').sort();
}

/** The local calendar day as YYYY-MM-DD, as the upstream scaffold's date.today() gives it. Never UTC. */
function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One system rendered as text: deviations first (on the stored text), then the declared sites in one pass. */
function renderTexts(tpl, system, title, created) {
  const sys = tpl.systems.get(system);
  const values = {};
  for (const p of tpl.placeholders) values[p.token] = p.value === 'campaign' ? title : created;
  const sites = new RegExp(tpl.placeholders.map((p) => escapeForRegExp(p.token)).join('|'), 'g');
  return sys.files.map((file) => {
    let text = file.text;
    for (const dev of tpl.deviations) {
      if (dev.file !== file.rel) continue;
      const at = text.indexOf(dev.from);
      text = text.slice(0, at) + dev.to + text.slice(at + dev.from.length);
    }
    return { file, text: text.replace(sites, (m) => values[m]) };
  });
}

function expand(value, title) {
  if (typeof value === 'string') return value.split(PROBE).join(title);
  if (Array.isArray(value)) return value.map((v) => expand(v, title));
  if (value instanceof Date) return value;
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, title)]));
  return value;
}

function sameValue(a, b) {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return Object.is(a, b);
}

/**
 * Renders the system with the real title and with a probe, parses every page's frontmatter, and
 * requires the real render to equal the probe render with the probe swapped for the title.
 * Nothing is escaped, so a title that breaks a page's YAML (a double quote or a backslash inside
 * a quoted value, for one) fails here, before anything is written.
 *
 * @throws {ConfigError} the title cannot be written exactly as typed
 */
function assertSystemReadsBack(tpl, system, title) {
  const real = renderTexts(tpl, system, title, PROBE_DATE);
  const probe = renderTexts(tpl, system, PROBE, PROBE_DATE);
  for (let i = 0; i < real.length; i += 1) {
    if (!real[i].file.rel.endsWith('.md')) continue;
    const expected = parseFrontmatterText(probe[i].text);
    if (!expected.ok) throw integrityError(real[i].file.rel);
    const actual = parseFrontmatterText(real[i].text);
    if (!actual.ok || !sameValue(expand(expected.data, title), actual.data) || expand(expected.content, title) !== actual.content) {
      throw new ConfigError(TITLE_REFUSAL);
    }
  }
}

/** The read-back across every system the build ships. @throws {ConfigError} */
function assertTitleReadsBack(tpl, title) {
  for (const id of tpl.systems.keys()) assertSystemReadsBack(tpl, id, title);
}

/**
 * @param {object} tpl from loadTemplate
 * @param {{ system: string, title: string, created: string }} where title already through validateStarterTitle; created is YYYY-MM-DD
 * @returns {{ dirs: string[], files: { rel: string, data: Buffer }[] }}
 * @throws {ConfigError} unknown system, or a title that cannot be written exactly as typed
 */
function renderStarter(tpl, { system, title, created }) {
  validateSystem(system, starterSystems(tpl));
  if (typeof title !== 'string' || title === '') throw new ScriptoriumError('the starter needs a site title');
  if (typeof created !== 'string' || !DATE_RE.test(created)) throw new ScriptoriumError('the starter needs a creation date in the form YYYY-MM-DD');
  assertSystemReadsBack(tpl, system, title);
  const rendered = renderTexts(tpl, system, title, created);
  const files = rendered.map((r) => ({ rel: r.file.rel, data: r.text === r.file.text ? r.file.buf : Buffer.from(r.text, 'utf8') }));
  return { dirs: [...tpl.systems.get(system).dirs], files };
}

module.exports = {
  TEMPLATE_DIR,
  loadTemplate,
  clearTemplateCache,
  verifyTemplateTree,
  starterSystems,
  renderStarter,
  assertTitleReadsBack,
  localDate,
};
