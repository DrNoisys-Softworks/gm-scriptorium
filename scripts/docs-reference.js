#!/usr/bin/env node
'use strict';

/*
 * Generates the tables on the reference pages in docs/reference/ from the code.
 *
 *   node scripts/docs-reference.js           write the tables
 *   node scripts/docs-reference.js --check   exit 1, naming the stale pages, if any table is out of date
 *
 * Each column comes from the code where the code holds it (the key lists, the defaults, the allowed
 * values, the exit-code meanings and the commands that return each code), and otherwise from
 * scripts/docs-reference-text.js. Never both: a column the code holds that the text also gives is an
 * error, so a hand-written value can never override a code fact. A code key with no text, and a text
 * key the code does not have, are errors too.
 *
 * A generated table sits between two comments:
 *   <!-- BEGIN GENERATED name: edit scripts/docs-reference-text.js, then run npm run docs-reference -->
 *   <!-- END GENERATED name -->
 * Everything outside the comments is hand-written and left byte for byte as it is.
 *
 * Pattern: scripts/generate-notices.js and scripts/notices-freshness.js. Not part of packaging,
 * because the docs are not shipped.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const TARGETS = Object.freeze([
  'docs/reference/config-toml.md',
  'docs/reference/exit-codes.md',
  'docs/reference/files-and-folders.md',
  'docs/reference/command-line.md',
]);

/** Which blocks each page holds, so a block in the wrong page, or a page missing one, is caught. */
const BLOCKS_BY_TARGET = Object.freeze({
  'docs/reference/config-toml.md': ['config-top', 'config-campaign', 'config-match', 'config-remote', 'config-update', 'config-desktop'],
  'docs/reference/exit-codes.md': ['exit-codes'],
  'docs/reference/files-and-folders.md': ['files'],
  'docs/reference/command-line.md': ['cli-commands', 'cli-global-flags', 'cli-flags', 'cli-subcommands'],
});

const BLOCK_NAMES = Object.freeze(Object.values(BLOCKS_BY_TARGET).flat());

const CONFIG_COLUMNS = Object.freeze([
  ['Key', 'key'],
  ['Type', 'type'],
  ['Default', 'default'],
  ['Allowed values', 'allowed'],
  ['What it does', 'what'],
  ['Changed by', 'changedBy'],
]);
const COLUMNS = {
  'exit-codes': Object.freeze([
    ['Code', 'key'],
    ['Meaning', 'meaning'],
    ['Commands that can return it', 'commands'],
    ['What to do', 'whatToDo'],
  ]),
  files: Object.freeze([
    ['Path', 'key'],
    ['What it holds', 'what'],
    ['Edit by hand?', 'handEdit'],
  ]),
  'cli-commands': Object.freeze([
    ['Command', 'key'],
    ['What it does', 'what'],
    ['Exit codes', 'exits'],
  ]),
  'cli-global-flags': Object.freeze([
    ['Flag', 'key'],
    ['Takes a value', 'takesValue'],
    ['What it does', 'what'],
  ]),
  'cli-flags': Object.freeze([
    ['Flag', 'key'],
    ['Takes a value', 'takesValue'],
    ['What it does', 'what'],
  ]),
  'cli-subcommands': Object.freeze([
    ['Subcommand', 'key'],
    ['Flags it accepts', 'flags'],
    ['What it does', 'what'],
  ]),
};
for (const name of BLOCK_NAMES) if (name.startsWith('config-')) COLUMNS[name] = CONFIG_COLUMNS;
Object.freeze(COLUMNS);

/** The columns whose values may come from the code. Text may give none of these for a key whose code fact has it. */
const CODE_COLUMNS = Object.freeze(['type', 'default', 'allowed', 'meaning', 'commands', 'exits', 'takesValue', 'flags']);

