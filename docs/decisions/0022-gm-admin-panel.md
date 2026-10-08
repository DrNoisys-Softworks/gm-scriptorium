# 0022. The GM admin panel: `serve --admin`, its request gate, and the vault write exception

Status: proposed (phase 8). This draft is written across slices; sections owned by a later slice
say "Pending (Sn)" and are filled in when that slice lands.

## Summary

`serve --admin` starts a local, GM-only web panel that edits a campaign's pack, runs `check`, and builds a preview, without ever changing what a published build contains. It listens only on the GM's own computer, on two separate addresses so that nothing in the preview can reach the panel's controls. Opening it takes the one link `serve --admin` prints, which carries a one-time token. Every write goes through one narrow, tested path, and a build that carries the panel's preview-only link is refused, even with `--force`. The record is long because it was extended as each part of the panel landed; its closing sections cover the later redesign.

## 1. Decision

`scriptorium serve --admin [campaign]` starts a small, local, GM-only web panel that edits a
campaign's pack (`<vault>/_meta/scriptorium/`), runs `check`, and builds a local preview, all
without ever changing what a published build contains. It binds two listeners, both on
`127.0.0.1` only: an admin listener, which serves the panel UI and its API, and a preview
listener, which serves nothing in this slice and will serve a built preview tree from slice S2
onward. The two are kept on separate origins deliberately (section 3), so that anything the
preview tree can make a browser do never reaches the admin API.

Opening the panel means visiting the one URL `serve --admin` prints, which carries a one-time
launch token. From then on a session cookie carries authentication (section 3, D02); every write
still goes through one narrow chokepoint per slice S3, guarded by the same containment and
atomicity rules `init`'s own pack writer already established (ADR 0021). Nothing the panel writes
ever reaches a published site: the write is confined to the pack, and slice S6 adds an
unconditional, `--force`-proof output gate that refuses any build carrying the panel's preview-only
GM link.

Everything below the launch, the bind, and the request gate is out of scope for this slice.
Slices S2 through S6 build the rest of the panel behind the route table and asset set this slice
lands (`src/admin/router.js`); see the later sections here for what each one owns.

## 2. Threat model

**In scope**, i.e. the panel is designed to resist these:

- Any web page open in any browser tab on the GM's own machine, while the panel is running,
  including a page the GM never intended to interact with the panel.
- DNS rebinding: a page whose origin resolves to `127.0.0.1` after the browser has already
  cached a same-origin decision.
- Content the panel itself has built and is serving as a preview (slice S2 onward): the preview
  tree runs vault-authored Markdown, themes and the pinned generator's own JS through a browser,
  and none of that is trusted code.
- Other, unrelated local processes that also happen to be listening on `127.0.0.1`, on other
  ports.

**Out of scope**, i.e. the panel does not attempt to resist these (see section 11 for the full,
deliberate list):

- Local malware or a locally-privileged administrator: either can already read the GM's files,
  including any token this panel ever prints.
- The GM themselves, acting on their own machine with their own credentials.
- A browser extension the GM has installed and granted broad permissions to.

## 3. Controls

- **Loopback bind, no opt-out.** `startLocalListener` (`src/serve/server.js`) has no `host`
  parameter at all: it always binds `127.0.0.1`. This is a stronger guarantee than plain `serve`,
  which defaults to loopback but accepts `--host` to widen it (ADR 0002). `serve --admin` refuses
  `--host` in every form, including a bare `--host` and `--host 127.0.0.1` (which would ask for
  nothing different, and is refused anyway, so the flag can never silently do something else
  later).
- **A flag allowlist, not a denylist.** `serve --admin` accepts exactly `--admin`, `--campaign`,
  `--config`, `--vault` and `--port`. Anything else, `--build`, `--out`, `--site-config`,
  `--host` (any form), `--force`, is a one-line `ConfigError` before any socket opens, so a
  refusal never reads config and never applies an `--out` override that would otherwise let a
  `check`/`build` invocation redirect where a later slice's write logic looks.
- **The Host allowlist.** Every request to either listener must name that listener's own bound
  port, as `127.0.0.1` or `localhost` (case-insensitive on the host part only), in its `Host`
  header. This is the DNS-rebinding defence: a page whose origin has rebound to `127.0.0.1` still
  carries whatever `Host` the browser sends, and a browser never sends anything but the origin it
  believes it is talking to.
- **The token.** 256 bits from `crypto.randomBytes`, base64url-encoded (43 characters, no `&`, no
  shell metacharacters), freshly generated on every launch, compared with `crypto.timingSafeEqual`
  over a SHA-256 digest of both sides (so a length mismatch in the presented value never throws
  and never leaks timing). It is printed exactly once, on the first startup line, and nowhere
  else: never in an error message, never in a response body, never on disk, never in the GM link
  a later slice adds.
- **The cookie exchange, and why (D02).** The token in the URL is exchanged once, at `/auth`, for
  a session cookie (`HttpOnly`, `SameSite=Strict`, host-only, `Path=/`, session-only, named per
  admin port so both listeners can recognise the same cookie despite Cookie headers ignoring
  ports). A redirect to `/` then strips the token from the URL bar, browser history and any
  referrer a page on the panel might leak. The alternative, keeping the token in a URL fragment
  and sending it as a header from every request, was rejected: it is cookie-free, which is a real
  property, but it cannot authenticate a plain browser navigation, which slice S6's GM link needs
  (the GM must be able to click a plain `<a>` in a built preview page and land in an authenticated
  panel), and every new tab would need the terminal URL again. Authentication succeeds if *any*
  cookie of the right name matches the token, deliberately: a page cannot deny service by tossing
  a decoy cookie of the same name ahead of the real one.
- **Origin, on every admin POST, including simple requests.** A POST must carry an `Origin`
  header exactly equal to `http://` plus the lowercased `Host` the request itself named. This is
  checked for every POST, not just ones a browser would preflight: a plain HTML form, a
  `multipart/form-data` upload, or a bare `text/plain` body are all "simple requests" that never
  trigger a CORS preflight, so Origin is the only signal available, and it is checked exactly,
  not as a prefix or a substring.
- **No CORS, anywhere.** Neither listener ever emits an `Access-Control-Allow-*` header, on any
  response, including `OPTIONS`. There is nothing here for a cross-origin `fetch` to succeed at.
