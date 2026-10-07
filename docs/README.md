# Documentation index

This page lists every document written for a human reader: GMs running GM-Scriptorium,
contributors, and anyone working on the upstream generator. It doesn't include planning notes or
the guides written for AI assistants, apart from one pointer to them under Contributing.

## Using

- [Install, update and build from source](install.md): downloading and verifying a release, the
  Windows warning, updating, and building from source.
- [Using GM-Scriptorium](using.md): what a vault needs, every command, and the leak checks.
- [Trying it safely](trying-it-safely.md): using the tool beside a campaign you care about, without touching your real config.
- [Privacy](privacy.md): what the tool sends over the network, and what it never does.
- [Why, and how this relates to gm-apprentice](about.md): the reasoning and the upstream credit.
- [Image slots](image-slots.md): which images a theme can show, and the sizes to prepare them at.
- [Remote access](remote-access.md): using the admin panel from another device, safely, and what is and is not protected.
- [Backing up your vault](backing-up-your-vault.md): how to keep your campaign notes safe, and why GM-Scriptorium does not do it for you.

## Contributing

- [Contributing](../CONTRIBUTING.md): how to propose a change.
- [Developer guide](DEVELOPING.md): what never to edit, the checks a change must pass, how
  releases are made, and the house conventions.
- [Collaborating with the upstream generator](COLLABORATING.md): where this project depends on the
  upstream generator's behaviour, and the ground rules for changes near that boundary.
- [Security policy](../SECURITY.md): how to report a vulnerability.

If you work with an AI coding assistant, point it at [`AGENTS.md`](../AGENTS.md).

## Design decisions

Architecture decision records: why something was built the way it was, and what was rejected along
the way.

