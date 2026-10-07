'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('stream');
const { EventEmitter } = require('events');

const { createPrompter } = require('../src/cli/prompt');

/*
 * ADR 0021. Readline drops lines when stdin is piped (only the first line
 * of a chunk reaches a pending rl.question), and readline with no 'SIGINT'
 * listener pauses on Ctrl-C instead of exiting. Every test here has a
 * { timeout: 15000 } so a prompter built on rl.question or missing its
 * SIGINT listener fails on a timeout instead of hanging.
 */

test('P1: a queued line source resolves ask() with each line in order, then null at EOF', { timeout: 15000 }, async () => {
  const input = Readable.from(['a\nb\nc\n']);
  const output = new PassThrough();
  const prompter = createPrompter({ input, output });
  assert.equal(await prompter.ask('q1: '), 'a');
  assert.equal(await prompter.ask('q2: '), 'b');
  assert.equal(await prompter.ask('q3: '), 'c');
  assert.equal(await prompter.ask('q4: '), null);
  prompter.close();
});

test('P2: after EOF, every further ask() resolves null immediately', { timeout: 15000 }, async () => {
  const input = Readable.from(['only\n']);
  const output = new PassThrough();
  const prompter = createPrompter({ input, output });
  assert.equal(await prompter.ask('q1: '), 'only');
  assert.equal(await prompter.ask('q2: '), null);
  assert.equal(await prompter.ask('q3: '), null);
  prompter.close();
});

test('P3: rl.emit(SIGINT) while an ask() is pending resolves null (terminal mode)', { timeout: 15000 }, async () => {
  const input = new PassThrough(); // never ended: a hang here means a missing SIGINT listener
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  const prompter = createPrompter({ input, output });
  const pending = prompter.ask('q1: ');
  prompter.rl.emit('SIGINT');
  assert.equal(await pending, null);
  prompter.close();
});

test('P4: non-terminal mode uses the injected signals emitter, and removes its listener on close', { timeout: 15000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const prompter = createPrompter({ input, output, signals });
  const pending = prompter.ask('q1: ');
  signals.emit('SIGINT'); // .once() self-removes on firing
  assert.equal(await pending, null);
  prompter.close();
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('P4b: close() removes the signals SIGINT listener even when it never fired', { timeout: 15000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const prompter = createPrompter({ input, output, signals });
  assert.equal(signals.listenerCount('SIGINT'), 1);
  prompter.close();
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('P5: the question text reaches output before the answer resolves', { timeout: 15000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString();
  });
  const prompter = createPrompter({ input, output });
  const pending = prompter.ask('Campaign name: ');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(written.includes('Campaign name: '), `expected the question in output, got: ${JSON.stringify(written)}`);
  input.write('alpha\n');
  assert.equal(await pending, 'alpha');
  prompter.close();
});

test('P6: after close(), ask() resolves null', { timeout: 15000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = createPrompter({ input, output });
  prompter.close();
  assert.equal(await prompter.ask('q: '), null);
});

test('close() is idempotent', { timeout: 15000 }, () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = createPrompter({ input, output });
  prompter.close();
  assert.doesNotThrow(() => prompter.close());
});
