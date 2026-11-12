/**
 * One `callbacks` declaration over a global the program never imports,
 * run over the same code in TypeScript, Python and Ruby. The global
 * takes its callback first and a delay after it, the way a runtime's
 * timer does, so each language gives the same schedule effects, says
 * the calls have a delay, claims the function written in place with the
 * metadata the link declares, and reads a bound method handed over as a
 * callback it cannot read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { callbacks, global, pack } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const LATER = callbacks({ client: global("later") })
  .methods({
    later: { callback: { written: "argument", at: 0 }, delay: { at: 1 } },
  })
  .schedules({
    via: "asWritten",
    unread: { missing: "missing-callback", other: "unread-callback" },
  })
  .unitWhenInPlace({
    kind: "scheduled-callback",
    name: ["parent", "callee", "countPerCallee"],
    metadata: { timers: { scheduledBy: { reads: "callee" } } },
  })
  .example("later(() => notify(), 5)");

const DECLARED = pack("declared-later", [LATER], {
  languages: ["typescript", "python", "ruby"],
  recognizedAs: "@suss/declared-timer-test",
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
  export function enqueue(handler: { method(): void }) {
    later(() => notify(), 5);
    later(handler.method, 5);
  }
`;

const PYTHON = `def enqueue(handler):
    later(lambda: notify(), 5)
    later(handler.method, 5)
`;

const RUBY = `module Timers
  def self.enqueue(handler)
    later(-> { notify }, 5)
    later(handler.method, 5)
  end
end
`;

async function typescriptSummaries(): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  project.createSourceFile("/timers.ts", TYPESCRIPT);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [EXPORTS, DECLARED],
  });
  return await adapter.extractAll();
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-declared-timers-")),
  );
  fs.mkdirSync(path.join(root, "timers"));
  fs.writeFileSync(path.join(root, "timers/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/timers"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/timers.rb"), RUBY);
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
    files: [path.join(root, "timers/__init__.py")],
    roots: [root],
    packs: [LOADED],
    modules: [{ name: "timers", root: path.join(root, "timers") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

async function rubySummaries(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/timers.rb")],
    packs: [LOADED],
    modules: [{ name: "timers", root: path.join(root, "lib/timers") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

function effectsOf(summary: BehavioralSummary | undefined): Effect[] {
  return (summary?.transitions ?? []).flatMap(
    (transition) => transition.effects,
  );
}

/** What one language's run says about the timer calls and the callback it claimed. */
function timersIn(summaries: readonly BehavioralSummary[]) {
  const parent = summaries.find(
    (summary) =>
      summary.identity.name.endsWith("enqueue") &&
      summary.kind !== "scheduled-callback",
  );
  const claim = summaries.find((summary) =>
    summary.identity.name.endsWith("enqueue.later#0"),
  );
  return {
    schedules: effectsOf(parent).flatMap((effect) =>
      effect.type === "interaction" && effect.interaction.class === "schedule"
        ? [[effect.callee, effect.interaction]]
        : [],
    ),
    claim: claim === undefined ? null : claim.kind,
    timersMetadata: claim?.metadata?.timers ?? null,
    others: summaries.filter((summary) =>
      summary.identity.name.includes(".later#"),
    ).length,
  };
}

describe("a callbacks declaration over a global that takes a delay", () => {
  it("records each call with its delay, claims the function written in place with its metadata, and reads a bound method as a callback it cannot read, in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = timersIn(await typescriptSummaries());

    expect(fromTypeScript).toEqual({
      schedules: [
        [
          "later",
          {
            class: "schedule",
            via: "later",
            callbackRef: { type: "literal" },
            hasDelay: true,
          },
        ],
        [
          "later",
          {
            class: "schedule",
            via: "later",
            callbackRef: { type: "opaque", reason: "unread-callback" },
            hasDelay: true,
          },
        ],
      ],
      claim: "scheduled-callback",
      timersMetadata: { scheduledBy: "later" },
      others: 1,
    });
    expect(timersIn(await pythonSummaries())).toEqual(fromTypeScript);
    expect(timersIn(await rubySummaries())).toEqual(fromTypeScript);
  });
});
