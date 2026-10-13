# 0056. An owner-only access list on the panel folder on Windows

## Summary

On Windows the `panel` folder used to take whatever access list its parent handed down, so a config kept outside the user profile could leave the accounts file, the session digests and the audit log readable by other people signed in to the same PC. GM-Scriptorium now sets the folder's access list itself, on every panel start and before any `remote` command writes there: your account, SYSTEM and Administrators, passed down to everything inside. It does this by running `%SystemRoot%\System32\icacls.exe` through the one process spawner ([ADR 0046](0046-one-process-spawner.md)), by full path, never by looking `icacls` up on `PATH`. The main alternative, adding `icacls` to the spawner's ordinary program list, is rejected because that list is resolved through `PATH`, so a planted copy could run. The limit a GM will meet is that a config folder on a drive without access lists (FAT, exFAT) or on a share that refuses the change can run only local mode on Windows, because the remote modes refuse to start there.

Status: accepted. Amends [ADR 0029](0029-remote-access.md), [ADR 0046](0046-one-process-spawner.md) and [ADR 0054](0054-gm-access-from-the-player-site.md).

## 1. The decision

### The invocation

One call, with these arguments in this order:

```
icacls <panel folder> /inheritance:r /grant:r <DOMAIN\user>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /Q
```

- `/inheritance:r` removes the entries the folder inherited from its parent.
- `/grant:r` grants the three principals full control, passed down to every file and folder created inside (`(OI)(CI)`). `*S-1-5-18` is SYSTEM and `*S-1-5-32-544` is Administrators, both by well-known identifier, so the result does not depend on the language of Windows.
- The files inside inherit the result, so it covers every current and future file, including `accounts.json`, `sessions.json`, `audit.log`, `welcome.json` and `launch-<pid>.html`.

The wording matters: this **removes the inherited entries and grants the three**. It does not remove an explicit entry that is already on the folder or on a file in it. Section 4 says what that leaves.

### The owner principal

The account is `USERDOMAIN\USERNAME` from the environment of the running program, which the caller passes in (the remote code never reads the process environment itself). Each part must be 1 to 256 characters and hold none of `\ / : * ? " < > | [ ] ; = , +` or a control character. Otherwise the step fails with "the account name could not be read" and `icacls` is never run.

### When it runs

- **On every panel start** (`serve --admin` and launch mode), after the readiness checks and before the session store, the audit log or any listener. It runs every time, not only when the folder is new, so a loose folder from an older build is tightened.
- **In the `remote` command**, immediately before the first write into the panel folder, after any prompt and password hashing, so a cancelled prompt creates nothing. `remote show` and `remote account list` never run it and never change the folder.
- **Never inside a campaign vault.** The caller works out whether the folder is inside one; if it is, the step does nothing and the existing refusal stands.
- **Not on Linux or macOS.** The step does nothing there; the folder is `0700` and the files `0600` from creation, as before.

### When it fails

The reasons come from a closed set: `the account name could not be read`, `the folder could not be prepared (<code>)`, `icacls could not be run (<code>)`, `icacls timed out` and `icacls exited <n>`. An unforeseen failure inside the step is reported as `icacls could not be run (unknown)`, so the step never rejects.

- **Every remote mode (ssh, tailscale, proxy, direct)** refuses to start, before any listener, with one `ConfigError` and exit 1: `remote access (mode <mode>) needs <panel> limited to your account, SYSTEM and Administrators, and that could not be done (<reason>); nothing was started`.
- **Local and setup mode** start, print one warning line before the first listener, and the Remote access screen's File permissions row lists the panel folder.
- **The `remote` command is split by what it writes.**
  - `remote password` and `remote account add`, `change` and `reset` save a password hash. When the list cannot be set they refuse (exit 1) before any panel write: `remote access needs <panel> limited to your account, SYSTEM and Administrators before a password is saved there, and that could not be done (<reason>); no password was saved`. No `accounts.json` or `password.json` is created or changed and no audit line is written.
  - `remote account remove` and `rename`, `remote signout-all`, `remote off` and `remote set` warn and carry on (exit 0, the warning is the last line). They write no new secret, and `off` must keep working because it is the way out.

## 2. Rejected alternatives

- **Add `icacls` to the spawner's ordinary program list.** That list is resolved through `PATH`, so a planted `icacls` earlier on `PATH` would run, and it would edit the pinned list. Instead there is a second list, `SYSTEM_COMMANDS`, holding `icacls` only, run only on Windows and only as `<SystemRoot>\System32\icacls.exe`.
- **PowerShell `Set-Acl`.** A script host is a far bigger thing to allow than one named system tool.
- **`spawnSync` or `execFile` outside the spawner.** The rule that only the spawner starts a program stands, and these block the event loop.
- **A native addon or an npm package.** A new dependency for one call, and the project takes none.
- **Remove named broad groups instead of replacing inheritance.** Any other named user or group would survive.
- **Apply inside `ensurePrivateDir`, or in each writer.** `ensurePrivateDir` is synchronous and the spawner is asynchronous only, and the writers are five call sites. One step at the two entry points is simpler to prove.
- **A bare `os.userInfo().username`, or running `whoami`.** The first can resolve to a different account of the same name; the second is a second program to run.
- **The `remote` command refuses everything on failure.** It would block `remote off`, the way out.
- **The `remote` command warns on every write, secret writes included.** The password hash would be written into a folder that others can read. A secret written into a loose folder is unusable remotely, because non-local start refuses, but the hash itself would be exposed.

## 3. Will not catch, deliberately

- An explicit entry someone adds by hand on the panel folder is kept; only inherited entries are removed on the next start or `remote` write.
- A file whose inheritance someone switched off.
- Explicit entries on the folder or on its files. Only the owner or an administrator can add one.
- The owner as named by `USERDOMAIN\USERNAME` of the running process. If that names a different account than the one that created the folder, the grant goes to the named one.
- The config folder's `backups` and `panel-prefs.json`, which are not in `panel`.
- `tls`, which is not written yet. The folder for certificates must reuse this step (`applyPanelAccess`).
- In local or launch mode with a failed list, `launch-<pid>.html` holds a one-time launch code that other local accounts can read until it is used. That is the same as before this change, and it is why the console and the Remote access screen warn.
- How Windows treats the result. The Linux tests prove the text handed to the spawner and the sequence of the steps, not what `icacls` does with it. That is checked only in the real executable.

## 4. Windows verification

C180 to C183 in `.agents/windows-verification.md`, plus a re-run of C70 and C158 with this build, all OPEN until a person confirms them on a real Windows machine.
