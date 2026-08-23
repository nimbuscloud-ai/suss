/**
 * A pack that broke and a pack that found nothing both report zero. The
 * difference has to reach whoever reads the numbers, because only one of
 * the two means the numbers are wrong.
 */

import { describe, expect, it, vi } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";
import { evaluatePackHealth, formatPackHealth } from "./packHealth.js";

import type { PatternPack } from "@suss/extractor";
import type { ExtractionReport } from "./diagnostics.js";

const SOURCE = "export const handler = () => ({ status: 200 });\n";

function packThatThrows(): PatternPack {
  return {
    name: "breaks",
    protocol: "http",
    languages: ["typescript"],
    discovery: [],
    discoverUnits: () => {
      throw new Error("cannot read what I was handed");
    },
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
  };
}

function packThatFindsNothing(): PatternPack {
  return {
    name: "quiet",
    protocol: "http",
    languages: ["typescript"],
    discovery: [],
    discoverUnits: () => [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
  };
}

async function reportFor(pack: PatternPack): Promise<ExtractionReport> {
  const project = createTestProject();
  project.createSourceFile("src/a.ts", SOURCE);

  let report: ExtractionReport | null = null;
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [pack],
    onExtractionReport: (r) => {
      report = r;
    },
  });
  await adapter.extractAll();

  if (report === null) {
    throw new Error("the adapter reported nothing");
  }
  return report;
}

describe("a pack whose hook throws", () => {
  it("is not reported as a pack that found nothing", async () => {
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const broke = await reportFor(packThatThrows());
      const quiet = await reportFor(packThatFindsNothing());

      // Both discovered nothing. Only one of them was asked and threw.
      expect(broke.packs[0]?.unitsDiscovered).toBe(0);
      expect(quiet.packs[0]?.unitsDiscovered).toBe(0);

      expect(broke.packs[0]?.failures).toHaveLength(1);
      expect(broke.packs[0]?.failures[0]?.hook).toBe("discoverUnits");
      expect(broke.packs[0]?.failures[0]?.message).toContain(
        "cannot read what I was handed",
      );
      expect(quiet.packs[0]?.failures).toEqual([]);
    } finally {
      noise.mockRestore();
    }
  });

  it("shows up in pack health for whoever ran the extract", async () => {
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const broke = await reportFor(packThatThrows());
      const printed = formatPackHealth(evaluatePackHealth(broke), ["run"]);

      expect(printed).toContain("breaks");
      expect(printed).toContain("threw from discoverUnits");
      expect(printed).toContain("read less than the counts below suggest");

      const quiet = await reportFor(packThatFindsNothing());
      expect(
        formatPackHealth(evaluatePackHealth(quiet), ["run"]),
      ).not.toContain("threw from");
    } finally {
      noise.mockRestore();
    }
  });
});
