'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCheckCommand } = require('../src/cli/check');

/* QA F15: the examples README Ottoline instruction must really fail check. */

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'examples', 'the-long-lease');

function checkWithEdit(edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-docs-b5-'));
  try {
    const vault = path.join(root, 'vault');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    const page = path.join(vault, 'Characters', 'NPCs', 'Orpiment.md');
    fs.writeFileSync(page, edit(fs.readFileSync(page, 'utf8')));
    const cfg = path.join(root, 'config.toml');
    fs.writeFileSync(cfg, ['config_version = 1', 'default_campaign = "lease"', '', '[campaigns.lease]', `vault = '${vault}'`, `output = '${path.join(root, 'out')}'`, ''].join('\n'));
    return runCheckCommand({ config: cfg }, 'lease').exitCode;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('F15: the sentence the examples README tells you to type under "# Orpiment" makes check exit 2', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'examples', 'README.md'), 'utf8');
  assert.ok(readme.includes('right under the `# Orpiment` heading'));
  assert.equal(checkWithEdit((t) => t.replace('\n# Orpiment\n', '\n# Orpiment\n\nOttoline Pardew was seen here.\n')), 2);
});

test('F15: the same sentence at the bottom (inside GM Notes) passes, as the README now says', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'examples', 'README.md'), 'utf8');
  assert.ok(readme.includes('Put the same sentence at the very bottom of the file and `check` passes'));
  assert.equal(checkWithEdit((t) => t + '\nOttoline Pardew was seen here.\n'), 0);
});