const BEGIN_RE = /^<!-- BEGIN GENERATED ([a-z-]+): edit scripts\/docs-reference-text\.js, then run npm run docs-reference -->$/;
const END_RE = /^<!-- END GENERATED ([a-z-]+) -->$/;
const beginLine = (name) => `<!-- BEGIN GENERATED ${name}: edit scripts/docs-reference-text.js, then run npm run docs-reference -->`;
const endLine = (name) => `<!-- END GENERATED ${name} -->`;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** The facts only the code holds, per block. Requires are inside so a failed require names the block. */
function codeFacts() {
  const schema = require('../src/config/schema');
  const remote = require('../src/remote/settings');
  const update = require('../src/config/updatesettings');
  const desktop = require('../src/config/desktopsettings');
  const { EXIT_CODES } = require('../src/util/exitcodes');
  const { EXIT_LINES, HELP_BY_COMMAND, commandHelp } = require('../src/cli/help');
  const { remotePaths } = require('../src/remote/paths');
  const { defaultConfigPath } = require('../src/config/location');
  const { BACKUPS_DIRNAME } = require('../src/config/machinedir');
  const { PREFS_FILE } = require('../src/admin/prefs');
  const welcome = require('../src/admin/welcome');
  const updateNotice = require('../src/admin/updatenotice');
  const { launcherPath } = require('../src/launch/launcherfile');
  const args = require('../src/cli/args');
  const remoteCli = require('../src/cli/remote');
  const desktopCli = require('../src/cli/desktop');
  const configCli = require('../src/cli/config');
  const { ADMIN_ALLOWED_FLAGS } = require('../src/cli/serve-admin');

  const facts = {};

  facts['config-top'] = schema.TOP_LEVEL_KEYS.map((key) =>
    key === 'config_version' ? { key, allowed: String(schema.CONFIG_VERSION) } : { key },
  );

  facts['config-campaign'] = [
    ...schema.CAMPAIGN_STRING_FIELDS.map((key) => ({ key, type: 'text' })),
    ...schema.CAMPAIGN_INTEGER_FIELDS.map((key) => ({ key, type: 'whole number' })),
    { key: 'paths' }, // the profile tables; a literal here because the schema keeps no name for it
  ];

  facts['config-match'] = schema.MATCH_KEYS.map((key) => ({ key }));

  const remoteDefault = remote.parseRemoteTable(undefined);
  facts['config-remote'] = remote.REMOTE_KEYS.map((key) => {
    if (key === 'mode') {
      return {
        key,
        default: remoteDefault.mode,
        allowed: remote.REMOTE_MODES.map((m) => (remote.SETTABLE_MODES.includes(m) ? m : `${m} (reserved)`)).join(', '),
      };
    }
    if (key === 'tls') return { key, allowed: remote.TLS_CHOICES.join(', ') };
    return { key };
  });

  const updateDefault = update.parseUpdateTable(undefined);
  facts['config-update'] = update.UPDATE_KEYS.map((key) => {
    if (key === 'check') return { key, default: String(updateDefault.check) };
    if (key === 'channel') return { key, allowed: update.CHANNELS.join(', ') };
    return { key };
  });

  const desktopDefault = desktop.parseDesktopTable(undefined);
  const DESKTOP_DEFAULT_FIELD = { port: 'port', preview_port: 'previewPort', remote_at_signin: 'remoteAtSignin' };
  facts['config-desktop'] = desktop.DESKTOP_KEYS.map((key) => {
    const field = DESKTOP_DEFAULT_FIELD[key];
    return field === undefined ? { key } : { key, default: String(desktopDefault[field]) };
  });

  facts['exit-codes'] = Object.values(EXIT_CODES).map((code) => {
    const commands = Object.keys(HELP_BY_COMMAND)
      .filter((name) => exitCodesOfHelp(commandHelp(name)).includes(code))
      .sort();
    return { key: String(code), meaning: EXIT_LINES[code].replace(/^\s*\d+\s+/, ''), commands: commands.join(', ') };
  });

  const scratch = path.resolve('docs-reference-scratch', 'config.toml');
  const paths = remotePaths(scratch);
  const rel = (abs, folder) => toPosix(path.relative(paths.configDir, abs)) + (folder ? '/' : '');
  const files = [path.basename(defaultConfigPath({ platform: 'linux', env: {}, home: '/h' }))];
  for (const [name, abs] of Object.entries(paths)) {
    if (name === 'configDir') continue;
    files.push(rel(abs, name === 'panelDir' || name === 'tlsDir'));
  }
  files.push(`${BACKUPS_DIRNAME}/`);
  files.push(PREFS_FILE);
  files.push(`panel/${welcome.FILE}`);
  files.push(`panel/${updateNotice.FILE}`);
  files.push(`panel/${path.basename(launcherPath('/x', '<number>'))}`);
  facts.files = files.map((key) => ({ key }));

  Object.assign(
    facts,
    cliFacts({
      COMMAND_FLAGS: args.COMMAND_FLAGS,
      COMMON_FLAGS: args.COMMON_FLAGS,
      VALUE_FLAGS: args.VALUE_FLAGS,
      validateFlags: args.validateFlags,
      HELP_BY_COMMAND,
      commandHelp,
    }),
  );
  facts['cli-subcommands'] = subcommandFacts({
    configSubs: configCli.SUBCOMMANDS,
    remoteSubs: remoteCli.SUBCOMMANDS,
    accountVerbs: remoteCli.ACCOUNT_VERBS,
    remoteAllowed: remoteCli.ALLOWED_FLAGS,
    desktopAllowed: desktopCli.ALLOWED_FLAGS,
    adminAllowed: ADMIN_ALLOWED_FLAGS,
  });

  return facts;
}

