import { describe, expect, it } from "vitest";

import {
  evaluatePackHealth,
  formatPackHealth,
  packGradients,
} from "./packHealth.js";

import type { PackFunnel } from "./extractionReport.js";
import type { DeclaredMatch } from "./framework.js";

const funnel = (over: Partial<PackFunnel> = {}): PackFunnel => ({
  pack: "demo",
  version: "1.0.0",
  discovers: true,
  recognizes: false,
  gates: ["@scope/lib"],
  unresolvedGates: [],
  candidateFiles: 4,
  unitsDiscovered: 3,
  unitsInGatedFiles: 0,
  effectsRecognized: 0,
  unitsClaimed: 3,
  selfCollisions: 0,
  failures: [],
  helpersUnmatched: [],
  summariesProduced: 3,
  summariesBound: 3,
  providerSummaries: 3,
  summariesWithBehavior: 3,
  declarations: null,
  ...over,
});

const firedBy = (name: string, packs: PackFunnel[]) =>
  evaluatePackHealth({
    filesInProject: 20,
    filesWalked: 20,
    packs,
    summaries: 0,
    filesWithUnreadableExports: [],
    emptyStage: null,
    reassignedNamesUnstated: 0,
  }).find((check) => check.name === name)?.violations ?? [];

const drops = (packs: PackFunnel[]) =>
  firedBy("no pack finds something and records nothing", packs);

