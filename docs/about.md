# Why GM-Scriptorium, and how it relates to gm-apprentice

This page is for a GM or contributor who wants the reasoning behind the tool and its relationship
to the upstream generator.

## Why

Everything a GM writes in a campaign vault is not meant for players: notes on what's really behind
a mystery, secret NPC motives, stat blocks that would spoil a fight. GM-Scriptorium's whole job is
turning that vault into a site players *can* see without your GM notes leaking into it. Your
players never see your GM notes. That's the promise, and the leak checks are how it's kept rather
than just claimed. They are described in [Using GM-Scriptorium](using.md#leak-checks).

## How this relates to gm-apprentice

GM-Scriptorium is not a fork of, or a replacement for,
[gm-apprentice](https://github.com/AntTheLimey/gm-apprentice), it's a wrapper around it. All credit
for the actual vault-to-site generation logic goes to that project and its author. GM-Scriptorium
vendors one pinned copy of the generator (currently upstream tag `publish-v1.14.0`, package
version `1.14.0`), verified file-by-file against a committed manifest, and adds on top of it:

- a compiled, self-contained CLI so you don't need Node or npm installed to run it;
- the leak checks described above;
- themes and a per-campaign vocabulary pack;
- the local GM admin panel;
- self-updating.

Pinning a specific generator version means an upstream change doesn't reach your build until
someone here deliberately bumps the pin and re-verifies it, so your site's output doesn't shift
under you between two runs of the same GM-Scriptorium version.

For where this project depends on the generator's behaviour, see
[Collaborating with the upstream generator](COLLABORATING.md).
