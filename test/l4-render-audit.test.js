'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { auditNamesAgainstBuild } = require('../scripts/l4-render-audit');

function withScratchOut(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-l4-audit-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeHtml(outDir, relPath, text) {
  const full = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

test('auditNamesAgainstBuild: a finding whose name IS in its cited output lands in Bucket A (confirmed)', () => {
  withScratchOut((outDir) => {
    writeHtml(outDir, 'characters/npcs/cal.html', '<html><body>Some text mentioning Secret Name here.</body></html>');
    const findings = [
      {
        id: 'leak/l4-hidden-name',
        path: 'Characters/NPCs/Cal.md',
        outputPath: 'characters/npcs/cal.html',
        data: { hiddenName: 'Secret Name' },
      },
    ];
    const result = auditNamesAgainstBuild(outDir, findings, ['Secret Name']);
    assert.equal(result.confirmed.length, 1);
    assert.equal(result.confirmed[0].name, 'Secret Name');
    assert.deepEqual(result.bucketB, []);
    assert.deepEqual(result.unconfirmed, []);
  });
});

test('auditNamesAgainstBuild: a name present in built HTML with no finding accounting for it lands in Bucket B (fail-open)', () => {
  withScratchOut((outDir) => {
    writeHtml(outDir, 'index.html', '<html><body>Recency card mentioning Secret Name in an excerpt.</body></html>');
    const findings = []; // nothing reported it
    const result = auditNamesAgainstBuild(outDir, findings, ['Secret Name']);
    assert.equal(result.bucketB.length, 1);
    assert.equal(result.bucketB[0].outputPath, 'index.html');
    assert.equal(result.bucketB[0].name, 'Secret Name');
  });
});

test('auditNamesAgainstBuild: a finding whose name is absent from every output it cites lands in Bucket C (unconfirmed)', () => {
  withScratchOut((outDir) => {
    writeHtml(outDir, 'characters/npcs/cal.html', '<html><body>No secret text here at all.</body></html>');
    const findings = [
      {
        id: 'leak/l4-hidden-name',
        path: 'Characters/NPCs/Cal.md',
        outputPath: 'characters/npcs/cal.html',
        data: { hiddenName: 'Secret Name' },
      },
    ];
    const result = auditNamesAgainstBuild(outDir, findings, ['Secret Name']);
    assert.equal(result.confirmed.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.unconfirmed[0].name, 'Secret Name');
  });
});

test('auditNamesAgainstBuild: a story-arm finding is confirmed if the name appears at ANY of data.renderedAt\'s two output paths', () => {
  withScratchOut((outDir) => {
    writeHtml(outDir, 'characters/pcs/tamsin.html', '<html><body>No leak on the PC sheet page.</body></html>');
    writeHtml(outDir, 'story/characters/tamsin.html', '<html><body>Gus Marzone appears in the story.</body></html>');
    const findings = [
      {
        id: 'leak/l4-hidden-name',
        path: 'Characters/PCs/Tamsin_Story.md',
        outputPath: 'characters/pcs/tamsin.html',
        data: { hiddenName: 'Gus Marzone', renderedAt: ['characters/pcs/tamsin.html', 'story/characters/tamsin.html'] },
      },
    ];
    const result = auditNamesAgainstBuild(outDir, findings, ['Gus Marzone']);
    assert.equal(result.confirmed.length, 1);
    assert.equal(result.unconfirmed.length, 0);
    // Bucket B must not double-list the story page's own confirmed pair.
    assert.deepEqual(result.bucketB, []);
  });
});

test('auditNamesAgainstBuild: findings other than leak/l4-hidden-name (e.g. a collision) are ignored', () => {
  withScratchOut((outDir) => {
    writeHtml(outDir, 'characters/npcs/cal.html', '<html><body>Nothing relevant.</body></html>');
    const findings = [
      { id: 'leak/l4-name-collision', path: 'Characters/NPCs/Hidden.md', outputPath: 'characters/npcs/cal.html', data: { hiddenName: 'X' } },
    ];
    const result = auditNamesAgainstBuild(outDir, findings, []);
    assert.deepEqual(result.confirmed, []);
    assert.deepEqual(result.unconfirmed, []);
    assert.deepEqual(result.bucketB, []);
  });
});

test('auditNamesAgainstBuild: never writes anything, only reads the given outDir', () => {
  withScratchOut((outDir) => {
    writeHtml(outDir, 'a.html', 'nothing');
    const before = fs.readdirSync(outDir).sort();
    auditNamesAgainstBuild(outDir, [], ['Anything']);
    const after = fs.readdirSync(outDir).sort();
    assert.deepEqual(before, after);
  });
});
