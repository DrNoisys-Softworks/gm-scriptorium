# 0054. Getting into the GM console from the player site

## Summary

Remote sign-in to the admin panel now takes a username and a password, and a GM can run several named accounts, up to eight, all with the same rights. They are managed only from the command line with `gm-scriptorium remote account ...`; the panel lists them and cannot change them. An install that has one password and no username keeps working as the account `gm`, and nothing is rewritten when the file is read. The sign-in lockout counts wrong tries per username typed, whether or not that account exists: five in ten minutes pause that name for fifteen minutes, and fifty across all names pause everyone. The same decision lets a published site carry one plain "Game master" link in its footer, switched on per campaign in `pack.toml`, that opens the console's sign-in page. The main alternative, a lockout per address, is rejected below. The limits a GM will meet are that anyone who can reach the sign-in page can pause everyone's sign-in by guessing wrong fifty times, that anyone who knows an account name can keep that one account paused, and that a published link makes the console's address public.

Status: accepted. The accounts, the sign-in and the lockout (sections 2 to 5, 7 and 8) are built. The published link and the panel card that sets it (section 6) are decided here and built in later changes; their evidence is marked Pending in section 14.

## 1. Decision

Four things change, and each is opt-in or invisible until used.

- **Several named accounts.** Remote password sign-in takes `{username, password}`. Accounts live in `panel/accounts.json`. An account has a name and a password, nothing else: no roles, no permissions, no email.
- **A lockout that a stranger cannot use cheaply.** Wrong tries are counted per username typed, with a higher ceiling across all names (section 4). It is cheap to abuse only for a stranger who does not know a username. Someone who knows or guesses one can still keep that account paused (section 13).
- **Accounts from the command line only.** `gm-scriptorium remote account add | change | reset | remove | rename | list`, plus `remote signout-all --account NAME`. The panel's Remote access screen lists names, when each password was set and the last sign-in, read-only.
- **An opt-in link on the published site.** A campaign can add one footer link to its published pages, set in `pack.toml` and, in a later change, from a panel card. It is off unless switched on, and a build with it off is byte for byte what it was.

Sign-in on the computer itself is unchanged: the one-time link or the launch code, never a password. `ssh` mode is unchanged. Nothing about the transport changes: this works only behind Tailscale or a proxy that gives HTTPS, and a request without `X-Forwarded-Proto: https` from a trusted proxy is still refused before any page is served.

## 2. Accounts and the file

`panel/accounts.json` sits beside `password.json`, `sessions.json` and `audit.log`, in the same `panel` folder, created readable only by you (`0700` for the folder, `0600` for the file) through the same atomic private write, with a link refused. The folder is still never created inside a vault.

Each entry is a `password.json` record (the same scrypt parameters, salt and hash) plus a `name` and a flag, `fromEarlierPassword`. The file is read as a whole and fails closed: it is invalid if any entry is malformed, a name is not already in canonical form, a name repeats, or there are more than eight entries. An invalid file means nobody can sign in, and the command line says how to start again. After `gm-scriptorium remote off` the file is replaced by `{ "version": 1, "cleared": true, ... }`.

**The username rule.** A username is 1 to 32 ASCII letters, digits, dots, hyphens or underscores, starting with a letter or digit, and it is case-insensitive: `Rook` and `rook` are the same account, stored and shown as `rook`. The rule is ASCII only on purpose. A name anyone can try from a public page should have no look-alikes (a fullwidth letter, a Cyrillic letter that looks Latin) and no locale-dependent case folding. Unicode names are refused. The code still normalises to NFC before checking, so widening the rule later keeps one path; under an ASCII-only rule that step changes nothing a person could observe. Passwords are unchanged: at least 12 code points after NFC, at most 1024, no composition rules.

**The cap** is eight accounts. It keeps the list readable and the lockout state small.

