'use strict';

/*
 * The facade's stripMovedSettings copies the rule of the pin's own stripSiteKeys, which the pin does
 * not export. This compares the two on a pack that covers each kind of key, so a pin bump that
 * changes the pin's rule fails here instead of letting `check` and the carry disagree. The pin's
 * answer is what its own planMove takes out of a site file, and what is left in that file once the
 * plan is applied. The pin is required directly: test-only, like test/helpers/moved-vault.js.
 *
 * Two references, one for each use:
 *   - the move (the carry): planMove when the site's tool can read the new file, so the five
 *     site-folder keys move into the yaml and leave the file;
 *   - staging (the build): planMove when the site's tool cannot yet read them from the vault, so the
 *     pin strips with its own `leaveFallback` and the five stay in the file, as a build needs them.
 *     The pin decides that from its update-pin answer, which pinCheck stands in for here: a site
 *     tool at 1.0.0, older than the first that reads the new file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');
const pinned = require('../src/generator/pinned');
const { planMove, applyMove } = require('gm-apprentice-publish/lib/settings/move');

const PACK = {
  siteTitle: 'Parity Title',
  landingTagline: 'a name the pin no longer reads',
  host: 'github-pages',
  attachmentsDir: '_attachments',
  folderMap: { Sessions: 'sessions' },
  excludeDirs: ['_meta', '_Templates', 'Secret Folder'],
  excludeSections: ['GM Notes', 'Pack Only Secret'],
  excludeCallouts: true,
  backend: { statusBar: true, inbox: false },
  siteUrl: 'https://example.org/lease/',
  projectName: 'lease',
  fourOhFour: { message: 'Not here.', style: 'plain' },
  somethingTheMoveDoesNotKnow: 'stays',
};

// Typed by hand (sorted): the keys that must come out of the pack. `projectName` is a site-folder key the pin
// leaves in the file, and `somethingTheMoveDoesNotKnow` is not a setting at all; both must stay.
const EXPECTED_REMOVED = [
  'attachmentsDir',
  'backend.inbox',
  'backend.statusBar',
  'excludeCallouts',
  'excludeDirs',
  'excludeSections',
  'folderMap',
  'fourOhFour.message',
  'fourOhFour.style',
  'host',
  'landingTagline',
  'siteTitle',
  'siteUrl',
];

// What the pin's update-pin check would say about a site folder whose tool is at 1.0.0, not ours.
const OLD_SITE_TOOL = () => ({ spec: '1.0.0', ours: false });

function pinsAnswer(root, { pinCheck = () => null } = {}) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  const siteDir = path.join(root, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const siteFile = path.join(siteDir, 'vault.config.json');
  fs.writeFileSync(siteFile, JSON.stringify({ ...PACK, vaultPath }, null, 2));
  const plan = planMove({ vaultPath, siteConfigPath: siteFile, foldSiteFile: true }, { pinCheck });
  assert.equal(plan.ok, true, plan.blockers.join('; '));
  const said = plan.lines.map((l) => /^Will (?:take|remove) the settings (?:out of|from) .*?: (.+?)\.(?: |$)/.exec(l)).find(Boolean);
  assert.ok(said, `the pin's plan names no removed keys:\n${plan.lines.join('\n')}`);
  applyMove(plan, { pinCheck });
  const left = JSON.parse(fs.readFileSync(siteFile, 'utf8'));
  delete left.vaultPath;
  return { removed: said[1].split(', ').sort(), left };
}

test('stripMovedSettings removes exactly the keys the pin takes out of a site file', () => {
  withScratch((root) => {
    const theirs = pinsAnswer(root);
    const ours = pinned.stripMovedSettings(PACK);
    assert.deepEqual([...ours.removed].sort(), theirs.removed);
    assert.deepEqual(ours.config, theirs.left);
  });
});

test('the hand-typed list: what the pin takes out of the covering pack', () => {
  withScratch((root) => {
    assert.deepEqual(pinsAnswer(root).removed, EXPECTED_REMOVED);
    assert.deepEqual([...pinned.stripMovedSettings(PACK).removed].sort(), EXPECTED_REMOVED);
    assert.deepEqual(pinned.stripMovedSettings(PACK).config, { projectName: 'lease', somethingTheMoveDoesNotKnow: 'stays' });
  });
});

test('stripMovedSettings with leaveFallback removes exactly what the pin takes out when it leaves the site-folder keys', () => {
  withScratch((root) => {
    const theirs = pinsAnswer(root, { pinCheck: OLD_SITE_TOOL });
    const ours = pinned.stripMovedSettings(PACK, { leaveFallback: true });
    assert.deepEqual([...ours.removed].sort(), theirs.removed);
    assert.deepEqual(ours.config, theirs.left);
  });
});

test('the hand-typed list for staging: the move\'s list without the site-folder keys host and siteUrl', () => {
  withScratch((root) => {
    const STAGING_REMOVED = EXPECTED_REMOVED.filter((k) => !['host', 'siteUrl'].includes(k));
    assert.deepEqual(STAGING_REMOVED.length, 11);
    assert.deepEqual(pinsAnswer(root, { pinCheck: OLD_SITE_TOOL }).removed, STAGING_REMOVED);
    assert.deepEqual([...pinned.stripMovedSettings(PACK, { leaveFallback: true }).removed].sort(), STAGING_REMOVED);
    assert.deepEqual(pinned.stripMovedSettings(PACK, { leaveFallback: true }).config, {
      host: 'github-pages',
      siteUrl: 'https://example.org/lease/',
      projectName: 'lease',
      somethingTheMoveDoesNotKnow: 'stays',
    });
  });
});