- **Response hardening.** Every admin response carries a fixed Content-Security-Policy
  (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
  connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`),
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
  `frame-ancestors 'none'` is the clickjacking defence: nothing can embed the panel in a frame, on
  any origin, including its own. The preview listener (slice S2 onward) gets the same set minus
  the CSP, since it serves arbitrary vault-authored HTML that cannot be constrained to
  `'self'`-only script and style.
  - **Panel v2 (V1a) amendment: `font-src 'self'`.** The restyle embeds four font families as
    same-origin files under `/assets/fonts/`. Without a `font-src` directive, `@font-face` falls
    back to `default-src 'none'` and every load is refused, embedded or not. `font-src 'self'`
    permits only the panel's own embedded files; nothing outside the admin origin can supply a
    font. Rejected: `font-src data:` (widens the policy for no benefit; the fonts are files, not
    inline data), and system font stacks (keeps the CSP untouched but loses the design's
    typography). This change lands in its own reviewed commit, ahead of the fonts themselves.
- **Public assets, authenticated pages and APIs.** The admin panel's own static UI files,
  every file named in `ADMIN_ASSET_ROUTES`, including the panel's own fonts, which the locked
  page also loads, are served without a cookie, alongside `/auth` itself. This is a deliberate
  reading of FR07 ("every admin page and API except a fixed open-the-link page requires the
  token"): these files carry no pack data, are byte-identical to the exe's own embedded copy for
  anyone who already has the exe, and letting the locked page (`locked.html`) load its own
  stylesheet, fonts and icon is what makes it a styled page rather than plain text. Every other
  admin route, `/`, `/api/session`, `/api/noop` and every route a later slice adds, requires the
  cookie; an unauthenticated `GET /` specifically
  gets served `locked.html` rather than a bare refusal body, so the "open the link in your
  terminal" instruction is legible in a browser tab.
- **The separate preview origin, and why sandbox-only was rejected.** The preview listener is a
  second, separate origin from the admin listener (different port; Cookie headers ignore ports,
  but Origin does not). A page served from the preview origin can never satisfy the admin
  listener's Origin check, so it can never make a state-changing admin request, no matter what
  script the vault, a theme, or the pinned generator's own JS contains. A `sandbox`-only approach
  (serving the preview inside a sandboxed frame or with a restrictive CSP alone) was rejected: the
  preview's own JS (search, in particular) needs to make same-origin fetches back to the preview
  tree itself, and a sandbox that permitted that would need to be threaded through every page the
  pin generates, which is far more surface than a second, unprivileged origin.
- **The 64 KiB JSON cap, and the malformed-input rule.** `readBody` refuses early on a
  `Content-Length` already over 65536 bytes, and on the running total for a body with no
  `Content-Length` (chunked transfer), never buffering past the cap. A body over the cap gets 413
  with `Connection: close`; the request stream is drained rather than destroyed, so the client
  sees a clean response rather than a connection reset. Malformed percent-encoding in a URL, a
  NUL byte, or malformed JSON with an `application/json` Content-Type all get 400, never an
  uncaught exception (`src/serve/server.js`'s plain-`serve` handler has exactly this defect today,
  H9; `serve --admin` does not inherit it, and D11 tracks fixing plain `serve` separately).
- **Console silence, and exit codes (NFR08).** Nothing is written to the console between the
  three startup lines and the `stopped.` shutdown line: every request, refused or not, is
  silent, both because a page that can trigger repeated console writes could freeze a Windows
  `conhost` window that has QuickEdit selection active, and because it keeps the token (which
  appears once, in the first startup line, and nowhere else) out of any console-capture tooling. A
  handler that throws or a promise that rejects gets a clean 500 if headers have not been sent, or
  has its socket destroyed if they have (never a second `res.writeHead`, which would throw
  `ERR_HTTP_HEADERS_SENT` and, if that itself escaped the router's catch, crash the whole process
  under Node 22). Exit codes are unchanged from the existing frozen taxonomy: 1 for a flag,
  config, port, or listener-start failure; 3 for an unreachable vault; 0 for a clean Ctrl-C.

## 4. Reads: the fixed readable set

**The set itself.** `GET /api/state` (slice S2) reads exactly five things, and nothing a request
parameter names: the pack's `pack.toml`, the pack's `vault.config.json` (or the legacy
`site_config` file, for a `site_config`-sourced campaign, always read-only regardless of source),
the vault's `_meta/vault-config.md` frontmatter (never its body), the pack's `images/` listing,
and image bytes for a listed entry. `src/admin/packfiles.js` (slice S1) already fixed the first
two names; slice S2 adds `src/admin/packimages.js` for the third and fourth. `?include=palette`
(V1b, FR-19) derives the palette scheme from that same `vault-config.md` frontmatter; it reads
nothing new. No handler ever
builds a path from a request parameter: the pack-file names are a two-entry literal, and the
image name a request can supply is checked against the listing this same module already computed,
never joined onto `packDir` directly.

**`pack.toml` and `vault.config.json` display.** Both are read through `packfiles.readPackFile`,
which returns the raw bytes and a sha256 alongside `exists`. `pack.toml`'s raw text is parsed a
second time, with `parsePackToml`, to surface `theme` and the `[images]` slot map for display; a
parse failure never stops the panel from starting (section "Parse failures are data" below) and is
shown as the file's own `error` field, with `theme: null`. `vault.config.json`'s display value is
produced by re-reading the file through `loadSiteConfig`/`loadPackConfig` (whichever the campaign's
site source uses) rather than by parsing the `raw` bytes already read for the sha, a small,
accepted TOCTOU (see "A residual" below).

**`?name=` must exactly equal a listed entry (FR14).** `listPackImages` walks `<pack>/images`
recursively, through `src/vault/read.js`'s `listDir` only, skips symlinks and non-matching
extensions, and returns a sorted, flat list of POSIX-relative paths. `GET /api/image?name=<rel>`
and the display's own `images` field both come from this one function. `readPackImage` returns
bytes only when `rel` is *exactly* a member of that list, its realpath is still inside the pack
directory's realpath (`isInsideReal`, a second, independent check against a symlink swapped in
between the listing and the read), and its size is within `MAX_IMAGE_BYTES`. No traversal form
(`../`, `..%2f`, a drive letter, a UNC path, a trailing `:stream` suffix) can ever reach a name
outside the listing, because none of them can ever equal a listing entry, the check is
membership, not path-safety-after-the-fact.

**A symlinked image is not listed, and is refused by name even though its realpath is inside the
pack.** `listPackImages` skips every symlink while walking, so a symlink placed inside
`images/`, even one that points back at a file the listing already contains, never becomes a
listed entry, and a request naming it by its own filename gets 404 the same as any other name that
isn't listed. This is deliberately stricter than "is it inside the pack": the fixed readable set
is the *listing*, not "anything reachable under `images/`".

**The sandbox CSP on images (FR15).** Every image response carries
`Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`,
plus the usual `nosniff`, in place of the admin CSP, not alongside it. `respond.adminHeaders`'s
`extra` argument already overrides rather than merges with the base header set (confirmed, not
changed, by this slice), so a single call produces exactly this header set with no risk of the
admin CSP's `script-src 'self'` leaking onto an origin serving arbitrary, vault-authored SVGs. The
allowlisted extension-to-content-type map (`IMAGE_CONTENT_TYPES`) is the same six extensions
`src/build/themeassets.js` already accepts; an uploaded SVG's `<script>` is inert under `sandbox`
on the admin origin (it is not inert in a published build, section 11's residual).

**`_meta/vault-config.md`, frontmatter only (FR32).** `vaultConfigMd` is `read.readFrontmatter`'s
`data`, re-serialised as `JSON.stringify(data, null, 2)`; the file's Markdown body
(`readFrontmatter`'s `content`) is never touched by this code path at all, so there is no
body-redaction logic to get wrong, the value simply never reaches the handler that would return
it. A parse failure or a filesystem-level read failure both produce `{ ok: false, text:
<message> }`; neither ever includes the raw file.

**Amended by ADR 0033 (V1e-1).** A second, additive `?include=vaultconfig` payload
(`vaultConfigFile`) now also exposes the same file's raw frontmatter text, its whole-file sha256,
and the structured `publish.theme.tagline` value, still never the body. The default `/api/state`
and this `vaultConfigMd` field above are both untouched; see 0033.

**Amended by ADR 0033 (V1e-2, section 7).** `GET /api/prefs` reads one more file, but not from the
vault: the panel's own saved layout preferences, in the per-machine folder ADR 0033 already
covers. It is a separate route from `/api/state`, so this section's own "the fixed readable set"
still describes the vault-facing reads exactly as before.

**Parse failures are data, not a launch failure (FR21, SD-6).** A broken `pack.toml` (bad TOML, an
unknown theme, a non-string `theme`) or a broken `vault.config.json` (invalid JSON, a non-object)
never produces a 500 and never stops `serve --admin` from starting: `GET /api/state` catches the
parse inside its own field-builder and reports the exact message `check` would also report,
leaving that one file's edit surface read-only in the panel (a later slice's concern) until it is
fixed outside the panel. The same applies to a theme that fails to load (`loadTheme` throwing):
that entry's `scheme` is reported as `null` rather than aborting the whole `themes` list.

**The static resolver and the D11 fix.** `src/serve/static.js`'s `resolveStaticPath` is a pure
function with no network builtin: it decodes a URL's path exactly once, refuses on a NUL byte, a
backslash, or a colon (covering drive letters and NTFS `:stream` suffixes in one rule), and checks
containment with `path.relative` plus a `realpath` comparison, never a string-prefix
(`startsWith`) check, which is exactly the bug D11 (issue #78) fixes in plain `serve`: a sibling
directory whose name merely started with the served directory's name used to be reachable, and a
malformed escape such as `/%E0%A4%A` used to crash the whole process on an uncaught
`decodeURIComponent` throw. Both the preview listener (this section) and, after D11, plain
`serve`'s `createServer` now share this one resolver, so a fix to one path-safety rule can never
apply to only one of the two.

**A residual: the display TOCTOU.** `vault.config.json`'s displayed `siteTitle`/`landingTagline`
come from a *second* read of the file (through `loadSiteConfig`/`loadPackConfig`), not from the
`raw` bytes whose sha was already taken. Between those two reads, the file on disk could in
principle change. This is harmless today because slice S3's save precondition re-reads the file
and re-checks its sha256 immediately before writing, so a stale display value can cause a save to
be correctly refused (FR17), never a corrupted write.

## 5. Preview builds

**In-process, against the ctxInfo bound at launch, and why.** `src/admin/preview.js`'s
`runPreviewBuild` calls `runBuildForContext` (the same function `scriptorium build` itself calls,
after slice S2's structural decision 2 extraction) directly, in the panel's own process, passing
the launch-bound `ctxInfo` with only `output` overridden to the preview directory. A child
process was considered and rejected for two reasons. First, FR03: a fresh child process would
re-resolve the campaign and the site source from `config.toml` on disk, and no existing flag can
pin a rebuild to the exact site source (`--site-config` changes semantics rather than repeating
whatever the panel itself resolved at launch), which would silently break "resolved once, at
launch, fixed for the life of the process". Second, packaging: the packaged exe would need to
spawn a copy of itself, putting `child_process` on the admin code path for the first time, and
that spawn behaviour is unverifiable from Linux (this repo's own standing rule, "verify the
artefact, not the source", a packaged self-spawn is exactly the kind of thing that has silently
been broken on Windows before).

**Why repeated in-process builds don't corrupt each other.** The stale worry (H3) was that the
pin's own `build()` was "only ever called once per process". Reading the pin's own `lib/build.js`
shows its `require(resolvedConfigPath)` cache key is the staging directory's own config path,
which slice S2's `stagingDirFor` already makes unique per build (`.scriptorium-build-<pid>-
<timestamp>`), so Node's require cache never actually collides between builds; a grep of the
pin's `lib/` found no other module-level mutable state, and Scriptorium's own one piece of
module-level state (`src/generator/redactions.js`'s map) is already cleared at the start of every
build. `src/generator/bootstrap.js`'s doc comment, which used to say the opposite, is corrected in
this slice to point at the evidence below rather than asserting the old, untested claim.

**The NFR02 evidence.** `test/admin-preview.test.js`'s NFR02 test runs three preview builds in one
process against a scratch copy of `test/fixtures/vocab-vault`, changing the pack's theme to
`haze` between builds 1 and 2 and a `[labels]` value between builds 2 and 3, then spawns a fresh
`scriptorium build` process against the same, now-thrice-edited inputs and compares the third
in-process build's tree to the fresh process's tree file-by-file, byte-by-byte. Both trees matched
exactly, over every file the fixture produces. The same sequence was re-run against the packaged
Linux binary (NFR06; see the Engineer's gate log for the exact run) with the same result. Had
either comparison failed, the fallback seam is `runPreviewBuild` alone: it is the only function
that would need to change to a child-process implementation, because the async mutex
(`runExclusive`) that already guards every build call is process-implementation-agnostic.

**The preview root, and why it is never beside the configured output.** `ensurePreviewRoot`
creates the root lazily, on the first build, as `fs.mkdtempSync(path.join(os.tmpdir(),
'scriptorium-preview-'))`; the preview's own `finalOut` is `<root>/site`. Because
`src/build/plan.js`'s `stagingDirFor` always stages as a sibling of whatever `finalOut` it is
given, a preview build's staging directory always lands inside the preview root too, never beside
the campaign's *configured* output, so `sweepStaleSiblings`, which a concurrent CLI `build` of
the same campaign runs at the start of its own build, can never reach anything belonging to a
preview. `ensurePreviewRoot` also fails closed, refusing to proceed, if the new root's real path
ever turns out to equal the configured output's own parent directory; this is a defensive
completeness check (`fs.mkdtempSync`'s random suffix means it can never fire through ordinary
misconfiguration) rather than a reachable one, and it is exercised in tests only by replacing
`fs.mkdtempSync` itself.

**Cleanup is best-effort at shutdown.** `removePreviewRoot`, called from `serve-admin.js`'s SIGINT
handler after both listeners have closed, does one `fs.rmSync(root, { recursive: true, force:
true })` inside its own `try`/`catch`, with any failure swallowed, the same pattern
`src/build/run.js` already uses for a staging-tree cleanup failure. A locked file (the realistic
case on Windows: a browser tab still holding the preview open) must never change Ctrl-C's exit
code; `test/admin-preview.test.js`'s EBUSY test proves this by injecting a throwing `fs.rmSync`
and confirming SIGINT still resolves `{ exitCode: 0, human: 'stopped.' }`, with the injected patch
itself confirmed to have actually been reached.

**A build blocks the panel while it runs (R9, accepted).** Both `check` and a preview build run
inside `runExclusive` with the labels `'check'` and `'build'`; a second request of either kind
while one is already running gets 409 `{ error: 'busy', busy: <label> }` rather than queueing or
running concurrently. The build itself is synchronous, so the whole panel, every other route,
on the same event loop, is unresponsive for the build's duration. V1b's SD-8 (section 13) is
the UI half of this: every run/save control's `disabled` is its own state OR `store.get().busy
!== null`, re-evaluated on a store change, so this reads as "busy", not "broken", V1c's job is
only ever to set and clear `busy` itself, never to touch these controls' own disabling logic.

**`require.cache` grows by one entry per build (a residual).** Each in-process build's unique
staging config path becomes a new, permanent entry in Node's module cache for the life of the
panel process; nothing currently evicts old entries. A long-running panel session accumulates
this. It is accepted, not fixed, in this slice (see section 11).

**A vault with any ERROR finding can never preview (FR29).** `runPreviewBuild` offers neither
`--force` nor `--no-check`: it is the same pipeline `scriptorium build` runs by default,
unconditionally, so a refusal is never overridable from the panel. A refused build writes nothing
new; the previous preview, if any, is left byte-for-byte as it was (`test/admin-preview.test.js`'s
FR29 test proves this by snapshotting the tree before the refusal and diffing after). This is a
real product-visible consequence worth restating plainly: **while the live campaign has any
ERROR-severity finding, its first preview build from the panel will be refused**, with no flag to
override it from here.

**`ctx.previewRoot` is added dynamically, not as a `context.js` field (a residual).**
`src/admin/preview.js`'s `ensurePreviewRoot` sets `ctx.previewRoot` the first time it runs, rather
than `createAdminContext` initialising it alongside `previewDir`, `busy` and the rest. This is
because slice S1's own `test/admin-context.test.js:178-192` deep-equals `createAdminContext`'s
return value against a literal object that predates this field; adding `previewRoot: null` to that
literal would break a frozen S1 test this slice does not edit. The residual: anything that
enumerates or serialises `ctx` before the first preview build ever runs will not see
`previewRoot` at all, since the key simply does not exist on the object yet. No call site does
that today; the only thing ever spread out of `ctx` is `ctx.ctxInfo`, in `runPreviewBuild`.

## 6. The write exception

P8-D01 was taken as its documented default under the owner's delegation, on 2026-09-28; the owner
reviews the decision on 2026-09-29. The default is a second, narrower chokepoint,
`src/vault/packreplace.js`, kept deliberately separate from `src/vault/packwrite.js` rather than
extending it. This supersedes `docs/decisions/0021-init-first-run-setup.md`, section "The narrow exception" ("phase 8
extends [the pack writer] rather than adding a second write path"): editing an existing file needs
a rename, and `test/pack-write.test.js`'s PW14 forbids `rename`, and every other non-`wx` write,
inside `packwrite.js`. The rejected alternative, amending PW14 so `packwrite.js` could rename,
would have edited a constraint test to make a fix pass, which CLAUDE.md treats as an escalation
rather than a decision available to an Engineer. Overwriting the target in place was rejected too:
it is not atomic, and a reader could observe a half-written file.

This amends `docs/decisions/0018-campaign-pack.md`, section "Decision" ("GM-Scriptorium reads a pack and never
writes to it. ADR 0021's `init` is the single, narrow exception, and it is create-only") and ADR
0006's second reason for "no vault write" (the vault is single-writer, worked directly by a
curation agent), with its own justification:

- The GM is the one editing, interactively, through a panel they themselves launched: this is not
  an automated agent writing to a vault out from under a human.
- Only two files can ever be touched, both inside `_meta/scriptorium/`, the one directory curation
  is already told not to edit.
- Every save carries an optimistic-concurrency precondition (FR17): a save whose sha256 no longer
  matches the file on disk is refused, never silently overwritten.
- The GM is expected to commit the vault to git before using the panel, so any edit the panel
  makes is one `git diff` away from being reviewed or reverted; the panel itself never commits.

**Amended by ADR 0033 (V1e-1).** A third file joins the write exception,
`_meta/vault-config.md`, outside `_meta/scriptorium/`, through its own separate chokepoint and
always backed up first, so the "two files" and "directory curation is told not to edit" bullets
above no longer describe the whole exception. 0033 carries the curation-agent co-writer argument
for that file, which sits outside curation's own no-edit convention.

### What `packreplace.js` enforces

Every replace follows the containment logic `packwrite.js` already established, plus checks of
its own:

1. The name must be exactly `pack.toml` or `vault.config.json` (`REPLACEABLE_FILES`), matched in
   exact case: nothing else can ever be named, structurally excluding `.md` files, `PACK.TOML`,
   and any path.
2. The data must be a plain, LF-only string with no leading byte-order mark: anything else is a
   Scriptorium programming error, not a refusal a GM would ever see.
3. `_meta` and the pack directory must both resolve, through `fs.realpathSync`, inside the
   vault's own real path, folded per platform exactly as `packwrite.js`'s `isInsideOrEqual`
   already does.
4. The target itself must be a regular file, checked with `fs.lstatSync`, never a symlink: a
   symlinked `pack.toml` is refused before anything is read from it. A target that has
   disappeared entirely is treated as "changed outside the panel", not a plain I/O failure.
5. The target's own real directory is re-checked against the pack directory's real path,
   independently of step 3: deliberate defence in depth against the gap between containment
   being checked and the file actually being touched. This is an EXACT match, folded, not
   "inside or equal" the way step 3's own vault-containment checks are: `REPLACEABLE_FILES`
   names are always slash-free and the target is always literally `path.join(packDir, name)`,
   so the target's own resolution can only ever coincide exactly with the pack dir's under any
   real call; accepting a descendant (the target's directory resolving to a subfolder of the
   pack dir) was reachable only through a mocked test, never a real one, and only widened the
   TOCTOU residual below for no benefit a legitimate caller could ever see.
6. A precondition read takes the target's current sha256 and compares it against the sha the
   panel loaded. A mismatch refuses immediately, before any temp file is written.
7. The write itself is a crash-safe temp file: `openSync(tmp, 'wx')` beside the target, inside
   the pack directory, `writeSync`, `fsyncSync`, `closeSync`, then `renameSync` over the target.
   A hard-linked copy of the target is untouched by the rename, because a rename only repoints
   one directory entry.
8. Nothing that existed before this call is ever deleted; a failure at any step removes only the
   temp file it created, best-effort, and leaves the target exactly as it was.

### The retry decision (SD-2)

`packreplace.js` has its own bounded retry loop rather than reusing `swap.js`'s
`renameWithRetry`, and reuses only the `RETRY_DELAYS_MS` constant (`[100, 200, 400, 800, 1600]`,
one attempt plus five retries, 3.1 seconds at most). It retries only `EPERM`, `EBUSY` and
`EACCES`, and re-hashes the target before every attempt, including the first, aborting with
"changed outside the panel" the moment the hash no longer matches rather than clobbering
whatever is now there.

Two alternatives were rejected:

- **Reusing `renameWithRetry` directly.** It retries every error code with no filter, including
  `ENOENT` and `EISDIR`, neither of which will ever succeed on a second attempt: that would
  freeze the panel for the full 3.1 seconds for nothing. It also has no per-attempt sha check, so
  it would happily rename over a file that changed mid-retry.
- **An async retry**, with an `await` between the sha check and the rename. It would put a real
  window inside the panel's own event loop for no benefit a GM could observe: `runExclusive`
  already holds the write lock across the whole call either way, so the synchronous version has
  no extra risk and one less moving part.

The accepted cost: in the worst case, when another program holds the file open, the panel freezes
for up to 3.1 seconds. That is the same class of cost R9 already accepts for a synchronous
preview build.

### D06: formatting on save

A save is parse, edit, re-serialise: TOML through `smol-toml`, JSON with two-space indentation
and a trailing newline. Every save is therefore a real, if usually invisible, reformat:

- Formatting choices smol-toml makes (quoting style, spacing) are normalised on the first save of
  a multi-table file; a single-key file such as a bare `theme = "haze"` round-trips
  byte-for-byte, which is what the test suite pins its literal comparisons to.
- Comments are lost. The live pack has none today (p3b live runbook), so this is a residual
  against a hypothetical future pack, not the current one; the UI warns before every save that
  removes one.
- Integer-like JSON object keys are reordered, because that is how a JS object orders its own
  keys, not an explicit choice this code makes.
- A TOML float written as `1.0` comes back as `1` after a round trip through smol-toml, which
  formats an integer-valued float without a decimal point unless the number is not a safe
  integer.

### D03: the editable set

`siteTitle` and `landingTagline` are the only `vault.config.json` keys the panel can write; the
tagline may be empty, and otherwise follows the title's one-line rule. `folderMap`,
`excludeDirs`, `excludeSections`, `excludeCallouts`, `attachmentsDir`, `siteUrl`, `host` and
`backend` stay read-only, because those decide what gets published rather than how it looks.

**Amended by ADR 0033 (V1e-1).** `landingTagline` is no longer writable here: it was dead config
(the site only ever reads `publish.theme.tagline` in `_meta/vault-config.md`), and is refused with
an unknown-field 400. `siteTitle` is now the only editable `vault.config.json` key; the tagline is
`publish.theme.tagline`, edited through the new vault-config.md chokepoint instead.

### Vocabulary edits

The vocabulary editor (FR25) covers every key ADR 0020 section 3 defines: the 17 `[labels]`
entries, `[timeline]`'s kinds, weights, `session_token`, `segment_units` and `[timeline.columns]`,
and `[recaps] learned_heading`. It reuses `runSave` unchanged (Structural decision 4): the
endpoint is `POST /api/pack/vocab`, with `name: 'pack.toml'`, `baseShaAllowsNull: false` and
`requireAtLeastOneOf: ['labels', 'timeline', 'recaps']`, so a missing `pack.toml` behaves exactly
like every other vocab refusal on a missing file, a 409 `changed`, and the panel shows "Save a
theme first; that creates pack.toml." The GM makes `pack.toml` exist by saving a theme, the same
precondition FR22 already gives the theme picker.

The merge follows one rule throughout: each key the GM actually provided is set to that value;
`null` removes the key, so the file's own default (or the campaign's inherited default) applies
again; a key not mentioned in the request is left exactly as it was on disk. A table left with no
keys after removals is dropped from the file entirely, never written out as an empty `[table]`
header. `[timeline.kinds]` is the one field that is replaced as a whole, or removed with `null`,
because a kind entry is itself a small table with its own unrecognised-key survivors (a GM who
never touches a `color` field some other tool wrote into a kind gets it back unchanged), and
`[timeline.columns]` gets the same key-by-key merge as `[labels]` and `[recaps]`, not a whole-table
replace. Whole-table replacement for every field was rejected outright: it would silently drop any
unrecognised on-disk key the moment the GM touched an unrelated key in the same table, which
directly violates FR20's "a save changes only the keys that were edited" guarantee.

Validation runs in two passes, in a fixed order. The first is shape-only, entirely inside this
slice (`validateVocabEdits`): the right tables, the right value types, no `null` outside the
documented positions, and a blanket refusal of `__proto__`, `constructor` and `prototype` at any
depth, including inside a `[[timeline.kinds]]` entry, which is the one place no other check would
catch it (kind entries deliberately allow unrecognised keys). Only once the shape passes does the
edit get built into a candidate `pack.toml` and handed to `parsePackToml`, the exact function
`check` and `build` already use. That second pass is where FR25's "the same message `check` prints"
guarantee comes from for free: nothing in this slice re-implements the regex, glyph, weight-count
or capture-group rules ADR 0020 already owns, so an invalid `session_token` or an under-specified
`timeline.kinds` entry is refused with the identical `ConfigError` message, because it is the
identical code path that produces it.

`GET /api/state` gains exactly two optional behaviours (V1b widens this from one), each behind its
own exact include name, comma-separated or repeated (`?include=vocab,palette` and
`?include=vocab&include=palette` are equivalent), with an unknown name ignored: `?include=vocab`
adds a `vocab` key holding the raw on-disk `[labels]`/`[timeline]`/`[recaps]` tables (or `null` for
a table that is absent, or for a `pack.toml` that fails to parse, with the parse error in
`vocab.error`) plus the same defaults `DEFAULT_VOCAB` already carries; `?include=palette` (V1b,
FR-19) adds a `palette` key, `{ scheme, background, error }`, derived from
`src/checks/themescheme.js`'s own `paletteScheme()` (the same function `config/theme-scheme-mismatch`
uses), with `palette` always appended last when both are requested. The membership test is exact
(a `Set` built from the include values, with no trimming and no case-folding), so a prefix or
substring match (`palettes`, `Palette`, `pal`) never matches. Without either parameter the response
is byte-identical to what S2 shipped, because S2's own test deep-equals the whole body and the
route table is frozen; no slice may widen the default shape of an already-shipped endpoint, so
each addition hides behind its own explicit opt-in instead.

**Amended by ADR 0033 (V1e-1).** A third include, `vaultconfig`, is appended after `palette`,
adding a `vaultConfigFile` key. Same rule: exact-name membership only, and the default shape (and
`?include=vocab,palette`'s own shape) stay byte-identical.

Injection is closed the same way pack writes have always been closed: `smol-toml`'s `stringify`
quotes every string value it writes, so a label containing `" ] [images] hero = "y` round-trips as
a literal string value, never as new TOML structure, and the label-string validator ADR 0020
already applies (`validateLabelString` in `src/build/labels.js`) refuses any control character
before the value ever reaches the serialiser, which also rules out a value that could terminate a
TOML string early through an unescaped control byte. The ReDoS residual ADR 0020 section 6 already
accepts for `session_token` and `segment_units` (a pathological pattern can hang a synchronous
`check` or `build`) is inherited unchanged: this slice adds no new regex engine and no new
mitigation, because the panel runs the same synchronous parse the CLI always has.

### Residuals

- **TOCTOU gaps.** Between the last sha check and the eventual `renameSync`, and separately
  between the containment check and the rename: closing either would need real OS-level file
  locking rather than check-then-write, judged disproportionate to a single-GM local tool.
- **Atomic replace over SMB is unproven.** No criterion here ever runs the panel against a mapped
  drive, so the owner's first real use against the live vault (mapped to a network drive) is also the first
  test of it there.
- **Temp files left behind by a crash are never swept.** The panel only ever replaces or creates;
  it never deletes, so a `.scriptorium-tmp-` file orphaned by a hard crash mid-write stays in the
  pack directory until someone removes it by hand.
- **The stale "single write chokepoint" comments.** `packwrite.js:9` and `read.js:20-22` still
  describe `packwrite.js` as the sole writer; the phase-6 scrub is where these get corrected,
  deliberately left as a known residual rather than edited here, to keep this change out of two
  files this brief does not allow touching.

Will catch / will not catch for writes are folded into sections 10 and 11 above, alongside every
other slice's controls.

## 7. Uploads

Uploads are a raw request body, not multipart (SD-1): `POST /api/images/upload?name=<name>` must
carry `Content-Type: application/octet-stream`, the name comes only from the query string, and the
cap is exactly `MAX_IMAGE_BYTES` (10485760 bytes), so FR13's upload overhead is 0. Multipart was
rejected: it needs a parser this repo does not already depend on (either new code or a new runtime
dependency, both of which CLAUDE.md gates explicitly), and its own framing bytes do not count
toward the file, muddying the cap.

### Name rules (SD-2)

`src/admin/uploadname.js`'s `validateUploadName` is the one place a client ever names a file the
panel writes. The checks run in a fixed order and the first failure wins, so the message a GM sees
always names the single most specific problem:

1. not a string, or empty
2. longer than 128 characters
3. a Windows-illegal character, a separator (`/` or `\`), the NTFS alternate-data-stream `:`
   suffix, or a control character (`\u0000`-`\u001f`, `\u007f`)
4. starts with a dot
5. contains `..`
6. ends with a dot or a space
7. a reserved Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`,
   followed by a dot or the end of the name, the anchor is load-bearing: `COM10` is not `COM1`
   followed by a dot, so it is accepted, and so is `CONSOLE`)
