'use strict';

/*
 * Child-process probe for rule (e) of the PATH-scrub assertion, and for the ambient-fallback
 * mutation. test/proc-run.test.js starts this as `node <probe> <markerPath>` with an
 * environment of exactly { PATH: <decoy folder>, HOME: <decoy home> }. In that process the
 * ambient PATH and HOME both hold a decoy `claude`.
 *
 * The probe asks the spawner for `claude` through the guarded helper, with the child PATH set to
 * an EMPTY scratch folder. A spawner with no fallback answers not-found without spawning. A
 * spawner that falls back to the ambient PATH or to a home folder finds a decoy, which the
 * guard refuses (one spawn attempt) before it can run. Either way no marker is written.
 *
 * It prints one JSON line: the error code, the spawn-attempt count, and whether the marker exists.
 */

const fs = require('fs');
const { makeFakeBin } = require('./proc-fakebin');

async function main() {
  const markerPath = process.argv[2];
  const fb = makeFakeBin(null, { empty: true });
  let code = null;
  try {
    await fb.run({ command: 'claude', env: { PATH: fb.dir, HOME: fb.root } });
    code = 'RESOLVED';
  } catch (err) {
    code = err && err.code ? err.code : 'OTHER';
  }
  const report = { code, attempts: fb.attempts.length, marker: fs.existsSync(markerPath) };
  fb.cleanup();
  process.stdout.write(JSON.stringify(report) + '\n');
}

main();
