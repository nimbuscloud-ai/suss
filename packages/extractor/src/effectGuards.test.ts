import { describe, expect, it } from "vitest";

import {
  type BranchEnding,
  effectsFiringOn,
  firesOn,
  guardsHoldOn,
  runsBefore,
} from "./effectGuards.js";

import type { RawCondition } from "./index.js";

function condition(
  sourceText: string,
  polarity: RawCondition["polarity"],
): RawCondition {
  return { sourceText, structured: null, polarity, source: "explicit" };
}

function endingAt(
  line: number,
  conditions: RawCondition[] = [],
  loopAround?: { start: number; end: number },
): BranchEnding {
  return {
    conditions,
    terminal: {
      kind: "response",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location: { start: line, end: line },
    },
    ...(loopAround === undefined ? {} : { loopAround }),
  };
}

describe("firesOn", () => {
  it("keeps a write after an early raise off the raise's branch", () => {
    expect(firesOn({ line: 9 }, endingAt(5))).toBe(false);
    expect(firesOn({ line: 3 }, endingAt(5))).toBe(true);
  });

  it("keeps a call off a branch that recorded its guard the other way around", () => {
    const site = { line: 3, preconditions: [condition("found", "negative")] };

    expect(firesOn(site, endingAt(8, [condition("found", "positive")]))).toBe(
      false,
    );
  });

  it("keeps a call later in the loop around the terminal, since an earlier pass may have run it", () => {
    const site = { line: 7, preconditions: [condition("ok", "positive")] };
    const branch = endingAt(6, [condition("ok", "negative")], {
      start: 5,
      end: 8,
    });

    expect(firesOn(site, branch)).toBe(true);
    expect(firesOn({ line: 9 }, branch)).toBe(false);
  });

  it("keeps cleanup on a branch that ended inside its try, and off one that ended before it", () => {
    const cleanup = { line: 12, cleansUpFrom: 6 };

    expect(firesOn(cleanup, endingAt(8))).toBe(true);
    expect(firesOn(cleanup, endingAt(4))).toBe(false);
  });
});

describe("effectsFiringOn", () => {
  it("keeps the effects that fire, in the order given", () => {
    const placed = [
      { effect: "read", site: { line: 2 } },
      { effect: "write", site: { line: 9 } },
      { effect: "log", site: { line: 4 } },
    ];

    expect(effectsFiringOn(placed, endingAt(5))).toEqual(["read", "log"]);
  });
});

describe("guardsHoldOn", () => {
  it("lets an effect nobody gated onto every branch", () => {
    expect(guardsHoldOn(undefined, [condition("flag", "positive")])).toBe(true);
    expect(guardsHoldOn([], [condition("flag", "positive")])).toBe(true);
  });

  it("lets a guarded effect onto the branch that agrees with it", () => {
    expect(
      guardsHoldOn(
        [condition("flag", "positive")],
        [condition("flag", "positive")],
      ),
    ).toBe(true);
  });

  it("keeps a guarded effect off the branch that recorded the other way", () => {
    expect(
      guardsHoldOn(
        [condition("flag", "positive")],
        [condition("flag", "negative")],
      ),
    ).toBe(false);
  });

  it("keeps a guarded effect where the branch says nothing about the guard", () => {
    expect(
      guardsHoldOn(
        [condition("item.ok", "positive")],
        [condition("items.length > 0", "positive")],
      ),
    ).toBe(true);
  });

  it("needs every guard to survive, not just one", () => {
    expect(
      guardsHoldOn(
        [condition("a", "positive"), condition("b", "positive")],
        [condition("a", "positive"), condition("b", "negative")],
      ),
    ).toBe(false);
  });
});

describe("runsBefore", () => {
  it("counts a call written on the terminal's own line", () => {
    expect(runsBefore(12, 12)).toBe(true);
  });

  it("counts a call written inside the terminal's own expression", () => {
    expect(runsBefore(13, 14)).toBe(true);
  });

  it("keeps a call written after the terminal off it", () => {
    expect(runsBefore(15, 14)).toBe(false);
  });
});
