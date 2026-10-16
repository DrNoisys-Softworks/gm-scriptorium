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
      what: 'Records that you agreed remote access may start when you sign in to Windows. Without it, the desktop app starts the panel for this computer only at sign-in, whatever mode is saved; a start you make yourself uses the saved mode. `remote set` asks "Also start remote access when you sign in to Windows?" when you switch to a remote mode (the default is No, and no terminal counts as No), and it asks again when you switch to a different remote mode. `remote off` clears it. It counts only on the computer named in `remote_at_signin_pc`.',
      changedBy: 'The answer to the `remote set` question, and `remote off`',
      since: '0.5.0',
    },
    remote_at_signin_pc: {
      type: 'text',
      allowed: 'A computer name',
      what: 'The name of the computer where you agreed that remote access may start at sign-in. The answer in `remote_at_signin` counts only on that computer, so copying your settings folder to another PC does not carry your yes with it: there the desktop app starts for this computer only, and `remote set` asks again. An answer saved without a name counts as no. `remote set` writes it together with the answer, and `remote off` clears both. It is never written to the desktop app\'s log.',
      changedBy: 'The answer to the `remote set` question, and `remote off`',
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

  'vault-publish': {
    mode: {
      type: 'text',
      what: 'Which pages are published. `player` publishes only the pages ticked in `_meta/publish-manifest.md`. The panel shows this key but has no field to change it, because it decides what players can see. Change it in the panel\'s text editor, or by hand.',
    },
    exclude_fields: {
      what: 'Frontmatter fields that are never published, on any page. Joined with `excludeFields` in `vault.config.json`; see how the two files combine, above.',
    },
    exclude_sections: {
      what: 'Headings whose section is removed from every page, at any heading level. Joined with `excludeSections` in `vault.config.json`.',
    },
    exclude_dirs: {
      what: 'Vault folders that are skipped completely. Joined with `excludeDirs` in `vault.config.json`. `check` compares the two lists and says if they differ.',
    },
    exclude_drafts: {
      type: 'true or false',
      what: 'Whether pages with `canon_status: DRAFT` are left out of the site.',
    },
    exclude_callouts: {
      type: 'true or false, or a list of text',
      what: 'Whether callout blocks are removed from pages. When this key is absent, `excludeCallouts` in `vault.config.json` is used instead, and then the default.',
    },
    overrides: {
      type: 'table',
      default: 'No overrides',
      what: 'Per-page exceptions to the hidden fields, under `overrides.fields`. An entry the generator cannot read is dropped.',
    },
    'theme.palette': {
      type: 'table of colours',
      default: 'The built-in colours',
      what: 'The four site colours: `primary`, `accent`, `background` and `text`. The panel shows them but has no field to change them.',
    },
    'theme.fonts': {
      type: 'table',
      default: 'The system font',
      what: 'The heading and body fonts, and where font files come from.',
    },
    'theme.genre': {
      type: 'text',
      default: 'None',
      what: 'A genre preset for the generator\'s look, such as `scifi`.',
    },
    'theme.campaign_image': {
      type: 'text',
      default: 'None',
      what: 'The path, inside the vault, of the campaign picture shown at the top of the landing page. The build copies it even from a hidden folder, because you named it, and `check` then gives a WARN (`leak/l2-excluded-dir-in-output`) so you know it is on the site.',
    },
    banners: {
      type: 'table',
      default: 'None',
      what: 'A picture at the top of a section\'s index page, keyed by the section\'s output folder, such as `locations`. A bare path, or a table with `image`, `link` and `alt`. A section with no entry uses a `_banner` picture, such as `_banner.png`, from its own vault folder. A picture or link you name here is copied even from a hidden folder, and `check` gives a WARN; a `_banner` picture in a hidden folder is an ERROR, and `build` refuses it (`leak/l2-excluded-dir-in-output`).',
    },
    landing: {
      type: 'table',
      default: 'The built-in landing page',
      what: 'The landing page. The keys the panel knows are listed below as `landing.` keys; the generator reads more, which its README describes.',
    },
    'landing.featured_npcs': {
      default: 'None',
      what: 'Characters to feature on the landing page, by name.',
    },
    'landing.quick_links': {
      default: 'None',
      what: 'Pages to link to from the landing page, by name.',
    },
    'landing.max_npcs': {
      what: 'How many characters the landing page shows. The panel accepts 0 to 100.',
    },
    four_oh_four: {
      type: 'table',
      default: 'The built-in not-found page',
      what: 'The page shown for an address that does not exist.',
    },
    'four_oh_four.message': {
      what: 'The line of text on the not-found page. The panel accepts 1 to 300 characters.',
    },
    'theme.tagline': {
      type: 'text',
      default: 'None',
      panel: 'Title & tagline (edit)',
      what: 'The one-line hook on the landing page. It is the only tagline the site shows; `landingTagline` in `vault.config.json` is no longer used.',
    },
  },

  'vault-json': {
    siteTitle: {
      type: 'text',
      what: 'The site\'s name, shown in the navigation bar and as the page title. New campaigns get the title you gave `init`, or the one in `campaign:` in `_meta/vault-config.md`.',
      changedBy: 'The Title & tagline screen in the admin panel, `init`, or by hand',
    },
    landingTagline: {
      type: 'text',
      what: 'An older home of the tagline. The site no longer reads it; use `publish.theme.tagline`. The panel shows a value left here but never writes one.',
      changedBy: '`init` writes it empty. By hand',
    },
    host: {
      type: 'text',
      what: 'Where the generator is told the site will be hosted: `github-pages`, or `cloudflare-pages`. It affects only the generator\'s deploy step. GM-Scriptorium does not read it.',
      changedBy: '`init`, or by hand',
    },
    attachmentsDir: {
      type: 'text',
      what: 'The folder inside the vault that holds images.',
      changedBy: '`init`, or by hand',
    },
    folderMap: {
      type: 'table',
      what: 'Which vault folder becomes which folder on the site. A map with no entries is allowed; the key must be there. New campaigns get the standard folders, and the generator\'s README lists them.',
      changedBy: '`init`, or by hand',
    },
    excludeDirs: {
      type: 'list of text',
      what: 'Vault folders skipped completely. Joined with `publish.exclude_dirs`.',
      changedBy: '`init`, or by hand',
    },
    excludeSections: {
      type: 'list of text',
      what: 'Headings whose section is removed from every page. Joined with `publish.exclude_sections`.',
      changedBy: '`init`, or by hand',
    },
    excludeCallouts: {
      type: 'true or false, or a list of text',
      what: 'Whether callout blocks are removed. Used only when `publish.exclude_callouts` is absent from the vault file.',
      changedBy: '`init`, or by hand',
    },
    backend: {
      type: 'table',
      what: 'Switches for the generator\'s optional site features: `statusBar` and `inbox`. New campaigns get both off.',
      changedBy: '`init`, or by hand',
    },
    banners: {
      type: 'table',
      what: 'An older home of the section banners. The generator still uses an entry here for a section that `publish.banners` in `_meta/vault-config.md` does not mention. GM-Scriptorium reads it to tell a copied banner from an attachment.',
      changedBy: 'By hand',
    },
    excludeFields: {
      type: 'list of text',
      what: 'Frontmatter fields that are never published. Joined with `publish.exclude_fields`. A new campaign has none here, and relies on the defaults.',
      changedBy: 'By hand',
    },
    outputDir: {
      type: 'text',
      what: 'Where the generator would write if you ran it alone. GM-Scriptorium takes the output folder from the settings file instead, and `build` stops if this names the same folder, unless you pass `--force-out`. New campaigns do not get one.',
      changedBy: 'By hand',
    },
    searchEnabled: {
      type: 'true or false',
      what: 'Set to `false` to build without the site search. Absent or anything else means search is on.',
      changedBy: 'By hand',
    },
    vaultPath: {
      type: 'text',
      what: 'Where the generator would look for the vault if you ran it alone. GM-Scriptorium uses the vault from the settings file instead, and `check` says if this names a different folder. New campaigns do not get one.',
      changedBy: 'By hand',
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
    'panel/logs/': {
      what: 'The Windows desktop app\'s log folder. It is private to your account.',
      handEdit: 'No',
      since: '0.5.0',
    },
    'panel/logs/desktop.log': {
      what: 'What the Windows desktop app did: started, stopped, retried, and a plain one-line reason when something failed. It never holds a sign-in code, token, password or cookie, and it is never sent anywhere. At 256 KiB it moves to `desktop.log.1`.',
      handEdit: 'No (read it if you like)',
      since: '0.5.0',
    },
    'panel/logs/desktop.log.1': {
      what: 'The previous `desktop.log`, kept when it reached 256 KiB. The next one replaces it.',
      handEdit: 'No (delete it if you like)',
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
      what: 'Saves the two ports the Windows desktop app gives its panel and its preview. The Windows tray app also runs `desktop run`, which is not meant to be typed.',
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
      what: 'For `desktop run`: the quiet start at sign-in, with no browser tab. `desktop set` refuses it.',
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
      what: 'Saves remote-access settings. Only https addresses are accepted, and every value is checked before anything is written. It takes effect the next time the admin panel starts. On a Windows copy with the tray app, switching to a remote mode also asks whether remote access may start when you sign in to Windows (the default is No).',
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
      what: 'Returns the mode to `local`, signs every device out and clears every account. It also clears the sign-in answer for the Windows desktop app.',
    },
    'desktop run': {
      what: 'The hidden background program the Windows tray app starts: `desktop run --background`. It runs the panel on the desktop ports and talks to the tray app over its standard input and output, so it is not meant to be typed and refuses to run in a terminal or off Windows. With `--background` (the start at sign-in) it is quiet, and it uses this computer only unless you agreed to remote access at sign-in.',
      since: '0.5.0',
    },
    'desktop set': {
      what: 'Saves the two ports for the Windows desktop app: `desktop set --port 7500 --preview-port 7501`. Give at least one, and a port you leave out keeps its current value. They must be different whole numbers from 1 to 65535, and nothing is written until both are checked. It changes only the `[desktop]` part of the settings file.',
      since: '0.5.0',
    },
    'serve --admin': {
      what: 'Opens the admin panel on this computer only. Every other flag, such as `--host`, `--build`, `--out` or `--site-config`, is refused with exit 1. This is a mode of `serve` and not a subcommand; it is listed here because it narrows the flags the same way.',
    },
  },
  'check-messages': {
    'frontmatter/non-yaml-language': {
      what: 'A note opens its frontmatter with a fence that names a language other than YAML, or its first line after the opening `---` has no line break within 65536 bytes, so the language cannot be confirmed. GM-Scriptorium will not read or build that note, because frontmatter in another language can run code.',
      action: 'Open the note and make the first lines plain YAML between two lines of `---`. Nothing overrides this refusal, not even `--force-check` or `--no-check`.',
    },
    'frontmatter/parse-error': {
      what: 'A note\'s frontmatter is not valid YAML, so the site generator would skip the note without a word. This check reports it instead of letting the page vanish.',
      action: 'Fix the YAML at the top of the note. The message gives the parser\'s reason. Common causes are an unclosed quote or a colon in an unquoted value.',
    },
    'frontmatter/missing-type': {
      what: 'A note has no `type:` in its frontmatter. The generator skips such a note, so it never reaches the site, and nothing else says so.',
      action: 'Add a `type:` line, such as `type: npc`, if the note should be on the site. If it is not meant for the site, move it into a folder listed in `excludeDirs`.',
    },
    'census/type': {
      what: 'A count of the typed notes in your vault, and how many of each type. It is information, not a problem.',
      action: 'Nothing. Glance at it to see that the counts look right.',
    },
    'census/unrecognised-type': {
      what: 'A note has a `type:` that is not one of the types the vault knows: the ones in `_meta/entity-types.md`, the folder mapping table, and `character-story`. The generator may not place the note where you expect.',
      action: 'Fix a misspelt type, or add the new type to `_meta/entity-types.md`.',
    },
    'census/session-wrap-hub-unpublished': {
      what: 'A published Wrap-Up is linked to a session note that is not published. The site then has no session page for it: no session badges, no Latest Session recap, and nothing on the timeline or in Connections.',
      action: 'Publish the session note, or keep the recap as a session note instead of a Wrap-Up.',
    },
    'census/session-wrap-link-unpaired': {
      what: 'A published Wrap-Up links to a session, but the link matches more than one note, or a note in another chapter. It is not paired with any session.',
      action: 'Make the link name exactly one session note.',
    },
    'census/session-wrap-learned-missing': {
      what: 'A session note has a learned-items list, but the Wrap-Up paired with it does not. Once they are paired, the session note\'s body is not published, so those items never reach the timeline.',
      action: 'Move the learned-items list into the Wrap-Up.',
    },
    'staleness/story-behind-pc': {
      what: 'A character\'s `_Story` note says it is as of an earlier session than the character\'s main page, so the story has fallen behind. Only whole numbers in `asOfSession` count.',
      action: 'Update the story note, then raise its `asOfSession` to match the main page.',
    },
    'link/unresolved': {
      what: 'A `[[link]]` points at a name that no note has, as a file name or as an alias. On the site it would be a dead link or plain text.',
      action: 'Correct the spelling, or add the missing note, or give a note that alias.',
    },
    'link/in-code': {
      what: 'A `[[link]]` inside a code span or code block does not resolve. Inside code it would not become a link anyway, so this is only a note.',
      action: 'Nothing, unless you meant a real link. Then take it out of the code.',
    },
    'link/ambiguous-target': {
      what: 'Two or more notes answer to the same `[[name]]`, so a link to it could land on either. The message lists the files.',
      action: 'Rename one of the notes, or change its aliases, so each name belongs to one note.',
    },
    'relationship/missing-required': {
      what: 'A note\'s type needs a kind of relationship that the note does not have, according to the "Required relationships" table in `_meta/entity-types.md`. It reports a single INFO line instead if that file or table is missing.',
      action: 'Add the relationship to the note, or change the table if the rule is wrong for your campaign.',
    },
    'relationship/unknown-predicate': {
      what: 'A relationship uses a word that is not in `_meta/relationship-types.md`. The site still shows it, but features that match exact words, such as a faction\'s member list, will not recognise it. It reports a single INFO line instead if the word list cannot be read.',
      action: 'Use the word the message suggests, or add your word to the Types table in `_meta/relationship-types.md`.',
    },
    'vault/unmapped-directory': {
      what: 'A folder has no entry in `folderMap` in `vault.config.json`, so the generator drops every note in it without saying so.',
      action: 'Add the folder to `folderMap` if its notes belong on the site. If not, list it in `excludeDirs`.',
    },
    'config/exclude-sections-divergence': {
      what: 'One of the built-in hidden headings (such as GM Notes) is no longer hidden, because one of your config files gives its own `exclude_sections` list. The built-in list applies only when neither file gives a list of its own. It is an ERROR when that heading really appears on a published page, and a WARN when it does not.',
      action: 'Add the heading named in the message to your list if it should still be hidden.',
    },
    'config/exclude-dirs-divergence': {
      what: 'A folder is hidden in one config file but not in the other. A fresh build honours both lists, so a folder hidden only in `_meta/vault-config.md` is still left out of a new build. A stale build made before you hid it can still hold its pages, and `leak/l2-excluded-dir-in-output` reports those. This is a WARN when only `_meta/vault-config.md` lists the folder, and an INFO when only `vault.config.json` lists it.',
      action: 'Add the folder to the list the message says is missing it, so both files agree. This warning never stops a `build`.',
    },
    'config/exclude-fields-divergence': {
      what: 'One of the built-in hidden fields (such as `gm_notes`) is no longer filtered, because one of your config files gives its own `exclude_fields` list. A list you give replaces the built-in one.',
      action: 'Add the field named in the message to your `exclude_fields` list.',
    },
    'config/site-vault-path-mismatch': {
      what: 'The site config\'s `vaultPath` points at a different folder from the vault GM-Scriptorium is using. The vault from your settings file wins, so this is reported and nothing stops.',
      action: 'Remove `vaultPath` from the site config, or point it at the vault you mean.',
    },
    'config/pack-shadowed': {
      what: 'The campaign sets the older `site_config` key and also has a campaign pack. `site_config` wins, so the pack is ignored.',
      action: 'Remove `site_config` from the campaign in the settings file to build from the pack.',
    },
    'config/theme-scheme-mismatch': {
      what: 'The theme in `pack.toml` is made for a light or dark palette, but the palette in `_meta/vault-config.md` is the other kind. Text and backgrounds may clash.',
      action: 'Set `publish.theme.palette.background` in `_meta/vault-config.md`, or choose another theme in `pack.toml`.',
    },
    'leak/l1-no-manifest': {
      what: 'The mode is `player` but `_meta/publish-manifest.md` is missing. In player mode that file decides which pages are published and which images are copied, so without it every file in the attachments folder would be copied.',
      action: 'Create `_meta/publish-manifest.md` with a `## Publishing` heading and one line for each page players may see. The sample campaign has a complete one.',
    },
    'leak/l2-excluded-dir-in-output': {
      what: 'A page or image in the built site came from a folder you hide, or from one of the always-excluded folders. It is an INFO line instead when there is no build yet to look at. `build` runs this on the new site before it goes live, not on the old site it replaces. A cover picture or section banner is judged by the file it was copied from: one you named in `publish.theme.campaign_image` or `banners` is a WARN and the build goes ahead, and a `_banner` picture the build found by itself is an ERROR. An ERROR stops `build`, and nothing overrides it.',
      action: 'For a cover picture or banner you named, move the file out of the hidden folder or change the setting; building again does not change it. For a `_banner` picture, move it out of the hidden folder or set a banner for that section in `banners`. For anything else, build again: a fresh build leaves hidden folders out and replaces the old site. If the line is still there, read the message for the file, and check `excludeDirs` and `publish.exclude_dirs`.',
    },
    'leak/l3-unpublished-link': {
      what: 'A published page links to a note that is not published, so the link shows as plain text. It is an ERROR when that note is marked `withheld: true`, which means the link may give away a secret, and a WARN otherwise.',
      action: 'Publish the note, remove the link, or leave it if plain text is fine. For an ERROR, take the link out.',
    },
    'leak/l4-hidden-name': {
      what: 'The name of a note marked `withheld: true` (its file name, title or a distinctive alias) appears in the text of a published page, its story note, or its published frontmatter. Players would read it.',
      action: 'Rewrite the sentence, or put it under a hidden heading or in a `gm-only` block. There is no way to suppress this check.',
    },
    'leak/l4-name-collision': {
      what: 'A withheld note\'s name is the same as the title or alias of a published page, so the hidden-name check cannot search for it. It also fires when the withheld note is itself published.',
      action: 'Rename one of them, or stop publishing the withheld note. The message names both files.',
    },
    'leak/l4-output-name': {
      what: 'The name of a withheld note appears in the built site, in a place the source check cannot see: a relationship graph label, an index card, an excerpt, or an image file name. It is an INFO line instead when there is no build yet. `build` runs this on the new site before it goes live, and nothing overrides it.',
      action: 'Find the source of the name from the message, change it, and build again.',
    },
    'leak/l4-index-term': {
      what: 'The name of a withheld note can be found in the site\'s search index, as the name or its possessive or plural form. It is a WARN when the search index cannot be read or is a kind the check does not understand, and an INFO when there is no search index (searching is off). `build` runs this on the new site before it goes live, and nothing overrides it.',
      action: 'Remove the name from the published text it came from, then build again. If search is off on purpose, ignore the INFO.',
    },
    'leak/l5-gm-heading-survives': {
      what: 'A heading that should be hidden is still on a published page. A hidden heading in an unusual form, such as bold or inside a list, can slip past the generator\'s exact match. It also fires when a `gm-only` marker is left in the output, when a heading cannot be read, and when a handout\'s Keeper heading survives.',
      action: 'Write the heading exactly as it appears in your `exclude_sections` list, such as a plain `## GM Notes`, or move the text out of the published page.',
    },
    'leak/l6-comment-withheld': {
      what: 'A published page has one or more Obsidian `%%comments%%`. The build removes every comment before the site is made, so this only tells you text is being withheld.',
      action: 'Nothing. Check that the lines it lists are the ones you meant to hide.',
    },
    'leak/l6-comment-unterminated': {
      what: 'A `%%` comment is opened and never closed. To be safe, the build hides everything from it to the end of the file.',
      action: 'Add the closing `%%` where the comment should end.',
    },
    'leak/l6-comment-in-output': {
      what: 'Text from a `%%comment%%`, or a stray `%%`, reached the built site, including its search index and data. If a data block cannot be read, that is an ERROR too. `build` runs this on the new site before it goes live, and nothing overrides it (ADR 0055).',
      action: 'Fix the note the message names, then build again. Nothing overrides this refusal, so the site is not changed until it is clean.',
    },
    'graph/orphan': {
      what: 'A note has no relationships to any other. It is not always a mistake.',
      action: 'Add a relationship if the note should be linked into the campaign. Otherwise ignore it.',
    },
    'graph/hub-overload': {
      what: 'A note has 12 or more relationships, so it may be doing too much. It is not always a mistake.',
      action: 'Consider splitting the note. Otherwise ignore it.',
    },
    'graph/generic-relationship-type': {
      what: 'A relationship uses a vague word that tells the reader little. If your vault has a relationship word list, the unknown word is reported once by `relationship/unknown-predicate` and not here.',
      action: 'Use a more specific word if one fits.',
    },
    'graph/double-stored-edge': {
      what: 'The same relationship is stored on both notes, which is redundant.',
      action: 'Remove it from one of the two notes.',
    },
    'build/gm-link-marker': {
      what: 'A file in the new site contains the marker the admin panel uses for the GM link. A GM link must never be published. Only `build` makes this, and nothing overrides it (ADR 0055).',
      action: 'Remove the marker from the source it came from, such as a note that pasted it in, then build again. The message names the file.',
    },
  },
});