**Migration, with nothing rewritten on read.** If `accounts.json` does not exist, an earlier `password.json` that holds a password reads as one account named `gm`, marked "from your earlier password", with the same hash. Nothing is written when it is read, not by the panel and not by `account list` or `show`. If `accounts.json` exists in any form (set, cleared or broken) it wins, and `password.json` is ignored. The first `remote account` command that writes (or `remote password`) puts that `gm` account into `accounts.json` and then clears `password.json`. Because accounts.json always wins, a crash between the two steps is harmless: the old file is stale but inert, and the next write clears it. Sessions made before accounts existed have no account recorded and count as `gm`.

**`remote password` stays** as an alias for the account `gm`: it adds `gm` when it is missing and otherwise changes it, asking for the current password first. Its prompts and its message are exactly what they were, and it still signs every device out.

**Who may write.** `src/remote/accounts.js` is read-only and is in the panel's module graph: its only requires are `fs`, `crypto` and `./password`. The writers, `writeAccounts` and `clearAccounts`, live in `src/remote/passwordwrite.js`, which the panel's graph never reaches, so the panel can read the list to check a sign-in and can never set or clear an account (ADR 0029 section 9).

## 3. Signing in with a username

`POST /auth/password` takes a body of exactly `{username, password}`: the username a string of 1 to 64 characters, the password 1 to 1024. The body is still capped at 1024 bytes, Origin-checked by the gate and refused on a loopback request. Anything of the wrong shape is a 400 with the one generic body, is never hashed and is not counted toward any lockout. The handler then goes in this order: make the lockout key from the typed name, read the accounts (a file read, no hashing), check the lockout, refuse if another check is running, refuse if no account can be used, refuse if the audit log cannot be written, and only then hash.

**One answer for everything.** Unknown name, wrong password, paused name, global pause and busy all return `403` with the same body: "That didn't work. Check your username and password." A refusal that did not hash waits about as long as a real check just took, so the time does not show which happened.

**The same work for every name.** The handler calls the scrypt check exactly once with the real parameters. For a known account the record is that account's. For an unknown name, or a name that breaks the rule, it checks against a record made once at start-up from random bytes, with the same cost parameters. That record is never a valid password, so the result is "no" however the check comes out. A paused attempt is not hashed at all.

**What is written.** The text typed as a username is never written anywhere: not to the audit log, not to a response, not to the console. It lives only in memory as a lockout key. The audit entry names the account only when it exists, otherwise `unknown`. A successful sign-in creates a new session that records its account, revokes any session the request presented, and sets the same cookie as before.

`GET /api/session` gains `account`: the signed-in account's name, `gm` for a session from before accounts existed, and `null` on a loopback request.

## 4. The lockout

Numbers, exactly:

- **Per username:** 5 wrong tries for one username inside any 10-minute window pause that username for 15 minutes.
- **Global ceiling:** 50 wrong tries across all usernames inside any 10-minute window pause every password sign-in for 15 minutes.
- The window is 600000 ms and the pause 900000 ms, on an injected clock in the tests.

A "username" here is whatever was typed, counted as the canonical name whether or not that account exists, so the lockout reveals nothing about which names are real. Every text that breaks the username rule shares one counter. Counting is never per address: an attacker controls their own address.

A success clears that name's count only, never the global count, so signing in cannot be used to reset the ceiling. Pauses are checked before any hashing, so a paused attempt costs no work. The loopback token and launch code are never paused. The state lives in memory: a restart clears it, as does the passage of time. The start and end of each pause are audited, with the account name (or `unknown`) for a name pause and the scope `all` for the ceiling.

The sign-in page states the rule in fixed text, always, so it does not depend on whether the visitor has failed yet. The paused page looks exactly like a wrong password on purpose.

This replaces the single global counter of ADR 0029 section 6. That counter was right while only the GM knew the address. Once the address can be on a public site, any visitor could pause the GM's sign-in with five guesses, which is what the per-username count and the higher ceiling fix, at the price recorded in section 13.

