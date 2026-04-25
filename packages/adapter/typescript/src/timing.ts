// timing.ts — Lightweight phase-timing instrumentation.
//
// Measures wall time spent in named phases of an adapter run so the
// CLI can surface "extract took 17s, of which 11s was in the
// reachable closure" without engaging a profiler. Cheap enough to
// always be on; a phase that isn't entered contributes zero.
//
// Not OpenTelemetry: this is single-process, stdout-bound, and
// shouldn't ship transitively to consumers. If suss ever becomes a
// long-running daemon (LSP / file-watcher), revisit then.

interface PhaseStat {
  /** Wall-clock milliseconds accumulated across all `time()` calls for this phase. */
  durationMs: number;
  /** How many times this phase was entered. */
  calls: number;
}

export interface TimingReport {
  totalMs: number;
  phases: Array<{ label: string; durationMs: number; calls: number }>;
}

export interface Timer {
  /** Run `fn`, accumulate wall time under `label`, return its result. */
  time<T>(label: string, fn: () => T): T;
  /** Async variant — same accumulation rule. */
  timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Snapshot of all accumulated phases, ordered by total time descending. */
  report(): TimingReport;
}

/**
 * Build a fresh timer. Each adapter run gets its own — keeps
 * concurrent extracts independent (irrelevant today, will matter if
 * we add a server mode).
 */
export function createTimer(): Timer {
  const phases = new Map<string, PhaseStat>();
  const start = performance.now();

  function record(label: string, deltaMs: number): void {
    const existing = phases.get(label);
    if (existing === undefined) {
      phases.set(label, { durationMs: deltaMs, calls: 1 });
    } else {
      existing.durationMs += deltaMs;
      existing.calls += 1;
    }
  }

  return {
    time<T>(label: string, fn: () => T): T {
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        record(label, performance.now() - t0);
      }
    },
    async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        record(label, performance.now() - t0);
      }
    },
    report(): TimingReport {
      const totalMs = performance.now() - start;
      const ordered = [...phases.entries()]
        .map(([label, s]) => ({
          label,
          durationMs: s.durationMs,
          calls: s.calls,
        }))
        .sort((a, b) => b.durationMs - a.durationMs);
      return { totalMs, phases: ordered };
    },
  };
}

/** Null implementation for callers that opt out of timing entirely. */
export function noopTimer(): Timer {
  return {
    time<T>(_label: string, fn: () => T): T {
      return fn();
    },
    async timeAsync<T>(_label: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    report(): TimingReport {
      return { totalMs: 0, phases: [] };
    },
  };
}
