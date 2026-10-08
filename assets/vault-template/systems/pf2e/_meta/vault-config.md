---
type: meta
gm_apprentice_version: "1.10.37"
publish:
  site: false
  system: "pf2e"
---

# Vault Configuration

Campaign: {{SCRIPTORIUM_CAMPAIGN}}

## Vault Structure

The layout this vault started from. Folders may be added or renamed.

```text
{Campaign Name}/
├── _meta/           (schema + index)
├── _attachments/    (image files)
│   ├── characters/  (PC and NPC portraits)
│   ├── locations/   (location images)
│   ├── factions/    (faction and organization logos, HQ images)
│   ├── items/       (item illustrations)
│   ├── creatures/   (creature art)
│   ├── events/      (scene art)
│   └── documents/   (scans, letter images)
├── _midwife/        (the-midwife's workspace)
├── _World/          (world rules and domain files)
│   ├── world-index.md
│   └── _flags.md
├── _Campaign/
│   ├── Campaign Overview.md
│   ├── Player Characters.md
│   └── Timeline.md
├── _Templates/      (one per type)
├── _inbox/          (staging area for vault-ingest)
│   └── _processed/  (completed imports, date-stamped)
├── Adventures/
│   └── {Adventure Name}/
│       └── {Adventure Name}.md
├── Chapters/
│   └── Chapter N - {Title}/
│       ├── Chapter N Overview.md
│       ├── Planning/
│       ├── Sessions/
│       └── Scenes/
├── Characters/ (PCs/, NPCs/)
├── Locations/
├── Factions & Organizations/
├── Items & Artifacts/
├── Creatures/
├── Heritages/
├── Events/
├── Documents/
└── Clues/
```
