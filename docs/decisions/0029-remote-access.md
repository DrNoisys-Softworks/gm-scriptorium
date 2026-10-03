# 0029. Remote access to the GM admin panel (opt-in)

Status: proposed (panel v2, slice V1.5). Written before any code, so both halves of the slice build
against one record. V1.5a (the modes, the request gate, password sign-in, sessions, the lockout, the
audit log, the read-only screen and the CLI, all over the existing plain-HTTP listener) lands first.
Anything marked **Pending (V1.5b)** is a decision already taken for the TLS half (certificates, the
TLS listener, Direct mode and the encrypted proxy hop). Its evidence is filled in when V1.5b lands,
and until then nothing it describes exists in the product.

## 1. Decision

`serve --admin` stays local-only by default, exactly as ADR 0022 describes. A GM who runs
Scriptorium on another machine (a home server, a VM) can opt in to using the panel from elsewhere.
The opt-in is a saved, validated, per-machine setting, never a flag: `--host` stays refused in every
form. The ways in:

- **proxy**: behind a reverse proxy that terminates HTTPS. The panel listens on a configured address
  plus 127.0.0.1, and answers only the named proxy address(es) and this machine.
- **tailscale**: through `tailscale serve`. The panel stays on 127.0.0.1; tailscaled, connecting over
  loopback, is the trusted proxy.
- **ssh**: through an SSH local forward. The panel stays on 127.0.0.1 with fixed ports and prints the
  exact `ssh -L` command. Sign-in is the one-time token, exactly as today: SSH has already
  authenticated the GM.
- **direct** (Pending (V1.5b)): on the LAN, with Scriptorium serving TLS itself from a certificate it
  generates or one the GM supplies.

Every way in that reaches the panel from another device over a network has HTTPS (terminated by the
proxy, by tailscale serve, by SSH or by Scriptorium), exact Host and Origin rules for the configured
addresses, server-side sessions with an absolute expiry, a lockout on repeated wrong passwords, and
an audit log. proxy, tailscale and direct also need a panel password. A read-only Setup > Remote
access screen shows the state and can sign every device out. Every change is made with
`scriptorium remote ...`, which works over SSH on a machine with no screen. Editing from the panel
is V7's (section 9).

## 2. Modes

| Mode | Listeners bind | Who may connect | HTTPS by | Remote sign-in |
|---|---|---|---|---|
| local (default) | 127.0.0.1, OS-assigned or `--port`/`--preview-port` | this machine | nothing | none (token) |
| ssh | 127.0.0.1, fixed ports | this machine, including tunnelled traffic | SSH | none (token) |
| tailscale | 127.0.0.1, fixed ports | loopback; tailscaled is the trusted proxy | tailscale serve | password |
| proxy | configured address plus 127.0.0.1, fixed ports | the trusted proxy address(es) and loopback, refused before any HTTP | the proxy; the proxy-to-panel hop is plain HTTP by default, optionally HTTPS (Pending (V1.5b)) | password |
| direct (Pending (V1.5b)) | configured address plus 127.0.0.1, fixed ports | any peer that can reach it | Scriptorium, on every address it binds | password |

There is one set of remote settings per machine and one remote panel at a time. Non-local modes
always use the fixed ports from their settings, because the proxy, the tailscale serve rule or the
tunnel points at them; `--port` and `--preview-port` are refused in those modes. proxy and direct
always also listen on 127.0.0.1, so the one-time token (the recovery path) keeps working on the
machine itself.

## 3. Threat model

ADR 0022 §2 still applies to everything on the panel's own machine. For the opt-in, the panel is
additionally designed to resist:

- **LAN peers.** Anything on the network that is not the trusted proxy is refused at the socket in
  proxy mode, before a byte of HTTP is parsed. In direct mode (Pending (V1.5b)) any peer can reach
  the sign-in page; the password, the lockout and TLS are what protect it.
- **LAN peers reading the plain proxy hop** (an owner decision). The hop from the proxy to the panel
  carries the password at sign-in and the session cookie on every request. It is accepted as a
  written residual (section 15) and closed, when wanted, by the optional HTTPS hop (Pending
  (V1.5b)).
- **LAN peers spoofing the trusted proxy's address.** The peer check limits who can talk to the
  panel, not who can pretend to be the proxy (ARP or IP spoofing on the segment). Such a peer still
  needs the password or a stolen cookie. There is no client authentication on the hop (section 15).
