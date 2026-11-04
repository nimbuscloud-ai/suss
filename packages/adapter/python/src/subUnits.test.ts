import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { callbacks, constructedFrom, pack } from "@suss/recognize";

// A run from source declines to cache, and the cached run here has to
// write an entry to disk and read it back.
vi.mock("./version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./version.js")>();
  return {
    ...actual,
    adapterStamp: {
      ...actual.adapterStamp,
      declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
    },
  };
});

import { extractPythonProject } from "./project.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { CacheDiagnostic, DiscoveredSubUnit } from "@suss/extractor";
import type { PythonPack } from "./pack.js";

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

const LATER_PACK: PythonPack = {
  name: "declared",
  protocol: "in-process",
  discovery: [],
  invocationRecognizers: DECLARED.invocationRecognizers ?? [],
  accessRecognizers: DECLARED.accessRecognizers ?? [],
  ...(DECLARED.subUnits === undefined ? {} : { subUnits: DECLARED.subUnits }),
};

const HEADER = ["from jobs import Jobs", "", "jobs = Jobs()", "", ""];

function sourceOf(...lines: string[]): string {
  return [...HEADER, ...lines, ""].join("\n");
}

const IN_PLACE = sourceOf("def enqueue():", "    jobs.later(lambda: notify())");

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-sub-units-")),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Project {
  readonly dir: string;
  /** Each package's `__init__.py`, the `store` package's first. */
  readonly files: readonly string[];
  readonly packages: readonly string[];
}

/** A project whose `store` package is `source`, with more packages beside it, each one a declared module. */
function projectOf(
  source: string,
  more: Readonly<Record<string, string>> = {},
): Project {
  const dir = fs.mkdtempSync(path.join(root, "case-"));
  const packages = Object.entries({ store: source, ...more });
  const files = packages.map(([name, text]) => {
    fs.mkdirSync(path.join(dir, name));
    const file = path.join(dir, `${name}/__init__.py`);
    fs.writeFileSync(file, text);
    return file;
  });
  return { dir, files, packages: packages.map(([name]) => name) };
}

async function extracted(
  project: Project,
  options: {
    packs?: PythonPack[];
    cacheDir?: string | null;
    onCacheDiagnostic?: (diagnostic: CacheDiagnostic) => void;
  } = {},
): Promise<BehavioralSummary[]> {
  const { dir, files } = project;
  const { summaries } = await extractPythonProject({
    files: [...files],
    roots: [dir],
    packs: options.packs ?? [LATER_PACK],
    modules: project.packages.map((name) => ({
      name,
      root: path.join(dir, name),
    })),
    workspaceRoot: dir,
    cacheDir: options.cacheDir ?? null,
    ...(options.onCacheDiagnostic === undefined
      ? {}
      : { onCacheDiagnostic: options.onCacheDiagnostic }),
  });
  return summaries;
}

async function summariesOf(
  source: string,
  packs?: PythonPack[],
): Promise<BehavioralSummary[]> {
  return extracted(projectOf(source), packs === undefined ? {} : { packs });
}

function named(
  summaries: readonly BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.find((summary) => summary.identity.name === name);
  if (found === undefined) {
    throw new Error(
      `no summary named ${name} among ${summaries.map((one) => one.identity.name).join(", ")}`,
    );
  }
  return found;
}

function effectsOf(summary: BehavioralSummary): Effect[] {
  return summary.transitions.flatMap((transition) => transition.effects);
}

function calleesOf(summary: BehavioralSummary): string[] {
  return effectsOf(summary).flatMap((effect) =>
    effect.type === "invocation" ? [effect.callee] : [],
  );
}

function schedulesOf(summary: BehavioralSummary): Effect[] {
  return effectsOf(summary).filter(
    (effect) =>
      effect.type === "interaction" && effect.interaction.class === "schedule",
  );
}

