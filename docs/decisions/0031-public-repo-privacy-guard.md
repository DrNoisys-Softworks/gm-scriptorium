# 0031. Privacy guard for the public repository

## Summary

This repository is now public, so every push, every pull request and every release runs through a
tracked guard before anything is accepted. One part of the guard looks for generic signs of
private data, a personal home-directory path, a private network address, a personal email address,
and runs for anyone, with no setup. The other part compares a change against the maintainers' own
private word lists (real campaign and player detail) kept outside the repository entirely, and
only runs for a maintainer who has those lists installed. Both parts also confirm the repository's
history still starts at this repository's own first commit, and refuse a small set of paths that
should never be pushed here at all. The main limit to know about: a word the maintainers have
deliberately allowed through becomes invisible to the check everywhere it appears, and a
contributor's own commit identity is only checked right before a release, not on every push.

## The problem

Everything in this repository is now visible to anyone, forever, including its full history. A
contributor could accidentally commit a private path, a stray IP address, or a personal email
address, and nobody would notice until it was already public. Separately, the maintainers' own
planning notes mention real campaign and player detail that must never appear here at all, but
checking for that needs a private word list that can't live in a public repository either.

An earlier version of this idea loaded its private lists however each caller happened to set them
up, usually through environment variables set by hand before running a check. That meant a caller
who forgot to set one, or set it the wrong way, would get a check that silently ran with fewer
lists than it should have, and nothing said so. One class of check in particular, catching a
maintainer's own name or email address in a commit, only works when one specific list is loaded;
without it, that commit would look perfectly clean.

## Decision

One guard script owns every privacy check in this repository, and it is the only thing that
decides which private lists load, from where, and when. A caller never sets a list by hand: the
maintainers' own lists live in one fixed, absolute folder outside the repository, named once in
local git configuration, and the guard reads them from fixed file names inside that folder. Any
leftover environment variable from the old approach is ignored and counted, not honoured.

The guard runs in four ways: a check installed as a pre-push hook on a contributor's own machine,
a check that runs in continuous integration on every push and pull request, a check a maintainer
runs before cutting a release, and a check of the maintainers' own allow-list, used to catch a
broken entry in it before it quietly stops working.

## Rejected alternatives

- **A separate script for continuous integration.** Two scripts means two places deciding how to
  check the repository's root commit, and they would drift apart over time.
- **Baking the private-list rule into the underlying pattern scanner.** The scanner has to stay
  usable on its own, with its own tests, and those tests need to be free to load whatever lists
  they like for their own purposes.
- **A flag to choose which private lists load.** A caller can forget a flag, or pass the wrong
  path, which is exactly the failure this guard exists to remove.
- **Signing the private lists so continuous integration could check them.** The lists never leave
  a maintainer's own machine, including in continuous integration, so there is nothing for an
  automated check to verify a signature against.
- **Pointing the git hook setting at a path inside the repository.** An untrusted clone could ship
  its own copy of that path and quietly redirect the hook to something else.

## Pinned binary residuals

A handful of files are allowed to trip the generic pattern check without being treated as a leak,
because their exact bytes are already pinned somewhere else in this repository. The bundled font
files are checked against the theme's own font manifest. A sample image, once the sample campaign
ships, is checked against its own manifest plus a basic check that the bytes really are an image.
The vendored copy of the upstream generator's release archive is checked against that release's
own checksum file, read fresh at the exact commit being scanned rather than trusted from an
earlier check. None of these needs a change to the guard itself when the pinned file changes: the
vendored archive's checksum file already updates alongside the archive, and a font or image swap
updates its own manifest at the same time. Compressed file formats like these can coincidentally
contain byte sequences that happen to match a generic pattern or a private word, and pinning the
exact, already-verified bytes is what lets the guard treat that coincidence as expected rather than
asking a human to re-approve the same unreadable binary over and over. A changed file, or one that
doesn't match its pin exactly, is scanned like anything else.

## A relative check during development

While a change is still accumulating pre-existing matches that haven't been reviewed yet, a
maintainer can ask the guard to compare the change against a starting point and report only what's
new, rather than the repository's entire backlog of matches every time. A push, a pull request and
a release never use that shortcut: those always check everything, every time.

## Will catch

