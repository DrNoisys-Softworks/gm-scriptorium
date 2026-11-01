'use strict';

/*
 * ADR 0007, from publish-v1.26.0: nearly every pin module requires lib/settings, whose registry loads
 * lib/templates/pc-registry.js and with it every system's character-sheet templates. So the
 * redacted template files are loaded by the facade itself, long before a build. The facade must have
 * seeded their stubs first, or the build's own applyRedactions() finds the real files already loaded
 * and refuses to build ("ran too late"). Run in a child process so this test's require.cache starts
 * empty, the way a command's does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

test('loading the facade leaves every redacted template file in require.cache as Scriptorium\'s stub', () => {
  const script = `
    require(${JSON.stringify(path.join(ROOT, 'src', 'generator', 'pinned.js'))});
    const ids = ['gm-apprentice-publish/lib/templates/gurps/blocks/reference.js', 'gm-apprentice-publish/lib/templates/coc/skills-data.js', 'gm-apprentice-publish/lib/templates/gurps/tohit-data.js']
      .map((s) => { const m = require.cache[require.resolve(s)]; return m ? (m.scriptoriumRedactionId || 'real file') : 'not loaded'; });
    process.stdout.write(JSON.stringify(ids));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['gurps-reference', 'coc-skills-data', 'gurps-tohit-data']);
});

test('after the facade has loaded, a build\'s own applyRedactions() still runs (it accepts the facade\'s seed)', () => {
  const script = `
    require(${JSON.stringify(path.join(ROOT, 'src', 'generator', 'pinned.js'))});
    const { applyRedactions } = require(${JSON.stringify(path.join(ROOT, 'src', 'generator', 'redactions.js'))});
    process.stdout.write(JSON.stringify(applyRedactions().map((r) => r.id)));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['gurps-reference', 'coc-skills-data', 'gurps-tohit-data']);
});
