# 0052. Adding a campaign from the panel

## Summary

A GM can now add another campaign from the running panel, on this computer or over remote access, with the same questions and the same checks as first-run setup. The setup page is served at a second address, `/campaigns/add`, and the panel's own address `#/campaigns/add` takes the GM there. First run and add share one check dispatcher, one set of answer rules and one commit pipeline per path; they differ only in a gate, which for an add is a fingerprint of the settings file plus a set of clash refusals that need no access to any other campaign's folders. The add is audited, and over remote access a typed path is only checked when the GM leaves the box, with that check audited too. After the add the panel offers to switch to the new campaign and build its first preview. The main alternative, reopening the setup routes after setup and for remote use, is rejected below because it would undo the rule that setup is local only. The limits a GM will meet are that the command line does not gain the clash refusals, that the welcome shows only in a browser on the computer itself, and that the same folder spelled two ways is not caught.

Status: accepted.

## 1. Where it lives

`GET /campaigns/add` serves the unchanged setup page, `setup.html`, with the same headers as every admin page. The page's script runs in add mode when its address is `/campaigns/add`, and in first-run mode otherwise. In add mode it asks the add routes in section 2 instead of the setup routes, commits to the add route, skips the redirect that first run does when setup is over, and draws a few things differently: a way back to the Campaigns screen, the campaign the panel is on, the clash refusals, the remote wording, and what happens after the add.

The panel reaches it from two controls, an Add a campaign button on the Campaigns screen and an Add a campaign link in the switcher. Both go to `#/campaigns/add`, and the panel turns that address into a replace of the page by `/campaigns/add`. It is a replace, not a navigation, so the Back button goes to where the GM was and never round again. The fragment is used because it rides on the panel's own address, which already has the locked and sign-in pages for a browser with no session.

The add route is campaign-bound like every audited change (ADR 0050 section 4), with no exemption. The add page therefore asks for `/api/session` before anything else, learns which campaign it was loaded for, and sends that name with every change it makes, the folder picker's create included.

## 2. The routes

Four routes, all in the campaigns handler, all needing a signed-in session, none refusing a remote request, and none answering while setup is active (the setup fence answers them with its fixed 409):

- `GET /campaigns/add`: the page above.
- `GET /api/campaigns/add/state`: the campaign the panel is on, the config path, the fingerprint (sha256) of the settings file, the registered names in config order, the default campaign, whether switching is possible and why not, how the request arrived, and the same themes, separator and new-vault facts that setup's state reports. A settings file that does not parse is a 409 with the loader's own message, and one that is missing says there is nothing to add to.
- `GET /api/campaigns/add/check`: one field check, with the same query, the same field list and the same answers as setup's check. A name, vault or output that clashes with a registered campaign comes back as a refusal with the rule line and a `clash` fact naming the kind and the other campaign.
- `POST /api/campaigns/add`: the commit. The body is setup's answers plus the fingerprint. It is audited by the router, and it adds one line of its own, section 6.

Setup's own routes are untouched. They stay loopback only and answer 409 once setup is over, so none of them could serve an add without undoing ADR 0028 section 1.

## 3. One pipeline for first run and add

The field list, the query parsing, the field dispatcher, the answer-shape rules and the state facts live in `src/setup/checks.js`, and both handlers call them. Neither keeps a copy, and a structure test counts the calls. Browser setup's answers are byte for byte what they were, which the existing setup tests prove without being edited.

`src/setup/register.js` keeps one pipeline for an existing vault and one for a new vault, each taking a gate. The gate is called twice. The early call runs before the first await. The late call runs after the last await, and from there to the writes everything is synchronous. First run's gate is the rule it always had: any registered campaign refuses the commit as taken. The add gate reads the settings file once, strictly, and compares its fingerprint with the one the page was given. A different fingerprint refuses the add as changed, a file that no longer parses refuses it as invalid, and at the late call a clash refuses it with the field and the rule. The sequence of writes is the same as first run: the new vault if there is one, the pack, one write of the settings file, then the welcome entry. Nothing is rolled back, and if a step fails after an earlier one succeeded the message says what was made.

