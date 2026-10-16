#!/usr/bin/env node
'use strict';

/*
 * Takes the pictures the how-to pages mark with `<!-- screenshot: how-to/<name>.png -->`.
 *
 *   node scripts/docs-screenshots.js --out <absolute dir> --root <absolute dir> [--only <file>]
 *
 * It copies the sample campaign (examples/the-long-lease) into a scratch folder (--root), writes
 * a scratch config there, starts the real admin panel on 127.0.0.1 against that config, and takes
 * each picture with Playwright. The pictures, a shots.json and a shots.md go to --out, which must
 * be outside the repository. Nothing is ever written under the repository, and nothing is copied
 * into docs/images/: a person checks every picture before it is added.
 *
 * Playwright is not a dependency. It is loaded inside main(), from PLAYWRIGHT_MODULE (the way the
 * browser tests load it), so requiring this module never loads it.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(REPO_ROOT, 'examples', 'the-long-lease');
const BIN = path.join(REPO_ROOT, 'bin', 'scriptorium.js');
const TOKEN_RE = /token=([A-Za-z0-9_-]{43})/;
const PORT_RE = /127\.0\.0\.1:(\d+)\/auth/;
const READY_CEILING_MS = 90000;
const STEP_TIMEOUT_MS = 30000;
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const LEAK_SENTENCE = 'Ottoline Pardew was seen here.';
const GM_LINK_URL = 'https://scriptorium.home.arpa';

function shot(file, page, alt) {
  return Object.freeze({ file, alt, page });
}

/** Overview is left out on purpose: the desktop app changes that screen. */
const SHOTS = Object.freeze([
  shot('how-to/setup-new-vault.png', 'docs/how-to/start-a-new-campaign.md', 'The setup question that asks where the new vault folder should go, with a folder typed in and a note that a new folder will be created.'),
  shot('how-to/setup-review.png', 'docs/how-to/start-a-new-campaign.md', 'The last setup screen, which lists every answer for a new campaign called lease and offers the button that creates it.'),
  shot('how-to/campaigns-screen.png', 'docs/how-to/add-another-campaign.md', 'The Campaigns screen, listing two campaigns with the one the panel is on marked, and the Add a campaign button.'),
  shot('how-to/add-a-campaign.png', 'docs/how-to/add-another-campaign.md', 'The Add another campaign page at the vault question, with an existing vault folder typed in and a note that it is a vault.'),
  shot('how-to/campaign-switcher.png', 'docs/how-to/add-another-campaign.md', 'The campaign switcher open in the side bar, listing both campaigns with the links Add a campaign and Manage campaigns below them.'),
  shot('how-to/theme-screen.png', 'docs/how-to/change-the-look-and-vocabulary.md', 'The Theme screen, with a card for each theme the campaign can use and the button that builds a preview of each.'),
  shot('how-to/images-screen.png', 'docs/how-to/change-the-look-and-vocabulary.md', 'The Images screen, showing the background image slots and the picture each one uses.'),
  shot('how-to/title-and-tagline.png', 'docs/how-to/change-the-look-and-vocabulary.md', 'The Title and tagline screen, with the site title and tagline fields.'),
  shot('how-to/vocabulary-screen.png', 'docs/how-to/change-the-look-and-vocabulary.md', 'The Vocabulary screen, listing the words the site uses and the campaign’s own wording for them.'),
  shot('how-to/vault-config-fields.png', 'docs/how-to/hide-gm-content.md', 'The vault settings screen in its fields layout, grouping each setting by how much it can expose to players.'),
  shot('how-to/check-leak-found.png', 'docs/how-to/hide-gm-content.md', 'The Check screen after a run that found a hidden character’s name on a page players can read, listed as an error.'),
  shot('how-to/site-footer-gm-link.png', 'docs/how-to/add-a-game-master-link.md', 'The foot of a published page, where the notices line ends with a Game master link.'),
  shot('how-to/remote-access-screen.png', 'docs/remote-access.md', 'The Remote access screen in local mode, showing that the panel is only reachable from this computer.'),
]);

