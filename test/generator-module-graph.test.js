'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

/*
 * NFR-02: no Scriptorium command path, including Scriptorium's own src/ and
 * not just the pinned generator's lib/, loads a module that can make a
 * network request. Static walk of the WHOLE graph from bin/scriptorium.js
 * (every command's entrypoint is required, literally, from its switch
 * statement, so this covers every command path including a future facade),
 * following both relative and bare require()/import() specifiers. Bare
 * specifiers resolve into node_modules the same way this repo's own
 * resolver would (require.resolve with paths scoped to the requiring
 * file's directory), so a bare 'gm-apprentice-publish' resolves exactly
 * where Node would resolve it at runtime.
 *
 * The network-builtin and forbidden-file assertions walk graph.files whole
 * (not filtered to the generator's lib/ dir): a Scriptorium-side network
 * capability is just as much an NFR-02 violation as a generator-side one.
 * NETWORK_BUILTIN_ALLOWLIST names the one pre-existing, legitimate
 * exception explicitly, with a justification, rather than narrowing the
 * filter back down.
 */

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'scriptorium.js');
const GENERATOR_DIR = path.join(ROOT, 'node_modules', 'gm-apprentice-publish');
/*
 * "generator file" in these assertions means the pin's own build logic
 * under lib/**, matching how the Architectural Context and FR-DEP-07
 * separate lib/** (logic) from the css/**, js/**, templates-scaffold/**
 * asset trees. js/*.js are dual-purpose browser scripts: some are required
 * transitively (e.g. lib/templates/gurps/party-board.js requires
 * ../../../js/gurps-party for its pure rowCells() helper, reused
 * server-side) purely for shared helper functions, and legitimately
 * contain browser-only code (js/party-core.js's fetch() call is inside
 * mountBoard(), which returns immediately when `document` is undefined,
 * i.e. under Node) that never runs at build time. That code ships to the
 * browser via pkg.assets' js/** glob regardless of whether lib/ requires
 * it for helper reuse, so its presence in the require graph does not
 * indicate a generator-side network or process capability.
 */
const GENERATOR_LIB_DIR = path.join(GENERATOR_DIR, 'lib');

const BUILTIN_NAMES = new Set(Module.builtinModules);
const FORBIDDEN_NETWORK_BUILTINS = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'];

/*
 * Correction (DEP reviewer pass 2026-09-11): the network-builtin and
 * forbidden-file assertions below used to filter to GENERATOR_LIB_DIR only,
 * so they never covered Scriptorium's own src/ even though the graph is
 * walked from bin/scriptorium.js and includes it. They now walk graph.files
 * whole. The one pre-existing, legitimate exception is allowlisted here,
 * named and justified, rather than the filter being narrowed back down.
 */
const NETWORK_BUILTIN_ALLOWLIST = new Map([
  [
    path.join(ROOT, 'src', 'serve', 'server.js'),
    "Scriptorium's own local `serve` command: it IS the HTTP server (binds " +
      '127.0.0.1 by default per docs/decisions/0002-serve-binds-localhost.md), ' +
      'unrelated to the generator/build network posture this test guards.',
  ],
]);

function normalizeSpec(spec) {
  return spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
}

function isBuiltinSpec(spec) {
  return BUILTIN_NAMES.has(normalizeSpec(spec));
}

/*
 * Strip /* *\/ and // comments before scanning. Without this, third-party
 * dist bundles' doc comments (e.g. markdown-it's "var hljs =
 * require('highlight.js') // https://highlightjs.org/" usage example)
 * get misread as real require() calls to a package that was never
 * installed. Best-effort: a string/template literal containing a
 * comment-like sequence could in principle be mis-stripped, not observed
 * in this dependency tree.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Literal require('x') and import('x') specifiers only; matches this repo's existing module-graph test pattern. */
function extractSpecs(source) {
  const specs = [];
  const stripped = stripComments(source);
  const reRequire = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  const reImport = /import\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  while ((m = reRequire.exec(stripped))) specs.push(m[2]);
  while ((m = reImport.exec(stripped))) specs.push(m[2]);
  return specs;
}

/** Mirrors Node's real resolution order: LOAD_AS_FILE (exact, .js, .json) before LOAD_AS_DIRECTORY. */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    if (fs.existsSync(path.join(base, 'index.js'))) return path.join(base, 'index.js');
    if (fs.existsSync(path.join(base, 'index.json'))) return path.join(base, 'index.json');
  }
  return base;
}

/**
 * @param {string[]} entryFiles
 * @returns {{ files: Set<string>, builtins: Set<string>, unresolved: string[] }}
 */
