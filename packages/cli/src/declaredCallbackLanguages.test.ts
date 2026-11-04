/**
 * One `callbacks` declaration run over the same code written in
 * TypeScript, Python and Ruby. Each adapter hands the compiled hooks the
 * ops over its own facts and lists the parent's calls from the same
 * rule, so the three languages give the same schedule effect, claim the
 * same callback as a unit of its own, and put the call inside it on that
 * unit's summary rather than on the parent's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { callbacks, constructedFrom, pack } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

// Ruby has no imports, so the library comes in through its own constant,
// which the origin lists beside the module.
const LATER = callbacks({ client: constructedFrom("jobs", "Jobs") })
  .methods({
    later: { callback: [{ written: "callback", at: 0 }, { written: "block" }] },
  })
  .unitWhenInPlace({
    kind: "scheduled-callback",
    name: ["parent", "callee", "countPerCallee"],
  })
  .example("jobs.later(() => notify())");

const DECLARED = pack("declared-later", [LATER], {
  languages: ["typescript", "python", "ruby"],
  recognizedAs: "@suss/declared-test",
});

// TypeScript discovers nothing without a pattern, so a pack finds the
// exported function the way a handler pack would.
const EXPORTS: PatternPack = {
  name: "exports",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["enqueue"] },
      requiresImport: [],
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "return", match: { type: "functionFallthrough" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const TYPESCRIPT = `
  import { Jobs } from "jobs";

  const jobs = new Jobs();

  export function enqueue() {
    jobs.later(() => notify());
  }
`;

const PYTHON = `from jobs import Jobs

jobs = Jobs()


def enqueue():
    jobs.later(lambda: notify())
`;

const RUBY = `module Store
  def self.enqueue
    jobs = Jobs::Queue.new
    jobs.later { notify }
  end
end
`;

async function typescriptSummaries(): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/jobs/package.json",
    JSON.stringify({ name: "jobs", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/jobs/index.d.ts",
    "export declare class Jobs { later(run: () => void): void; }",
  );
  project.createSourceFile("/jobs.ts", TYPESCRIPT);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [EXPORTS, DECLARED],
  });
  return await adapter.extractAll();
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-declared-callbacks-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** The hooks the declaration compiled to, the way the Python and Ruby adapters load a pack. */
const LOADED = {
  name: DECLARED.name,
  protocol: DECLARED.protocol,
  discovery: [],
  invocationRecognizers: DECLARED.invocationRecognizers ?? [],
  ...(DECLARED.subUnits === undefined ? {} : { subUnits: DECLARED.subUnits }),
};

async function pythonSummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [LOADED],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

async function rubySummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs: [LOADED],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

/** What one language's run says about the parent and the callback it claimed. */
interface Claimed {
  /** The schedule effects on the parent, without where they were written. */
  schedules: unknown[];
  /** The name the claim is given after the parent's own. */
  claim: string | null;
  claimKind: string | null;
  /** Whether `notify` is called on the parent's summary and on the claim's. */
  notifyOnParent: boolean;
  notifyOnClaim: boolean;
}

function effectsOf(summary: BehavioralSummary | undefined): Effect[] {
  return (summary?.transitions ?? []).flatMap(
    (transition) => transition.effects,
  );
}

function calls(summary: BehavioralSummary | undefined, callee: string) {
  return effectsOf(summary).some(
    (effect) => effect.type === "invocation" && effect.callee === callee,
  );
}

function claimedIn(summaries: readonly BehavioralSummary[]): Claimed {
  const parent = summaries.find(
    (summary) =>
      summary.identity.name.endsWith("enqueue") &&
      summary.kind !== "scheduled-callback",
  );
  const claim = summaries.find((summary) =>
    summary.identity.name.endsWith("enqueue.jobs.later#0"),
  );
  const parentName = parent?.identity.name ?? "";
  return {
    schedules: effectsOf(parent)
      .filter(
        (effect) =>
          effect.type === "interaction" &&
          effect.binding?.recognition === "@suss/declared-test",
      )
      .map(({ location: _location, ...rest }) => rest),
    claim:
      claim === undefined ? null : claim.identity.name.slice(parentName.length),
    claimKind: claim?.kind ?? null,
    notifyOnParent: calls(parent, "notify"),
    notifyOnClaim: calls(claim, "notify"),
  };
}

describe("a callbacks declaration", () => {
  it("records the schedule, claims the callback and puts its call on the claim, in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = claimedIn(await typescriptSummaries());

    expect(fromTypeScript).toEqual({
      schedules: [
        {
          type: "interaction",
          binding: {
            transport: "in-process",
            semantics: { name: "function-call" },
            recognition: "@suss/declared-test",
          },
          callee: "jobs.later",
          interaction: {
            class: "schedule",
            via: "jobs.later",
            callbackRef: { type: "literal" },
            hasDelay: false,
          },
        },
      ],
      claim: ".jobs.later#0",
      claimKind: "scheduled-callback",
      notifyOnParent: false,
      notifyOnClaim: true,
    });
    expect(claimedIn(await pythonSummaries())).toEqual(fromTypeScript);
    expect(claimedIn(await rubySummaries())).toEqual(fromTypeScript);
  });
});
