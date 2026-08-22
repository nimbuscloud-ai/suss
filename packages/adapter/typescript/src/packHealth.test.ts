import { describe, expect, it } from "vitest";

import {
  evaluatePackHealth,
  formatPackHealth,
  packGradients,
} from "./packHealth.js";

import type { DeclaredMatch } from "@suss/extractor";
import type { PackFunnel } from "./diagnostics.js";

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
  }).find((check) => check.name === name)?.violations ?? [];

const drops = (packs: PackFunnel[]) =>
  firedBy("no pack drops everything it was holding", packs);

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
    expect(found[0]?.detail).toContain("discovery matched nothing");
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
    expect(found[0]?.detail).toContain("matched nothing in the bodies it saw");
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
    expect(found[0]?.detail).toContain(
      "turned none of them into a bound summary",
    );
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

  it("fires when every summary a pack produced is empty of transitions", () => {
    const found = drops([funnel({ summariesWithBehavior: 0 })]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("empty of transitions");
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
    });
    const audienceOf = (name: string) =>
      checks.find((check) => check.name === name)?.audience;

    expect(audienceOf("no pack drops everything it was holding")).toBe("run");
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
    expect(fired[0].detail).toBe(
      "2 link(s) are data and 1 written as a function: redis.container",
    );
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
    });

  it("says nothing when the caller asked for an audience that found nothing", () => {
    expect(
      formatPackHealth(
        [{ whenBroken: "broken", name: "x", audience: "run", violations: [] }],
        ["run"],
      ),
    ).toBe("");
  });

  it("prints only the audience the caller asked for", () => {
    const runOnly = formatPackHealth(checks(), ["run"]);
    expect(runOnly).toContain("empty of transitions");
    expect(runOnly).not.toContain("declares no version");

    const both = formatPackHealth(checks(), ["run", "pack"]);
    expect(both).toContain("empty of transitions");
    expect(both).toContain("declares no version");
  });
});
