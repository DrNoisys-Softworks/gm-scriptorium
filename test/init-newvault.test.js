'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const { runInitCommand } = require('../src/cli/init');
const { parseConfig } = require('../src/config/load');
const { ConfigError, ScriptoriumError, VaultUnreachableError } = require('../src/util/errors');
const { validateFlags } = require('../src/cli/args');
const { FIXTURE_DIR } = require('./helpers/vault-template-fixture');

/*
 * `init --new-vault` and the interactive "Do you already have a vault?" question
 * (docs/decisions/0048-new-campaign-vault.md, section 5). In-process, with injected streams, the
 * fixture starter and a fixed clock. Expected texts are written out by hand. The existing-vault
 * path is covered by the existing init tests, which this change does not touch.
 */

const NOW = () => new Date(2026, 9, 8, 12, 0, 0);
const OPTS = { now: NOW, env: {}, templateDir: FIXTURE_DIR };

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-initnv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture() {
  const lines = [];
  return { lines, output: { write: (s) => lines.push(String(s).replace(/\n$/, '')) } };
}

function streams({ tty = true } = {}) {
  const input = new PassThrough();
  if (tty) input.isTTY = true; // the question is only asked at a terminal
  const output = new PassThrough();
  let written = '';
  output.on('data', (c) => {
    written += c.toString();
  });
  return { input, output, getWritten: () => written };
}

