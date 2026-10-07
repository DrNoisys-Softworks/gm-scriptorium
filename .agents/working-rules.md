# Working rules for AI coding assistants

These rules are for an AI assistant making changes in this repository. They add to the contributor
rules in `docs/DEVELOPING.md`, which bind everyone and which you must read first. This file is
public: keep real names, private paths, hosts, IP addresses and emails out of it.

## Read order

1. `AGENTS.md`, the index.
2. `docs/DEVELOPING.md`: the artefact rule, never-touch, gates, constraint tests, testing
   standards, release procedure and conventions.
3. `docs/COLLABORATING.md`, before touching `src/generator/`, `src/build/`,
   `src/vault/publishset.js`, `src/cli/check.js` or `vendor/gm-apprentice-publish/`.
4. `.agents/bookkeeping.md`, when a change moves a count it records.

## How to work

- **Never edit `vendor/gm-apprentice-publish/` or `node_modules/gm-apprentice-publish/`.** Go
  through `src/generator/pinned.js`. The never-touch rule holds on whoever's machine you are on.
- **Never write to a path the repository names as frozen or campaign-specific**, and never commit
  campaign content, vault files, secrets or credentials.
- **Write the failing test first and watch it go red**, then fix. Prove the fix by mutation, as
  `docs/DEVELOPING.md` describes. Never derive an expected value from the code under test.
- **Run the gates before you call a change done**: `npm test` and `npm run verify-generator`, and
  `npm run package` when the change touches packaging, notices, embedded assets, `src/`, `bin/`,
  `assets/` or `scripts/` in a way that reaches the executable.
- **Name what a green result does not prove.** If correctness depends on the packaged Windows
  binary, say so and leave the item open. Never report a Windows-found defect as fixed on Linux
  evidence.
- **Do not weaken a constraint test to make a change pass.** Stop and report it instead.
- **Report gaps honestly.** If you could not run something, say which command and why.

## Commits and pushes

- Use conventional-commit messages. Keep commits small, one concern each.
- Check for conflict markers before every commit.
- **A multi-step shell block must never end in a push.**
- Releases, tags, version bumps, deploys and pushes belong to the owner. Commit and stop unless
  the owner has told you, in their own words, to push.
- Owner-specific instructions live in an untracked `CLAUDE.local.md`. It is not part of this
  repository, and nothing here depends on it.

## Writing documents

Documents in this repository are for human readers. Follow the "Write for people" convention in
`docs/DEVELOPING.md`. Put anything meant only for assistants in `.agents/`, not in the human
documents. Do not commit `docs/agent-runs/`, which is gitignored.

## The Windows runbook

`.agents/windows-verification.md` is the only place Windows-side behaviour gets verified. A fix
with a Windows leg updates its criterion there in the same change. Criterion numbers (C1, C2 and
so on) never change, because other documents cite them. Keep each criterion's text stable; add a
new criterion rather than rewriting an old one.
