import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A run from source declines to cache, so the cache test would read
// nothing from it. This lets `cacheDir` through, as a built run does.
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

import { Database } from "@suss/datalog";
import { callbacks, constructedFrom, pack } from "@suss/recognize";

import { activeJobTestPack } from "./__fixtures__/jobPatterns.js";
import { railsTestPack } from "./__fixtures__/railsControllerPattern.js";
import { field } from "./ast.js";
import { claimedIn } from "./claims.js";
import { parseRuby } from "./parser.js";
import { extractRubyProject } from "./project.js";
import { rubySubUnitContext, startSubUnits } from "./subUnits.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { CacheDiagnostic, ExtractionReport } from "@suss/extractor";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";

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

/** The declared pack as Ruby loads it, with or without its `subUnits` hook. */
function laterPack(claims: boolean): RubyPack {
  return {
    name: DECLARED.name,
    protocol: DECLARED.protocol,
    discovery: [],
    invocationRecognizers: DECLARED.invocationRecognizers ?? [],
    ...(claims ? hookOnly() : {}),
  };
}

/** The same pack's hook, with none of its recognizers. */
function hookOnly(name = DECLARED.name): RubyPack {
  return {
    name,
    protocol: DECLARED.protocol,
    discovery: [],
    ...(DECLARED.subUnits === undefined ? {} : { subUnits: DECLARED.subUnits }),
  };
}

const STORE = `module Store
  def self.enqueue
    jobs = Jobs::Queue.new
    jobs.later { notify }
  end

  def self.with_lambda
    jobs = Jobs::Queue.new
    jobs.later(-> { notify })
  end

  def self.by_name(handler)
    jobs = Jobs::Queue.new
    jobs.later(handler)
    jobs.later(:handler)
  end

  def self.nested
    jobs = Jobs::Queue.new
    jobs.later do
      audit
      jobs.later { notify }
    end
  end

  def self.idle
    jobs = Jobs::Queue.new
    jobs.later { }
  end

  def self.indirect
    Later.run
  end
end
`;

// Not in the module's public file, so `run` is a unit only because the
// walk reaches it, and `deliver` only through the block `run` hands over.
const LATER_CLASS = `class Later
  def self.run
    jobs = Jobs::Queue.new
    jobs.later { deliver }
  end

  def self.deliver
    Mailer.send_now("receipt")
  end
end
`;

const REPORT_JOB = `class ReportJob < ApplicationJob
  def perform
    jobs = Jobs::Queue.new
    jobs.later { notify }
  end
end
`;

const ORDERS_CONTROLLER = `class OrdersController < ApplicationController
  def later
    jobs = Jobs::Queue.new
    jobs.later { notify }
    head :ok
  end
end
`;

/** What a claim is when it is internal code of the method it is written in. */
const REACHABLE = {
  transport: "in-process",
  semantics: { name: "function-call" },
  recognition: "reachable",
};

const FILES = ["lib/store.rb", "lib/store/later.rb"];

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-sub-units-")),
  );
  writeProject(root);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeProject(dir: string): void {
  fs.mkdirSync(path.join(dir, "lib/store"), { recursive: true });
  fs.mkdirSync(path.join(dir, "app/jobs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "app/controllers"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib/store.rb"), STORE);
  fs.writeFileSync(path.join(dir, "lib/store/later.rb"), LATER_CLASS);
  fs.writeFileSync(path.join(dir, "app/jobs/report_job.rb"), REPORT_JOB);
  fs.writeFileSync(
    path.join(dir, "app/controllers/orders_controller.rb"),
    ORDERS_CONTROLLER,
  );
}

interface RunOptions {
  readonly files?: readonly string[];
  readonly cacheDir?: string;
  readonly onCacheDiagnostic?: (diagnostic: CacheDiagnostic) => void;
}

async function summariesIn(
  dir: string,
  packs: RubyPack[],
  options: RunOptions = {},
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: (options.files ?? FILES).map((file) => path.join(dir, file)),
    packs,
    modules: [{ name: "store", root: path.join(dir, "lib/store") }],
    workspaceRoot: dir,
    cacheDir: options.cacheDir ?? null,
    ...(options.onCacheDiagnostic === undefined
      ? {}
      : { onCacheDiagnostic: options.onCacheDiagnostic }),
  });
  return summaries;
}