- **Other devices on the tailnet.** A tailnet's access rules decide who can reach `tailscale serve`.
  Nothing in the product or the docs says "only your devices"; the password is the control.
- **Local processes forging forwarded headers over loopback** (tailscale mode, and proxy mode when
  loopback is a trusted proxy). They can reach the sign-in page as if proxied, use up the lockout
  and falsify the address in the audit log. They cannot get past the password (section 15).
- **Browser-borne attacks:** CSRF and login CSRF (the exact Origin check, on every POST including
  the sign-in POST), DNS rebinding (the exact Host allowlist), clickjacking (`frame-ancestors
  'none'` on every admin response, including the sign-in page, except the one hand-off redirect in
  section 7).
- **A preview (sub)domain setting cookies for the admin's parent domain.** The remote session
  cookies use the `__Host-` prefix (host-only, `Secure`, `Path=/`, no `Domain`), so a cookie planted
  with a `Domain` attribute can never carry the name the panel reads.
- **A stolen cookie.** Sessions expire 24 hours after sign-in with no sliding renewal, can be signed
  out one device at a time or all at once, and the server keeps only SHA-256 digests of session
  credentials, so a stolen sessions file yields no usable cookie.
- **A stolen remote session changing what the published site withholds.** The guarded
  `vault-config.md` writes (ADRs 0033 and 0041) are reachable from a remote session. They are
  audited like every state-changing request, and they fail closed: if the audit log cannot be
  written, a remote request to them is refused with 503 before the handler runs. The restore route
  only accepts backup names of the fixed backup shape, so the secrets under `panel/` can never be
  read through it.
- **Password guessing, and the lockout used against the GM.** Five wrong passwords in ten minutes
  pause all remote password sign-in for fifteen minutes. Paused attempts are refused before any hash
  is computed. The loopback token is unaffected, which is the GM's way back in.

**TLS additions (Pending (V1.5b)):**

- **Key theft** from disk, backups, a `%APPDATA%` roaming profile, or any copy of the config folder.
  It allows impersonating the covered names to devices and proxies that trusted the certificate,
  and so capturing the password and cookies. Mitigated by the certificate shape (section 10: the key
  that devices trust is destroyed when the certificate is made, and the key that remains can speak
  only for the configured names), by file permissions, and by regeneration on request. Proxies
  never need a copy of the key: they trust the public trust certificate.
- **Certificate/host mismatch:** refused at startup.
- **Fingerprint pinning is trust on first use:** an attacker can intercept the very first
  connection. Mitigated by comparing against the fingerprint on the console or the CLI, read on the
  machine itself or over SSH, never against a copy on a page served over the connection being
  checked.
- **A proxy configured to skip verification:** the hop then gives no protection against an active
  attacker. The docs never recommend it.
- **Downgrade:** a TLS listener never accepts plaintext, never falls back, and requires TLS 1.2 or
  later.
- **Expiry:** refused at startup; a warning 30 days ahead.
- **127.0.0.1 and localhost in the generated certificate:** a device that trusts it also trusts it
  for its own loopback. Exploiting that needs a foothold on that device (section 15).

**Out of scope:** ADR 0022 §2's list, unchanged. Also: the proxy's own configuration and security,
the tailnet's access rules, the SSH server's configuration, and a compromised device the GM signs in
from.

## 4. Settings and files (owner decision)

Non-secret settings live in `config.toml` as a new top-level `[remote]` table: `mode`, `port`,
`preview_port`, `admin_url`, `preview_url`, `bind`, `trusted_proxies`, `tls`, `tls_cert` and
`tls_key`. The last three are Pending (V1.5b) in effect, but in the schema from day one so V1.5a
never has to change its shape. An unrecognised key in `[remote]` is a hard error for `serve
--admin` and `scriptorium remote`, because a typo in a security setting must not silently become a
default. `check`, `build` and `status` never read `[remote]`. An older binary warns about the
unrecognised top-level key, preserves it on rewrite (`src/config/write.js` keeps unknown top-level
keys), and runs local-only, which is the safe failure. `config_version` is not bumped.