## 5. Password managers

The sign-in form has a visible username field (`autocomplete="username"`, no automatic capitalisation, no spell check) and the password field (`autocomplete="current-password"`), each with a label. The admin Content-Security-Policy keeps `form-action 'none'`, and the page still posts by script.

On success the page does not clear either field before it navigates away. Chromium and Edge capture the credential at the submit event and offer to save after the page leaves the form. Firefox captures from the still-filled fields when the page navigates. On failure only the password is cleared and the username stays. With scripts off, the native submit is blocked by `form-action 'none'`, which fails closed.

**Why `form-action` stays `'none'`.** The alternative is a native form post with `form-action 'self'`. The page sets `Referrer-Policy: no-referrer`, and under that policy the Fetch standard sends `Origin: null` on a non-CORS form navigation. That would fail the exact Origin check, and both remedies (relaxing `no-referrer`, or accepting `Origin: null`) weaken controls ADR 0029 relies on. So the scripted post stays.

**Verification is manual.** Whether Edge, Chrome and Firefox really offer to save and to fill is a claim about browsers, not code, and is not proved by any test here. It is criterion C159 for Edge and an owner acceptance item for Chrome and Firefox (section 14). If Edge or Chrome does not offer to save, the agreed fix is client-side only: before navigating, store the credential through the Credential Management API where the browser has `PasswordCredential`. It changes nothing on the server. If Firefox does not offer to save, that is a recorded residual (section 13).

## 6. The GM link on the published site

A campaign can switch on one plain link in the footer of every published page, set in its `pack.toml`:

```toml
[gm_link]
url = "https://gm.example.net"
```

No table means off. A table means on, and `url` is then required: a string, `https://` only, a bare origin (no path, query, fragment or user name and password), never a loopback or unspecified address. `check` and `build` refuse anything else as a pack problem, exit 3, with one plain line. Any other key in the table is a warning.

The link is added by Scriptorium's own pass after the generator has finished, in the same style as the third-party notices line, and the generator's markup is never touched. It reads "Game master", is plain text with no icon, and carries `rel="noopener noreferrer nofollow"`, a marker of its own (`data-scriptorium-gm-access`, different from the preview marker), no script, no `target`, and no address but its `href`. The href is the console's origin and `/`, plus `?campaign=<name>` when the campaign's configuration name has the shape of a campaign name. It never carries a token, ticket, session or loopback address, and it never checks whether the console is running, so the site gives no sign that a GM is online.

The pass runs before the output gates, so the leak scan, the comment scan and the preview-marker scan all run over the tree that will really be published, and none of them can be skipped. With the link off the pass touches nothing and a build is byte for byte what it was. The preview shows the link exactly as it will be published, next to the existing preview GM link.

The setting lives in `pack.toml`, which build already reads, so it travels with the pack. A key in `config.toml` was rejected: that file is per machine. Build and check still never read `[remote]`.

In a later change the Campaigns screen gets an audited card that edits the setting through the existing fenced `pack.toml` save. It always warns that anyone who reads the site sees the address, and it adds a notice when the address differs from the configured admin address, when remote access is off or SSH, or when it equals the preview address. The docs recommend a Tailscale address over a public reverse-proxy name.

## 7. The campaign hint

The link may open `/?campaign=<name>`. The server treats "/" as the sign-in page when the raw query is empty or is exactly one `campaign=<value>` parameter whose value has the shape of a campaign name (lower-case letters, digits and hyphens, 1 to 63). Any other query, a second parameter, a different case, a path-like value or an encoded character keeps today's plain refusal. The same rule applies to the locked, launch-locked and sign-in pages. The server never looks the name up, never decodes it, and never puts it in a header, a redirect or a page.

