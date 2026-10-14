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
  'docs/reference/pack-toml.md',
  'docs/reference/vault-config.md',
  'docs/reference/check-messages.md',
]);

/** Which blocks each page holds, so a block in the wrong page, or a page missing one, is caught. */
const BLOCKS_BY_TARGET = Object.freeze({
  'docs/reference/config-toml.md': ['config-top', 'config-campaign', 'config-match', 'config-remote', 'config-update', 'config-desktop'],
  'docs/reference/exit-codes.md': ['exit-codes'],
  'docs/reference/files-and-folders.md': ['files'],
  'docs/reference/command-line.md': ['cli-commands', 'cli-global-flags', 'cli-flags', 'cli-subcommands'],
  'docs/reference/pack-toml.md': ['pack-top', 'pack-images', 'pack-labels', 'pack-timeline', 'pack-timeline-kinds', 'pack-timeline-columns', 'pack-recaps', 'pack-gm-link'],
  'docs/reference/vault-config.md': ['vault-publish', 'vault-json'],
  'docs/reference/check-messages.md': ['check-messages'],
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
  'vault-publish': Object.freeze([
    ['Key', 'key'],
    ['Type', 'type'],
    ['Default', 'default'],
    ['In the panel', 'panel'],
    ['What it does', 'what'],
  ]),
  'vault-json': Object.freeze([
    ['Key', 'key'],
    ['Type', 'type'],
    ['Required', 'required'],
    ['New campaigns get', 'newCampaigns'],
    ['What it does', 'what'],
    ['Changed by', 'changedBy'],
  ]),
  'check-messages': Object.freeze([
    ['ID', 'key'],
    ['Severity', 'severity'],
    ['Runs in', 'runs'],
    ['What it means', 'what'],
    ['What to do', 'action'],
  ]),
};
for (const name of BLOCK_NAMES) if (name.startsWith('config-') || name.startsWith('pack-')) COLUMNS[name] = CONFIG_COLUMNS;
Object.freeze(COLUMNS);

/** The columns whose values may come from the code. Text may give none of these for a key whose code fact has it. */
const CODE_COLUMNS = Object.freeze(['type', 'default', 'allowed', 'meaning', 'commands', 'exits', 'takesValue', 'flags', 'required', 'newCampaigns', 'panel', 'severity', 'runs']);

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
  const packToml = require('../src/build/packtoml');
  const labels = require('../src/build/labels');
  const themes = require('../src/build/themes');
  const { COVERED_PREFIXES } = require('../src/admin/vaultconfigeffects');
  const { FIELD_SCHEMA, DISPLAY_PATHS } = require('../src/admin/vaultconfigfields');
  const pinned = require('../src/generator/pinned');
  const { composeVaultConfigJson } = require('../src/setup/scaffold');
  const { assertScanKeysPresent } = require('../src/cli/check');
  const { CHECKS } = require('../src/checks/registry');

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

  Object.assign(
    facts,
    packFacts({
      PACK_TOP_LEVEL_KEYS: packToml.PACK_TOP_LEVEL_KEYS,
      DEFAULT_THEME: themes.DEFAULT_THEME,
      THEMES: themes.THEMES,
      SLOT_NAMES: themes.SLOT_NAMES,
      DEFAULT_LABELS: labels.DEFAULT_LABELS,
      DEFAULT_VOCAB: labels.DEFAULT_VOCAB,
      TIMELINE_KEYS: labels.TIMELINE_KEYS,
      KIND_ENTRY_KEYS: labels.KIND_ENTRY_KEYS,
      GLYPH_NAMES: labels.GLYPH_NAMES,
      RECAPS_KEYS: labels.RECAPS_KEYS,
      GM_LINK_KEYS: packToml.GM_LINK_KEYS,
    }),
  );

  Object.assign(
    facts,
    vaultFacts({
      COVERED_PREFIXES,
      FIELD_SCHEMA,
      DISPLAY_PATHS,
      PUBLISH_DEFAULTS: pinned.PUBLISH_DEFAULTS,
      scaffoldJson: JSON.parse(composeVaultConfigJson(pinned.readVaultConfigTemplate(), '')),
      requiredKeys: requiredJsonKeys(assertScanKeysPresent),
      readKeys: JSON_READ_KEYS,
    }),
  );

  facts['check-messages'] = checkFacts({ CHECKS, buildIds: BUILD_FINDING_IDS });

  return facts;
}

