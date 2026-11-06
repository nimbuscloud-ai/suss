/**
 * A pack that broke and a pack that found nothing both report zero. The
 * difference has to reach whoever reads the numbers, because only one of
 * the two means the numbers are wrong.
 */

import { describe, expect, it, vi } from "vitest";

import { evaluatePackHealth, formatPackHealth } from "@suss/extractor";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { ExtractionReport, PatternPack } from "@suss/extractor";

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

  it("costs only its sub-units when the hook that claims them throws", async () => {
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const project = createTestProject();
      project.createSourceFile(
        "src/a.ts",
        "export function handler() { later(() => notify()); }\n",
      );
      const handlers: PatternPack = {
        name: "handlers",
        protocol: "http",
        languages: ["typescript"],
        discovery: [
          {
            kind: "handler",
            match: { type: "namedExport", names: ["handler"] },
            requiresImport: [],
          },
        ],
        terminals: [],
        inputMapping: { type: "positionalParams", params: [] },
      };
      const claims: PatternPack = {
        name: "claims",
        protocol: "in-process",
        languages: ["typescript"],
        discovery: [],
        // A recognizer makes the pack apply to every file.
        invocationRecognizers: [() => null],
        subUnits: () => {
          throw new Error("cannot claim what I was handed");
        },
        terminals: [],
        inputMapping: { type: "positionalParams", params: [] },
      };
      let report: ExtractionReport | null = null;
      const summaries = await createTypeScriptAdapter({
        project,
        frameworks: [handlers, claims],
        onExtractionReport: (r) => {
          report = r;
        },
      }).extractAll();

      expect(summaries.map((summary) => summary.identity.name)).toEqual([
        "handler",
      ]);
      const failures = (report as ExtractionReport | null)?.packs.find(
        (funnel) => funnel.pack === "claims",
      )?.failures;
      expect(failures?.map((failure) => failure.hook)).toContain("subUnits");
      expect(failures?.[0]?.message).toBe("cannot claim what I was handed");
    } finally {
      noise.mockRestore();
    }
  });

  it("shows up in pack health for whoever ran the extract", async () => {
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const broke = await reportFor(packThatThrows());
      const printed = formatPackHealth(evaluatePackHealth(broke), ["run"]);

      expect(printed).toContain("threw");
      expect(printed).toContain("breaks");
      expect(printed).toContain("discoverUnits on /src/a.ts");

      const quiet = await reportFor(packThatFindsNothing());
      expect(
        formatPackHealth(evaluatePackHealth(quiet), ["run"]),
      ).not.toContain("threw from");
    } finally {
      noise.mockRestore();
    }
  });

  it("costs only the calls its recognizer threw on, and goes on its tally", async () => {
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const project = createTestProject();
      project.createSourceFile(
        "src/a.ts",
        "export function handler() {\n  audit();\n}\n",
      );
      const handlers: PatternPack = {
        name: "handlers",
        protocol: "http",
        languages: ["typescript"],
        discovery: [
          {
            kind: "handler",
            match: { type: "namedExport", names: ["handler"] },
            requiresImport: [],
          },
        ],
        terminals: [
          {
            kind: "return",
            match: { type: "functionFallthrough" },
            extraction: {},
          },
        ],
        inputMapping: { type: "positionalParams", params: [] },
      };
      const audits: PatternPack = {
        ...handlers,
        name: "audits",
        discovery: [],
        invocationRecognizers: [
          () => [
            {
              type: "interaction",
              binding: {
                transport: "sqs",
                semantics: {
                  name: "message-bus",
                  messageBus: "aws_sqs",
                  channel: "audits",
                },
                recognition: "audits",
              },
              callee: "audit",
              interaction: { class: "message-send" },
            },
          ],
        ],
      };
      const breaks: PatternPack = {
        ...handlers,
        name: "breaks",
        discovery: [],
        invocationRecognizers: [
          () => {
            throw new Error("cannot read what I was handed");
          },
        ],
      };
      let report: ExtractionReport | null = null;
      const summaries = await createTypeScriptAdapter({
        project,
        frameworks: [handlers, breaks, audits],
        onExtractionReport: (r) => {
          report = r;
        },
      }).extractAll();

      const handler = summaries.find((one) => one.identity.name === "handler");
      expect(
        handler?.transitions.flatMap((transition) =>
          transition.effects.flatMap((effect) =>
            effect.type === "interaction" ? [effect.callee] : [],
          ),
        ),
      ).toEqual(["audit"]);
      const funnels = (report as ExtractionReport | null)?.packs ?? [];
      expect(
        funnels.find((funnel) => funnel.pack === "breaks")?.failures,
      ).toEqual([
        {
          hook: "invocationRecognizers",
          file: "/src/a.ts",
          line: 2,
          message: "cannot read what I was handed",
        },
      ]);
      expect(
        funnels.find((funnel) => funnel.pack === "audits")?.failures,
      ).toEqual([]);
    } finally {
      noise.mockRestore();
    }
  });

  it("finishes the run when the hook naming its generator's directories throws, and goes on its tally", async () => {
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const project = createTestProject();
      project.createSourceFile(
        "src/a.ts",
        'import { db } from "./generated/db";\nexport function handler() {\n  return db;\n}\n',
      );
      const generator: PatternPack = {
        name: "generator",
        protocol: "http",
        languages: ["typescript"],
        discovery: [
          {
            kind: "handler",
            match: { type: "namedExport", names: ["handler"] },
            requiresImport: ["orm-client"],
          },
        ],
        generatedModuleDirs: () => {
          throw new Error("cannot read the generator's configuration");
        },
        terminals: [],
        inputMapping: { type: "positionalParams", params: [] },
      };
      let report: ExtractionReport | null = null;
      const summaries = await createTypeScriptAdapter({
        project,
        frameworks: [generator],
        onExtractionReport: (r) => {
          report = r;
        },
      }).extractAll();

      expect(summaries).toEqual([]);
      expect(
        (report as ExtractionReport | null)?.packs.find(
          (funnel) => funnel.pack === "generator",
        )?.failures,
      ).toEqual([
        {
          hook: "generatedModuleDirs",
          file: "/src",
          message: "cannot read the generator's configuration",
        },
      ]);
    } finally {
      noise.mockRestore();
    }
  });
});
