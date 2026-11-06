import { describe, expect, it, vi } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import {
  buildUngatedExtractionReport,
  createPackTallies,
  emptyTally,
  packRecognizers,
  recordPackFailure,
  runPackHook,
  runPackRecognizer,
  summaryCountsByPack,
  tallyUnit,
} from "./extractionReport.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";

/** A summary with only what the funnel reads off it: which pack recognised it, and whether it says anything. */
function summaryFrom(
  pack: string,
  opts: { kind?: BehavioralSummary["kind"]; transitions?: number } = {},
): BehavioralSummary {
  return {
    kind: opts.kind ?? "handler",
    location: { file: "x.ts", range: { start: 0, end: 1 }, exportName: null },
    identity: {
      name: "handler",
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path: "/",
        recognition: pack,
      }),
    },
    inputs: [],
    transitions: Array.from(
      { length: opts.transitions ?? 1 },
      (_, i): Transition => ({
        id: `t${i}`,
        conditions: [],
        output: { type: "void" },
        effects: [],
        location: { start: 0, end: 1 },
        isDefault: true,
      }),
    ),
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("emptyTally", () => {
  it("starts every count at zero", () => {
    expect(emptyTally()).toEqual({
      candidateFiles: 0,
      unitsDiscovered: 0,
      unitsInGatedFiles: 0,
      effectsRecognized: 0,
      unitsClaimed: 0,
      summariesProduced: 0,
      failures: [],
      helpersMatched: new Set(),
    });
  });
});

describe("createPackTallies", () => {
  it("gives each pack its own empty tally", () => {
    const tallies = createPackTallies([{ name: "a" }, { name: "b" }]);
    expect([...tallies.keys()]).toEqual(["a", "b"]);
    expect(tallies.get("a")).not.toBe(tallies.get("b"));
  });

  it("starts each try from the failures recorded before it, without sharing them", () => {
    const packs = [{ name: "a" }, { name: "b" }];
    const earlier = createPackTallies(packs);
    earlier
      .get("a")
      ?.failures.push({ hook: "discoveryInputs", file: "/repo", message: "x" });

    const first = createPackTallies(packs, earlier);
    first.get("a")?.failures.push({
      hook: "entryPoints",
      file: "/repo/a.py",
      message: "y",
    });
    const second = createPackTallies(packs, earlier);

    expect(second.get("a")?.failures).toEqual([
      { hook: "discoveryInputs", file: "/repo", message: "x" },
    ]);
    expect(second.get("b")?.failures).toEqual([]);
    expect(earlier.get("a")?.failures).toHaveLength(1);
  });
});

describe("recordPackFailure", () => {
  it("appends the failure to the tally and phrases it as one line", () => {
    const tally = emptyTally();
    const message = recordPackFailure(tally, {
      pack: "express",
      hook: "discoverUnits",
      file: "x.ts",
      error: new Error("boom"),
    });
    expect(tally.failures).toEqual([
      { hook: "discoverUnits", file: "x.ts", message: "boom" },
    ]);
    expect(message).toBe(
      '[suss] pack "express" threw from discoverUnits while reading x.ts: boom\n',
    );
  });

  it("stringifies a thrown value that is not an Error", () => {
    const tally = emptyTally();
    recordPackFailure(tally, {
      pack: "express",
      hook: "discoverUnits",
      file: "x.ts",
      error: "not an Error instance",
    });
    expect(tally.failures[0]?.message).toBe("not an Error instance");
  });

  it("does nothing to a tally the caller never had", () => {
    expect(() =>
      recordPackFailure(undefined, {
        pack: "express",
        hook: "discoverUnits",
        file: "x.ts",
        error: new Error("boom"),
      }),
    ).not.toThrow();
  });
});

describe("runPackHook", () => {
  const site = { pack: "jobs", hook: "subUnits", file: "x.py" };

  it("gives back what the hook returns", () => {
    const tally = emptyTally();
    expect(runPackHook(tally, site, () => ["claimed"], [])).toEqual([
      "claimed",
    ]);
    expect(tally.failures).toEqual([]);
  });

  it("records a hook that throws, prints it, and gives back the fallback", () => {
    const tally = emptyTally();
    const printed = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const found = runPackHook(
        tally,
        site,
        (): string[] => {
          throw new Error("boom");
        },
        [],
      );
      expect(found).toEqual([]);
      expect(tally.failures).toEqual([
        { hook: "subUnits", file: "x.py", message: "boom" },
      ]);
      expect(printed).toHaveBeenCalledWith(
        '[suss] pack "jobs" threw from subUnits while reading x.py: boom\n',
      );
    } finally {
      printed.mockRestore();
    }
  });
});

