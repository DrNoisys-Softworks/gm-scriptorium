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
});
