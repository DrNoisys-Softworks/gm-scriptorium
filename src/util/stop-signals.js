'use strict';

/*
 * Issue #27: `serve` (plain and --admin) used to stop only on SIGINT, so the signal a service
 * manager sends (SIGTERM) killed the process with no cleanup. Both stop paths now go through this
 * one registration so they cannot drift apart.
 *
 * win32 has no real SIGTERM: Node only emulates SIGINT (Ctrl-C), SIGBREAK (Ctrl-Break) and
 * SIGHUP (the console window being closed), plus unconditional kill for the rest. Registering a
 * SIGTERM listener there is harmless (it just never fires), SIGBREAK gets Ctrl-Break the same
 * clean stop, and SIGHUP gets a closed console window one too (ADR 0028, section 9).
 *
 * POSIX registers SIGHUP only when the caller passes { hup: true }, which only launch mode does.
 * A JavaScript SIGHUP listener replaces the ignore that nohup sets up, so registering it in every
 * mode would make a nohup'd `serve --admin` stop when its terminal closes.
 */
function stopSignalNames(platform = process.platform, { hup = false } = {}) {
  if (platform === 'win32') return ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
  return hup ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
}

/**
 * Run `handler(signalName)` once, on the first stop signal; later signals are ignored and every
 * listener is removed so the process can exit.
 * @param {NodeJS.EventEmitter} signals
 * @param {(name: string) => void} handler
 * @param {string} [platform]
 * @param {{ hup?: boolean }} [opts]
 * @returns {() => void} removes every listener without running the handler (safe to call twice)
 */
function onStopSignal(signals, handler, platform = process.platform, opts = {}) {
  const names = stopSignalNames(platform, opts || {});
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
  return function dispose() {
    for (const [n, l] of listeners) signals.removeListener(n, l);
  };
}

module.exports = { onStopSignal, stopSignalNames };
