import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadIntentDoc } from "@suss/contract-intent";
import { parseChangeList } from "@suss/intent-ir";

import {
  CREATE_BEFORE,
  CREATE_WITH_409,
  cancelRoute,
  touches,
} from "./__fixtures__/orderRoutes.js";
import { changeTransitions } from "./intentKeep.js";
import { runCli } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A folder with the summaries before and after, and the change list. */
function project(
  before: BehavioralSummary[],
  after: BehavioralSummary[],
  changes: string,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-intent-"));
  created.push(dir);
  for (const [side, summaries] of [
    ["before", before],
    ["after", after],
  ] as const) {
    fs.mkdirSync(path.join(dir, side));
    fs.writeFileSync(
      path.join(dir, side, "0-extract.json"),
      JSON.stringify(summaries),
    );
  }
  fs.writeFileSync(path.join(dir, "changes.yaml"), changes);
  return dir;
}

async function capture(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function checkArgs(dir: string, ...more: string[]): string[] {
  return [
    "intent",
    "check",
    path.join(dir, "changes.yaml"),
    "--before",
    path.join(dir, "before"),
    "--after",
    path.join(dir, "after"),
    ...more,
  ];
}

const CANCEL_LIST = [
  'asked: "Add POST /orders/:id/cancel ... 404 when the order does not exist."',
  "changes:",
  "  - adds: POST /orders/:id/cancel",
  "    outcomes: [200, 404]",
  "  - adds: { writes: postgresql:orders, fields: [cancelled_at] }",
  "    at: POST /orders/:id/cancel",
  "  - changes: Order.status",
  '    note: gains the value "cancelled"',
].join("\n");

const WRITES_CANCELLED = touches("write", "orders", ["cancelled_at"]);

describe("suss intent check", () => {
  it("exits 0 and prints the verdicts when every entry is done and nothing else changed", async () => {
    const dir = project(
      [CREATE_BEFORE],
      [CREATE_BEFORE, cancelRoute([WRITES_CANCELLED])],
      CANCEL_LIST,
    );

    const run = await capture(checkArgs(dir));

    expect(run.exit).toBe(0);
    expect(run.stdout).toBe(
      [
        "2 done and 1 unchecked.",
        "",
        "done        + POST /orders/{id}/cancel responds 200, 404  src/cancel.ts::cancel",
        "            + POST /orders/{id}/cancel writes postgresql:orders [cancelled_at]  src/cancel.ts::cancel",
        'unchecked   ~ Order.status gains the value "cancelled"',
        "              suss has no boundary spelled Order.status, so it cannot check this entry.",
        "",
      ].join("\n"),
    );
  });

  it("exits 1 when a boundary changed where nobody asked, and lists it", async () => {
    const dir = project(
      [CREATE_BEFORE],
      [CREATE_WITH_409, cancelRoute([WRITES_CANCELLED])],
      CANCEL_LIST,
    );

    const run = await capture(checkArgs(dir));

    expect(run.exit).toBe(1);
    expect(run.stdout).toContain(
      "2 done, 1 unchecked and 1 boundary changed where nobody asked.",
    );
    expect(run.stdout).toContain(
      "not asked   serves POST /orders  src/create.ts::create\n              + responds 409  when  open\n",
    );
  });

  it("exits 1 when an entry is not done, and says why", async () => {
    const dir = project([CREATE_BEFORE], [CREATE_BEFORE], CANCEL_LIST);

    const run = await capture(checkArgs(dir));

    expect(run.exit).toBe(1);
    expect(run.stdout).toContain(
      "not done    + POST /orders/:id/cancel responds 200, 404\n              the diff does not show POST /orders/:id/cancel added or changed.",
    );
  });

  it("marks an entry no message asked for, from the messages the plugin records", async () => {
    const dir = project(
      [CREATE_BEFORE],
      [CREATE_BEFORE, cancelRoute([WRITES_CANCELLED])],
      CANCEL_LIST,
    );
    fs.writeFileSync(
      path.join(dir, "prompts.jsonl"),
      `${JSON.stringify({ prompt: "Add an archive endpoint." })}\n`,
    );

    const run = await capture(
      checkArgs(dir, "--prompts", path.join(dir, "prompts.jsonl"), "--json"),
    );

    const json = JSON.parse(run.stdout);
    expect(
      json.entries.map((entry: { requested: boolean }) => entry.requested),
    ).toEqual([false, false, false]);
    expect(json.text).toContain(
      'unrequested + POST /orders/{id}/cancel responds 200, 404  src/cancel.ts::cancel\n              Done. No message the developer sent contains "Add POST /orders/:id/cancel ... 404 when the order does not exist."',
    );
  });

  it("takes a file of plain text as one message", async () => {
    const dir = project([], [cancelRoute()], CANCEL_LIST);
    fs.writeFileSync(
      path.join(dir, "request.txt"),
      "Add POST /orders/:id/cancel.\nReturn 404 when the order does not exist.",
    );

    const run = await capture(
      checkArgs(dir, "--prompts", path.join(dir, "request.txt"), "--json"),
    );

    expect(JSON.parse(run.stdout).entries[0].requested).toBe(true);
  });

  it("writes the verdicts as JSON with the printed report beside them", async () => {
    const dir = project([], [cancelRoute([WRITES_CANCELLED])], CANCEL_LIST);

    const run = await capture(checkArgs(dir, "--json"));

    const json = JSON.parse(run.stdout);
    expect(Object.keys(json)).toEqual([
      "version",
      "entries",
      "notAsked",
      "explained",
      "fromWrappers",
      "text",
    ]);
    expect(json.text.split("\n")[0]).toBe("2 done and 1 unchecked.");
  });

  it("refuses a change list that does not fit its schema and says what is wrong", async () => {
    const dir = project(
      [],
      [],
      "changes:\n  - adds: POST /x\n    removes: POST /y\n",
    );

    const run = await capture(checkArgs(dir, "--json"));

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "changes.0: an entry has exactly one of adds, removes or changes",
    );
    expect(JSON.parse(run.stdout).error).toContain("does not fit its schema");
  });

  it("refuses a folder on one side and a file on the other", async () => {
    const dir = project([], [], CANCEL_LIST);

    const run = await capture([
      "intent",
      "check",
      path.join(dir, "changes.yaml"),
      "--before",
      path.join(dir, "before"),
      "--after",
      path.join(dir, "after", "0-extract.json"),
    ]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "--before and --after are two folders of summaries or two files",
    );
  });

  it("refuses two folders with no summaries file in common", async () => {
    const dir = project([], [], CANCEL_LIST);
    fs.renameSync(
      path.join(dir, "after", "0-extract.json"),
      path.join(dir, "after", "1-extract.json"),
    );

    const run = await capture(checkArgs(dir));

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("have no summaries file in common");
  });

  it("says what it needs when the change list or a side is missing", async () => {
    const run = await capture(["intent", "check", "changes.yaml"]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "intent check needs the change list and the summaries on both sides.",
    );
  });
});

