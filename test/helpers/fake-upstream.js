'use strict';

/*
 * A pretend run of the upstream vault scaffold, for the capture tool's tests. It writes a small
 * vault tree the way the real scaffold would: the campaign name once or twice in a few files, the
 * date twice in an index, one file per game system, and files every system shares. It is NOT the
 * real scaffold and says nothing about its output; it exists so `derive` can be tested on trees
 * whose every byte is known. Options plant a defect for a refusal test.
 */

const fs = require('fs');
const path = require('path');

const SHARED_TYPES = '---\ntype: meta\npurpose: entity-types\n---\n\n# Entity types\n\n| pc | Characters/PCs |\n';

function put(root, rel, text) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

/**
 * @param {string} dir the new vault folder (must not exist)
 * @param {{ system: string, name: string, created: string }} run
 * @param {{ leakPath?: boolean, binary?: boolean, stray?: string, marker?: string, extraFile?: boolean, rawToken?: boolean, escapeQuotes?: boolean, crlf?: boolean, hit?: string, noCampaign?: boolean }} [quirks]
 */
function writeFakeRun(dir, { system, name, created }, quirks = {}) {
  const norm = name.trim().split(/\s+/).join(' ');
  const shown = quirks.escapeQuotes ? norm.replace(/"/g, '\\"') : norm;
  fs.mkdirSync(dir, { recursive: true });
  const systemLine = system === 'none' ? '' : `\n  system: "${system}"`;
  put(dir, '_meta/vault-config.md', `---\ntype: meta\ngm_apprentice_version: "9.9.9"\npublish:\n  site: false${systemLine}\n---\n\n# ${shown}: vault settings\n`);
  put(dir, '_meta/entity-types.md', SHARED_TYPES);
  put(dir, '_meta/index.md', `---\ntype: meta\ngenerated: ${created}\n---\n\n# Index\n\nGenerated ${created}.\n`);
  if (!quirks.noCampaign) {
    put(dir, '_Campaign/Timeline.md', `---\ntype: timeline\ncampaign: "${shown}"\n---\n\n# ${shown}: Timeline\n`);
  } else {
    put(dir, '_Campaign/Timeline.md', '---\ntype: timeline\n---\n\n# Timeline\n');
  }
  put(dir, '_Templates/pc.md', `---\ntype: pc\n---\n\n# Name\n\nA player character for ${system === 'none' ? 'any game' : system}.\n`);
  fs.mkdirSync(path.join(dir, '_attachments', 'characters'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Locations'), { recursive: true });
  if (quirks.leakPath) put(dir, '_meta/note.md', `Created at ${dir}\n`);
  if (quirks.binary) fs.writeFileSync(path.join(dir, '_attachments', 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]));
  if (quirks.stray !== undefined) put(dir, '_meta/stray.md', `stray ${quirks.stray}\n`);
  if (quirks.marker) put(dir, '_meta/rules.md', `${quirks.marker}\n`);
  if (quirks.extraFile) put(dir, '_meta/extra.md', 'only in this run\n');
  if (quirks.rawToken) put(dir, '_meta/token.md', 'has {{SCRIPTORIUM_CAMPAIGN}} already\n');
  if (quirks.crlf) put(dir, '_meta/crlf.md', 'a\r\nb\r\n');
  if (quirks.hit) put(dir, '_meta/hit.md', `line one\n${quirks.hit}\nline three\n`);
}

module.exports = { writeFakeRun };