- A maintainer's own name or email address appearing in a commit's author or committer line,
  anywhere in this repository's history. The one exception is the ten already-public commits in
  "Amendment: ten commits that are already public".
- A path under a private planning folder, or a maintainer's personal settings file, in any pushed
  change.
- A personal home-directory path, a private network address, or a personal email address, in any
  tracked file, for any contributor, with no setup required.
- A real campaign or player detail from the maintainers' own private word lists, in any pushed
  change or release, for a maintainer who has those lists installed.

## Will not catch, deliberately

- **A word the maintainers have allowed through once is invisible to every check, everywhere it
  appears, from then on.** Allowing a word through is a narrow, considered exception, never a
  default reach.
- **A contributor's own commit identity is only checked right before a release, not on every push
  or pull request.** Most contributions are reviewed and merged long before a release happens, so
  checking identity that early would be checking commits that are still going to be rewritten.
- **Text inside a signed commit's own signature block can coincidentally look like a private
  word.** These always count as something a human has to look at, and the guard always stops
  rather than waving them through on a guess.
- **Text inside the compressed bytes of a bundled font, a bundled image, or the vendored generator
  archive is outside what either part of the guard can read**, since neither one looks inside
  compressed data. A changed file still goes through the ordinary check.
- **Nothing from before this guard existed is re-checked automatically.** It relies on a one-time
  pass over the repository's existing history, made before the repository went public.

## Evidence

- `scripts/public-guard.js`
- `scripts/denylist-scan.js`
- `scripts/hooks/pre-push`
- `scripts/public-hygiene-patterns.txt`
- `test/public-guard.test.js`
- `test/public-guard-path-allow.test.js`

## Amendment: excusing exact files from private-word hits

**What changed.** The maintainers' private allowlist could only excuse a word everywhere. It can
now also excuse one exact committed file, with a line of the form `path <repo-relative file> --
<reason>`. The lower-level scanner already understood this line; the guard's own check of the
allowlist used to refuse it, and now accepts it under the rules below.

**Why.** A few files are copied unchanged from the upstream starter vault and legitimately
contain words the private lists flag. Excusing those files one at a time leaves every word fully
guarded everywhere else, which weakening a word would not. The owner approved this in his own
words ("For (A) that's fine").

**The limits.**

- The target must be an exact repo-relative file path. Globs, directories, `..` or `.` segments,
  absolute paths, drive letters, backslashes, control characters, empty segments and an empty target are refused,
  and the guard stops with `bad-allow` and the line number of the offending entry.
- A reason is always required. A line without one is refused as a malformed list.
- An entry excuses every hit in that one file, its path text included, in every commit of a
  range and for any future content of that path. An excused file must therefore stay
  byte-identical to its upstream source: if it changes, nothing flags it. No other file is
  excused. Matching is exact string equality with no normalisation, so the same name in another
  folder, a longer name that starts or ends the same way, or a differently-encoded spelling of
  the same-looking name (for example the decomposed form of an accented letter) is still
  checked.
- An entry that matched nothing in what was scanned (the file is absent, the path is a
  directory, or it lies outside the revision or pathspec scanned) is reported as `UNUSED` with
  its line number, never silently ignored.
- Commit messages and every other non-file target are never excused by a path entry.
- Where it applies: `scan tree`, `scan commits`, `pre-push` and `release` see repo-relative
  paths, so entries apply there (in the commit modes they cover that file in each commit of the
  range). `scan files` only knows a bare file name, which cannot prove which repository file it
  is, so path entries never apply there and show as `UNUSED`. `ci` has no private lists and is
  unchanged.
- Word entries behave exactly as before, and nothing here weakens any word.

## Amendment: a push with nothing new to scan

**What changed.** The pre-push check used to stop with `ERROR empty-range` when a push added no
commits, for example a release tag on a commit GitHub already has, or a branch push that is
already up to date. It now looks at what each pushed ref adds. If every commit the ref points at
is already on the remote, there is nothing new to scan, so the check prints
`NOTE nothing new to scan` and carries on. The other checks (the public hygiene checks and the
history check) still run on that ref.

**What did not change.**

- `scan commits <range>` still ends with `ERROR empty-range` when the range holds no commits. There
  an empty range usually means a typo, and silence would hide it.
