'use strict';

/*
 * Per-command help (QA F08). `gm-scriptorium <command> --help` used to print the global usage
 * block for every command. Each entry says what the command does, its flags, and the exit codes
 * it can end with. The exit-code table is the frozen one in src/util/exitcodes.js; nothing here
 * changes it.
 */

const COMMON_FLAGS = [
  '  --config <path>   use this config file instead of the default one',
  '  --campaign <name> pick a registered campaign (same as the positional name)',
  '  --json            print machine-readable JSON instead of text',
  '  --no-color        plain text, no colour',
];

const EXIT_LINES = {
  0: '  0  success, or warnings only',
  1: '  1  Scriptorium could not do what you asked (see the message); also used for unexpected failures',
  2: '  2  the vault has errors (check found problems, or build refused and wrote nothing)',
  3: '  3  the campaign, its config or its vault cannot be used: no campaign registered, unknown campaign, missing or malformed config, vault missing or not a gm-apprentice vault, output folder missing or inside the vault',
  4: '  4  update cannot run (gh missing or not signed in, or no such release)',
};

function exits(codes) {
  return ['Exit codes:', ...codes.map((c) => EXIT_LINES[c])].join('\n');
}

const HELP_BY_COMMAND = {
  init: [
    'gm-scriptorium init [--name <name>] [--vault <path>] [--out <path>] [--title <text>] [--theme <name>] [--yes]',
    '',
    'Walks you through registering a vault and scaffolding its publish settings. It only adds files',
    'under _meta/scriptorium/ inside the vault and never touches the rest of it. With --yes it asks',
    'no questions and uses the flags you gave.',
    '',
    'Example: gm-scriptorium init --vault ~/campaigns/lease --name lease --out ~/sites/lease --yes',
    '',
    exits([0, 1, 3]),
  ],
  check: [
    'gm-scriptorium check [campaign] [--graph] [--json] [--no-color]',
    '',
    'Reads the vault and reports anything that would leak GM-only material or break the site. It',
    'changes nothing. Run it before every build.',
    '',
    'Flags:',
    '  --graph   also run the optional relationship graph checks',
    ...COMMON_FLAGS.slice(0, 2),
    '',
    'Example: gm-scriptorium check lease',
    '',
    exits([0, 1, 2, 3]),
  ],
  build: [
    'gm-scriptorium build [campaign] [--no-check] [--force] [--out <path>] [--json]',
    '',
    'Checks the vault, then writes the player-facing website to the output folder. If the check',
    'finds errors it refuses and writes nothing.',
    '',
    'Flags:',
    '  --no-check   skip the check step',
    '  --force      build even though the check found errors',
    '  --out <path> write the site here for this run only (not saved)',
    ...COMMON_FLAGS.slice(0, 2),
    '',
    'Example: gm-scriptorium build lease',
    '',
    exits([0, 1, 2, 3]),
  ],
  serve: [
    'gm-scriptorium serve [campaign] [--build] [--port N] [--host ADDR]',
    'gm-scriptorium serve [campaign] --admin [--port N]',
    '',
    'Serves the built site on http://127.0.0.1:8080 by default so you can look at it. With --admin',
    'it opens the admin panel instead and prints a one-time link; that mode only listens on this',
    'computer. Stop either with Ctrl-C.',
    '',
    'Flags:',
    '  --build      build the site first',
    '  --port N     port number, 1 to 65535. Plain serve also accepts 0 for any free port;',
    '               with --admin, leave --port out and a free port is chosen for you',
    '  --host ADDR  listen on another address (this exposes the site beyond this computer)',
    '  --admin      open the admin panel',
    '',
    'Example: gm-scriptorium serve lease --build --port 8081',
    '',
    exits([0, 1, 3]),
  ],
  status: [
    'gm-scriptorium status [campaign] [--json]',
    '',
    'Shows where a campaign stands: whether the vault is reachable, when the site was last built,',
    'the last and next session, file counts and the latest check result. It changes nothing.',
    '',
    'Example: gm-scriptorium status lease',
    '',
    exits([0, 1, 3]),
  ],
  config: [
    'gm-scriptorium config <subcommand>',
    '',
    'Manages the list of campaigns Scriptorium knows about.',
    '',
    'Subcommands:',
    '  list                              show every registered campaign',
    '  add <name> --vault <path> [--out <path>] [--site-config <path>]',
    '                                    register (or replace) a campaign',
    '  remove <name>                     forget a campaign; nothing on disk is deleted',
    '  set-default <name>                the campaign used when you name none',
    '  path                              print where the config file lives',
    '  edit                              open the config file in $EDITOR',
    '',
    'Example: gm-scriptorium config add lease --vault ~/campaigns/lease --out ~/sites/lease',
    '',
    exits([0, 1, 3]),
  ],
  update: [
    'gm-scriptorium update [--check] [--pre] [--version TAG]',
    '',
    'Downloads the newest release and replaces this program with it. It needs the GitHub command',
    'line tool (gh) installed and signed in.',
    '',
    'Flags:',
    '  --check        only say whether a newer release exists',
    '  --pre          include pre-releases',
    '  --version TAG  install that exact release',
    '',
    exits([0, 1, 4]),
  ],
};

/** @returns {string|null} the help text for a command, or null when the name is not a command */
function commandHelp(command) {
  const lines = HELP_BY_COMMAND[command];
  return lines ? lines.join('\n') + '\n' : null;
}

module.exports = { commandHelp, HELP_BY_COMMAND };
