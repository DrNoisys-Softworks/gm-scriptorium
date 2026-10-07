# 0034. Executable frontmatter: refuse non-YAML fences, freeze the generator's gray-matter to YAML

## Summary

The frontmatter parser Scriptorium and its generator both depend on can be told to run its
opening block as JavaScript instead of reading it as data, simply by naming a different language
after the fence's three dashes. A note built from an untrusted source, a co-GM's synced file, or a
sample vault could therefore run code with the permissions of whoever built the site. This change
closes that path with two independent controls: Scriptorium refuses to read or build any tracked
file whose frontmatter declares a language other than YAML, and separately, the generator's own
copy of the parser has every engine but YAML permanently removed for the life of the process, so
even a note the refusal never reaches cannot execute. The refusal cannot be turned off, including
with the build's own override flag. A small number of cases, described below, are refused as a
precaution even though nothing in them would actually have run.

Status: accepted.

## 1. The vector

A frontmatter parser widely used across the ecosystem this project depends on picks its parsing
engine from the text that follows a note's opening `---`. Writing `js` or `javascript` there, in
any capital combination, switches from reading the block as data to running it as code. A vault
holding notes from other people is exactly where this can arrive without anyone intending it: a
synced note, an imported sample, or a shared campaign file. Once a build reaches such a note, the
code runs with the same access the person running the build has.

Both Scriptorium's own copy of the parser and the one bundled inside the generator it depends on
carry this behaviour, because both are the same version of the same library. Setting an option
that names the expected language does not close it: the fence itself overrides that option, the
same way it decided the language in the first place. The generator's own scan reads more of the
vault than a first look suggests: alongside every published page, it also reads any note that
declares an alias for another name, in any folder, published or not, once per build, regardless of
whether that folder is otherwise excluded from the site. A note that fails to parse there is
silently skipped rather than reported, so a refusal that stops at Scriptorium's own check is not
enough on its own: the generator would still need telling.

## 2. The decision: two layers, each proven on its own

**The primary control** freezes the generator's own copy of the parser at the moment Scriptorium's
generator-facing code first loads: every non-YAML parsing engine is removed from its shared engine
table and the table is then locked, so nothing already running, and nothing a future release of
Scriptorium adds, can put one back. Because every parse the generator performs rebuilds its
engine choices from that same shared table, this covers every place inside the generator that
reads a note's frontmatter, including any such place a future update to the generator adds,
without Scriptorium needing to know where those places are. A self-check runs immediately
afterwards, through the generator's own code (not merely against Scriptorium's own reference to
the parser), confirming that the exact copy the generator itself will use really has been frozen.
If that self-check ever fails, for instance because a future update changes how the generator
resolves its own copy of the parser, the whole program stops rather than continuing with a freeze
that might not be covering the right object.

**The refusal layer** is a matching, independent check inside Scriptorium itself. A single rule
decides whether a note's opening fence names YAML (including a blank fence) or something else,
built by reading the parsing library's own behaviour line by line rather than by calling into the
library, since a refused file must never reach it at all. Scriptorium's own reading of a note now
consults this rule before it ever hands the note to the parser. A whole-vault scan applies the
same rule everywhere the generator's build can possibly read a note, which turns out to be wider
than the set of files an ordinary check already looks at: it includes folders otherwise excluded
from the built site, an inbox area meant only for triage, and even a `node_modules` folder if one
happens to exist inside the vault. Every refusal is reported as its own finding, once per file, so
a GM sees exactly which files need attention rather than a generic parse failure. The same check
also runs, unconditionally, at the very start of a build, before anything is written to disk, and
it cannot be skipped by the build's "skip checking" flag or overridden by its "build anyway despite
errors" flag; both exist for other findings, not for this one.

