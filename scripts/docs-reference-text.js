'use strict';

/*
 * The hand-written columns of the generated tables on the reference pages (docs/reference/). Run
 * `npm run docs-reference` after changing this file; scripts/docs-reference.js merges it with the
 * facts it reads from the code.
 *
 * Rules, enforced by test/docs-reference.test.js:
 *  - one entry per key the code has, and no entry for a key it does not;
 *  - an entry never gives a column the code holds for that key (type, default, allowed, meaning or
 *    commands where the generator reads them), so a hand value cannot override a code fact;
 *  - no cell holds a newline; `since: 'X.Y.Z'` puts "Since X.Y.Z." at the start of the "What" cell.
 *
 * Facts copied by hand because the code keeps them inline (no exported constant to read): the
 * serve_port fallback of 8080, the trusted_proxies limit of 16, the port range 1 to 65535, the
 * match.platform names, and the 20 backups kept. They are listed in the test's residual notes.
 */

const ADR_57 = '[ADR 0057](../decisions/0057-windows-desktop-app.md), section 8';

function deepFreeze(value) {
  for (const inner of Object.values(value)) if (inner && typeof inner === 'object') deepFreeze(inner);
  return Object.freeze(value);
}

module.exports = deepFreeze({
  'config-top': {
    config_version: {
      type: 'whole number',
      default: 'Required',
      what: 'The version of the settings format. A file with a higher number than this program understands is refused, never half read.',
      changedBy: 'GM-Scriptorium writes it',
    },
    default_campaign: {
      type: 'text',
      default: 'None',
      what: 'The campaign used when you name none on the command line.',
      changedBy: '`config set-default`, the admin panel, or by hand',
    },
    campaigns: {
      type: 'table',
      default: 'None',
      what: 'One table per campaign, named by you: `[campaigns.lease]`. See the campaign table below.',
      changedBy: '`config add`, `config remove`, `init`, the admin panel, or by hand',
    },
    remote: {
      type: 'table',
      default: 'Absent means local only',
      what: 'Remote access. See the `[remote]` section below.',
      changedBy: '`remote set`, `remote off`, or by hand',
    },
    update: {
      type: 'table',
      default: 'Absent means checks on',
      what: 'The panel\'s update notice. See the `[update]` section below.',
      changedBy: 'The Updates card in the admin panel, or by hand',
      since: '0.5.0',
    },
    desktop: {
      type: 'table',
      default: 'Absent means the default ports',
      what: 'The ports for the Windows desktop app. See the `[desktop]` section below.',
      changedBy: '`desktop set`',
      since: '0.5.0',
    },
  },

  'config-campaign': {
    vault: {
      default: 'None',
      what: 'The folder holding the campaign\'s notes. A campaign without one cannot be checked or built.',
      changedBy: '`config add`, `init`, the admin panel, or by hand',
    },
    site_config: {
      default: 'None',
      what: 'The campaign\'s `vault.config.json`, which holds the site settings. When it is set it is used, and any campaign pack is ignored.',
      changedBy: '`config add --site-config`, or by hand',
    },
    output: {
      default: 'None',
      what: 'The folder `build` writes the website to. It must be outside the vault.',
      changedBy: '`config add`, `init`, the admin panel, or by hand',
    },
    pack: {
      default: 'None',
      what: 'The campaign pack folder (site settings, stylesheet and images). Without it, GM-Scriptorium looks for `_meta/scriptorium` inside the vault.',
      changedBy: 'By hand',
    },
    serve_port: {
      default: '8080',
      allowed: '1 to 65535',
      what: 'The port `serve` listens on when you do not give `--port`.',
      changedBy: 'By hand',
    },
    paths: {
      type: 'table of tables',
      default: 'None',
      what: 'Per-computer profiles: `[campaigns.lease.paths.<profile>]`. A profile needs a `match` and may set any of the campaign keys above except `paths`. See the profiles section below.',
      changedBy: 'By hand',
    },
  },

  'config-match': {
    platform: {
      type: 'text',
      default: 'Matches any',
      allowed: 'win32, linux, darwin',
      what: 'The operating system, as Node.js names it. `win32` is Windows.',
      changedBy: 'By hand',
    },
    hostname: {
      type: 'text',
      default: 'Matches any',
      allowed: 'Any computer name, such as my-laptop',
      what: 'The computer\'s name. Capital letters do not matter.',
      changedBy: 'By hand',
    },
  },

  'config-remote': {
    mode: {
      type: 'text',
      what: 'How the panel is reached from other devices. `local` is this computer only. `direct` is reserved: it is refused with a message, and `remote set` will not set it.',
      changedBy: '`remote set --mode`, `remote off`, or by hand',
    },
    port: {
      type: 'whole number',
      default: 'None',
      allowed: '1 to 65535',
      what: 'The fixed port for the panel. Every mode except `local` needs it, and it must differ from `preview_port`.',
      changedBy: '`remote set --port`, or by hand',
    },
    preview_port: {
      type: 'whole number',
      default: 'None',
      allowed: '1 to 65535',
      what: 'The fixed port for the preview of the player site. Every mode except `local` needs it.',
      changedBy: '`remote set --preview-port`, or by hand',
    },
    admin_url: {
      type: 'web address',
      default: 'None',
      allowed: 'An https address with no user name or password',
      what: 'The address you type to reach the panel. Needed in the `tailscale`, `proxy` and reserved `direct` modes. Changing the mode drops it.',
      changedBy: '`remote set --admin-url`, or by hand',
    },
    preview_url: {
      type: 'web address',
      default: 'None',
      allowed: 'An https address with no user name or password',
      what: 'The address you type to reach the preview. It must differ from `admin_url`. Changing the mode drops it.',
      changedBy: '`remote set --preview-url`, or by hand',
    },
    bind: {
      type: 'IP address',
      default: 'None',
      allowed: 'One IP address',
      what: 'The address the panel listens on, for the `proxy` mode (and the reserved `direct` mode).',
      changedBy: '`remote set --bind`, or by hand',
    },
    trusted_proxies: {
      type: 'list of IP addresses',
      default: 'None',
      allowed: '1 to 16 addresses, never 0.0.0.0 or ::',
      what: 'The reverse proxies the panel believes, in the `proxy` mode.',
      changedBy: '`remote set --trusted-proxy`, or by hand',
    },
    tls: {
      type: 'text',
      default: 'off',
      what: 'Reserved. This version has no certificate support, so only `off` works, and a `proxy` mode with anything else is refused.',
      changedBy: 'By hand',
    },
    tls_cert: {
      type: 'full path',
      default: 'None',
      allowed: 'An absolute path',
      what: 'Reserved. The certificate file for `tls = "byo"`. Nothing reads it in this version.',
      changedBy: 'By hand',
    },
    tls_key: {
      type: 'full path',
      default: 'None',
      allowed: 'An absolute path',
      what: 'Reserved. The key file for `tls = "byo"`. Nothing reads it in this version.',
      changedBy: 'By hand',
    },
  },

  'config-update': {
    check: {
      type: 'true or false',
      allowed: 'true, false',
      what: 'Whether the admin panel asks GitHub once a day if a newer version is out. `false` turns the notice off and no request is made.',
      changedBy: 'The Updates card in the admin panel, or by hand',
      since: '0.5.0',
    },
    channel: {
      type: 'text',
      default: 'Left to the running build',
      what: 'Which releases the notice offers. `beta` also offers releases that are still being checked.',
      changedBy: 'The Updates card in the admin panel, or by hand',
      since: '0.5.0',
    },
  },

  'config-desktop': {
    port: {
      type: 'whole number',
      allowed: '1 to 65535',
      what: `The panel's port for the Windows desktop app (${ADR_57}). In this version only \`desktop set\` reads and writes it. It must differ from \`preview_port\`.`,
      changedBy: '`desktop set --port`',
      since: '0.5.0',
    },
    preview_port: {
      type: 'whole number',
      allowed: '1 to 65535',
      what: `The preview's port for the Windows desktop app (${ADR_57}). In this version only \`desktop set\` reads and writes it.`,
      changedBy: '`desktop set --preview-port`',
      since: '0.5.0',
    },
    remote_at_signin: {
      type: 'true or false',
      allowed: 'true, false',
      what: 'Records that you agreed remote access may start when you sign in to Windows. GM-Scriptorium sets it only from your own answer to its question. Nothing in this version asks that question or reads it, so leave it out.',
      changedBy: 'Nothing in this version',
      since: '0.5.0',
    },
  },

  'pack-top': {
    theme: {
      type: 'text',
      what: 'The look of the built site. A theme the program does not know stops the build. New campaigns made by `init` get `gloam`; a pack file with no `theme` gets the default shown here.',
      changedBy: 'The Theme screen in the admin panel, `init`, or by hand',
    },
    images: {
      type: 'table',
      default: 'No images',
      what: 'The art for the image slots. See the `[images]` section below.',
      changedBy: 'The Images screen in the admin panel, or by hand',
    },
    labels: {
      type: 'table',
      default: 'The built-in words',
      what: 'The words the built site shows, such as the name of the party. See the `[labels]` section below.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    timeline: {
      type: 'table',
      default: 'The built-in timeline words',
      what: 'How the story timeline reads your timeline page. See the `[timeline]` section below.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    recaps: {
      type: 'table',
      default: 'The built-in heading',
      what: 'How recaps are read. See the `[recaps]` section below.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    gm_link: {
      type: 'table',
      default: 'Absent means no link',
      what: 'Adds one plain "Game master" link to the footer of every published page. See the `[gm_link]` section below.',
      changedBy: 'By hand',
      since: '0.5.0',
    },
  },

  'pack-images': {
    hero: {
      type: 'text',
      default: 'Empty',
      what: 'The landing banner: a wide picture for the top of the landing page. A slot is a place for your art, and it shows only where a theme or your `overrides.css` draws it. See [image slots](../image-slots.md).',
      changedBy: 'The Images screen in the admin panel, or by hand',
    },
    ground: {
      type: 'text',
      default: 'Empty',
      what: 'The page backdrop: a picture fixed behind your pages.',
      changedBy: 'The Images screen in the admin panel, or by hand',
    },
    paper: {
      type: 'text',
      default: 'Empty',
      what: 'The paper texture: a small image repeated behind text and cards.',
      changedBy: 'The Images screen in the admin panel, or by hand',
    },
    'crest-frame': {
      type: 'text',
      default: 'Empty',
      what: 'The emblem frame: a decorative border for faction crests. Use an image with a transparent background.',
      changedBy: 'The Images screen in the admin panel, or by hand',
    },
    portrait: {
      type: 'text',
      default: 'Empty',
      what: 'The character portrait: an upright picture, cropped to fill a 3 to 4 frame.',
      changedBy: 'The Images screen in the admin panel, or by hand',
    },
    '404': {
      type: 'text',
      default: 'Empty',
      what: 'The picture on the page players land on when a link goes nowhere. Write the key in quotes, as `"404"`.',
      changedBy: 'The Images screen in the admin panel, or by hand',
    },
  },

  'pack-labels': {
    learned_lens: {
      type: 'text',
      what: 'The name of the timeline view that shows what the party learned.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    learned_legend: {
      type: 'text',
      what: 'The timeline legend entry for a point where the party learned something.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    story_lens: {
      type: 'text',
      what: 'The name of the timeline view that shows the story.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    chapter: {
      type: 'text',
      what: 'The word used for a chapter on the timeline.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    recap: {
      type: 'text',
      what: 'The word for a session recap.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    recap_learned_link: {
      type: 'text',
      what: 'The text of the link from a recap to what the party learned.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    same_recap: {
      type: 'text',
      what: 'The label for other events in the same recap.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    connections_heading: {
      type: 'text',
      what: 'The heading above the connections section of a page.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_tie: {
      type: 'text',
      what: 'The heading for the group of ties between two pages.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_named: {
      type: 'text',
      what: 'The heading for the group of pages that name this one.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_pc: {
      type: 'text',
      what: 'The heading for the player characters, usually the party.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_npc: {
      type: 'text',
      what: 'The heading for the non-player characters.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_faction: {
      type: 'text',
      what: 'The heading for factions.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_location: {
      type: 'text',
      what: 'The heading for places.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_thing: {
      type: 'text',
      what: 'The heading for things, such as items.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_event: {
      type: 'text',
      what: 'The heading for events.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    group_other: {
      type: 'text',
      what: 'The heading for pages that fit none of the other groups.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
  },

  'pack-timeline': {
    kinds: {
      type: 'list of tables',
      what: 'The kinds of story point, written as `[[timeline.kinds]]` entries. Your list replaces the built-in kinds as a whole, it is not added to them. See the `[[timeline.kinds]]` section below.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    weights: {
      type: 'list of text',
      what: 'The three words for how much a story point matters, from lightest to heaviest. There must be exactly three.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    session_token: {
      type: 'text',
      what: 'A pattern that finds a session number in the text, such as the 3 in S3. It needs at least one capture group, and the first group must catch the number. The pattern is case-sensitive.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    segment_units: {
      type: 'text',
      what: 'A pattern that finds a stretch of time, such as week 2. It needs at least two capture groups: the unit word, then the number. The pattern ignores case.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    columns: {
      type: 'table',
      default: 'The built-in column names',
      what: 'The column names the timeline page uses in your vault. See the `[timeline.columns]` section below.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
  },

  'pack-timeline-kinds': {
    key: {
      type: 'text',
      default: 'Required',
      what: 'The kind\'s name as it is written in your timeline table. A lower-case word of up to 32 characters: a letter, then letters, digits or hyphens. `learned` and `none` are reserved. No two kinds, or their aliases, may share a name.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    label: {
      type: 'text',
      default: 'The key',
      what: 'The word shown for the kind on the site.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    glyph: {
      type: 'text or drawing',
      default: 'The built-in glyph named like the key, if there is one; otherwise none',
      what: 'The small picture for the kind. Use one of the built-in names, or SVG path data starting with `M` or `m`, at most 1024 characters.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    aliases: {
      type: 'list of text',
      default: 'None',
      what: 'Other names a Kind cell may use for this kind. Up to 16.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    before: {
      type: 'true or false',
      default: 'false',
      what: 'Marks the kind as something that happened before the story began. Such points sit at the start of the timeline.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
  },

  'pack-timeline-columns': {
    title: {
      type: 'list of text',
      what: 'The names the Title column of the timeline table may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    kind: {
      type: 'list of text',
      what: 'The names the Kind column may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    weight: {
      type: 'list of text',
      what: 'The names the Weight column may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    place: {
      type: 'list of text',
      what: 'The names the Place column may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    in_game: {
      type: 'list of text',
      what: 'The names the in-game date column may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    when: {
      type: 'list of text',
      what: 'The names the When column may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    real_world: {
      type: 'list of text',
      what: 'The names the real-world date column may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    what: {
      type: 'list of text',
      what: 'The names the What column may go by. Its text becomes the body of the timeline card.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    session: {
      type: 'list of text',
      what: 'The names the Session column of the second table, the one that anchors what the party learned, may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    learned: {
      type: 'list of text',
      what: 'The names the Learned column of that second table may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
    after: {
      type: 'list of text',
      what: 'The names the After column of that second table may go by.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
  },

  'pack-recaps': {
    learned_heading: {
      type: 'text',
      what: 'The heading, inside a recap, above the list of what the party learned. The match ignores capital letters.',
      changedBy: 'The Vocabulary screen in the admin panel, or by hand',
    },
  },

  'pack-gm-link': {
    url: {
      type: 'text',
      default: 'Required when the table is present',
      what: 'The address the "Game master" link opens. It must start with `https://` and be a bare address with no path, no user name and no loopback address. Anyone who can read the site can read this address.',
      changedBy: 'By hand',
      since: '0.5.0',
    },
  },

  'exit-codes': {
    0: {
      whatToDo: 'Nothing. Warnings are shown but do not stop anything.',
    },
    1: {
      whatToDo: 'Read the message. It names what could not be done, such as an unknown command or flag, a port already in use, or an editor that could not start. A stack trace instead of a message is a bug, so report it.',
    },
    2: {
      whatToDo: 'Run `gm-scriptorium check` and fix what it lists. A refused `build` writes nothing.',
    },
    3: {
      whatToDo: 'Read the message. It names the campaign, config file or folder that cannot be used. `gm-scriptorium config list` shows what is registered.',
    },
    4: {
      whatToDo: 'Check that this computer can reach GitHub, then run `gm-scriptorium update --check` again.',
    },
  },

  files: {
    'config.toml': {
      what: 'The settings file: your campaigns, profiles and the `[remote]`, `[update]` and `[desktop]` tables.',
      handEdit: 'Yes, see [the settings file](config-toml.md)',
    },
    'panel/': {
      what: 'The admin panel\'s per-computer files. It holds password hashes, so copy or share it with care.',
      handEdit: 'No',
    },
    'panel/password.json': {
      what: 'The earlier single-password file. It is still read, as the account `gm`, until the first `remote account` command moves it.',
      handEdit: 'No',
    },
    'panel/accounts.json': {
      what: 'The remote-access accounts: each name and a salted hash of its password, never the password itself.',
      handEdit: 'No',
      since: '0.5.0',
    },
    'panel/sessions.json': {
      what: 'Digests of the sign-ins of the devices that are signed in.',
      handEdit: 'No',
    },
    'panel/audit.log': {
      what: 'One line for each remote-access change, with the account name and the result.',
      handEdit: 'No (read it if you like)',
    },
    'tls/': {
      what: 'Reserved. Nothing writes it in this version.',
      handEdit: 'No',
    },
    'tls/generated.pem': {
      what: 'Reserved. Nothing writes it in this version.',
      handEdit: 'No',
    },
    'backups/': {
      what: 'Copies of each campaign\'s `_meta/vault-config.md`, made before the admin panel saves it, in a `campaign-<name>/` folder each. The newest 20 per campaign are kept.',
      handEdit: 'No (delete old ones if you like)',
    },
    'panel-prefs.json': {
      what: 'How you set the admin panel up on this computer, such as its views and pane placement.',
      handEdit: 'No (delete it to reset)',
    },
    'panel/welcome.json': {
      what: 'The campaigns whose welcome message on the Overview has not been dismissed yet.',
      handEdit: 'No',
      since: '0.5.0',
    },
    'panel/update-check.json': {
      what: 'When the panel last asked GitHub about a newer version, and what it found.',
      handEdit: 'No',
      since: '0.5.0',
    },
    'panel/launch-<number>.html': {
      what: 'The one-time sign-in page that opens your browser. It holds the sign-in code for under a minute and is deleted after use. The number is the program\'s process number.',
      handEdit: 'No',
      since: '0.5.0',
    },
  },

  // The command line page (docs/reference/command-line.md). The exit codes, the "takes a value" column and the
  // flags of remote, desktop and serve --admin come from the code. The flags of the config subcommands are
  // given here, because config keeps no list of them.

  'cli-commands': {
    init: {
      what: 'Registers a vault and sets up its publish settings, or creates a new vault first. It only adds files under `_meta/scriptorium/` and never touches the rest of the vault.',
    },
    check: {
      what: 'Reads the vault and reports anything that would leak GM-only material or break the site. It changes nothing.',
    },
    build: {
      what: 'Checks the vault, then writes the player-facing website to the output folder. If the check finds errors it refuses and writes nothing.',
    },
    serve: {
      what: 'Serves the built site on this computer so you can look at it, or with `--admin` opens the admin panel.',
    },
    status: {
      what: 'Shows where a campaign stands: whether the vault is reachable, when the site was last built, the last and next session, file counts and the latest check result. It changes nothing.',
    },
    config: {
      what: 'Manages the list of campaigns GM-Scriptorium knows about. It never needs the vault to be reachable.',
    },
    update: {
      what: 'Downloads the newest release from GitHub and replaces this program with it. On an installed copy on Windows it replaces the tray helper beside it too, and nothing is replaced if either download fails. If the tray app is running, quit it and start it again afterwards.',
    },
    remote: {
      what: 'Changes how the admin panel can be reached from other devices, and manages the accounts that can sign in. See [Remote access](../remote-access.md).',
    },
    desktop: {
      what: 'Saves the two ports the Windows desktop app gives its panel and its preview.',
      since: '0.5.0',
    },
  },

  'cli-global-flags': {
    '--help': {
      what: 'Prints the commands and the global flags. After a command, as in `serve --help`, it prints that command\'s own help and its exit codes.',
    },
    '--version': {
      what: 'Prints the version of this program and the licence notices line, then stops. After `update` it takes a release tag instead (see the table below).',
    },
    '--notices': {
      what: 'Prints the third-party licence notices, then stops.',
    },
    '--config': {
      what: 'Uses this settings file instead of the default one. See [the settings file](config-toml.md).',
    },
    '--json': {
      what: 'Prints machine-readable JSON instead of text. Only `check`, `build`, `status` and `serve` read it; the other commands ignore it, and `init` refuses it. With `serve` it prints one JSON line for each event.',
    },
    '--quiet': {
      what: 'Does nothing. Accepted only so that older scripts that pass it keep working. Leave it out of new scripts.',
    },
    '--no-color': {
      what: 'Output is always plain text, so this changes nothing.',
    },
    '--campaign': {
      what: 'Picks a registered campaign. It is the same as naming the campaign after the command. `check`, `build`, `status` and `serve` read it; `init` refuses it.',
    },
    '--vault': {
      what: 'Uses this vault folder for this run only. Nothing is saved. `check`, `build`, `status` and `serve` read it. `init` and `config add` take it as the vault to register.',
    },
    '--out': {
      what: 'Uses this output folder for this run only. Nothing is saved. `check`, `build`, `status` and `serve` read it. `init` and `config add` take it as the output folder to register.',
    },
    '--site-config': {
      what: 'Uses this site config for this run only. Nothing is saved. `check`, `build` and `status` read it; `serve` never reads the site config. `config add` can register it with a campaign. `init` refuses it.',
    },
  },

  'cli-flags': {
    'init --name': { what: 'The name to register the campaign under.' },
    'init --title': { what: 'The title of the site.' },
    'init --theme': { what: 'The theme for the site. An unknown theme exits 1 and lists the valid ones.' },
    'init --yes': { what: 'Asks no questions and uses the flags you gave.' },
    'init --new-vault': {
      what: 'Creates a new vault in this folder first, which must not exist yet or must be empty. Nothing is overwritten or removed. Use it with `--system`. It cannot be combined with `--vault`.',
      since: '0.5.0',
    },
    'init --system': {
      what: 'The game system for the new vault, or `none` for no particular system. It is never guessed, and it only works with `--new-vault`.',
      since: '0.5.0',
    },
    'check --graph': { what: 'Also runs the optional relationship graph checks.' },
    'build --force-out': {
      what: 'Builds into the site config\'s own `outputDir`.',
      since: '0.5.0',
    },
    'build --force-check': {
      what: 'Builds even though the check found errors. The output-leak scan still refuses a leak.',
      since: '0.5.0',
    },
    'build --no-check': { what: 'Skips the check step.' },
    'serve --build': { what: 'Builds the site first.' },
    'serve --port': {
      what: 'The port to listen on, 1 to 65535. Plain `serve` also accepts 0 for any free port, and uses the campaign\'s `serve_port` or 8080 when you give none. With `--admin`, leave it out and a free port is chosen for you.',
    },
    'serve --host': {
      what: 'Listens on another address. This exposes the site beyond this computer. `serve --admin` refuses it.',
    },
    'serve --admin': {
      what: 'Opens the admin panel instead of serving the built site, and prints a one-time link. This mode accepts only the flags listed for `serve --admin` in the subcommands table.',
    },
    'serve --preview-port': {
      what: 'With `--admin`, the port for the preview, 1 to 65535. Remote access uses its saved ports.',
    },
    'update --check': { what: 'Only says whether a newer release exists.' },
    'update --pre': { what: 'Includes pre-releases.' },
    'update --version': {
      what: 'Installs that exact release, as in `update --version <tag>`. Everywhere else `--version` prints the version.',
    },
    'remote --mode': {
      what: 'For `remote set`: `local`, `ssh`, `tailscale` or `proxy`. Changing it drops the old addresses unless you give new ones.',
    },
    'remote --admin-url': { what: 'For `remote set`: the https address the admin panel is reached at.' },
    'remote --preview-url': { what: 'For `remote set`: the https address the preview is reached at.' },
    'remote --bind': { what: 'For `remote set`: the IP address the panel listens on, for the `proxy` mode.' },
    'remote --trusted-proxy': { what: 'For `remote set`: the address of your reverse proxy. Give several as a comma-separated list.' },
    'remote --port': { what: 'For `remote set`: the port for the admin panel.' },
    'remote --preview-port': { what: 'For `remote set`: the port for the preview.' },
    'remote --account': {
      what: 'For `remote signout-all`: signs out only the devices signed in as this account.',
      since: '0.5.0',
    },
    'desktop --port': {
      what: 'For `desktop set`: the port the Windows desktop app gives its panel. See `[desktop]` in [the settings file](config-toml.md).',
      since: '0.5.0',
    },
    'desktop --preview-port': {
      what: 'For `desktop set`: the port the Windows desktop app gives its preview. See `[desktop]` in [the settings file](config-toml.md).',
      since: '0.5.0',
    },
    'desktop --background': {
      what: 'Belongs to a later subcommand; `desktop set` refuses it.',
      since: '0.5.0',
    },
  },

  'cli-subcommands': {
    'config list': {
      flags: '--config',
      what: 'Shows every registered campaign, with its vault and output folder and whether the vault is reachable.',
    },
    'config add': {
      flags: '--config, --vault, --out, --site-config',
      what: 'Registers a campaign, or replaces one of the same name: `config add <name> --vault <path> --out <path>`. It needs `--vault`, and needs `--out` unless the campaign already has an output folder.',
    },
    'config remove': {
      flags: '--config',
      what: 'Forgets a campaign: `config remove <name>`. Nothing on disk is deleted.',
    },
    'config set-default': {
      flags: '--config',
      what: 'Sets the campaign used when you name none: `config set-default <name>`.',
    },
    'config path': {
      flags: '--config',
      what: 'Prints where the settings file lives.',
    },
    'config edit': {
      flags: '--config',
      what: 'Opens the settings file in the editor named by `EDITOR` or `VISUAL`. With neither set, it prints the path instead.',
    },
    'remote show': {
      what: 'Prints the remote-access settings for this computer: the mode, the addresses, where it listens, which accounts exist and whether it is ready to start. It never prints a secret.',
    },
    'remote set': {
      what: 'Saves remote-access settings. Only https addresses are accepted, and every value is checked before anything is written. It takes effect the next time the admin panel starts.',
    },
    'remote account add': {
      what: 'Adds an account: `remote account add <name>`. Names are 1 to 32 letters, digits, dots, hyphens or underscores. The password is asked for with nothing shown on screen, and must be at least 12 characters. There can be at most 8 accounts.',
      since: '0.5.0',
    },
    'remote account change': {
      what: 'Changes an account\'s password: `remote account change <name>`. It asks for the current password first, and signs that account out on every device.',
      since: '0.5.0',
    },
    'remote account reset': {
      what: 'Sets a new password when the old one is forgotten: `remote account reset <name>`. It needs no current password, and signs that account out on every device.',
      since: '0.5.0',
    },
    'remote account remove': {
      what: 'Deletes an account: `remote account remove <name>`. It signs that account out on every device.',
      since: '0.5.0',
    },
    'remote account rename': {
      what: 'Gives an account a new name: `remote account rename <old> <new>`. It signs that account out on every device.',
      since: '0.5.0',
    },
    'remote account list': {
      what: 'Shows the account names and dates. It never shows a secret.',
      since: '0.5.0',
    },
    'remote password': {
      what: 'The earlier command, kept so existing notes still work. It sets or changes the password of the account named `gm`, adding the account if it is not there, and signs every remote device out. Use `remote account` for other accounts.',
    },
    'remote signout-all': {
      what: 'Signs every remote device out at once, or with `--account` only the devices signed in as that account. A running panel notices straight away.',
    },
    'remote off': {
      what: 'Returns the mode to `local`, signs every device out and clears every account.',
    },
    'desktop set': {
      what: 'Saves the two ports for the Windows desktop app: `desktop set --port 7500 --preview-port 7501`. Give at least one, and a port you leave out keeps its current value. They must be different whole numbers from 1 to 65535, and nothing is written until both are checked. It changes only the `[desktop]` part of the settings file.',
      since: '0.5.0',
    },
    'serve --admin': {
      what: 'Opens the admin panel on this computer only. Every other flag, such as `--host`, `--build`, `--out` or `--site-config`, is refused with exit 1. This is a mode of `serve` and not a subcommand; it is listed here because it narrows the flags the same way.',
    },
  },
});
