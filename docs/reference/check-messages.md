# Check messages

This page is for a GM who has run `gm-scriptorium check` or `gm-scriptorium build` and wants to know what one of its messages means and what to do about it. The table below is generated from the program itself, so it lists every message id this version can print. Its severity and "Runs in" columns come from the code. The other two columns are written by hand.

## Reading a line of output

`check` prints one line for each finding, like this:

```
ERROR leak/l4-hidden-name Locations/Harbour.md  Locations/Harbour.md: withheld name "Ottoline Pardew" (from Characters/NPCs/Ottoline Pardew.md) appears in published text
```

The line has the severity in capitals, the message id, the file and line when there is one, then the message. Some findings add a second, indented line that quotes the text around the problem. A summary line with the three counts comes last.

The id is the stable part. The wording of a message can change between versions, but an id is never renumbered or reused, so search this page for the id. With `--json`, `check` prints the same findings as data, each with an `id`, a `severity`, a `path`, a `line` and a `message`.

## Severity

- **ERROR** means a problem serious enough to stop a build, such as a secret that could reach players. `check` exits with code 2 if there is any ERROR (see [exit codes](exit-codes.md)), and `build` refuses to start.
- **WARN** means something that is probably a mistake. It is shown but stops nothing.
- **INFO** is for your information. It is also what a check says when it has nothing to look at yet, such as the built site before the first build.

A severity marked "(varies)" depends on what the check finds. The row says when.

## Where each check runs

Most checks run in both `check` and `build`. `build` runs the checks first and refuses on an ERROR, unless you pass `--force-check`. With `--no-check`, `build` skips the checks, so "check and build" is a simplification for that case. The built site is scanned separately, before it goes live, and nothing overrides that scan ([ADR 0055](../decisions/0055-force-split.md)).

The four `graph/` checks are off unless you run `check --graph`. They are hygiene hints, never errors.

One id, `build/gm-link-marker`, is made only by `build`.

## Lines that are not checks

A line that starts with `ERROR rendering` and names a page comes from the site generator while it builds, not from a check. It has no id here. Read the page it names.

## What the checks cannot see

A clean run is not clearance. The checks look for hidden names and headings, not for a secret that is given away in other words. For what they miss, read the section [What the leak checks cannot see](../explanation/what-players-see.md#what-the-leak-checks-cannot-see) in the page on how GM-Scriptorium decides what players see.

<!-- BEGIN GENERATED check-messages: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
<!-- END GENERATED check-messages -->
