'use strict';

/*
 * P3b, S4 (ADR 0023, SD-6): config/theme-scheme-mismatch. Scratch copies of
 * test/fixtures/mini-vault, following test/pack-shadowed.test.js's pattern.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MINI_VAULT = path.join(__dirname, 'fixtures', 'mini-vault');

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-theme-scheme-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function requireFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

/**
 * Copies mini-vault into a scratch dir, with a convention pack.toml (`theme = <theme>`, default
 * "haze") and _meta/vault-config.md replaced by `vaultConfigMd` (default: no publish.theme
 * block at all). Returns the scratch config.toml path.
 */
function setupVault(dir, { theme = 'haze', vaultConfigMd = null, pack = true } = {}) {
  const vaultDir = path.join(dir, 'vault');
  fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
  if (vaultConfigMd !== null) {
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), vaultConfigMd);
  }
  // else: leave the fixture's own _meta/vault-config.md as-is -- it has no publish.theme block,
  // which is exactly the "no theme block" case, and locateVault() requires the file to exist at
  // all for the vault to be recognised.
  const packDir = path.join(vaultDir, '_meta', 'scriptorium');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'vault.config.json'),
    JSON.stringify(
      { siteTitle: 'Theme Scheme Fixture', siteUrl: 'https://example.invalid', excludeDirs: [], folderMap: {} },
      null,
      2,
    ),
  );
  if (pack) {
    fs.writeFileSync(path.join(packDir, 'pack.toml'), `theme = "${theme}"\n`);
  }
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['config_version = 1', 'default_campaign = "fixture"', '', '[campaigns.fixture]', `vault = '${vaultDir}'`, `output = '${path.join(dir, 'out')}'`].join(
      '\n',
    ),
  );
  return configPath;
}

function vaultConfigWithPalette(background) {
  return `---\ntype: meta\npublish:\n  theme:\n    palette:\n      background: '${background}'\n---\n\n# Vault config\n`;
}

function vaultConfigWithGenre(genre) {
  return `---\ntype: meta\npublish:\n  theme:\n    genre: '${genre}'\n---\n\n# Vault config\n`;
}

function findings(configPath) {
  const { runCheckCommand } = requireFresh('../src/cli/check');
  const result = runCheckCommand({ config: configPath }, 'fixture');
  return result.envelope.findings.filter((f) => f.id === 'config/theme-scheme-mismatch');
}

// -- 1. haze with a light palette fires --------------------------------------------------------

test('1: haze with #f5f0e6 fires one INFO with the exact data', () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithPalette('#f5f0e6') });
    const fs1 = findings(configPath);
    assert.equal(fs1.length, 1);
    const f = fs1[0];
    assert.equal(f.severity, 'info');
    assert.equal(f.category, 'config');
    assert.equal(f.path, '_meta/vault-config.md');
    assert.deepEqual(f.data, { theme: 'haze', scheme: 'dark', paletteScheme: 'light', background: '#f5f0e6' });
    assert.equal(
      f.message,
      'theme "haze" expects a dark palette, but the palette background #f5f0e6 is light; ' +
        'set publish.theme.palette.background in _meta/vault-config.md, or choose another theme in pack.toml',
    );
  });
});

// -- 2. no theme block: falls back to the pin's default background (#e8f0f3), fires -------------

test('2: no theme block fires with background #e8f0f3, stated literally', () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'haze', vaultConfigMd: null });
    const fs1 = findings(configPath);
    assert.equal(fs1.length, 1);
    assert.equal(fs1[0].data.background, '#e8f0f3');
    assert.equal(fs1[0].data.paletteScheme, 'light');
  });
});

// -- 3. empty background string falls back to #1a1f25, doesn't fire (haze is dark) --------------

test("3: palette with background: '' doesn't fire (falls back to #1a1f25)", () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithPalette('') });
    assert.equal(findings(configPath).length, 0);
  });
});

// -- 4. haze with a dark palette doesn't fire ----------------------------------------------------

test("4: haze with #202020 doesn't fire", () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithPalette('#202020') });
    assert.equal(findings(configPath).length, 0);
  });
});

// -- 5. plain has no scheme (dir: null) -> never fires -------------------------------------------

test("5: plain with a light palette doesn't fire", () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'plain', vaultConfigMd: vaultConfigWithPalette('#f5f0e6') });
    assert.equal(findings(configPath).length, 0);
  });
});

