'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planSelfTest, execVersionProbe } = require('../scripts/package-selftest');

// -- planSelfTest(): pure decision logic, every branch, no pkg invocation --

test('planSelfTest() unavailable when the host is not linux-x64', () => {
  const plan = planSelfTest({ target: 'node22-win-x64', outPath: '/tmp/does-not-matter.exe', hostTarget: null });
  assert.equal(plan.mode, 'unavailable');
  assert.match(plan.detail, /not linux-x64/);
});

test('planSelfTest() runs the shipped artefact directly when target matches the host', () => {
  const plan = planSelfTest({ target: 'node22-linux-x64', outPath: '/tmp/scriptorium-linux-x64', hostTarget: 'node22-linux-x64' });
  assert.equal(plan.mode, 'direct');
  assert.equal(plan.binPath, '/tmp/scriptorium-linux-x64');
  assert.match(plan.detail, /matches this build host/);
});

test('planSelfTest() proxy-builds a host-matching target when the shipped target cannot run here', () => {
  const plan = planSelfTest({ target: 'node22-win-x64', outPath: '/tmp/scriptorium-win-x64.exe', hostTarget: 'node22-linux-x64' });
  assert.equal(plan.mode, 'proxy-build');
  assert.equal(plan.buildTarget, 'node22-linux-x64');
  assert.match(plan.detail, /cannot be executed on this Linux host/);
  assert.match(plan.detail, /does NOT prove node22-win-x64 itself starts/);
});

test('planSelfTest() defaults hostTarget to this process\'s own host when not overridden', () => {
  const plan = planSelfTest({ target: 'node22-win-x64', outPath: '/tmp/does-not-matter.exe' });
  // This project's build host is linux-x64 (see scripts/package-selftest.js HOST_TARGET); if
  // that ever changes, this assertion should change with it rather than silently pass.
  assert.equal(plan.mode, process.platform === 'linux' && process.arch === 'x64' ? 'proxy-build' : 'unavailable');
});

// -- execVersionProbe(): exec + pass/fail shape, against small throwaway scripts (no pkg) --

test('execVersionProbe() reports ok:true when the binary exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-selftest-probe-'));
  try {
    const wrapper = path.join(dir, 'ok.sh');
    fs.writeFileSync(wrapper, '#!/usr/bin/env bash\necho "0.2.0"\nexit 0\n');
    fs.chmodSync(wrapper, 0o755);
    const result = execVersionProbe(wrapper);
    assert.equal(result.ok, true);
    assert.match(result.detail, /--version exited 0: 0\.2\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('execVersionProbe() reports ok:false with stderr detail when the binary exits non-zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-selftest-probe-'));
  try {
    const wrapper = path.join(dir, 'fail.sh');
    fs.writeFileSync(wrapper, '#!/usr/bin/env bash\necho "boom" >&2\nexit 1\n');
    fs.chmodSync(wrapper, 0o755);
    const result = execVersionProbe(wrapper);
    assert.equal(result.ok, false);
    assert.match(result.detail, /boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('execVersionProbe() reports ok:false when the binary does not exist', () => {
  const result = execVersionProbe('/nonexistent/scriptorium-selftest-probe-binary');
  assert.equal(result.ok, false);
  assert.ok(result.detail.length > 0);
});
