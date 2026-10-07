---
type: meta
purpose: entity-types
source_confidence: AUTHORITATIVE
lastUpdated: "3"
---

# Entity types

The entity types this sample vault uses, and the folder and fields each one expects.

## Hierarchy

```text
person (abstract)
└── character (abstract)
    ├── pc
    └── npc
agent (abstract)
├── creature: beast, construct, elemental, ooze
└── faction: government, guild, bank
place (abstract)
└── location (nests via parent_location)
artifact (abstract)
└── item: weapon, shield, contract
narrative (abstract)
├── event: treaty, arrival, discovery, ritual
├── session
├── timeline
└── campaign_overview
```

## Universal fields

`type`, `source_confidence` (DRAFT | AUTHORITATIVE | SUPERSEDED | STUB), `aliases`, `tags`, `campaign`, `source` (play | backstory | setting | prep), `createdSession`, `asOfSession`, `lastUpdated`, `withheld` (true, or absent), `relationships`.

Session markers (`createdSession`, `asOfSession`, `lastUpdated`) hold a bare session number as a quoted string. `"0"` means setting material the table has not touched yet.

`source: prep` keeps a page off the player site. `withheld: true` goes further: the entity's name must not appear in any other published page either. Only one entity in this vault carries it.

## Folder mapping

| Type | Folder |
|---|---|
| pc | `Characters/PCs/` (with a `{Name}_Story.md` companion) |
| character-story | `Characters/PCs/` |
| npc | `Characters/NPCs/` |
| location | `Locations/` |
| faction | `Factions & Organizations/` |
| item | `Items & Artifacts/` |
| creature | `Creatures/` |
| event | `Events/` |
| session | `Sessions/` |
| campaign_overview | `_Campaign/` |
| timeline | `_Campaign/` |
| meta | `_meta/` |

## Type-specific fields

- **pc:** player_name, class, heritage, occupation, age, status, key_traits, portrait, display_meta, ability_scores, proficiencies, class_features, spell_slots
- **npc:** occupation, heritage, age, status (alive, dead, missing), portrait
- **location:** location_type, parent_location (wiki-link), atmosphere, portrait
- **faction:** faction_type, goals, leadership (wiki-link), territory (wiki-link), status, portrait
- **item:** item_type, rarity, cost, weight, damage, current_holder (wiki-link), origin (wiki-link), portrait
- **creature:** creature_type, threat_level, hp, speed, abilities, weaknesses, portrait
- **event:** event_type, location (wiki-link), participants, outcome
- **session:** session_number, play_date, status (played), location (wiki-link)

## Required relationships

| Type | Required |
|---|---|
| npc, pc, creature | `located_at` |
| faction | `headquartered_at` |

## Player-visible vs GM-only

Every page body is player-visible except `## GM Notes`, and anything between `<!-- gm-only -->` and `<!-- /gm-only -->` markers. The `secrets` field is stripped on publish, and so is any relationship edge marked `gm_only: true`.