describe("a pack's recognizers", () => {
  const found = (callee: string) => [
    {
      type: "invocation" as const,
      callee,
      args: [],
      async: false,
    },
  ];
  const packs = [
    {
      name: "cache",
      invocationRecognizers: [() => found("cache.get")],
      accessRecognizers: [() => found("cache.read")],
    },
    { name: "sql", invocationRecognizers: [() => found("db.query")] },
  ];

  it("are listed in pack order, each with its pack, the list it came from and its tally", () => {
    const tallies = createPackTallies(packs);
    const listed = packRecognizers(packs, tallies);

    expect(
      listed.map((one) => [
        one.pack,
        one.hook,
        one.tally === tallies.get(one.pack),
      ]),
    ).toEqual([
      ["cache", "invocationRecognizers", true],
      ["cache", "accessRecognizers", true],
      ["sql", "invocationRecognizers", true],
    ]);
  });

  it("give back what the recognizer made of a node", () => {
    const [first] = packRecognizers(packs, undefined);
    expect(
      first === undefined
        ? null
        : runPackRecognizer(first, { file: "x.rb", line: 3 }, {}, {}),
    ).toEqual(found("cache.get"));
  });

  it("charge a throw to the recognizer's pack, with the line of the node", () => {
    const tallies = createPackTallies([{ name: "breaks" }]);
    const [breaks] = packRecognizers(
      [
        {
          name: "breaks",
          invocationRecognizers: [
            () => {
              throw new Error("boom");
            },
          ],
        },
      ],
      tallies,
    );
    const printed = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(
        breaks === undefined
          ? undefined
          : runPackRecognizer(breaks, { file: "x.rb", line: 3 }, {}, {}),
      ).toBeNull();
      expect(tallies.get("breaks")?.failures).toEqual([
        {
          hook: "invocationRecognizers",
          file: "x.rb",
          line: 3,
          message: "boom",
        },
      ]);
      expect(printed).toHaveBeenCalledWith(
        '[suss] pack "breaks" threw from invocationRecognizers while reading x.rb:3: boom\n',
      );
    } finally {
      printed.mockRestore();
    }
  });
});

describe("tallyUnit", () => {
  it("credits the pack the boundary binding names", () => {
    const tallies = createPackTallies([{ name: "fastapi" }]);
    tallyUnit(tallies, "fastapi");
    expect(tallies.get("fastapi")).toMatchObject({
      unitsDiscovered: 1,
      summariesProduced: 1,
    });
  });

  it("does nothing for a name outside this run's packs", () => {
    const tallies = createPackTallies([{ name: "fastapi" }]);
    tallyUnit(tallies, "some-other-pack");
    expect(tallies.get("fastapi")).toMatchObject({ unitsDiscovered: 0 });
  });

  it("does nothing when the raw unit named no pack at all", () => {
    const tallies = createPackTallies([{ name: "fastapi" }]);
    tallyUnit(tallies, undefined);
    expect(tallies.get("fastapi")).toMatchObject({ unitsDiscovered: 0 });
  });
});

describe("summaryCountsByPack", () => {
  it("groups bound, provider-side and behavior-bearing counts by pack", () => {
    const counts = summaryCountsByPack([
      summaryFrom("fastapi"),
      summaryFrom("fastapi", { kind: "caller", transitions: 0 }),
      summaryFrom("flask-restx"),
    ]);
    expect(counts.get("fastapi")).toEqual({
      bound: 2,
      providers: 1,
      withBehavior: 1,
    });
    expect(counts.get("flask-restx")).toEqual({
      bound: 1,
      providers: 1,
      withBehavior: 1,
    });
  });

  it("skips a summary whose boundary binding names no pack", () => {
    const unbound: BehavioralSummary = {
      ...summaryFrom("fastapi"),
      identity: { name: "handler", exportPath: null, boundaryBinding: null },
    };
    expect(summaryCountsByPack([unbound]).size).toBe(0);
  });
});

describe("buildUngatedExtractionReport", () => {
  const packs = [{ name: "fastapi", version: "1.0.0", discovers: true }];

  it("reports every pack ungated, with candidateFiles from the whole walk", () => {
    const tallies = createPackTallies(packs);
    tallyUnit(tallies, "fastapi");
    const report = buildUngatedExtractionReport({
      packs,
      tallies,
      filesWalked: 5,
      summaries: [summaryFrom("fastapi")],
    });
    expect(report.filesInProject).toBeNull();
    expect(report.filesWalked).toBe(5);
    expect(report.summaries).toBe(1);
    expect(report.emptyStage).toBeNull();
    expect(report.packs[0]).toMatchObject({
      pack: "fastapi",
      gates: [],
      unresolvedGates: [],
      candidateFiles: 5,
      unitsDiscovered: 1,
      unitsClaimed: 1,
      summariesProduced: 1,
      summariesBound: 1,
      declarations: null,
    });
  });

  it("blames candidateFiles when the walk found no files", () => {
    const report = buildUngatedExtractionReport({
      packs,
      tallies: createPackTallies(packs),
      filesWalked: 0,
      summaries: [],
    });
    expect(report.emptyStage).toBe("candidateFiles");
  });

  it("blames discovery when files were walked but no pack found a unit", () => {
    const report = buildUngatedExtractionReport({
      packs,
      tallies: createPackTallies(packs),
      filesWalked: 5,
      summaries: [],
    });
    expect(report.emptyStage).toBe("discovery");
  });

  it("blames assembly when units were discovered but nothing was built", () => {
    const tallies = createPackTallies(packs);
    const tally = tallies.get("fastapi");
    if (tally !== undefined) {
      tally.unitsDiscovered = 1;
    }
    const report = buildUngatedExtractionReport({
      packs,
      tallies,
      filesWalked: 5,
      summaries: [],
    });
    expect(report.emptyStage).toBe("assembly");
  });
});