/** @returns {string|null} a problem, or null when `outDir` is an absolute path outside the repository. */
function outDirProblem(repoRoot, outDir) {
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) return 'the folder must be an absolute path';
  const rel = path.relative(path.resolve(repoRoot), path.resolve(outDir));
  if (rel === '') return 'the folder is the repository itself';
  if (path.isAbsolute(rel)) return null; // another drive
  if (rel.split(path.sep)[0] !== '..') return 'the folder is inside the repository';
  return null;
}

/** @returns {string|null} a problem when any segment of the path equals the user name. */
function userSegmentProblem(absPath, username) {
  if (typeof username !== 'string' || username === '') return null;
  for (const seg of String(absPath).split(/[\\/]+/)) {
    if (seg === username) return `the path has a folder named after the current user (${username}); choose a path without it`;
  }
  return null;
}

function parseArgs(argv) {
  const out = { out: null, root: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--root' || a === '--only') {
      const v = argv[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      out[a.slice(2)] = v;
      i++;
    } else {
      return { error: `unknown argument ${a}` };
    }
  }
  if (!out.out) return { error: '--out <absolute dir> is required' };
  if (!out.root) return { error: '--root <absolute dir> is required' };
  return out;
}

function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try {
      return require(c);
    } catch (_) {
      /* next */
    }
  }
  return null;
}

// -- the panel -----------------------------------------------------------------------------------

function killChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (_) {
      /* gone */
    }
  }
}

function stopChild(child, graceMs = 4000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      killChild(child);
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGINT');
  });
}

/** Starts `serve ...` and resolves on the printed `admin panel:` line (token and port). */
function startPanel(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killChild(child);
      reject(new Error(`the panel did not start: ${why}`));
    };
    const check = () => {
      if (done) return;
      const tok = TOKEN_RE.exec(text);
      const port = PORT_RE.exec(text);
      if (!tok || !port) return;
      done = true;
      clearTimeout(timer);
      resolve({ child, token: tok[1], base: `http://127.0.0.1:${port[1]}`, stop: () => stopChild(child) });
    };
    const timer = setTimeout(() => fail(`no admin panel line within ${READY_CEILING_MS}ms`), READY_CEILING_MS);
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('error', (e) => fail(`spawn error: ${e.message}`));
    child.once('exit', (code, sig) => fail(`exited before ready (code=${code} signal=${sig})`));
  });
}

/** Runs a command to the end (used for `build`); resolves with its exit code. */
function runToEnd(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

/** Starts the built-site server and resolves on its printed address. */
function startSite(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killChild(child);
      reject(new Error(`the site server did not start: ${why}`));
    };
    const check = () => {
      if (done) return;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
      if (!m) return;
      done = true;
      clearTimeout(timer);
      resolve({ child, base: `http://127.0.0.1:${m[1]}`, stop: () => stopChild(child) });
    };
    const timer = setTimeout(() => fail(`no address line within ${READY_CEILING_MS}ms`), READY_CEILING_MS);
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('error', (e) => fail(`spawn error: ${e.message}`));
    child.once('exit', (code, sig) => fail(`exited before ready (code=${code} signal=${sig})`));
  });
}

// -- the scratch campaign ------------------------------------------------------------------------

function scratchLayout(root) {
  return {
    home: path.join(root, 'home'),
    vaults: { lease: path.join(root, 'vaults', 'lease'), ledger: path.join(root, 'vaults', 'ledger') },
    outs: { lease: path.join(root, 'sites', 'lease'), ledger: path.join(root, 'sites', 'ledger') },
    fresh: path.join(root, 'work', 'marsh'),
    newVault: path.join(root, 'new', 'lease-notes'),
    config: path.join(root, 'cfg', 'config.toml'),
    setupConfig: path.join(root, 'setup-cfg', 'config.toml'),
  };
}

function scratchEnv(root, lay, configPath) {
  const env = {
    PATH: process.env.PATH || '',
    HOME: lay.home,
    USERPROFILE: lay.home,
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    APPDATA: path.join(root, 'appdata'),
    SCRIPTORIUM_CONFIG: configPath,
    TMPDIR: path.join(root, 'tmp'),
  };
  return env;
}

