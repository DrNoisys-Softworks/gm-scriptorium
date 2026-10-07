'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PACK_TOML_FILE, parsePackToml, loadPackToml } = require('../src/build/packtoml');
const { ConfigError } = require('../src/util/errors');
const { DEFAULT_VOCAB } = require('../src/build/labels');
const readModule = require('../src/vault/read');

/*
 * ADR 0019: parsePackToml is pure (no filesystem access); loadPackToml is
 * the read.pathExists/read.readText wrapper around it. Synthetic names
 * only (NFR-08).
 */

function withScratchDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-packtoml-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function parse(dir, text, opts = {}) {
  const T = path.join(dir, PACK_TOML_FILE);
  return parsePackToml(text, { tomlPath: T, campaign: 'alpha', ...opts });
}

function assertConfigError(fn, expectedMessage) {
  assert.throws(
    fn,
    (err) => err instanceof ConfigError && err.message === expectedMessage,
    `expected message: ${expectedMessage}`,
  );
}

// --- K1/K2: loadPackToml's read chokepoint use --------------------------

test('K1: no pack.toml gives present: false, and read.readText is never called', () => {
  withScratchDir((dir) => {
    const spy = mock.method(readModule, 'readText');
    try {
      const result = loadPackToml(dir, { campaign: 'alpha' });
      assert.equal(result.present, false);
      assert.equal(result.theme, 'plain');
      assert.deepEqual(result.images, []);
      assert.deepEqual(result.warnings, []);
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});

test('K2: theme = "plain" gives readText exactly one call, with T', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    fs.writeFileSync(T, 'theme = "plain"\n');
    const spy = mock.method(readModule, 'readText');
    try {
      const result = loadPackToml(dir, { campaign: 'alpha' });
      assert.equal(result.present, true);
      assert.equal(result.theme, 'plain');
      assert.equal(spy.mock.calls.length, 1);
      assert.equal(spy.mock.calls[0].arguments[0], T);
    } finally {
      spy.mock.restore();
    }
  });
});

// --- K3/K4: theme validation ---------------------------------------------

test('K3: theme "Plain" and "toString" each give P-THEME (valid themes: gloam, haze, plain)', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    for (const bad of ['Plain', 'toString']) {
      assertConfigError(
        () => parse(dir, `theme = "${bad}"\n`),
        `campaign "alpha": ${T}: unknown theme "${bad}"; valid themes: gloam, haze, plain`,
      );
    }
  });
});

test('K4: theme = 5 gives P-THEME-TYPE', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    assertConfigError(() => parse(dir, 'theme = 5\n'), `campaign "alpha": ${T}: theme must be a string`);
  });
});

// --- K5: TOML syntax error ------------------------------------------------

test('K5: theme = <nothing> gives a wrapped ConfigError, one line, prefixed correctly', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    assert.throws(
      () => parse(dir, 'theme = '),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.message.startsWith(`campaign "alpha": ${T} is not valid TOML: `));
        assert.ok(!err.message.includes('\n'));
        return true;
      },
    );
  });
});

// --- K6/K7: [images] shape -------------------------------------------------

test('K6: images = "x" gives P-IMAGES-TYPE', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    assertConfigError(() => parse(dir, 'images = "x"\n'), `campaign "alpha": ${T}: [images] must be a table`);
  });
});

test('K7: ground = 5, ground = "", and [images.ground] each give P-SLOT-TYPE', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    const expected = `campaign "alpha": ${T}: [images] ground must be a non-empty string`;
    assertConfigError(() => parse(dir, '[images]\nground = 5\n'), expected);
    assertConfigError(() => parse(dir, '[images]\nground = ""\n'), expected);
    assertConfigError(() => parse(dir, '[images.ground]\nx = 1\n'), expected);
  });
});

// --- K8: warnings ----------------------------------------------------------

test('K8: an unrecognised top-level key and an unrecognised slot each warn and still parse', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);

    const r1 = parse(dir, 'not_a_pack_key = 1\n');
    assert.equal(r1.present, true);
    assert.deepEqual(r1.warnings, [`${T}: unrecognised key "not_a_pack_key" (ignored)`]);

    const r2 = parse(dir, '[images]\nbanner = "x.png"\n');
    assert.equal(r2.present, true);
    assert.deepEqual(r2.warnings, [`${T}: [images] unrecognised slot "banner" (ignored; slots are hero, ground, paper, crest-frame, portrait, 404)`]);
    assert.deepEqual(r2.images, []);
  });
});

// --- K9: SlotRef shape and SLOT_NAMES ordering -----------------------------

