# 0041. Check runs on an edited copy of a vault file before it is saved

## Summary

Before the admin panel saves a change to your vault's settings note, it now runs the full check
against the edited copy, without writing anything to your vault first. It does this by telling
Scriptorium's single file-reading module to hand back the edited copy, for that one file only, for
the length of one check. The panel compares that check with one run on the file as it is now, and
shows you only what is new. A file that the check refuses outright, such as one whose opening line
asks for code to run, is refused however you answer the review.

Status: proposed.

## 1. The decision

Scriptorium already has exactly one module that every reader of vault file contents goes through
(`src/vault/read.js`; see its own header comment, and ADR 0033's chokepoint language). This change
adds one function to that module, `withCandidateFile(absPath, bytes, fn)`: for the exact length of
one synchronous call to `fn`, every one of that module's own content-reading functions, reading
a file's frontmatter, its whole text, its raw bytes, or a bounded head of it, serves `bytes`
instead of touching disk, but only when the path being read is an exact match for `absPath` (never
a prefix, a parent, or a case-folded near-match beyond what the real filesystem itself would fold).
Everything else about that same module keeps reading the real disk: walking the vault's file list,
listing a directory, checking whether a path exists, stat-ing it, or resolving its real path. A
candidate is not a file; it has no listing entry, no stat, and no identity of its own, and nothing
in this change pretends otherwise.

Only one candidate can be active at a time, and only the admin panel's own candidate-check module
opens one. Calling it again while one is already open, handing it something other than a buffer of
bytes, or handing it a function that turns out to be asynchronous, is treated as a programming
mistake and refused outright, loudly, rather than silently layering a second substitution on top of
the first. The overlay is always cleared again before the call returns, including when the
wrapped call throws, so a check that fails partway through can never leave a stale candidate
answering some later, unrelated read.

The function also counts, for its own single call, how many times the overlay actually answered a
read, and hands that count back to its caller alongside whatever the wrapped call returned. The
panel's candidate-check module treats a count of zero as its own self-check failing: if the check
it just ran never actually touched the edited copy, for any reason, the panel refuses to trust the
result rather than show you a review that might describe the file as it already is on disk, not the
edit you are about to make.

## 2. Why at the reading module

Every reader the check command uses already goes through this same module, because that is what
the module has meant since ADR 0033 first described it: the single, narrowest possible seam
between the rest of Scriptorium and the vault's own files. Putting the substitution there, rather
than inside the check command or inside any one of the checks it runs, means every current reader
of frontmatter, whole text, raw bytes or a bounded head is covered automatically, without the check
command needing to know which of its checks happen to read this particular file. It also means a
check added later, written by someone who has never heard of this decision, is covered the same
way, as long as it keeps reading through this module rather than reaching for the filesystem
directly, which is already the rule this module's own header comment states for every reader in
the project.

## 3. New findings and the "Save anyway" tick

The panel runs the check twice: once over the file as it actually is right now, and once over the
edited copy under the overlay above. It keeps only what the second run reports and the first did
not, counted properly, so a finding that would have appeared twice either way is not mistaken for
something new. That is the only thing a review ever shows you about the check: not everything
wrong with your vault, only what your own edit is about to add.

A new finding that only warns is shown, but does not stop a save. A new finding that is an error
needs an explicit tick, read in the same review, before a save can go ahead; without it, the save
is refused. But a small, fixed set of findings, the ones this project's frontmatter-language
guard already reports for a file whose opening line asks to run something other than plain
settings, or for a file gray-matter simply cannot parse at all, are never something a tick can
override, for this file or any other. The settings note's own two layers of protection against that
exact problem, described in their own decision (0034), apply to the edited copy exactly as they
apply to the file on disk: the candidate is still handed to the same fence check and the same
restricted parser, nothing about running it through the overlay first loosens either layer.

## 4. Rejected alternatives

- **Threading an override through every reader that might touch this file**, rather than through
  the one module they all already share. Six separate call sites would need to agree on the same
  override and stay in step with each other, and a reader added after this decision, by someone who
  never saw the brief that led to it, would read the real disk file instead and quietly break the
  guarantee this decision exists to provide.
- **Copying the whole vault to a scratch location for every review.** A GM's real campaign data,
  duplicated into a temporary location at the vault's own size, with every symlink inside it needing
  the same handling the real vault's own walk already gives them, just to change the contents of one
  file for the length of one check. The project's own test suite already uses exactly this approach
  as its test oracle for proving the overlay behaves identically to a real write, it remains that,
  rather than becoming the mechanism itself.
- **Patching the filesystem module directly**, so every read anywhere in the running process sees
  the edited copy. That reaches far wider than the one file a review is actually about, including
  the panel's own serving of other files while a review is open.
- **Running the generator itself against the edited copy.** The check command does not depend on
  the generator, and reaching for it here would pull in a dependency the check has never needed,
  for behaviour the check can already decide on its own.

## 5. Will catch

- Every current reader of this file's frontmatter, whole text, raw bytes or bounded head, for every
  check that reads any of them, seeing the edited copy exactly as if it had already been saved.
- Any new finding the edited copy introduces that the file as it stands today does not already have,
  counted correctly even when the same finding would otherwise appear more than once.
- The refusals that no tick can override, reported from the edited copy exactly as they would be
  reported from a real file after saving.
- The overlay's own self-check failing to see even one read reaching it, which stops the panel from
  trusting a result it cannot prove came from the candidate at all.

## 6. Will not catch, deliberately

- A link elsewhere in the vault that points at this same file. Nothing walks the vault a second time
  to find and redirect such a link; it still reads the file as it stands on disk.
- A future reader that reaches for the filesystem directly instead of going through this module.
  Nothing in this project's structure can force every future line of code through one seam; the
  module's own header comment states the rule, and a structural test already scans this module's own
  source for exactly the write calls it must never contain, but a reader elsewhere bypassing the
  module entirely is outside what either of those can see.
- An edit to some other note in the vault, made outside the panel, between a review finishing and a
  save actually happening. The review's own check result is reused for the exact edited copy it was
  run against; it does not re-read the rest of the vault a second time before the save goes ahead.
- Mounts that fold case beyond what Windows and macOS already do by themselves. The overlay's own
  path match folds case only the same way the rest of this module already does for those two
  platforms, and nothing wider than that.

## 7. Evidence

- `src/vault/read.js:51-118`, the overlay itself (`withCandidateFile`, `candidateFor`, `foldKey`),
  and the module-level comment recording why each of walkVault/listDir/pathExists/statPath/
  statOrNull/realPath/parseFrontmatterText is deliberately not consulted.
- `src/vault/read.js:172-212`, `385-461`, `readFrontmatter`, `readText`, `readBytes` and
  `readHead`, each checking `candidateFor` first and counting a hit before falling through to the
  real filesystem read.
- `src/admin/candidatecheck.js:102-116`, `runCandidateCheck`, which runs the check command itself
  inside the overlay and catches a throw from the check so the hit count is still available even
  when the check run fails outright.
- `src/admin/candidatecheck.js:128-188`, `runReview`, which opens the overlay twice (once for the
  publish-set comparison, once for the check), refuses to trust either result when its own hit count
  comes back at zero, and never writes anything anywhere.
- `src/admin/candidatecheck.js:24-25`, the two finding ids no tick can override.
- `docs/decisions/0034-executable-frontmatter-guard.md`, the two-layer guard the candidate still
  passes through unchanged.
- `docs/decisions/0033-vaultconfig-write-exception.md`, the chokepoint language this decision
  extends, and its own tail addendum describing the review this check feeds.