function buildScratch(root) {
  const lay = scratchLayout(root);
  for (const d of [lay.home, path.join(root, 'tmp'), path.dirname(lay.config), path.join(root, 'work'), path.join(root, 'new'), path.join(root, 'sites')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const v of Object.values(lay.vaults)) fs.cpSync(SAMPLE, v, { recursive: true });
  fs.cpSync(SAMPLE, lay.fresh, { recursive: true });
  fs.rmSync(path.join(lay.fresh, '_meta', 'scriptorium'), { recursive: true, force: true });
  // The footer picture needs the link on, so the scratch pack of "lease" gets it.
  const pack = path.join(lay.vaults.lease, '_meta', 'scriptorium', 'pack.toml');
  fs.appendFileSync(pack, `\n[gm_link]\nurl = ${JSON.stringify(GM_LINK_URL)}\n`);
  const lines = ['config_version = 1', 'default_campaign = "lease"', ''];
  for (const name of ['lease', 'ledger']) {
    lines.push(`[campaigns.${name}]`, `vault = ${JSON.stringify(lay.vaults[name])}`, `output = ${JSON.stringify(lay.outs[name])}`, '');
  }
  fs.writeFileSync(lay.config, lines.join('\n'));
  return lay;
}

/** Puts the sentence right under the `# Orpiment` heading of the scratch copy (examples/README.md, "The withheld NPC"). Returns a function that puts the page back. */
function plantLeak(vault) {
  const file = path.join(vault, 'Characters', 'NPCs', 'Orpiment.md');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => l === '# Orpiment');
  if (at < 0) throw new Error('the sample page has no "# Orpiment" heading to plant the sentence under');
  lines.splice(at + 1, 0, '', LEAK_SENTENCE);
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, lines.join('\n'));
  return () => fs.writeFileSync(file, original);
}

// -- the pictures --------------------------------------------------------------------------------

async function settle(page) {
  // pictures on the page have finished loading (an image that is not drawn does not count)
  await page.waitForFunction(() => Array.prototype.every.call(document.images, (i) => i.complete || i.offsetWidth === 0));
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(VIEWPORT.width - 1, VIEWPORT.height - 1); // no hover state in the picture
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function openPanel(browser, panel, fragment) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  await page.goto(`${panel.base}/auth?token=${panel.token}`, { waitUntil: 'load' });
  if (fragment) {
    await page.waitForSelector('[data-screen="overview"]', { state: 'attached' });
    await page.evaluate((f) => {
      location.hash = f;
    }, fragment);
  }
  return { ctx, page };
}

async function waitText(page, id, needle) {
  await page.waitForFunction(([i, n]) => !!document.getElementById(i) && document.getElementById(i).textContent.indexOf(n) !== -1, [id, needle]);
}

async function toNewVaultQuestion(page, name) {
  await page.waitForSelector('[data-role="setup-root"] h1');
  await page.click('label.su-path:has(input[value="new"])');
  await page.click('.su-foot .a1-btn.primary');
  await page.fill('#su-name', name);
  await waitText(page, 'su-name-st', 'works.');
  await page.click('[data-part="next"]');
  await page.waitForSelector('#su-newvault');
}

