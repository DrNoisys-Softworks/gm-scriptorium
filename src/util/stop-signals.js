'use strict';

/*
 * Issue #27: `serve` (plain and --admin) used to stop only on SIGINT, so the signal a service
 * manager sends (SIGTERM) killed the process with no cleanup. Both stop paths now go through this
 * one registration so they cannot drift apart.
 *
 * win32 has no real SIGTERM: Node only emulates SIGINT (Ctrl-C), SIGBREAK (Ctrl-Break / console
 * close) and unconditional kill for the rest. Registering a SIGTERM listener there is harmless
 * (it just never fires), and SIGBREAK is added so Ctrl-Break gets the same clean stop.
 */
function stopSignalNames(platform = process.platform) {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
}

/**
 * Run `handler(signalName)` once, on the first stop signal; later signals are ignored and every
 * listener is removed so the process can exit.
 * @param {NodeJS.EventEmitter} signals
 * @param {(name: string) => void} handler
 */
function onStopSignal(signals, handler, platform = process.platform) {
  const names = stopSignalNames(platform);
  let fired = false;
  const listeners = names.map((name) => {
    const fn = () => {
      if (fired) return;
      fired = true;
      for (const [n, l] of listeners) signals.removeListener(n, l);
      handler(name);
    };
    return [name, fn];
  });
  for (const [n, l] of listeners) signals.on(n, l);
}

module.exports = { onStopSignal, stopSignalNames };