describe("a lambda a declared pack claims", () => {
  it("records the schedule on the parent and gives the lambda a summary of its own", async () => {
    const summaries = await summariesOf(IN_PLACE);
    const parent = named(summaries, "enqueue");
    const claimed = named(summaries, `${parent.identity.name}.jobs.later#0`);

    expect(schedulesOf(parent)).toEqual([
      expect.objectContaining({
        callee: "jobs.later",
        interaction: {
          class: "schedule",
          via: "jobs.later",
          callbackRef: { type: "literal" },
          hasDelay: false,
        },
      }),
    ]);
    expect(claimed.kind).toBe("scheduled-callback");
    expect(claimed.inputs).toEqual([]);
    expect(claimed.transitions.map((one) => one.output.type)).toEqual([
      "return",
    ]);
    expect(calleesOf(claimed)).toEqual(["notify"]);
    expect(calleesOf(parent)).toEqual(["jobs.later"]);
  });

  it("takes the binding of a parent that serves", async () => {
    const summaries = await summariesOf(IN_PLACE);
    const parent = named(summaries, "enqueue");
    const claimed = named(summaries, "enqueue.jobs.later#0");

    expect(claimed.identity.boundaryBinding).toEqual(
      parent.identity.boundaryBinding,
    );
  });

  it("is internal code under a parent that calls out", async () => {
    const caller: PythonPack = {
      ...LATER_PACK,
      clients: [
        {
          type: "clientCall",
          importModule: ["httpclient"],
          verbAttributeNames: { get: "GET" },
          url: { position: 0, keyword: "url" },
        },
      ],
    };
    const {
      dir,
      files: [file = ""],
    } = projectOf(
      [
        "import httpclient",
        ...HEADER,
        "def fetch_orders():",
        '    httpclient.get("/orders")',
        "    jobs.later(lambda: notify())",
        "",
      ].join("\n"),
    );
    const { summaries } = await extractPythonProject({
      files: [file],
      roots: [dir],
      packs: [caller],
      workspaceRoot: dir,
      cacheDir: null,
    });

    expect(named(summaries, "fetch_orders").kind).toBe("client");
    expect(
      named(summaries, "fetch_orders.jobs.later#0").identity.boundaryBinding,
    ).toEqual(
      expect.objectContaining({
        semantics: { name: "function-call" },
        recognition: "reachable",
      }),
    );
  });

  it("records a function passed by name and makes no summary for it", async () => {
    const summaries = await summariesOf(
      sourceOf("def enqueue():", "    jobs.later(notify)"),
    );
    const parent = named(summaries, "enqueue");

    expect(schedulesOf(parent)).toEqual([
      expect.objectContaining({
        interaction: expect.objectContaining({
          callbackRef: { type: "identifier", name: "notify" },
        }),
      }),
    ]);
    expect(
      summaries.filter((one) => one.kind === "scheduled-callback"),
    ).toEqual([]);
  });

  it("gives a claim written inside another claim to the outer parent", async () => {
    const summaries = await summariesOf(
      sourceOf(
        "def enqueue():",
        "    jobs.later(lambda: jobs.later(lambda: notify()))",
      ),
    );
    const parent = named(summaries, "enqueue");
    const outer = named(summaries, "enqueue.jobs.later#0");
    const inner = named(summaries, "enqueue.jobs.later#1");

    expect(calleesOf(parent)).toEqual(["jobs.later"]);
    expect(schedulesOf(parent)).toHaveLength(1);
    expect(calleesOf(outer)).toEqual(["jobs.later"]);
    expect(schedulesOf(outer)).toHaveLength(1);
    expect(calleesOf(inner)).toEqual(["notify"]);
  });

  it("claims in a function the call walk reached", async () => {
    const summaries = await summariesOf(
      sourceOf(
        "def _schedule():",
        "    jobs.later(lambda: notify())",
        "",
        "",
        "def enqueue():",
        "    _schedule()",
      ),
    );
    const reached = named(summaries, "_schedule");
    const claimed = named(summaries, "_schedule.jobs.later#0");

    expect(reached.identity.boundaryBinding?.recognition).toBe("reachable");
    expect(calleesOf(reached)).toEqual(["jobs.later"]);
    expect(calleesOf(claimed)).toEqual(["notify"]);
  });

  it("leaves the lambda in its parent when no pack claims it", async () => {
    const { subUnits: _subUnits, ...withoutHook } = LATER_PACK;
    const summaries = await summariesOf(IN_PLACE, [withoutHook]);

    expect(calleesOf(named(summaries, "enqueue"))).toEqual([
      "notify",
      "jobs.later",
    ]);
    expect(
      summaries.filter((one) => one.kind === "scheduled-callback"),
    ).toEqual([]);
  });

  it("keeps the first claim of a lambda two hooks claim, with what its hook adds", async () => {
    const tagged: PythonPack = {
      name: "tagged",
      protocol: "in-process",
      discovery: [],
      subUnits: (parent, ctx) =>
        (DECLARED.subUnits?.(parent, ctx) ?? []).map(
          (one): DiscoveredSubUnit => ({
            ...one,
            name: `${one.name}.tagged`,
            metadata: { tagged: true },
          }),
        ),
    };
    const summaries = await summariesOf(IN_PLACE, [tagged, LATER_PACK]);
    const claimed = summaries.filter(
      (one) => one.kind === "scheduled-callback",
    );

    expect(claimed.map((one) => one.identity.name)).toEqual([
      "enqueue.jobs.later#0.tagged",
    ]);
    expect(claimed[0]?.metadata).toEqual(
      expect.objectContaining({ tagged: true }),
    );
  });
});

describe("a cached run with a pack that claims lambdas", () => {
  it("gives what a run without the cache gives, before and after an edit to another file", async () => {
    const project = projectOf(IN_PLACE, {
      other: sourceOf("def remind():", "    ping()"),
    });
    const cacheDir = path.join(project.dir, ".suss-cache");
    const diagnostics: CacheDiagnostic[] = [];
    const cached = async () =>
      JSON.stringify(
        await extracted(project, {
          cacheDir,
          onCacheDiagnostic: (one) => diagnostics.push(one),
        }),
      );
    const cold = async () => JSON.stringify(await extracted(project));

    expect(await cached()).toBe(await cold());
    expect(await cached()).toBe(await cold());
    fs.writeFileSync(
      project.files[1] ?? "",
      sourceOf("def remind():", "    jobs.later(lambda: ping())"),
    );
    const edited = await cached();

    expect(edited).toBe(await cold());
    expect(edited).toContain("enqueue.jobs.later#0");
    expect(edited).toContain("remind.jobs.later#0");
    expect(diagnostics.map((one) => one.kind)).toEqual(["miss", "hit", "miss"]);
    expect(diagnostics[2]?.missReason).toBe("files-changed");
  });
});
