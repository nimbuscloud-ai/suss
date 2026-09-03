import { describe, expect, it } from "vitest";

import { createTimer, noopTimer } from "./timing.js";

/** Burns a few milliseconds of wall time without an async wait, so ordering by duration is deterministic. */
function busyWaitMs(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

describe("createTimer", () => {
  it("returns what the timed function returned", () => {
    const timer = createTimer();
    expect(timer.time("parse", () => 42)).toBe(42);
  });

  it("accumulates duration and call count across repeated calls to the same label", () => {
    const timer = createTimer();
    timer.time("parse", () => busyWaitMs(1));
    timer.time("parse", () => busyWaitMs(1));
    const report = timer.report();
    const parse = report.phases.find((p) => p.label === "parse");
    expect(parse?.calls).toBe(2);
    expect(parse?.durationMs).toBeGreaterThan(0);
  });

  it("still records the phase when the timed function throws", () => {
    const timer = createTimer();
    expect(() =>
      timer.time("discover", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(
      timer.report().phases.find((p) => p.label === "discover")?.calls,
    ).toBe(1);
  });

  it("orders phases by duration, longest first", () => {
    const timer = createTimer();
    timer.time("summarize", () => busyWaitMs(1));
    timer.time("discover", () => busyWaitMs(10));
    const labels = timer.report().phases.map((p) => p.label);
    expect(labels).toEqual(["discover", "summarize"]);
  });

  it("times an async phase and propagates a rejection", async () => {
    const timer = createTimer();
    await expect(
      timer.timeAsync("parse", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(timer.report().phases.find((p) => p.label === "parse")?.calls).toBe(
      1,
    );
  });

  it("reports a total that grows from when the timer was built", () => {
    const timer = createTimer();
    busyWaitMs(1);
    expect(timer.report().totalMs).toBeGreaterThan(0);
  });
});

describe("noopTimer", () => {
  it("runs the function and returns its value without recording anything", async () => {
    const timer = noopTimer();
    expect(timer.time("parse", () => 1)).toBe(1);
    await expect(
      timer.timeAsync("parse", () => Promise.resolve(2)),
    ).resolves.toBe(2);
    expect(timer.report()).toEqual({ totalMs: 0, phases: [] });
  });
});
