'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pinned = require('../src/generator/pinned');
const {
  SESSION_BADGE_FIELDS,
  BADGE_FIELD_FALLBACKS,
  BADGE_MARKER,
  presentFields,
  annotateSessionBadges,
  applySessionBadgeFields,
} = require('../src/build/sessionbadges');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-badges-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function frontmatterBlock(fm) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\nBody.\n`;
}

// Builds a tmp vault with a Sessions/ folder (folderMap Sessions -> sessions) and a matching
// staged site tree, one page per entry in `pages` ({ name, frontmatter }). Every page's built
// HTML embeds pinned.metadataBadgesFor's own output for that frontmatter (post
// publishedFrontmatter), inside a base.js-shaped page, unless `html` is supplied directly (the
// mismatch case). Returns { vaultPath, siteRoot, jsonConfig }.
function buildFixture(dir, { pages, excludeFields } = {}) {
  const vaultPath = path.join(dir, 'vault');
  const siteRoot = path.join(dir, 'site');
  fs.mkdirSync(path.join(vaultPath, 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(siteRoot, 'sessions'), { recursive: true });

  const excludeYaml = excludeFields ? `\n  exclude_fields:\n${excludeFields.map((f) => `    - ${f}`).join('\n')}` : '';
  fs.writeFileSync(
    path.join(vaultPath, '_meta', 'vault-config.md'),
    `---\ntype: meta\npublish:\n  mode: full${excludeYaml}\n---\n\nConfig.\n`,
  );

  const jsonConfig = { folderMap: { Sessions: 'sessions' }, excludeFields: excludeFields || [] };

  for (const p of pages) {
    fs.writeFileSync(path.join(vaultPath, 'Sessions', `${p.name}.md`), frontmatterBlock(p.frontmatter));

    const outputPath = `sessions/${pinned.slugify(p.name)}.html`;
    fs.mkdirSync(path.dirname(path.join(siteRoot, outputPath)), { recursive: true });

    let badgeBlock;
    if (p.html !== undefined) {
      badgeBlock = p.html;
    } else {
      const publishedFm = pinned.publishedFrontmatter(p.frontmatter, excludeFields || [], {});
      badgeBlock = pinned.metadataBadgesFor(publishedFm);
    }

    const html = `<!DOCTYPE html>\n<html><head></head><body>\n<main class="content">\n<h1 class="page-title">${p.name}</h1>\n${badgeBlock}\n<p>Body.</p>\n</main>\n</body></html>`;
    fs.writeFileSync(path.join(siteRoot, outputPath), html);
  }

  return { vaultPath, siteRoot, jsonConfig };
}

// -- presentFields ----------------------------------------------------------------------------

test('presentFields: all four fields present', () => {
  const fields = presentFields({ session_number: 1, play_date: '2026-09-04', status: 'reviewed', stage: 'Aftermath' });
  assert.deepEqual(fields, ['session_number', 'play_date', 'status', 'stage']);
});

test('presentFields: no status', () => {
  const fields = presentFields({ session_number: 2, play_date: '2026-09-11' });
  assert.deepEqual(fields, ['session_number', 'play_date']);
});

test('presentFields: stage set, no status', () => {
  const fields = presentFields({ session_number: 3, play_date: '2026-09-17', stage: 'Splinter Hollow' });
  assert.deepEqual(fields, ['session_number', 'play_date', 'stage']);
});

test('presentFields: no session_number', () => {
  const fields = presentFields({ play_date: '2026-09-18', status: 'reviewed' });
  assert.deepEqual(fields, ['play_date', 'status']);
});

test('presentFields: no play_date, actual_date fills in -- field is still "play_date"', () => {
  const fields = presentFields({ session_number: 5, actual_date: '2026-09-19', status: 'reviewed' });
  assert.deepEqual(fields, ['session_number', 'play_date', 'status']);
});

test('presentFields: wiki-link brackets stripped, empty-after-strip is skipped', () => {
  const fields = presentFields({ session_number: '[[]]', play_date: '2026-09-04' });
  assert.deepEqual(fields, ['play_date']);
});

// -- annotateSessionBadges (unit) --------------------------------------------------------------

test('annotateSessionBadges: idempotent, marker checked first', () => {
  const fm = { type: 'session', session_number: 1, play_date: '2026-09-04', status: 'reviewed', stage: 'Aftermath' };
  const block = pinned.metadataBadgesFor(fm);
  const html = `<main>${block}</main>`;
  const once = annotateSessionBadges(html, fm);
  assert.notEqual(once, null);
  assert.equal(annotateSessionBadges(once, fm), null);
});

test('annotateSessionBadges: returns null when the expected block is absent', () => {
  const fm = { type: 'session', session_number: 1 };
  assert.equal(annotateSessionBadges('<main>no badges here</main>', fm), null);
});

test('annotateSessionBadges: returns null when the expected block occurs more than once', () => {
  const fm = { type: 'session', session_number: 1, play_date: '2026-09-04' };
  const block = pinned.metadataBadgesFor(fm);
  const html = `<main>${block}</main><aside>${block}</aside>`;
  assert.equal(annotateSessionBadges(html, fm), null);
});

// -- Drift binding ------------------------------------------------------------------------------

test('pinned.TYPE_BADGE_FIELDS.session deep-equals SESSION_BADGE_FIELDS', () => {
  assert.deepEqual(pinned.TYPE_BADGE_FIELDS.session, SESSION_BADGE_FIELDS);
});

test('BADGE_FIELD_FALLBACKS matches base.js:140 for play_date', () => {
  assert.deepEqual(BADGE_FIELD_FALLBACKS, { play_date: 'actual_date' });
});

// -- applySessionBadgeFields (real tmp vault + staged site) -------------------------------------

test('applySessionBadgeFields: annotates every session page variant correctly', () => {
  withTmpDir((dir) => {
    const { vaultPath, siteRoot, jsonConfig } = buildFixture(dir, {
      pages: [
        { name: 'full', frontmatter: { type: 'session', session_number: 1, play_date: '2026-09-04', status: 'reviewed', stage: 'Aftermath' } },
        { name: 'no-status', frontmatter: { type: 'session', session_number: 2, play_date: '2026-09-11' } },
        { name: 'stage-no-status', frontmatter: { type: 'session', session_number: 3, play_date: '2026-09-17', stage: 'Splinter Hollow' } },
        { name: 'no-number', frontmatter: { type: 'session', play_date: '2026-09-18', status: 'reviewed' } },
        { name: 'no-playdate-actual', frontmatter: { type: 'session', session_number: 5, actual_date: '2026-09-19', status: 'reviewed' } },
      ],
    });

    const result = applySessionBadgeFields(siteRoot, { vaultPath, jsonConfig });
    assert.equal(result.pagesAnnotated, 5);
    assert.deepEqual(result.unmatched, []);

    const full = fs.readFileSync(path.join(siteRoot, 'sessions/full.html'), 'utf8');
    assert.match(full, /<div class="metadata-badges" data-scriptorium-badges>/);
    assert.match(full, /<span class="metadata-badge" data-field="session_number">1<\/span>/);
    assert.match(full, /<span class="metadata-badge" data-field="play_date">2026-09-04<\/span>/);
    assert.match(full, /<span class="metadata-badge" data-field="status">reviewed<\/span>/);
    assert.match(full, /<span class="metadata-badge" data-field="stage">Aftermath<\/span>/);

    const noStatus = fs.readFileSync(path.join(siteRoot, 'sessions/no-status.html'), 'utf8');
    assert.doesNotMatch(noStatus, /data-field="status"/);
    assert.match(noStatus, /data-field="session_number"/);
    assert.match(noStatus, /data-field="play_date"/);

    const stageNoStatus = fs.readFileSync(path.join(siteRoot, 'sessions/stage-no-status.html'), 'utf8');
    assert.match(stageNoStatus, /data-field="stage"/);
    assert.doesNotMatch(stageNoStatus, /data-field="status"/);

    const noNumber = fs.readFileSync(path.join(siteRoot, 'sessions/no-number.html'), 'utf8');
    assert.doesNotMatch(noNumber, /data-field="session_number"/);
    assert.match(noNumber, /data-field="play_date"/);
    assert.match(noNumber, /data-field="status"/);

    // play_date field name even though actual_date supplied the value.
    const fallback = fs.readFileSync(path.join(siteRoot, 'sessions/no-playdate-actual.html'), 'utf8');
    assert.match(fallback, /<span class="metadata-badge" data-field="play_date">2026-09-19<\/span>/);
    assert.doesNotMatch(fallback, /data-field="actual_date"/);

    // Idempotent: a second pass annotates 0 pages.
    const second = applySessionBadgeFields(siteRoot, { vaultPath, jsonConfig });
    assert.equal(second.pagesAnnotated, 0);
  });
});

test('applySessionBadgeFields: exclude_fields drops status entirely -- three spans', () => {
  withTmpDir((dir) => {
    const { vaultPath, siteRoot, jsonConfig } = buildFixture(dir, {
      excludeFields: ['status'],
      pages: [
        { name: 'excluded', frontmatter: { type: 'session', session_number: 6, play_date: '2026-09-20', status: 'reviewed', stage: 'Denouement' } },
      ],
    });

    const result = applySessionBadgeFields(siteRoot, { vaultPath, jsonConfig });
    assert.equal(result.pagesAnnotated, 1);

    const html = fs.readFileSync(path.join(siteRoot, 'sessions/excluded.html'), 'utf8');
    assert.doesNotMatch(html, /data-field="status"/);
    const spanCount = (html.match(/class="metadata-badge"/g) || []).length;
    assert.equal(spanCount, 3);
  });
});

test('applySessionBadgeFields: a page whose block differs from the derived expectation is reported unmatched, byte-untouched', () => {
  withTmpDir((dir) => {
    const { vaultPath, siteRoot, jsonConfig } = buildFixture(dir, {
      pages: [
        {
          name: 'drift',
          frontmatter: { type: 'session', session_number: 7, play_date: '2026-09-21', status: 'reviewed' },
          html: '<div class="metadata-badges"><span class="metadata-badge">SOMETHING ELSE</span></div>',
        },
      ],
    });

    const before = fs.readFileSync(path.join(siteRoot, 'sessions/drift.html'), 'utf8');
    const result = applySessionBadgeFields(siteRoot, { vaultPath, jsonConfig });
    assert.equal(result.pagesAnnotated, 0);
    assert.deepEqual(result.unmatched, ['sessions/drift.html']);

    const after = fs.readFileSync(path.join(siteRoot, 'sessions/drift.html'), 'utf8');
    assert.equal(after, before, 'a page whose block does not match must be left byte-untouched');
  });
});

// -- Mutation proofs (recorded manually in the Engineer report; this suite is the gate) -----------
// positional assignment against the full list (SESSION_BADGE_FIELDS[i]): the no-status and
//   no-number cases get the wrong data-field.
// dropping the fallback (BADGE_FIELD_FALLBACKS): the no-playdate-actual case fails.
// skipping publishedFrontmatter (using page.frontmatter directly): the exclude_fields case fails
//   (status would still be present).
