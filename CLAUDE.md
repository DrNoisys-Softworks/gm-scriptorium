# CLAUDE.md: Scriptorium

This file is thin on purpose. It loads the full rule set for a Claude Code session opened at the
repository root, and it tells older citations where each section went. It holds no rules of its
own.

@AGENTS.md
@.agents/working-rules.md
@docs/DEVELOPING.md
@.agents/bookkeeping.md

Owner-specific instructions live in an untracked `CLAUDE.local.md`, which is not part of this
repository.

## Where the old sections went

Other files cite this file by section name. Each section now lives here:

| Former section | Now in |
|---|---|
| The rule that matters more than any other (verify the artefact, not the source) | `docs/DEVELOPING.md`, "The rule that matters more than any other" |
| Never touch (the vendored generator and its facade) | `docs/DEVELOPING.md`, "Never touch" |
| Gates that must stay green (gate table, test count, asset count) | `docs/DEVELOPING.md`, "Gates that must stay green"; the counts are in `.agents/bookkeeping.md` |
| Constraints that are tests, not preferences (including the frozen exit codes) | `docs/DEVELOPING.md`, "Constraints that are tests, not preferences" |
| Testing standards | `docs/DEVELOPING.md`, "Testing standards" |
| Release procedure | `docs/DEVELOPING.md`, "Release procedure" |
| Push policy | `docs/DEVELOPING.md`, "Push policy", and `docs/COLLABORATING.md`, "Collaboration rules" |
| Conventions (privacy rule, issues on GitHub, `docs/agent-runs/` never committed, decision records) | `docs/DEVELOPING.md`, "Conventions" |
| Windows verification | `.agents/windows-verification.md` (formerly `docs/HANDOVER-WINDOWS.md`) |
| The AI-assistant section of COLLABORATING | `.agents/ai-assistant-onboarding.md` |
