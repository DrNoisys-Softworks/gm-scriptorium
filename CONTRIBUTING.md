# Contributing

This page is for anyone who wants to propose a change. The developer guide,
[`docs/DEVELOPING.md`](docs/DEVELOPING.md), covers what never to edit, the checks a change must
pass, and how releases are made. If you work with an AI coding assistant, point it at
[`AGENTS.md`](AGENTS.md).

The detail about the upstream generator lives in
[`docs/COLLABORATING.md`](docs/COLLABORATING.md). Read it before
touching anything under `src/generator/`, `src/build/`, `src/vault/publishset.js`,
`src/cli/check.js`, or `vendor/gm-apprentice-publish/`. The short version:

- No real campaign, player, character or personal names in repo text, test
  fixtures or commit messages. Use neutral, made-up example names instead.
- Keep `main` green: run `npm test` and `npm run verify-generator` before
  proposing a change.
- Every change reaches `main` through a pull request. See "How to open a pull
  request" below.
- Releases, tags, version bumps and deploys are the owner's.
- Contributions are accepted under this repository's MIT licence (see
  [`LICENSE`](LICENSE)).
- Two CI checks run on every push to `main` and every pull request. They look for private file
  paths, private IP addresses, personal email addresses and files that must
  never be committed, and checks that the history starts at this
  repository's first commit.
- Maintainers also scan every push and release against private word lists
  that never enter this repository.
- To run the same public checks before you push, copy
  `scripts/hooks/pre-push` to `.git/hooks/pre-push`. The hook is tested on
  Linux. A push that adds no commits, such as a tag on a commit the remote already has, passes with
  a note that there is nothing new to scan.

## How to open a pull request

1. Fork the repository, or ask the owner for access. Create a branch from the
   latest `main`. Name it for the change, for example `fix-toc-focus`.
2. Make one change per branch. Keep commits small and use conventional
   commit messages such as `fix(a11y): ...` or `docs: ...`.
3. Run `npm test` and `npm run verify-generator` on your machine first.
4. Open a pull request against `main`. Fill in the template. Say what changed,
   why, and how you checked it.
5. Add a written review to the pull request, in the description or a
   comment (see "The review expectation" below).
6. Wait for both CI checks to go green, then answer any review comments. A
   maintainer merges it.

Nobody pushes directly to `main`, including the owner. Pull requests are
squash merged, so `main` stays a straight line with one commit per change.
Merge commits are turned off. If more than one person worked on the change,
add a `Co-authored-by:` line for each of them at the end of the pull request
description, so the squashed commit credits everyone.

If `main` moves while your pull request is open, rebase your branch on it and
push again. Don't merge `main` into your branch.

## What CI checks

| Check | What it does |
|---|---|
| `test` | Installs dependencies, runs `npm test` and runs `npm run verify-generator`. |
| `hygiene` | Runs the public privacy check over the whole history. It looks for private paths, private IP addresses, personal email addresses and files that must never be committed. |

Both must pass before a pull request can merge. The checks use no secrets, so
they skip in a fork's own Actions tab, so a fork shows no checks there. The checks run when you open the pull request against this repository, and the result appears on the pull request.

## The review expectation

Every pull request carries a written review before it merges. The review is a
short note saying what was looked at, what was run and what was found. It can
come from a human reviewer or from an AI reviewer's report. The owner is
currently the only maintainer and cannot approve their own pull requests, so
GitHub does not require an approval click. The written review is the
requirement instead. Unresolved review threads block the merge.

## Issue labels

| Label | Use it for |
|---|---|
| `bug` | Something does not work as described. |
| `leak-class` | A bug that could expose hidden or private campaign content on the player site. These come first. |
| `a11y` | Accessibility problems. |
| `windows`, `macos` | Problems that only show on that system. |
| `upstream` | Anything that tracks a change in the upstream generator. |
| `security` | Security reports that are safe to discuss in public. For anything sensitive, follow [`SECURITY.md`](SECURITY.md) instead. |
| `docs` | Documentation changes. |
| `good first issue` | A small, well-described task for a new contributor. |

Issues are grouped into milestones, one per release, and tracked on a project
board.

`#N` issue numbers that appear in older docs and ADRs refer to the private
archive repository's tracker, not this repository's.
