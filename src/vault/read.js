'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { VaultReadError, FrontmatterLanguageError, ScriptoriumError } = require('../util/errors');
const { toRelativePosix } = require('../util/paths');
const { classifyFrontmatterFence, renderTag, FENCE_HEAD_BYTES } = require('./fence');

/*
 * The single read-only chokepoint for vault access (Engineering Brief
 * section 8 and section 9 non-functional: "Read-only against vaults,
 * enforced structurally, not by convention. Nothing opens a vault file for
 * writing.") Every command that touches a vault, in every phase, routes
 * its reads through this module.
 *
 * This file must never import or call a write-capable fs function
 * (writeFileSync, appendFileSync, copyFileSync, rmSync, mkdirSync,
 * unlinkSync, renameSync, chmodSync, and their non-Sync counterparts).
 * test/vault-read.test.js asserts that structurally by scanning this
 * module's own source, not by trusting a code review. ADR 0021's `init` is
 * the one narrow, create-only exception to this file's own read-only rule,
 * and it writes through src/vault/packwrite.js, never through this module.
 *
 * Two failure modes are deliberately kept distinct:
 *
 *  - A gray-matter frontmatter PARSE failure is a content defect. The
 *    generator itself silently skips such a file; `check` (phase 2) reports
 *    it as an ordinary per-file finding and keeps walking everything else.
 *    readFrontmatter() returns { ok: false, error } for this case, it does
 *    not throw.
 *
 *  - A filesystem READ failure (ENOENT after existence was already
 *    established, EACCES, or EIO from the NAS's soft mount dropping
 *    mid-walk) means the filesystem itself stopped answering. walkVault()
 *    throws VaultReadError immediately and does not return a partial
 *    result: a `check` that returns successfully after silently skipping
 *    the unreadable remainder of the vault is more dangerous than one that
 *    fails outright, because --json is consumed by Claude and determinism
 *    is a hard requirement (Decisions Addendum, gap 2: "mid-run
 *    unreachability aborts, never degrades").
 *
 * A read-only vault is a supported mode (Decisions Addendum, gap 1): every
 * function in this module only ever reads, so nothing here can fail
 * because the vault is not writable. Nothing in this module checks or
 * cares whether the vault is writable at all.
 */

const DEFAULT_SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules']);

/*
 * V1e-9 (ADR 0041, SD-90): a one-file, single-slot, synchronous candidate overlay. For the exact
 * duration of withCandidateFile(absPath, bytes, fn)'s own `fn` call, readFrontmatter/readText/
 * readBytes/readHead for THAT ONE PATH serve `bytes` instead of touching disk, so
 * src/admin/candidatecheck.js can run a real `check` against an edited copy that was never
 * written anywhere. Every other reader (walkVault, walkMarkdownFiles's own listing, listDir,
 * pathExists, statPath, statOrNull, realPath, parseFrontmatterText) is deliberately NOT
 * consulted: a file's existence, its listing membership, and its stat/realpath identity are never
 * part of "what would check see if this file's bytes were different", and parseFrontmatterText
 * never reads a path at all.
 *
 * Rejected (see docs/decisions/0041-check-an-edited-copy.md section 4): threading an override
 * through check.js/context.js/publishset.js/index.js/fencescan.js/themescheme.js (six readers to
 * keep in step, and a reader added later would silently read disk and quietly break the
 * equivalence guarantee this exists to prove); copying the whole vault to scratch per review (GM
 * data duplicated into tmp, at owner-vault size, with symlink handling -- it stays the TEST
 * ORACLE instead, never the mechanism); monkeypatching `fs` (process-wide, would also hit asset
 * serving); running the generator (check doesn't use it).
 */
let candidate = null;

/**
 * A local copy of platformFoldsCase() (src/vault/exclusions.js:87-90), deliberately NOT required
 * from there: exclusions.js requires src/generator/pinned, which would pull the generator facade
 * into this module's require graph (this file's own header: "must never import or call a
 * write-capable fs function", and more generally must stay the vault's narrowest possible
 * dependency surface).
 */
