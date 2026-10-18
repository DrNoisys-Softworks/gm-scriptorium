'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAtomicBuild } = require('../src/build/run');

const STORY_VAULT = path.join(__dirname, 'fixtures', 'story-vault');
const STORY_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'story-vault-site-config.json'));

// Pin change detector (docs/decisions/0006-post-build-page-writer.md, last addendum). Scriptorium no
// longer writes sessions/index.html: the pin has since publish-v1.11.40 (upstream #214). If a later pin
// stops writing it, this test fails at the pin bump, by name, instead of a site losing its Sessions page.
test('a real build of story-vault: the pin writes sessions/index.html itself, and Scriptorium runs no writer of its own', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-story-sessions-index-'));
  try {
    const siteDir = path.join(scratch, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    const finalOut = path.join(scratch, 'out');
    const buildResult = runAtomicBuild({
      vaultPath: STORY_VAULT,
      userJsonConfig: { ...STORY_SITE_CONFIG, vaultPath: STORY_VAULT },
      finalOut,
      siteDir,
      campaign: 'story-vault-sessions-index',
      force: true,
    });
    assert.equal(buildResult.ok, true, buildResult.ok ? '' : JSON.stringify(buildResult.renderErrors));
    assert.equal('sessionsIndex' in buildResult, false, 'the retired Sessions page writer still runs');

    const html = fs.readFileSync(path.join(finalOut, 'sessions', 'index.html'), 'utf8');
    assert.match(html, /<main class="content"/, 'the Sessions page is not a full page from the pin\'s own shell');
    const sessionPages = fs.readdirSync(path.join(finalOut, 'sessions')).filter((f) => f.endsWith('.html') && f !== 'index.html');
    assert.ok(sessionPages.length > 0, 'positive control: story-vault published no session pages');
    for (const f of sessionPages) assert.ok(html.includes(`href="${f}"`), `the Sessions page does not link ${f}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