- [0001. Packager: @yao-pkg/pkg, target node22-win-x64](decisions/0001-packager.md): Scriptorium ships as a self-contained executable (Windows first, Linux added later), built on Linux.
- [0002. `serve` binds 127.0.0.1 by default, not 0.0.0.0](decisions/0002-serve-binds-localhost.md): `serve` listens only on your own computer unless you ask otherwise.
- [0003. Config format: TOML, parsed with smol-toml](decisions/0003-config-format.md): Settings live in a hand-editable TOML file.
- [0004. `update` authenticates via the `gh` CLI subprocess only](decisions/0004-update-credential.md): `update` talks to GitHub only through the `gh` tool.
- [0005. Generator pin: vendored tarball, per-file manifest integrity](decisions/0005-generator-pin.md): The bundled generator is one exact copy that is checked file by file.
- [0006. `sessions/index.html` is written by Scriptorium's own post-build pass, not a vault page](decisions/0006-post-build-page-writer.md): The Sessions page of a built site is written after the generator runs.
- [0007. Rules-content redaction: two-layer erasure of GURPS reference tables and CoC skill data](decisions/0007-rules-content-redaction.md): Game-rules tables from two game systems are left out of every build.
- [0008. L4: report every dropped collision, search rendered text with real line numbers](decisions/0008-l4-rendered-text.md): The withheld-name check searches the text a page actually renders.
- [0009. The output-leak scan: read what the generator actually emitted](decisions/0009-output-leak-scan.md): A scan of the built site catches withheld names in generated views.
- [0010. Windows startup defect: drop V8 bytecode, add a pipeline startup self-test](decisions/0010-no-bytecode-packaging.md): The packager no longer emits bytecode, and a startup test runs before release.
- [0011. Stamp the notices header with the version; `update` deletes the stale copy on success](decisions/0011-notices-beside-the-executable.md): The notices file names its version, and `update` removes the stale copy.
- [0012. A product stylesheet, separate from the campaign's overrides.css](decisions/0012-product-stylesheet.md): Scriptorium ships its own stylesheet, separate from a campaign's.
- [0013. Nested section exclusion: a load-time source patch of the pinned `filterSections`](decisions/0013-nested-section-exclusion-patch.md): A patch for a section-exclusion bug in the generator, since retired.
- [0014. Story nav split toggle: a post-build HTML transform, not a vendored edit](decisions/0014-story-nav-split-toggle.md): The Story link and its menu caret become two separate controls.
- [0015. Into the Haze home: product/campaign split, hero stacking, the recap transform, and the slip slot](decisions/0015-haze-home-and-recap-emphasis.md): How one campaign's landing page was restyled without touching other sites.
- [0016. Book leaves and page motion: the LEAF scope, the token split, gated names, the badge join, the date transform, and the b2 fold](decisions/0016-book-leaves-and-page-motion.md): Inner pages read as book leaves, with page-turn motion.
- [0017: Story timeline and Connections lane](decisions/0017-story-timeline-and-connections-lane.md): A story timeline and a Connections lane replace the generator's versions.
- [0018. The campaign pack: site inputs may live in the vault, output may not](decisions/0018-campaign-pack.md): A campaign's site settings may live in its vault, but built output may not.
- [0019. Themes, image slots and the asset step](decisions/0019-themes-image-slots-and-asset-step.md): `pack.toml` picks a theme and fills six named image slots.
- [0020. Labels and vocabulary](decisions/0020-labels-and-vocabulary.md): A campaign can rename the words its built site shows.
- [0021. First-run setup: init creates a campaign pack and registers it, and writes nothing else in the vault](decisions/0021-init-first-run-setup.md): `init` is a wizard that sets up and registers a campaign.
- [0022. The GM admin panel: `serve --admin`, its request gate, and the vault write exception](decisions/0022-gm-admin-panel.md): A local, GM-only web panel edits a campaign's pack and previews the site.
- [0023. The built-in `haze` theme](decisions/0023-haze-theme.md): The built-in `haze` theme.
- [0029. Remote access to the GM admin panel (opt-in)](decisions/0029-remote-access.md): The panel can be used from another device, but only if you turn that on from the command line.
- [0030. The public repository becomes the update source](decisions/0030-public-repo-and-update-source.md): `update` reads releases from the public repository.
- [0031. Privacy guard for the public repository](decisions/0031-public-repo-privacy-guard.md): A guard checks every push, pull request and release for private data.
- [0032. The gloam base theme](decisions/0032-base-theme.md): A new built-in theme, gloam, is the default for new campaigns.
- [0033. `_meta/vault-config.md` gets its own write exception, backed up outside the vault](decisions/0033-vaultconfig-write-exception.md): The panel can edit the tagline in one vault file, with a backup kept outside the vault.
- [0034. Executable frontmatter: refuse non-YAML fences, freeze the generator's gray-matter to YAML](decisions/0034-executable-frontmatter-guard.md): Notes that try to run code in their frontmatter are refused.
- [0035. The panel shows the player site inside a frame](decisions/0035-preview-in-a-frame.md): The panel shows your preview site inside a frame.
- [0036. Session Wrap-Ups: recaps come from the Wrap-Up, and withheld session notes stay out of the leak checks](decisions/0036-session-wrap-up-support.md): Recaps can come from a linked Wrap-Up note.
- [0037. Relationship words are checked against the vault's own list](decisions/0037-relationship-word-check.md): `check` warns about relationship words that are not on your vault's list.
- [0038. The panel shows art from your vault's attachments folder](decisions/0038-vault-art-in-the-panel.md): The panel can pick art already in your vault's attachments folder.
- [0039. Preview copies of your site, built privately on this computer](decisions/0039-preview-copies.md): The Theme screen shows your own site in each theme.
- [0041. Check runs on an edited copy of a vault file before it is saved](decisions/0041-check-an-edited-copy.md): The panel runs `check` on an edited copy before saving.
- [0042. Stub pages: withheld sections win over include entries (guard on keepOnlySections)](decisions/0042-stub-section-guard.md): A stub page can no longer publish a heading nested inside a withheld section.
- [0043. A table cell link with an escaped pipe is read the same way by check and by the build](decisions/0043-escaped-pipe-read-shim.md): `[[Target\|Label]]` in a table cell is read as a link with a label.
- [0044. Obsidian %% comments are removed before the site is built, and the build refuses to publish one](decisions/0044-obsidian-comments-withheld.md): `%%private notes%%` never reach the site.
- [0046. One process spawner for outside programs](decisions/0046-one-process-spawner.md): Programs the tool starts all go through one module with a fixed list, no shell and a scrubbed environment.

## Licensing

- [Licence provenance](PROVENANCE.md): an audit of every bundled dependency's licence.
- [Third-party notices](../THIRD-PARTY-NOTICES.txt): the notices bundled with every release.
- [Licence](../LICENSE): this project's own licence.

## Issues

- [Issues](issues/README.md): where bugs and feature requests live.

Some older documents and decision records reference a number like `#N`. That refers to the
private archive repository's own issue tracker, not this repository's.