Secrets and the audit log do not live in `config.toml`. That file is written with default
permissions, is hand-edited, and is designed to be copied between machines. Instead they live in a
`panel` folder beside the resolved config path: `panel/password.json`, `panel/sessions.json` and
`panel/audit.log`. The generated TLS material lives in a `tls` folder beside it
(`tls/generated.pem`, Pending (V1.5b)). Both folders are created with mode 0700 and every file in
them with 0600, at creation, never loosened or tightened afterwards. On Windows they inherit the
user-profile ACL, which is OPEN until verified (C70). Because the location derives from the resolved
config path, `SCRIPTORIUM_CONFIG`/`--config` isolation also isolates the secrets and the log.
Nothing is ever written there if that folder would be inside a registered vault. A `panel` or `tls`
folder that is a symbolic link is refused. This supersedes one line of the approved V7 storyboard
(the hash "in config.toml") and its `signins.log` name.

## 5. Listeners and the request gate

**Listeners.** `startLocalListener` (`src/serve/server.js`) is unchanged and is still the only
listener in local and ssh modes. It has no `host` parameter. tailscale, proxy and direct use a new
primitive in the same file, `startPanelListener`, which takes a list of hosts. That list is computed
only by `listenPlan` from validated settings. Each entry must be an IP literal. It opens one server
per address on the same fixed port. When given a peer allowlist, it drops a connection whose peer
is not on it, in a listener that runs before HTTP (or TLS) sees the socket. If any address fails to
bind, everything already opened is closed and startup exits 1. There is never a retry on a wider
address. In V1.5b the same primitive takes TLS options (section 10). Every network-builtin line
stays in `server.js`.

**Two kinds of request (owner decision).** A request whose Host is `127.0.0.1:<port>` or
`localhost:<port>` for that listener (ADR 0022's allowlist, unchanged) is a *loopback* request: it
signs in with the one-time token only, exactly as today. A request whose Host is exactly the
configured external host for that listener (host part compared case-insensitively, port exactly,
no port for a default-port https URL) is a *remote* request: it signs in with the password only, and
`/auth?token=` is refused. Everything else, including the raw LAN address (unless it *is* the
configured host in direct mode), a trailing dot, a name with anything added before or after it, a
wrong port, a missing Host and duplicate Host headers, is 403 before anything else runs. An
external address can never be a loopback form, which the settings validator enforces, so the two
kinds never overlap.

**Peers and forwarded headers.** In tailscale, proxy and direct modes, a loopback request must also
come from a loopback peer (127.0.0.1 or ::1, after IPv4-mapped IPv6 is normalised). A remote request
in proxy or tailscale mode must come from a trusted proxy's own socket address and carry exactly
`X-Forwarded-Proto: https`. Only then is `X-Forwarded-For` read, and only its rightmost entry (the
one the proxy appended) is the client address. `X-Forwarded-Host` is never read: the proxy must pass
Host through. In direct mode forwarded headers are ignored entirely, a remote request must have
arrived over Scriptorium's own TLS, and the client address is the socket peer. SNI never decides
access. Nothing is logged to the console per request (ADR 0022 §3).

**Origin.** Every admin POST must carry an Origin exactly equal to `https://<external>` for a remote
request, or `http(s)://127.0.0.1|localhost:<port>` for a loopback request (https when the listener
serves TLS, Pending (V1.5b)). The preview's external origin is different from the admin's by
construction (the validator refuses equal ones), so preview content can never pass. No response
carries a CORS header.

## 6. Signing in

**Loopback.** Unchanged from ADR 0022: the token URL, exchanged once at `/auth` for the
per-admin-port cookie. Token sign-ins are now audited (section 8).

**Password.** A remote request with no session gets a sign-in page, the remote counterpart of the
locked page. Its script posts the password to `POST /auth/password`. That request is Origin-checked
by the gate, capped at 1024 bytes, and refused on a loopback request. The response is one generic
message for every failure, including the pause. The page states the lockout rule in fixed text, so
the GM is never left guessing. One password check runs at a time. An attempt that arrives while a
check is running, or while sign-in is paused, is refused at once without hashing.

The password is set only from the CLI: hidden input on a terminal, stdin when there is none, never
argv or an environment variable. It must be at least 12 characters (code points, after Unicode NFC
normalisation), with no composition rules. It is stored as an asynchronous Node `crypto.scrypt`
hash (N = 32768, r = 8, p = 3, 64-byte key, 16-byte random salt, parameters stored alongside) and
compared with `crypto.timingSafeEqual`. Changing it needs the current password, and signs out every
remote device. `scriptorium remote off` clears it (owner default), so a panel
still running in a remote mode refuses new remote sign-ins at once. Turning remote access back on
means setting a new one, which is also the path for a forgotten password.

**Sessions.** A successful sign-in always issues a new 256-bit credential. Any valid session the
request carried is revoked, so a session can never be fixed. The credential is set as
`__Host-scriptorium_session=<value>; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Strict`.
The server stores only the credential's SHA-256 digest, its kind and its absolute expiry. Sessions
last 24 hours from sign-in with no sliding renewal and survive a restart. The panel notices when
the CLI rewrote the file (sign out every device, a password change, `remote off`) and reloads it
before the next check. "Sign out this device" revokes the current session; "Sign out every device"
revokes all of them. Remote requests never accept the token or the loopback cookie; loopback
requests never accept a remote session.

**Lockout (owner decision).** Five wrong passwords within any ten-minute window pause all remote
password sign-in for fifteen minutes, globally rather than per address, because an attacker
controls their own address. The state lives in memory: a restart clears it, as does the passage of
time. The loopback token is never paused. The start and end of each pause are audited. The end is
recorded when it is first observed, stamped with the time the pause actually ended.

## 7. The preview, the GM link, and URLs from the server

**The preview's external address** is a second hostname in proxy mode (preferably
`preview.<admin name>`, which keeps the two same-site for `SameSite=Strict`), a second HTTPS port of
the same ts.net name in tailscale mode, and a second port in direct mode. The same Host,
trusted-proxy and TLS rules apply, and a remote preview request needs its own preview session.

