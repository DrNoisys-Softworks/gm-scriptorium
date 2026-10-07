'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinding } = require('../src/report/finding');
const { buildEnvelope, envelopeWithoutTimestamp, SCHEMA_VERSION } = require('../src/report/json');

function sampleFindings() {
  return [
    createFinding({
      id: 'leak/l4-hidden-name',
      severity: 'error',
      category: 'leak',
      campaign: 'example',
      path: 'Locations/Ashbourne.md',
      message: 'hidden name "Novelle" appears in published text',
    }),
    createFinding({
      id: 'census/type',
      severity: 'info',
      category: 'census',
      campaign: 'example',
      message: '181 pages by type',
    }),
    createFinding({
      id: 'relationship/missing-required',
      severity: 'warn',
      category: 'frontmatter',
      campaign: 'example',
      path: 'Characters/NPCs/Ghost.md',
      message: 'missing located_at',
    }),
  ];
}

test('buildEnvelope has the frozen top-level shape', () => {
  const envelope = buildEnvelope({
    tool: { name: 'scriptorium', version: '0.0.0' },
    campaign: 'example',
    vaultPath: '/vault',
    outputPath: '/out',
    findings: sampleFindings(),
    now: () => '2026-09-10T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(envelope), [
    'schemaVersion',
    'tool',
    'campaign',
    'vaultPath',
    'outputPath',
    'generatedAt',
    'counts',
    'findings',
  ]);
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(envelope.tool, { name: 'scriptorium', version: '0.0.0' });
});

test('buildEnvelope computes counts by severity', () => {
  const envelope = buildEnvelope({
    tool: { name: 'scriptorium', version: '0.0.0' },
    campaign: 'example',
    vaultPath: '/vault',
    outputPath: '/out',
    findings: sampleFindings(),
    now: () => '2026-09-10T00:00:00.000Z',
  });
  assert.deepEqual(envelope.counts, { error: 1, warn: 1, info: 1 });
});

test('buildEnvelope sorts findings deterministically', () => {
  const findings = sampleFindings();
  const reversed = [...findings].reverse();
  const a = buildEnvelope({
    tool: { name: 'scriptorium', version: '0.0.0' },
    campaign: 'example',
    vaultPath: '/vault',
    outputPath: '/out',
    findings,
    now: () => '2026-09-10T00:00:00.000Z',
  });
  const b = buildEnvelope({
    tool: { name: 'scriptorium', version: '0.0.0' },
    campaign: 'example',
    vaultPath: '/vault',
    outputPath: '/out',
    findings: reversed,
    now: () => '2026-09-10T01:00:00.000Z',
  });
  assert.deepEqual(a.findings, b.findings);
});

test('two runs differ only by generatedAt', () => {
  const findings = sampleFindings();
  const a = buildEnvelope({
    tool: { name: 'scriptorium', version: '0.0.0' },
    campaign: 'example',
    vaultPath: '/vault',
    outputPath: '/out',
    findings,
    now: () => '2026-09-10T00:00:00.000Z',
  });
  const b = buildEnvelope({
    tool: { name: 'scriptorium', version: '0.0.0' },
    campaign: 'example',
    vaultPath: '/vault',
    outputPath: '/out',
    findings,
    now: () => '2026-09-11T12:34:56.000Z',
  });
  assert.notEqual(a.generatedAt, b.generatedAt);
  assert.deepEqual(envelopeWithoutTimestamp(a), envelopeWithoutTimestamp(b));
  assert.equal(JSON.stringify(envelopeWithoutTimestamp(a)), JSON.stringify(envelopeWithoutTimestamp(b)));
});

test('buildEnvelope defaults vaultPath/outputPath to null', () => {
  const envelope = buildEnvelope({
    tool: { name: 'scriptorium', version: '0.0.0' },
    campaign: 'example',
    findings: [],
    now: () => '2026-09-10T00:00:00.000Z',
  });
  assert.equal(envelope.vaultPath, null);
  assert.equal(envelope.outputPath, null);
  assert.deepEqual(envelope.counts, { error: 0, warn: 0, info: 0 });
  assert.deepEqual(envelope.findings, []);
});
