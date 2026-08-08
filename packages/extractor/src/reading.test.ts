import { describe, expect, it } from "vitest";

import {
  absentReading,
  ambiguousReading,
  andThenReading,
  firstWrittenReading,
  mapReading,
  unreadableReading,
  valueToReadFurtherFrom,
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
      mapReading(ambiguousReading([1, 2], "two routers", range), (n) => n * 5),
    ).toEqual({
      kind: "ambiguous",
      candidates: [5, 10],
      reason: "two routers",
      range,
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

  it("reads further from every candidate of an ambiguous reading", () => {
    expect(
      andThenReading(
        ambiguousReading(["/items", "/things"], "two mounts", range),
        (prefix, at) => writtenReading(`${prefix}/{id}`, at),
      ),
    ).toEqual({
      kind: "ambiguous",
      candidates: ["/items/{id}", "/things/{id}"],
      reason: "two mounts",
      range,
    });
  });

  it("keeps only the candidates the next step could read", () => {
    expect(
      andThenReading(
        ambiguousReading(["/items", "/things"], "two mounts", range),
        (prefix, at) =>
          prefix === "/items"
            ? writtenReading(prefix, at)
            : unreadableReading<string>("no reader for this one", at),
      ),
    ).toEqual({
      kind: "ambiguous",
      candidates: ["/items"],
      reason: "two mounts",
      range,
    });
  });
});

describe("firstWrittenReading", () => {
  it("takes the first reading that was written", () => {
    expect(
      firstWrittenReading([
        absentReading,
        writtenReading(1, range),
        writtenReading(2, range),
      ]).reading,
    ).toEqual({ kind: "written", value: 1, range });
  });

  it("hands back what it passed over and could not read", () => {
    const unread = unreadableReading<number>("not a name", range);
    const chosen = firstWrittenReading([unread, writtenReading(7, range)]);

    expect(chosen.reading).toEqual({ kind: "written", value: 7, range });
    expect(chosen.passedOver).toEqual([unread]);
  });

  it("passes over nothing when every other reading was absent", () => {
    expect(
      firstWrittenReading([absentReading, writtenReading(7, range)]).passedOver,
    ).toEqual([]);
  });

  it("keeps a reason when nothing was written", () => {
    const chosen = firstWrittenReading([
      absentReading,
      unreadableReading<number>("not a name", range),
    ]);

    expect(chosen.reading).toEqual({
      kind: "unreadable",
      reason: "not a name",
      range,
    });
    // The reading a claim would come from is not also passed over, so
    // its reason reaches the summary once.
    expect(chosen.passedOver).toEqual([]);
  });

  it("comes back absent when every reading was absent", () => {
    expect(firstWrittenReading([absentReading, absentReading]).reading).toEqual(
      {
        kind: "absent",
      },
    );
    expect(firstWrittenReading<number>([]).reading).toEqual({ kind: "absent" });
  });
});

describe("valueToReadFurtherFrom", () => {
  it("gives back what a written reading found", () => {
    expect(valueToReadFurtherFrom(writtenReading("/items", range))).toBe(
      "/items",
    );
  });

  it("gives back nothing for a reading that found nothing, and no default", () => {
    expect(valueToReadFurtherFrom(absentReading)).toBeNull();
    expect(
      valueToReadFurtherFrom(unreadableReading<string>("computed", range)),
    ).toBeNull();
    expect(
      valueToReadFurtherFrom(ambiguousReading(["a", "b"], "two", range)),
    ).toBeNull();
  });
});
