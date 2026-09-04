import { afterEach, describe, expect, it, vi } from "vitest";

import { createTimer, noopTimer } from "./timing.js";

/**
 * A clock the test moves by hand. Spinning for a millisecond and
 * spinning for ten came back in the wrong order on a busy CI runner,
 * because the short spin was the one that got preempted.
 */
function fakeClock(): { advance: (ms: number) => void } {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTimer", () => {
  it("returns what the timed function returned", () => {
    const timer = createTimer();
    expect(timer.time("parse", () => 42)).toBe(42);
  });

  it("accumulates duration and call count across repeated calls to the same label", () => {
    const clock = fakeClock();
    const timer = createTimer();
    timer.time("parse", () => clock.advance(1));
    timer.time("parse", () => clock.advance(3));
    const report = timer.report();
    const parse = report.phases.find((p) => p.label === "parse");
    expect(parse?.calls).toBe(2);
    expect(parse?.durationMs).toBe(4);
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
    const clock = fakeClock();
    const timer = createTimer();
    timer.time("summarize", () => clock.advance(1));
    timer.time("discover", () => clock.advance(10));
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
    const clock = fakeClock();
    const timer = createTimer();
    clock.advance(7);
    expect(timer.report().totalMs).toBe(7);
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
