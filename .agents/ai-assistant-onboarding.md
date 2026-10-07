# Onboarding for an upstream-side AI assistant

This page is for an AI coding assistant working for the author of the upstream generator
(`AntTheLimey/gm-apprentice`, the `tools/publish` package published as `gm-apprentice-publish`), or
for any contributor working near the generator boundary. The human guide to the same boundary is
`docs/COLLABORATING.md`. This file is public: keep real names, private paths, hosts, IP addresses
and emails out of it.

- **Read `docs/DEVELOPING.md` first.** It is the source of truth for this repository's
  conventions, test gates and constraints. It is written for any contributor, and nothing in it is
  specific to the owner's machines.
- **The never-touch rules still hold** whoever's machine you are on. Never edit
  `vendor/gm-apprentice-publish/` or `node_modules/gm-apprentice-publish/` directly, and never
  write to any path `docs/DEVELOPING.md` names as frozen or campaign-specific.
- **The integration map is `docs/COLLABORATING.md`.** Read "The integration surface" there before
  touching anything under `src/generator/`, `src/build/`, `src/vault/publishset.js`,
  `src/cli/check.js` or `vendor/gm-apprentice-publish/`.
- **Run the tests before pushing**: `npm test` and `npm run verify-generator` at minimum. If your
  change touches packaging, notices or embedded assets, also run `npm run package` (see "Gates that
  must stay green" in `docs/DEVELOPING.md`).
- Follow the push and branch rules in "Collaboration rules" in `docs/COLLABORATING.md`.
- The general working rules for assistants are in `.agents/working-rules.md`.