// -- 6. no pack.toml -> packToml.present is false -------------------------------------------------

test("6: no pack.toml doesn't fire", () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { pack: false, vaultConfigMd: vaultConfigWithPalette('#f5f0e6') });
    assert.equal(findings(configPath).length, 0);
  });
});

test('6b: the present:false guard specifically (isolated from DEFAULT_THEME being scheme-less) -- a synthetic ctx with present:false and a real, scheme-bearing theme name still gives zero findings', () => {
  withScratchDir((dir) => {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), vaultConfigWithPalette('#f5f0e6'));
    const themescheme = requireFresh('../src/checks/themescheme');
    // present:false with theme:"haze" never happens via the real loadPackToml() (its own
    // present:false early return always defaults theme to DEFAULT_THEME, which is scheme-less
    // and would mask this guard on its own -- see test 6 above), so this ctx is synthetic,
    // built directly to isolate the present guard from that coincidence.
    const ctx = { vaultPath: vaultDir, campaign: 'fixture', packToml: { present: false, theme: 'haze' } };
    assert.deepEqual(themescheme.runThemeSchemeMismatch(ctx), []);
  });
});

// -- 7. the > vs >= boundary, at an exact-0.5-luminance value -------------------------------------

test('7: #808080 (luminance 0.50196..., > 0.5) fires; #7f7f7f (0.49803..., < 0.5) does not', () => {
  withScratchDir((dir) => {
    const light = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithPalette('#808080') });
    assert.equal(findings(light).length, 1);
  });
  withScratchDir((dir) => {
    const dark = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithPalette('#7f7f7f') });
    assert.equal(findings(dark).length, 0);
  });
});

test('7b: an exact luminance-0.5 background exists (brute-forced over 2^24 colours) -- #01ade1; the > branch treats it as dark, not light', () => {
  const { luminance } = (() => {
    // Port, isolated to this test, of the exact formula themescheme.js uses -- brute-forcing the
    // search here (not importing the private parseHex/luminance) keeps the search itself an
    // independent check of the module's own behaviour below, not a tautology against it.
    function parseHex(hex) {
      const h = hex.replace('#', '');
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    function luminance(hex) {
      const { r, g, b } = parseHex(hex);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
    return { luminance };
  })();

  const EXACT_HALF_BG = '#01ade1';
  assert.equal(luminance(EXACT_HALF_BG), 0.5, 'brute-force precondition: this value must compute to exactly 0.5');

  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithPalette(EXACT_HALF_BG) });
    // luminance(bg) > 0.5 is false at exactly 0.5, so the palette is "dark" -- matches haze
    // (also dark), so no mismatch fires. If the module used >= instead, this would fire.
    assert.equal(findings(configPath).length, 0, 'the > (not >=) branch must not treat an exact 0.5 as light');
  });
});

// -- 8. genre presets own the palette; no finding unless the genre itself fails to resolve -------

test('8: genre "horror" with no palette gives no finding (a real genre resolves, palette stays null-owned)', () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithGenre('horror') });
    assert.equal(findings(configPath).length, 0);
  });
});

/** A real, file-backed fixture theme with the given theme.json `scheme`, for registry injection
 * (loadTheme() genuinely reads it off disk -- no product-code monkeypatching). */
function writeFixtureTheme(dir, scheme, { owns } = {}) {
  const themeDir = path.join(dir, 'fixture-theme');
  fs.mkdirSync(themeDir, { recursive: true });
  const json = { name: 'fixture-light', scheme, slots: [] };
  if (owns) json.owns = owns;
  fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify(json));
  fs.writeFileSync(path.join(themeDir, 'theme.css'), 'body { color: red; }\n');
  return Object.freeze({ 'fixture-light': Object.freeze({ name: 'fixture-light', dir: themeDir }) });
}

test('8b: genre "nonsense" with no palette, plus an injected light fixture theme, fires with #1a1f25', () => {
  withScratchDir((dir) => {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), vaultConfigWithGenre('nonsense'));

    const themescheme = requireFresh('../src/checks/themescheme');
    const registry = writeFixtureTheme(dir, 'light');
    const ctx = { vaultPath: vaultDir, campaign: 'fixture', packToml: { present: true, theme: 'fixture-light' } };
    const result = themescheme.runThemeSchemeMismatch(ctx, { registry });
    assert.equal(result.length, 1);
    assert.equal(result[0].data.background, '#1a1f25');
    assert.equal(result[0].data.paletteScheme, 'dark');
    assert.equal(result[0].data.scheme, 'light');
  });
});

