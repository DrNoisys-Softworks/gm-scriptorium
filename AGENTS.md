# AGENTS.md

GM-Scriptorium is a compiled command-line tool for Windows and Linux. It checks a gm-apprentice
campaign vault, builds a player-facing website from it, and updates itself from this repository's
releases. This file is the index for AI coding assistants; it holds no rules of its own.

## Read in this order

1. [Developer guide](docs/DEVELOPING.md): the artefact rule, never-touch, gates, constraint tests,
   testing standards, release procedure and conventions.
2. [Collaborating with the upstream generator](docs/COLLABORATING.md): the integration map and the
   collaboration rules.
3. [Working rules for assistants](.agents/working-rules.md).
4. [Onboarding for an upstream-side assistant](.agents/ai-assistant-onboarding.md).
5. [Windows verification runbook](.agents/windows-verification.md).
6. [Counts that go stale](.agents/bookkeeping.md).
7. [Pull request workflow](.agents/pr-workflow.md): the per-slice flow once the repository is public.

Owner-specific instructions live in an untracked `CLAUDE.local.md`, which is not part of this
repository.
