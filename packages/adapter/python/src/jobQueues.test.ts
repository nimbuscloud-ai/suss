import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "./project.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-jobs-"));

function write(rel: string, lines: string[]): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join("\n"));
}

/** Inline rather than the shipped Celery pack, which depends on this package. */
const jobsPack: PythonPack = {
  name: "jobs-inline-test-pack",
  protocol: "celery",
  discovery: [],
  jobQueues: [
    {
      messageBus: "celery",
      module: "celery",
      taskDecorators: ["task", "shared_task"],
      nameKeyword: "name",
      queueKeyword: "queue",
      defaultName: "modulePath",
      enqueueMethods: [
        { method: "delay", arguments: { type: "spread" } },
        {
          method: "apply_async",
          arguments: {
            type: "packed",
            args: { argument: 0, keyword: "args" },
            kwargs: { argument: 1, keyword: "kwargs" },
          },
        },
      ],
      sendByName: [
        {
          method: "send_task",
          name: { argument: 0, keyword: "name" },
          arguments: {
            type: "packed",
            args: { argument: 1, keyword: "args" },
            kwargs: { argument: 2, keyword: "kwargs" },
          },
        },
      ],
      apps: ["Celery", "current_app"],
    },
  ],
};

let summaries: BehavioralSummary[] = [];

