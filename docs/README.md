# Documentation index

This page lists every document written for a human reader: GMs running GM-Scriptorium,
contributors, and anyone working on the upstream generator. It doesn't include planning notes or
the guides written for AI assistants, apart from one pointer to them under Contributing.

The pages for GMs are in four groups, by what you want to do.

Anything these pages mark "Since 0.5.0" needs version 0.5.0 or later; `gm-scriptorium --version` shows yours.

## Tutorial

Learn by doing, from the start.

- [The Long Lease: a sample campaign](../examples/README.md): a small invented campaign to copy, build and serve before you point the tool at your own vault.

## How-to guides

Steps for a job you already have in mind.

- [Install, update and build from source](install.md): downloading and verifying a release, the
  Windows warning, updating, and building from source.
- [Using GM-Scriptorium](using.md): what a vault needs, every command, and the leak checks.
- [Trying it safely](trying-it-safely.md): using the tool beside a campaign you care about, without touching your real config.
- [Remote access](remote-access.md): using the admin panel from another device, safely.
- [Backing up your vault](backing-up-your-vault.md): how to keep your campaign notes safe, and why GM-Scriptorium does not do it for you.
- [Start a new campaign](how-to/start-a-new-campaign.md): set up your first campaign, with a vault you already have or a new one, in the admin panel or on the command line.
- [Add another campaign, and switch between them](how-to/add-another-campaign.md): add a second campaign, move the panel between campaigns, choose the default and take one off the list.
- [Change how your site looks and the words it uses](how-to/change-the-look-and-vocabulary.md): the theme, the pictures, the title and tagline, and the vocabulary.
- [Move to another computer](how-to/move-to-another-computer.md): copying your settings, fixing the paths, and sharing one vault between two computers.
- [Use the command line and scripts](how-to/use-the-command-line-and-scripts.md): giving a script its own settings, reading results as data, acting on exit codes, and setting a password without a prompt.
- [Troubleshooting](how-to/troubleshooting.md): what the common messages mean and what to do, and the problems that come with no message.
- [Keep GM-only notes off the player site](how-to/hide-gm-content.md): hiding a page, part of a page, a field, a relationship or a name, and checking the result.
- [Add a Game master link to the player site](how-to/add-a-game-master-link.md): a link in the site footer back to your own admin panel, and why its address is public.
- [Keep building after gm-apprentice moves your vault's settings](how-to/vault-settings-moved.md): what `check` says once the settings live in `_meta/vault-config.yaml`, and how to carry the pack's leftover settings into that file.

## Reference

Facts to look up.

- [Image slots](image-slots.md): which images a theme can show, and the sizes to prepare them at.
- [The settings file (config.toml)](reference/config-toml.md): every key in the settings file, what it does, and what changes it.
- [Environment variables](reference/environment-variables.md): every variable the program reads.
- [Exit codes](reference/exit-codes.md): the five codes every command ends with, and what to do about each.
- [Files and folders](reference/files-and-folders.md): what GM-Scriptorium keeps on your computer, and where.
- [The command line](reference/command-line.md): every command, flag and subcommand, and the exit codes each command returns.
- [The campaign pack file (pack.toml)](reference/pack-toml.md): every key in a campaign's pack file, what it does, and what changes it.
- [The vault's publish settings (vault-config.md and vault.config.json)](reference/vault-config.md): the keys GM-Scriptorium reads, shows or changes in the two files, how they combine, and which the panel edits.
- [Check messages](reference/check-messages.md): every message id `check` and `build` can print, what it means and what to do.
- [Remote access: accounts, sign-in and what is protected](reference/remote-access.md): the account and sign-in rules, the audit log, what is and is not protected, and the files remote access keeps.

## Explanation

Why the tool works the way it does.

- [Privacy](privacy.md): what the tool sends over the network, and what it never does.
- [How GM-Scriptorium decides what players see](explanation/what-players-see.md): which pages publish, what is cut from them, and what the leak checks cannot see.
- [Why, and how this relates to gm-apprentice](about.md): the reasoning and the upstream credit.

## Contributing

- [Contributing](../CONTRIBUTING.md): how to propose a change.
- [Developer guide](DEVELOPING.md): what never to edit, the checks a change must pass, how
  releases are made, and the house conventions.
- [Collaborating with the upstream generator](COLLABORATING.md): where this project depends on the
  upstream generator's behaviour, and the ground rules for changes near that boundary.
- [Security policy](../SECURITY.md): how to report a vulnerability.
- [Writing the user documentation](WRITING-DOCS.md): the criteria every page for GMs meets, and the list of those pages.

If you work with an AI coding assistant, point it at [`AGENTS.md`](../AGENTS.md).

## Design decisions

Architecture decision records: why something was built the way it was, and what was rejected along
the way.

- [0001. Packager: @yao-pkg/pkg, target node22-win-x64](decisions/0001-packager.md): Scriptorium ships as a self-contained executable (Windows first, Linux added later), built on Linux.
- [0002. `serve` binds 127.0.0.1 by default, not 0.0.0.0](decisions/0002-serve-binds-localhost.md): `serve` listens only on your own computer unless you ask otherwise.
- [0003. Config format: TOML, parsed with smol-toml](decisions/0003-config-format.md): Settings live in a hand-editable TOML file.
- [0004. `update` authenticates via the `gh` CLI subprocess only](decisions/0004-update-credential.md): `update` talks to GitHub only through the `gh` tool.
- [0005. Generator pin: vendored tarball, per-file manifest integrity](decisions/0005-generator-pin.md): The bundled generator is one exact copy that is checked file by file.
- [0006. `sessions/index.html` is written by Scriptorium's own post-build pass, not a vault page](decisions/0006-post-build-page-writer.md): The Sessions page of a built site is written after the generator runs. Retired at publish-v1.21.0: the generator writes the page itself.
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
- [0024. AI connections](decisions/0024-ai-connections.md): Scriptorium's one outgoing connection module, and the rules for what it may reach.
- [0028. Installer and first run](decisions/0028-installer-and-first-run.md): With no campaign yet, the admin panel starts with browser setup.
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
- [0042. Stub pages: withheld sections win over include entries (guard on keepOnlySections)](decisions/0042-stub-section-guard.md): A stub page can no longer publish a heading nested inside a withheld section. Retired at publish-v1.17.0, when the generator began doing this itself.
- [0043. A table cell link with an escaped pipe is read the same way by check and by the build](decisions/0043-escaped-pipe-read-shim.md): `[[Target\|Label]]` in a table cell is read as a link with a label.
- [0044. Obsidian %% comments are removed before the site is built, and the build refuses to publish one](decisions/0044-obsidian-comments-withheld.md): `%%private notes%%` never reach the site.
- [0045. The leak checks read headings the way the generator renders them, and read JSON data islands](decisions/0045-leak-checks-read-rendered-headings-and-data-islands.md): a bold, indented, underlined or story-file `GM Notes` heading is caught, and comment text inside timeline and connections data is searched.
- [0046. One process spawner for outside programs](decisions/0046-one-process-spawner.md): Programs the tool starts all go through one module with a fixed list, no shell and a scrubbed environment.
- [0048. Starting a new campaign: creating a vault from the gm-apprentice scaffold](decisions/0048-new-campaign-vault.md): A GM with no vault can create one in a new or empty folder, from gm-apprentice's own scaffold output, by a writer that never overwrites and never deletes.
- [0049. The folder picker](decisions/0049-folder-picker.md): Path fields can browse folders in the panel and make a new one, without listing any file.
- [0050. Several campaigns in one panel](decisions/0050-several-campaigns.md): One running panel can switch between registered campaigns, set the default and remove one from the list, and config.toml is now written crash-safely.
- [0051. Code signing for the Windows executable](decisions/0051-code-signing.md): Releases are signed from 1.0 and the signature is checked on Windows, while self-update keeps trusting SHA256SUMS.
- [0052. Adding a campaign from the panel](decisions/0052-add-a-campaign.md): A GM can add another campaign from the running panel, on this computer or over remote access, with the same questions and checks as first-run setup, then switch to it.
- [0053. The Windows installer and uninstaller](decisions/0053-windows-installer.md): Setup installs for the signed-in user only and the uninstaller removes a short list of named files and never settings, built on Linux with its files stored as they are so the build can prove it packed them.
- [0054. Getting into the GM console from the player site](decisions/0054-gm-access-from-the-player-site.md): Remote sign-in takes a username and a password against up to eight named accounts managed from the command line, wrong tries are counted per username with a global ceiling, and a published site can carry one opt-in "Game master" link.
- [0055. `--force` is split, and no flag overrides the output-leak scan](decisions/0055-force-split.md): `build --force-check` builds despite check errors, `build --force-out` builds into the site config's own output folder, nothing overrides the output-leak scan, and a bare `--force` exits 1 with one line.
- [0056. An owner-only access list on the panel folder on Windows](decisions/0056-windows-panel-access-list.md): On Windows the program sets the `panel` folder's access list to your account, SYSTEM and Administrators on every panel start and before any `remote` command writes there, using `icacls` from System32 through the one process spawner, and the remote modes refuse to start if it cannot.
- [0057. The Windows desktop app](decisions/0057-windows-desktop-app.md): Installed Windows copies run in the background with a system tray icon and no console window, a small native helper owns the icon, the single running copy, sign-out and Start with Windows and talks to the program over pipes, the panel uses fixed addresses (7400 and 7401 by default, which the GM can change), and remote access never starts at sign-in until the GM ticks "Remote access at sign-in" in the tray menu on that PC.
- [0058. Installer options and the first campaign](decisions/0058-installer-options.md): Setup installs and starts the tray app, offers the Start menu and desktop shortcuts and Start with Windows as choices with PATH and the ports under Advanced, closes a running copy itself, and never opens the settings or changes remote access at sign-in.
- [0059. The sample campaign is published to GitHub Pages, built only from the sample](decisions/0059-hosted-sample-site.md): A separate workflow builds and checks the sample from one fixed path and publishes it with a generated leak demo page, nothing is uploaded if any gate fails, and the 404 notices link breaks at nested missing addresses.
- [0060. A folder hidden only in vault-config.md is a warning, and the build judges hidden folders on the new site](decisions/0060-hidden-folders-warn.md): Hiding a folder in the panel no longer blocks a build, and the build checks the new site, not the old one, for pages from hidden folders.
- [0061. Banners and the cover picture are judged by the file they were copied from](decisions/0061-banner-and-cover-sources.md): The hidden-folder leak check no longer mistakes the cover picture and section banners for attachments; one you named from a hidden folder is a warning, and a `_banner` picture found in a hidden folder still refuses the build.
- [0069. The real-browser tests run on every pull request, and the check must pass](decisions/0069-browser-tests-in-ci.md): A browser check now runs the real-browser test files in Chromium and Firefox on every pull request, a runner fails on any skip, the check becomes required, and one known flake may be re-run once.
- [0070. Keyboard focus is not left under the narrow window's bars](decisions/0070-focus-not-hidden-by-bars.md): In a window narrower than 700 px the page keeps scroll room equal to the top bar, the bottom bar and the unsaved-changes strip, so a focused control is scrolled out from under them, and the Updates card still lands 16 px below the top bar.
- [0071. Reading a vault whose settings moved to vault-config.yaml, and carrying the pack's leftover settings](decisions/0071-moved-vault-settings.md): `check`, `build`, `init` and the panel read a moved vault through the generator's own reader, a hide entry or folder map left only in the pack fails `check`, and the GM moves them with `carry` or the panel's button, through the generator's own merge, with both files backed up outside the vault first.

## Licensing

- [Licence provenance](PROVENANCE.md): an audit of every bundled dependency's licence.
- [Third-party notices](../THIRD-PARTY-NOTICES.txt): the notices bundled with every release.
- [Licence](../LICENSE): this project's own licence.

## Issues

- [Issues](issues/README.md): where bugs and feature requests live.

Some older documents and decision records reference a number like `#N`. That refers to the
private archive repository's own issue tracker, not this repository's.