function foldKey(p) {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/** The active candidate iff `absPath` is an EXACT match (never startsWith/dirname), else null. */
function candidateFor(absPath) {
  if (candidate === null) return null;
  return foldKey(path.resolve(absPath)) === candidate.key ? candidate : null;
}

/**
 * @param {string} absPath the one path the candidate stands in for
 * @param {Buffer} bytes the candidate's whole-file bytes
 * @param {() => any} fn run synchronously, with the overlay active; its return value becomes
 *   `value`, and the overlay is always cleared before this function returns (even on a throw)
 * @returns {{ value: any, hits: number }} `hits` counts every read this overlay actually served
 * @throws {ScriptoriumError} nesting, bad arguments, or an `fn` that returns a thenable (a
 *   programming error: this overlay is single-slot and synchronous by contract -- ADR 0041)
 */
function withCandidateFile(absPath, bytes, fn) {
  if (candidate !== null) {
    throw new ScriptoriumError('withCandidateFile: a candidate is already active (programming error)');
  }
  if (!Buffer.isBuffer(bytes)) {
    throw new ScriptoriumError('withCandidateFile: bytes must be a Buffer (programming error)');
  }
  if (typeof fn !== 'function') {
    throw new ScriptoriumError('withCandidateFile: fn must be a function (programming error)');
  }
  candidate = { key: foldKey(path.resolve(absPath)), bytes: Buffer.from(bytes), text: Buffer.from(bytes).toString('utf8'), hits: 0 };
  try {
    const value = fn();
    if (value && typeof value.then === 'function') {
      throw new ScriptoriumError('withCandidateFile: fn must be synchronous (programming error)');
    }
    return { value, hits: candidate.hits };
  } finally {
    candidate = null;
  }
}

// ADR 0034 / SD-3, layer 2: the ONLY bare `matter(` call in this module (and, by the FR-FM-02
// structural test, in all of src/**/*.js and bin/*.js). `YAML_ONLY_OPTIONS.engines` disables the
// javascript and json engines directly on this call, independently of the fence predicate below
// (layer 1): even if layer 1 has a bug and lets a refused fence through, gray-matter itself
// cannot dispatch to `eval` through this options object. `disabled()` throws a plain Error, never
// FrontmatterLanguageError, deliberately: a predicate bug must surface loudly as an ordinary
// frontmatter/parse-error, not be silently reclassified as if the fence predicate had caught it.
function disabled(name) {
  return {
    parse() {
      throw new Error(`frontmatter engine "${name}" is disabled in Scriptorium`);
    },
    stringify() {
      throw new Error(`frontmatter engine "${name}" is disabled in Scriptorium`);
    },
  };
}

const YAML_ONLY_OPTIONS = Object.freeze({
  engines: Object.freeze({ javascript: disabled('javascript'), json: disabled('json') }),
});

/**
 * ADR 0034 / SD-3: the one place raw text is handed to gray-matter with the javascript/json
 * engines disabled. A truthy options object also keeps gray-matter's cache bypass (the comment
 * this replaced already relied on that; see the file-level history), so identical malformed
 * content parsed twice throws twice rather than being served a stale cached placeholder.
 *
 * @param {string} raw
 * @returns {object} gray-matter's parsed result
 * @throws {Error} a plain Error -- including for the disabled javascript/json engines above --
 *   never FrontmatterLanguageError (that is layer 1's job, in readFrontmatter/parseFrontmatterText).
 */
function parseYamlOnly(raw) {
  return matter(raw, YAML_ONLY_OPTIONS);
}

/**
 * Read one file's frontmatter with the same gray-matter version the
 * generator depends on, so a file that parses here parses there.
 *
 * ADR 0034 / SD-3, layer 1: before ever calling gray-matter, the fence predicate
 * (src/vault/fence.js) classifies the file's opening fence. A refused fence returns
 * `{ ok:false, raw, error: FrontmatterLanguageError }` without gray-matter ever seeing the raw
 * text (FR-FM-02). Anything else (no fence, or a yaml/yml/empty tag) falls through to
 * parseYamlOnly, layer 2's independent restriction.
 *
 * @param {string} absPath
 * @returns {{ ok: true, raw: string, data: object, content: string } |
 *           { ok: false, raw: string, error: Error }}
 * @throws {VaultReadError} if the filesystem read itself fails
 */
function readFrontmatter(absPath) {
  let raw;
  const c = candidateFor(absPath);
  if (c) {
    c.hits++;
    raw = c.text;
  } else {
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      throw new VaultReadError(absPath, err);
    }
  }
  const fence = classifyFrontmatterFence(raw);
  if (fence.status === 'refused') {
    return {
      ok: false,
      raw,
      error: new FrontmatterLanguageError(absPath, { tag: renderTag(fence.tag), reason: fence.reason }),
    };
  }
  try {
    // gray-matter 4.0.3 caches its result keyed by the raw content string,
    // and it writes that cache entry BEFORE parsing, not after: if two
    // reads share byte-identical content (a duplicated template, or the
    // same file read twice across two runs in one long-lived process) and
    // the first parse throws, gray-matter's own cache silently serves the
    // second caller the pre-parse, unparsed placeholder as if it were a
    // successful parse rather than throwing again. Passing an explicit
    // (even empty) options object takes the uncached code path entirely
    // (matter's cache check is gated on `!options`), which is worth the
    // trivial cost here: correctness of the frontmatter/parse-error check
    // matters more than reusing gray-matter's memoisation for a value this
    // small. Confirmed against gray-matter 4.0.3's own source
    // (node_modules/gray-matter/index.js:34-47).
    const parsed = parseYamlOnly(raw);
    return { ok: true, raw, data: parsed.data, content: parsed.content };
  } catch (err) {
    return { ok: false, raw, error: err };
  }
}