// -- 9. symmetry: a light fixture theme on a dark palette fires too ------------------------------

test('9: an injected light fixture theme on a dark palette fires (symmetry with haze/light)', () => {
  withScratchDir((dir) => {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), vaultConfigWithPalette('#101010'));

    const themescheme = requireFresh('../src/checks/themescheme');
    const registry = writeFixtureTheme(dir, 'light');
    const ctx = { vaultPath: vaultDir, campaign: 'fixture', packToml: { present: true, theme: 'fixture-light' } };
    const result = themescheme.runThemeSchemeMismatch(ctx, { registry });
    assert.equal(result.length, 1);
    assert.equal(result[0].data.scheme, 'light');
    assert.equal(result[0].data.paletteScheme, 'dark');
  });
});

// -- 10. parity matrix against the pin ------------------------------------------------------------

test('10: paletteScheme() parity against the pin\'s full pipeline (config.js merge + theme.js generateThemeCSS)', () => {
  // Deep-required in this test only (SD-6): the pin's real merge defaults + CSS generator, to
  // derive an INDEPENDENT scheme/background reading, never the module under test's own logic.
  // eslint-disable-next-line global-require
  const { PUBLISH_DEFAULTS } = require('gm-apprentice-publish/lib/config');
  // eslint-disable-next-line global-require
  const { generateThemeCSS, resolveGenrePreset } = require('gm-apprentice-publish/lib/theme');
  const themescheme = requireFresh('../src/checks/themescheme');

  /** Reproduces lib/config.js:257-262's own merge, then theme.js:87-110's scheme read -- the
   * SAME two-stage pipeline paletteScheme() reproduces, from the pin's real exports, for a
   * genuine independent check (not calling generateThemeCSS with an unmerged palette, which
   * would trip its own internal '#1a1f25' fallback the merge stage already resolved --
   * deviation 1 at the top of the Engineering Brief). */
  function pinReading({ rawPalette, genre }) {
    let palette;
    if (rawPalette) palette = { ...PUBLISH_DEFAULTS.theme.palette, ...rawPalette };
    else if (genre) palette = null;
    else palette = { ...PUBLISH_DEFAULTS.theme.palette };

    if (palette === null && resolveGenrePreset(genre)) {
      return { scheme: null, background: null };
    }
    const css = generateThemeCSS({ palette, fonts: {}, genre });
    const bgMatch = css.match(/--bg: ([^;]+);/);
    const background = bgMatch ? bgMatch[1] : null;
    let scheme = null;
    if (/--accent-dim: rgba\(\d+, \d+, \d+, 0\.08\);/.test(css)) scheme = 'light';
    else if (/--accent-dim: rgba\(\d+, \d+, \d+, 0\.15\);/.test(css)) scheme = 'dark';
    return { scheme, background };
  }

  const cases = [
    { label: '#fff', rawPalette: { background: '#fff' } },
    { label: '#abc', rawPalette: { background: '#abc' } },
    { label: 'red', rawPalette: { background: 'red' } },
    { label: 'empty string', rawPalette: { background: '' } },
    { label: 'exact 0.5 (#01ade1)', rawPalette: { background: '#01ade1' } },
    { label: 'palette without background', rawPalette: { primary: '#1a2f3a' } },
    { label: 'genre only', rawPalette: null, genre: 'horror' },
    { label: 'unknown genre', rawPalette: null, genre: 'nonsense' },
    { label: 'genre plus palette (palette wins per the pin\'s own merge)', rawPalette: { background: '#202020' }, genre: 'horror' },
    { label: 'no file at all', none: true },
  ];

  for (const c of cases) {
    const pin = c.none ? { scheme: null, background: null } : pinReading({ rawPalette: c.rawPalette, genre: c.genre || null });

    withScratchDir((dir) => {
      const vaultDir = path.join(dir, 'vault');
      fs.mkdirSync(path.join(vaultDir, '_meta'), { recursive: true });
      if (!c.none) {
        let publishTheme = '';
        if (c.rawPalette && c.rawPalette.background !== undefined) {
          publishTheme = `  theme:\n    palette:\n      background: '${c.rawPalette.background}'\n`;
        } else if (c.rawPalette) {
          publishTheme = `  theme:\n    palette:\n      primary: '${c.rawPalette.primary}'\n`;
        } else if (c.genre) {
          publishTheme = `  theme:\n    genre: '${c.genre}'\n`;
        }
        const vcMd = `---\ntype: meta\npublish:\n${publishTheme}---\n\n# Vault config\n`;
        fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), vcMd);
      }

      const ours = c.none ? { scheme: 'n/a' } : themescheme.paletteScheme(vaultDir);
      // "no file at all": the pin has no comparable reading either (Not our own real target for
      // an assertion, since the pin never runs without a config), so only assert our own result
      // reads the un-authored default (light, background #e8f0f3) when the file is simply absent.
      if (c.none) {
        assert.equal(themescheme.paletteScheme(vaultDir).background, '#e8f0f3');
      } else {
        assert.equal(ours.scheme, pin.scheme, `scheme mismatch for case "${c.label}"`);
      }
    });
  }
});

