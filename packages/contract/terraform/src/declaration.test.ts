// What a summary gives back when its declaration is missing or was
// written by something older than this reader.

import { describe, expect, it } from "vitest";

import {
  readTerraformDeclaration,
  withTerraformDeclaration,
} from "./declaration.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function summaryWith(metadata: Record<string, unknown>): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "main.tf",
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: { name: "x", exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata,
  };
}

describe("what one resource stated", () => {
  it("reads back what the reader wrote", () => {
    const metadata = withTerraformDeclaration(undefined, {
      resource: "signals_counter",
      attributes: { limit: 5, "shape.value_type": "SPREAD", on: true },
    });

    expect(readTerraformDeclaration(summaryWith(metadata))).toEqual({
      resource: "signals_counter",
      attributes: { limit: 5, "shape.value_type": "SPREAD", on: true },
    });
  });

  it("keeps whatever else the metadata already stated", () => {
    const metadata = withTerraformDeclaration(
      { codeScope: { files: [] } },
      { resource: "signals_counter", attributes: {} },
    );

    expect(metadata.codeScope).toEqual({ files: [] });
  });

  it("says nothing for a summary that states nothing", () => {
    expect(readTerraformDeclaration(summaryWith({}))).toBeUndefined();
    expect(
      readTerraformDeclaration(summaryWith({ terraformDeclaration: "no" })),
    ).toBeUndefined();
    expect(
      readTerraformDeclaration(summaryWith({ terraformDeclaration: {} })),
    ).toBeUndefined();
  });

  it("drops a value it has no use for and keeps its siblings", () => {
    const declaration = readTerraformDeclaration(
      summaryWith({
        terraformDeclaration: {
          resource: "signals_counter",
          attributes: { limit: 5, labels: ["a"], nothing: null },
        },
      }),
    );

    expect(declaration?.attributes).toEqual({ limit: 5 });
  });

  it("gives back no attributes when they were not written as a block", () => {
    const declaration = readTerraformDeclaration(
      summaryWith({
        terraformDeclaration: { resource: "signals_counter", attributes: 7 },
      }),
    );

    expect(declaration).toEqual({
      resource: "signals_counter",
      attributes: {},
    });
  });
});
