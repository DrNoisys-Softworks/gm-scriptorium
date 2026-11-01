'use strict';

/*
 * Child process for test/settings-carry-no-spawn.test.js.
 *
 * It replaces every way of starting a program in the child-process module with a stub that throws,
 * and only then loads the carry. The pin's move code takes `spawnSync` out of that module when it
 * loads, so the stubs have to be in place first, which is why this runs in a process of its own.
 * Then it plans and applies a carry on the vault it is given (argv[2]) and prints one JSON line.
 */

const cp = require('child_process');
const started = [];
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[name] = (...args) => {
    started.push(name);
    throw new Error(`a program was started: ${name}(${JSON.stringify(args[0])})`);
  };
}

const path = require('path');
const { planCarry, applyCarry } = require('../../src/vault/settingscarry');
const { writeCarriedPack } = require('../../src/vault/carrypack');

const vault = process.argv[2];
const machineDir = process.argv[3];
const planned = planCarry({ vaultPath: vault, packConfigPath: path.join(vault, '_meta', 'scriptorium', 'vault.config.json') });
const result = { state: planned.state, blockers: planned.blockers, applied: false, started };
if (planned.state === 'ready') {
  applyCarry(planned, { machineDir, campaign: 't', packWriter: writeCarriedPack });
  result.applied = true;
}
console.log(JSON.stringify(result));
