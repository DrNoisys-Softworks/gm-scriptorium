# 0002. `serve` binds 127.0.0.1 by default, not 0.0.0.0

Status: accepted (phase 2, 2026-09-10).

## Summary

`serve` now listens only on the GM's own computer, so a phone or laptop on the same network cannot open the site. Passing `--host` opts in to wider access and prints a warning before the server starts. The usual habit of binding development servers to every network address was rejected here, because a site being previewed can still hold GM-only material that has not been checked or built safely. The limit a user will hit is that showing the site to another device at the table means asking for it with `--host` and accepting the warning.

## Decision

`scriptorium serve` binds `127.0.0.1` by default. `--host <addr>` opts in explicitly and prints a
warning naming the risk before starting. This deliberately contradicts the standing "dev servers bind
0.0.0.0" convention used elsewhere in this environment.

## Why the standing convention does not apply here

The standing rule exists so a developer can reach a dev server from another machine on the LAN while
iterating. That is the right default for ordinary local development, where the content being served is
either already public or not sensitive to who can see it mid-build.

`serve` is different in one specific way: the content is player-facing-but-not-yet-safe. A campaign
vault routinely contains GM-only material, prep for content the players have not reached yet, and (per
the leak checks, `src/checks/leak/*.js`) sometimes names the tool's own `check` flags as leaks on the
very content being served. `check` and `build`'s default refusal on any ERROR is the main safety net,
but `serve --build` and a plain `serve` of an already-built `out/` both bypass that net if the vault
owner ran `build --force` earlier, or built before authoring more sensitive content, or simply forgot
what state the last build was in. The LAN is exactly where that mistake becomes visible to someone else
at the table, mid-session, on the same network as the GM's laptop.

Binding to `127.0.0.1` makes the failure mode "the GM cannot see it from another device" rather than
"a player's phone, on the LAN checking scores between fights, can see it." The former is an
inconvenience with a one-flag fix; the latter is the exact leak the rest of this tool exists to catch.

## The mechanism, verified

`src/serve/server.js`'s `startServer()` passes `host` straight to `http.Server#listen(port, host)`.
Verified directly (test/README section, not automated because it requires a live socket outside
node:test's usual scope): a server started with no `--host` reports
`server.address() === { address: '127.0.0.1', family: 'IPv4', port: <N> }`, and a request to
`http://127.0.0.1:<port>/` succeeds while the server is running. A connection attempt to the machine's
LAN-facing address on the same port is refused at the socket level, because nothing is listening there;
this is a structural guarantee (the process never opens that socket), not a firewall rule that could be
misconfigured.

Timing, not just address, is part of "prints a warning naming the risk before starting" (issue #25):
`src/cli/serve.js`'s `runServeCommand()` emits the `--host` warning through its injected `emit` before
`startServer` is ever called, not after Ctrl-C returns it as part of the final summary. The same seam
also moves the `serving <path> at http://<host>:<port>` readiness line and, when `--build` is used, the
build summary (including any `--force`-overridden output-leak findings) ahead of the server accepting a
connection. `test/serve-emission.test.js`'s `AC-25-01` and `AC-25-02` tests are the ones that prove this:
they assert the warning precedes the (injected, fake) `startServer` call on a shared ordering log, and
that the serving line is already emitted while the returned promise is still pending, rather than only
asserting the warning text is present somewhere in the eventual output.

**What only Windows can add**: behaviour with the Windows Firewall enabled (whether it prompts, whether
a prior "allow" decision for a different Scriptorium version persists) is out of scope for this ADR and
is covered by `.agents/windows-verification.md` (criterion C16): mechanism verified on Linux, target-specific
behaviour unverified.

## Record, so nobody "fixes" this back

Do not change `serve`'s default bind to `0.0.0.0` to match the general dev-server convention. If a
future maintainer wants LAN reachability by default, that is a product decision for the owner, not a
convention-consistency cleanup, because it reopens exactly the leak surface this ADR closes.