beforeAll(async () => {
  write("proj/__init__.py", [""]);
  write("proj/worker.py", [
    "from celery import Celery",
    "",
    'app = Celery("proj")',
    "",
    'twice = Celery("first")',
    'twice = Celery("second")',
    "",
  ]);
  write("proj/tasks.py", [
    "import functools",
    "from celery import shared_task",
    "from proj.worker import app, twice",
    "",
    "def plain(x):",
    "    return x",
    "",
    "@shared_task",
    "def cleanup():",
    "    return None",
    "",
    "@functools.lru_cache",
    "def cached():",
    "    return 1",
    "",
    "@functools.total_ordering",
    "class Ordered:",
    "    pass",
    "",
    "@mystery",
    '@twice.task(name="twice.job")',
    "def twice_job():",
    "    return None",
    "",
    '@app.task(name="reports.send", queue="mail", bind=True)',
    "def send_report(self, report_id, force=False):",
    "    return report_id",
    "",
    "@app.task()",
    "def refresh(dashboard_id):",
    "    return dashboard_id",
    "",
    "@app.task(name=make_name())",
    "def dynamic():",
    "    return None",
    "",
  ]);
  write("proj/mailer.py", [
    "class Mailer:",
    "    def send_task(self, name):",
    "        return name",
    "",
  ]);
  write("proj/odd.py", [
    "from proj.mailer import Mailer",
    "from proj.tasks import dynamic, refresh",
    "from proj.worker import twice",
    "",
    "mailer = Mailer()",
    "",
    "def odd_calls(rows, opts):",
    "    refresh.delay(*rows)",
    '    refresh.apply_async([*rows], {1: "x"})',
    "    refresh.apply_async(rows, opts)",
    '    mailer.send_task("not.celery")',
    "    dynamic.delay()",
    '    twice.send_task("twice.by_name")',
    "",
  ]);
  write("proj/jobs.py", [
    "from multiprocessing import Pool",
    "from celery import current_app",
    "from proj.odd import odd_calls",
    "from proj.tasks import cleanup, plain, refresh, send_report",
    "from proj.worker import app",
    "",
    "pool = Pool()",
    "",
    "def enqueue_all(task):",
    "    send_report.delay(7, force=True)",
    '    refresh.apply_async((3,), {"full": True}, countdown=5)',
    "    refresh.apply_async(args=[4])",
    "    cleanup.delay()",
    '    app.send_task("reports.prune", args=[1])',
    '    current_app.send_task("by.current", kwargs={"days": 3})',
    "    task.delay(1)",
    "    plain.delay(2)",
    "    pool.apply_async(plain, (1,))",
    "",
    "@app.task",
    "def kickoff():",
    "    enqueue_all(cleanup)",
    "    odd_calls([], {})",
    "",
  ]);
  const result = await extractPythonProject({
    files: findPythonFiles(root),
    packs: [jobsPack],
    workspaceRoot: root,
    roots: [root],
  });
  summaries = result.summaries;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function named(name: string): BehavioralSummary {
  const found = summaries.find((summary) => summary.identity.name === name);
  if (found === undefined) {
    throw new Error(`no summary named ${name}`);
  }
  return found;
}

function sends(summary: BehavioralSummary): Effect[] {
  return summary.transitions
    .flatMap((transition) => transition.effects)
    .filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "message-send",
    );
}

function channelsSent(summary: BehavioralSummary): (string | null)[] {
  return sends(summary).map((effect) =>
    effect.type === "interaction" &&
    effect.binding.semantics.name === "message-bus"
      ? effect.binding.semantics.channel
      : "not a bus",
  );
}

describe("a task function", () => {
  it("is a consumer on the name and queue its decorator gives", () => {
    const task = named("send_report");
    expect(task.kind).toBe("consumer");
    expect(task.identity.boundaryBinding).toMatchObject({
      recognition: "jobs-inline-test-pack",
      semantics: {
        name: "message-bus",
        messageBus: "celery",
        channel: "mail#reports.send",
      },
    });
  });

  it("is named after its module and function when the decorator gives no name", () => {
    expect(named("refresh").identity.boundaryBinding?.semantics).toMatchObject({
      channel: "proj.tasks.refresh",
    });
    expect(named("cleanup").identity.boundaryBinding?.semantics).toMatchObject({
      channel: "proj.tasks.cleanup",
    });
    expect(named("kickoff").kind).toBe("consumer");
  });

  it("leaves a function with no task decorator alone", () => {
    expect(summaries.find((s) => s.identity.name === "plain")?.kind).not.toBe(
      "consumer",
    );
  });
});

describe("an enqueue", () => {
  it("is a send to the task's name, on the unit that makes it", () => {
    expect(channelsSent(named("enqueue_all"))).toEqual([
      "reports.send",
      "proj.tasks.refresh",
      "proj.tasks.refresh",
      "proj.tasks.cleanup",
      "reports.prune",
      "by.current",
      null,
    ]);
  });

  it("records what the task is handed", () => {
    const bodies = sends(named("enqueue_all")).map((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "message-send"
        ? effect.interaction.body
        : undefined,
    );
    expect(bodies.slice(0, 6)).toEqual([
      {
        kind: "array",
        items: [
          { kind: "array", items: [{ kind: "number", value: 7 }] },
          {
            kind: "object",
            fields: { force: { kind: "boolean", value: true } },
          },
        ],
      },
      {
        kind: "array",
        items: [
          { kind: "array", items: [{ kind: "number", value: 3 }] },
          {
            kind: "object",
            fields: { full: { kind: "boolean", value: true } },
          },
        ],
      },
      { kind: "array", items: [{ kind: "number", value: 4 }] },
      { kind: "array", items: [] },
      { kind: "array", items: [{ kind: "number", value: 1 }] },
      { kind: "object", fields: { days: { kind: "number", value: 3 } } },
    ]);
  });

  it("whose task does not settle leaves one gap and no other stop", () => {
    const gaps = named("enqueue_all").gaps.filter(
      (gap) => gap.type === "unfollowedCall",
    );
    expect(gaps.map((gap) => gap.callee)).toEqual(["task.delay"]);
    expect(gaps[0]?.description).toContain("could not settle which job");
  });

  it("reads arguments it cannot list as the value written, and none behind a star", () => {
    const odd = named("odd_calls");
    const bodies = sends(odd).map((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "message-send"
        ? effect.interaction.body
        : "not a send",
    );
    expect(bodies).toEqual([
      undefined,
      {
        kind: "array",
        items: [
          { kind: "identifier", name: "[*rows]" },
          { kind: "identifier", name: '{1: "x"}' },
        ],
      },
      {
        kind: "array",
        items: [
          { kind: "identifier", name: "rows" },
          { kind: "identifier", name: "opts" },
        ],
      },
      { kind: "array", items: [] },
      { kind: "array", items: [] },
    ]);
  });

  it("leaves a send_task on something other than the app alone", () => {
    expect(channelsSent(named("odd_calls"))).toEqual([
      "proj.tasks.refresh",
      "proj.tasks.refresh",
      "proj.tasks.refresh",
      null,
      "twice.by_name",
    ]);
  });

  it("reads an app the module builds twice, since both builds are Celery's", () => {
    expect(
      named("twice_job").identity.boundaryBinding?.semantics,
    ).toMatchObject({ channel: "twice.job" });
    expect(summaries.find((s) => s.identity.name === "cached")?.kind).not.toBe(
      "consumer",
    );
  });

  it("of a task whose name does not settle has no channel on either side", () => {
    expect(named("dynamic").identity.boundaryBinding?.semantics).toMatchObject({
      channel: null,
    });
    expect(
      named("odd_calls").gaps.map((gap) =>
        gap.type === "unfollowedCall" ? gap.callee : gap.type,
      ),
    ).toContain("dynamic.delay");
  });

  it("is followed from the task that calls the function making it", () => {
    const kickoff = named("kickoff");
    expect(kickoff.transitions.flatMap((t) => t.effects)).toContainEqual(
      expect.objectContaining({ type: "invocation", callee: "enqueue_all" }),
    );
  });
});
