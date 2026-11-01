'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildCheckContext } = require('../src/checks/context');
const { runNameCollision, runHiddenName, collectWithheldNames } = require('../src/checks/leak/l4');
const { CHECKS, getCheck, defaultEnabledChecks } = require('../src/checks/registry');
const { RUNNERS } = require('../src/checks/run');

const PIN_VAULT = path.join(__dirname, 'fixtures', 'pin-vault');
const PIN_SITE_CONFIG = require(path.join(__dirname, 'fixtures', 'pin-vault-site-config.json'));

const { onLayout } = require('./helpers/moved-vault');

// Every vault-backed case runs on both settings layouts: the old _meta/vault-config.md and the
// moved _meta/vault-config.yaml. The assertions are the same on both.
const LAYOUTS = ['legacy', 'new'];
const scratchRoots = [];
const onLayoutCache = {};
function pinOn(layout) {
  if (!onLayoutCache[layout]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l4-collision-'));
    scratchRoots.push(root);
    onLayoutCache[layout] = onLayout(layout, PIN_VAULT, PIN_SITE_CONFIG, root);
  }
  return onLayoutCache[layout];
}
test.after(() => {
  for (const r of scratchRoots) fs.rmSync(r, { recursive: true, force: true });
});

function pinContext(layout) {
  return buildCheckContext({ campaign: 'pin-vault', ...pinOn(layout) });
}

// --- AC-D1-01: registered, wired, frozen, nothing else renumbered --------

test('AC-D1-01: leak/l4-name-collision is registered, wired in run.js, and no existing id changed', () => {
  const check = getCheck('leak/l4-name-collision');
  assert.equal(check.category, 'leak');
  assert.equal(check.defaultSeverity, 'error');
  assert.equal(check.defaultEnabled, true);
  assert.equal(check.requiresFlag, null);
  assert.equal(typeof RUNNERS['leak/l4-name-collision'], 'function');
  assert.equal(RUNNERS['leak/l4-name-collision'], runNameCollision);

  const enabled = defaultEnabledChecks();
  assert.ok(enabled.some((c) => c.id === 'leak/l4-name-collision'));

  // leak/l4-hidden-name still exists, unrenumbered, unchanged category/severity.
  const hidden = getCheck('leak/l4-hidden-name');
  assert.equal(hidden.category, 'leak');
  assert.equal(hidden.defaultSeverity, 'error');

  const ids = CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'every id still unique');
});

for (const layout of LAYOUTS) {
  // --- AC-D1-02: a published alias exactly matching the withheld title -----

  test(`AC-D1-02: a published page aliased exactly to the withheld title produces one collision naming both files, via alias, and no hidden-name finding for that name [${layout}]`, () => {
    const ctx = pinContext(layout);
    const collisions = runNameCollision(ctx);

    const hits = collisions.filter((f) => f.data.hiddenName === 'Ondrej Vasek');
    assert.equal(hits.length, 1, 'exactly one collision for the colliding name');
    const hit = hits[0];
    assert.equal(hit.id, 'leak/l4-name-collision');
    assert.equal(hit.severity, 'error');
    assert.equal(hit.path, 'Characters/NPCs/Collision-Hidden.md');
    assert.equal(hit.data.withheldEntity, 'Characters/NPCs/Collision-Hidden.md');
    assert.equal(hit.data.publishedPath, 'Characters/NPCs/Published-Collision.md');
    assert.equal(hit.data.via, 'alias');
    assert.equal(hit.data.selfPublished, false);
    assert.match(hit.message, /Collision-Hidden\.md/);
    assert.match(hit.message, /Published-Collision\.md/);

    const hiddenFindings = runHiddenName(ctx);
    assert.ok(
      !hiddenFindings.some((f) => f.data.hiddenName === 'Ondrej Vasek'),
      'a collided name must never also produce a leak/l4-hidden-name finding',
    );
  });

  // --- AC-D1-03: the withheld entity is itself the published page ----------

  test(`AC-D1-03: a withheld entity that is itself published produces selfPublished: true and a message that says so [${layout}]`, () => {
    const ctx = pinContext(layout);
    const collisions = runNameCollision(ctx);
    const hit = collisions.find((f) => f.data.withheldEntity === 'Characters/NPCs/SelfPublished-Hidden.md');
    assert.ok(hit, 'SelfPublished-Hidden.md must produce a collision against its own published page');
    assert.equal(hit.data.selfPublished, true);
    assert.equal(hit.data.publishedPath, 'Characters/NPCs/SelfPublished-Hidden.md');
    assert.match(hit.message, /itself published/);
  });

  // --- AC-D1-04 (FR-02): hiddenNames and collisions[].name partition candidateNames ---

  test(`AC-D1-04: for every withheld entity, hiddenNames and collisions[].name are disjoint and their union equals candidateNames [${layout}]`, () => {
    const ctx = pinContext(layout);
    const rows = collectWithheldNames(ctx);
    assert.ok(rows.length > 0, 'the fixture vault must carry at least one withheld entity');

    for (const { entity, candidateNames, hiddenNames, collisions } of rows) {
      const collisionNames = collisions.map((c) => c.name);
      const union = new Set([...hiddenNames, ...collisionNames]);
      assert.deepEqual(
        [...union].sort(),
        [...candidateNames].sort(),
        `${entity.relPath}: hiddenNames ∪ collisions[].name must equal candidateNames`,
      );
      const intersection = hiddenNames.filter((n) => collisionNames.includes(n));
      assert.deepEqual(intersection, [], `${entity.relPath}: hiddenNames and collisions[].name must be disjoint`);
    }
  });

  // --- Collision-Hidden.md's OTHER candidate name is unaffected ------------

  test(`a collision on one candidate name does not remove the entity's other candidate names from hiddenNames [${layout}]`, () => {
    const ctx = pinContext(layout);
    const rows = collectWithheldNames(ctx);
    const row = rows.find((r) => r.entity.relPath === 'Characters/NPCs/Collision-Hidden.md');
    assert.ok(row);
    // The filename stem "Collision-Hidden" never collided with anything and must stay hidden.
    assert.ok(row.hiddenNames.includes('Collision-Hidden'));
    assert.ok(row.collisions.some((c) => c.name === 'Ondrej Vasek'));
  });

  // --- Novelle sanity is not this fixture's job, but Gus Marzone must be unaffected ---

  test(`Gus-Hidden.md's hidden name is untouched by the unrelated collision fixtures [${layout}]`, () => {
    const ctx = pinContext(layout);
    const rows = collectWithheldNames(ctx);
    const row = rows.find((r) => r.entity.relPath === 'Characters/NPCs/Gus-Hidden.md');
    assert.ok(row);
    assert.equal(row.collisions.length, 0, 'Gus-Hidden.md must not be caught up in the new collision fixtures');
    assert.ok(row.hiddenNames.includes('Gus Marzone'));
  });
}
