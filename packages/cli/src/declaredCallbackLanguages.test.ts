/**
 * One `callbacks` declaration run over the same code written in
 * TypeScript, Python and Ruby. Each adapter hands the compiled hooks the
 * ops over its own facts and lists the parent's calls from the same
 * rule, so the three languages give the same schedule effect, claim the
 * same callback as a unit of its own, and put the call and the read of
 * the environment inside it on that unit's summary rather than on the
 * parent's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import {
  callbacks,
  constructedFrom,
  pack,
  renderedProps,
} from "@suss/recognize";
import { nodeRuntimePack } from "@suss/runtime-node";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

// Ruby has no imports, so the library comes in through its own constant,
// which the origin lists beside the module.
const LATER_CALLS = {
  later: { callback: [{ written: "callback", at: 0 }, { written: "block" }] },
} as const;

const LATER = callbacks({ client: constructedFrom("jobs", "Jobs") })
  .methods(LATER_CALLS)
  .schedules({
    via: "asWritten",
    unread: { missing: "missing-callback", other: "non-literal-callback" },
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

// A chain that records nothing on the parent, numbers its claims across
// the parent and reads the metadata each claim records.
const QUEUED = callbacks({ client: constructedFrom("jobs", "Jobs") })
  .methods(LATER_CALLS)
  .unitWhenInPlace({
    kind: "handler",
    name: ["parent", "countInParent"],
    countedAs: "job",
    metadata: {
      jobs: {
        kind: { reads: "text", text: "queued" },
        owner: { reads: "parent" },
        index: { reads: "count" },
        tags: { reads: "argumentItems", at: 1 },
      },
    },
  })
  .example('jobs.later(() => notify(), ["orders"])');

const CLAIMING = pack("declared-claims", [QUEUED], {
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
    jobs.later(() => notify(process.env.API_URL));
  }
`;

const PYTHON = `import os

from jobs import Jobs

jobs = Jobs()


def enqueue():
    jobs.later(lambda: notify(os.environ["API_URL"]))
`;

const RUBY = `module Store
  def self.enqueue
    jobs = Jobs::Queue.new
    jobs.later { notify(ENV["API_URL"]) }
  end
end
`;

const QUEUED_TYPESCRIPT = `
  import { Jobs } from "jobs";

  const jobs = new Jobs();
  const tags = ["nightly"];

  export function enqueue() {
    jobs.later(() => notify(), ["orders", ...tags]);
    jobs.later(() => audit(), tags);
    jobs.later(() => sweep());
  }
`;

const QUEUED_PYTHON = `from jobs import Jobs

jobs = Jobs()
tags = ["nightly"]


def enqueue():
    jobs.later(lambda: notify(), ["orders", *tags])
    jobs.later(lambda: audit(), tags)
    jobs.later(lambda: sweep())
`;

const QUEUED_RUBY = `module Queue
  def self.enqueue
    jobs = Jobs::Queue.new
    tags = ["nightly"]
    jobs.later(-> { notify }, ["orders", *tags])
    jobs.later(-> { audit }, tags)
    jobs.later { sweep }
  end
end
`;

async function typescriptSummaries(
  declared: PatternPack = DECLARED,
  source = TYPESCRIPT,
  file = "/jobs.ts",
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/jobs/package.json",
    JSON.stringify({ name: "jobs", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/jobs/index.d.ts",
    "export declare class Jobs { later(run: () => void, tags?: string[]): void; }",
  );
  project.createSourceFile(file, source);
  // TypeScript reads `process.env` through the Node runtime pack.
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [EXPORTS, declared, nodeRuntimePack()],
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
  fs.mkdirSync(path.join(root, "queue"));
  fs.writeFileSync(path.join(root, "queue/__init__.py"), QUEUED_PYTHON);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
  fs.mkdirSync(path.join(root, "lib/queue"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/queue.rb"), QUEUED_RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** The hooks a declaration compiled to, the way the Python and Ruby adapters load a pack. */
function loaded(declared: PatternPack) {
  return {
    name: declared.name,
    protocol: declared.protocol,
    discovery: [],
    invocationRecognizers: declared.invocationRecognizers ?? [],
    ...(declared.subUnits === undefined ? {} : { subUnits: declared.subUnits }),
  };
}

async function pythonSummaries(
  declared: PatternPack = DECLARED,
  module = "store",
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, `${module}/__init__.py`)],
    roots: [root],
    packs: [loaded(declared)],
    modules: [{ name: module, root: path.join(root, module) }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

async function rubySummaries(
  declared: PatternPack = DECLARED,
  module = "store",
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, `lib/${module}.rb`)],
    packs: [loaded(declared)],
    modules: [{ name: module, root: path.join(root, `lib/${module}`) }],
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
  /** Internal code in every language, so the claim pairs with nothing its parent serves. */
  claimBinding: unknown;
  /** Whether `notify` is called on the parent's summary and on the claim's. */
  notifyOnParent: boolean;
  notifyOnClaim: boolean;
  /** The environment variables the parent's summary and the claim's read. */
  envOnParent: (string | null)[];
  envOnClaim: (string | null)[];
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