/**
 * The command line facts that come from the flag tables and the help texts. The inputs are injected
 * so the logic can be tested with scratch tables.
 *
 * takesValue is read by asking the real validator (validateFlags(command, { flag: true })): a flag that
 * needs a value throws "needs a value". That way the one special case (update --version) is never copied by hand.
 *
 * @returns {{ 'cli-commands': object[], 'cli-global-flags': object[], 'cli-flags': object[] }}
 * @throws a command with a flag table but no help, or help but no flag table
 */
function cliFacts({ COMMAND_FLAGS, COMMON_FLAGS, VALUE_FLAGS, validateFlags, HELP_BY_COMMAND, commandHelp }) {
  const commands = Object.keys(COMMAND_FLAGS);
  for (const cmd of commands) {
    if (!Object.prototype.hasOwnProperty.call(HELP_BY_COMMAND, cmd)) throw new Error(`command "${cmd}" has flags in COMMAND_FLAGS but no help in HELP_BY_COMMAND`);
  }
  for (const cmd of Object.keys(HELP_BY_COMMAND)) {
    if (!Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, cmd)) throw new Error(`command "${cmd}" has help in HELP_BY_COMMAND but no flags in COMMAND_FLAGS`);
  }
  const probe = (cmd, flag) => {
    try {
      validateFlags(cmd, { [flag]: true });
      return false;
    } catch (e) {
      if (/needs a value/.test(e.message)) return true;
      throw e;
    }
  };
  const yesNo = (b) => (b ? 'yes' : 'no');

  const flagRows = [];
  for (const cmd of commands) {
    for (const f of COMMAND_FLAGS[cmd]) {
      if (!COMMON_FLAGS.includes(f)) flagRows.push({ key: `${cmd} --${f}`, takesValue: yesNo(probe(cmd, f)) });
    }
    for (const f of COMMON_FLAGS) {
      if (COMMAND_FLAGS[cmd].includes(f) && probe(cmd, f) !== VALUE_FLAGS.has(f)) flagRows.push({ key: `${cmd} --${f}`, takesValue: yesNo(probe(cmd, f)) });
    }
  }
  return {
    'cli-commands': commands.map((cmd) => ({ key: cmd, exits: exitCodesOfHelp(commandHelp(cmd)).join(', ') })),
    'cli-global-flags': COMMON_FLAGS.map((f) => ({ key: `--${f}`, takesValue: yesNo(VALUE_FLAGS.has(f)) })),
    'cli-flags': flagRows,
  };
}

/**
 * The subcommand rows: config's, remote's (with the account verbs expanded), desktop's, and the
 * `serve --admin` mode, which narrows the flags the same way. Flags come from each allow-list; the
 * config subcommands have no allow-list, so their text gives the flags.
 *
 * @throws a remote subcommand with no allow-list entry
 */
