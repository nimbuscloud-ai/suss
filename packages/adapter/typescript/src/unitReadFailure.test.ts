/**
 * One unit that cannot be read must not end the run. Its summary still
 * comes out, with its name and place, and a gap says what went wrong, so
 * nobody takes the empty body for one that does nothing.
 */

import { Project } from "ts-morph";
import { describe, expect, it, vi } from "vitest";

import { createTestProject, testCompilerOptions } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type {
  ExtractionReport,
  InputMappingPattern,
  PatternPack,
} from "@suss/extractor";

const RETURNS: PatternPack["terminals"] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
];

const PACK: PatternPack = {
  name: "handlers",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["broken", "fine"] },
    },
  ],
  terminals: RETURNS,
  inputMapping: { type: "positionalParams", params: [] },
};

// A mapping with no parameter list, which reading the unit's parameters
// cannot iterate. Any bug that throws partway through one unit's body
// behaves the same way.
const UNREADABLE_MAPPING = {
  type: "positionalParams",
  params: null,
} as unknown as InputMappingPattern;

/** Finds `broken` and `fine`, and hands `broken` the mapping above. */
const PACK_WITH_ONE_BAD_UNIT: PatternPack = {
  ...PACK,
  name: "one-bad-unit",
  discovery: [],
  discoverUnits: (sourceFile, ctx) => {
    const exported = (
      ctx as {
        exportedFunctions: (
          file: unknown,
        ) => Array<{ name: string; func: unknown }>;
      }
    ).exportedFunctions(sourceFile);
    return exported.map((fn) => ({
      func: fn.func,
      kind: "handler",
      name: fn.name,
      ...(fn.name === "broken" ? { inputMapping: UNREADABLE_MAPPING } : {}),
    }));
  },
};

/** A pattern whose export names are a number, gated to files that import one package. */
const PACK_WITH_BAD_PATTERN: PatternPack = {
  ...PACK,
  name: "bad-pattern",
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: 1 as unknown as string[] },
      requiresImport: ["@gated/lib"],
    },
  ],
};

async function extract(
  project: Project,
  frameworks: PatternPack[],
): Promise<{
  summaries: BehavioralSummary[];
  report: ExtractionReport | null;
  printed: string;
}> {
  let report: ExtractionReport | null = null;
  const adapter = createTypeScriptAdapter({
    project,
    frameworks,
    onExtractionReport: (r) => {
      report = r;
    },
  });
  const writes: string[] = [];
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
  try {
    const summaries = await adapter.extractAll();
    return { summaries, report, printed: writes.join("") };
  } finally {
    stderr.mockRestore();
  }
}

function projectWith(files: Record<string, string>): Project {
  const project = createTestProject();
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  return project;
}

const TWO_UNITS = `
  export function broken() {
    return 1;
  }
  export function fine() {
    return 2;
  }
`;

describe("a unit whose body throws while it is read", () => {
  it("still comes out, with a gap that gives the error", async () => {
    const { summaries } = await extract(
      projectWith({ "src/units.ts": TWO_UNITS }),
      [PACK_WITH_ONE_BAD_UNIT],
    );

    const broken = summaries.find((s) => s.identity.name === "broken");
    expect(broken?.transitions).toEqual([]);
    expect(broken?.confidence.level).toBe("low");
    expect(broken?.gaps).toHaveLength(1);
    expect(broken?.gaps[0]?.type).toBe("unreadOutcome");
    expect(broken?.gaps[0]?.description).toContain("is not iterable");
  });

  it("leaves the other units in the run alone", async () => {
    const { summaries, printed } = await extract(
      projectWith({ "src/units.ts": TWO_UNITS }),
      [PACK_WITH_ONE_BAD_UNIT],
    );

    const fine = summaries.find((s) => s.identity.name === "fine");
    expect(fine?.transitions).toHaveLength(1);
    expect(fine?.gaps).toEqual([]);
    expect(printed).toContain("could not read broken in /src/units.ts");
  });
});

describe("a function whose scan for calls throws", () => {
  it("is left out of the closure and the run goes on", async () => {
    // The compiler leaves this file unbound, so the checker throws on `this`.
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { ...testCompilerOptions, allowJs: false },
    });
    project.createSourceFile(
      "/src/units.js",
      "export function broken(active) {\n  this.cleanup();\n  return active;\n}\nexport function fine() {\n  return 2;\n}\n",
    );

    const { summaries, printed } = await extract(project, [PACK]);

    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "broken",
      "fine",
    ]);
    expect(printed).toContain("could not scan the function at /src/units.js:1");
  });
});

describe("a file whose discovery throws", () => {
  it("goes on that pack's tally, and the other packs still read the file", async () => {
    const { summaries, report, printed } = await extract(
      projectWith({
        "src/broken.ts": `import "@gated/lib";\nexport function broken() { return 1; }\n`,
        "src/fine.ts": "export function fine() { return 2; }\n",
      }),
      [PACK_WITH_BAD_PATTERN, PACK],
    );

    expect(summaries.map((s) => s.identity.name).sort()).toEqual([
      "broken",
      "fine",
    ]);
    const failures = report?.packs.find(
      (funnel) => funnel.pack === "bad-pattern",
    )?.failures;
    expect(failures?.map((f) => [f.hook, f.file])).toEqual([
      ["discovery", "/src/broken.ts"],
    ]);
    expect(printed).toContain("threw from discovery");
  });
});
