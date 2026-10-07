# 0003. Config format: TOML, parsed with smol-toml

Status: accepted (phase 1, 2026-09-10).

## Summary

Scriptorium's own settings file is TOML, which a GM can edit by hand. TOML lets a Windows path be written as it is, with no doubled backslashes, and it allows comments. JSON was rejected because backslash escaping in paths is a common typo that produces a confusing "path not found" error. The file is read and written with the `smol-toml` library, pinned to an exact version because every command depends on it. This record covers only the file format and the parser, not the settings themselves.

## Decision

Scriptorium's own config file (`%APPDATA%\Scriptorium\config.toml` on Windows,
`${XDG_CONFIG_HOME:-~/.config}/scriptorium/config.toml` elsewhere) is TOML, parsed and written with
the `smol-toml` npm package, pinned exact at `1.8.0`.

## Why TOML over JSON

Hand-editability is a stated requirement (Engineering Brief section 4), and the config holds Windows
paths: `vault = "D:\Campaigns\example\vault"` in JSON requires doubled backslashes
(`"D:\\Campaigns\\..."`), which is exactly the typo class that produces a confusing "path not found"
rather than a syntax error. TOML's literal strings (single-quoted: `vault = 'D:\Campaigns\...'`) take
the path verbatim, no escaping. TOML also supports inline comments, which JSON does not, and the
per-machine profile tables (`[campaigns.example.paths.desktop]`) map naturally onto TOML's
native table syntax rather than needing a JSON convention invented for the purpose.

## Why smol-toml over the alternatives considered

Node 22 has no built-in TOML parser, so this is an unavoidable added dependency. Requirements: pure
JS, no native code, permissive licence, small, actively published (Engineering Brief section 4).

| Option | Licence | Native code | Last published | Verdict |
|---|---|---|---|---|
| `smol-toml` | BSD-3-Clause | None | 2026-08-11 (actively maintained) | **Chosen.** Zero dependencies of its own, ~109 kB unpacked, ships a CJS build (`dist/index.cjs`) so `require('smol-toml')` works despite the package itself being `type: module` |
| `@iarna/toml` | ISC | None | 2023-07-15 | Stable but not actively maintained; older TOML spec compliance |
| `toml` | MIT | None | Considered, not benchmarked in detail once smol-toml's zero-dependency BSD-3 profile was confirmed | |

`smol-toml` is pinned exact (`"smol-toml": "1.8.0"`, not `^1.8.0`) for the same reason
`gm-apprentice-publish` is pinned exact: config parsing is load-bearing for every command, and a silent
minor-version behaviour change in how paths or tables parse is not an acceptable surprise.

## What this does and does not decide

This ADR is the format and parser choice only. The schema itself (`config_version`, campaign blocks,
the `[campaigns.<name>.paths.<profile>]` per-machine seam) is specified in the Engineering Brief section
5 and frozen in `src/config/schema.js`; the loader/validator is `src/config/load.js`; the canonical
writer (fixed key order, regenerated header, unknown keys preserved but comments not) is
`src/config/write.js`. None of that is a smol-toml concern, it would be the same regardless of which
TOML library had been chosen.

## Consequence worth recording

Because the writer is a canonical emitter and not a round-tripping library, any comment a user adds to
the config file outside the header is lost on the next `config add`/`remove`/`set-default`. This is
documented in `config --help` and in the file's own regenerated header. It was a deliberate trade
(section 4 of the brief: "Write with a canonical emitter we own, not a round-tripping library") for a
smaller, more auditable writer rather than pulling in a heavier TOML library that preserves formatting.