The sign-in page's script reads the query itself, checks it against the same shape, and after a successful sign-in goes to `/?campaign=<name>` when it passes and to `/` when it does not. Whether the name is a registered campaign is decided only after sign-in, by the panel, so an anonymous visitor cannot use the hint to find out which campaigns exist. After sign-in the panel offers a one-click switch when a different campaign is active (built with the card), and never switches by itself.

## 8. Crawlers

A public link will be found by crawlers, so every response from the admin listener now carries `X-Robots-Tag: noindex`: the sign-in page, the locked and refusal pages, JSON answers and assets. The preview listener's headers are unchanged: its address is never linked from the site and it always needs a session. Host, Origin, the `__Host-` cookie, `frame-ancestors` and `Referrer-Policy` are untouched.

## 9. What this supersedes, for the opt-in only

- **ADR 0022 section 1.** "A published build never changes" now has one opt-in exception: a published build may carry one GM link per page, only when switched on in the pack.
- **ADR 0022 section 8.** "A published build can never carry a GM link" now refers to the preview GM link and its marker only. The preview gate stays unconditional and cannot be overridden by `--force`. The sentence that `runAtomicBuild`'s signature gains no new parameter is amended to read: no parameter can skip or override any gate, and `gmLink` only switches the published link on.
- **ADR 0029 section 6.** Sign-in takes a username, the lockout is per username with a global ceiling (section 4), a change signs that account out, and `remote off` clears every account.
- **ADR 0029 section 7.** Published builds may carry the configured `https://` console address in the opt-in link, never a loopback or preview address, and are byte for byte unchanged when it is off.

Two other amendments do not relax anything: ADR 0029 section 4 gains `accounts.json` beside the other files in the `panel` folder, and section 9 gains the `remote account` verbs and `signout-all --account`. The panel still never reaches the writer.

## 10. Constraint tests

- `test/remote-structure.test.js` gains `src/remote/accounts.js` as the last entry of the files the panel's graph must reach, and a new test that `accounts.js` holds no writer token and requires exactly `crypto`, `fs` and `./password`, with a positive control. The list of forbidden files and the list of files allowed to call a private-file writer are unchanged.
- `test/gm-link-structure.test.js` and the other constraint tests (the embedded-asset rule, `net-structure`, `proc-structure`, the module-graph tests, `setup-structure`, `admin-campaign-fields`, `vault-read-candidate`) are unchanged. No field is added to the panel context.
- The published link adds its own pins in `test/gm-access-structure.test.js` when it is built.

## 11. Rejected alternatives

- **A lockout per address.** An attacker controls their own address, and a proxy hides it. It would also lock the GM out when a shared address is abused.
- **Keeping the global counter of five.** Cheap for any visitor to trigger once the address is public.
- **A native form post, so password managers see a real submit.** It needs `form-action 'self'`, and under `Referrer-Policy: no-referrer` the browser sends `Origin: null`, which fails the Origin check (section 5).
- **A generic link with the address stored in each browser.** Nothing in the site, but a setup step on every device and a script on every page.
- **Hiding the link.** It does not hide the address, which is in the page source either way.
- **Editing accounts in the panel.** It would put the panel one require away from the password writer. It stays a command line job; panel editing of remote settings remains a separate future decision.
- **Unicode usernames.** Look-alikes and case folding on a public page.
- **A sidecar file of names beside `password.json`.** Two files to keep consistent, and no atomic set.
- **One file per account.** More files, more access lists, and no single atomic change.

## 12. Will catch

- An unknown name taking a different time or answer from a known one: the same single hash, with the same parameters, and the same body.
- A paused name or a global pause hashing anything.
- The typed username appearing in the audit log, a response or the Remote access screen.
- A read of the accounts writing anything, or `password.json` winning over `accounts.json`.
- A change, reset, remove or rename leaving that account signed in on a running panel, and `remote off` leaving an account behind.
- A query other than one valid `campaign=` hint being accepted at the root.
- The panel's module graph reaching the account writer.

## 13. Will not catch, deliberately

