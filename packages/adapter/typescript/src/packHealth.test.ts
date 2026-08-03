import { describe, expect, it } from "vitest";

import { evaluatePackHealth, formatPackHealth } from "./packHealth.js";

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
  ...over,
});

const firedBy = (name: string, packs: PackFunnel[]) =>
  evaluatePackHealth({
    filesInProject: 20,
    filesWalked: 20,
    packs,
    summaries: 0,
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

describe("formatPackHealth", () => {
  const checks = () =>
    evaluatePackHealth({
      filesInProject: 20,
      filesWalked: 20,
      packs: [funnel({ version: null, summariesWithBehavior: 0 })],
      summaries: 0,
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