/**
 * The finding ids the build makes outside the check registry, with the severity each is made at.
 * A literal here because the source keeps no list; the test scans src/ for id literals to keep the
 * ids honest. The severity is copied by hand (a test compares it with the source).
 */
const BUILD_FINDING_IDS = Object.freeze([Object.freeze({ id: 'build/gm-link-marker', severity: 'error' })]);

/**
 * The check-messages facts: every finding id a GM can see, with its severity and where it runs.
 * The inputs are injected so the logic can be tested with scratch values. A severity that can
 * change per finding is marked "(varies)". The ids of the registry come first, then the build's.
 *
 * @param {{ CHECKS: object[], buildIds: { id: string, severity: string }[] }} input
 * @returns {{ key: string, severity: string, runs: string }[]}
 * @throws a finding id that appears twice
 */
function checkFacts({ CHECKS, buildIds }) {
  const seen = new Set();
  const once = (id) => {
    if (seen.has(id)) throw new Error(`duplicate finding id "${id}"`);
    seen.add(id);
    return id;
  };
  const fromRegistry = CHECKS.map((c) => ({
    key: once(c.id),
    severity: c.defaultSeverity.toUpperCase() + (c.dynamicSeverity ? ' (varies)' : ''),
    runs: c.requiresFlag ? `check ${c.requiresFlag} only` : 'check and build',
  }));
  const fromBuild = buildIds.map((b) => ({ key: once(b.id), severity: b.severity.toUpperCase(), runs: 'build only' }));
  return [...fromRegistry, ...fromBuild];
}

/**
 * The keys the source reads from a vault.config.json, through `jsonConfig.`, `siteConfig.` or
 * `userJsonConfig.`. A literal here because the source keeps no list; the test scans src/ both ways
 * to keep it honest. A read through any other variable name is invisible to that scan.
 */
const JSON_READ_KEYS = Object.freeze([
  'attachmentsDir',
  'backend',
  'excludeCallouts',
  'excludeDirs',
  'excludeFields',
  'excludeSections',
  'folderMap',
  'outputDir',
  'searchEnabled',
  'siteTitle',
  'vaultPath',
]);

/**
 * The keys vault.config.json must have, read by asking the real validator (as cliFacts asks
 * validateFlags): an empty config throws "is missing required key(s) a and b".
 *
 * @param {(config: object, file: string, campaign: string) => void} assertFn
 * @returns {string[]} the required keys, or [] when an empty config passes
 * @throws any error that is not a missing-keys message
 */
function requiredJsonKeys(assertFn) {
  try {
    assertFn({}, 'vault.config.json', 'probe');
    return [];
  } catch (e) {
    const m = /is missing required keys? (.+)$/.exec(e.message);
    if (m === null) throw e;
    return m[1].split(' and ');
  }
}

/** A string, number or boolean becomes its text, a non-empty array of strings its items joined by commas; anything else (null, empty, an object) has no code value. */
function plainValue(v) {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return v.join(', ');
  return undefined;
}

/**
 * The vault-config.md and vault.config.json facts: which keys exist (the panel's lists, and the
 * keys the program reads, writes or requires), their types where the panel names them, their
 * defaults, and what a new campaign gets. The inputs are injected so the logic can be tested with
 * scratch values.
 *
 * @returns {{ 'vault-publish': object[], 'vault-json': object[] }}
 * @throws a publish path that does not start with "publish."
 */
