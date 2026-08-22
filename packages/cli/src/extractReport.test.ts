import { describe, expect, it } from "vitest";

import { formatExtractionReport, incompletenessPathFor } from "./extract.js";

import type { ExtractionReport, PackFunnel } from "@suss/adapter-typescript";

function pack(overrides: Partial<PackFunnel> = {}): PackFunnel {
  return {
    pack: "express",
    version: "1.0.0",
    discovers: true,
    recognizes: false,
    gates: ["express"],
    unresolvedGates: [],
    candidateFiles: 3,
    unitsDiscovered: 2,
    unitsInGatedFiles: 0,
    effectsRecognized: 0,
    unitsClaimed: 2,
    selfCollisions: 0,
    failures: [],
    summariesProduced: 2,
    summariesBound: 2,
    providerSummaries: 2,
    summariesWithBehavior: 2,
    declarations: null,
    ...overrides,
  };
}

function report(overrides: Partial<ExtractionReport> = {}): ExtractionReport {
  return {
    filesInProject: 10,
    filesWalked: 5,
    packs: [pack()],
    summaries: 2,
    filesWithUnreadableExports: [],
    emptyStage: null,
    ...overrides,
  };
}

describe("formatExtractionReport", () => {
  it("shows where the summaries came from on a run that found some", () => {
    const output = formatExtractionReport(report());

    expect(output).toContain("Where these came from");
    expect(output).toContain("files in the tsconfig");
    expect(output).toContain("boundaries recognized by express");
    expect(output).not.toContain("Where it stopped");
  });

  it("blames the tsconfig, and says what to look at", () => {
    const output = formatExtractionReport(
      report({
        filesInProject: 0,
        filesWalked: 0,
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "tsconfig",
        packs: [
          pack({ candidateFiles: 0, unitsDiscovered: 0, summariesProduced: 0 }),
        ],
      }),
    );

    expect(output).toContain("matched no source files");
    expect(output).toContain("`include`");
  });

  it("names the missing package when a gate does not resolve", () => {
    const output = formatExtractionReport(
      report({
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "gateResolution",
        packs: [
          pack({
            pack: "apollo-client",
            gates: ["@apollo/client"],
            unresolvedGates: ["@apollo/client"],
            candidateFiles: 102,
            unitsDiscovered: 0,
            summariesProduced: 0,
          }),
        ],
      }),
    );

    expect(output).toContain("102 files import @apollo/client");
    expect(output).toContain("not installed here");
    expect(output).toContain("Install this project's dependencies");
  });

  // A project that does not use a package has that package missing from
  // node_modules too, so an unresolved gate on its own is evidence of nothing.
  it("does not blame a missing package when no file asked for it", () => {
    const output = formatExtractionReport(
      report({
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "candidateFiles",
        packs: [
          pack({
            gates: ["express"],
            unresolvedGates: ["express"],
            candidateFiles: 0,
            unitsDiscovered: 0,
            summariesProduced: 0,
          }),
        ],
      }),
    );

    expect(output).toContain("No file imports anything");
    expect(output).not.toContain("not installed here");
    expect(output).not.toContain("Install this project's dependencies");
  });

  // Running with only recognizer packs can never produce a summary, so
  // the empty run is a missing pack, not a code shape the pack lacks.
  it("says a recognizer-only run needs a discovery pack, not an issue", () => {
    const output = formatExtractionReport(
      report({
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "discovery",
        packs: [
          pack({
            pack: "aws-sqs",
            discovers: false,
            recognizes: true,
            unitsDiscovered: 0,
            summariesProduced: 0,
          }),
        ],
      }),
      ["aws-sqs"],
    );

    expect(output).toContain("No discovery pack is loaded");
    expect(output).toContain("suss extract -f express -f aws-sqs");
    expect(output).not.toContain("Worth opening an issue");
  });

  // A recogniser pack attaches effects to units other packs found, so its
  // discovery rows are all zero.
  it("shows what a recogniser pack contributed", () => {
    const output = formatExtractionReport(
      report({
        summaries: 1,
        filesWithUnreadableExports: [],
        emptyStage: null,
        packs: [
          pack({
            pack: "prisma",
            discovers: false,
            recognizes: true,
            gates: ["@prisma/client"],
            candidateFiles: 4,
            unitsDiscovered: 0,
            unitsInGatedFiles: 7,
            effectsRecognized: 3,
            summariesProduced: 0,
            summariesBound: 0,
            providerSummaries: 0,
            summariesWithBehavior: 0,
          }),
        ],
      }),
    );

    expect(output).toContain("7  unit bodies prisma could look inside");
    expect(output).toContain("3  effects prisma recognized");
    expect(output).not.toContain("boundaries recognized by prisma");
    expect(output).not.toContain("summaries from prisma");
  });

  it("says no file imported anything the pack looks for", () => {
    const output = formatExtractionReport(
      report({
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "candidateFiles",
        packs: [
          pack({ candidateFiles: 0, unitsDiscovered: 0, summariesProduced: 0 }),
        ],
      }),
    );

    expect(output).toContain("No file imports anything");
    expect(output).toContain("local wrapper module");
  });

  it("says the pack read files and recognized nothing", () => {
    const output = formatExtractionReport(
      report({
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "discovery",
        packs: [pack({ unitsDiscovered: 0, summariesProduced: 0 })],
      }),
    );

    expect(output).toContain("recognized no boundaries");
    expect(output).toContain("opening an issue");
  });

  it("calls an assembly failure a bug in suss", () => {
    const output = formatExtractionReport(
      report({
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "assembly",
        packs: [pack({ summariesProduced: 0 })],
      }),
    );

    expect(output).toContain("recognized 2 boundaries");
    expect(output).toContain("bug in suss");
  });

  it("notes a missing dependency without calling it a failure", () => {
    // A pack matching on import text works without the package installed.
    const output = formatExtractionReport(
      report({
        packs: [
          pack({
            pack: "aws-lambda",
            gates: ["aws-lambda"],
            unresolvedGates: ["aws-lambda"],
          }),
        ],
      }),
    );

    expect(output).toContain("matched on import names alone");
    expect(output).not.toContain("dependency not installed");
  });

  it("describes a pack with no gate as applying everywhere", () => {
    const output = formatExtractionReport(
      report({ packs: [pack({ pack: "node", gates: [] })] }),
    );

    expect(output).toContain("files node looked at");
  });

  it("leaves out the tsconfig row when a Project was supplied", () => {
    const output = formatExtractionReport(report({ filesInProject: null }));

    expect(output).not.toContain("files in the tsconfig");
    expect(output).toContain("files read");
  });

  it("lists two unresolved packages as a pair", () => {
    const output = formatExtractionReport(
      report({
        summaries: 0,
        filesWithUnreadableExports: [],
        emptyStage: "gateResolution",
        packs: [
          pack({
            gates: ["axios", "@apollo/client"],
            unresolvedGates: ["axios", "@apollo/client"],
            candidateFiles: 4,
            summariesProduced: 0,
          }),
        ],
      }),
    );

    expect(output).toContain("axios and @apollo/client");
    expect(output).toContain("those packages are");
  });

  it("says which files it could not read the re-exports of", () => {
    const output = formatExtractionReport(
      report({ filesWithUnreadableExports: ["/src/barrel.ts"] }),
    );

    expect(output).toContain("could not follow the re-exports of 1 file");
    expect(output).toContain("/src/barrel.ts");
  });

  it("names a few unreadable files and counts the rest", () => {
    const files = Array.from({ length: 8 }, (_, i) => `/src/barrel${i}.ts`);
    const output = formatExtractionReport(
      report({ filesWithUnreadableExports: files }),
    );

    expect(output).toContain("re-exports of 8 files");
    expect(output).toContain("/src/barrel0.ts");
    expect(output).not.toContain("/src/barrel7.ts");
    expect(output).toContain("and 3 more");
  });
});

describe("incompletenessPathFor", () => {
  it("sits beside the summaries under a name derived from theirs", () => {
    expect(incompletenessPathFor("/out/summaries.json")).toBe(
      "/out/summaries.incomplete.json",
    );
  });

  it("names a note for a summaries file with no extension", () => {
    expect(incompletenessPathFor("/out/summaries")).toBe(
      "/out/summaries.incomplete.json",
    );
  });
});
