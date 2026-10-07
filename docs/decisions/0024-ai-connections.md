# 0024. AI connections

## Summary

Nothing a GM sees changes yet. Scriptorium now has one module that is allowed to make outgoing
network connections, `src/net/egress.js`. It reaches only a fixed list written in the code (today,
the two local model servers on this computer) and refuses anything else before any name lookup or
socket exists. Certificates are always verified, a redirect is an error, and proxy settings are
ignored. The main alternative, letting each feature use Node's built-in network client directly, is
rejected below because every feature would then carry its own answers to "where may this go?". The
limit a user will hit: a local model server on a non-default port, or a machine that can only reach
the network through a proxy, cannot be used.

Status: accepted for sections 1 to 4. The sections marked Pending are not decided yet.

## 1. Network posture

The only files under `src/` that load a network module are the listener in `src/serve/server.js`
(which accepts connections from the GM's own browser) and `src/net/egress.js` (which makes the
outgoing ones). `test/net-structure.test.js` pins that: it scans every source file for any way of
naming one of the seven network modules (`http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`), in
raw text and with comments removed, and requires the answer to be exactly those two files. It also
requires that `egress.js` loads only `http`, `https` and its own error file, that nothing under
`src/net` reaches outside that folder except the shared error classes, and that nothing there names
a fetch-style client, a socket-based browser API or an event-source client, so the same words
cannot slip past the older network scans once the module is reachable.

The AI features are not built yet. Nothing in the command-line tool or the panel reaches `src/net`,
which is why the older network checks (`test/generator-module-graph.test.js` and the update and
panel scans) are unchanged and still green. When a feature first reaches the module, two things
change in the same pull request: the generator-graph test gets one named entry for `egress.js` in
its allowlist, and the network line in the README is amended to say that Scriptorium can now make
outgoing connections, to which destinations, and when.

## 2. The outgoing connection module

- **A fixed destination list.** `DESTINATIONS` is a frozen list in `egress.js`: `ollama` at
  `http://127.0.0.1:11434` and `lmstudio` at `http://127.0.0.1:1234`. It is checked when the module
  loads. An entry has exactly an id, a scheme, a host and a port. Plain `http` is allowed only for
  an address in 127.0.0.0/8. No config key, environment variable, command-line flag or request field
  can add an entry, and `egress.js` never reads the process environment. Adding a destination means
  editing this file and its pinned test.
- **Refuse first.** A request names a destination id and a URL. The URL must match that entry
  exactly: the same scheme, the same host after lower-casing (no suffix, prefix or wildcard
  matching, and a trailing dot fails), the same effective port, and no user name or password in the
  address. Plain `http` to anything but a loopback address is refused again at this point. This runs
  before the module builds anything, so a refused request causes no name lookup, no agent use and no
  socket. The tests prove that with a recorder on name lookups and a counter on connects, and the
  recorder itself is shown to work on an ordinary Node request first.
- **A closed set of options.** A request takes a destination, a URL, a method (`GET` or `POST`),
  headers, a body, an abort signal, four limits and two callbacks. Anything else is refused,
  including every TLS, agent, name-lookup and socket option. Headers that decide how a request is
  framed or routed (`host`, `connection`, `content-length`, `transfer-encoding`, `upgrade`,
  `expect`, `keep-alive`, `te`, `trailer` and anything starting with `proxy-`) are refused, and a
  header value may not contain a line break or a NUL.
- **TLS is always verified.** Every `https` request sets `rejectUnauthorized: true` explicitly, which
  also beats `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment. No option can change that. The
  shipped client sets no list of trusted authorities of its own, so its trust is Node's bundled
  roots, plus whatever the machine's owner adds when launching Node through `NODE_EXTRA_CA_CERTS`,
  which Node itself only ever adds to. A test can trust a private authority only through a seam,
  `createEgressForTests`, which is named nowhere else under `src/` or `bin/`, refuses any
  destination other than `127.0.0.1` and refuses the two real model-server ports. Its trust list
  *replaces* Node's bundled list for that one loopback-only client rather than extending it: adding
  to the bundled roots inside the process would need the `tls` module, and `egress.js` is limited to
  `http` and `https`. So the rule that holds is "nothing can weaken or bypass verification", not
  "a test authority is added on top of the bundled roots". The shipped client never sets one.
- **No detours.** Each client owns private `http` and `https` agents with keep-alive off. It never
  uses the global agents, so Node's proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`,
  `NO_PROXY`, `NODE_USE_ENV_PROXY`) have no effect on it, and a test runs the module in a child
  process with those variables aimed at a trap to show it. Any 3xx status is an error
  (`E_NET_REDIRECT`) carrying only the status. The `location` header is never read and the reply is
  destroyed.
