'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseSha256Sums, isLinuxExecutable, isWindowsExecutable } = require('../src/update/verify');

function makeScratchFile(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-verify-'));
  const file = path.join(dir, 'asset');
  fs.writeFileSync(file, bytes);
  return { dir, file };
}

// ---------------------------------------------------------------------------
// P5a-FR10: today's parseSha256Sums() reads a real multi-entry SHA256SUMS
// (both binaries plus the notices file, exactly the shape scripts/package.js
// now writes for the default dual-target build) and finds the Windows entry.
// No source change required for this: it is a regression/characterisation
// test showing the existing parser already handles it.
// ---------------------------------------------------------------------------

test('P5a-FR10: parseSha256Sums() reads a combined linux+win+notices SHA256SUMS and finds the Windows entry', () => {
  const linuxHash = '1'.repeat(64);
  const winHash = '2'.repeat(64);
  const noticesHash = '3'.repeat(64);
  const text =
    `${linuxHash}  scriptorium-linux-x64\n` +
    `${winHash}  scriptorium-win-x64.exe\n` +
    `${noticesHash}  THIRD-PARTY-NOTICES.txt\n`;

  const map = parseSha256Sums(text);

  assert.equal(map.size, 3, 'all three entries must be read, not just the first');
  assert.equal(map.get('scriptorium-win-x64.exe'), winHash, 'the Windows entry must be found among the others');
  assert.equal(map.get('scriptorium-linux-x64'), linuxHash);
  assert.equal(map.get('THIRD-PARTY-NOTICES.txt'), noticesHash);
});

test('P5a-FR10: entry order in the file does not matter (Windows entry first, or last)', () => {
  const winHash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const winFirst = `${winHash}  scriptorium-win-x64.exe\n${otherHash}  scriptorium-linux-x64\n`;
  const winLast = `${otherHash}  scriptorium-linux-x64\n${winHash}  scriptorium-win-x64.exe\n`;

  assert.equal(parseSha256Sums(winFirst).get('scriptorium-win-x64.exe'), winHash);
  assert.equal(parseSha256Sums(winLast).get('scriptorium-win-x64.exe'), winHash);
});

// ---------------------------------------------------------------------------
// P5a-FR05: isLinuxExecutable(), the ELF mirror of isWindowsExecutable()'s
// MZ check -- ELF magic, 64-bit class, x86-64 machine.
// ---------------------------------------------------------------------------

/** A minimal, valid ELF64 x86-64 header prefix (first 20 bytes are all that isLinuxExecutable reads). */
function elfHeader({ magic = [0x7f, 0x45, 0x4c, 0x46], eiClass = 2, eMachine = 0x3e } = {}) {
  const buf = Buffer.alloc(20);
  buf[0] = magic[0];
  buf[1] = magic[1];
  buf[2] = magic[2];
  buf[3] = magic[3];
  buf[4] = eiClass;
  buf[5] = 1; // EI_DATA: little-endian (not checked by isLinuxExecutable, set realistically anyway)
  buf.writeUInt16LE(eMachine, 18);
  return buf;
}

test('isLinuxExecutable(): a real ELF64 x86-64 header passes', () => {
  const { dir, file } = makeScratchFile(elfHeader());
  try {
    assert.equal(isLinuxExecutable(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLinuxExecutable(): wrong magic bytes fails', () => {
  const { dir, file } = makeScratchFile(elfHeader({ magic: [0x00, 0x45, 0x4c, 0x46] }));
  try {
    assert.equal(isLinuxExecutable(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLinuxExecutable(): correct magic but 32-bit class (ELFCLASS32) fails', () => {
  const { dir, file } = makeScratchFile(elfHeader({ eiClass: 1 }));
  try {
    assert.equal(isLinuxExecutable(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLinuxExecutable(): correct magic and 64-bit class but a non-x86-64 machine (aarch64) fails', () => {
  const { dir, file } = makeScratchFile(elfHeader({ eMachine: 0xb7 })); // EM_AARCH64 = 183
  try {
    assert.equal(isLinuxExecutable(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLinuxExecutable(): an MZ (Windows) header fails the ELF check', () => {
  const { dir, file } = makeScratchFile(Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
  try {
    assert.equal(isLinuxExecutable(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLinuxExecutable(): a file shorter than the header (truncated download) fails, does not throw', () => {
  const { dir, file } = makeScratchFile(Buffer.from([0x7f, 0x45]));
  try {
    assert.equal(isLinuxExecutable(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isWindowsExecutable() is unaffected by the new ELF check (regression guard)', () => {
  const { dir, file } = makeScratchFile(Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
  try {
    assert.equal(isWindowsExecutable(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