function subcommandFacts({ configSubs, remoteSubs, accountVerbs, remoteAllowed, desktopAllowed, adminAllowed }) {
  const flagsOf = (list) => list.map((f) => `--${f}`).join(', ');
  const out = configSubs.map((s) => ({ key: `config ${s}` }));
  for (const s of remoteSubs) {
    if (!Object.prototype.hasOwnProperty.call(remoteAllowed, s)) throw new Error(`remote subcommand "${s}" has no entry in the remote ALLOWED_FLAGS`);
    const flags = flagsOf(remoteAllowed[s]);
    if (s === 'account') for (const v of accountVerbs) out.push({ key: `remote account ${v}`, flags });
    else out.push({ key: `remote ${s}`, flags });
  }
  for (const s of Object.keys(desktopAllowed)) out.push({ key: `desktop ${s}`, flags: flagsOf(desktopAllowed[s]) });
  out.push({ key: 'serve --admin', flags: flagsOf(adminAllowed) });
  return out;
}

/** The exit codes listed in the `Exit codes:` block at the end of a help text. */
function exitCodesOfHelp(helpText) {
  const at = helpText.lastIndexOf('Exit codes:');
  if (at === -1) return [];
  return [...helpText.slice(at).matchAll(/^\s*(\d+)\s/gm)].map((m) => Number(m[1]));
}

/**
 * @throws on a code key with no text, a text key the code lacks, or text for a column the code holds
 * @throws a code key with no text, a text key not in the code, or text giving a column the code holds
 */
function rows(block, { facts = codeFacts(), text = require('./docs-reference-text') } = {}) {
  if (!BLOCK_NAMES.includes(block)) throw new Error(`unknown block "${block}"`);
  const fromCode = facts[block];
  const fromText = text[block];
  if (!Array.isArray(fromCode)) throw new Error(`block ${block}: no code facts`);
  if (!fromText || typeof fromText !== 'object') throw new Error(`block ${block}: no text`);
  const codeKeys = fromCode.map((f) => f.key);
  const textKeys = Object.keys(fromText);
  const missing = codeKeys.filter((k) => !textKeys.includes(k));
  if (missing.length > 0) throw new Error(`block ${block}: the code has ${missing.map((k) => `"${k}"`).join(', ')} but scripts/docs-reference-text.js has no entry`);
  const extra = textKeys.filter((k) => !codeKeys.includes(k));
  if (extra.length > 0) throw new Error(`block ${block}: scripts/docs-reference-text.js has ${extra.map((k) => `"${k}"`).join(', ')} but the code does not`);
  const byKey = new Map(fromCode.map((f) => [f.key, f]));
  return textKeys.map((key) => {
    const fact = byKey.get(key);
    const entry = fromText[key];
    for (const col of CODE_COLUMNS) {
      if (fact[col] !== undefined && entry[col] !== undefined) {
        throw new Error(`block ${block}, key "${key}": the code holds "${col}", so the text must not give it`);
      }
    }
    return { ...entry, ...fact };
  });
}

function cell(value, where) {
  const s = value === undefined || value === null || value === '' ? '-' : String(value);
  if (/[\r\n]/.test(s)) throw new Error(`${where}: a table cell must not contain a newline`);
  // A pipe becomes \| . Backslashes right before it are doubled first, so \| in the source stays a backslash then a cell break.
  // A backslash anywhere else is left alone, so a regex in a code span (\bS(\d+)\b) shows as written.
  return s.replace(/(\\*)\|/g, (m, slashes) => `${slashes}${slashes}\\|`);
}

/** Wraps a comma-separated list in backticks, item by item. `direct (reserved)` becomes `direct` (reserved). */
function codeList(value) {
  return String(value)
    .split(', ')
    .map((item) => item.replace(/^(\S+)( \(reserved\))?$/, (m, word, reserved) => `\`${word}\`${reserved || ''}`))
    .join(', ');
}