test('K9: vault: and pack forms parse to the right SlotRefs, in SLOT_NAMES order', () => {
  withScratchDir((dir) => {
    const text = '[images]\n404 = "images/404.png"\nhero = "vault:_attachments/hero.png"\n';
    const result = parse(dir, text);
    assert.equal(result.images.length, 2);
    assert.deepEqual(result.images[0], { slot: 'hero', raw: 'vault:_attachments/hero.png', kind: 'vault', rel: '_attachments/hero.png' });
    assert.deepEqual(result.images[1], { slot: '404', raw: 'images/404.png', kind: 'pack', rel: 'images/404.png' });
  });
});

test('K16: parsePackToml round-trips theme = "plain"; vocab is the default', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    const result = parse(dir, 'theme = "plain"\n');
    const { vocab, ...rest } = result;
    assert.deepEqual(rest, { path: T, present: true, theme: 'plain', images: [], warnings: [] });
    assert.equal(vocab, DEFAULT_VOCAB);
  });
});

// --- K10-K15: [images] slot syntax refusals ---------------------------------

test('K10: P-BACKSLASH, for both a pack and a vault: value', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    for (const raw of ['images\\a.webp', 'vault:_attachments\\a.webp']) {
      assertConfigError(
        () => parse(dir, `[images]\nground = "${raw.replace(/\\/g, '\\\\')}"\n`),
        `campaign "alpha": ${T}: [images] ground = "${raw}" uses a backslash; write paths with forward slashes, even on Windows`,
      );
    }
  });
});

test('K11: /abs/a.webp, vault:/abs/a.webp and C:/a.webp each give P-ABSOLUTE', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    const D = path.dirname(T);
    for (const raw of ['/abs/a.webp', 'vault:/abs/a.webp', 'C:/a.webp']) {
      assertConfigError(
        () => parse(dir, `[images]\nground = "${raw}"\n`),
        `campaign "alpha": ${T}: [images] ground = "${raw}" is an absolute path; write "vault:<path inside the vault>" or a path relative to ${D}`,
      );
    }
  });
});

test('K12: https://..., file:a.webp and vault:data:x each give P-SCHEME', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    const D = path.dirname(T);
    for (const raw of ['https://example.invalid/a.webp', 'file:a.webp', 'vault:data:x']) {
      assertConfigError(
        () => parse(dir, `[images]\nground = "${raw}"\n`),
        `campaign "alpha": ${T}: [images] ground = "${raw}" is a URL; only files inside the vault ("vault:<path>") or relative to ${D} are allowed`,
      );
    }
  });
});

test('K13: ../a.webp, vault:_attachments/../a.webp and images/.. each give P-DOTDOT', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    const D = path.dirname(T);
    for (const raw of ['../a.webp', 'vault:_attachments/../a.webp', 'images/..']) {
      assertConfigError(
        () => parse(dir, `[images]\nground = "${raw}"\n`),
        `campaign "alpha": ${T}: [images] ground = "${raw}" contains ".."; write "vault:<path inside the vault>" or a path relative to ${D}`,
      );
    }
  });
});

test('K14: images//a.webp, ./a.webp, vault: and images/./a.webp each give P-SEGMENT', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    for (const raw of ['images//a.webp', './a.webp', 'vault:', 'images/./a.webp']) {
      assertConfigError(
        () => parse(dir, `[images]\nground = "${raw}"\n`),
        `campaign "alpha": ${T}: [images] ground = "${raw}" has an empty or "." path segment; write a plain relative path such as "images/example.webp"`,
      );
    }
  });
});

test('K15: vault:_meta/a.webp gives P-META; vault:_META/a.webp gives P-META on win32/darwin, parses on linux', () => {
  withScratchDir((dir) => {
    const T = path.join(dir, PACK_TOML_FILE);
    const D = path.dirname(T);
    assertConfigError(
      () => parse(dir, '[images]\nground = "vault:_meta/a.webp"\n'),
      `campaign "alpha": ${T}: [images] ground = "vault:_meta/a.webp" points into _meta/; put the image in ${D} and write its path relative to that folder instead`,
    );

    for (const platform of ['win32', 'darwin']) {
      withPlatform(platform, () => {
        assertConfigError(
          () => parse(dir, '[images]\nground = "vault:_META/a.webp"\n'),
          `campaign "alpha": ${T}: [images] ground = "vault:_META/a.webp" points into _meta/; put the image in ${D} and write its path relative to that folder instead`,
        );
      });
    }

    withPlatform('linux', () => {
      const result = parse(dir, '[images]\nground = "vault:_META/a.webp"\n');
      assert.deepEqual(result.images[0], { slot: 'ground', raw: 'vault:_META/a.webp', kind: 'vault', rel: '_META/a.webp' });
    });
  });
});
