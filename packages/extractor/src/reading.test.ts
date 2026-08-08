import { describe, expect, it } from "vitest";

import {
  absentReading,
  ambiguousReading,
  andThenReading,
  firstWrittenReading,
  mapReading,
  unreadableReading,
  writtenReading,
} from "./reading.js";

import type { Reading } from "./reading.js";

const range = { start: 3, end: 9 };

describe("mapReading", () => {
  it("converts a written value and keeps where it was written", () => {
    expect(mapReading(writtenReading(2, range), (n) => n * 5)).toEqual({
      kind: "written",
      value: 10,
      range,
    });
  });

  it("converts an ambiguous reading's candidates too", () => {
    expect(
      mapReading(ambiguousReading([1, 2], "two routers"), (n) => n * 5),
    ).toEqual({
      kind: "ambiguous",
      candidates: [5, 10],
      reason: "two routers",
    });
  });

  it("leaves an absent reading absent and an unreadable one unread", () => {
    expect(mapReading(absentReading, (n: number) => n * 5)).toEqual({
      kind: "absent",
    });
    expect(
      mapReading(unreadableReading<number>("computed", range), (n) => n * 5),
    ).toEqual({ kind: "unreadable", reason: "computed", range });
  });
});

describe("andThenReading", () => {
  it("reads further from a written value, at the range it was written", () => {
    const next = andThenReading(writtenReading("/items", range), (path, at) =>
      writtenReading(`${path}/{id}`, at),
    );
    expect(next).toEqual({ kind: "written", value: "/items/{id}", range });
  });

  it("lets the next step say it could not read", () => {
    const next = andThenReading(writtenReading("/items", range), (_path, at) =>
      unreadableReading<string>("no reader for this syntax", at),
    );
    expect(next).toEqual({
      kind: "unreadable",
      reason: "no reader for this syntax",
      range,
    });
  });

  it("never runs the next step on a reading that found nothing", () => {
    let ran = false;
    const step = (): Reading<string> => {
      ran = true;
      return absentReading;
    };
    expect(andThenReading(absentReading, step)).toEqual({ kind: "absent" });
    expect(
      andThenReading(unreadableReading<string>("computed", range), step),
    ).toEqual({ kind: "unreadable", reason: "computed", range });
    expect(ran).toBe(false);
  });

  it("carries an ambiguous reading's reason on with no candidates", () => {
    expect(
      andThenReading(ambiguousReading(["a", "b"], "two mounts"), () =>
        writtenReading("x", range),
      ),
    ).toEqual({ kind: "ambiguous", candidates: [], reason: "two mounts" });
  });
});

describe("firstWrittenReading", () => {
  it("takes the first reading that was written", () => {
    expect(
      firstWrittenReading([
        absentReading,
        writtenReading(1, range),
        writtenReading(2, range),
      ]),
    ).toEqual({ kind: "written", value: 1, range });
  });

  it("keeps a reason when nothing was written", () => {
    expect(
      firstWrittenReading([
        absentReading,
        unreadableReading<number>("not a name", range),
      ]),
    ).toEqual({ kind: "unreadable", reason: "not a name", range });
  });

  it("comes back absent when every reading was absent", () => {
    expect(firstWrittenReading([absentReading, absentReading])).toEqual({
      kind: "absent",
    });
    expect(firstWrittenReading<number>([])).toEqual({ kind: "absent" });
  });
});