function named(
  summaries: readonly BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find((summary) => summary.identity.name === name);
}

function effectsOf(summary: BehavioralSummary | undefined): Effect[] {
  return (summary?.transitions ?? []).flatMap(
    (transition) => transition.effects,
  );
}

function invoked(summary: BehavioralSummary | undefined): string[] {
  return effectsOf(summary).flatMap((effect) =>
    effect.type === "invocation" ? [effect.callee] : [],
  );
}

function schedules(summary: BehavioralSummary | undefined): Effect[] {
  return effectsOf(summary).filter(
    (effect) =>
      effect.type === "interaction" && effect.interaction.class === "schedule",
  );
}

function scheduledCallbacks(summaries: readonly BehavioralSummary[]): string[] {
  return summaries
    .filter((summary) => summary.kind === "scheduled-callback")
    .map((summary) => summary.identity.name);
}

describe("a block a declared pack's call is written with, in Ruby", () => {
  it("becomes a unit of its own, and its calls leave the method", async () => {
    const summaries = await summariesIn(root, [laterPack(true)]);
    const parent = named(summaries, "Store.enqueue");
    const claimed = named(summaries, "Store.enqueue.jobs.later#0");

    expect(schedules(parent)).toEqual([
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
    expect(claimed?.kind).toBe("scheduled-callback");
    expect(claimed?.identity.boundaryBinding).toEqual(REACHABLE);
    expect(claimed?.location.range).toEqual({ start: 4, end: 4 });
    expect(invoked(claimed)).toEqual(["notify"]);
    expect(invoked(parent)).not.toContain("notify");
  });

  it("claims a lambda written as the argument", async () => {
    const summaries = await summariesIn(root, [laterPack(true)]);

    expect(invoked(named(summaries, "Store.with_lambda.jobs.later#0"))).toEqual(
      ["notify"],
    );
    expect(invoked(named(summaries, "Store.with_lambda"))).not.toContain(
      "notify",
    );
  });

  it("records a name or a symbol as the callback, and claims nothing", async () => {
    const summaries = await summariesIn(root, [laterPack(true)]);

    expect(
      schedules(named(summaries, "Store.by_name")).map((effect) =>
        effect.type === "interaction" && effect.interaction.class === "schedule"
          ? effect.interaction.callbackRef
          : null,
      ),
    ).toEqual([
      { type: "identifier", name: "handler" },
      { type: "identifier", name: ":handler" },
    ]);
    expect(
      summaries.filter((summary) =>
        summary.identity.name.startsWith("Store.by_name."),
      ),
    ).toEqual([]);
  });

  it("gives a block claimed inside another claimed block to the method", async () => {
    const summaries = await summariesIn(root, [laterPack(true)]);
    const outer = named(summaries, "Store.nested.jobs.later#0");
    const inner = named(summaries, "Store.nested.jobs.later#1");

    expect(invoked(outer)).toEqual(["audit"]);
    expect(schedules(outer)).toHaveLength(1);
    expect(invoked(inner)).toEqual(["notify"]);
    expect(invoked(named(summaries, "Store.nested"))).toEqual([]);
  });

  it("claims an empty block", async () => {
    const summaries = await summariesIn(root, [laterPack(true)]);
    const claimed = named(summaries, "Store.idle.jobs.later#0");

    expect(claimed?.kind).toBe("scheduled-callback");
    expect(invoked(claimed)).toEqual([]);
  });

  it("claims in a method the walk reaches, and walks on from the block", async () => {
    const summaries = await summariesIn(root, [laterPack(true)]);
    const claimed = named(summaries, "run.jobs.later#0");
    const call = effectsOf(claimed).find(
      (effect) => effect.type === "invocation" && effect.callee === "deliver",
    );

    expect(invoked(named(summaries, "run"))).toEqual([]);
    expect(call).toMatchObject({
      summary: "lib/store/later.rb::Later.deliver",
    });
    expect(invoked(named(summaries, "deliver"))).toEqual(["Mailer.send_now"]);
  });

  it("gives a block a job's method claims the binding of a call it reaches", async () => {
    const summaries = await summariesIn(
      root,
      [activeJobTestPack(), laterPack(true)],
      { files: ["app/jobs/report_job.rb"] },
    );
    const parent = summaries.find((summary) => summary.kind === "consumer");
    const claimed = named(summaries, `${parent?.identity.name}.jobs.later#0`);

    expect(claimed?.identity.boundaryBinding).toEqual(REACHABLE);
    expect(invoked(claimed)).toEqual(["notify"]);
  });

  it("gives a block in a controller action the binding of internal code, not the action's route", async () => {
    const summaries = await summariesIn(
      root,
      [
        railsTestPack({
          root: path.join(root, "app/controllers"),
          routesFor: (_controller, action) => [
            { method: "GET", path: `/orders/${action}` },
          ],
        }),
        laterPack(true),
      ],
      { files: ["app/controllers/orders_controller.rb"] },
    );
    const action = summaries.find((summary) => summary.kind === "handler");

    expect(action?.identity.boundaryBinding?.semantics).toMatchObject({
      name: "rest",
      method: "GET",
      path: "/orders/later",
    });
    expect(
      named(summaries, `${action?.identity.name}.jobs.later#0`)?.identity
        .boundaryBinding,
    ).toEqual(REACHABLE);
  });

  it("keeps one sub-unit when two packs claim the same block, with or without recognizers", async () => {
    const summaries = await summariesIn(root, [
      hookOnly("first"),
      hookOnly("second"),
    ]);

    expect(scheduledCallbacks(summaries)).toEqual([
      "Store.enqueue.jobs.later#0",
      "Store.with_lambda.jobs.later#0",
      "Store.nested.jobs.later#0",
      "Store.nested.jobs.later#1",
      "Store.idle.jobs.later#0",
      "run.jobs.later#0",
    ]);
    expect(schedules(named(summaries, "Store.enqueue"))).toEqual([]);
  });

  it("leaves the block on the method when no pack claims it", async () => {
    const summaries = await summariesIn(root, [laterPack(false)]);

    expect(invoked(named(summaries, "Store.enqueue"))).toEqual(["notify"]);
    expect(scheduledCallbacks(summaries)).toEqual([]);
  });

  it("gives the same summaries from the cache, after an edit too", async () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-sub-units-cache-")),
    );
    try {
      writeProject(dir);
      const cacheDir = path.join(dir, ".suss");
      const packs = [laterPack(true)];
      const kinds: string[] = [];
      const cached = {
        cacheDir,
        onCacheDiagnostic: (diagnostic: CacheDiagnostic): void => {
          kinds.push(diagnostic.kind);
        },
      };
      const uncached = await summariesIn(dir, packs);

      expect(await summariesIn(dir, packs, cached)).toEqual(uncached);
      expect(await summariesIn(dir, packs, cached)).toEqual(uncached);

      fs.appendFileSync(
        path.join(dir, "lib/store/later.rb"),
        "\nclass Later\n  def self.extra\n  end\nend\n",
      );
      const edited = await summariesIn(dir, packs);

      expect(await summariesIn(dir, packs, cached)).toEqual(edited);
      expect(named(edited, "run.jobs.later#0")).toBeDefined();
      expect(kinds).toEqual(["miss", "hit", "miss"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The declared callback beside a job queue and an HTTP client, written inline the way a pack writes them. */
function besideJobsAndRequests(): RubyPack[] {
  return [
    activeJobTestPack(),
    {
      ...laterPack(true),
      clients: [
        {
          constantName: "Http",
          verbMethodNames: { get: "GET" },
          url: { position: 0 },
        },
      ],
    },
  ];
}

const BUSY = `class SendJob < ApplicationJob
  def perform
  end
end

module Store
  def self.busy
    jobs = Jobs::Queue.new
    jobs.later do
      url = ENV["API_URL"]
      puts url
      SendJob.perform_later
      Http.get("https://h.example/orders")
      raise ArgumentError, "boom"
    end
  end

  def self.guarded(stale)
    jobs = Jobs::Queue.new
    jobs.later do
      raise "stale" if stale
      notify
    end
  end
end
`;

/** Each interaction a summary records, as its class and what it was called on. */
function interactions(summary: BehavioralSummary | undefined): string[] {
  return effectsOf(summary).flatMap((effect) =>
    effect.type === "interaction"
      ? [`${effect.interaction.class} ${effect.callee ?? ""}`]
      : [],
  );
}

describe("what a claimed block does besides calling", () => {
  let summaries: BehavioralSummary[] = [];

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(root, "busy-"));
    fs.mkdirSync(path.join(dir, "lib/store"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lib/store.rb"), BUSY);
    summaries = await summariesIn(dir, besideJobsAndRequests(), {
      files: ["lib/store.rb"],
    });
  });

  it("goes on the claim and not on the method", () => {
    expect(interactions(named(summaries, "Store.busy"))).toEqual([
      "schedule jobs.later",
    ]);
    expect(interactions(named(summaries, "Store.busy.jobs.later#0"))).toEqual([
      'config-read ENV["API_URL"]',
      "message-send SendJob.perform_later",
      "stream-write puts",
    ]);
  });

  it("ends the claim in a throw where the block raises", () => {
    const claimed = named(summaries, "Store.busy.jobs.later#0");

    expect(claimed?.transitions.map((one) => one.output)).toEqual([
      expect.objectContaining({
        type: "throw",
        exceptionType: "ArgumentError",
        message: "boom",
      }),
    ]);
    expect(named(summaries, "Store.busy")?.transitions).toEqual([
      expect.objectContaining({
        output: expect.objectContaining({ type: "return" }),
      }),
    ]);
  });

  it("reads a raise under a condition as one path of the claim's", () => {
    const claimed = named(summaries, "Store.guarded.jobs.later#0");

    expect(
      claimed?.transitions.map((one) => [
        one.output.type,
        one.conditions.length,
        invoked({ ...claimed, transitions: [one] }),
      ]),
    ).toEqual([
      ["throw", 1, []],
      ["return", 1, ["notify"]],
    ]);
  });

  it("makes the block the client of a request it makes, under the claim's name", () => {
    const clients = summaries.filter((summary) => summary.kind === "client");

    expect(
      clients.map((client) => [
        client.identity.name,
        client.identity.boundaryBinding?.semantics,
        client.location.range,
      ]),
    ).toEqual([
      [
        "busy.jobs.later#0",
        expect.objectContaining({
          name: "rest",
          method: "GET",
          path: "/orders",
        }),
        named(summaries, "Store.busy.jobs.later#0")?.location.range,
      ],
    ]);
  });
});

describe("a pack whose subUnits hook throws", () => {
  it("claims nothing, goes on the pack's tally, and the run goes on", async () => {
    const breaks: RubyPack = {
      name: "breaks",
      protocol: "in-process",
      discovery: [],
      subUnits: () => {
        throw new Error("cannot claim what I was handed");
      },
    };
    const reports: ExtractionReport[] = [];
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let summaries: BehavioralSummary[];
    try {
      ({ summaries } = await extractRubyProject({
        files: [path.join(root, "lib/store.rb")],
        packs: [breaks],
        modules: [{ name: "store", root: path.join(root, "lib/store") }],
        workspaceRoot: root,
        cacheDir: null,
        onExtractionReport: (report) => reports.push(report),
      }));
    } finally {
      noise.mockRestore();
    }
    const failures =
      reports[0]?.packs.find((funnel) => funnel.pack === "breaks")?.failures ??
      [];

    expect(invoked(named(summaries, "Store.enqueue"))).toEqual(["notify"]);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      new Set(failures.map((one) => `${one.hook} ${one.file} ${one.message}`)),
    ).toEqual(
      new Set([
        `subUnits ${path.join(root, "lib/store.rb")} cannot claim what I was handed`,
      ]),
    );
  });
});

describe("the sub-unit registry", () => {
  it("claims nothing in a file the run did not bind, or outside a method", async () => {
    const root = (await parseRuby(STORE)).rootNode as RbNode;
    const method = root.descendantsOfType("singleton_method")[0] as RbNode;
    const db = new Database();
    const registry = startSubUnits(db, [laterPack(true)], new Map());

    expect(registry?.claimsOf(method)).toBeNull();
    expect(claimedIn(method, db)).toBeUndefined();
    expect(claimedIn(field(method, "name") as RbNode, db)).toBeUndefined();
    expect(claimedIn(root, db)).toBeUndefined();
    expect(
      rubySubUnitContext(db).calls?.({
        func: method,
        name: "enqueue",
        kind: "library",
      }),
    ).toEqual([]);
  });

  it("is not started when no pack claims sub-units", () => {
    expect(
      startSubUnits(new Database(), [laterPack(false)], new Map()),
    ).toBeNull();
  });
});