function renderBlock(block, opts) {
  const columns = COLUMNS[block];
  if (!columns) throw new Error(`unknown block "${block}"`);
  const out = [];
  out.push(`| ${columns.map(([title]) => title).join(' | ')} |`);
  out.push(`|${columns.map(() => '---').join('|')}|`);
  for (const row of rows(block, opts)) {
    const cells = columns.map(([, field]) => {
      const where = `block ${block}, key "${row.key}", ${field}`;
      let value = row[field];
      if (field === 'key') return cell(`\`${row.key}\``, where);
      if (field === 'allowed' || field === 'commands' || field === 'exits' || field === 'flags') return value === undefined || value === '' ? cell(undefined, where) : cell(codeList(value), where);
      if ((field === 'what' || field === 'whatToDo') && row.since !== undefined) {
        value = `*Since ${row.since}.* ${value === undefined ? '' : value}`.trimEnd();
      }
      return cell(value, where);
    });
    out.push(`| ${cells.join(' | ')} |`);
  }
  return out.join('\n');
}

/**
 * Replaces the body of every generated block with `render(name)`. Throws on a block name that is
 * unknown, a BEGIN with no END, a name used twice, a nested BEGIN, or an END with no BEGIN.
 */
function fillBlocks(text, render = renderBlock) {
  const lines = text.split('\n');
  const out = [];
  const seen = new Set();
  let open = null;
  for (const line of lines) {
    const looksBegin = line.startsWith('<!-- BEGIN GENERATED');
    const looksEnd = line.startsWith('<!-- END GENERATED');
    if (looksBegin) {
      const m = BEGIN_RE.exec(line);
      if (!m) throw new Error(`a BEGIN GENERATED line is not in the exact form: ${line}`);
      if (open !== null) throw new Error(`block "${m[1]}" begins inside block "${open}"`);
      if (!BLOCK_NAMES.includes(m[1])) throw new Error(`unknown generated block "${m[1]}"`);
      if (seen.has(m[1])) throw new Error(`generated block "${m[1]}" appears twice`);
      seen.add(m[1]);
      open = m[1];
      out.push(line, render(open));
    } else if (looksEnd) {
      const m = END_RE.exec(line);
      if (!m) throw new Error(`an END GENERATED line is not in the exact form: ${line}`);
      if (open === null || m[1] !== open) throw new Error(`END GENERATED ${m[1]} has no matching BEGIN`);
      open = null;
      out.push(line);
    } else if (open === null) {
      out.push(line);
    }
  }
  if (open !== null) throw new Error(`generated block "${open}" has no END`);
  return out.join('\n');
}

/** The names of the generated blocks a page holds, in order. */
function blockNamesIn(text) {
  return text.split('\n').map((l) => BEGIN_RE.exec(l)).filter(Boolean).map((m) => m[1]);
}

/** Repo-relative paths of the pages whose tables are out of date. */
function staleTargets(root = ROOT) {
  return TARGETS.filter((rel) => {
    const content = fs.readFileSync(path.join(root, rel), 'utf8');
    return content !== fillBlocks(content);
  });
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, out?: (s: string) => void, err?: (s: string) => void }} [deps]
 * @returns {number} the exit code
 */
function main(argv, { root = ROOT, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const check = argv.includes('--check');
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    err(`docs-reference: unknown argument ${unknown[0]}\n`);
    return 1;
  }
  try {
    if (check) {
      const stale = staleTargets(root);
      if (stale.length === 0) {
        out('docs-reference: the reference tables are up to date\n');
        return 0;
      }
      err(`docs-reference: out of date:\n${stale.map((s) => `  ${s}`).join('\n')}\nRun: npm run docs-reference\n`);
      return 1;
    }
    for (const rel of TARGETS) {
      const file = path.join(root, rel);
      const content = fs.readFileSync(file, 'utf8');
      const next = fillBlocks(content);
      if (next !== content) {
        fs.writeFileSync(file, next);
        out(`docs-reference: updated ${rel}\n`);
      } else {
        out(`docs-reference: ${rel} is already up to date\n`);
      }
    }
    return 0;
  } catch (e) {
    err(`docs-reference: ${e.message}\n`);
    return 1;
  }
}

module.exports = { TARGETS, BLOCKS_BY_TARGET, BLOCK_NAMES, COLUMNS, beginLine, endLine, blockNamesIn, codeFacts, cliFacts, subcommandFacts, rows, renderBlock, fillBlocks, staleTargets, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
