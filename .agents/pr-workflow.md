# Pull request workflow for AI assistants

This file is for an AI assistant working in this repository once it is public. It is the exact
flow for one slice of work. It sits on top of `.agents/working-rules.md` and `docs/DEVELOPING.md`.
How the public cut itself works is not covered here; see ADR 0031
(`docs/decisions/0031-public-repo-privacy-guard.md`) and the owner's cut runbook.

## The rules

- `main` changes only through a pull request. Never push to `main`, with or without force.
- Every pull request carries a written review in its body or a comment.
- Two checks must be green before merge: `test` and `hygiene` (from `.github/workflows/ci.yml`).
- Pull requests are squash merged. Merge commits are off.
- Pushing a branch, opening a pull request and merging are owner actions unless the owner has
  said so in their own words for this slice. An assistant never changes GitHub settings,
  rulesets or labels.

## Per-slice flow

1. **Branch.** Start from the latest `main`, one branch per slice, in its own worktree:
   `git fetch origin && git worktree add -b <slice-name> <path> origin/main`.
2. **Build and test.** Do the slice with tests first, as `.agents/working-rules.md` says. Run
   `npm test`, `npm run verify-generator`, and `node scripts/public-guard.js` before you commit,
   so `hygiene` cannot surprise you.
3. **Commit.** Conventional commits, small, one concern each. Add `Co-authored-by:` trailers
   for anyone sharing credit. Check for conflict markers first.
4. **Review.** A Reviewer assistant checks the branch and writes its report. Fix anything it
   finds on the branch, then have it re-check the changes.
5. **Open the pull request** (owner's go): `gh pr create --base main --head <branch> --title
   "<conventional title>" --body-file <reviewer-report.md>`. The Reviewer report is the body.
   The title becomes the squashed commit's subject, so write it as a conventional commit.
6. **Wait for CI.** `gh pr checks <number> --watch` with a timeout. Do not assume success from
   silence. Read any failure and fix it on the branch.
7. **Merge** (the orchestrator, after the owner's go): `gh pr merge <number> --squash`. Branches
   delete themselves on merge. No `--admin`, no `--merge`, no `--rebase`.
8. **Catch up.** Run `git pull --ff-only` on the shared checkout straight after the merge, before
   starting another slice.

## When `main` moves

If another pull request merges first, rebase your branch rather than merging `main` into it:

1. `git fetch origin && git rebase origin/main`.
2. Resolve conflicts, then `git rebase --continue`.
3. Re-run the gates. A clean rebase can still break a test.
4. Update the branch with `git push --force-with-lease` on your own branch only (owner's go). The
   ruleset blocks force pushes to `main`, not to your branch.
5. The Reviewer re-checks the changes since its last report and adds a note to the pull request.

A rebase is Engineer work. A Reviewer does not rebase.

## Windows criteria and bookkeeping

Both are updated inside the same pull request, never in a follow-up:

- If the slice adds or changes a Windows check, edit `.agents/windows-verification.md` in the
  branch. A result you could only prove on Linux stays open there. Say so in the review.
- If the slice moves a count, update `.agents/bookkeeping.md` and every place it lists.
- Windows findings that arrive after merge come back as a new slice and a new pull request.

## Private branches and the cut

Work that began on the private repository crosses over as patches with the owner's public
identity, as the cut runbook describes. Once crossed, it follows this flow like any other change.
Don't add the public repository as a remote to an old private clone.