describe("the funnel-drop check", () => {
  it("stays quiet when a pack's gate selected nothing", () => {
    expect(
      drops([
        funnel({
          candidateFiles: 0,
          unitsDiscovered: 0,
          unitsClaimed: 0,
          summariesProduced: 0,
          summariesBound: 0,
          providerSummaries: 0,
          summariesWithBehavior: 0,
        }),
      ]),
    ).toEqual([]);
  });

  it("fires when a gate selected files and discovery matched nothing in them", () => {
    const found = drops([
      funnel({
        unitsDiscovered: 0,
        unitsClaimed: 0,
        summariesProduced: 0,
        summariesBound: 0,
        providerSummaries: 0,
        summariesWithBehavior: 0,
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe("4 source files -> 0 units");
  });

  it("fires when a pack bound client summaries and none describe anything", () => {
    // The count this is measured against used to skip clients, so a
    // client pack that described nothing looked like a success.
    const found = drops([
      funnel({ providerSummaries: 0, summariesWithBehavior: 0 }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe("3 summaries -> 0 transitions");
  });

  it("stays quiet when a client pack's summaries do describe something", () => {
    expect(drops([funnel({ providerSummaries: 0 })])).toEqual([]);
  });

  it("fires when a recogniser saw bodies and matched nothing in them", () => {
    const found = drops([
      funnel({
        discovers: false,
        recognizes: true,
        unitsDiscovered: 0,
        unitsInGatedFiles: 20,
        effectsRecognized: 0,
        unitsClaimed: 0,
        summariesProduced: 0,
        summariesBound: 0,
        providerSummaries: 0,
        summariesWithBehavior: 0,
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe("20 unit bodies -> 0 effects");
  });

  it("says nothing about a recogniser whose library is not installed", () => {
    const found = drops([
      funnel({
        discovers: false,
        recognizes: true,
        unresolvedGates: ["@scope/lib"],
        unitsDiscovered: 0,
        unitsInGatedFiles: 20,
        effectsRecognized: 0,
        unitsClaimed: 0,
        summariesProduced: 0,
        summariesBound: 0,
        providerSummaries: 0,
        summariesWithBehavior: 0,
      }),
    ]);
    // The empty-run diagnosis says the dependencies are missing, and
    // saying it twice in one run reads as two problems.
    expect(found).toEqual([]);
  });

  it("says nothing about a pack made only of recognisers", () => {
    const found = drops([
      funnel({
        discovers: false,
        recognizes: true,
        unitsDiscovered: 0,
        unitsInGatedFiles: 0,
        unitsClaimed: 0,
        summariesProduced: 0,
        summariesBound: 0,
        providerSummaries: 0,
        summariesWithBehavior: 0,
      }),
    ]);
    expect(found).toEqual([]);
  });

  it("fires when recognised units bound to no boundary", () => {
    const found = drops([
      funnel({
        summariesBound: 0,
        providerSummaries: 0,
        summariesWithBehavior: 0,
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe("3 units -> 0 summaries");
  });

  it("stays quiet when an earlier pack claimed every unit", () => {
    expect(
      drops([
        funnel({
          unitsClaimed: 0,
          summariesProduced: 0,
          summariesBound: 0,
          providerSummaries: 0,
          summariesWithBehavior: 0,
        }),
      ]),
    ).toEqual([]);
  });

  it("fires when every summary a pack wrote records nothing", () => {
    const found = drops([funnel({ summariesWithBehavior: 0 })]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe("3 summaries -> 0 transitions");
  });
});

describe("who a check is addressed to", () => {
  it("keeps a codebase finding separate from a pack-build finding", () => {
    const checks = evaluatePackHealth({
      filesInProject: 20,
      filesWalked: 20,
      packs: [funnel()],
      summaries: 0,
      filesWithUnreadableExports: [],
      emptyStage: null,
      reassignedNamesUnstated: 0,
    });
    const audienceOf = (name: string) =>
      checks.find((check) => check.name === name)?.audience;

    expect(audienceOf("no pack finds something and records nothing")).toBe(
      "run",
    );
    expect(audienceOf("no pack collides with itself")).toBe("run");
    expect(audienceOf("every pack declares a version")).toBe("pack");
  });
});

describe("the remaining checks", () => {
  it("names a pack that declares no version", () => {
    expect(
      firedBy("every pack declares a version", [funnel({ version: null })]),
    ).toHaveLength(1);
    expect(firedBy("every pack declares a version", [funnel()])).toEqual([]);
  });

  it("names a pack whose own patterns claimed one unit twice", () => {
    expect(
      firedBy("no pack collides with itself", [funnel({ selfCollisions: 2 })]),
    ).toHaveLength(1);
  });

  it("names a pack that threw, with the file and message from its first failure", () => {
    const found = firedBy("no pack throws while it reads", [
      funnel({
        failures: [
          { hook: "discoverUnits", file: "a.ts", message: "boom" },
          { hook: "discoverUnits", file: "b.ts", message: "also boom" },
        ],
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toBe("discoverUnits on a.ts (+1 more): boom");
  });

  it("stays quiet about a pack whose hooks never threw", () => {
    expect(firedBy("no pack throws while it reads", [funnel()])).toEqual([]);
  });
});

describe("the gradient a declared pack sits on", () => {
  const declared = (over: Partial<DeclaredMatch> = {}): PackFunnel =>
    funnel({
      declarations: {
        declarations: [
          {
            name: "redis",
            dataLinks: 2,
            functionLinks: [],
            astLinks: [],
            example: 'redis.get("k")',
            ...over,
          },
        ],
      },
    });

  const gradients = (packs: PackFunnel[]) =>
    packGradients({
      filesInProject: 20,
      filesWalked: 20,
      packs,
      summaries: 0,
      filesWithUnreadableExports: [],
      emptyStage: null,
      reassignedNamesUnstated: 0,
    });

  it("passes over a pack written as a hand-rolled walk", () => {
    expect(gradients([funnel()])).toEqual([]);
  });

  it("adds up the links across every declaration a pack ships", () => {
    expect(gradients([declared()])).toEqual([
      {
        pack: "demo",
        dataLinks: 2,
        functionLinks: [],
        astLinks: [],
        withoutExample: [],
      },
    ]);
  });

  it("says which link a pack wrote as a function, and how many stayed data", () => {
    const fired = firedBy("every link a declared pack states is data", [
      declared({ functionLinks: ["container"] }),
    ]);

    expect(fired).toHaveLength(1);
    expect(fired[0].detail).toBe("redis.container (2 data)");
  });

  it("leaves a pack alone when every link it states is data", () => {
    expect(
      firedBy("every link a declared pack states is data", [declared()]),
    ).toEqual([]);
  });

  it("names a pack that reads the syntax tree", () => {
    const fired = firedBy("no declared pack reads the syntax tree", [
      declared({ functionLinks: ["container"], astLinks: ["container"] }),
    ]);

    expect(fired).toHaveLength(1);
    expect(fired[0].detail).toContain("redis.container");
  });

  it("names a declaration nobody can run", () => {
    const fired = firedBy("every declaration states an example", [
      declared({ example: null }),
    ]);

    expect(fired).toHaveLength(1);
    expect(fired[0].detail).toContain("redis");
    expect(
      firedBy("every declaration states an example", [declared()]),
    ).toEqual([]);
  });

  it("addresses all three to whoever ships the pack", () => {
    const checks = evaluatePackHealth({
      filesInProject: 20,
      filesWalked: 20,
      packs: [declared()],
      summaries: 0,
      filesWithUnreadableExports: [],
      emptyStage: null,
      reassignedNamesUnstated: 0,
    });
    const audienceOf = (name: string) =>
      checks.find((check) => check.name === name)?.audience;

    expect(audienceOf("every link a declared pack states is data")).toBe(
      "pack",
    );
    expect(audienceOf("no declared pack reads the syntax tree")).toBe("pack");
    expect(audienceOf("every declaration states an example")).toBe("pack");
  });
});

describe("formatPackHealth", () => {
  const checks = () =>
    evaluatePackHealth({
      filesInProject: 20,
      filesWalked: 20,
      packs: [funnel({ version: null, summariesWithBehavior: 0 })],
      summaries: 0,
      filesWithUnreadableExports: [],
      emptyStage: null,
      reassignedNamesUnstated: 0,
    });

  it("says nothing when the caller asked for an audience that found nothing", () => {
    expect(
      formatPackHealth(
        [{ code: "x", name: "x", audience: "run", violations: [] }],
        ["run"],
      ),
    ).toBe("");
  });

  it("prints only the audience the caller asked for", () => {
    const runOnly = formatPackHealth(checks(), ["run"]);
    expect(runOnly).toContain("no-output");
    expect(runOnly).not.toContain("no-version");

    const both = formatPackHealth(checks(), ["run", "pack"]);
    expect(both).toContain("no-output");
    expect(both).toContain("no-version");
  });
});

describe("the recognizer-with-no-units check", () => {
  const noUnits = (packs: PackFunnel[]) =>
    firedBy("every recognizer had units to look inside", packs);

  const recognizerOnly = (over: Partial<PackFunnel> = {}) =>
    funnel({
      discovers: false,
      recognizes: true,
      candidateFiles: 12,
      unitsDiscovered: 0,
      unitsInGatedFiles: 0,
      unitsClaimed: 0,
      summariesProduced: 0,
      summariesBound: 0,
      providerSummaries: 0,
      summariesWithBehavior: 0,
      ...over,
    });

  it("says which pack had nothing to look inside, and what to add", () => {
    // `-f prisma` alone on a working application printed nothing at
    // all: the recognizer walks units other packs discover, none were
    // discovered, and the funnel-drop check skips a stage whose first
    // count is already zero.
    const violations = noUnits([recognizerOnly()]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("12 gated files");
    expect(violations[0]?.detail).toContain("suss init");
  });

  it("stays quiet when units were walked, whatever came of them", () => {
    expect(noUnits([recognizerOnly({ unitsInGatedFiles: 5 })])).toEqual([]);
  });

  it("stays quiet when the closure roots recognized effects", () => {
    // The gated files' exports joined the walk as roots, so the run
    // produced summaries and the missing framework pack costs
    // attribution rather than existence.
    expect(noUnits([recognizerOnly({ effectsRecognized: 40 })])).toEqual([]);
  });

  it("stays quiet when the gate selected no files", () => {
    expect(noUnits([recognizerOnly({ candidateFiles: 0 })])).toEqual([]);
  });

  it("stays quiet for a pack that discovers its own units", () => {
    expect(noUnits([funnel({ recognizes: true })])).toEqual([]);
  });

  it("stays quiet while the gate is unresolved, which has its own report", () => {
    expect(
      noUnits([recognizerOnly({ unresolvedGates: ["@scope/lib"] })]),
    ).toEqual([]);
  });
});