8. `.md` (check reads every Markdown file under `_meta`; a `.md` upload would look like vault
   content it never wrote itself)
9. any extension other than jpg, jpeg, png, webp, gif, svg or avif (`themeassets.js`'s own
   `IMAGE_EXT_RE`, so the upload allowlist and the build-time allowlist can never drift apart)

The 128-character cap and the full Windows-illegal-character set go beyond the Lead's own list;
both fail closed rather than waiting for a Windows-specific report.

### Create-only, through the one write chokepoint

An accepted upload is written as two entries through `packwrite.createPackEntries`: a `dir` entry
for `images/` (tolerated if it already exists) and a `file` entry for `images/<name>`, written with
`wx` (`O_CREAT|O_EXCL`). There is no separate upload-write path and no second chokepoint: this is
the exact same function `saveTheme`/`saveSettings`/`saveSlots` write pack.toml and
vault.config.json through, called via the module object (as pack.js's write path already does) so
a test can patch it to simulate the EEXIST race deterministically.

### `images/` must be a real folder (SD-4)

If `<packDir>/images` already exists, its real path (`fs.realpathSync`) must equal
`path.join(fs.realpathSync(ctx.packDir), 'images')` **exactly**, folded per `platformFoldsCase()`.
Anything else, a missing `images/`, is fine and gets created by the write above. This is an
equality check, never a prefix or "inside or equal" check: a prefix check would wrongly accept a
sibling folder whose name happens to start with "images" (`images-real`), and an argument-swapped
"inside" check would wrongly accept a symlink to an ancestor (the vault root, or `_meta`). The
equality check catches all four shapes uniformly: a symlink to an ancestor, to a folder outside the
vault, to a prefix-named sibling inside the pack, and a Windows junction (which resolves through
`realpathSync` exactly like a symlink does). `createPackEntries`'s own parent-containment check
(`isInsideOrEqual`) stays as the backstop against a race between this check and the write.

### Collisions (SD-5)

Inside the write lock, the top level of `images/` is listed with `read.listDir` and each existing
name is compared against the upload name **for equality**, folded per `platformFoldsCase()` on
win32/darwin. A match gives 409 `exists`, and the upload is refused before anything is written; the
original file's bytes are therefore always untouched by a collision. This is equality, not a prefix
match, so `crest.png.old.webp` already existing does not block a `crest.png` upload.

As a backstop, a `ConfigError` from `createPackEntries` (the `wx` write failing with `EEXIST`) is
re-mapped to 409 `exists` if `images/<name>` exists on disk at that point, or to 400 `invalid`
otherwise. This is what a same-request race or an NTFS 8.3 short-name collision falls into: neither
is visible to the equality comparison above (the short name is not what `read.listDir` returns),
but both fail closed as `EEXIST` at the filesystem layer, which is C41 step 6's Windows-only
evidence for.

### The slot hook, and why it runs on the candidate only (SD-3)

`POST /api/pack/slots` reuses `src/admin/handlers/pack.js`'s `runSave`/`buildAndWrite` exactly the
way `saveTheme` and `saveSettings` do (`pack.js` gains nothing beyond one hook and the exports
line, per SD-7), with one addition: an optional `candidateCheck(text, parseResult, ctx)` hook that
`buildAndWrite` runs as a new step "9b", after the candidate's own `productParse` and before the
dry-run branch. For slots, the hook runs `planThemeAssets` against the **candidate** pack.toml
only, it never sees the on-disk file. `runSave` passes the hook through as a single optional
property only when the endpoint defines one, so `saveTheme`/`saveSettings` are byte-for-byte the
call they always were.

This exists because `productParse` alone cannot tell "this slot is fine" from "this slot points at
a broken file": TOML syntax validation (`parsePackToml`/`validateSlotValue`) and file-existence
validation (`planThemeAssets`) are different checks, run by different code, at different times. If
the file check ran inside `productParse` itself, the same function `buildAndWrite` already runs
against the on-disk text at step 7, a slot that was already broken on disk (its target deleted or
moved outside the panel) would make step 7 itself refuse with 422 `invalid-on-disk`, and the GM
would have no way to ever clear it through the panel. Running the file check only against the
candidate, in its own step, means a broken on-disk slot can always still be cleared (setting it to
`null`), and a *newly* broken slot is refused with exactly the message `build` itself would give,
because both call the same `planThemeAssets`.

### Everything in `images/` is published

The panel's upload form says so directly: every file under `images/` ships with the site once a
build runs, whether or not any slot currently references it. There is no separate "unused uploads
are pruned" behaviour, and none is planned; an upload is a permanent addition to the pack until
someone removes the file by hand.

### Residuals

- **Superscript device names.** `COM¹`, `LPT²` and similar Unicode superscript-digit forms are not
  matched by the reserved-name regex (which only recognises ASCII `1`-`9`), so they are accepted
  even though some Windows tooling still treats them as aliases for the plain device name.
- **Unicode normalisation.** A name that normalises to `CON` under NFKC or NFD but is not literally
  `CON` in NFC (the form JavaScript string literals and `RegExp` compare) is accepted.
- **Zero-width characters.** A name containing a zero-width character (for instance a zero-width
  joiner) is accepted and written under its literal name inside `images/`. That is not a containment
  break, but it can render identically to another file in a listing.
- **Leading spaces.** Only a trailing dot or space is refused (check 6); `"   crest.png"` passes
  every check.
- **Case-insensitive Linux mounts.** `platformFoldsCase()` is a `process.platform` check, not a
  filesystem probe, so a case-insensitive filesystem mounted under Linux (an exFAT USB drive, for
  instance) still gets case-sensitive collision behaviour here.
- **A symlink inside `images/` is refused even though it might be harmless.** `planThemeAssets`'s
  own walk of the pack's `images/` folder (used at build time, not by the upload path) refuses any
  symbolic link found there unconditionally, with no attempt to check whether it happens to resolve
  safely inside the pack. This slice does not relax that: uploads never create a symlink, and
  nothing here re-validates one placed by hand.

### Rejected

- **Multipart.** Covered above (SD-1): a new parser this repo does not already depend on, for no
  benefit over a raw body plus a query-string name.
- **Replacing or renaming an existing upload.** Every write is `wx`; a collision is always refused,
  never silently overwritten. A GM who wants to replace a file removes it outside the panel and
  uploads again. Renaming has the same shape (it would need its own chokepoint, since
  `packwrite.js`'s only write mode is create).
- **A separate `slots/` folder (P8-D08).** Slots reference either an uploaded file under `images/`
  or a `vault:` path; there is no third location a slot image can live, and no separate upload flow
  for one. This keeps "everything under `images/` is published, and nothing else the panel writes
  is" a single, exception-free rule.

## 8. GM link and the unconditional output-gate marker

The panel's whole point, section 1's "without ever changing what a published build contains,"
rests on two things holding together: a preview build gets a link back into the panel, and a
published build never can. This slice builds both halves and the machinery that keeps the second
one true even when a future change gets the first one wrong.

**The marker (SD-1).** `src/build/gmmarker.js` defines `GM_LINK_MARKER =
"data-scriptorium-gm-link"` once, and nowhere else: `test/gm-link-structure.test.js` pins that the
literal string appears under `src/` only in that one file, so a future writer cannot introduce a
second copy of the marker that would escape the containment tests below. The same module's
`findGmLinkMarker(dir)` is the one detector both the writer and the gate use. It walks with
`readdirSync(dir, { withFileTypes: true })`, recursing only into `isDirectory()` entries and
reading only `isFile()` entries, so it never follows a symlink in either direction a walk could
meet one (a symlinked directory it might otherwise recurse into, or a symlinked file it might
otherwise read). It reads every regular file as raw bytes and checks `Buffer.includes`, covering
every file type the build emits, not only `.html`: the pin's own `search-index.json` carries raw
page text (Track D2's existing `scanSearchIndex` arm already proves that shape of leak is real),
so a marker that only reached the search index would still have to refuse the build.

**The gate (SD-2).** `src/build/outputgate.js` gains `scanGmLinkMarker({ stagingOut, campaign })`,
a second, independent scan alongside the existing `scanStagingOutput`, returning
`build/gm-link-marker` findings (severity `error`, category `build`, `outputPath` set to the
relative path) with the message naming the file and stating plainly that `--force` cannot override
this. `src/build/run.js` calls it on its own, in a block placed immediately before the existing
leak-scan comment and entirely outside that scan's `force` handling: a hit removes the staging
tree best-effort and returns `{ ok: false, refusedByScan: true, findings, stagingRoot: null }`
before the leak scan, `scanHasError`, or the `!force` check are ever reached. `runAtomicBuild`'s
signature gains no new parameter, so there is no argument any caller, present or future, could
pass to skip this. The rejected alternative was folding the marker finding into
`scanStagingOutput` itself: that scan's own hits are exactly what `force` is built to override
(`run.js`'s existing `scanHasError && !force` branch), so a marker finding routed through it would
inherit that override and FR34(b) would fail the moment anyone passed `--force`.

**Reusing `refusedByScan` (SD-3).** Rather than inventing a third result shape, the marker gate
returns the identical `{ ok: false, refusedByScan: true, findings, stagingRoot: null }` envelope
the pre-existing leak scan already produces on a hit. `src/cli/build.js`'s handling of that shape
(`:189-214`) already exits 2 unconditionally, regardless of `--force`, and already writes nothing
and prints every finding, both properties this feature needs for free, without editing
`build.js` or its own module graph at all. The one residual this reuse carries: the human-readable
line still reads "the output-leak scan found N error finding(s)," which is now not quite literally
true for a marker-only refusal (it is a different scan). Recorded here rather than fixed, per the
Lead's orchestrator note: changing that wording is a `build.js` edit left for a later slice, if the
owner wants distinct wording.

**The writer (SD-4).** `src/admin/gmlink.js`'s `injectGmLinks(ctx)` walks `ctx.previewDir` the same
symlink-safe way the detector does, and for every `.html` file that has a `</body>` and does not
already carry the marker, inserts exactly one snippet, a `<div class="content
scriptorium-gm-link" data-scriptorium-gm-link>` wrapping a single `<a>` to the admin origin root
immediately before the first `</body>`, using the same `String.replace` idiom
`src/build/notice.js`'s own footer pass already uses. Because the notice footer runs earlier in
the pipeline and uses the identical idiom, the GM link always lands after it in the page. A page
with no `</body>` is left untouched, exactly like the notice pass's own bare-redirect-page case.
Re-running the injector against an already-linked tree is a no-op: it detects the marker and skips
that page, so the panel can call it every time a preview build succeeds without ever risking a
second link.

Two preconditions guard the writer against being pointed somewhere it should never write:
`ctx.previewDir` must be exactly `path.join(ctx.previewRoot, ...)`'s immediate `site` child (an
exact `path.dirname(ctx.previewDir) === ctx.previewRoot` compare, not a string-prefix or
"inside-or-equal" check, either of which would wrongly accept a prefix-named sibling directory or
the root passed as its own child, see the Engineer's mutation table for the exact shapes each
alternative lets through), and `ctx.adminPort` must be a real, already-bound integer port. Both
failures throw a `ScriptoriumError`: a programming error the writer should never actually hit in
production, not a user-facing refusal.

**Why the link is added after the gate, and only in the preview (SD-5).** `src/admin/preview.js`
gains `buildPreviewWithGmLink(ctx)`: call the existing `runPreviewBuild(ctx)` unchanged, and only
when it returns `exitCode === EXIT_CODES.OK`, call `gmlink.injectGmLinks(ctx)`. `runPreviewBuild`
itself is never touched, because slice S2's own `test/admin-preview.test.js` calls it directly and
asserts its NFR02 byte-identity and FR29 refusal properties against an unpatched tree, adding the
link inside it would silently break both. The ordering is the entire point of this slice: FR34(b)'s
gate runs, unconditionally, as part of the build `runPreviewBuild` performs, against the staged
tree, before that tree is ever swapped into `ctx.previewDir`. The GM link is added strictly after
that swap has already happened, so the link is never present anywhere the gate itself inspects,
there is no ordering under which a preview build could see its own about-to-be-added link and
refuse itself. `src/admin/handlers/views.js`'s `previewHandler` is a one-line change, calling
`buildPreviewWithGmLink` in place of `runPreviewBuild`; the response shape of `POST /api/preview`
is unchanged.

**The structural test and its positive control (SD-6, FR34(a)).**
`test/gm-link-structure.test.js` walks the real module graph, using the same walker
`test/generator-module-graph.test.js` already established, from two different entrypoints:
`src/cli/build.js` and `src/cli/serve.js`. The build graph must not reach `src/admin/gmlink.js`,
or any file under `src/admin/` at all, the published path has no reason to ever load the admin
side of the codebase, and this test makes that structural rather than a matter of nobody adding
the wrong `require` later. The same test asserts the serve graph *does* reach `gmlink.js`: without
that positive control, a broken or over-narrow walker that resolved nothing would report the same
"build.js doesn't reach it" result while proving nothing at all, which is exactly the kind of test
CLAUDE.md's testing standards ask to be named and refused as evidence. The same file also pins
which files may contain the marker literal or the `GM_LINK_MARKER` identifier at all, closing the
loop SD-1 opens: a second copy of either would not just be untidy, it would be a second place a
future writer could reach without this structural test ever noticing.

**No token, and `127.0.0.1` (FR33).** `gmLinkHref(port)` builds exactly `http://127.0.0.1:<port>/`
the admin origin root, nothing else, and the token is never part of it. This follows directly
from P8-FR07's rule that the token is "never placed in any preview file": a script in a vault-
authored page, or the pin's own generated JS, runs on the preview origin and could read anything
embedded in the page it sits inside, so the only way to guarantee the token never leaks through a
preview page is for it to never be there in the first place. `127.0.0.1` rather than `localhost`
matches the rest of the panel's own convention (`gmLinkHref`'s literal, `adminUrl` in
`serve-admin.js`) and avoids a hostname a local resolver could ever remap.

**Residuals:**
- A GM who is used to opening the panel at `localhost:<port>` rather than `127.0.0.1:<port>` and
  clicks the GM link from a preview page lands on the locked page, not the panel: the link is
  built with the literal address, and the two are different origins as far as the Host check
  (section 3) is concerned. Re-authenticating from the terminal-printed URL still works; this is
  not a security gap, only a minor friction the ADR records rather than special-cases away.
- A vault note whose own prose happens to contain the literal text `data-scriptorium-gm-link`,
  entirely plausible for a GM writing about this very feature, blocks every build, published and
  preview alike, until the text is removed. The finding names the exact file
  (`build/gm-link-marker`'s `outputPath`), so this is loud and diagnosable rather than a silent
  failure, but it is a real, user-visible cost of an unconditional, content-based gate with no
  suppression mechanism (deliberately, mirroring Track D2's own "no allowlist" decision).
- The detector and the gate both read every staged file's full bytes, including every binary
  asset the build emits (images, fonts, the packaged CSS/JS), not just `.html`. This is
  deliberate (SD-1's search-index reasoning applies equally to any file the pin might embed
  page text into), and it is also Risk area 3/6's performance cost: one more full read of the
  staged tree per build, timed in the gate log (see Performance below).
- A GM who manually copies the preview directory into a deploy path outside the tool entirely.
  The GM link would ship in that case, even though it only ever points at `127.0.0.1` and is
  therefore harmless to anyone else who loads the page, this is the same residual section 11
  already lists for exactly this scenario; nothing about this slice narrows it, because the gate
  only ever inspects what `scriptorium build` itself stages, never a file copy made by hand.

**Performance.** The marker detector reads every staged file's bytes once more than the pipeline
already did (a second full pass over the staging tree, in addition to the pre-existing leak
scan's own read). Measured against the live campaign and against `vocab-vault`/`mini-vault`: see
the Engineer's gate log (`GATE.md` section 3) for the exact median-of-three timing this slice
recorded; any slowdown is noted there, not gated on, per the brief.

## 9. Rejected alternatives

- **CORS, in any form.** Emitting `Access-Control-Allow-Origin` for the preview origin (or any
  origin) would undo the entire point of splitting the two listeners: it would let preview
  content's own script read admin API responses directly, rather than merely being unable to
  write to them. Rejected outright; neither listener ever emits an `Access-Control-*` header.
- **A same-origin preview.** Serving the preview tree from the admin origin (or as a sub-path of
  it) was rejected per H5: every script in a built site, the pinned generator's own JS,
  `scriptorium.js`, and anything vault-authored, would then pass the admin listener's Origin
  check for free, because it would BE the admin origin. The two-listener split is what makes
  FR11 possible at all.
- **A sandbox-only preview**, discussed in section 3 above: rejected because the preview's own
  same-origin search fetches need to keep working, and a sandbox permissive enough to allow that
  is no longer meaningfully sandboxing anything.
- **Fragment-plus-header token carriage (the D02 alternative).** Cookie-free, but breaks a plain
  browser navigation (the GM link in a preview page, slice S6) and needs the terminal URL again
  for every new tab. Rejected in favour of the cookie exchange (section 3).
- **Token-in-URL only, no exchange.** Leaves the token in the address bar, browser history, and
  any `Referrer` header a page on the panel might send, indefinitely, rather than for the single
  `/auth` request. Rejected.
- **`--host` for `serve --admin`.** Plain `serve --host` exists because published-but-not-yet-
  checked content sometimes genuinely needs LAN access for review. There is no equivalent
  legitimate use for the admin panel: it edits a live pack with no authentication story beyond
  loopback-plus-token, and a GM who needs remote access already has SSH local forwarding
  available (P8-D12), which keeps the bind itself unchanged.
- **Reusing `startServer` (plain `serve`'s listener) for the admin/preview listeners.**
  `startServer` takes a `host` parameter and defaults to `127.0.0.1` rather than refusing anything
  else; the admin panel's guarantee needs to be structural (no parameter to widen), not a default,
  so `startLocalListener` is a separate, narrower primitive with no `host` argument at all.
- **CSRF tokens instead of an exact Origin check.** A synchroniser-token pattern (a hidden field
  or header carrying a server-issued nonce, checked per request) is the traditional CSRF defence
  and would work, but it duplicates what the Origin check already gives for free here, since every
  legitimate admin request is same-origin by construction and the only realistic use of "cross
  origin" traffic against this panel is an attacker's page, never a legitimate third party.
  Origin is simpler, is already mandatory context on every fetch/form/XHR a browser sends, and
  covers the simple-request case (form POST, multipart, `text/plain`) that a preflight-only
  defence would miss entirely.

## 10. Will catch

- DNS rebinding. **S1**, the Host allowlist.
- Cross-site and cross-origin writes, including simple-request POSTs (form, multipart,
  `text/plain`) and pages served from other localhost ports, including the panel's own preview
  listener. **S1**, the exact Origin check.
- Other local users on the same machine who don't have the token. **S1**, the token plus the
  loopback bind.
- Scripts in preview content making admin API requests. **S1**, the separate preview origin (the
  preview tree itself is built starting **S2**).
- Clickjacking (embedding the panel in a frame on any origin). **S1**, `frame-ancestors 'none'`.
- Traversal, symlink, junction and hard-link escapes out of the pack directory. **S3**, the write
  chokepoint's containment checks.
- Upload overwrites (a name that already exists). **S5**, create-only uploads.
- Concurrent edits made outside the panel racing a save. **S3**, the optimistic-concurrency sha256
  precondition (FR17).
- An invalid `pack.toml` ever reaching disk. **S3**, validate-before-write (FR19).
- Resolved, machine-local config (an absolute `vaultPath`, filled-in defaults) leaking into a
  saved pack file. **S3**, save-from-raw-bytes (FR18).
- XSS from vault-derived strings shown in the panel (check findings, pack values, vault-config.md
  fields). **S2** (and every slice that displays vault-derived text after it), plain-text
  rendering only, never markup.
- A GM link appearing in any published build. **S6**, the unconditional output-gate marker refusal
  plus a structural test that `src/cli/build.js`'s module graph cannot reach the GM-link writer.

## 11. Will not catch, deliberately

- Local malware, a locally-privileged administrator, or a browser extension the GM has granted
  broad permissions to. **S1** (threat model, section 2): any of these can already read the token
  directly off the GM's own machine.
- The token appearing in terminal scrollback, in a console-capture tool (e.g. NSSM's log
  redirection), or in browser history from the very first `/auth` URL before the redirect strips
  it. **S1**: the token is printed to the terminal by design, once, because that is the whole
  authentication bootstrap; nothing downstream of "the GM's own terminal" is defended.
- TOCTOU gaps: between a containment check and the eventual rename, and between the sha256
  precondition compare and the rename. **S3**: closing the concurrency window would need OS-level
  file locking rather than check-then-write, which was judged disproportionate to a single-GM
  local tool.
- ReDoS from a regex field (e.g. a vocab `session_token` pattern) hanging a synchronous build.
  **S4** (ADR 0020 section 6 already accepts this residual for `check`/`build`; the panel inherits
  it unchanged).
- An uploaded SVG's `<script>` reaching the *published* site. The admin origin sandboxes served
  image bytes (`Content-Security-Policy: sandbox`, FR15); the published site a GM later builds
  and deploys does not carry that sandbox, because nothing about a published build changes here.
  **S3** serves image bytes; **S5** accepts the upload.
- Every file in `images/` being published whether or not any slot actually uses it, and a
  slot image being copied twice into the built output. **S5**: this is existing `themeassets.js`
  behaviour (ADR 0019), unchanged by the panel.
- Uncommitted panel edits being thrown away by a `git checkout`, `stash` or `reset` run during
  vault curation. **S3**: the panel never commits anything; git hygiene around the vault is the
  GM's own responsibility, same as it is for any other local edit.
- Atomic replace semantics over SMB, which is where the real vault lives (mapped to a network drive on
  the owner's Windows machine). No criterion in this document ever runs the panel against a mapped
  drive, so the first real use against SMB is also the first test of it there. **S3**: keep the
  vault clean in git before using the panel against it for real.
- Comments in `pack.toml` being lost on first save (P8-D06's re-serialise-from-parsed approach).
  **S3**: the live pack has no comments today, so this is a residual against a hypothetical future
  pack, not the current one.
- A GM who manually copies the preview directory into a deploy path. The GM link would ship in
  that case, even though it only ever points at `127.0.0.1` and is therefore harmless to anyone
  else who loads the page. **S6**: the output gate only inspects what `scriptorium build` itself
  stages, not a manual file copy outside the tool entirely.
- Plain `serve` (without `--admin`) still has no Host check of its own, as already accepted in
  ADR 0002. **S1**: this ADR's controls apply only to the admin and preview listeners; D11 tracks
  the plain-`serve` static-handler defects (H9) as a separate fix.
- An SSH local forward whose local port differs from the panel's own bound port: exact Host/Origin
  matching means the tunnel's local port must equal the panel's port, or every request fails the
  Host check. **S1**: documented in P8-D12, not treated as a defect.
- `require.cache` growing by one entry per in-process preview build, for the life of the panel
  process. **S2**: accepted per the architectural context's NFR02 discussion; a long-running panel
  session accumulates this, and it clears on restart.
- Case-insensitive mounts on Linux (ADR 0019's existing residual). **S5**: unchanged by the panel;
  upload name-collision checks fold case only on win32/darwin, matching existing `packwrite.js`
  behaviour.
- 8.3 short names on NTFS are not normalised or checked against. This is expected to fail closed
  (an upload using an existing file's 8.3 short name is refused as a plain write conflict, not
  specially detected), and C41 on Windows checks that it does. **S5**.

## 12. Not decided here

8b (a browser-driven `init`) is out of scope for phase 8 entirely; only the validation logic it
will eventually share with the panel (`src/setup/validate.js`, slice S3) is built now.

## 13. Panel redesign: frame, fonts and tokens

Slice V1a of the panel restyle rebuilds the admin panel's UI in the "a1 Backstage" design: a
grouped sidebar on wide viewports, a bottom bar and disclosure sheet below 700px ("n1"), four
embedded font families, and a single-layer colour token sheet. Section 3 above already carries
the CSP amendment (`font-src 'self'`) and the widened public-asset statement; this section covers
the rest of V1a's structural decisions in narrative form.

**Fonts are embedded byte-for-byte, with no conversion or subsetting.** IM Fell English, IM Fell
English SC, Alegreya Sans (four styles) and IBM Plex Mono (two weights) ship as exactly the files
their upstream publishers distribute, six TTFs from `google/fonts` (which does not publish a
woff2 build for these families) and two woff2s from IBM's `plex-mono` package. Every file, its
immutable source URL (pinned to a 40-hex commit), its sha256 and its licence metadata are recorded
in `scripts/vendor/fonts/FONTS.json`; `test/admin-fonts.test.js` recomputes every hash from the
checked-in copy, and `scripts/generate-notices.js` recomputes them again when it builds the
notices text, so a changed font trips both the test suite and the packaging notices-freshness
gate. `@font-face` never uses `local()`, so an installed system font with the same family name can
never shadow the embedded one. Rejected: local conversion to woff2 (a new tool in the build chain,
plus the OFL's "Modified Version" question for any family carrying a Reserved Font Name, IBM
Plex Mono reserves "Plex"), and an npm font package such as fontsource (a new runtime dependency,
and a third party's conversion rather than upstream's own bytes).

**Asset routes gain a subpath, not a new lookup shape.** `ADMIN_ASSET_ROUTES` grows from 7 to 20
keys; the 8 new font keys carry a single `/` (`fonts/<file>`). Lookup stays exact own-property
membership on the frozen map (`src/admin/handlers/core.js`, unedited), and `readAdminAsset`'s
existing `path.join` already resolves a subpath correctly. Rejected: a prefix match or a
directory listing under `/assets/fonts/`, which would need `core.js` to change and would widen
what an unauthenticated request can enumerate.

**The router lives in the fragment, not the path.** Screen state is `#/<id>` or `#/<id>/<sub>`,
parsed by a fixed grammar and checked against the known screen ids by exact array membership,
never an object or property lookup, which would let a fragment like `#/constructor` resolve
through `Object.prototype`. Anything malformed, or naming an unknown screen, falls back to
Overview; navigation never issues a request, because every screen already exists in the DOM
(built once, at boot, from the same `NV.NAV` literal that drives every nav copy). Rejected: path
based routes (`/theme`, `/vocab`), which would need new server routes and reopen the route table
that `test/admin-http.test.js`'s route sweep freezes.

**Placeholders are data, not five hand-built pages.** Every "soon" screen (Memory, Publish,
Sessions, AI console, Storage) is rendered by the same `frame.js` code path from the `NV.NAV`
literal's `soon` flag: a heading, the fixed sentence "This part of the panel is a placeholder.",
the fixed status "Not in this version yet", and, Publish only, a link to Preview. The nav
marker is the visible text "soon", not colour alone.

**One colour layer.** Every colour used anywhere in `admin.css` is a `var(--...)` read from
`tokens.css`, enforced by a structural test that scans `admin.css` for hex, colour functions and
named colours. Rejected: colours living per-module (a `.pack-*` palette distinct from a
`.vocab-*` palette), which is exactly how the pre-restyle panel accumulated three near-identical
but not-quite-matching shades of the same warning colour; a single token sheet makes that
divergence a compile-time-visible diff instead of a visual one.

**Contrast: two token values move, one token is added.** Meeting WCAG AA required darkening
`--slip-muted` (`#6b5943` to `#5e4e3a`, since it is dark text on the light slip surface,
lightening it would have made it worse) and lightening `--text-faint` (`#857e71` to `#978f82`).
A new token, `--line-control` (`#7d7465`), covers form-control borders at the 3:1 UI threshold;
the mock's `--line-crease` is kept for purely decorative rules, which are not held to that
threshold. No other token moved: `test/admin-style.test.js`'s from-scratch WCAG 2.2
implementation checks every pair in the design's contrast table and all of them pass with these
three changes alone.

**Residuals, carried forward:**
- Fonts are served with `Cache-Control: no-store`, matching every other admin response, so they
  are re-fetched on every panel load rather than cached across sessions. Accepted: the panel is
  loopback-only and used by one person.
- The write screens moved into the frame in V1a (Theme, Title & tagline, Vocabulary, Images) keep
  their pre-restyle markup verbatim; their unlabelled-input accessibility gaps are not fixed here
  and are not a V1a regression, V1b, which rebuilds these screens' save flow, is where AA
  compliance for them is achieved.
- Windows rendering (fonts, the CSP, Edge specifically) is unverified until the Windows verifier runs the
  new C45 criterion in `.agents/windows-verification.md`.

### The sealed slip, rebuilt write screens, and per-slot image guidance

V1b adds `?include=palette` (SD-1), rebuilds the four write screens (Theme, Title & tagline,
Vocabulary, Images) on a store that owns their state (SD-3), and puts every save through a
sealed-slip review (SD-5/SD-6) before it reaches the server.

**SD-1 to SD-3: the store, not each screen, now owns `/api/state`.** `store.load()` runs one
`GET /api/state?include=vocab,palette` at boot, after `initSections`; the three write screens
(pack.js, vocab.js, images.js) read `store.get().state` and re-render on a store change,
`views.js` alone keeps its own legacy fetch. The V1a tap mirrored every `/api/state...` response
into the store unconditionally; that would let `views.js`'s own plain reload after a preview
build (a body with neither `vocab` nor `palette`) wipe the write screens' data and reset their
base shas. `ST.statePatch()` fixes this: the tap now calls it, and only a "full" body (both keys,
by own-property presence, checked in `ST.isFullState`) ever patches the store.

**SD-4: six pure modules, one pattern.** `diff.js` (`DF`), `outcome.js` (`OC`) and `slip.js`
(`SL`) join the existing VB/IC pattern: pure exports above a `module.exports` guard, a browser
singleton below it. `DF.diffLines` is a verbatim port of the V1 mockup's LCS diff
(the approved panel mockup, which is not kept in this repository) plus the
`MAX_CELLS` cap; `OC.mapOutcome` turns any `api()` result into the outcome table's
`{kind,role,message,detail,actions}`; `SL.buildSlip` builds the slip's rows/effects/diff from a
save's kind, payload, current state and dry-run response.

**SD-5/SD-6: one native `<dialog>`, reused.** `assets/admin/slip.js`'s browser half builds a
single `<dialog class="slip">` lazily and keeps it in the DOM; `showModal()` makes the rest of the
page inert and traps focus without a hand-rolled trap (rejected explicitly). `cancel` (the native
Escape event) is intercepted and mapped to Keep editing; focus returns to the button that opened
the slip on every close, tracked explicitly rather than relying on the browser's own return-focus
target. The confirm POST body is `SL.confirmBody(dryBody)`: the exact dry-run request with
`dryRun` deleted, so a single save's bytes are provably the same shape the parent sent.

**Kind-row wording is an Engineer-interpreted residual.** The brief's rows spec names three kind
outcomes ("added, removed, or changed with the changed field names") without pinning literal cell
text beyond the null-kinds case ("your N kinds" to "built-in set"); `slip.js`'s `kindsRows` uses
'none'/'added', 'present'/'removed' and 'changed'/`<comma-joined field names>`, documented at the
call site.

**SD-8: the busy contract.** Every run/save control across the four write screens and the slip,
Theme's and Title's Review buttons, Vocabulary's Review and save, Images' Upload and every slot's
Set/Clear, and the slip's own Save, computes `disabled` as its own state (read-only, a file
parse error, or nothing to save) OR `store.get().busy !== null`, and re-evaluates on a store
change. The store gains one shared helper (`store.isBusy()`, backed by a pure `ST.isBusy(busy)`
predicate) rather than four separate implementations, keeping each screen's own module boundary:
each screen still owns its own control-disabling logic, it just asks the store for the busy half.
Because SD-7 can suppress a screen's normal state/pending re-render entirely while it has its own
pending edit, each screen carries a second, busy-only `store.subscribe` that updates a button's
`disabled` directly rather than waiting for a full rebuild, disabling a button destroys no
input, so this stays live regardless of SD-7's suppression. **Nothing in V1b ever sets `busy`**;
V1c's job is only ever to set and clear it (Part 0 item 14 of the original design notes), so V1c
never needs to touch any of these four files' own disabling logic. This landed as a follow-up
fix, not in V1b's original commits: it was specified in the brief but missed, and section 5's
"A later slice's UI disables its own buttons" sentence (written before this fix) has been
corrected to say so.

**SD-12 (D-10, decided as option (c)):** the six image slots get a recommended-convention guide
(`IM.SLOT_GUIDE`), typed from the owner-approved table, not derived from any file:line source,
nothing in the repo draws any of these six slots yet. `IM.sizeAdvice` gives soft warnings (too
small, wrong shape, or a JPEG on `crest-frame`, which wants transparency) that never block a save.
Measurement never creates a `blob:` or `data:` URL: an `images/` value loads through an unattached
`<img src="/api/image?name=...">`; the upload picker uses `createImageBitmap`, closed immediately
after reading its dimensions.

**Rejected alternatives:** a prefix/substring `?include=` match (a route already frozen against
exactly that); mirroring any `/api/state...` response into the store rather than gating on
`ST.isFullState`; a hand-rolled slip focus trap; capturing a base sha per module rather than in
the store's own `files` map; a `blob:` URL for measuring a picked file's size.

**Residuals:**
- Rows are entirely client-derived from the dry-run response and the current store state; the
  diff toggle one click away is the same information restated, not a second source of truth.
- An older `store.load()` response landing after a newer one is not sequenced against it; the
  failure mode is a safe 409 on the next save (the confirm's `baseSha256` still matches the
  server, or it doesn't and the panel says so).
- Slot sizes are a recommended convention, not a measurement: no built-in theme draws any of the
  six slots yet (ADR 0019, "Not decided here"), so nothing here is derived from real product output.
- `vault:` slot values and SVGs are never measured; both show "Size not checked."

### The read screens rebuilt, the busy state, and the frame carry-forwards

V1c rebuilds `views.js` in place (SD-1) to own Overview, Check, Preview and vault-config.md,
the last screens still running V1a's legacy per-module `/api/state` fetch and raw `<h3>`/`<pre>`/
`<table>` dumps, and sets/clears the `busy` V1b's controls have watched since the SD-8 follow-up
fix above.

**SD-1: one more screen owner joins the VB pattern.** `views.js` gains a `VW` pure namespace
(`timeOf`, `billCheck`, `billPreview`, `checkOutcome`, `previewOutcome`, `findingRows`,
`wordsSummary`, `slotCells`) above the node guard, and its browser half reads `store.get().state`
never its own fetch, calling `store.load()` after every preview attempt (matching the legacy
`loadState()` call's own unconditional-on-outcome behaviour). `checkOutcome`/`previewOutcome`
delegate any non-(200 envelope)/(200 error) response (409 busy, a network abort, an unexpected
status) to `OC.mapOutcome`, so busy/unreachable text has exactly one source of truth across the
whole panel rather than a second copy in `views.js`. `previewOutcome` checks
`envelope.refusedByScan` before the generic `envelope.refused` branch: a scan refusal is *also*
`refused: true`, so checking `refused` alone would misclassify it as a check refusal and read the
(on a scan refusal, unrelated) `check.findings` instead of `outputScanFindings`.

**SD-2: Overview supplies its own `h1`.** `NV`'s `overview` item gains `ownHeader: true`;
`frame.js`'s `buildScreens` skips `screenHeader` for it, so the hero's own `h1` (the site title,
or the campaign name) is the screen's only `h1`. Every other screen is unchanged: one frame-built
`h1` each, `screenHeader`'s eyebrow plus label as before.

**SD-4/SD-6: `lastCheck`/`lastPreview` are the store's, an outcome kind is a screen's own.** The
store gains `busy`, `lastCheck` (`{exitCode, counts, findings, generatedAt}`) and `lastPreview`
(`{exitCode, pagesWritten, generatedAt, refused, findings, human}`), set only on a successful run
this is the shape `VW.billCheck`/`billPreview` (and so Overview's bill) expect. A run's full
outcome, of any kind (`ok`/`error`/`busy`/`unknown` for a check; `built`/`refused-check`/
`refused-scan`/`failed`/`error`/`busy`/`unknown` for a preview), lives in a module-local variable
in `views.js`, not the shared store: only the Check/Preview screens' own error/busy display reads
it, and putting it in the store would mean inventing a shape SD-4 never specified just to shuttle
a value between two functions in the same closure.

**SD-5: the busy contract's other half.** `runCheck()`/`runBuildPreview()` set `store.busy` to
`'check'`/`'build'` before the POST and clear it in both the success and failure paths,
including a rejected `fetch()`, which `app.js`'s `api()` never catches itself, so `busy` can
never get stuck open on a network abort. `frame.js` renders a `role="status"`
`[data-role="busy-status"]` line above the screens (already styled since V1b, unused until now),
showing `ST.busyLine(busy)`; `null`, or any value the panel never sets, hides it. Both Run check
and Build preview appear twice (Overview's own actions, and the dedicated screen), sharing one
pair of functions, so there is exactly one place either action's request logic lives.

**SD-7: the two frame carry-forwards from V1a.** The brand becomes a title line (`siteTitle`,
falling back to the bare campaign name) plus an always-present sub-line "campaign `<name>`"
(FR-01's wording, `v1-restyle-lead-requirements-2026-09-29.md:43`), V1a shipped only the title
line's fallback logic, sub-line included. `navLink` gains the visible `nav-readonly-marker` span
(styled since V1a, `admin.css:232-235`, but never emitted) for `vault-config.md`, the one
`readOnly` nav item.

**A closed V1a residual: `heading-order` on Overview.** V1a's own Reviewer pass found Overview's
frame `h1` sitting directly above `views.js`'s pre-existing `heading()` `h3` set with no `h2`
between (carried forward from that review). SD-2 plus the rebuilt
Overview's `h2` sections (Check findings, Image slots, Words, Unsaved changes) close it: every
scan in the QA gate record (Chromium at 1280/390 across all thirteen screens, Firefox spot-check
on the V1c four) came back with zero `heading-order` and zero `page-has-heading-one` findings, and
a direct DOM check confirms exactly one visible `h1` per screen. The write-screen AA residual the
V1a section above names is, as that section already says, V1b's to close, not V1c's; V1c's own
QA gate re-confirms it stayed closed (the four write screens re-swept, still clean).

**Deviation: `images.js` gains one line.** `slotCells`'s browser call site needs
`ScriptoriumAdmin.IM.slotImageRel` (interfaces), but `images.js` never published its `IM` onto
`window.ScriptoriumAdmin` the way `diff.js`/`outcome.js`/`slip.js` already do for `DF`/`OC`/`SL`
a gap, not a deliberate omission, since V1c is `IM`'s first consumer outside `images.js`
itself. The fix is the identical one-line pattern: `window.ScriptoriumAdmin.IM = IM;`, purely
additive. `IM`/`SLOT_NAMES` are deliberately never captured at the top of `views.js`'s own IIFE,
node or browser: `images.js` loads *after* `views.js` in `index.html`'s script order, so a
top-level `window.ScriptoriumAdmin.IM` read there would be `undefined` forever (`app.js`'s own
"read `ScriptoriumAdmin` lazily" note); `slotCells` takes `relFn` injected instead, read at
render time, well after every deferred script has run, and `views.js`'s own `SLOT_NAMES` is an
independent literal (drift-tested against `images.js`'s real copy) rather than a load-order-
dependent `require`.

**Rejected alternatives:** a `views.js`-local reimplementation of `slotImageRel`'s membership
check (would create a second copy of `SLOT_NAMES`-adjacent logic to keep in sync by hand, which
is exactly what the existing drift tests exist to avoid); re-rendering Overview/Check/Preview/
vault-config only when their own screen has no pending edits, mirroring SD-7's suppression on the
write screens (rejected because none of these four screens has any typed or selected input of
its own to lose on a re-render, so the suppression protects nothing here and a plain full
re-render already gives "controls re-evaluate on store changes" for free); storing a run's full
outcome (any kind) in the shared store rather than a module-local variable (SD-4 never specifies
that shape, and no other screen needs it).

**Residuals:**
- Overview's own inline display for a check/preview *failure* triggered from its own actions is
  minimal (parse errors only); the full error/busy message for a failed run lives on the
  dedicated Check/Preview screen, matching AC-02/AC-03's split of that responsibility from AC-01's
  "invents nothing" Overview scope.
- `wordsSummary`'s exact wording ("N custom label(s), N custom kind(s)" or "built-in kinds") is an
  Engineer-interpreted residual: the interfaces name the three ingredients without pinning literal
  text, the same class of residual `slip.js`'s `kindsRows` comment already documents for V1b.
- Windows rendering (the busy line, the two-line brand, the read-only marker, the restyled locked
  page) is unverified until the Windows verifier runs C45 in `.agents/windows-verification.md`.

### Visual fidelity to the Backstage mock, part one (frame, tokens, Overview, Check, Preview, vault-config)

The owner looked at the merged V1 panel and said it didn't look like the mockups. He was right:
`admin.css` had copied the mock's token *values* accurately but never ported its CSS *rules* or
DOM structure, it was a hand-written approximation. V1d-1 ports the approved panel mockup's
a1 direction rule-for-rule, transcribing its class names (`a1-*`,
`df-*`) rather than reinterpreting them, for the frame (sidebar, n1 top/bottom bar) and the four
screens the previous slices already owned: Overview, Check, Preview, vault-config.md. Theme,
Vocabulary, Title, Images and the slip are V1d-2's (`pack.js`/`vocab.js`/`images.js`/`slip.js` are
frozen this phase).

**The port decision.** Every ported selector, in every case, keeps the mock's own class name
(`.a1-crest`, `.a1-ni`, `.a1-bill`, `.a1-btn`, `.a1-rule`, `.a1-find`, `.a1-slots`, `.a1-words`,
and so on) so a reviewer can diff each rule against its M: line directly, rather than trusting a
paraphrase. The only transformations applied, per SD-1: `var(--bk-*)` and every literal colour
became a token (SD-2's map); `cqw` became `vw`; `@container app (max-width:N)` became `@media
(max-width:N)`; the `.a1` scope and `.nav-n1` prefix were dropped. Legacy V1 rules that would
otherwise outrank the new a1-classed rules on specificity (`[data-screen] button`'s own box, and
`[data-screen] h2`) are wrapped in `:where()` at zero specificity, called out by name in the
brief as the reason V1's Overview buttons and headings never looked right, since a plain
attribute selector out-specifies a single class. The frozen write screens (Theme/Vocab/Images,
still V1's own markup this phase) keep using those wrapped rules for their box styling; they just
can no longer outrank an a1 class when one is present.

**Rejected alternative: reinterpreting the mock.** The brief's own name for what V1 did the first
time. Rejected again here for the same reason: a paraphrase drifts, silently, exactly the way
`admin.css`'s hand-typed token values already had (right values, wrong rules), and there is no
way for a reviewer to audit a paraphrase against the mock line-by-line the way a literal port
allows.

**A corrected port, not a literal one: `.a1-layout` is a real CSS grid, not a fixed sidebar.** The
first pass kept V1a's `position: fixed` sidebar (reasoning: pixel-equivalent to the mock's grid
item in a single-viewport screenshot). That reasoning was wrong for any page taller than one
viewport: a fixed sidebar only paints for the height of the viewport, so its background and the
"Bound to 127.0.0.1 only" footer clipped partway down a tall Overview capture, caught by the
owner from the first side-by-side screenshot, not by any automated gate, since every axe/overflow
check the harness ran is width-based, not content-height-based. The fix ports M:212's
`.a1-layout{display:grid;grid-template-columns:var(--side-w) minmax(0,1fr)}` literally: grid's
default `align-items: stretch` makes the sidebar and main share one stretched row, so the
sidebar's background and footer always reach the true bottom of the content, whichever column is
taller. `frame.js`'s `build()` now wraps `side`/`main` in a real `.a1-layout` div rather than
inserting them as flat siblings of `[data-role="app"]`.

**A background-image needs an explicit background-color fallback, or axe-core cannot read it.**
`[data-role="app"]` takes M:208's radial gradient (SD-2). Written as the `background:` shorthand
(gradient only, no explicit colour), axe-core's `color-contrast` rule intermittently reported a
false `#ffffff` background on an unrelated, frozen screen (Title, 390 width, only after a
width-context switch in the same browser process) for text whose real, rendered background was
the correct dark gradient throughout, confirmed live by reading the ancestor chain's computed
`background-color`, which showed the correct token colour the whole time. Splitting the shorthand
into `background-color: var(--surface-ground)` (a real solid fallback) plus a separate
`background-image: radial-gradient(...)` did not change the rendered pixel at all, but gave axe's
sampler something reliable to fall back to, and the false positive stopped reproducing. Recorded
here because a future gradient anywhere else in the panel should use the same longhand pattern
from the start, not rediscover this by triage.

**Icons and headers.** `IC.ICONS` gains the sixteen a1 icon specs (SD-4, transcribed from
M:960-986 as `[tag, attrs]` tuples, the same shape every existing icon already uses; the existing
allowlist test covers them with no changes needed). `frame.screenHeader` now reads
`item.eyebrow`/`item.lede` (SD-5); every non-`ownHeader` `NV` item carries both as literals (the
placeholder items' eyebrow is `NV.SOON_STATUS`'s own text, duplicated per item rather than
referenced, since `NV.SOON_STATUS` isn't assigned yet at the point the `NAV` array literal that
needs it is evaluated).

**`navLink`'s markers move into one `<span class="end">`.** SD-7 (M:221-228): pending first (now
styled `.a1-dot`, not `.nav-pending-dot`), then read-only/soon (both `.a1-ro`, the mock has one
style for both, reused rather than inventing a second). `.a1-dot` itself needs `display:
inline-block` explicitly: shell.src.html's own M:223 copy of the rule omits `display` (a plain
`<span>`/`<i>` ignores `width`/`height` without it), while `r2-src/common.css`'s copy of the same
class carries `display: inline-block; flex: none`. Used the fuller `r2-src` version, the same
citation the brief already uses for `.a1-ro`/`.a1-new`.

**SD-9: `VW` gains five pure functions** (`numberWord`, `wordsParts`, `themeNudge`, `shortPath`,
`pendingLinks`), each independently unit-tested (`test/admin-v1d-model.test.js`) against literals
never derived from the implementation. `wordsParts`'s `kindsCount` mirrors `vocab.js:602`'s own
on-disk-else-defaults split: the on-disk length when `tables.timeline.kinds` is a real array,
else the vocab payload's own `defaults.timeline.kinds` length (the real server response always
supplies this), else a last-resort independent literal (`DEFAULT_KINDS_COUNT = 5`, matching
`src/build/labels.js`'s `DEFAULT_KINDS.length`, a payload that omits `defaults` entirely never
reaches the panel in practice, but the function must never throw). `billCheck`'s `meta` gains the
error/warning counts (M:1136 shows all three); its `text` is unchanged.

**Rejected alternative: a views.js-local reimplementation, again, this time for the words
sentence.** `buildWords` could have hand-rolled its own label/kind counting inline the way the
old `wordsSummary` did. Kept `wordsParts` as the single source of the *data* and let `buildWords`
own only the *sentence* assembly (capitalising `numberWord`'s output for a sentence-initial
position, joining up to three `<q>`-wrapped values), the same VB-pattern split every other
screen in this panel already uses, and the split that let `wordsParts` get an independent,
fixture-driven unit test instead of one that could only ever assert against its own rendered
string.

**Findings become a list, not a table** (SD-8, M:265-266): `.a1-find`/`li`/`code`/`p`, a severity
pill (`info`→`seal`, `warn`→`rose`, `error`→`error`, the mock's own choice) plus the finding's
path in parentheses after the message (DV-8: FR-14 already requires the path; the mock's own
example finding has none to show).

**Image slots: three kinds of card, not two.** `thumb` (a real `images/` file) is unchanged in
substance, an `<img>`, now with CSS `object-fit: cover` instead of the mock's `background-
image` (SD-8's own instruction: a semantic `<img>` gives real alt text, which a CSS background
image cannot). `path` (DV-3: a `vault:` value, or anything else `IM.slotImageRel` won't
resolve) is new, a hatched card reading "vault file" plus `VW.shortPath`'s shortened value,
using the same `--wash-hatch` pattern as `empty`, distinguished by a solid rather than dashed
border. Both `.a1-slot.empty .th` and `.a1-slot .th.path` use the `background:` shorthand (not
`background-image:`), matching M:272 exactly: the base `.th` rule's `background-color:
var(--surface-thumb)` (the cream fallback, meant for the thumb case only) would otherwise show
through the hatch pattern's transparent gaps on the other two cards, caught from the first
side-by-side screenshot, where both non-thumb card kinds rendered cream instead of the mock's
dark hatch.

**`[data-role="app"] code`** (M:211, dropping the `.a1` scope) is every `code` element in the
panel: IBM Plex Mono at `.86em`, not the browser's UA-stylesheet monospace fallback. Missing from
the first pass entirely, caught from the side-by-side screenshot's finding IDs and the preview
address, which rendered in a serif-adjacent fallback instead of the embedded mono font.

**DV-16 (new): Check, Preview and vault-config have no mock drawing at all.** shell.src.html only
draws Overview, Theme, Vocabulary and the slip ("What I found", the phase-split brief). Their
component language, primary action button(s), `.a1-meta` counts, `ul.a1-find`, `.a1-fine`, a
mono block for raw text, is extrapolated from Overview and the shared a1 component set (SD-3),
per AC-03, not ported from a mock pixel reference that does not exist for these three screens.

**DV-17 (new): the sidebar sub-line can wrap to two lines.** "Backstage · campaign `<name>`" fits
one line in the mock's own capture at 238px; the real build's embedded `@font-face` copies render
it fractionally wider than the mock's Google-Fonts-loaded copy of the same family names, and it
wraps for this specific campaign name's length. The CSS is a literal, unmodified port of
M:215-218 with no width constraint added on either side; no functional impact, since neither
version truncates the line.

**Landmarks close the axe `region` finding** (SD-7, F9): the top bar becomes a real `<header>`,
the bottom bar and the "More" sheet become `<nav>` with `aria-label`s ("Sections", "All
sections"), the three elements the brief's own root-cause list named as plain `div`s. DV-1
(the bottom bar's own destinations differ from the mock's fixed five, since our own "More"
overflow pattern has no mock equivalent) is unchanged from the phase-split brief's own list.

**SD-6: no visible ring on the route-focused `h1`.** `h1[tabindex="-1"]:focus{outline:none}`,
scoped narrowly enough that every real interactive control's `:focus-visible` ring (still the
global rule, unchanged) is untouched.

**Residual: `wordsSummary` is left unused.** Its own tests (`test/admin-views-model.test.js`)
still pass unedited, the function itself is correct and frozen, just no longer called from
Overview. Not deleted: V1c's own comment already names this as the kind of residual worth
recording rather than silently orphaning.

**Deviation: `views.js` gains a local `icon` capture.** The pure `VW` section never touched
`ScriptoriumAdmin.icon` (Overview's old DOM had no icons at all), so the browser half never
captured it the way `frame.js` does. SD-8's new icon-bearing buttons/pills need it; the fix is
the same one-line pattern V1c's own `images.js` deviation used: `var icon =
ScriptoriumAdmin.icon;`, alongside the existing `api`/`el`/`setText` captures.

**Behaviour, unchanged.** `store.js`, `app.js`, `diff.js`, `outcome.js`, and every request/payload
shape are untouched. The FR-13 double-save sequence, FR-20's busy contract, and the XSS fixture
were all re-run live against the restyled build and are unaffected, confirmed via a harness
defect this phase's own axe re-run found and fixed first: the QA scripts (inherited from V1c's own
`axe-sweep.js`) filtered `axe.run()` to `{tag: ['wcag2a', 'wcag2aa']}`, which silently excludes
axe-core's `region` rule (tagged `best-practice`/`cat.keyboard`, not `wcag2a`/`wcag2aa`), every
prior slice's "zero region findings" claim, including V1c's, was never actually checked. Recorded
here since it affects how much weight any earlier slice's axe result should carry, not just this
one's.

### Visual fidelity to the Backstage mock, part two (Theme, Vocabulary, Title, Images, the slip)

V1d-1 ported the frame and the four read screens; V1d-2 ports the rest of what the mock draws
(Theme, Vocabulary's four subtabs, the d3 confirm slip in its ready/refused/raw-open/saved
states) plus the two screens it never draws at all (Title & tagline, Images), which get the same
a1 visual language rather than a literal port. `tokens.css` needed no additions this phase: every
colour V1d-2's ported rules reference was already added, either in V1a/V1b (when the legacy write
screens were first tokenised) or in V1d-1's own SD-2 pass, the one genuine gap (`.a1-seal`'s
own box-shadow, `rgba(0,0,0,.45)`, a literal the brief's own SD-2 map never named) got a single
new token, `--seal-shadow`.

**The port decision, same rule as V1d-1.** Every ported selector keeps the mock's own class name
verbatim (`.a1-themes`, `.a1-theme`, `.a1-frame`, `.a1-cap2`, `.a1-subtabs`, `.a1-lrow`,
`.a1-kind`, `.a1-kg`, `.a1-pending`, `.a1-seal`, `.cf-*`, `.df-*`, and so on), so a reviewer can
diff each rule against its M: line directly. The legacy `.theme-card`/`.pack-actions`/
`.vocab-tablist`/`.vocab-field`/`.vocab-kind-row`/`.vocab-glyph-preview` rules they replace are
deleted outright, not wrapped, SD-1's own instruction for this phase, since nothing in the
frozen screens (Check/Preview/vault-config/Overview) ever used them.

**DV-6 forces a structural choice the mock never had to make: where does an editable Key input
go?** The mock's own kind cards are read-only (`<dl>`, M:1168-1174); ours must stay editable
(admin-fix-1's own key/label/glyph/aliases/before fields, unchanged this phase). `.a1-khead`'s
own slot for the key is a literal `<code>` in the mock, there is nowhere in that markup for a
real `<input>`. The fix keeps an `<input class="a1-in mono">` sitting where the `<code>` would,
visually monospace and compact, but a real, focusable, F16-tested form control. Documented here
because it is the one place DV-6's "kept editable" instruction and SD-1's "port the DOM" collide,
and the resolution favours function over the mock's own markup shape.

**A specificity bug, caught from the first side-by-side screenshot: the plain and haze theme
specimens rendered identically.** `buildSpecimen(scheme)` correctly branches on `scheme ===
'light'`, but the *value* it received was always `theme.scheme`, `null` for `plain` (the
registry entry has no scheme of its own; `src/build/themes.js`'s `loadTheme('plain')` always
returns `scheme: null`, and the real server agrees: `/api/state?include=palette` reports
`{"name":"plain","scheme":null}`), which the ternary's own `!== 'light'` branch silently treated
as `'dark'`. The fix, `effectiveScheme(theme, palette)`: fall back to the vault's own
`state.palette.scheme` when the theme has none of its own, the same fallback
`views.js`'s `themeSchemeFor` already uses for the Overview bill's Theme card, applied here for
the first time to the specimen itself. A second, unrelated bug in the same screenshot: `.a1-theme
p`'s own descendant selector, meant only for the card's blurb paragraph, also matched the
specimen's nested `.theme-specimen-title`/`.theme-specimen-tag` paragraphs (both `<p>` elements),
overriding their scheme-appropriate inherited ink with `--text-muted` regardless of the
specimen's own background, fixed by narrowing to `.a1-theme > p` (the blurb's real position, a
direct child).

**A pre-existing V1d-1 bug, newly consequential: `[data-role="main"]`'s own 390 padding-bottom
was two rules deep.** The frame's own 699px block sets `padding-bottom: calc(var(--bar-h) + env
(safe-area-inset-bottom, 0px))` so page content clears the fixed bottom bar; Overview's own 390
fallback (M:386's literal `padding: 22px 16px 28px`) uses the `padding` *shorthand*, which also
sets `padding-bottom`, silently overriding the dedicated clearance rule back down to a flat
28px, on every screen, not just Overview. Overview's own trailing content apparently never
reached far enough down the page for this to matter; Theme's Keep/Review bar, sitting much closer
to the natural end of its own (shorter) screen, did, found live as an un-clickable button
underneath the bottom bar at 390. Fixed by splitting M:386's shorthand into
`padding-top`/`padding-left`/`padding-right` longhands, leaving the dedicated `padding-bottom`
rule alone. `admin.css` is in this phase's own file map, so the fix stays in scope even though
the bug predates it.

**Axe found six real defects, all fixed, none deferred.** `color-contrast` on the light theme
specimen's nav bar (a dark-navy band inheriting the specimen's own dark ink, meant for its cream
body, M:131's own `.pv-plain .pv-nav` sets its own light text for exactly this reason, missed
on the first port) and on its title/tagline (the `.a1-theme p` leak above); `color-contrast` on
the Images 404 diagram's own label text (`--text-faint` measured 3.28:1 against the composited
`--wash-selected`-over-`--surface-panel` tint; `--text` clears it); `label` (critical, 20 nodes)
on every Timeline-kind card's own key/label/glyph/aliases inputs (`plainField`'s `<label>` was
never for/id-linked to its `<input>`, a sibling, not an association; the discarded key label
lost its accessible name entirely once DV-6 moved the key input out of its own field wrapper,
fixed with `aria-label="Key"`); `heading-order` in the slip (`.df-effects`' own heading skipped
from `h2.cf-title` straight to `h4`, M:1077's own literal tag, changed to `h3`, the mock's own
tag choice loses to the accessibility requirement here); `scrollable-region-focusable` on the
expanded raw diff (`.df-scroll`'s own `overflow-x: auto` had no way to reach it by keyboard,
`tabindex="0"` plus `role="region"`); and a second `color-contrast`, on the diff table's own
add/del row line-numbers (`--slip-muted`, already darkened once for D-7, still falls under 4.5:1
against the add/del row tints specifically, composited, roughly 3.85:1/3.88:1; `--slip-ink`
clears both). None of these six are visible in a screenshot alone, all six were axe findings
first, screenshot second (or not at all, for the sub-4.5:1 cases).

**DV-18: the slip's `.a1-btn.primary` uses `--slip-hi`/`--slip-ink`, not the mock's own literal
`#2e2013`/`#f0d99a`.** That literal pairing measures 3.84:1, the same D-7 class of failure
`--text-faint`/`--slip-muted` already needed fixing for, and the same pairing the pre-V1d-2
`.slip-action-primary` rule already used for this reason. Not a new deviation in spirit, just the
first time this phase's own restructure gives it a genuinely mock-literal class name to attach
the note to.

**DV-19: the slip's `df-fields` "where" column reads `SL.buildThemeRows`'s own pre-existing
label ("Theme"), not M:1071's literal "Site look" example.** `SL` is V1b's own pure half,
unchanged this phase (not in the V1d-2 file map), its row-building functions predate the d3
grid layout by two phases and were never asked to match the mock's own example copy word for
word.

**DV-20: the Vocabulary pending bar shows a mechanical "N unsaved change(s)" count, not the
mock's own field-name listing** (M:1201: `": group_npc, kind meeting"`). The same DV-14 precedent
(the Words sentence quotes at most three labels rather than listing every one) applied to a
second sentence: a literal per-field listing would need to describe an edited kind card
differently from an edited label row, a rendering rule the brief never pinned beyond the mock's
own two-item example.

**A missing per-tab dot, caught from the same side-by-side screenshot.** M:1196's own `dot()`
hardcodes which tabs can show one (`labels`/`kinds` only, matching the mock's own fixed demo
state); the real panel tracks four independently editable tabs, so `refreshTabDots()` recomputes
all four, live, from `buildPayload()`'s own already-separated `labels`/`recaps`/
`timeline.{kinds,weights,session_token,segment_units,columns}` keys, not mocked literally
(the mock never has to decide what a *matching*-tab dot would mean), but the same visual
component (`.a1-dot`) the mock already uses for the other two tabs.

**Owner feedback, mid-build (2026-09-30): the Images screen needed to say what each slot is
for.** Not mocked at all (shell.src.html never draws Images), so this is new copy and a new
schematic diagram in the a1 idiom, not a port. Purpose text per slot (`IM.SLOT_PURPOSE`, a new
pure map alongside the existing `SLOT_GUIDE`) is sourced only from what the codebase already
documents: ADR 0019's own worked example (the `ground` slot wired in as `background-image:
var(--sc-img-ground)`, `:196-208`), each slot's own name (the registry literal in
`src/build/themes.js`), and `SLOT_GUIDE`'s own `behaviour`/`tile`/`alpha` fields, no invented
purpose. `IM.BUILT_IN_THEMES_DRAW_NO_SLOT` is a literal fact, independently verified rather than
queried live: both registry entries (`plain`'s `dir: null`, and `assets/themes/haze/theme.json`'s
own `"slots": []`) currently draw zero slots between them, and `/api/state` exposes no theme's
`slots` array to check this dynamically without a new route, **DV-21**, named per the owner's
own instruction rather than added silently. The placement diagram (`slotDiagram(kind)`, six
`kind` variants) reuses the Theme specimen's own idiom exactly: a bordered mini page outline, a
highlighted region showing roughly where the slot sits, tokens only, no images, DOM and CSS only
(CSP-safe). `docs/image-slots.md` gained the same purpose table, so the docs and the panel agree.

**Behaviour, unchanged.** `store.js`, `app.js`, `diff.js`, `outcome.js`, `SL` (slip.js's pure
half) and every request/payload shape are untouched. POST bodies for all seven single-save
actions (theme, settings, vocab-labels, vocab-kinds, vocab-matching, vocab-recaps, an image slot)
were replayed against PARENT (`b5b48b4`) and are byte-identical. The FR-13 double-save sequence,
FR-20's busy contract (including the interception set), the slip's keyboard modality (Escape,
focus return, `aria-labelledby`), and the XSS fixture were all re-run live against the restyled
build and are unaffected.

**Residual: the Kinds tab is deliberately not an `.a1-vbody` grid.** `buildPanel(id, vbody)`'s
`vbody` parameter defaults true (M:1200's own `display: grid; gap: 24px` wrapper) but Kinds
passes `false`: a grid parent would lay out its Add-kind/Reset-kinds `.a1-btn` pair one per row
instead of side by side, and moving them into their own flex wrapper div would have broken the
frozen `admin-busy-contract.test.js`'s own literal `kindsPanel.appendChild(addKindBtn)`/
`kindsPanel.appendChild(resetKindsBtn)` substring checks. `.a1-btn + .a1-btn` (a new, narrowly
scoped adjacent-sibling rule) supplies the mock's own 10px `.a1-actions` gap instead.

**REWORK round 1 (Reviewer, 2026-09-30): two live-reproduced defects, both fixed.** First, the
slip's diff toggle (`slip.js`'s `diffToggle()`) hardcoded its *initial* label as `'Also happens to
the file: '`, an unrelated string borrowed from the effects-list heading, instead of the text
its own click handler computes for the collapsed state. SD-10/M:1061 pins the collapsed label to
`S.raw ? 'Hide' : 'Show'` with `S.raw` starting false, so every "ready" slip in the compare page
(captured before any click) showed the wrong label; `mutation-check.js`'s own `F12` baseline check
had already asserted the correct text and was failing against the committed code. Fixed by seeding
the label with the click handler's own `'Show the file diff '` string. Second, `.df-gap td` (the
"N unchanged lines" row inside an expanded diff) used `--slip-muted`, which composites to ~4.17:1
against `--slip-gap-bg`-over-`--slip-code`, the same D-7 class of failure as the adjoining
`.df-add`/`.df-del .df-no` fix just above it, missed because the original axe sweep never
exercised a diff with a large enough unchanged run between two hunks to produce a gap row. Fixed
with the same `--slip-ink` token (~8.2:1). Both fixes were mutation-proved for real: reverting each
one reproduced the original failure live (F12 MISMATCH; one `color-contrast` serious violation on
both gap-row cells), and re-applying the fix cleared it, at both 1280 and 390. Full detail,
including the fresh-vault methodology used to reproduce a gap row and the complete gate re-run,
is recorded in a private QC folder (not in this repo)'s own "REWORK round 1" section.

### The tagline fix and the two-file review

The shipped defect: the Title screen wrote `vault.config.json`'s `landingTagline`, but the site's
landing hero only ever reads `publish.theme.tagline` from `_meta/vault-config.md`
(`gm-apprentice-publish/lib/templates/landing.js:63`, merged at `lib/config.js:257-267`, which
carries no fallback to `landingTagline` at all). A GM who set a tagline through the panel saw it
in the panel and never on the built site. `docs/decisions/0033-vaultconfig-write-exception.md`
records the fix's own write exception and its residuals; this subsection is the panel-side half.

**The Title screen.** The tagline field now reads and writes `publish.theme.tagline` through the
new chokepoint (`src/vault/vaultconfigwrite.js`) and its targeted editor
(`src/admin/vaultconfigedit.js`), never `landingTagline`. `POST /api/pack/settings` drops
`landingTagline` from its allowlist entirely: sending it now gets the ordinary unknown-field 400,
the same refusal an unrecognised field always gets. `editVaultConfigJson` loses the
`landingTagline` branch; an existing on-disk value is left exactly as it was, shown read-only with
a neutral note that the site does not use it.

**Two files, one review (D-19).** Title and tagline are two different files with two different
sha256 preconditions, `vault.config.json` and `vault-config.md`. Saving both at once opens a
single slip covering both, built by `SL.buildCombined` and posted through `SL.postInOrder`:
sequential, always attempting the second request even when the first fails (parallel dry runs
would 409-busy each other under `runExclusive`'s one-write-at-a-time contract, and a sequential
confirm means a failed field stays pending while the other stays saved). The busy-contract
literals (`reviewBtn.disabled = disabledReason || store.isBusy();`, 6 in `pack.js`;
`currentSaveBtn`, 1 in `slip.js`) are unchanged in count: the two-file flow still runs inside one
`.then`/`.catch` pair, exactly like the single-file flow it replaces.

**The include.** `GET /api/state?include=vaultconfig` exposes the raw frontmatter text, the
file's sha256, the structured tagline value, and whether editing is currently possible (and why
not, when it is not), never the file's body, keeping FR32's promise from section 4 above. The
default response and every existing `?include=` shape are unchanged; a byte-equality test
confirms it directly.

### The layout switcher, the pane slot, and the content cap

Every round-3 screen picks up a small control in its header, letting a GM switch between that
screen's own layout options. It remembers the choice per computer, using the preference store
described in `docs/decisions/0033-vaultconfig-write-exception.md`, section 7. Nothing about the
switcher builds a new layout yet. It only remembers which one is chosen; the layouts themselves
arrive screen by screen in later work.

Choosing a button never rebuilds it: only which button looks pressed changes, so a GM's keyboard
focus never jumps away mid-click.

**A shared right-hand pane.** Screens that want a docked panel on wide screens, an edge tab to
hide and reveal it, and a drawer or full-screen sheet on a narrower one, all share the same slot
and the same small set of rules for deciding what to show. A screen can register its own panel;
so can one shared panel that several screens use at once, for the "follow what I'm editing" split
preview the owner asked for. When both are registered together on a wide screen, the screen's own
panel is the one shown docked, and the shared one collapses to its own edge tab rather than
disappearing, so it is always one click away. Nothing registers a real panel in this piece of
work; a placeholder is used only to prove the slot itself works, and the real panels arrive with
each screen's own layout options.

**The width cap.** On a wide screen, with nothing docked, a screen's main content is capped at
1180 pixels so a line of text never runs uncomfortably wide. With something docked, the cap lifts:
the docked panel has already taken the extra room, and capping the remaining space too would waste
it. This replaces an older, unconditional width limit that predated the mock's own measurement and
always applied regardless of what, if anything, was docked.

### Title and tagline, finished

The Title screen now offers three views over the same two fields, switched the same way every
other round-3 screen's layout choice is: a small control in the header, remembered per computer.
The first view draws a live hero exactly as a player would see it, with everything else in
vault.config.json folded into one short, plain-language summary behind a disclosure. The second
keeps the two fields but shows every place those words actually appear on the site, and points to
where the rest of the file changes today rather than listing it there. The third lays the whole
file out as read-only cards in plain language, with a Cards/JSON toggle for anyone who wants the
raw file; only the name and tagline are ever editable. None of the three ever shows a JSON key
name on the main screen: keys appear only in the save review's fine print and behind an explicit
"Show the file" disclosure.

A new warning appears in the save review when renaming the site would also change its campaign
id. The generator derives that id from the site title with its own function, reached only through
the pinned facade, so the panel's warning can never drift from what a real build actually does. It
only shows when vault.config.json's own backend switches (the live status bar or the
change-request inbox) are already on, and it never blocks the save.

**Rejected:** reimplementing the id function on the client, which risks drift from the pinned
generator; and a new read route to fetch it, which would need a second request on every review for
a warning that already has everything it needs from the same save request.

**Will not catch:** a backend switched on only through vault-config.md's own settings, or detected
from an already-deployed backend, rather than vault.config.json's own flags. Widening the check is
a small follow-up if that turns out to matter.

### Vocabulary help and friendly rows

Two of the Vocabulary screen's layout options answer the owner's own round-1 request for a
hideable explanation, and for something friendlier than a bare list of pack.toml key names.

**A "How to use" rail.** Choosing it shows a right-hand panel that explains whichever tab is open:
what the words on that tab are for, how to change one, where it shows on the player site, and what
saving does. It follows the tab: switching from labels to timeline kinds changes the rail's own
text without touching the form underneath. A GM can hide it; the panel remembers that choice on
this computer, the same way it remembers every other layout choice. A small button above the tabs
brings it back. On a phone the rail becomes a closed "How to use this screen" line at the top of
the screen instead, since there is no room for a side panel there.

**Friendlier rows, on the same layout the plain screen already uses.** Rather than build a second
copy of the form, the friendly-rows option shows the same fields with extra parts alongside them: a
plain-English name above the pack.toml key (which stays visible as small print, since the owner
still needs it to hand-edit the file if they ever want to), and a small sample of how the word
looks once it is in place on the player site. The sample is invented text in the panel's own
fonts, not a real page: building one from the actual vault would mean an extra server round trip
per keystroke, and the point of the sample is to show the word's *style*, not its content. Typing
into a field updates its sample immediately. A short note explains the idea the first time a GM
opens this option; dismissing it lasts until the panel tab is closed, not longer, since remembering
it across a relaunch would need a preference of its own.

Because both options draw from the very same set of fields as the plain screen, switching between
them never loses an edit mid-way through typing. A second layout built from scratch would have
needed its own copy of every field's current value, kept in step with the first, which is exactly
the kind of place a GM's typing goes missing.

**The save itself is unchanged.** Neither option alters what gets written to `pack.toml`, when it
gets written, or what counts as a pending change: the same review-and-save flow the plain screen
already used covers every option, byte for byte.

Every timeline-kind card also gained a small preview of its own key: the icon and name a
Kind column on the Timeline page would draw for it, and, when the kind has an alias, an example of
a Kind cell using that alias and how it reads. Two lines that the mock's own wording overstated for
every vault ("all five" kinds, "your Timeline columns already match") were reworded to something
true regardless of what a GM has actually configured.

### The live preview, screen sizes and the stacked pane

The Overview screen's own shared panel, described above, gets its first real use: a live, sandboxed
view of the private preview build, sitting beside the Overview on a wide screen and folding away on
a smaller one. `docs/decisions/0035-preview-in-a-frame.md` covers the framing decision, the
freshness signal and where the pages it offers come from; this subsection covers the three layouts
themselves, the per-screen-size memory, and a small fix to how the shared panel behaves when a
screen's own panel outranks it.

**Three ways to see the preview.** Docked keeps the Overview exactly as it already is, with a
small preview pinned to the side on a wide screen, folding to a drawer on a laptop-sized one and a
full-screen sheet on a phone. Split puts the preview and the Overview side by side on a wide
screen, each taking about half the width; on a laptop or a phone it becomes a second tab next to
the Overview itself, so the two are never fighting for the same space. Postcards shows three small,
live snapshots, the landing page, the latest recap and the timeline, in a narrow rail on a wide
screen, or a row a GM can scroll sideways through on a laptop or a phone; picking one opens it
large, with arrows to step to the next.

**Screen-size-aware memory.** Every layout choice on every screen, not only the preview, is now
remembered separately for a wide screen, a laptop-sized one and a phone, and the preview panel's
own placement, alongside the page, or stacked underneath it, has the same per-size memory. The
addendum to `docs/decisions/0033-vaultconfig-write-exception.md` covers the preference file's own
shape and its one-time migration from the previous, single-choice-per-screen version.

**Stacked below, by default on a laptop or a phone.** Docked's drawer and full-screen sheet both
stay available, but a laptop or a phone now defaults to stacking the preview underneath the page
instead, with one button in the preview's own header to switch back to a drawer or sheet, and
another to return to stacking underneath. The owner's own preference, once the round-3 mock had
been reviewed, was for the pane to sit underneath rather than behind an extra click on these sizes.

**A working swap, not a dead reveal.** When a screen with its own shared-panel-using rail (the
Vocabulary "how to use" panel, for instance) is open on a wide screen at the same time as the split
preview is chosen, the rail wins the shared panel and the split preview collapses to its own edge
tab, exactly as the shared-panel design already described. Clicking that edge tab now actually
swaps the two: the rail hides and the preview takes its place, with a matching edge tab to swap
back. Previously that edge tab was wired to a preference the rail's own screen never reads, so
clicking it did nothing.

**Following what a GM is editing.** With the split layout chosen and its own "follow what I'm
editing" option turned on, the preview jumps to whichever page a screen mainly affects, the
landing page for Overview, Theme, Title and vault-config, the timeline or a character page for
Vocabulary depending on which field is focused, and so on. This subsection wires the mechanism
and the Overview's own default (always the landing page); a later screen's own work is what tells
it which field is focused.

**Two pointers back to section 3 and section 4.** Section 3's line that "the preview listener gets
the same set minus the CSP" no longer holds for preview pages the way it once did: they now carry
their own, narrow `frame-ancestors` header naming the admin origin, so only the panel's own page
can frame them. The line "nothing can embed the panel" still holds exactly as written: only the
panel's own single page, `GET /`, ever gains a `frame-src` allowance, and it names the preview
origin and nothing else. Section 4's fixed readable set gains one more small, derived thing: the
built preview's own list of pages, and whether it is stale, both covered fully in
`docs/decisions/0035-preview-in-a-frame.md`.

### Images: friendly names, three layouts and your vault's art

The Images screen gets a proper name for each of the six spots an image can fill, shown as the
heading everywhere the spot appears; the code name a theme's own CSS and the docs already use (
`hero`, `crest-frame` and so on) stays visible too, but only ever as small print beside it. Each
spot also says, in plain words, whether the theme you have chosen actually draws it, this reads
the live list of themes the panel already knows about, not a guess, so it stays correct if a theme
is added later. Under the shipped `gloam` theme, the landing banner spot is a special case worth
spelling out: nothing puts it on the landing page itself, because the only built-in theme that
draws it uses it as the picture behind the not-found page, and only when that page's own text is
left empty.

The screen itself comes in three swappable layouts, remembered the same way every other screen's
layout choice already is. One shows the six spots as a gallery of cards, each a shape matching
where it is used, with a picker that lets you preview how a candidate picture would be cropped
before you commit to it. Another draws a small picture of a typical page with a numbered marker on
each spot, so picking a marker shows that one spot's own details beside the drawing, including a
small drawing of the not-found page, since that is a page of its own. The third starts from your
art instead of from the spots: every picture you have, from an upload or from your vault, in one
library, with a short list of best-fitting suggestions once you pick one. All three layouts share
one set of pending choices underneath, so swapping between them, or reloading the page, never loses
an edit still waiting to be saved; they are all saved together, in one review, over the pack-save
route that already existed.

Several pictures can now be uploaded in one go, each keeping its own file name; a file the server
refuses never stops the rest from trying. The "follow what I'm editing" behaviour (above) now also
covers Images: picking a spot, or focusing one in the page-drawing layout, moves the live preview
to the landing page, or to the not-found page for that one spot.

**Your vault's own art, read-only.** The screen can also show pictures already sitting in your
vault's own attachments folder (the same folder and default name the site generator itself reads
from), so you can point a spot at one of them without uploading a second copy. `docs/decisions/
0038-vault-art-in-the-panel.md` covers how that listing and those bytes are kept strictly inside
that one folder; the short version for this document is that section 4's fixed readable set gains
exactly two more things, the folder's own listing and one already-listed picture's bytes, and
the existing rule that nothing the panel serves is ever named by a request parameter alone still
holds: a byte request must name something the panel has already listed.

The busy rule from `docs/decisions/0033-vaultconfig-write-exception.md`'s own write-chokepoint
section now covers Images too, in its simpler, single-screen form: only "Choose files" and
"Review and save" pause while something else is running; picking a spot, swapping which picture
fills it, or undoing a choice never did send a request of its own, so none of them need to.

### Editing vault-config.md: the guarded editor, the review and restore

The vault-config.md screen moves out of the panel's read-only screens into one that can save,
guarded the same way every other write screen already is: a review before the save, a tick for
anything the review flags as worth a second look, and a save that refuses if the file changed
underneath it since it was loaded. The full mechanics, what counts as a byte-for-byte kept body,
what a stray carriage return refuses outright, how a backup is found again and labelled, and why
the Advanced group is where this screen now lives, are in the tail addendum to
`docs/decisions/0033-vaultconfig-write-exception.md`, which this subsection only points at rather
than repeats.

**Section 4's readable set.** The settings block itself joins what section 4 already reads, now as
plain editable text rather than only a parsed, read-only view; so does the backups list this screen
offers, and the plain-language list of what an edit changes, worked out by comparing the settings
before and after. None of the three reads anything section 4 did not already have a path to: the
settings block was already read for its frontmatter, the backups already exist on disk for every
save this project has ever made, and the comparison is just the same settings read twice.

**Section 6's write exception.** The whole-block replace this screen saves, and the restore it
offers from any backup the backups list actually finds, both go through the same chokepoint section
6 already describes for this file, unchanged; `docs/decisions/0033-vaultconfig-write-exception.md`
covers both operations in full, including what review each one goes through first.

**The review itself** runs the check this project already has, against the edited copy, before
anything is saved, covered as its own decision, `docs/decisions/0041-check-an-edited-copy.md`,
because the mechanism it needed (handing one file's bytes to a check without ever writing them)
is useful well beyond this one screen.

### Theme previews built from your own site

The Theme screen's cards, the build round, the status strip, the full-size view, and the before
and after review, are covered fully in `docs/decisions/0039-preview-copies.md`.

Two pointers back to earlier sections. Section 4's readable set gains the list of preview copies
and the pages each one offers. Section 5's preview builds gain copies, living under the same
temporary root, taken under the same lock, and cleaned up the same way.

### The Vocabulary live example

A rail on the Vocabulary screen, "How it will look", sits beside a "How to use" tab in the same
space. It shows a real, private build of the page your focused field actually affects: a
character page for a Connections word, the Timeline page for a story-timeline word, a session
recap for the recap heading. A Now / After saving switch flips between the page players see today
and the page they would see if you saved right now, including every edit still unsaved on the
screen. Nothing builds until you ask, with an Update example button that follows the panel's usual
busy pause; after that, the example follows your focus and your keystrokes without rebuilding
itself, only redrawing its own caption, until you ask again or the page it needs to show actually
changes. On a phone the example is a closed "See how it will look" line above the fields instead
of a side rail. Hiding the rail uses the same per-computer choice as the "How to use" rail on the
other Vocabulary layout, so there is one hidden/shown state to remember, not two.

The save itself is unchanged: this rail never writes anything, and the words you actually save
come from exactly the same place they always did.

### vault-config.md: the watch and field layouts

The vault-config.md screen has three layouts, picked with the same per-screen switcher as the
others. "Guarded dialog" is the text editor behind a warning dialog. "Unlock and watch" replaces
the dialog with an inline warning that is unlocked by typing the campaign's name, and shows what
the edit does as it is typed, in the docked pane at the widest layout (the same hide/show choice as
the file map) and below the editor everywhere else. "Fields by risk" shows seven settings as fields
in three risk groups, behind a drawer warning, and sends everything else to "Edit as text instead".
All three share one unlock and one edit session, and the writes are the guarded ones in ADR 0033
and its second addendum. The screen's preview-free reads add one route, `GET
/api/vault-config/fields`, which reads the settings and counts the pages carrying each hidden-field
name; the one new write route is `POST /api/vault-config/fields`.

## 14. Amended by ADR 0028

[ADR 0028](0028-installer-and-first-run.md) changes three things in this record.

- **Section 5 (the context is resolved once).** In the ordinary case nothing changes: the campaign
  context is resolved once, at launch, and fixed. When `serve --admin` starts with no campaign
  registered it starts in browser setup mode, and the context is resolved once at the handover,
  right after the setup commit, then fixed from there. The ports, the token and the cookie do not
  change at the handover.
- **The write exception (and the ban on reaching the config writer).** The panel's module graph
  still never reaches `src/cli/config.js` or `src/cli/init.js`. It may now reach
  `src/config/write.js` through exactly one chain, `src/admin/handlers/setup.js` >
  `src/setup/register.js` > `src/config/write.js`, so that browser setup can register a first
  campaign. That is the panel's only write to `config.toml`, and ADR 0028 section 2 names the tests
  that fence it.
- **Section 3 (the token is printed in the console).** `serve --admin` still prints the one-time link. In launch mode (running with no command) the console does not print it: the browser is signed in with a one-time launch code carried in an owner-only launcher file, and the link is printed only as the fallback when the browser could not be opened. ADR 0028 sections 7 and 8 describe the code, the one narrow Origin exception it needs on `/auth/launch`, and the fallback.

## 15. Amended by ADR 0050

[ADR 0050](0050-several-campaigns.md) changes two things in this record.

- **Section 5 (the context is resolved once).** The campaign context is now resolved at launch, at the setup handover, or at a switch. A switch re-resolves the one shared context under the exclusive lock, after a bounded check that the target's folders answer. The ports, the token, the cookies, the remote settings, the sessions and the audit log do not change.
- **The write exception.** The panel's module graph still never reaches `src/cli/config.js` or `src/cli/init.js`, and `src/setup/register.js` is still the only panel-side module that requires `src/config/write.js`. A second handler module, `src/admin/handlers/campaigns.js`, may now require `register.js`, for the campaign set-default and remove routes. Those are the only other writes the panel makes to `config.toml`, and ADR 0050 section 5 names the tests that fence them.