- **Limits.** Defaults: 10 seconds to connect (until the TLS handshake finishes, for `https`), 120
  seconds without a byte once connected, 10 minutes in total, and 16 MiB of reply. A call can lower
  or raise each one. The byte cap cuts the chunk that crosses it, so a caller receives exactly the
  limit before the call fails with `E_NET_RESPONSE_CAP`. An abort signal works before and during a
  request and destroys the socket. All timers are unreferenced so they cannot hold the process open.
- **Clean errors.** Every failure is a fresh `NetError` whose message comes from a fixed table by
  code. It carries only a short list of safe fields (a reason, a phase, a status, a limit, a system
  or TLS error code, a line number), each only if it is a short plain token or a whole number. It
  never carries a cause, a URL, a path, a query, a header, a body or any reply text. Nothing in
  `src/net` writes to the console.

## 3. Reading streamed replies

`src/net/sse.js` reads server-sent event streams and `src/net/ndjson.js` reads newline-delimited
JSON. Both are pure and incremental: they take bytes, decode them as UTF-8 (dropping a leading
byte-order mark and holding a character that is split between two chunks), and return what
completed. Both fail closed: after an error or after `end()`, any call fails with `E_PARSER_DONE`,
and a chunk that is not bytes fails with `E_PARSER_INPUT`.

The event-stream reader follows the standard line rules (CRLF, LF and a lone CR all end a line,
including a CR at the very end of a chunk), ignores comments, `retry` and unknown fields, and keeps
the last event id between events. Its caps are 256 KiB for a line and 1 MiB for one event's data,
counted on the decoded text and enforced while a line is still pending. The JSON-lines reader splits
on line feeds only, skips blank lines (but counts them), and caps a line at 1 MiB. A bad line fails
with the line number and nothing else, so a vendor's reply text can never end up in a message.

What the events and values mean is decided with each provider, not here.

## 4. Rejected alternatives

- **Node's built-in `fetch`.** It follows redirects by default, it cannot be given a private TLS
  setup without adding a dependency, and naming it would need a network-token allowlist entry that
  was never approved.
- **Each feature opening its own connections.** Every feature would need its own destination check,
  its own redirect rule and its own error hygiene, and a structural test could not say "this is the
  only place".
- **Honouring proxy variables.** A proxy sees every request, including the key header, and an
  environment variable is an easy way to send traffic somewhere the GM did not choose.
- **Following redirects after a re-check.** A listed host could still bounce a request that carries a
  key header to somewhere else that happens to pass the check.
- **A config key or environment variable that adds destinations.** It would turn "where may this
  go?" from something reviewable in one file into something any file on the machine could change.
- **Suffix or wildcard host matching.** `evil-api.example` and `api.example.evil` both end or
  contain a listed name. Only an exact match is safe.
- **Splicing the bundled authority list in-process.** It would give the test seam the real roots plus
  a private one, but it needs `tls` loaded in `egress.js`, which the network posture above forbids.

## Will catch / Will not catch, deliberately

Will catch: a URL that is not an exact match for a listed destination; plain `http` to a
non-loopback address; any redirect; a certificate that is untrusted, expired or issued for another
name; a reply over the size cap; a stalled, slow or endless request; an abort; an error that tries
to carry request or reply text; a test that could reach anything but this computer.

Will not catch:

- a listed destination that is itself compromised or forwards what it is sent;
- how the machine's resolver answers for a listed remote name (HTTPS verification limits the damage,
  and the local entries are IP addresses, not names);
- trust the machine's owner adds when launching Node through `NODE_EXTRA_CA_CERTS`, and a wrong
  system clock;
- any program on this computer that listens on the two local model-server ports;
- what a reply says (its size is capped, its meaning is not judged);
- a hard kill in the middle of a request;
- Windows socket behaviour, until the criterion named below has been run.

## What a consumer must do

- Pass the job's `AbortSignal`, so cancelling the job closes the connection.
- Name the destination for the configured provider, and never build a URL from user text alone.
- Check `status`: 4xx and 5xx replies resolve, they are not errors.
- Feed `onChunk` to a parser rather than buffering a long stream.
- Put keys in headers, not in the URL, wherever the vendor allows it, because a URL is more likely to
  be logged elsewhere.

## Pending: connection modes

Pending. Written when the feature it describes is built; until then nothing in the command-line tool
reaches the module above.

## Pending: remote providers and their destinations

Pending. Written when the feature it describes is built; until then nothing in the command-line tool
reaches the module above.

## Pending: keys

Pending. Written when the feature it describes is built; until then nothing in the command-line tool
reaches the module above.

## Pending: vendor terms

Pending. Written when the feature it describes is built; until then nothing in the command-line tool
reaches the module above.

## Pending: what is sent

Pending. Written when the feature it describes is built; until then nothing in the command-line tool
reaches the module above.

## Windows verification

The Windows half (the real executable reaching only listed destinations, the proxy variables having
no effect, and a certificate from an untrusted authority being refused) is verified only from the
real exe. It is OPEN: `.agents/windows-verification.md` C129. The Linux tests prove the rules against
loopback stubs from source, not from the executable.
