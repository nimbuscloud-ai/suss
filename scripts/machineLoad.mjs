// machineLoad.mjs: how busy the machine is, for scripts that time suss.

import os from "node:os";

/** The 1-minute load average spread over the cores. */
export function loadPerCore() {
  return os.loadavg()[0] / os.cpus().length;
}

export function percent(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Waits, up to `limitMs`, for the load a previous run left behind to fall
 * under `maxLoadPerCore`. Returns the load it stopped waiting at.
 */
export function settle({ maxLoadPerCore, limitMs, pollMs = 10_000 }) {
  const deadline = Date.now() + limitMs;
  let noted = false;
  while (loadPerCore() > maxLoadPerCore && Date.now() < deadline) {
    if (!noted) {
      process.stderr.write(
        `  waiting for the load average (${percent(loadPerCore())} per core) to settle\n`,
      );
      noted = true;
    }
    sleepMs(pollMs);
  }
  return loadPerCore();
}
