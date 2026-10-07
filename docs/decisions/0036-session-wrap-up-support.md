# 0036. Session Wrap-Ups: recaps come from the Wrap-Up, and withheld session notes stay out of the leak checks

## Summary

Some campaigns keep a session's player-facing recap in a separate Wrap-Up note linked to the
session note. When the two are linked, the site builder publishes the Wrap-Up and hides the
session note's body, so Scriptorium now takes that session's timeline items, recap numerals and
Connections links from the Wrap-Up page, and the leak checks no longer report text in a session
body that will never publish. Scriptorium reads the pairing the site builder actually made, and
`check` asks the site builder's own pairing function rather than keeping a copy of the rule. We
rejected rebuilding the site builder's own session pages, or restructuring vaults into its
preferred layout, as larger and riskier than needed. If a published Wrap-Up is linked to a session
note that doesn't publish, `check` warns, because the site then has no session page for it at all.

Status: accepted.

## Decision

**What pairs, and who decides.** The site builder does, through its own explicit-link rule: a
session note's own `documents.wrap_up` field names the Wrap-Up, or the Wrap-Up's own `session`
field names the session note. Scriptorium never re-implements that rule; it calls the site
builder's own pairing function, through the same facade every other generator call goes through.

**Build.** Scriptorium reads the pairing from the session page the site builder actually built:
a paired session page carries a short recap block with a link to the full Wrap-Up, and Scriptorium
resolves that link to find out which Wrap-Up it is. Because this reads what was really built,
vault text itself can never forge a pairing that didn't happen.

**Check.** `check` asks the site builder's own pairing function again, fed by a faithful copy of
the site builder's own note-finding walk (built once, and change-detected against the installed
site builder so a future update can't drift silently). Every real build also runs this
recomputation and compares it against what it read from the pages, naming any session where the
two sides disagree.

**What changes on the site.** For a paired session, the timeline's learned items and recap
numeral, and Connections' shared-recap score, come from the Wrap-Up's own page instead of the
session note's. The session note still supplies its own number and date. A Wrap-Up page is never
itself a Connections lane item, the same way a session note already wasn't.

**What changes in `check`.** A paired session note's body reads as empty to the body leak checks
(the checks that look for a withheld name, an unpublished link, or a spoiler heading surviving
into published text), because that body will never actually publish once it pairs. Frontmatter is
checked exactly as before, and every other page, including the Wrap-Up itself, is checked exactly
as before. Three new warnings, described below, replace the previous "not supported yet" notice.

**The fail-safe.** When the two note-finding walks might disagree (a symlinked note is the one
case this can currently happen), nothing is treated as withheld, so the leak checks only ever get
stricter under uncertainty, never looser.

## Rejected alternatives

- **Restructuring the owner's vault into the site builder's preferred layout.** The layout is the
  owner's own choice, and the code needed is the same either way. It would also double the number
  of cards shown for one session on the sessions index, and publish fields from the session note's
  own frontmatter that currently stay private.
- **Treating a standalone published Wrap-Up as a full session record, and re-rendering the site
  builder's own landing page, badges, previous/next links and saga summary from it.** Much larger,
  and it would mean re-rendering pages the site builder itself owns. The narrower change here is
  consistent with this project's existing rule against reimplementing pieces of the site builder's
  own shell; the alternative is waiting on the upstream project to support this layout natively.
- **Writing our own copy of the pairing rule.** The site builder keeps that rule in exactly one
  place; a separate copy would drift the next time it changes there.
- **Capturing the pairing by patching the site builder's own code in memory while it runs.** This
  project already has one narrow, documented use of that technique for a different problem, and
  the site builder's own build already writes the answer onto the page it builds, so there is a
  simpler, safer source available here.
- **Recomputing the pairing on the build side and using that answer for the site**, instead of
  reading the site builder's own output. A recomputation can disagree with what the site builder
  actually shipped; what the site shows must always win.
- **Using `check`'s own census note list as the note-finding source**, instead of a dedicated
  walk. That list skips folders the site builder's own walk counts, so `check` could end up
  treating a session body as empty when the real site never actually withheld it.
- **An error, instead of a warning, for a Wrap-Up linked to a session note that doesn't
  publish.** That is a layout choice a GM may make deliberately, not a privacy leak.

## Will catch

- For a session paired by a real build, timeline items, recap numerals and shared-recap scoring
  from the Wrap-Up's own rendered page, including a campaign's own custom heading name for the
  learned-items list.
- Paired session bodies no longer produce a false-positive in the body leak checks, while every
  other page, every frontmatter field and every Wrap-Up page is still checked exactly as before.
- Three `check` warnings: a published Wrap-Up linked to a session note that doesn't publish; a
  Wrap-Up's link that doesn't resolve to exactly one session note; and a session note whose
  learned-items list didn't make it into its paired Wrap-Up.
- A build where `check`'s own recomputed pairing disagrees with what the site actually built,
  named per session, so a drift between the two note-finding walks is never silent.
- An upstream change to the pairing markup, the note-walk's own filters, or the Wrap-Up type list,
  which turns a change detector red at the next site-builder update.

## Will not catch, deliberately

- A session paired this way in human `build` output: `build` only prints check errors, never
  warnings; the new warnings surface in `check`, and in `build`'s own machine-readable output.
- The site builder's own session surfaces (landing page, badges, previous/next links, saga
  summary) for a Wrap-Up whose session note doesn't publish at all.
- The sessions index listing a Wrap-Up card alongside its session's own card, when both happen to
  map to the same output folder.
- Two notes claiming the same alias, resolved in whichever order the vault happens to be walked.
- A symlinked note. This switches the fail-safe on, which makes `check` stricter, never looser.
- Markdown formatting inside a learned-items heading.
- A withheld name that appears only in a paired session's scene list or linked-documents field:
  still reported, even though the site builder never actually renders either field. A campaign can
  add either field to its own excluded-fields list if this matters to it.
- A session note with the status some campaigns use to mean "wrapped up" not counting as played on
  the landing page. That is an existing upstream quirk, unrelated to this change.

## Residuals

- The check side depends on its own copy of the note-finding walk staying equal to the site
  builder's. Tests compare the two directly, and a future site-builder update re-runs them before
  anything else.
- Recaps are still matched by session number across chapters, an existing limitation unrelated to
  this change.
- The site builder itself keeps its Wrap-Up type list in two places; Scriptorium follows the one
  its own pairing call reads.
- A real build now also walks the vault's notes once, when a published Wrap-Up exists, to recompute
  the check-side pairing for comparison; timings are recorded as part of this change's own
  performance evidence.
- Windows verification stays open until it is actually run there.

## Evidence

Citations are against the installed site-builder package, at the pinned commit this repository
tracks.

- `lib/session-hub.js:22,68-76,109-125,147-192,202`
- `lib/build.js:294-304,429,454-460,493-501,603-609,851-871`
- `lib/templates/session.js:12-13,34,36`
- `lib/markdown.js:74`
- `lib/scanner.js:98-99,341,343-377`
- `lib/processor.js:770-775`
- `lib/templates/base.js:142-154`
- `lib/templates/wiki.js:51-55`
- the gate reasoning at `lib/session-hub.js:118-124,187-189`
- this repository's own parity tests and mutation results, `test/session-pairing.test.js`,
  `test/session-chain-leak.test.js`, `test/session-chain-recaps.test.js`