Neither control is enough alone. Freezing the generator's copy stops any code from running, but a
note the generator treats as unparseable is dropped from the site silently, and one particular
piece of hidden-name protection depends on a note's declared aliases actually being read: a
frozen-but-silently-dropped note can leave a name unprotected without anyone being told. The
refusal layer catches that and tells the GM, but on its own it would need to correctly predict
every way the generator might ever read a note, which drifts every time the generator is updated
and can never fully close a small window between a scan finishing and the generator's own read
starting. Together, the freeze is what actually stops any code execution, and the refusal is what
keeps a GM informed instead of a file quietly vanishing from the build.

## 3. What gets refused

Every tracked markdown file in the vault, of any case in its extension, whether a regular file or
a link to one, is covered, except that a whole folder is skipped only when its own name starts
with a dot (the conventional marker for a tool's own private folder, such as an editor's cache).
Nothing else is skipped: excluded folders, an inbox, even a `node_modules` folder inside the vault
are all read, because the generator itself would read every one of them under the right
circumstances. A folder reached only through a link to another folder is never followed, matching
what the generator itself does.

The rule that decides "YAML or something else" mirrors the parsing library's own steps exactly: it
strips one leading byte-order mark if present, recognises the fence only when the line begins with
exactly three dashes, reads the text up to the first line break (a line ending on either
convention), and treats that text, trimmed of surrounding whitespace, as the declared language.
An empty declaration, or "yaml"/"yml" in any capitalisation, is the only thing allowed through;
absolutely anything else, including a name the parsing library would not recognise at all, is
refused. A file whose very first line runs unusually long, with no line break found within a
generous bound before Scriptorium gives up looking, is refused as a precaution rather than assumed
safe.

## 4. Output and exit codes

Because the declared language in a refused file is written by whoever wrote the file, it is never
shown as-is: what appears in a message or a finding is a bounded, escaped rendering, capped at
thirty-two characters, with anything that could otherwise manipulate a terminal or a log escaped
to a plain, printable form. Nothing else about a refused file, and none of its body text, ever
appears in output. The refusal itself does not change any of Scriptorium's exit codes: a refused
check or refused build still exits the same way an ordinary set of check errors does, and a
filesystem failure while scanning is reported the same way an equivalent failure elsewhere in
Scriptorium already is.

## 5. Rejected alternatives

- **Scanning first and relying on that alone.** The generator's own read still needs mirroring
  exactly, has to be kept in step with every future update to the generator, and leaves a narrow
  window between the scan finishing and the generator's own read starting. It is required as the
  layer that keeps a GM informed, but not sound as the only control.
- **Freezing the generator's copy and stopping there.** Without the refusal layer, a note the
  generator treats as unparseable disappears from the build with no report, which for one
  particular protection can mean a name that was supposed to stay hidden quietly stops being
  hidden.
- **Passing a language restriction into each of the generator's own parsing calls.** The generator
  is a dependency Scriptorium does not modify, and none of its calls currently accept that option.
- **Telling the parser which language to expect via a general setting.** The fence itself overrides
  that setting, so it does nothing.
- **Allowing a data format such as JSON.** Nothing in any real vault or in Scriptorium's own test
  material uses it, and a narrower allowed list is easier to reason about.
- **Refusing only a fixed list of known-dangerous language names.** A future version of the parsing
  library, or the generator's own bundled copy of it, could add another one under a different name
  that such a list would not know to catch.
- **Letting the build's "build anyway" override apply to this refusal too.** That would defeat the
  whole point of an unconditional control.
- **Patching the generator's own installed files directly, or asking Scriptorium's packaging tool
  to do so.** Scriptorium's whole relationship with the generator depends on running its files
  unmodified and verified against a known checksum.
- **Resolving the generator's copy of the parser by searching its installed files at run time.**
  This is unproven inside a packaged, single-file executable and is avoided in favour of a fixed,
  literal reference to the exact file Scriptorium already ships and verifies.
- **Matching the fence with a single regular expression instead of reading it step by step.** A
  regular expression that looks reasonable at a glance still misses a line-ending edge case the
  parsing library itself treats specially (a stray carriage return that sits before, rather than
  immediately in front of, the actual line break); a regular expression general enough to catch
  that case correctly stops being simpler than reading the fence step by step in the first place.
