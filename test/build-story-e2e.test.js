'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');
const { SITE_SCRIPT_MARKER, EMBEDDED_SITE_SCRIPT_PATH } = require('../src/build/sitescript');
const { computePublishedSet } = require('../src/vault/publishset');

const STORY_VAULT = path.join(__dirname, 'fixtures', 'story-vault');
const STORY_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'story-vault-site-config.json'));

function walkHtml(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) out.push(full);
    }
  })(dir);
  return out;
}

test('build-story-e2e: a real runAtomicBuild on story-vault', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-story-e2e-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...STORY_SITE_CONFIG, vaultPath: STORY_VAULT };
    const finalOut = path.join(scratch, 'out');

    const result = runAtomicBuild({
      vaultPath: STORY_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'story-e2e',
      force: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error && result.error.message));

    // -- timeline ---------------------------------------------------------------------------
    assert.equal(result.timeline.pagesPatched, 1, JSON.stringify(result.timeline.warnings));
    assert.equal(result.timeline.target, 'campaign/timeline.html');
    assert.equal(result.timeline.points, 7); // 1 backstory row + 6 campaign rows

    // no root timeline.html
    assert.ok(!fs.existsSync(path.join(finalOut, 'timeline.html')));

    const timelineHtml = fs.readFileSync(path.join(finalOut, 'campaign', 'timeline.html'), 'utf8');
    assert.ok(timelineHtml.includes('data-scriptorium-timeline'));
    // no timestamps survive
    assert.doesNotMatch(timelineHtml.split('sc-tl-data">')[1].split('</script>')[0], /\d{1,2}:\d{2}/);

    // -- connections --------------------------------------------------------------------------
    assert.ok(result.connections.pagesPatched >= 1, JSON.stringify(result.connections.warnings));

    // -- site script --------------------------------------------------------------------------
    const scriptPath = path.join(finalOut, 'js', 'scriptorium.js');
    assert.ok(fs.existsSync(scriptPath));
    const written = fs.readFileSync(scriptPath);
    const embedded = fs.readFileSync(EMBEDDED_SITE_SCRIPT_PATH);
    assert.ok(written.equals(embedded));

    const htmlFiles = walkHtml(finalOut);
    let linkedCount = 0;
    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      if (html.includes(SITE_SCRIPT_MARKER)) linkedCount++;
    }
    assert.equal(linkedCount, result.timeline.pagesPatched + result.connections.lanes + result.connections.hubOnly);
    assert.ok(linkedCount < htmlFiles.length, 'the script must not be linked on every page');

    // -- .vt-fx stays immediately before </main> on the timeline leaf ---------------------------
    const mainCloseIdx = timelineHtml.indexOf('</main>');
    const beforeMainClose = timelineHtml.slice(Math.max(0, mainCloseIdx - 60), mainCloseIdx);
    assert.match(beforeMainClose, /<div class="vt-fx" aria-hidden="true"><\/div>\s*$/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// -- T-C14: search-index.json documents equal computePublishedSet, by outputPath ---------------
// At publish-v1.11.40 (Δ), documents are keyed by an opaque base-36 ref (i.toString(36)), not by
// outputPath; each document's own `href` field holds the output path instead
// (docs/agent-runs/repin-v1.11.40-engineering-brief-2026-09-30.md's delta map). Map through href.

test('T-C14: search-index.json {title,type} equals computePublishedSet for every outputPath (mapped through href)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-story-c14-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const userJsonConfig = { ...STORY_SITE_CONFIG, vaultPath: STORY_VAULT };
    const finalOut = path.join(scratch, 'out');

    const result = runAtomicBuild({
      vaultPath: STORY_VAULT,
      userJsonConfig,
      finalOut,
      siteDir,
      campaign: 'story-c14',
      force: true,
    });
    assert.equal(result.ok, true);

    const searchIndexPath = path.join(finalOut, 'search-index.json');
    assert.ok(fs.existsSync(searchIndexPath), 'expected search-index.json (searchEnabled defaults true)');
    const searchIndex = JSON.parse(fs.readFileSync(searchIndexPath, 'utf8'));

    const { publishedPages } = computePublishedSet(STORY_VAULT, userJsonConfig);
    const byOutputPath = new Map(publishedPages.map((p) => [p.outputPath, p]));

    let checked = 0;
    let unmapped = 0;
    for (const [ref, doc] of Object.entries(searchIndex.documents)) {
      assert.equal(ref, Number(ref).toString(36), `document ref "${ref}" is not the expected base-36 shape`);
      assert.equal(typeof doc.href, 'string', `document ${ref} has no href`);
      const outputPath = doc.href;
      const page = byOutputPath.get(outputPath);
      if (!page) {
        unmapped++;
        continue;
      }
      assert.equal(doc.title, page.displayTitle, outputPath);
      assert.equal(doc.type, page.frontmatter.type || '', outputPath);
      checked++;
    }
    assert.equal(unmapped, 0, `${unmapped} document href(s) computePublishedSet does not account for`);
    assert.ok(checked > 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