function waitForOutput(getWritten, text, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (getWritten().includes(text)) resolve();
      else if (Date.now() - started > timeout) reject(new Error(`timed out waiting for ${JSON.stringify(text)}; got ${JSON.stringify(getWritten())}`));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

function flagsFor(root, extra = {}) {
  return { yes: true, name: 'fresh', 'new-vault': path.join(root, 'New Campaign'), system: 'dnd-5e-2024', config: path.join(root, 'cfg', 'config.toml'), ...extra };
}

function list(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${r}/` : r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  })(dir, '');
  return out.sort();
}

// --- flags ---------------------------------------------------------------------------------------

test('init accepts --new-vault and --system as flags, and both take a value', () => {
  assert.doesNotThrow(() => validateFlags('init', { 'new-vault': '/x', system: 'none' }));
  assert.throws(() => validateFlags('check', { 'new-vault': '/x' }), /unknown flag --new-vault for "check"/);
});

test('--new-vault together with --vault is refused before anything is asked or written', async (t) => {
  const root = scratch(t);
  const { lines, output } = capture();
  await assert.rejects(
    () => runInitCommand(flagsFor(root, { vault: path.join(root, 'v') }), [], { output, ...OPTS }),
    (err) => err instanceof ConfigError && err.message === 'init takes --vault or --new-vault, not both',
  );
  assert.deepEqual(lines, []);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('--system without --new-vault is refused', async (t) => {
  const root = scratch(t);
  await assert.rejects(
    () => runInitCommand({ yes: true, name: 'x', vault: path.join(root, 'v'), system: 'none' }, [], { output: capture().output, ...OPTS }),
    (err) => err instanceof ConfigError && err.message === '--system only applies with --new-vault',
  );
});

test('--new-vault and --system with no value are refused like the other value flags', async (t) => {
  const root = scratch(t);
  for (const [flag, message] of [['new-vault', '--new-vault needs a value'], ['system', '--system needs a value']]) {
    await assert.rejects(() => runInitCommand(flagsFor(root, { [flag]: true }), [], { output: capture().output, ...OPTS }), (err) => err instanceof ConfigError && err.message === message, flag);
  }
});

test('--yes --new-vault needs --system: it is never guessed', async (t) => {
  const root = scratch(t);
  const flags = flagsFor(root);
  delete flags.system;
  await assert.rejects(
    () => runInitCommand(flags, [], { output: capture().output, ...OPTS }),
    (err) => err instanceof ConfigError && err.message === 'init --yes --new-vault needs --system <id> or --system none',
  );
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
});

test('--yes --new-vault needs --name', async (t) => {
  const root = scratch(t);
  const flags = flagsFor(root);
  delete flags.name;
  await assert.rejects(() => runInitCommand(flags, [], { output: capture().output, ...OPTS }), (err) => err instanceof ConfigError && err.message === 'init --yes --new-vault needs --name <name>');
});

test('an unknown --system exits through ConfigError with the list of valid systems', async (t) => {
  const root = scratch(t);
  await assert.rejects(
    () => runInitCommand(flagsFor(root, { system: 'nonesuch' }), [], { output: capture().output, ...OPTS }),
    (err) => err instanceof ConfigError && err.message === 'unknown game system "nonesuch"; valid systems: dnd-5e-2024, none',
  );
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
});

test('a title the new pages cannot hold is refused as a ConfigError before anything is written', async (t) => {
  const root = scratch(t);
  await assert.rejects(
    () => runInitCommand(flagsFor(root, { title: 'Say "hi"' }), [], { output: capture().output, ...OPTS }),
    (err) => err instanceof ConfigError && err.message === "site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes",
  );
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
});

test('a build with no starter refuses with a plain ScriptoriumError and writes nothing', async (t) => {
  const root = scratch(t);
  await assert.rejects(
    () => runInitCommand(flagsFor(root), [], { output: capture().output, ...OPTS, templateDir: path.join(root, 'nothing-here') }),
    (err) => err instanceof ScriptoriumError && !(err instanceof VaultUnreachableError) && err.message === 'this build has no new-campaign starter',
  );
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
  assert.equal(fs.existsSync(path.join(root, 'cfg')), false);
});

// --- the --yes path -----------------------------------------------------------------------------------

test('init --yes --new-vault creates the vault, the pack and the registration, and prints what it did', async (t) => {
  const root = scratch(t);
  const { lines, output } = capture();
  const vault = path.join(root, 'New Campaign');
  const res = await runInitCommand(flagsFor(root, { title: 'The  Brass Lantern' }), [], { output, ...OPTS });
  assert.deepEqual(res, { exitCode: 0 });
  assert.equal(lines[0], 'GM-Scriptorium campaign setup');
  assert.equal(lines[1], 'This creates new files under <vault>/_meta/scriptorium/ only. Nothing else in the vault is changed, and no existing file is overwritten.');
  assert.equal(lines[2], 'Starting a new campaign: this first creates the vault itself, in a new or empty folder. Nothing is overwritten or removed.');
  assert.equal(lines[3], `created the new vault at ${vault}: 11 folders, 11 files, game system dnd-5e-2024`);
  assert.equal(lines[4], `created in ${path.join(vault, '_meta', 'scriptorium')}: css/, images/, pack.toml, vault.config.json`);
  assert.match(lines[5], /^registered campaign "fresh" in .* \(now the default campaign\)$/);
  assert.equal(lines[6], 'next: run "check fresh", then "build fresh"');
  assert.equal(lines.length, 7);

  const files = list(vault);
  assert.equal(files.includes('_meta/vault-config.md'), true);
  assert.equal(files.includes('_meta/NOTICE.txt'), true);
  assert.equal(files.includes('_meta/scriptorium/vault.config.json'), true);
  assert.match(fs.readFileSync(path.join(vault, '_meta', 'vault-config.md'), 'utf8'), /# The Brass Lantern: vault settings/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vault, '_meta', 'scriptorium', 'vault.config.json'), 'utf8')).siteTitle, 'The Brass Lantern');
  const { config: cfg } = parseConfig(fs.readFileSync(path.join(root, 'cfg', 'config.toml'), 'utf8'));
  assert.equal(cfg.campaigns.fresh.vault, vault);
  assert.equal(cfg.campaigns.fresh.output, path.join(root, 'fresh-site'));
});

test('the title defaults to the campaign name, and system none leaves out the game system', async (t) => {
  const root = scratch(t);
  await runInitCommand(flagsFor(root, { system: 'none' }), [], { output: capture().output, ...OPTS });
  const settings = fs.readFileSync(path.join(root, 'New Campaign', '_meta', 'vault-config.md'), 'utf8');
  assert.equal(settings.includes('system: '), false);
  assert.match(settings, /# fresh: vault settings/);
});

test('missing parent folders are created and named in the output', async (t) => {
  const root = scratch(t);
  const { lines, output } = capture();
  const flags = flagsFor(root, { 'new-vault': path.join(root, 'Games', 'Fantasy', 'New') });
  await runInitCommand(flags, [], { output, ...OPTS });
  assert.equal(lines.includes(`also created the folders above it: ${path.join(root, 'Games')}, ${path.join(root, 'Games', 'Fantasy')}`), true, lines.join('\n'));
  assert.equal(fs.existsSync(path.join(root, 'Games', 'Fantasy', 'New', '_meta', 'vault-config.md')), true);
});

test('a target that is not empty is a VaultUnreachableError (exit 3), and nothing is written', async (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'New Campaign');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'mine.md'), 'x');
  await assert.rejects(
    () => runInitCommand(flagsFor(root), [], { output: capture().output, ...OPTS }),
    (err) => err instanceof VaultUnreachableError && err.reason === 'new-vault' && err.message === `refusing to create a vault in ${vault}: it is not empty (it holds mine.md)`,
  );
  assert.deepEqual(fs.readdirSync(vault), ['mine.md']);
  assert.equal(fs.existsSync(path.join(root, 'cfg')), false);
});

test('a target inside an existing vault is refused with exit 3 before the starter is even loaded', async (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'old');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  await assert.rejects(
    () => runInitCommand(flagsFor(root, { 'new-vault': path.join(vault, 'sub') }), [], { output: capture().output, ...OPTS, templateDir: path.join(root, 'nothing-here') }),
    (err) => err instanceof VaultUnreachableError && err.message === `refusing to create a vault in ${path.join(vault, 'sub')}: it is inside the vault at ${vault}`,
  );
});

test('the output folder may not be inside the new vault', async (t) => {
  const root = scratch(t);
  await assert.rejects(
    () => runInitCommand(flagsFor(root, { out: path.join(root, 'New Campaign', 'site') }), [], { output: capture().output, ...OPTS }),
    /refusing to build inside the vault/,
  );
  assert.equal(fs.existsSync(path.join(root, 'New Campaign')), false);
});

test('a pack error after the vault exists keeps the vault and says so', async (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'New Campaign');
  const real = fs.writeFileSync;
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file).endsWith('vault.config.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return real.call(this, file, ...rest);
  };
  t.after(() => {
    fs.writeFileSync = real;
  });
  await assert.rejects(
    () => runInitCommand(flagsFor(root), [], { output: capture().output, ...OPTS }),
    (err) => err instanceof ScriptoriumError && err.message.endsWith(`The new vault at ${vault} was created and is left as it is.`),
  );
  fs.writeFileSync = real;
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'vault-config.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'cfg', 'config.toml')), false);
});

// --- the questions --------------------------------------------------------------------------------------

test('interactive with no vault flag: it asks whether you have a vault, and "n" walks the new-vault questions in order', { timeout: 20000 }, async (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'New Campaign');
  const { input, output, getWritten } = streams();
  const promise = runInitCommand({ name: 'fresh', config: path.join(root, 'cfg', 'config.toml') }, [], { input, output, ...OPTS });

  await waitForOutput(getWritten, 'Do you already have a vault? [Y/n]: ');
  input.write('n\n');
  await waitForOutput(getWritten, 'New vault folder (a new or empty folder): ');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'stray.md'), 'x');
  input.write(`${vault}\n`);
  await waitForOutput(getWritten, `refusing to create a vault in ${vault}: it is not empty (it holds stray.md)`);
  fs.rmSync(path.join(vault, 'stray.md'));
  fs.rmdirSync(vault);
  input.write(`${vault}\n`);
  await waitForOutput(getWritten, 'Site title [fresh]: ');
  input.write('Say "hi"\n');
  await waitForOutput(getWritten, "site title can't be written into the new vault's pages exactly as typed; leave out double quotes and backslashes");
  input.write('The Brass Lantern\n');
  await waitForOutput(getWritten, 'Game system (dnd-5e-2024, none): ');
  input.write('gurps-4e\n');
  await waitForOutput(getWritten, 'unknown game system "gurps-4e"; valid systems: dnd-5e-2024, none');
  input.write('dnd-5e-2024\n');
  await waitForOutput(getWritten, `Output folder for the built site [${path.join(root, 'fresh-site')}]: `);
  input.write('\n');
  await waitForOutput(getWritten, 'Theme (gloam, haze, plain) [gloam]: ');
  input.write('\n');
  await waitForOutput(getWritten, `Create a new vault at ${vault} (11 folders, 11 files, game system dnd-5e-2024) and css/, images/, pack.toml, vault.config.json in ${path.join(vault, '_meta', 'scriptorium')}? [Y/n]: `);
  assert.equal(fs.existsSync(vault), false, 'nothing is written before the confirmation');
  input.write('y\n');
  await waitForOutput(getWritten, 'Run a first check now? [Y/n]: ');
  input.write('n\n');
  const res = await promise;
  assert.deepEqual(res, { exitCode: 0 });

  const written = getWritten();
  const order = ['Do you already have a vault?', 'New vault folder', 'Site title', 'Game system', 'Output folder', 'Theme', 'Create a new vault at'].map((s) => written.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the questions come in the stated order');
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'vault-config.md')), true);
});

test('interactive: declining the final question writes nothing', { timeout: 20000 }, async (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'Quiet');
  const { input, output, getWritten } = streams();
  const promise = runInitCommand({ name: 'fresh', 'new-vault': vault, system: 'none', config: path.join(root, 'cfg', 'config.toml') }, [], { input, output, ...OPTS });
  input.write('\n'); // title: the default
  input.write('\n'); // output: the default
  input.write('\n'); // theme: the default
  await waitForOutput(getWritten, '? [Y/n]: ');
  input.write('n\n');
  await assert.rejects(promise, (err) => err instanceof ConfigError && err.message === 'init aborted; nothing written');
  assert.equal(fs.existsSync(vault), false);
  assert.equal(fs.existsSync(path.join(root, 'cfg')), false);
});

test('interactive: the missing parent folders are listed before the final question', { timeout: 20000 }, async (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'Games', 'Fantasy', 'Quiet');
  const { input, output, getWritten } = streams();
  const promise = runInitCommand({ name: 'fresh', 'new-vault': vault, system: 'none', config: path.join(root, 'cfg', 'config.toml') }, [], { input, output, ...OPTS });
  input.write('\n\n\n');
  await waitForOutput(getWritten, '? [Y/n]: ');
  assert.equal(getWritten().includes(`These folders do not exist yet and will be created first: ${path.join(root, 'Games')}, ${path.join(root, 'Games', 'Fantasy')}`), true, getWritten());
  assert.equal(fs.existsSync(path.join(root, 'Games')), false);
  input.write('n\n');
  await assert.rejects(promise, /init aborted; nothing written/);
  assert.equal(fs.existsSync(path.join(root, 'Games')), false);
});

test('interactive: closed input at the "already have a vault" question aborts with nothing written', async (t) => {
  const root = scratch(t);
  const { input, output } = streams();
  const promise = runInitCommand({ name: 'fresh', config: path.join(root, 'cfg', 'config.toml') }, [], { input, output, ...OPTS });
  input.end();
  await assert.rejects(promise, (err) => err instanceof ConfigError && err.message === 'init aborted; nothing written');
});

test('interactive: "y" (or Enter) at the question goes on to the existing vault questions, unchanged', { timeout: 20000 }, async (t) => {
  const root = scratch(t);
  const { input, output, getWritten } = streams();
  const promise = runInitCommand({ name: 'fresh', config: path.join(root, 'cfg', 'config.toml') }, [], { input, output, ...OPTS });
  await waitForOutput(getWritten, 'Do you already have a vault? [Y/n]: ');
  input.write('\n');
  await waitForOutput(getWritten, 'Vault folder (the one holding _meta/vault-config.md): ');
  assert.equal(getWritten().includes('Starting a new campaign'), false);
  input.end();
  await assert.rejects(promise, /init aborted; nothing written/);
});

test('with --vault, or with --yes, the question is not asked at all', async (t) => {
  const root = scratch(t);
  const { input, output, getWritten } = streams();
  const vault = path.join(root, 'v');
  fs.mkdirSync(path.join(vault, '_meta'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_meta', 'vault-config.md'), '---\ntype: meta\n---\n');
  await runInitCommand({ yes: true, name: 'fresh', vault, config: path.join(root, 'cfg', 'config.toml') }, [], { input, output, ...OPTS });
  assert.equal(getWritten().includes('Do you already have a vault?'), false);
});

test('a campaign name that is already registered is refused, so a new vault is never pointed at an old campaign', async (t) => {
  const root = scratch(t);
  const flags = flagsFor(root);
  await runInitCommand(flags, [], { output: capture().output, ...OPTS });
  await assert.rejects(
    () => runInitCommand({ ...flags, 'new-vault': path.join(root, 'Second') }, [], { output: capture().output, ...OPTS }),
    (err) => err instanceof ConfigError && err.message === 'campaign "fresh" is already registered, so a new vault cannot be made for it; choose another name',
  );
  assert.equal(fs.existsSync(path.join(root, 'Second')), false);
});

test('a OneDrive folder gets an info note, and is created like any other', async (t) => {
  const root = scratch(t);
  const drive = path.join(root, 'OneDrive');
  fs.mkdirSync(drive);
  const { lines, output } = capture();
  await runInitCommand(flagsFor(root, { 'new-vault': path.join(drive, 'Campaign') }), [], { output, ...OPTS, env: { OneDrive: drive } });
  assert.equal(lines.includes('note: this folder is under OneDrive, which may sync the new files while they are being created'), true, lines.join('\n'));
  assert.equal(fs.existsSync(path.join(drive, 'Campaign', '_meta', 'vault-config.md')), true);
});

test('with input that is not a terminal the question is not asked, so scripted answers keep their old order', { timeout: 20000 }, async (t) => {
  const root = scratch(t);
  const { input, output, getWritten } = streams({ tty: false });
  const promise = runInitCommand({ name: 'fresh', config: path.join(root, 'cfg', 'config.toml') }, [], { input, output, ...OPTS });
  await waitForOutput(getWritten, 'Vault folder (the one holding _meta/vault-config.md): ');
  assert.equal(getWritten().includes('Do you already have a vault?'), false);
  input.end();
  await assert.rejects(promise, /init aborted; nothing written/);
});

test('a SIGINT at the vault prompt, after answering y to the vault question, aborts with nothing written', { timeout: 15000 }, async (t) => {
  const { createPrompter } = require('../src/cli/prompt');
  const root = scratch(t);
  const { input, output, getWritten } = streams();
  output.isTTY = true;
  const prompter = createPrompter({ input, output });
  const configPath = path.join(root, 'cfg', 'config.toml');
  const promise = runInitCommand({ config: configPath }, [], { input, output, prompter, ...OPTS });
  input.write('alpha\n');
  await waitForOutput(getWritten, 'Do you already have a vault? [Y/n]: ');
  input.write('y\n');
  await waitForOutput(getWritten, 'Vault folder (the one holding _meta/vault-config.md): ');
  prompter.rl.emit('SIGINT');
  await assert.rejects(promise, (err) => err instanceof ConfigError && err.message === 'init aborted; nothing written');
  assert.equal(fs.existsSync(configPath), false);
  prompter.close();
});

test('init --new-vault into a folder that is already a git repository works, and leaves .git alone', async (t) => {
  const root = scratch(t);
  const vault = path.join(root, 'New Campaign');
  fs.mkdirSync(path.join(vault, '.git'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await runInitCommand(flagsFor(root), [], { output: capture().output, ...OPTS });
  assert.equal(fs.readFileSync(path.join(vault, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  assert.equal(fs.existsSync(path.join(vault, '_meta', 'vault-config.md')), true);
});