function envRead(summary: BehavioralSummary | undefined): (string | null)[] {
  return effectsOf(summary).flatMap((effect) =>
    effect.type === "interaction" && effect.interaction.class === "config-read"
      ? [effect.interaction.name]
      : [],
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
    claimBinding: claim?.identity.boundaryBinding ?? null,
    notifyOnParent: calls(parent, "notify"),
    notifyOnClaim: calls(claim, "notify"),
    envOnParent: envRead(parent),
    envOnClaim: envRead(claim),
  };
}

describe("a callbacks declaration", () => {
  it("records the schedule, claims the callback and puts its call and its read of the environment on the claim, in TypeScript, Python and Ruby", async () => {
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
      claimBinding: {
        transport: "in-process",
        semantics: { name: "function-call" },
        recognition: "reachable",
      },
      notifyOnParent: false,
      notifyOnClaim: true,
      envOnParent: [],
      envOnClaim: ["API_URL"],
    });
    expect(claimedIn(await pythonSummaries())).toEqual(fromTypeScript);
    expect(claimedIn(await rubySummaries())).toEqual(fromTypeScript);
  });
});

/** Each claim the chain made in `enqueue`, by its name after the parent's, with its metadata and the owner said as the parent. */
function claimsOf(summaries: readonly BehavioralSummary[]) {
  const parent = summaries.find((summary) =>
    summary.identity.name.endsWith("enqueue"),
  );
  const parentName = parent?.identity.name ?? "";
  return {
    onParent: effectsOf(parent).filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.binding?.recognition === "@suss/declared-test",
    ),
    claims: summaries
      .filter(
        (summary) =>
          summary.kind === "handler" &&
          summary.identity.name.startsWith(`${parentName}.`),
      )
      .map((summary) => {
        const { owner, ...jobs } = (summary.metadata?.jobs ?? {}) as {
          owner?: unknown;
        };
        return [
          summary.identity.name.slice(parentName.length),
          { ...jobs, ownerIsParent: owner === parentName },
        ];
      }),
  };
}

/** The claims every language makes, with the spread in the first list as each one writes it. */
function expectedClaims(spread: string) {
  const metadata = (index: number, tags: string[] | null) => ({
    kind: "queued",
    index,
    tags,
    ownerIsParent: true,
  });
  return {
    onParent: [],
    claims: [
      [".job#0", metadata(0, ['"orders"', spread])],
      [".job#1", metadata(1, ["tags"])],
      [".job#2", metadata(2, null)],
    ],
  };
}

describe("a callbacks declaration that only claims", () => {
  it("records nothing on the parent, numbers its claims in the parent and reads the metadata the link declares, in TypeScript, Python and Ruby", async () => {
    expect(
      claimsOf(await typescriptSummaries(CLAIMING, QUEUED_TYPESCRIPT)),
    ).toEqual(expectedClaims("...tags"));
    expect(claimsOf(await pythonSummaries(CLAIMING, "queue"))).toEqual(
      expectedClaims("*tags"),
    );
    expect(claimsOf(await rubySummaries(CLAIMING, "queue"))).toEqual(
      expectedClaims("*tags"),
    );
  });
});

const CLICKS = renderedProps({ matching: "^on[A-Z]" })
  .unitWhenInPlace({
    kind: "handler",
    name: ["parent", "callee", "prop", "countOnCollision"],
  })
  .example("<button onClick={() => notify()}>go</button>");

const CLICKING = pack("declared-clicks", [CLICKS], {
  languages: ["typescript", "python", "ruby"],
  recognizedAs: "@suss/declared-test",
});

// The TypeScript adapter runs a pack in a file only when the pack has
// something to find there, so the chain rides on the export pattern.
const CLICKING_TS: PatternPack = { ...CLICKING, discovery: EXPORTS.discovery };

// Only TypeScript writes JSX, so the Python and Ruby adapters list no
// elements and the same declaration claims nothing there.
describe("a chain over the elements a parent renders", () => {
  it("claims the handler an element is handed in TypeScript, and nothing in Python or Ruby", async () => {
    const handlers = (summaries: readonly BehavioralSummary[]) =>
      summaries
        .filter((summary) => summary.identity.name.includes(".onClick"))
        .map((summary) => summary.identity.name);

    expect(
      handlers(
        await typescriptSummaries(
          CLICKING_TS,
          "export function enqueue() {\n  return <button onClick={() => notify()}>go</button>;\n}\n",
          "/jobs.tsx",
        ),
      ),
    ).toEqual(["enqueue.button.onClick"]);
    expect(handlers(await pythonSummaries(CLICKING))).toEqual([]);
    expect(handlers(await rubySummaries(CLICKING))).toEqual([]);
  });
});