- **The global pause as denial of service.** Anyone who can reach the sign-in page can pause everyone's password sign-in for 15 minutes by making 50 wrong tries. This was accepted by the owner. The one-time link on the machine itself is never paused, and a restart clears the pause.
- **The public address, and whether the console is up.** The published link shows the address to every reader, and anyone can tell whether the console is running by whether the address answers. The docs recommend a Tailscale address over a public reverse-proxy name.
- **Shared-GM linkage between sites.** One panel serves several campaigns at the same address, so two published sites that link to it show that they share a GM.
- **The published campaign name.** The hint is the campaign's configuration name, so a reader of the site learns that name. It is not the campaign's title.
- **Hand-edited scrypt parameters.** A record edited by hand to other parameters would make the unknown path and that account take different times. The reader bounds the parameters, and a default install never has them.
- **An older program after migration.** A GM who runs the earlier release against a config folder that has been migrated finds `password.json` cleared, so that older program refuses remote sign-in. That is the safe failure.
- **The Firefox capture heuristic.** Firefox decides for itself whether to offer to save, and this design cannot force it (section 5). If it does not, that is a residual, not a defect we can fix here.
- **Two GM links on preview pages.** A preview page shows both the preview GM link and the published link.
- **A known username held in a pause.** Anyone who knows or guesses a username (the earlier single password is the account `gm`) can keep that one account paused by making five wrong tries every 15 minutes. Other accounts and the one-time link on the machine itself are unaffected, and a restart ends the pause. Per-username counting protects an account from strangers who do not know its name, not from someone who does.
- **A slow guesser, and a restart.** The lockout lives in memory, so a restart clears it, and a guesser who stays under five tries per name in any 10 minutes is never paused.

## 14. Verification

**Linux (accounts, sign-in, lockout, command line):**

- Tests first, with the red run recorded for each, then a mutation for every security rule: the unknown name returning before the hash, the dummy record with a cheaper cost, the pause checked after the hash, the global ceiling removed, failures counted only for real accounts, a success clearing the global count, no case folding, the typed name reaching the audit log, a read that writes, the older file winning, reset and remove not signing the account out, change skipping the current password, no cap, `remote off` leaving the file, the crawler header removed, the root accepting any query, and the session not storing its account. Each went red behaviourally.
- Sign-in over real sockets through the repository's test proxy, on free ports: two accounts, a paused name that does not block another, the global ceiling pausing everyone while the loopback token still works, exactly one hash on the known and unknown paths with equal parameters, and a command line reset or remove signing out exactly one account on a running panel.
- The packaged Linux binary adds an account with the password set in decomposed Unicode and signs in by username with the password typed in composed Unicode, through the test proxy, and answers a wrong password and an unknown name identically.
- Chromium and Firefox: the sign-in page's labels and autocomplete tokens, the failure state, what is and is not cleared, the hint forwarded only when it has the right shape, the Remote access accounts list, no violations from axe at 1280 and 390 wide and in forced colours.

**Windows:** C157 to C160 in `.agents/windows-verification.md`, all OPEN until a person confirms them on a real Windows machine: the account prompts in conhost and Windows Terminal, the access list on `accounts.json`, Edge through a proxy with two accounts (including the password manager), and a reset, `remote off` and an install from before accounts. The criteria for the published link are added with it.

**Pending (the published link):** the Linux and Windows evidence for sections 6 and 7's build side and the panel card.

**Owner acceptance (owner decision):** run by the owner against the owner's own infrastructure.

| Check | Status |
|---|---|
| From a phone, follow the "Game master" link on the real site, through Caddy and through Tailscale, to the console's sign-in page | OPEN (Pending, needs the published link) |
| Chrome and Firefox offer to save the login after sign-in, and fill it on the next visit | OPEN |
| A paused `rook` signing in from the phone does not block `gm` on the desktop | OPEN |

`accounts.json` gets its access list from the panel folder (ADR 0056).
