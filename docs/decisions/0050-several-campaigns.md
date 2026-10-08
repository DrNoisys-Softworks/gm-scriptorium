# 0050. Several campaigns in one panel

## Summary

One running panel can now work with every campaign in `config.toml`. A GM can switch between registered campaigns, set the default and remove a campaign from the list, and all three work over remote access and are audited. A switch re-resolves the one shared context after a bounded check that the target's folders answer, so a dead network share fails with a plain message in a few seconds instead of freezing the panel. Removing a campaign only takes it off the list; the vault, pack, output and backups stay where they are. The main alternative, choosing the campaign on every request, is rejected below because it would change every handler and every cache. The limits a GM will meet are that a panel started with `--vault` cannot switch, that the active campaign cannot be removed, and that a tab left open across a switch is told to reload before it can change anything.

Status: accepted.

## 1. Switching re-resolves the one context

ADR 0022 section 5 said the campaign context is resolved once and fixed. That becomes: resolved at launch, at the setup handover, or at a switch. The ports, the token, the cookies, the remote settings, the sessions and the audit log do not change, because they hang off the config folder and not off a campaign.

A switch runs under the same exclusive lock as a build or a save, so if anything is running it is refused with a busy answer. Inside the lock the steps run in a fixed sequence:

1. The config is read and the target campaign resolved to its paths. This reads `config.toml` only and never touches a vault.
2. Each path the resolver is about to look at is probed, one at a time, with the bounded probe that browser setup uses (ADR 0028 section 3): the vault, its `_meta/vault-config.md`, and the pack and site config when the campaign names them. A campaign with no vault skips the probes, because the resolver refuses it without touching the disk.
3. An answer of "timed out", "could not be read" or "the probe cap is full" refuses the switch with a fixed sentence that names the campaign, the path and the campaign the panel stayed on. "Exists" and "missing" carry on, because the resolver has its own words for a missing folder.
4. From here everything is synchronous. The same resolver the setup handover uses runs, then the context is built. If the resolver throws, its message is shown word for word and nothing on the context has changed.
5. If the vault path the resolver found is not the one the first read found, the config changed while the probes waited, and the switch is refused as changed.
6. If another change request is still waiting on its body (section 4), the switch is refused as busy.
7. Otherwise the context's campaign fields are replaced in one synchronous step.

Because the resolver reads the disk synchronously, calling it before the probes would stall the whole process on a dead share. That sequence is pinned by a test that hangs the probe on a vault that is not on disk.

## 2. What belongs to a campaign

`src/admin/campaignstate.js` is a pure module that classifies every field of the context. There are four lists:

- **Resolved:** the eight fields the setup handover already copies (campaign, paths, writable flag and read-only reason). They come from the fresh resolve.
- **Kept:** the preview folder and its freshness stamp and page list, the variant copies, and the count of saves made in the panel. They are stashed under the campaign's name when the panel leaves it and restored when the panel returns.
- **Reset:** the cached vault art listing and the vault-config review. They are rebuilt from the vault on demand and are deleted on every switch. They are deleted, never set to null, because the code that reads them tests for "not there".
- **Process:** the token, the ports, the busy label, the remote access state, the sessions, the audit log, the lockout and ticket stores, the clock, the sign-in guards, the launch codes, the setup state and the campaigns bookkeeping itself.

A campaign that has no stash gets exactly what a brand-new context has: no preview folder and nothing else set. `src/admin/context.js` and its frozen test are not edited. Instead a test reads the source of the admin code and the two command modules that add fields, collects every `ctx.<name>` it finds, and fails unless the set equals the union of the four lists, so a new field cannot be added without choosing a list. The same test seeds every per-campaign field with a recognisable value, switches, and checks that nothing of the first campaign is on the second.

## 3. Previews

There is still one preview listener on one port, because remote access fixes its ports. Each campaign has its own temporary root, created lazily the first time that campaign builds a preview. After a switch the listener serves the new campaign's root or says that no preview has been built yet, and never the previous campaign's pages. Switching back shows that campaign's last preview from this run. Variant copies live under the same root, so they follow it.

The stash records the vault path it was made for. If the campaign now resolves to a different vault when the panel returns, the stash is dropped and its root removed, so one vault's preview is never shown under another vault's name. Removing a campaign from the list drops its stash and root. Stopping the panel removes the current root and every stashed root.

## 4. Stale tabs

A tab that was loaded for one campaign must not change another. Every change request (every audited POST except the setup commit, which has no campaign yet) carries a header naming the campaign the page was loaded for. The router checks it after the setup fence and before anything runs. A header that does not match, or that cannot be decoded, is answered 409 `campaign-changed`, and nothing is written, built or checked. The panel's page shows "This tab was showing X. The panel is now on Y. Reload to continue." and stops sending changes.

A request with no header is accepted until the first switch of this process and refused after it. A stale tab can only exist after a switch, so before the first one every tab was loaded for the only campaign this process has served. Refusing a missing header from the first request would add the header to every existing test for a check that guards consistency, not access.

A request that passes the check may still wait for its body while a switch completes. A counter closes that gap: a passing request is counted from the check until it finishes (released in a `finally`), and a switch is refused as busy while another counted request is in flight.