const STEPS = {
  async 'how-to/setup-new-vault.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.setupPanel, null);
    await toNewVaultQuestion(page, 'lease');
    await page.fill('#su-newvault', ctx.lay.newVault);
    await waitText(page, 'su-newvault-st', 'A new folder will be created');
    await settle(page);
    return page;
  },
  async 'how-to/setup-review.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.setupPanel, null);
    await toNewVaultQuestion(page, 'lease');
    await page.fill('#su-newvault', ctx.lay.newVault);
    await waitText(page, 'su-newvault-st', 'A new folder will be created');
    const next = async () => {
      await page.waitForFunction(() => !!document.querySelector('[data-part="next"]') && !document.querySelector('[data-part="next"]').disabled);
      await page.click('[data-part="next"]');
    };
    await next(); // vault > title
    await page.waitForFunction(() => !!document.getElementById('su-title') && document.getElementById('su-title').value !== '');
    await next(); // title > game system
    await page.waitForSelector('input[name="su-sys"]');
    await next(); // game system > output
    await page.waitForSelector('#su-out');
    await page.waitForFunction(() => document.getElementById('su-out').value !== '' && document.getElementById('su-out-st').textContent.indexOf('Outside the vault') !== -1);
    await next(); // output > theme
    await page.waitForSelector('.su-themes');
    await next(); // theme > review
    await page.waitForSelector('.a1-slip');
    await settle(page);
    return page;
  },
  async 'how-to/campaigns-screen.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/campaigns');
    await page.waitForSelector('.cs-add');
    await settle(page);
    return page;
  },
  async 'how-to/add-a-campaign.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, null);
    await page.waitForSelector('.cs-trigger', { state: 'attached' });
    await page.goto(`${ctx.panel.base}/campaigns/add`, { waitUntil: 'load' });
    await page.waitForSelector('[data-role="setup-root"] h1');
    await page.click('.su-foot .a1-btn.primary');
    await page.fill('#su-name', 'marsh');
    await waitText(page, 'su-name-st', 'works.');
    await page.click('[data-part="next"]');
    await page.waitForSelector('#su-vault');
    await page.fill('#su-vault', ctx.lay.fresh);
    await waitText(page, 'su-vault-st', 'A gm-apprentice vault');
    await settle(page);
    return page;
  },
  async 'how-to/campaign-switcher.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/theme');
    await page.waitForSelector('[data-role="side"] .cs-trigger');
    await page.click('[data-role="side"] .cs-trigger');
    await page.waitForSelector('.cs-pop:not([hidden]) .cs-foot');
    await settle(page);
    return page;
  },
  async 'how-to/theme-screen.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/theme');
    await page.waitForSelector('[data-screen="theme"]');
    await settle(page);
    return page;
  },
  async 'how-to/images-screen.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/images');
    await page.waitForSelector('[data-screen="images"]');
    await settle(page);
    return page;
  },
  async 'how-to/title-and-tagline.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/title');
    await page.waitForSelector('[data-screen="title"]');
    await settle(page);
    return page;
  },
  async 'how-to/vocabulary-screen.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/vocab');
    await page.waitForSelector('[data-screen="vocab"]');
    await settle(page);
    return page;
  },
  async 'how-to/vault-config-fields.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/vault-config');
    await page.waitForSelector('[data-screen="vault-config"]');
    await page.click('[data-switcher="vault-config"] [data-view-opt="vc3"]');
    await page.waitForSelector('.vc3-grid');
    await settle(page);
    return page;
  },
  async 'how-to/check-leak-found.png'(ctx) {
    const restore = plantLeak(ctx.lay.vaults.lease);
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/check');
    // the phone bar carries a second, hidden Run check button, so take the visible one
    const run = page.locator('[data-act="check"]:visible').first();
    await run.waitFor();
    await run.click();
    // the Overview keeps its own hidden findings list, so wait for the one that is drawn
    await page.locator('ul.a1-find:visible li').first().waitFor();
    restore(); // the findings are drawn; put the page back so the later site build is clean
    await settle(page);
    return page;
  },
  async 'how-to/site-footer-gm-link.png'(ctx) {
    const code = await runToEnd(['build', 'lease', '--config', ctx.lay.config], ctx.env);
    if (code !== 0) throw new Error(`build of the scratch campaign exited ${code}`);
    const site = await startSite(['serve', 'lease', '--port', '0', '--config', ctx.lay.config], ctx.env);
    ctx.stops.push(site.stop);
    const bctx = await ctx.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await bctx.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    await page.goto(`${site.base}/`, { waitUntil: 'load' });
    await page.waitForSelector('a.scriptorium-gm-access');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settle(page);
    return page;
  },
  async 'how-to/remote-access-screen.png'(ctx) {
    const { page } = await openPanel(ctx.browser, ctx.panel, '#/remote');
    await page.waitForSelector('[data-screen="remote"]');
    await settle(page);
    return page;
  },
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function table(rows) {
  const lines = ['| File | sha256 | Bytes | Alt text |', '|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.file} | ${r.sha256} | ${r.bytes} | ${r.alt} |`);
  return lines.join('\n') + '\n';
}

async function capture({ pw, root, outDir, only, log }) {
  const lay = buildScratch(root);
  fs.mkdirSync(outDir, { recursive: true });
  const todo = SHOTS.filter((s) => only === null || s.file === only);
  const stops = [];
  let browser = null;
  const rows = [];
  try {
    const setupPanel = await startPanel(['serve', '--admin', '--config', lay.setupConfig], scratchEnv(root, lay, lay.setupConfig));
    stops.push(setupPanel.stop);
    const env = scratchEnv(root, lay, lay.config);
    const panel = await startPanel(['serve', '--admin', '--config', lay.config, 'lease'], env);
    stops.push(panel.stop);
    browser = await pw.chromium.launch();
    const ctx = { browser, setupPanel, panel, lay, env, stops };
    for (const s of todo) {
      const page = await STEPS[s.file](ctx);
      const dest = path.join(outDir, s.file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await page.screenshot({ path: dest, fullPage: false });
      await page.context().close();
      const buf = fs.readFileSync(dest);
      rows.push({ file: s.file, sha256: sha256(buf), bytes: buf.length, alt: s.alt });
      log(`took ${s.file}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const stop of stops) await stop().catch(() => {});
  }
  fs.writeFileSync(path.join(outDir, 'shots.json'), JSON.stringify(rows, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'shots.md'), table(rows));
  return rows;
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {{ repoRoot?: string, username?: string, loadPlaywright?: Function, capture?: Function, log?: Function, err?: Function }} [deps]
 * @returns {Promise<number>} the exit code
 */
async function main(argv, deps = {}) {
  const repoRoot = deps.repoRoot || REPO_ROOT;
  const username = deps.username !== undefined ? deps.username : os.userInfo().username;
  const log = deps.log || ((m) => process.stdout.write(`${m}\n`));
  const err = deps.err || ((m) => process.stderr.write(`${m}\n`));
  const args = parseArgs(argv);
  if (args.error) {
    err(`docs-screenshots: ${args.error}`);
    return 2;
  }
  let only = null;
  if (args.only !== null) {
    const hit = SHOTS.find((s) => s.file === args.only);
    if (!hit) {
      err(`docs-screenshots: --only ${args.only} is not one of: ${SHOTS.map((s) => s.file).join(', ')}`);
      return 2;
    }
    only = hit.file;
  }
  // Only the scratch root shows in pictures (a path on the setup screens), so only it is kept free of
  // the user name. The output folder is never drawn into a picture.
  for (const [flag, dir, named] of [['--out', args.out, false], ['--root', args.root, true]]) {
    const problem = outDirProblem(repoRoot, dir) || (named ? userSegmentProblem(dir, username) : null);
    if (problem) {
      err(`docs-screenshots: ${flag}: ${problem}`);
      return 2;
    }
    if (fs.existsSync(dir)) {
      err(`docs-screenshots: ${flag}: ${dir} already exists; choose a folder that does not exist yet`);
      return 2;
    }
  }
  if (path.resolve(args.out) === path.resolve(args.root)) {
    err('docs-screenshots: --out and --root must be different folders');
    return 2;
  }
  const pw = (deps.loadPlaywright || loadPlaywright)();
  if (!pw) {
    err('docs-screenshots: Playwright was not found; set PLAYWRIGHT_MODULE to its folder');
    return 2;
  }
  try {
    await (deps.capture || capture)({ pw, root: args.root, outDir: args.out, only, log });
  } catch (e) {
    err(`docs-screenshots: ${e && e.message ? e.message : e}`);
    return 1;
  }
  log(`pictures, shots.json and shots.md are in ${args.out}`);
  return 0;
}

module.exports = { SHOTS, outDirProblem, userSegmentProblem, main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
