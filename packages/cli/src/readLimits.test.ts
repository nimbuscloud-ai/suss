import { describe, expect, it } from "vitest";

import { durationText, readLimitsFrom } from "./readLimits.js";

const bigMachine = { memoryMb: 65_536, cpus: 12 };

describe("the limits a project's reads run under", () => {
  it("runs four reads at once for twenty minutes each, at the heap one suss run gets", () => {
    expect(readLimitsFrom({}, bigMachine)).toEqual({
      jobs: 4,
      timeoutMs: 1_200_000,
      memoryMb: 8192,
    });
  });

  it("runs fewer at once when four full heaps would not fit in memory", () => {
    expect(readLimitsFrom({}, { memoryMb: 16_384, cpus: 12 }).jobs).toBe(1);
    expect(readLimitsFrom({}, { memoryMb: 32_768, cpus: 12 }).jobs).toBe(3);
  });

  it("runs no more at once than the machine has cores", () => {
    expect(readLimitsFrom({}, { memoryMb: 65_536, cpus: 2 }).jobs).toBe(2);
  });

  it("fits more reads in memory when each is given a smaller heap", () => {
    expect(
      readLimitsFrom({ "read-memory": "2048" }, { memoryMb: 16_384, cpus: 12 }),
    ).toMatchObject({ jobs: 4, memoryMb: 2048 });
  });

  it("takes each flag as given", () => {
    expect(
      readLimitsFrom(
        { jobs: "8", "read-timeout": "0.5", "read-memory": "4096" },
        bigMachine,
      ),
    ).toEqual({ jobs: 8, timeoutMs: 30_000, memoryMb: 4096 });
  });

  it("turns the time limit off at 0", () => {
    expect(readLimitsFrom({ "read-timeout": "0" }, bigMachine).timeoutMs).toBe(
      0,
    );
  });

  it.each([
    [{ jobs: "0" }, "--jobs takes a whole number of reads"],
    [{ jobs: "two" }, "--jobs takes a whole number of reads"],
    [{ "read-memory": "1.5" }, "--read-memory takes a whole number"],
    [{ "read-timeout": "-1" }, "--read-timeout takes the minutes"],
    [{ "read-timeout": "" }, "--read-timeout takes the minutes"],
  ])("refuses %o", (flags, message) => {
    expect(() => readLimitsFrom(flags, bigMachine)).toThrow(message);
  });
});

describe("a duration in a progress line", () => {
  it.each([
    [850, "850ms"],
    [4_200, "4.2s"],
    [600_000, "10m 0s"],
    [725_400, "12m 5s"],
  ])("prints %d ms as %s", (ms, text) => {
    expect(durationText(ms)).toBe(text);
  });
});