/**
 * V1e-1 (ADR 0033, SD-5): Scriptorium's own frontmatter parser, exposed as a standalone
 * function so src/admin/vaultconfigedit.js's semantic guard can run it directly against a
 * CANDIDATE buffer that never touches disk (readFrontmatter above only ever reads a real file).
 *
 * ADR 0034: routed through the same fence predicate and the same restricted parseYamlOnly layer
 * 2 as readFrontmatter, for the identical reason (FR-FM-02: "and to any future Scriptorium call
 * site"). The explicit options object also keeps bypassing gray-matter's content-keyed cache: a
 * candidate string that happens to be byte-identical to a file already parsed once in this
 * process must still be parsed fresh, not served gray-matter's cached (and, on a prior throw,
 * unparsed) placeholder.
 *
 * @param {string} raw
 * @returns {{ ok: true, data: object, content: string } | { ok: false, error: Error }}
 */
function parseFrontmatterText(raw) {
  const fence = classifyFrontmatterFence(raw);
  if (fence.status === 'refused') {
    return { ok: false, error: new FrontmatterLanguageError(null, { tag: renderTag(fence.tag), reason: fence.reason }) };
  }
  try {
    const parsed = parseYamlOnly(raw);
    return { ok: true, data: parsed.data, content: parsed.content };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Deterministically walk every file under `vaultPath`, skipping directories
 * in `skipDirs` (default: .git, .obsidian, node_modules) and any directory
 * whose name starts with "." Sibling entries are sorted by name at every
 * level, so directory order never reaches the result regardless of what
 * the underlying filesystem's readdir happens to return (section 9:
 * "Sort every readdirSync result so directory order never reaches the
 * output").
 *
 * Aborts (throws VaultReadError) on the first filesystem-level read
 * failure anywhere in the tree. Never returns a partial list.
 *
 * @param {string} vaultPath absolute path to the vault root
 * @param {{ skipDirs?: Set<string> }} [options]
 * @returns {{ absPath: string, relPath: string }[]} sorted by relPath
 */
function walkVault(vaultPath, options = {}) {
  const skipDirs = options.skipDirs || DEFAULT_SKIP_DIRS;
  const results = [];

  function walkDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new VaultReadError(dir, err);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walkDir(absPath);
        continue;
      }

      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = fs.statSync(absPath).isFile();
        } catch (err) {
          throw new VaultReadError(absPath, err);
        }
      }
      if (!isFile) continue;

      results.push({ absPath, relPath: toRelativePosix(vaultPath, absPath) });
    }
  }

  walkDir(vaultPath);
  results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return results;
}

/**
 * Walk the vault and return only markdown files, each with its frontmatter
 * already read via readFrontmatter(). Still aborts (does not catch) on a
 * filesystem-level read failure; a per-file frontmatter parse failure is
 * folded into the returned entry instead (see module doc above).
 *
 * @param {string} vaultPath
 * @param {{ skipDirs?: Set<string> }} [options]
 */
function walkMarkdownFiles(vaultPath, options = {}) {
  return walkVault(vaultPath, options)
    .filter((f) => f.relPath.endsWith('.md'))
    .map((f) => Object.assign({}, f, readFrontmatter(f.absPath)));
}