## 5. Writes to config.toml

Set as default and remove from GM-Scriptorium are two more functions on the registration chain of ADR 0028 section 2. `src/setup/register.js` stays the only panel-side module that requires `src/config/write.js`. A second handler module, `src/admin/handlers/campaigns.js`, now requires `register.js` alongside `src/admin/handlers/setup.js`. Later storage work that needs to change a campaign's paths extends this same chain and does not add a second one.

Each write carries the sha256 of the `config.toml` the page loaded. The handler reads its body first, then inside a synchronous section it reads the file once, takes the sha256 of those bytes and parses the same bytes, compares the sha, and writes. A mismatch is refused 409 "Your settings changed outside the panel. Reload and try again." and nothing is written. The parse mirrors the command line: lenient for remove, so a malformed entry can still be removed, strict for set as default, then the same migration. The bytes written are the same as `config remove` and `config set-default` produce, which a test compares against the command on a twin config.

The active campaign cannot be removed, so the panel is never left with no campaign; the command line can still remove anything. Removing also drops the name from the Overview welcome list, and a failure there never undoes the removal. Both writes run under the exclusive lock, so they are refused while a build or a switch runs, which also stops a remove of the campaign a switch is probing.

## 6. Crash-safe config writes

`writeConfigFile` now writes the canonical text to a temp file in the config's own folder, flushes it, and renames it over the config. This is for every caller, including the command line, so a crash or a full disk leaves the old file whole. The text is the same, a symlinked config stays a link (the real path is the target), and an existing file's mode is kept. On a sharing violation (EPERM, EBUSY or EACCES, which Windows reports while another program holds the file) the rename is retried up to five times with growing waits, about three seconds in all, then the original error is thrown, the temp file is removed and the old config is untouched.

The residual from the emitter remains: comments a GM added to `config.toml` are still dropped on every rewrite, as the command line has always done.

## 7. Audit

The request line keeps the campaign the request found. The response line names the campaign active after the handler, so a switch records request A and response B. Set as default and remove add one more field to the response line, `affected`, holding the name of the campaign changed. It is the only value a handler hands back to the audit log, through a small note object the router passes in. The audit log rebuilds each entry from a fixed key list, so `affected` is appended to that list, and a test pins that no other field is ever handed back.

## 8. Remote access

Switch, set as default and remove work for a signed-in remote session as they do on this computer. They are audited, and if the audit log cannot be written a remote request is refused 503 before the handler runs, exactly as for every other change.

## 9. Started with --vault

`--vault` overrides the folder of the launched campaign only (ADR 0022 section 3). A panel started that way refuses to switch, with the reason "This panel was started with --vault, which changes the folder for "<name>" only, so switching campaigns is off. Restart without --vault to switch.", with the launched campaign's name in place of the placeholder, because a switch would silently drop the override. Set as default and remove stay available.

## Rejected alternatives

- **Choose the campaign on every request.** Every handler closes over one context, so this would change every handler, every cache and the preview listener, which has no campaign in its address. It would also let two tabs drive two campaigns at once through one lock.
- **One preview listener per campaign.** Remote access uses fixed ports, so a second listener per campaign has nowhere to go.
- **The panel updating an existing entry.** Set as default and remove only ever change `default_campaign` or delete an entry. Changing a campaign's paths is later storage work.
- **A separate config-write module for the panel.** Two chains to the config writer would each need their own fence tests. One chain, extended, is easier to audit.
- **Refusing a request with no header from the first request.** See section 4.
- **Dropping previews on a switch.** It would throw away a build the GM may be about to look at again.
- **Letting the active campaign be removed.** The panel would be left with a context for a campaign that is no longer registered.

## Will catch / Will not catch, deliberately

Will catch:

- a tab that was loaded for one campaign trying to save, build or check while the panel is on another, including one whose request was already waiting on its body when the switch started;
- a switch to a campaign on an unreachable share, which answers within the probe bound while the rest of the panel keeps answering, and leaves the active campaign as it was;
- a second change to `config.toml` made outside the panel after the page loaded, from a terminal or another window, including one made while the request body was still arriving;
- one campaign's preview, variants, saved-count or cached listings appearing under another;
- a new context field that has not been classified;
- a crash or full disk half way through a config write.

Will not catch, deliberately:

- a `pack` or `site_config` on another dead share beyond the per-path bound, since only the four paths named in section 1 are probed;
- a `config.toml` that is itself on a slow share, because it is read synchronously;
- a read in flight during a switch, which finishes against whichever campaign it started with;
- a stalled upload, which holds a switch off as busy until it ends;
- a tab from an older version of the panel left open across an upgrade, which sends no header;
- comments in `config.toml`, which every rewrite still drops;
- anything on Windows, until the criterion below has been run there.

## Windows verification

The Windows half (switching between a local campaign and one on a mapped drive, a disconnected share failing within the bound, a remove leaving every file where it was, a refused write when a terminal changed the config, the rename retry when another program holds the file, and no preview folders left behind) is verified only from the real exe. It is OPEN: `.agents/windows-verification.md` C139. The Linux tests prove the sequence of the calls and the shape of the retry, not how Windows treats a held file or a dropped share.
