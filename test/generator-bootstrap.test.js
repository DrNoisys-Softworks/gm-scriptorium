'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyGeneratorLog } = require('../src/generator/bootstrap');

function line(level, text) {
  return { level, text };
}

test('classifies a "page" render error, naming the output path', () => {
  const { renderErrors, detail } = classifyGeneratorLog([
    line('error', '  ERROR rendering factions/gronks-horde.html: Cannot read properties of undefined'),
  ]);
  assert.deepEqual(renderErrors, [
    { kind: 'page', outputPath: 'factions/gronks-horde.html', message: 'Cannot read properties of undefined' },
  ]);
  assert.deepEqual(detail, []);
});

test('classifies a "roster" render error, checked before the generic page pattern', () => {
  const { renderErrors, detail } = classifyGeneratorLog([
    line('error', '  ERROR rendering roster characters/party.html: board.renderBoard is not a function'),
  ]);
  assert.deepEqual(renderErrors, [
    { kind: 'roster', outputPath: 'characters/party.html', message: 'board.renderBoard is not a function' },
  ]);
  assert.deepEqual(detail, []);
});

test('classifies a "party-manifest" error, with a null outputPath', () => {
  const { renderErrors, detail } = classifyGeneratorLog([
    line('error', '  ERROR building party manifest: campaignId is required'),
  ]);
  assert.deepEqual(renderErrors, [
    { kind: 'party-manifest', outputPath: null, message: 'campaignId is required' },
  ]);
  assert.deepEqual(detail, []);
});

test('classifies all three shapes together, in a mixed log, and leaves WARNING/wrote lines as detail', () => {
  const { renderErrors, detail } = classifyGeneratorLog([
    line('log', '  wrote index.html'),
    line('warn', '  WARNING: unresolved wikilink [[Nowhere]] in Old-Mill.md'),
    line('error', '  ERROR rendering locations/old-mill.html: boom'),
    line('log', '  wrote characters/npcs/alice.html'),
    line('error', '  ERROR building party manifest: campaignId is required'),
    line('error', '  ERROR rendering roster characters/party.html: boom2'),
    line('warn', '  WARNING: image not found: missing.png'),
  ]);

  assert.deepEqual(renderErrors, [
    { kind: 'page', outputPath: 'locations/old-mill.html', message: 'boom' },
    { kind: 'party-manifest', outputPath: null, message: 'campaignId is required' },
    { kind: 'roster', outputPath: 'characters/party.html', message: 'boom2' },
  ]);
  assert.deepEqual(detail, [
    line('log', '  wrote index.html'),
    line('warn', '  WARNING: unresolved wikilink [[Nowhere]] in Old-Mill.md'),
    line('log', '  wrote characters/npcs/alice.html'),
    line('warn', '  WARNING: image not found: missing.png'),
  ]);
});

test('a line that does not match any ERROR shape is left as detail unchanged', () => {
  const { renderErrors, detail } = classifyGeneratorLog([line('log', 'built 42 pages')]);
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(detail, [line('log', 'built 42 pages')]);
});