/**
 * List one directory's entries, sorted by name, as plain data (not live
 * fs.Dirent objects, so callers cannot accidentally call a method that
 * touches the filesystem again). Lower-level than walkVault: used by
 * modules that need their own traversal policy (e.g. src/vault/publishset.js
 * mirroring the generator's exact directory-skip algorithm) while still
 * routing every actual read through this chokepoint.
 *
 * @param {string} absDir
 * @returns {{ name: string, isDirectory: boolean, isFile: boolean, isSymbolicLink: boolean }[]}
 * @throws {VaultReadError}
 */
function listDir(absDir) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    throw new VaultReadError(absDir, err);
  }
  return entries
    .map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      isSymbolicLink: e.isSymbolicLink(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True if `absPath` exists (of any kind). Never throws: a missing path is
 * exactly the case this exists to report, not a filesystem-level failure.
 */
function pathExists(absPath) {
  return fs.existsSync(absPath);
}

/**
 * fs.statSync wrapped to abort (VaultReadError) on anything other than the
 * path simply not existing, which callers get as a normal falsy-ish path
 * via pathExists() first, or handle themselves with statOrNull().
 *
 * @throws {VaultReadError}
 */
function statPath(absPath) {
  try {
    return fs.statSync(absPath);
  } catch (err) {
    throw new VaultReadError(absPath, err);
  }
}

/** stat that returns null for ENOENT instead of throwing; anything else still aborts. */
function statOrNull(absPath) {
  try {
    return fs.statSync(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new VaultReadError(absPath, err);
  }
}

/**
 * UTF-8 text through the chokepoint (ADR 0018: a campaign pack's
 * vault.config.json may live inside the vault, so it is read here rather
 * than through plain fs the way a legacy, outside-the-vault site config is).
 *
 * @param {string} absPath
 * @returns {string}
 * @throws {VaultReadError}
 */
function readText(absPath) {
  const c = candidateFor(absPath);
  if (c) {
    c.hits++;
    return c.text;
  }
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new VaultReadError(absPath, err);
  }
}

/** Raw bytes through the chokepoint (ADR 0019 image slots). @throws {VaultReadError} */
function readBytes(absPath) {
  const c = candidateFor(absPath);
  if (c) {
    c.hits++;
    return Buffer.from(c.bytes);
  }
  try {
    return fs.readFileSync(absPath);
  } catch (err) {
    throw new VaultReadError(absPath, err);
  }
}

/**
 * ADR 0034 / SD-3: a bounded read of at most `maxBytes` from the start of `absPath`, for
 * src/vault/fencescan.js's whole-vault fence walk (which must not read an unbounded amount of
 * memory per file just to classify one opening fence). Opens with the raw fs API (not
 * readFileSync) so the read can stop after `maxBytes + 1` bytes rather than allocating the whole
 * file.
 *
 * @param {string} absPath
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }} `truncated` is true iff the file holds more
 *   than `maxBytes` bytes; `text` is always at most `maxBytes` bytes, decoded as UTF-8.
 * @throws {VaultReadError} on any open or read failure
 */
function readHead(absPath, maxBytes) {
  const c = candidateFor(absPath);
  if (c) {
    c.hits++;
    const truncated = c.bytes.length > maxBytes;
    return { text: c.bytes.toString('utf8', 0, Math.min(c.bytes.length, maxBytes)), truncated };
  }
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
  } catch (err) {
    throw new VaultReadError(absPath, err);
  }
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buf, total, buf.length - total, null);
      } catch (err) {
        throw new VaultReadError(absPath, err);
      }
      if (n === 0) break;
      total += n;
      if (total >= buf.length) break;
    }
    const truncated = total > maxBytes;
    return { text: buf.toString('utf8', 0, Math.min(total, maxBytes)), truncated };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort only, following the run.js swallowed-cleanup pattern
    }
  }
}

/** fs.realpathSync (the JS implementation plan.js already uses) through the chokepoint. @throws {VaultReadError} */
function realPath(absPath) {
  try {
    return fs.realpathSync(absPath);
  } catch (err) {
    throw new VaultReadError(absPath, err);
  }
}

module.exports = {
  readFrontmatter,
  parseFrontmatterText,
  parseYamlOnly,
  readHead,
  walkVault,
  walkMarkdownFiles,
  listDir,
  pathExists,
  statPath,
  statOrNull,
  readText,
  readBytes,
  realPath,
  DEFAULT_SKIP_DIRS,
  withCandidateFile,
};
