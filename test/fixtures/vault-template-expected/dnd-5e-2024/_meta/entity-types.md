---
type: meta
purpose: entity-types
---

# Entity Types

## Hierarchy

```text
character (abstract)
├── pc
└── npc
place (abstract)
└── location
narrative (abstract)
├── session
├── timeline
├── pc_roster
└── campaign_overview
```

## Folder mapping

| Type | Folder |
|---|---|
| pc | `Characters/PCs/` |
| npc | `Characters/NPCs/` |
| location | `Locations/` |
| campaign_overview | `_Campaign/` |
| timeline | `_Campaign/` |
| pc_roster | `_Campaign/` |
| meta | `_meta/` |

## Required relationships

| Type | Required |
|---|---|
| npc, pc | `located_at` |