Because the late call reads the file after the last probe, a campaign added from a terminal while a slow check waited is seen, and the add is refused as changed with the terminal's entry intact.

## 4. Refusals before anything is written

The clash rules compare paths as written in `config.toml`, never by looking at the disk, so a dead network share belonging to another campaign can never stall an add. Every registered campaign's vault and output are compared, and so is every `paths.<profile>` table's. Paths are compared after turning backslashes into slashes, lower-casing and dropping trailing separators, and one is taken to overlap another when it is equal to it or inside it. The rules, tried in this order with the first hit winning, refuse:

1. a name that is already registered;
2. a vault equal to another campaign's vault;
3. a vault that overlaps another campaign's output folder;
4. an output that overlaps another campaign's output folder;
5. an output that overlaps another campaign's vault.

The refusal's rule line is the exact sentence the server sends, with the other campaign's value printed as written in `config.toml` and the new values as the server resolved them. Rules 3 to 5 go beyond a plain duplicate check. A build replaces its whole output folder, and the build's own safety check only knows the campaign's own vault, so an output that is another campaign's vault would let a build swap that vault away. The existing refusals still hold: a settings file inside a vault, the panel's folder inside a vault, and an output inside the campaign's own vault.

## 5. The default campaign

The panel never changes the default. The add follows the same rule as `init`: an existing default stays, and when none is set the new campaign becomes it. The review says which, in words, before the GM presses Add, and the added screen says it again. Setting a different default is the Campaigns screen's job (ADR 0050 section 5).

## 6. Remote use and the audit

Adding works over remote access exactly as it does on this computer. The folder picker already works remotely (ADR 0049), and it is how a remote GM picks a folder. Three things are different for a remote session.

A typed vault, new vault or output path is not checked while the GM types, and not when the page asks for a check without committing. It is checked when the GM leaves the box, presses Continue or presses check it now. This reuses the rule browser setup already has for a network path, and it applies to every path in a remote session. Each committed remote check writes one `campaign-check` line to the audit log, holding the typed path, before the path is probed. If the line cannot be written, the answer is 503 and nothing is probed.

The commit writes one `campaign-add` line holding the typed vault path before anything runs, after the body has been checked and before the exclusive lock is taken. A remote add whose line cannot be written is refused 503 and nothing is created. The response line carries the new campaign's name as `affected`. A local check writes no line, as the picker's local listings write none. A local add writes its `campaign-add` line too, but is not refused when the line cannot be written, as for every other local change.

A remote session can learn things from these checks, and this record says so plainly. Any signed-in session can find out whether a readable path exists, whether it is a vault, whether it is empty, and, for a new vault into a folder that is not empty, what the folder holds. The picker already lists folder names remotely, so the new part is the finer detail and the fact that a typed path can be named directly. The defences are that remote checks wait for a deliberate commit, that each one is audited with its path before it runs, and that every probe goes through the shared bounded probe with its cap. A remote session can also create a vault anywhere the operating system user can write, and that is recorded with its path. That is the same trust the sign-in already gives a remote session over the panel's other writes.

## 7. Switching to it

After the add the page offers three actions: switch and build its first preview, switch, or stay. Switching uses the route that already exists (`POST /api/campaigns/switch`), so everything in ADR 0050 section 1 applies, including the bounded probes and the refusal in words when a folder does not answer. A failed switch leaves the add done and says so.

Switch and build keeps the page open. After its own successful switch the page calls `ScriptoriumAdmin.adopt` with the new name, which points the page's campaign header at the campaign it is now on. `adopt` refuses to do anything for a page that is already stale, and a structure test pins that it has one definition and one caller. Without it the next read would mark the page stale, because the panel has moved on. The page then runs the same check and preview screens as first run, and the requests carry the new campaign's header. Go to my panel opens the new campaign's Overview, where its welcome shows on this computer. Switch alone goes straight to the Overview. Stay goes back to the Campaigns screen.

