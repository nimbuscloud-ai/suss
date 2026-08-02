import { describe, expect, it } from "vitest";

import { evaluatePackHealth } from "./packHealth.js";

import type { PackFunnel } from "./diagnostics.js";

const funnel = (over: Partial<PackFunnel> = {}): PackFunnel => ({
  pack: "demo",
  version: "1.0.0",
  discovers: true,
  gates: ["@scope/lib"],
  unresolvedGates: [],
  candidateFiles: 4,
  unitsDiscovered: 3,
  unitsClaimed: 3,
  selfCollisions: 0,
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
    expect(
      drops([
        funnel({
          discovers: false,
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

  it("says nothing about an ungated pack that found no units", () => {
    expect(
      drops([
        funnel({
          gates: [],
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

  it("says nothing when the gate itself failed to resolve", () => {
    expect(
      drops([
        funnel({
          unresolvedGates: ["@scope/lib"],
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

  it("fires when recognised units bound to no boundary", () => {
    const found = drops([
      funnel({
        summariesBound: 0,
        providerSummaries: 0,
        summariesWithBehavior: 0,
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("bound none of them");
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
    const scopeOf = (name: string) =>
      checks.find((check) => check.name === name)?.scope;

    expect(scopeOf("no pack drops everything it was holding")).toBe("run");
    expect(scopeOf("no pack collides with itself")).toBe("run");
    expect(scopeOf("every pack declares a version")).toBe("pack");
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