function vaultFacts({ COVERED_PREFIXES, FIELD_SCHEMA, DISPLAY_PATHS, PUBLISH_DEFAULTS, scaffoldJson, requiredKeys, readKeys }) {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const TYPE_OF_KIND = { list: 'list of text', int: 'whole number', string: 'text' };
  const strip = (p) => {
    if (!p.startsWith('publish.')) throw new Error(`the path "${p}" does not start with "publish."`);
    return p.slice('publish.'.length);
  };
  const schemaByKey = new Map(FIELD_SCHEMA.map((f) => [strip(f.path), f]));
  const displayByKey = new Map(DISPLAY_PATHS.map((d) => [strip(d.path), d]));
  const publishKeys = [...new Set([...COVERED_PREFIXES, ...FIELD_SCHEMA.map((f) => f.path), ...DISPLAY_PATHS.map((d) => d.path)].map(strip))];
  const defaultAt = (key) => {
    let v = PUBLISH_DEFAULTS;
    for (const part of key.split('.')) {
      if (v === null || typeof v !== 'object' || !own(v, part)) return undefined;
      v = v[part];
    }
    return plainValue(v);
  };
  const publishRows = publishKeys.map((key) => {
    const row = { key };
    const field = schemaByKey.get(key);
    const type = field === undefined ? undefined : TYPE_OF_KIND[field.kind];
    if (type !== undefined) row.type = type;
    const dflt = defaultAt(key);
    if (dflt !== undefined) row.default = dflt;
    if (field !== undefined) row.panel = `${field.label} (edit)`;
    else if (displayByKey.has(key)) row.panel = `${displayByKey.get(key).label} (shown)`;
    return row;
  });

  const jsonKeys = [...new Set([...Object.keys(scaffoldJson), ...requiredKeys, ...readKeys])];
  const jsonRows = jsonKeys.map((key) => {
    const row = { key, required: requiredKeys.includes(key) ? 'yes' : 'no' };
    const v = own(scaffoldJson, key) ? plainValue(scaffoldJson[key]) : undefined;
    if (v !== undefined) row.newCampaigns = v;
    return row;
  });
  return { 'vault-publish': publishRows, 'vault-json': jsonRows };
}

/**
 * The pack.toml facts that come from the parser's own constants. The inputs are injected so the
 * logic can be tested with scratch values. A regular expression's default is its source in a code
 * span; renderBlock escapes any pipe in it.
 *
 * @returns {object} the eight pack-* blocks
 */
function packFacts({ PACK_TOP_LEVEL_KEYS, DEFAULT_THEME, THEMES, SLOT_NAMES, DEFAULT_LABELS, DEFAULT_VOCAB, TIMELINE_KEYS, KIND_ENTRY_KEYS, GLYPH_NAMES, RECAPS_KEYS, GM_LINK_KEYS }) {
  const code = (re) => '`' + re.source + '`';
  const timelineDefault = {
    kinds: DEFAULT_VOCAB.kinds.map((k) => k.key).join(', '),
    weights: DEFAULT_VOCAB.weights.join(', '),
    session_token: code(DEFAULT_VOCAB.sessionToken),
    segment_units: code(DEFAULT_VOCAB.segmentUnits),
  };
  return {
    'pack-top': PACK_TOP_LEVEL_KEYS.map((key) =>
      key === 'theme' ? { key, default: DEFAULT_THEME, allowed: Object.keys(THEMES).sort().join(', ') } : { key },
    ),
    'pack-images': SLOT_NAMES.map((key) => ({ key })),
    'pack-labels': Object.keys(DEFAULT_LABELS).map((key) => ({ key, default: DEFAULT_LABELS[key] })),
    'pack-timeline': TIMELINE_KEYS.map((key) => (timelineDefault[key] === undefined ? { key } : { key, default: timelineDefault[key] })),
    'pack-timeline-kinds': KIND_ENTRY_KEYS.map((key) => (key === 'glyph' ? { key, allowed: GLYPH_NAMES.join(', ') } : { key })),
    'pack-timeline-columns': Object.keys(DEFAULT_VOCAB.columns).map((key) => ({ key, default: DEFAULT_VOCAB.columns[key].join(', ') })),
    'pack-recaps': RECAPS_KEYS.map((key) => (key === 'learned_heading' ? { key, default: DEFAULT_VOCAB.learnedHeading } : { key })),
    'pack-gm-link': GM_LINK_KEYS.map((key) => ({ key })),
  };
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

module.exports = { TARGETS, BLOCKS_BY_TARGET, BLOCK_NAMES, COLUMNS, beginLine, endLine, blockNamesIn, codeFacts, cliFacts, subcommandFacts, packFacts, vaultFacts, requiredJsonKeys, JSON_READ_KEYS, checkFacts, BUILD_FINDING_IDS, rows, renderBlock, fillBlocks, staleTargets, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
