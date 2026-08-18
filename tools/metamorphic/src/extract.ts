import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import type { Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { Program } from "./rewrite.js";
import type { Seed } from "./seed.js";

/**
 * Discovers the one unit every rewrite keeps, so a seed does not have to
 * pull in a web framework to have something to describe. Nothing about
 * the boundary call is in here; that is the seed's pack.
 */
export const HANDLER_PACK: PatternPack = {
  name: "metamorphic-handler",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["handler"] },
      requiresImport: [],
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [{ position: 0, role: "event" }],
  },
};

/** What a run says, in the two parts a rewrite has to leave alone. */
export interface RunDescription {
  /**
   * Every boundary access the run describes, wherever it attributes it.
   * A rewrite that moves the call into another function moves the effect
   * onto that function's own summary, and the access is the same one.
   */
  readonly effects: readonly string[];
  /** What the discovered unit reaches, which is the `Reaches:` of inspect. */
  readonly reaches: readonly string[];
}

// A rewrite moves the call and renames the function around it, so these
// would differ for a program that reaches the same boundary the same way.
const IGNORED_KEYS = new Set(["callee", "groupId", "origin", "preconditions"]);

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !IGNORED_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`);
  return `{${entries.join(",")}}`;
}

/** What a rewrite must not change: the boundary, and what the call does to it. */
export function fingerprint(effect: Effect): string {
  return stable(effect);
}

interface ClosureEntry {
  kind: string;
  target: string;
}

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Extract `program` and say what it describes. A guard splits one call
 * across two transitions, so the effects are deduplicated: which branches
 * a program has is not what a rewrite is being asked about.
 */
export async function describeRun(
  program: Program,
  seed: Seed,
): Promise<RunDescription> {
  const project = createTestProject();
  for (const [path, source] of Object.entries({
    ...seed.library,
    ...program,
  })) {
    project.createSourceFile(path, source);
  }
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [HANDLER_PACK, seed.pack()],
  });
  const summaries = await adapter.extractAll();
  const unit = summaries.find((summary) => summary.kind === "handler");
  if (unit === undefined) {
    throw new Error("the rewrite left no discovered unit to describe");
  }
  const closure = (unit.metadata?.effectsClosure ?? []) as ClosureEntry[];
  return {
    effects: sortedSet(
      summaries
        .flatMap((summary) => summary.transitions)
        .flatMap((transition) => transition.effects)
        .filter((effect) => effect.type === "interaction")
        .map(fingerprint),
    ),
    reaches: sortedSet(
      closure
        .filter((entry) => entry.kind === "interaction")
        .map((entry) => entry.target),
    ),
  };
}