// -- 11. wiring: registry, RUNNERS, end-to-end ------------------------------------------------------

test('11: registry entry fields; RUNNERS wiring; end-to-end runCheckCommand includes the finding', () => {
  const { CHECKS } = requireFresh('../src/checks/registry');
  const entry = CHECKS.find((c) => c.id === 'config/theme-scheme-mismatch');
  assert.ok(entry);
  assert.equal(entry.category, 'config');
  assert.equal(entry.defaultSeverity, 'info');
  assert.equal(entry.defaultEnabled, true);
  assert.equal(entry.requiresFlag, null);
  assert.match(entry.description, /pack\.toml theme/);

  // Fresh-require themescheme FIRST: run.js requires it internally (`require('./themescheme')`),
  // so RUNNERS' own reference must come from the SAME fresh module instance this test compares
  // against, not a second, later-fresh-required copy.
  const themescheme = requireFresh('../src/checks/themescheme');
  const { RUNNERS } = requireFresh('../src/checks/run');
  assert.equal(RUNNERS['config/theme-scheme-mismatch'], themescheme.runThemeSchemeMismatch);

  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'haze', vaultConfigMd: vaultConfigWithPalette('#f5f0e6') });
    assert.equal(findings(configPath).length, 1);
  });
});

// -- ADR 0032, Structural decision 2: palette-owning themes never fire ---------------------------

test('12: gloam with a light palette does not fire (the theme owns the palette)', () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'gloam', vaultConfigMd: vaultConfigWithPalette('#f5f0e6') });
    assert.equal(findings(configPath).length, 0);
  });
});

test('13: gloam with no theme block does not fire', () => {
  withScratchDir((dir) => {
    const configPath = setupVault(dir, { theme: 'gloam', vaultConfigMd: null });
    assert.equal(findings(configPath).length, 0);
  });
});

test('14: a fixture theme with owns:["palette"] never fires, even on a mismatched light palette', () => {
  withScratchDir((dir) => {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), vaultConfigWithPalette('#f5f0e6'));

    const themescheme = requireFresh('../src/checks/themescheme');
    const registry = writeFixtureTheme(dir, 'dark', { owns: ['palette'] });
    const ctx = { vaultPath: vaultDir, campaign: 'fixture', packToml: { present: true, theme: 'fixture-light' } };
    assert.deepEqual(themescheme.runThemeSchemeMismatch(ctx, { registry }), []);
  });
});

test('15: a fixture theme WITHOUT owns still fires on the same mismatched light palette (GM4/GM11/GM13 control)', () => {
  withScratchDir((dir) => {
    const vaultDir = path.join(dir, 'vault');
    fs.cpSync(MINI_VAULT, vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '_meta', 'vault-config.md'), vaultConfigWithPalette('#f5f0e6'));

    const themescheme = requireFresh('../src/checks/themescheme');
    const registry = writeFixtureTheme(dir, 'dark');
    const ctx = { vaultPath: vaultDir, campaign: 'fixture', packToml: { present: true, theme: 'fixture-light' } };
    const result = themescheme.runThemeSchemeMismatch(ctx, { registry });
    assert.equal(result.length, 1);
    assert.equal(result[0].data.theme, 'fixture-light');
  });
});