function walkModuleGraph(entryFiles) {
  const files = new Set();
  const builtins = new Set();
  const unresolved = [];
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);

    if (!fs.existsSync(file)) {
      unresolved.push(file);
      continue;
    }
    if (!file.endsWith('.js')) continue; // .json etc: nothing to extract

    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecs(source)) {
      if (isBuiltinSpec(spec)) {
        builtins.add(normalizeSpec(spec));
        continue;
      }
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch (err) {
        unresolved.push(spec);
      }
    }
  }

  return { files, builtins, unresolved };
}

let graph;
test.before(() => {
  graph = walkModuleGraph([ENTRY]);
});

test('every specifier in the graph resolves (no unresolvable require/import)', () => {
  assert.deepEqual(graph.unresolved, [], `unresolvable specifier(s): ${graph.unresolved.join(', ')}`);
});

test('the graph reaches node_modules/gm-apprentice-publish/lib/build.js', () => {
  const target = path.join(GENERATOR_DIR, 'lib', 'build.js');
  assert.ok(graph.files.has(target), 'expected the generator module graph to include lib/build.js');
});

test('the graph never requires a network-capable builtin, including node: forms, outside the allowlist', () => {
  const offenders = [];
  for (const f of graph.files) {
    if (!f.endsWith('.js')) continue;
    if (NETWORK_BUILTIN_ALLOWLIST.has(f)) continue;
    const source = fs.readFileSync(f, 'utf8');
    for (const name of FORBIDDEN_NETWORK_BUILTINS) {
      if (new RegExp(`require\\(\\s*(['"])(node:)?${name}\\1\\s*\\)`).test(source)) {
        offenders.push(`${path.relative(ROOT, f).split(path.sep).join('/')} (${name})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `graph reaches forbidden network builtin(s): ${offenders.join(', ')} (NFR-02; see docs/decisions/0005-generator-pin.md)`,
  );
});

test('every allowlisted network-builtin file is actually reached and actually requires its builtin', () => {
  // Guards against a stale allowlist entry silently widening coverage.
  for (const [file, justification] of NETWORK_BUILTIN_ALLOWLIST) {
    assert.ok(graph.files.has(file), `allowlisted file not reached by the graph: ${file}`);
    assert.ok(justification && justification.length > 0, `allowlist entry missing a justification: ${file}`);
    const source = fs.readFileSync(file, 'utf8');
    const usesAny = FORBIDDEN_NETWORK_BUILTINS.some((name) =>
      new RegExp(`require\\(\\s*(['"])(node:)?${name}\\1\\s*\\)`).test(source),
    );
    assert.ok(usesAny, `allowlisted file no longer requires a network builtin, remove the entry: ${file}`);
  }
});

test('the graph never reaches lib/deploy-cli.js, lib/inbox-cli.js or lib/flush-cli.js', () => {
  const forbidden = ['deploy-cli.js', 'inbox-cli.js', 'flush-cli.js'];
  const hits = [...graph.files].filter((f) => forbidden.includes(path.basename(f)));
  assert.deepEqual(hits, [], `graph must not reach: ${hits.join(', ')}`);
});

test('no reached generator lib/ file contains fetch(', () => {
  const offenders = [];
  for (const f of graph.files) {
    if (!f.startsWith(GENERATOR_LIB_DIR + path.sep)) continue;
    if (!f.endsWith('.js')) continue;
    const source = fs.readFileSync(f, 'utf8');
    if (/\bfetch\(/.test(source)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `fetch( found in: ${offenders.join(', ')}`);
});

test('the generator files requiring child_process are exactly lib/image-optimize.js and lib/run-command.js', () => {
  const expected = ['lib/image-optimize.js', 'lib/run-command.js'].sort();
  const actual = [];
  for (const f of graph.files) {
    if (!f.startsWith(GENERATOR_LIB_DIR + path.sep)) continue;
    if (!f.endsWith('.js')) continue;
    const source = fs.readFileSync(f, 'utf8');
    if (/require\(\s*(['"])(node:)?child_process\1\s*\)/.test(source)) {
      actual.push(path.relative(GENERATOR_DIR, f).split(path.sep).join('/'));
    }
  }
  actual.sort();
  assert.deepEqual(
    actual,
    expected,
    `child_process is reached from an unexpected set of generator files: ${actual.join(', ')}. ` +
      'See docs/decisions/0005-generator-pin.md (network posture) for the expected set.',
  );
});

// --- FR-19/SD-19 (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md): the network
// gate hardened for a network capability reached through `globalThis.fetch`/an injected fetch,
// which the two tests above (builtin requires, forbidden files) cannot see -- lib/fonts.js and
// lib/update-pin.js reach it that way, not via a literal `require('http')`. Additive only: this
// block builds its OWN graph via its OWN comment-stripping, rather than reusing `graph`/
// `stripComments`/`walkModuleGraph` above.
//
// Bug found while writing this (not fixed here -- see the Engineer's handback): `stripComments`
// above strips `/* */` before `//`, so a `//` line comment containing a `/*`-shaped substring
// (lib/build.js has `// ... static css/themes/*.css file ...`) is misread as an unterminated
// block-comment start, which then swallows everything up to the next unrelated `*/` anywhere
// later in the file -- 54KB of lib/build.js, including several real require() calls
// (`./manifest-cli` among them), silently vanish from `stripped`. Empirically this does not
// change any existing assertion's truth value in this file (checked directly: the corrected
// walk below adds lib/update-pin.js, lib/manifest-cli.js and lib/site-pin.js to the reached set,
// none of which trip the forbidden-builtin, forbidden-file or child_process assertions above),
// so nothing here is known-wrong today -- but the shared helper stays unrepaired because fixing
// it is a non-additive edit to this file, which this track's constraints reserve as an
// escalation, not a decision for the Engineer.

const NETWORK_TOKEN_RE =
  /\bfetch\w*\s*\(|\b(?:globalThis|global|window)\s*\.\s*fetch\b|\bfetch(?:Fn|Impl)\b|\b(?:WebSocket|EventSource|XMLHttpRequest)\b|require\(\s*(['"])undici\1\s*\)/;

/**
 * A corrected comment stripper: one pass, matching strings/template literals and both comment
 * forms in lexical order, so a `//` comment's own text is never re-examined for an embedded
 * `/*`-shaped substring. See the block comment above for why this exists as a second, local
 * function rather than a fix to `stripComments` above.
 */
function stripCommentsSafe(source) {
  return source.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('//') || m.startsWith('/*') ? '' : m),
  );
}

function extractSpecsSafe(source) {
  const specs = [];
  const stripped = stripCommentsSafe(source);
  const reRequire = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  const reImport = /import\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  while ((m = reRequire.exec(stripped))) specs.push(m[2]);
  while ((m = reImport.exec(stripped))) specs.push(m[2]);
  return specs;
}

function walkModuleGraphSafe(entryFiles) {
  const files = new Set();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!fs.existsSync(file) || !file.endsWith('.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecsSafe(source)) {
      if (isBuiltinSpec(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolveRelative(file, spec));
        continue;
      }
      try {
        queue.push(require.resolve(spec, { paths: [path.dirname(file)] }));
      } catch (err) {
        // unresolved: the existing "every specifier resolves" test above already covers this
        // against the (buggier) shared graph; not re-asserted here.
      }
    }
  }
  return files;
}

/*
 * The exact allowlist: lib/fonts.js and lib/update-pin.js reach a network-capability token
 * (Δ, #270 self-host fonts / the release-pin updater), src/generator/netguard.js itself
 * necessarily names `fetch`/`WebSocket` (it's the guard), js/party-core.js is the pre-existing,
 * documented browser-only case (see GENERATOR_LIB_DIR's own comment above: its fetch() call is
 * inside mountBoard(), which returns immediately under Node), and src/cli/update.js /
 * src/update/release.js are Scriptorium's own, pre-existing, deliberate self-update feature --
 * already governed by its own dedicated constraint test (test/update-module-graph.test.js,
 * CLAUDE.md), unrelated to the generator/build network posture this test guards (the same
 * reasoning NETWORK_BUILTIN_ALLOWLIST above already applies to src/serve/server.js).
 */
const NETWORK_TOKEN_ALLOWLIST = new Map([
  [path.join(GENERATOR_DIR, 'lib', 'fonts.js'), '#270 self-host font prefetch; Scriptorium never calls prefetchForConfig/ensureFontCache/buildWithFonts'],
  [path.join(GENERATOR_DIR, 'lib', 'update-pin.js'), 'the release-pin updater; Scriptorium never calls runUpdatePin/runUpdatePinTag'],
  [path.join(ROOT, 'src', 'generator', 'netguard.js'), 'the guard itself: it necessarily names fetch/WebSocket to replace them'],
  [
    path.join(GENERATOR_DIR, 'js', 'party-core.js'),
    'pre-existing, documented browser-only case (see the GENERATOR_LIB_DIR comment above): its fetch() call is inside mountBoard(), which returns immediately when `document` is undefined',
  ],
  [path.join(ROOT, 'src', 'cli', 'update.js'), "Scriptorium's own self-update feature, governed by test/update-module-graph.test.js; unrelated to generator/build network posture"],
  [path.join(ROOT, 'src', 'update', 'release.js'), "Scriptorium's own self-update feature, governed by test/update-module-graph.test.js; unrelated to generator/build network posture"],
]);

let graphSafe;
test.before(() => {
  graphSafe = walkModuleGraphSafe([ENTRY]);
});

test('FR-19: no reached file matches a network-capability token (fetch/WebSocket/undici/etc), outside the exact allowlist', () => {
  const offenders = [];
  for (const f of graphSafe) {
    if (!f.endsWith('.js')) continue;
    if (NETWORK_TOKEN_ALLOWLIST.has(f)) continue;
    const stripped = stripCommentsSafe(fs.readFileSync(f, 'utf8'));
    if (NETWORK_TOKEN_RE.test(stripped)) offenders.push(path.relative(ROOT, f).split(path.sep).join('/'));
  }
  assert.deepEqual(offenders, [], `graph reaches a network-capability token outside the allowlist: ${offenders.join(', ')}`);
});

test('FR-19: every allowlisted network-token file is actually reached and actually matches the token', () => {
  for (const [file, justification] of NETWORK_TOKEN_ALLOWLIST) {
    assert.ok(graphSafe.has(file), `allowlisted file not reached by the graph: ${file}`);
    assert.ok(justification && justification.length > 0, `allowlist entry missing a justification: ${file}`);
    const stripped = stripCommentsSafe(fs.readFileSync(file, 'utf8'));
    assert.ok(NETWORK_TOKEN_RE.test(stripped), `allowlisted file no longer matches a network token, remove the entry: ${file}`);
  }
});

test('FR-19: no file under src/ or bin/ names buildWithFonts, prefetchForConfig, ensureFontCache, runUpdatePin or runUpdatePinTag', () => {
  const forbiddenNames = ['buildWithFonts', 'prefetchForConfig', 'ensureFontCache', 'runUpdatePin', 'runUpdatePinTag'];
  const offenders = [];
  function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const name of forbiddenNames) {
        if (new RegExp(`\\b${name}\\b`).test(source)) {
          offenders.push(`${path.relative(ROOT, full)} (${name})`);
        }
      }
    }
  }
  walkDir(path.join(ROOT, 'src'));
  walkDir(path.join(ROOT, 'bin'));
  assert.deepEqual(offenders, [], `Scriptorium must never name a font-prefetch or update-pin capability: ${offenders.join(', ')}`);
});

test('FR-19/FR-DEP-08: the pin reads its site config from disk, with no non-literal require() left under lib/', () => {
  // Up to publish-v1.11.44 the pin loaded the site config with two non-literal requires,
  // lib/build.js:34 `require(resolvedConfigPath)` and lib/fonts.js:267 `require(resolved)`, and this
  // test recorded both lines. At publish-v1.12.0 both call `loadVaultConfig()` (lib/config.js),
  // which reads the file with fs and JSON.parse (lib/build.js:67 then, :69 from publish-v1.12.3, :70 from publish-v1.14.0).
  // What is recorded now is that the two call sites
  // are still where the config is read, and that no file under lib/ requires a bare identifier.
  const fontsSource = fs.readFileSync(path.join(GENERATOR_DIR, 'lib', 'fonts.js'), 'utf8');
  const line267 = fontsSource.split('\n')[266];
  assert.match(line267, /loadVaultConfig\(\s*resolved\s*\)/, `lib/fonts.js:267 no longer reads the config through loadVaultConfig(resolved): "${line267}"`);

  const buildSource = fs.readFileSync(path.join(GENERATOR_DIR, 'lib', 'build.js'), 'utf8');
  const line70 = buildSource.split('\n')[69];
  assert.match(
    line70,
    /loadVaultConfig\(\s*resolvedConfigPath\s*\)/,
    `lib/build.js:70 no longer reads the config through loadVaultConfig(resolvedConfigPath): "${line70}"`,
  );

  const offenders = [];
  const libDir = path.join(GENERATOR_DIR, 'lib');
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((text, idx) => {
        if (/\brequire\(\s*[A-Za-z_$][\w$.]*\s*\)/.test(text)) offenders.push(`${path.relative(GENERATOR_DIR, full)}:${idx + 1}`);
      });
    }
  })(libDir);
  assert.deepEqual(offenders, [], `the pin gained a non-literal require(): ${offenders.join(', ')}`);
});
