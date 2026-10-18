'use strict';

/*
 * A `--require` preload standing in for "every comment strip failed", for the tests that prove the
 * output gate refuses a published Obsidian comment (test/obsidian-comments.test.js,
 * test/gm-access-build.test.js).
 *
 * From publish-v1.17.0 the pinned generator strips `%%` comments itself (lib/processor.js), so the
 * leak has to be made before it can: while the generator builds, every `.md` file it reads has its
 * `%%` markers deleted and their text kept, which leaves nothing for its strip to find. Only the
 * generator run is affected. The output gate reads the comments from the vault afterwards, with the
 * real reader, so it still knows what the comments said. Scriptorium itself ships no read hook
 * (docs/decisions/0044-obsidian-comments-withheld.md, last addendum).
 */

const fs = require('fs');
const bootstrap = require('../../src/generator/bootstrap');

const realBuild = bootstrap.runGeneratorBuild;

bootstrap.runGeneratorBuild = function runGeneratorBuildWithCommentsUnwrapped(...args) {
  const original = fs.readFileSync;
  fs.readFileSync = function unwrapComments(file) {
    const result = original.apply(fs, arguments);
    if (typeof result === 'string' && typeof file === 'string' && file.endsWith('.md')) return result.split('%%').join('');
    return result;
  };
  try {
    return realBuild.apply(this, args);
  } finally {
    fs.readFileSync = original;
  }
};