describe("suss intent keep", () => {
  function changes(yaml: string) {
    const parsed = parseChangeList(YAML.parse(yaml));
    return parsed.ok ? parsed.list.changes : fail();
  }

  it("compiles each adds or changes entry into transitions of a kind: boundary document", () => {
    const [route, write, changed] = changes(
      [
        'asked: "Add a cancel endpoint."',
        "changes:",
        "  - adds: POST /orders/:id/cancel",
        "    outcomes: [200, 404, throws, { throws: NotFoundError }, returns]",
        "  - adds: { writes: postgresql:orders, fields: [cancelled_at], by: id }",
        "    at: POST /orders/:id/cancel",
        "  - changes: POST /orders",
        "    outcomes: [409]",
      ].join("\n"),
    );

    const transitions = [route, write, changed].map((entry) =>
      changeTransitions(entry ?? fail()),
    );
    const doc = loadIntentDoc({
      kind: "boundary",
      name: "compiled",
      purpose: "Add a cancel endpoint.",
      audience: "the web client",
      boundary: {
        semantics: "rest",
        method: "POST",
        path: "/orders/:id/cancel",
      },
      transitions: transitions.flat(),
    });

    expect(transitions.map((compiled) => compiled.length)).toEqual([5, 1, 1]);
    expect(doc.kind === "boundary" ? doc.outcomes : []).toEqual([
      expect.objectContaining({ id: "200-ok", kind: "response", status: 200 }),
      expect.objectContaining({ id: "404-not-found", status: 404 }),
      expect.objectContaining({ id: "throws", kind: "throw", errorType: null }),
      expect.objectContaining({
        id: "throws-not-found-error",
        errorType: "NotFoundError",
      }),
      expect.objectContaining({ id: "returns", kind: "return" }),
      expect.objectContaining({
        id: "writes-postgresql-orders",
        kind: "effect",
        effects: [
          {
            does: "writes",
            names: "postgresql:orders",
            fields: ["cancelled_at"],
            by: ["id"],
          },
        ],
      }),
      expect.objectContaining({ id: "409-conflict", status: 409 }),
    ]);
  });

  it("compiles a removes entry into nothing, since a document states what a boundary does", () => {
    const [removed] = changes("changes:\n  - removes: GET /orders/:id");

    expect(changeTransitions(removed ?? fail())).toEqual([]);
  });

  it("writes a document per boundary, with each when from the code as it is now", async () => {
    const dir = project([], [cancelRoute([WRITES_CANCELLED])], CANCEL_LIST);
    const into = path.join(dir, "intent");

    const run = await capture([
      "intent",
      "keep",
      path.join(dir, "changes.yaml"),
      "--dir",
      path.join(dir, "after"),
      "--audience",
      "the web client",
      "--into",
      into,
    ]);

    expect(run.exit).toBe(0);
    const file = path.join(into, "post-orders-id-cancel.intent.yaml");
    expect(run.stdout).toContain(`Kept 1 intent document:\n  ${file}`);
    const doc = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(doc).toMatchObject({
      kind: "boundary",
      purpose:
        "Add POST /orders/:id/cancel ... 404 when the order does not exist.",
      audience: "the web client",
      source: "author",
      boundary: { method: "POST", path: "/orders/:id/cancel" },
    });
    expect(
      doc.transitions.map((t: { id: string; when: unknown }) => [t.id, t.when]),
    ).toEqual([
      ["200-ok", "otherwise"],
      ["404-not-found", "!found"],
      ["writes-postgresql-orders", "otherwise"],
    ]);
    expect(() => loadIntentDoc(doc)).not.toThrow();
  });

  it("leaves out a boundary nothing serves, and one whose entries quote no request", async () => {
    const dir = project(
      [],
      [CREATE_WITH_409],
      [
        "changes:",
        "  - adds: POST /refunds",
        "    outcomes: [201]",
        "  - changes: POST /orders",
        "    outcomes: [409]",
        "  - adds: { writes: postgresql:audit_log }",
      ].join("\n"),
    );

    const run = await capture([
      "intent",
      "keep",
      path.join(dir, "changes.yaml"),
      "--dir",
      path.join(dir, "after", "0-extract.json"),
      "--audience",
      "the web client",
      "--into",
      path.join(dir, "intent"),
    ]);

    expect(run.exit).toBe(1);
    expect(run.stdout).toContain(
      "POST /refunds: nothing in these summaries serves it",
    );
    expect(run.stdout).toContain(
      "POST /orders: no entry about it quotes the request",
    );
    expect(run.stdout).toContain(
      "writes postgresql:audit_log: it gives no at, so no one boundary's document can take it.",
    );
  });

  it("leaves a document that is already there alone", async () => {
    const dir = project([], [cancelRoute([WRITES_CANCELLED])], CANCEL_LIST);
    const into = path.join(dir, "intent");
    const file = path.join(into, "post-orders-id-cancel.intent.yaml");
    fs.mkdirSync(into);
    fs.writeFileSync(file, "kept by hand\n");

    const run = await capture([
      "intent",
      "keep",
      path.join(dir, "changes.yaml"),
      "--dir",
      path.join(dir, "after"),
      "--audience",
      "the web client",
      "--into",
      into,
    ]);

    expect(run.exit).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("kept by hand\n");
    expect(run.stdout).toContain("already exists, so merge the two by hand.");
  });

  it("says what it needs when the audience is missing", async () => {
    const run = await capture(["intent", "keep", "changes.yaml", "--dir", "."]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("who calls the boundaries");
  });
});

function fail(): never {
  throw new Error("the test's change list does not parse or is too short");
}