- **Reading a whole file, however large, just to decide its declared language.** A bounded read of
  the first part of the file is enough, and avoids allocating unbounded memory per file during the
  whole-vault scan.

## 6. Will catch

- Any tracked markdown file, of any case, a regular file or a link to one, outside a dot-named
  folder, whose fence would otherwise route it away from YAML, once its own byte-order mark, line
  endings and surrounding whitespace are accounted for; reported by an ordinary check, and refused,
  unconditionally, by every build.
- Any vault text reaching the generator's own copy of the parser through any of its current
  reading points, or any the generator might add in a future update, for as long as the process
  keeps running.
- A mistake in Scriptorium's own refusal rule: the generator-side freeze still stops execution even
  if the refusal rule itself has a bug.
- A future update to the generator that changes the exact files this freeze depends on, or that
  resolves its parser from somewhere unexpected: both are caught by a failing self-check, which
  stops the whole program rather than continuing with a freeze that may no longer be covering the
  right thing.

## 7. Will not catch, deliberately

- The narrow window between a scan finishing and the generator's own read of the same file
  starting. Nothing can execute in that window, since the freeze still holds, but a refusal found
  moments earlier can be missed by that one read, and the generator then treats the file as
  unparseable and skips it, which for a note whose only job was to declare a hidden name's alias
  means that name is no longer hidden. The generator does warn about this itself.
- A declared language whose name happens to collide with a property every JavaScript object
  already has (for instance, naming the fence after the word every object uses for its own
  constructor). The generator's own copy returns meaningless data for a case like this rather than
  running anything, so nothing executes, and Scriptorium refuses it regardless.
- A future update that replaces the parsing library inside the generator with something else
  entirely. The hash check this change adds will notice the files changed and force a person to
  read the new code before trusting it again, but it cannot itself judge whether a replacement
  library is safe.
- Anything already outside this project's stated security boundary: raw HTML or scripts placed
  directly in a note's own body text, and deliberately oversized YAML content meant to exhaust
  memory or time while parsing.
- A folder reached only through a link to another folder. Neither of the generator's own scans
  follow one at this version, so this stays out of scope alongside them.
- Code already running inside the same process re-adding a removed parsing engine on its own. That
  is outside what this change is meant to defend against, and the freeze would refuse the attempt
  regardless.
- Running the generator on its own, outside Scriptorium. That belongs to the project the generator
  itself comes from.

## 8. Residuals

- A first line long enough to exceed the bounded read is refused even in the rare case where the
  rest of that same line, had it been read in full, would have turned out to be ordinary YAML.
- A filesystem failure partway through the whole-vault scan now stops a check or a build the same
  way an equivalent failure elsewhere already does; this widens where such a failure can be hit
  from, without changing what it looks like when it happens.
- Because Scriptorium loads its generator-facing code before dispatching almost any command, a
  failed self-check stops nearly every command, including ones that never touch a vault at all.
  This is accepted rather than narrowed for now.
- The packaged program's own startup check does not currently exercise this path, so a failure
  specific to how the freeze behaves once packaged would only be caught by actually running the
  packaged program against a note built for this purpose, which has been done and is recorded
  separately from this document.
- Confirmation that this holds on the packaged Windows program specifically is tracked in the
  agent-facing runbook this project keeps for that purpose, and stays open until someone runs it
  there.
- A vault whose manifest file is itself refused also trips the existing check for a missing
  manifest, which is already how any other unparseable manifest behaves.
- A previously published build of this project, predating this change, still carries the
  vulnerability this document describes; a later, fixed build resolves it, but nothing about that
  earlier build is changed retroactively.

## 9. Keeping this current when the generator is updated

Whenever the generator dependency this project relies on is moved to a newer version, the four
files this change checksums must be re-verified against the new version, and the places inside the
generator that read a note's frontmatter must be re-read and compared against the table in section
3 above, in case a new version adds another one. See the generator pin's own decision record for
the full update procedure, and the collaboration notes for the equivalent step there.