- A range that should hold commits but cannot be read still fails closed. This covers a remote
  commit the local repository does not know, a missing object, and any git error. The pre-push
  check ends with `ERROR unreadable-range` and exit code 2.
- A new branch whose commits the remote lacks is scanned in full, as before.
- A deleted ref (all-zero local id) is skipped, as before.

**Rejected alternative.** Treating every empty set as "nothing to scan", in both the pre-push check
and `scan commits`. That would also let a mistyped range or a git failure pass without a word.

## Amendment: file names that hold a newline

**What changed.** A committed file whose name held a newline could make the check pass when it
should have blocked. The scanner printed that file's hit on two lines, the guard could not read the
second half back as a hit, and the scan ended with a pass. The check now fails closed in three
ways:

- Every list of paths the guard and the scanner read from git is NUL-separated (`-z`), so a path
  arrives whole whatever characters it holds. This covers the tree, commit and working-copy scans
  and the forbidden-path check that `ci`, `pre-push` and `release` run.
- The scanner prints a path with control characters (newline, carriage return, escape, the other
  control codes, and the Unicode line and paragraph separators) as a visible escape such as `\x0a`,
  so a name can never split a report row. Matching still uses the real path.
- The guard compares the scanner's own total with the hits it could read back. If they differ, it
  adds one hit that nothing can excuse, so the scan blocks.

**Limits.** An allowlist `path` entry still cannot name a path with a control character (those are
refused when the list loads), so such a file is never excused. A file name that holds a private
word is reported with that word masked, as before. The escaped spelling in a report is for reading
only; it is not a form you can put in the allow file.

## Amendment: a push after merging main scans only what is new

**What changed.** The pre-push check used to scan the range from the remote's old tip of the pushed
branch to the local tip. After a branch merged main, that range also held commits already on main,
which are public. A private-list hit in one of those commits blocked every such push, although
re-scanning them could not prevent anything. The check now scans only the commits that the old
remote tip does not reach and that no remote-tracking ref of the remote being pushed to reaches
(`git rev-list <local> --not <old remote tip> <ids of refs/remotes/<remote>/*>`). A new branch already worked
this way.

**What did not change.**

- Commits the remote lacks are scanned in full: messages, trees and diffs.
- It fails closed. If the remote-tracking refs are missing or stale, the commits that depended on
  them are simply scanned. A remote commit this repository does not know still ends with
  `ERROR unreadable-range`.
- Only refs of the remote named in the push count. They are listed exactly, never matched as a pattern, so a path or URL given as the remote (even one named `*`) excludes nothing. A commit that is public on a different remote is
  still scanned.
- The tree at the pushed revision is still scanned in full.

**Rejected alternative.** Skipping the scan when the branch has any upstream. That would also skip
commits that really are new.

## Amendment: ten commits that are already public

**What changed.** Ten earlier commits that GitHub created when merging pull requests carry an identity the private lists flag, in their author line. The guard now accepts that one kind of hit on those ten commits only, each named in the guard by its full commit hash. It reports them on their own line, `RESIDUAL known-public-identity=<hits> commits=<n>`, next to the identity line, which still counts every identity hit.

**Why.** These commits are already public, and rewriting published history would break every existing clone and fork. GitHub creates a merge commit on its own servers, so no pre-push hook ever sees it, and continuous integration has no private lists. The release check is the only place these commits are seen. Without this exception, every release whose range includes them would block on hits nobody can now fix.

**The limits.**

- A commit is accepted only when its full 40-character hash is in the list. A short hash or a prefix never matches.
- Only name and email hits on the author and committer lines are accepted. A name in the message body or in a trailer such as `Co-authored-by:`, or any other private word anywhere in the commit, still blocks.
- It applies only in this repository's public history. A private history uses the ordinary identity rule, as before.
- The list grows only by a maintainer decision made at a release and written down with it. A new commit with the same problem blocks the release, exactly as before.
- A malformed entry (not 40 lowercase hex characters, or a repeat) stops the guard with `ERROR bad-residual kind=identity` and the entry's position, never its value, before anything is scanned.

**Rejected alternatives.**

- Allowing the flagged identity through everywhere. That would hide it in every file and every commit from then on, not only in these ten.
- A general rule accepting identity-only hits on any commit GitHub creates. Those are exactly the commits no hook sees, so the rule would hide the first thing this guard is meant to catch, on every future merge.