**Open preview without a long-lived secret in a URL.** The panel's Open preview link, and every
frame and tab the panel opens onto the preview, is the admin-origin path `GET /open-preview?to=<rel>`
(the target is re-validated on the server: no leading `/`, no backslash, colon, query or fragment,
no empty, `.` or `..` segment, and a variant id only in its own shape). For a loopback request it
redirects to the loopback preview URL, keeping the request's own host form, as today. For a remote
request with a valid session, it mints a ticket and redirects to
`<preview address>/:enter?ticket=<t>&to=<rel>`. The hand-off path starts with a colon, which the
published-site path rules never produce (ADR 0039's reserved namespace), so it can never shadow a
page. The ticket is 256 random bits, lives in memory only, is single use, expires after 60
seconds, and is bound to the admin session that minted it. The preview listener consumes it, sets
`__Host-scriptorium_preview=<value>; Path=/; Max-Age=<remaining>; Secure; HttpOnly;
SameSite=Strict` for a preview session that ends when its admin session does, and redirects to the
validated target, which removes the ticket from the address bar. A preview session that already
exists for the same admin session is reused, so there is one preview session per admin session,
not one per frame load.

**The live preview frame (ADR 0035) in remote modes.** In a remote request, the panel page's
Content-Security-Policy names the configured preview origin as its only `frame-src`, and remote
preview responses name the configured admin origin as their only `frame-ancestors`. Both are built
only from the validated settings, and fail closed to the loopback-only forms unless the origin is
exactly the configured one. The loopback forms are unchanged byte for byte. The hand-off 303 itself
carries `frame-ancestors 'self'`, the one deliberate exception, so the hop works whether or not a
browser enforces frame-ancestors on redirects.

Minting on a GET is deliberate. A cross-site page cannot trigger it, because the Strict cookie is not
sent on a cross-site navigation. A same-site page (the preview itself) can trigger it only for the
same browser, and can never read the redirect (no CORS, `frame-ancestors 'none'`). HEAD never mints.
The preview listener never accepts the admin session cookie, and the admin listener never accepts
the preview cookie.

**URLs come from the server, so no proxy rewrites a body.** The GM link injected into preview pages
points at the admin's external address in tailscale, proxy and direct modes, and at
`http://127.0.0.1:<port>/` in local and ssh modes, exactly as today. It never carries a token.
`/api/session` gains an `access` object carrying the footer's reach line, which in local mode is
the unchanged "Bound to 127.0.0.1 only". The output gate is untouched: published builds carry no
GM-link marker, no external address and no loopback address, and stay byte-identical.

## 8. Audit log

One append-only JSON-lines file, `panel/audit.log`, written in every mode including local. It
records:

- every sign-in attempt: method (token or password), result, client address (section 5), browser
  family from a fixed list (Edge, Firefox, Chrome, Safari, curl, other; never the raw User-Agent),
  time and campaign;
- the start and end of each lockout;
- sign-out of one device, and of every device;
- password changes and remote-settings changes (the changed key names, not values);
- certificate generation and regeneration (Pending (V1.5b));
- two lines per state-changing POST that passes the gate: one before the handler runs, and one after
  with the status.

The POST hook is a flag on the route (`audit: true`) set on every state-changing POST route except the
no-op test route and the sign-in and sign-out routes, which write their own events. A structural test
pins that exact set, so a new route cannot be added without the flag.
V3's publish sets the same flag.

Entries are built only from a fixed list of keys, and every string is stripped of control
characters and capped. That is how "never passwords, tokens, cookies, session credentials, private
key material or request bodies" is guaranteed structurally rather than by care. Attempts refused
during a pause, or while another check is running, are counted into the lockout-end entry rather than
written one line each (owner default). This stops the pause from becoming a way
to fill the disk.

Entries older than 90 days are pruned at startup, best-effort. A pruning failure never blocks
startup and never changes an exit code.

If the log cannot be written (owner decision), a state-changing request from a remote session is
refused with 503 before its handler runs, and so is a remote password sign-in. A loopback request
goes ahead, and the failure is shown on the Remote access screen. Signing out is always allowed.

## 9. The CLI, the read screen (owner decision), and the V7 seam

`scriptorium remote show | set | password | signout-all | off` makes every change, plus `remote cert
generate | use | show | export` (Pending (V1.5b)). `set` validates each value as it is given
(`http://` is refused with "remote access needs HTTPS"), writes `config.toml` through the existing
canonical writer, and reports whether the settings are complete. Changes take effect at the next
start of `serve --admin`, except sign-outs and the password, which take effect at once.

The Setup > Remote access screen shows:
- the mode, the addresses and where it listens;
- whether HTTPS is on and by what;
- when the password was set, and the lockout state;
- sign-ins from the last seven days, and the full log with a refused-only filter;
- the audit log's health;
- in TLS modes, the certificate (Pending (V1.5b)).

In place of Change, Turn on and Turn off, it shows the command to run. Its only actions are "Sign
out this device" and "Sign out every device".

The FR35 structural test (`test/admin-assets.test.js`) is untouched: the panel still cannot reach
any config writer. A new structural test pins that the panel's module graph never reaches the
password writer, the CLI, or the certificate generator and its writer (Pending (V1.5b)). It also
pins that the only writers of remote-access files (`panel/`, `tls/`) are the session store and the
audit log (and, for the CLI only, the password writer), and it has a positive control. The panel also
writes the pack, `vault-config.md`, its backups and its preferences, as ADRs 0022, 0033 and 0041
describe; those are not remote-access files.

**The V7 seam.** Field validation (`src/setup/validate.js`), the settings model, the completeness
rules and the listen plan (`src/remote/settings.js`), and password hashing (`src/remote/password.js`)
are shared modules with no UI. V7's browser setup offers the same five choices by calling them.
V7's own panel writer, and its relaxation of the new structural test, are V7's escalation to make.

## 10. TLS and certificates (Pending (V1.5b))

**Certificates are optional (owner decision).** Only direct mode and the encrypted proxy hop use
one. local, ssh, tailscale and plain-hop proxy never do.

**Generator: in-house, no new dependency.** Node's `crypto` already provides EC key generation, SPKI
export, ECDSA signing with DER signatures, SHA-256, and `X509Certificate` for parsing and
verification. The only missing piece is DER encoding of a certificate's to-be-signed body: about
150 lines under `src/cert/der.js` with known-answer tests. Rejected: an X.509 library (a new
runtime dependency, notices, a licence re-audit, and security-critical third-party code in a
product that may be sold) and calling `openssl` (not on stock Windows, and `child_process` on the
admin path is forbidden).

**Shape: a name-constrained trust certificate plus a server certificate, with the trust key never
stored.** Generation makes two P-256 keys:
- The first signs a CA certificate, "the trust certificate": `CA:TRUE`, `pathLen:0`, `keyCertSign`
  only, and critical name constraints permitting only the configured names and addresses.
- It then signs the server certificate: `CA:FALSE`, `digitalSignature`, `serverAuth`, subject
  alternative names only, no common name.
- Then the first key is discarded without ever touching disk.

Devices and proxies import the trust certificate, not the key. A stolen server key can speak only
for the server certificate's own names. It cannot issue anything, because every verifier refuses a
`CA:FALSE` issuer, and the only key that could issue no longer exists. The name constraints are
defence in depth: browsers differ on enforcing constraints in imported roots, so the design doesn't
rely on them. The constraints admit subdomains of each configured name (RFC 5280 semantics), which
only matters if the discarded key were somehow recovered.

Rejected:
- a self-signed server certificate trusted as its own root. The trusted key would then be the
  working key, and whether a stolen copy could issue for other names would depend on every
  verifier enforcing `CA:FALSE` on trust anchors, which not all do.
- an unconstrained local CA of the kind mkcert makes. FR-23 rejects it.
- keeping the CA key for later leaves. It is a standing issuing key on disk.

**Parameters.**
- ECDSA P-256, signed with ecdsa-with-SHA256.
- Serial numbers: 16 random bytes with the top bit cleared and the next bit set, so every
  generation is unique, as Firefox requires.
- The trust certificate's subject carries a random suffix.
- `notBefore` is backdated one hour for clock skew.
- The default validity is 820 days. The ceiling is 825, inclusive of both ends, under Apple's limit.
- 127.0.0.1 and localhost are always included.

**Storage and rotation.** The server key, the server certificate and the trust certificate are one
PEM bundle, `tls/generated.pem`, mode 0600 in a 0700 folder. That makes "replaced together
atomically" a single rename, and a failed regeneration leaves the old bundle byte-identical.
Regeneration happens only when the GM asks (`remote cert generate --replace`), never automatically,
because a silent fingerprint change looks exactly like an attack. It is audited. The key is never
printed, logged, exported, sent in a response or shown in the panel. `remote cert export` gives only
the trust certificate.

**Bring your own.** A PEM certificate (any chain) and an unencrypted private key in any format
`crypto.createPrivateKey` accepts, read in place at every start and never copied. On POSIX, a key
readable by group or others gets a startup warning. Passphrase-protected keys are refused with a
clear message.

**Startup checks, for both sources.** Startup is refused, with one line and exit 1, when:
- the certificate or key doesn't parse;
- the key doesn't match (`checkPrivateKey`);
- the certificate is outside its validity window;
- a configured external name or address for either listener is not covered (`checkHost` with no
  common-name fallback and no partial wildcards, or `checkIP`).

Refusing a name mismatch is deliberate: a GM who is warned every time learns to click through. A
certificate expiring within 30 days warns at startup and on the read screen.

**The TLS listener.** Both listeners serve TLS on every address they bind, including loopback:
`https.createServer` with `minVersion: 'TLSv1.2'`. There is no plaintext port, no redirect and no
fallback. HSTS is deliberately not sent: it would make click-through impossible for a
self-signed-trust setup, and a proxy that wants it adds it itself. In TLS modes the loopback cookie
gains `Secure`.

**Fingerprints.**
- Format: SHA-256 over DER, uppercase colon-hex, the same as `fingerprint256` and browsers'
  certificate viewers.
- For a generated certificate there are two:
  - the trust certificate's: compare it when importing, and give it to the proxy;
  - the server certificate's: what a browser warning page shows first.
- For a certificate you supplied, the server certificate's.
- Where they are shown: the startup console, `remote cert show`, and the read screen. The read
  screen and the docs say the first-connection check must use the console or CLI copy.

**The encrypted proxy hop.** The proxy dials the panel's bind address over HTTPS, trusts the trust
certificate (or the GM's own CA), and verifies the external name as the TLS server name. It keeps
passing the browser's Host through; it never rewrites Host to the upstream address. The trusted-peer
rule and `X-Forwarded-Proto: https` still apply. The documented Caddy configuration is confirmed
against Caddy's own docs at the time of writing, and never uses a skip-verification option.

**Evidence: Pending (V1.5b)**, recorded here when V1.5b lands:
- the parse-back oracle and the openssl run;
- the name-constraint negative control through a real TLS client;
- the real TLS socket tests;
- the packaged Linux binary generating a certificate and serving direct mode and the HTTPS hop;
- whether any browser refused `Secure` cookies on a click-through origin. If one did, "import the
  trust certificate" becomes the documented path (C75).

## 11. What this supersedes, for the opt-in only

- **ADR 0022 §3, "Loopback bind, no opt-out".** Local and ssh are exactly that. tailscale also
  keeps the loopback bind. proxy and direct bind a configured address plus loopback, and only from
  validated saved settings, through a separate primitive fed only by the listen plan.
  `startLocalListener` keeps no `host` parameter.
- **ADR 0022 §3, the token's position.** It is still printed exactly once. In remote modes it
  appears on an "on this machine" line after the warning that ADR 0002's ordering requires, not on
  the first line.
- **ADR 0022 §3, Origin "equal to `http://` plus the lowercased Host".** Unchanged for loopback
  requests on plain listeners. Remote requests compare against the configured external origin, and
  TLS listeners use `https://` (section 5).
- **ADR 0022 §3, the session-only cookie.** The loopback cookie is unchanged. Remote sessions carry
  an explicit 24-hour expiry and survive a restart.
- **ADR 0022 §9, the rejection of `--host`.** It stands, and the reason is reworded. Remote reach
  comes only from saved settings, so the refusal message now says so instead of "only ever listens
  on 127.0.0.1".
- **ADR 0022 §11, the SSH residual.** ssh mode fixes both ports and prints the command with matching
  local ports, so the tunnel matches by construction. The residual now applies only if the GM
  changes the local ports.
- **ADR 0002.** Plain `serve` is unchanged. The panel's opt-in follows ADR 0002's two rules: it must
  be explicit, and a warning naming who can reach it is printed before any socket opens. The only
  difference is that the opt-in is a validated saved setting rather than a flag.

## 12. Constraint tests

Unchanged:
- the network-builtin scans (`test/admin-assets.test.js`, and `test/generator-module-graph.test.js`'s
  per-file allowlist, which still names only `src/serve/server.js`);
- FR35;
- the exit-code taxonomy (no new codes);
- the `createAdminContext` literal (new context fields are added dynamically, like `previewRoot`).

Updated deliberately, each in a reviewed hunk:
- the admin route sweep;
- A2 and the e2e `--host` message;
- the help-text line;
- the nav literal;
- the `/api/` path literal;
- the admin asset and package asset literals.

`src/serve/server.js` gains `https` in V1.5b and passes the allowlist test with no edit. Its
justification string, which describes only plain `serve`, is updated in its own commit to name the
panel's listeners and this ADR (Pending (V1.5b)). That is a documentation-accuracy edit and changes
no guarantee. New structural tests pin the panel's writer set (section 9), the absence of
`scryptSync` and of environment reads in the remote code, and the certificate module's imports
(`crypto` only).

## 13. Rejected alternatives

- **A flag that turns remote on,** including `--host`. A flag is one typo away from exposure and
  carries no validation. Settings are validated as a whole before any socket opens.
- **Trusting `X-Forwarded-Host`, or the leftmost `X-Forwarded-For`.** The first lets whatever the
  proxy relays choose the Host rules. The second is client-supplied.
- **Stateless signed cookies, with "sign out everywhere" as a secret rotation.** Signing out one
  device would then need server state anyway. Server-side records of digests are simpler and allow
  single-device sign-out.
- **The password hash in `config.toml`,** as the storyboard showed. That file is hand-edited, copied
  between machines, and written with default permissions (owner decision).
- **Accepting the password on loopback too** (owner decision). It would let any local process try
  passwords.
- **Editing remote settings from the panel now** (owner decision). It doubles the review surface.
  That's V7's, together with setup mode.
- **Letting the preview accept the admin cookie, or sharing a cookie domain.** The preview hand-off
  ticket keeps the two origins' credentials separate in every mode.
- **Per-address lockout.** The attacker controls the address.
- **For TLS:** an X.509 library; `openssl` as a child process; a self-signed server certificate as
  its own root; an unconstrained or retained CA; HSTS; automatic renewal or ACME (out of scope).

## 14. Will catch

- DNS rebinding and wrong-name requests against the external names and the LAN address (the exact
  Host allowlist, including trailing dots, suffixes, ports, missing and duplicate Host).
- Any peer other than the trusted proxy and this machine in proxy mode (dropped at the socket).
- Forged `X-Forwarded-For` or `X-Forwarded-Proto` from anything that is not the trusted proxy's
  own socket. A client-supplied `X-Forwarded-For` entry ahead of the proxy's own.
- Cross-site and cross-origin writes, including login CSRF and requests from the preview origin
  (the exact Origin per request kind).
- Clickjacking of the panel and the sign-in page.
- A preview name planting cookies for the admin name (`__Host-` names).
- Session fixation (a new credential on every sign-in).
- A stolen sessions file yielding a usable cookie (digests only).
- A token URL used against the external name, and a remote cookie used against loopback.
- More than five wrong passwords in ten minutes, and parallel guessing (one check at a time, and
  refused before hashing).
- Remote changes continuing while the audit log cannot record them.
- Secrets in the vault, the site, the preview, responses, the console or the log (fixed-key audit
  entries, and a location beside the config that is never inside a vault).
- (Pending (V1.5b)) A certificate that does not cover the configured names, is outside its dates, or
  does not match its key (startup refusal).
- (Pending (V1.5b)) Plaintext or pre-TLS-1.2 connections to a TLS listener.
- (Pending (V1.5b)) A stolen generated server key being used for names outside the configured set.
- (Pending (V1.5b)) A half-replaced key and certificate after a failed regeneration.

## 15. Will not catch, deliberately

- Reading the plain proxy hop (owner decision): the password at sign-in and every cookie are readable to anyone
  who can see that traffic. Keep the proxy and the panel on a trusted segment, or use the HTTPS hop.
- A LAN peer that spoofs the trusted proxy's address: it reaches the sign-in page as if proxied.
  There is no client certificate on the hop (mTLS is out of scope).
- Devices the tailnet's access rules allow: they reach the sign-in page.
- Local processes forging forwarded headers over loopback: they can use up the lockout and falsify
  audit addresses.
- The lockout as denial of service: anyone who reaches the sign-in page can keep remote sign-in
  paused. The way back is the token on the machine or through SSH, or a restart, which also clears
  the pause.
- A stolen session cookie: it stays valid until its expiry or a sign-out, and is not bound to an
  address or device.
- Password quality beyond a 12-character minimum: there is no breach-list check.
- Cookie-jar flooding by preview content, which can evict the session cookie. That signs the GM out;
  it never signs anyone in.
- A sign-in landing in the same instant as a CLI sign-out-all can survive it. The panel re-reads the
  sessions file before every write, which narrows the window without closing it.
- A stolen remote session can use the guarded `vault-config.md` editor (ADRs 0033, 0041) to change
  what the published site withholds. Every such write is audited, and refused while the log cannot
  be written, but the session is the only control: there is no second factor.
- The GM link in remote modes points at the external address. A GM using the panel on the machine
  itself who follows it lands on the sign-in page.
- Refused attempts during a pause are counted, not logged one line each (owner default), and a paused refusal
  answers faster than a checked one. The pause is not a secret: the sign-in page states the rule.
- A new remote sign-in after `remote off` on a still-running panel is refused (the password is
  cleared). Its network listeners close only at the next restart.
- Windows ACLs on `panel` and `tls` inherit the profile folder (OPEN, C70, C78). A config placed
  outside the profile gets that folder's ACL.
- A `%APPDATA%` roaming profile, and any backup of the config folder, carry the password hash, the
  session digests and (V1.5b) the server key.
- (Pending (V1.5b)) Trust on first use: an unchecked first click-through can be intercepted.
- (Pending (V1.5b)) A proxy configured to skip upstream verification.
- (Pending (V1.5b)) No revocation. Regenerating does not untrust the old trust certificate on
  devices that imported it: remove it by hand after a suspected theft.
- (Pending (V1.5b)) Devices trusting the generated certificate also trust it for their own
  127.0.0.1 and localhost.
- (Pending (V1.5b)) A supplied certificate is checked only for names, key match and dates. Its chain
  is whatever the GM's CA says.
- (Pending (V1.5b)) Name-constraint enforcement on imported roots varies by browser. The design does
  not rely on it.

## 16. Verification

**Linux (V1.5a):** recorded at V1.5a landing. **Linux (V1.5b):** Pending (V1.5b).

**Windows:** C69 to C74 (V1.5a) and C75 to C80 (V1.5b) in `docs/HANDOVER-WINDOWS.md`, all OPEN
until a person confirms them on a real Windows machine.

**Owner acceptance (owner decision):** run by the owner from the owner's desktop against the
owner's own infrastructure. Agents never change the owner's proxy or tailnet configuration.

| Check | Status |
|---|---|
| A real Caddy site block for the admin and preview names, over the plain hop: sign-in, a save, Open preview, sign out every device | OPEN |
| Caddy over the HTTPS hop, trusting a generated trust certificate, with the external name as the TLS server name and Host passed through; verification never skipped | OPEN (Pending (V1.5b)) |
| The same with a supplied certificate | OPEN (Pending (V1.5b)) |
| `tailscale serve` for the admin and preview ports, from another tailnet device, including that the browser's Host reaches the panel unchanged | OPEN |