If switching is off because the panel was started with `--vault`, both switch actions are off with the reason in words, and the add itself still works.

## 8. The command line

`init` and `config add` are unchanged. They do not gain the clash refusals, and `config add` of an existing name still replaces the entry. A test compares what the add route writes against `init --yes` and `init --yes --new-vault` on a twin config, for the pack files, the vault tree and the config entry. Nothing on the command line opens the panel at the add screen: launch mode accepts only `--config` and always lands on the Overview. A start-menu entry or a launcher target that opens the add screen belongs with the installer.

## 9. What this changes in earlier decisions

- ADR 0022 section 4, reads: request-named paths are now probed, bounded, outside setup mode and for remote sessions, by the add checks. ADR 0022 section 6, the write exception: the add route is a third panel write to `config.toml` on the same chain as setup's commit and ADR 0050's two writes.
- ADR 0028 section 1: the setup screens are served at a second address and the check dispatcher and commit pipeline are shared. The setup routes themselves, and their loopback rule, are unchanged.
- ADR 0050 section 10: the address it reserved for adding a campaign is now used, the add route is campaign-bound, and the page re-points itself with `adopt` after its own switch.

## Rejected alternatives

- **Add on this computer only.** Remote access is part of why several campaigns exist, and the picker already works remotely. The audit and the deferred checks are the price of allowing it.
- **The wizard inside the panel's frame.** The setup page has its own chrome and its own hash screens, so mounting it inside the frame would be a rewrite of the page for no gain.
- **Reopening the setup routes after setup and for remote use.** It breaks the rule that setup is local only and the tests that pin it.
- **A separate add pipeline.** A second pipeline would drift from first run's checks and writes. One pipeline with a gate cannot.
- **Reloading after the switch.** The first-preview screens would have to be rebuilt from browser storage. Re-pointing the page after its own switch is smaller and keeps the stale-tab guard.
- **Clash checks by real path.** They would stat other campaigns' folders, and a dead share would stall an add.
- **Updating an existing entry.** An add that finds the name taken refuses it. Changing a campaign's paths is later storage work.

## Will catch / Will not catch, deliberately

Will catch:

- a name, vault or output that clashes with a registered campaign, with no access to that campaign's folders;
- an add made from a page whose settings file has changed, by a terminal or another window, before the write, including during a slow probe;
- a remote add or a remote committed check whose audit line cannot be written, with nothing created or probed;
- an add from a tab the panel has moved on from;
- a first run that answers differently from before, since its tests are untouched.

Will not catch, deliberately:

- the same folder spelled two ways, such as a junction, a mapped drive against its network path, or an 8.3 short name, because the rules compare text;
- the title and theme checks reading a hand-named dead share synchronously, which a hand-made remote request could use to stall the panel;
- remote checks filling the shared probe cap, which slows other folder checks until it drains;
- the picker's refusal of a folder inside a vault not knowing a vault added during this run until the panel switches or restarts, because it reads the configuration as of the last switch;
- the welcome not showing in a remote browser, because it reads setup state that stays loopback only (ADR 0028 section 1);
- audit paths longer than 256 characters, which the audit log shortens;
- anything on Windows, until the criterion below has been run there.

## Windows verification

The Windows half (adding from the Campaigns screen with a vault chosen on a mapped drive, the parity with `init --yes`, each clash refusal leaving the settings file unchanged, a new vault in a missing folder, a terminal add during the review, a remote add and its audit lines, and no preview folders left behind) is verified only from the real exe. It is OPEN: `.agents/windows-verification.md` C140. The Linux tests prove the sequence of the writes, the gate and the audit lines, not how Windows treats a mapped drive or a held file.
