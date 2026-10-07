'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ScriptoriumError } = require('../util/errors');

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Parses a SHA256SUMS file (standard `sha256sum` output: "<hex>  <filename>"). */
function parseSha256Sums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

/**
 * @throws {ScriptoriumError} on any mismatch, truncation, or missing entry
 */
function verifyDownload(assetPath, sumsPath) {
  const basename = path.basename(assetPath);
  const sums = parseSha256Sums(fs.readFileSync(sumsPath, 'utf8'));
  const expected = sums.get(basename);
  if (!expected) {
    throw new ScriptoriumError(`SHA256SUMS has no entry for ${basename}`);
  }
  const actual = sha256File(assetPath);
  if (actual !== expected) {
    throw new ScriptoriumError(`checksum mismatch for ${basename}: expected ${expected}, got ${actual}`);
  }
}

/** MZ magic-byte check: is this actually a Windows PE executable? */
function isWindowsExecutable(assetPath) {
  const fd = fs.openSync(assetPath, 'r');
  try {
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    return buf[0] === 0x4d && buf[1] === 0x5a; // "MZ"
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * ELF magic-byte check (P5a-FR05): mirrors isWindowsExecutable's MZ check above, for the
 * linux-x64 asset. Confirms three things a downloaded blob claiming to be
 * `scriptorium-linux-x64` should have: the ELF magic (0x7F 'E' 'L' 'F'), the 64-bit class
 * byte (EI_CLASS, offset 4, must be 2), and the x86-64 machine field (e_machine, offset
 * 18-19 little-endian, must be 0x3E / EM_X86_64). Reads the first 20 bytes, enough to
 * cover e_machine at offset 18-19.
 */
function isLinuxExecutable(assetPath) {
  const fd = fs.openSync(assetPath, 'r');
  try {
    const buf = Buffer.alloc(20);
    fs.readSync(fd, buf, 0, 20, 0);
    const magicOk = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46; // "\x7fELF"
    const is64Bit = buf[4] === 2; // EI_CLASS: ELFCLASS64
    const isX86_64 = buf.readUInt16LE(18) === 0x3e; // e_machine: EM_X86_64
    return magicOk && is64Bit && isX86_64;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { sha256File, parseSha256Sums, verifyDownload, isWindowsExecutable, isLinuxExecutable };
