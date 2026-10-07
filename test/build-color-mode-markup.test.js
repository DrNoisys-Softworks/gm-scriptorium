'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runAtomicBuild } = require('../src/build/run');
const { applyPageTurn } = require('../src/build/pageturn');
const { injectHouseStyleLinks } = require('../src/build/housestyle');
const { applyAccordionOpen } = require('../src/build/accordions');
const { applyDateFormat } = require('../src/build/dates');
const { applySessionBadgeFields } = require('../src/build/sessionbadges');

/*
 * FR-08 / SD-12 (R1 repin, publish-v1.11.40): "no transform code changes" is a claim about
 * src/build/*, not evidence. This is the real-build markup and idempotency proof the brief
 * requires, against grapheme-vault (no theme.palette override, so the pin's own color-mode
 * toggle renders -- C48) built with the REAL, installed v1.11.40 pin.
 *
 * NOTE on scope vs. the superseded ac2ebad architect spec: that spec's idempotency list included
 * `applyRecapEmphasis`. At publish-v1.11.40 that module is retired (FR-20/SD-20 -- upstream's own
 * `extractRecapHtml` renders the emphasis now); it is deliberately omitted below rather than
 * imported from a deleted file.
 */

const GRAPHEME_VAULT = path.join(__dirname, 'fixtures', 'grapheme-vault');
const GRAPHEME_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'grapheme-vault-site-config.json'));

function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function hashTree(dir) {
  const hash = crypto.createHash('sha256');
  const files = walkHtml(dir)
    .concat(
      (function walkAll(d, o = []) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walkAll(full, o);
          else o.push(full);
        }
        return o;
      })(dir),
    )
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .sort();
  for (const f of files) {
    hash.update(path.relative(dir, f));
    hash.update(fs.readFileSync(f));
  }
  return hash.digest('hex');
}

test('FR-08: a real build of grapheme-vault at publish-v1.11.40 shows the color-mode toggle and head script, every Scriptorium transform anchored correctly, and re-running every transform is a no-op', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-color-mode-markup-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...GRAPHEME_SITE_CONFIG, vaultPath: GRAPHEME_VAULT };
    const finalOut = path.join(scratch, 'out');

    const buildResult = runAtomicBuild({
      vaultPath: GRAPHEME_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'grapheme-vault-color-mode-markup',
      force: true,
    });
    assert.equal(buildResult.ok, true, buildResult.ok ? '' : JSON.stringify(buildResult.renderErrors));

    const htmlFiles = walkHtml(finalOut);
    assert.ok(htmlFiles.length > 0, 'the build produced no HTML pages to check');

    let topNavPages = 0;
    let titlePages = 0;
    for (const f of htmlFiles) {
      const html = fs.readFileSync(f, 'utf8');
      const rel = path.relative(finalOut, f);

      // Positive control: every page with <title> has the pin's color-mode head script
      // (gm-apprentice:color-mode:<key>) before <title>.
      const titleIdx = html.indexOf('<title>');
      if (titleIdx !== -1) {
        titlePages++;
        const scriptIdx = html.indexOf('gm-apprentice:color-mode:');
        assert.ok(scriptIdx !== -1 && scriptIdx < titleIdx, `${rel}: no gm-apprentice:color-mode: head script before <title>`);
      }

      // Positive control: every page with <header class="top-nav"> has the toggle button,
      // after that header's own </nav> and before its </header>.
      const headerIdx = html.indexOf('<header class="top-nav">');
      if (headerIdx !== -1) {
        topNavPages++;
        const navCloseIdx = html.indexOf('</nav>', headerIdx);
        const headerCloseIdx = html.indexOf('</header>', headerIdx);
        assert.ok(navCloseIdx !== -1 && headerCloseIdx !== -1, `${rel}: missing </nav> or </header>`);
        const btnIdx = html.indexOf('nav-color-mode-btn', headerIdx);
        assert.ok(
          btnIdx !== -1 && btnIdx > navCloseIdx && btnIdx < headerCloseIdx,
          `${rel}: nav-color-mode-btn not positioned after </nav> and before </header>`,
        );
      }

      // Per-page: exactly one housestyle marker, after the theme.css link; exactly one
      // pageturn marker, before </head>.
      const houseHits = (html.match(/data-scriptorium-housestyle/g) || []).length;
      assert.equal(houseHits, 1, `${rel}: expected exactly one data-scriptorium-housestyle, got ${houseHits}`);
      const themeLinkIdx = html.indexOf('href="css/theme.css"') !== -1 ? html.indexOf('href="css/theme.css"') : html.search(/href="[./]*css\/theme\.css"/);
      const houseIdx = html.indexOf('data-scriptorium-housestyle');
      assert.ok(themeLinkIdx !== -1 && houseIdx > themeLinkIdx, `${rel}: housestyle link not after the theme.css link`);

      const pageturnHits = (html.match(/data-scriptorium-pageturn/g) || []).length;
      assert.equal(pageturnHits, 1, `${rel}: expected exactly one data-scriptorium-pageturn, got ${pageturnHits}`);
      const headCloseIdx = html.indexOf('</head>');
      assert.ok(headCloseIdx !== -1 && html.indexOf('data-scriptorium-pageturn') < headCloseIdx, `${rel}: pageturn marker not before </head>`);

    }
    assert.ok(topNavPages > 0, 'no page had <header class="top-nav">, positive control did not fire');
    assert.ok(titlePages > 0, 'no page had <title>, positive control did not fire');

    // Idempotency: hash the tree, re-run every Scriptorium build-time transform, and confirm
    // every one patches 0 and the tree hash is unchanged.
    const beforeHash = hashTree(finalOut);

    const pageTurn2 = applyPageTurn(finalOut);
    const houseLinked2 = injectHouseStyleLinks(finalOut);
    const accordions2 = applyAccordionOpen(finalOut);
    const dates2 = applyDateFormat(finalOut);
    const badges2 = applySessionBadgeFields(finalOut, { vaultPath: GRAPHEME_VAULT, jsonConfig: userJsonConfig });

    assert.equal(pageTurn2.pagesPatched, 0, 'applyPageTurn re-run patched pages, not idempotent');
    assert.equal(houseLinked2, 0, 'injectHouseStyleLinks re-run linked pages, not idempotent');
    assert.equal(accordions2.pagesPatched, 0, 'applyAccordionOpen re-run patched pages, not idempotent');
    assert.equal(dates2.pagesPatched, 0, 'applyDateFormat re-run patched pages, not idempotent');
    assert.equal(badges2.pagesAnnotated, 0, 'applySessionBadgeFields re-run annotated pages, not idempotent');

    const afterHash = hashTree(finalOut);
    assert.equal(afterHash, beforeHash, 'the output tree changed after re-running every transform');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
