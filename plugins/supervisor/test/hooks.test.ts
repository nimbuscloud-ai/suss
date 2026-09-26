/**
 * Each hook fed the JSON Claude Code writes on its stdin, with what it
 * prints and its exit code checked. Most tests run a stand-in suss the
 * project installs, so they can make suss report whatever the case
 * needs; the last block runs the suss this repository builds.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runHook } from "../demo/orders409.mjs";
import { installFakeSuss, scriptFakeSuss } from "./fakeSuss.js";

import type { SinceFinding, SinceReport } from "../scripts/types.js";

const FIXTURE = path.resolve(__dirname, "../../../fixtures/supervisor-orders");
const SESSION = "hook-test";

let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "suss-hooks-"));
});

afterEach(() => {
  runHook(event("session-end", { reason: "other" }), project, {});
  fs.rmSync(project, { recursive: true, force: true });
});

function event(hook: string, extra: Record<string, unknown> = {}) {
  const names: Record<string, string> = {
    "session-start": "SessionStart",
    prompt: "UserPromptSubmit",
    "after-edit": "PostToolUse",
    stop: "Stop",
    "session-end": "SessionEnd",
  };
  return {
    hook,
    input: {
      session_id: SESSION,
      transcript_path: path.join(project, "transcript.jsonl"),
      cwd: project,
      hook_event_name: names[hook] ?? hook,
      ...extra,
    },
  };
}

function edited(file: string) {
  return event("after-edit", {
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(project, file),
      old_string: "a",
      new_string: "b",
    },
    tool_response: { filePath: path.join(project, file) },
    tool_use_id: "toolu_test",
  });
}

function sessionFile(name: string): string {
  return path.join(project, ".suss", "session", SESSION, name);
}

function sinceReport(findings: SinceFinding[]): SinceReport {
  return {
    since: "/before",
    findings,
    resolved: [],
    changedBoundaries: [
      { key: "POST /orders", units: ["src/orders/create.ts::post"] },
    ],
    run: [],
  };
}

function storeError(): SinceFinding {
  return {
    kind: "boundaryFieldUnknown",
    boundary: {
      transport: "postgresql",
      semantics: {
        name: "storage",
        storageSystem: "postgresql",
        scope: "default",
        container: "orders",
        accessPath: null,
      },
      recognition: "prisma",
    },
    provider: {
      summary: "prisma/schema.prisma::orders",
      location: {
        file: "prisma/schema.prisma",
        range: { start: 3, end: 9 },
        exportName: null,
      },
    },
    consumer: {
      summary: "src/orders/create.ts::post",
      transitionId: "post:response:201:1402b5d",
      location: {
        file: "src/orders/create.ts",
        range: { start: 10, end: 23 },
        exportName: "post",
      },
    },
    description:
      "writes orders.cancelled_at, which the orders table does not declare",
    severity: "error",
    identity: "cancelled-at-unknown",
    boundaryKey: "postgresql:orders",
    atChangedBoundary: false,
    rule: {
      kind: "boundaryFieldUnknown",
      boundary: "postgresql:orders",
      consumer: { transitionId: "post:response:201:1402b5d" },
    },
  };
}

async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the worker");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function processed(): number {
  try {
    return JSON.parse(fs.readFileSync(sessionFile("progress.json"), "utf8"))
      .processed;
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("with a stand-in suss the project installs", () => {
  it("takes the baseline at session start and prints nothing", () => {
    installFakeSuss(project, {});

    const start = runHook(
      event("session-start", { source: "startup" }),
      project,
      {},
    );

    expect(start.status).toBe(0);
    expect(start.stdout).toBe("");
    expect(
      fs.existsSync(
        path.join(
          project,
          ".suss",
          "session",
          SESSION,
          "state",
          "baseline.json",
        ),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(project, ".suss", "session", ".gitignore"),
        "utf8",
      ),
    ).toBe("*\n");
  });

  it("keeps each prompt in the session record and prints nothing", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});

    const prompt = runHook(
      event("prompt", { prompt: "Add a cancel endpoint." }),
      project,
      {},
    );

    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toBe("");
    const lines = fs
      .readFileSync(sessionFile("prompts.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(lines[0] ?? "{}").prompt).toBe("Add a cancel endpoint.");
  });

  it("blocks an edit that introduced an error, even at a boundary it did not change", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    scriptFakeSuss(project, { check: sinceReport([storeError()]) });

    const edit = runHook(edited("src/orders/create.ts"), project, {});

    expect(edit.status).toBe(0);
    expect(edit.output?.decision).toBe("block");
    expect(String(edit.output?.reason)).toContain(
      "[ERROR] boundaryFieldUnknown at postgresql:orders",
    );
    expect(String(edit.output?.reason)).toContain(
      'consumer: { transitionId: "post:response:201:1402b5d" }',
    );
  });

  it("says what an edit changed as context when nothing new needs acting on", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    scriptFakeSuss(project, { check: sinceReport([]) });

    const edit = runHook(edited("src/orders/create.ts"), project, {});

    expect(edit.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "suss: this edit changed POST /orders.",
      },
    });
  });

  it("delivers a result that missed its edit's budget with the next prompt, as context", async () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    scriptFakeSuss(project, {
      extractMs: 300,
      check: sinceReport([storeError()]),
    });

    const edit = runHook(edited("src/orders/create.ts"), project, {
      SUSS_SUPERVISOR_EDIT_MS: "0",
    });
    expect(edit.status).toBe(0);
    expect(edit.stdout).toBe("");

    await eventually(() => processed() >= 1);
    const prompt = runHook(
      event("prompt", { prompt: "Carry on." }),
      project,
      {},
    );

    expect(prompt.output?.decision).toBeUndefined();
    const context = (prompt.output?.hookSpecificOutput ?? {}) as Record<
      string,
      string
    >;
    expect(context.hookEventName).toBe("UserPromptSubmit");
    expect(context.additionalContext).toContain(
      "suss: an earlier edit changed POST /orders",
    );
    expect(context.additionalContext).toContain(
      "boundaryFieldUnknown at postgresql:orders",
    );
  });

  it("blocks a stop once on a new error, then lets the next stop through with the report", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    scriptFakeSuss(project, { check: sinceReport([storeError()]) });

    const first = runHook(
      event("stop", { stop_hook_active: false }),
      project,
      {},
    );
    const second = runHook(
      event("stop", { stop_hook_active: true }),
      project,
      {},
    );

    expect(first.status).toBe(0);
    expect(first.output?.decision).toBe("block");
    expect(String(first.output?.reason)).toContain(
      "suss: this turn introduced an error.",
    );
    expect(second.output?.decision).toBeUndefined();
    expect(String(second.output?.systemMessage)).toContain(
      "New findings since the session started:\n  [ERROR] boundaryFieldUnknown at postgresql:orders",
    );
  });

  it("switches the session off when suss cannot read the project, and says so once", () => {
    installFakeSuss(project, { extractFails: true });

    const start = runHook(event("session-start"), project, {});
    const edit = runHook(edited("src/orders/create.ts"), project, {});
    const stop = runHook(event("stop"), project, {});

    expect(String(start.output?.systemMessage)).toContain(
      "suss could not read this project, so it is not checking edits in this session.",
    );
    expect(String(start.output?.systemMessage)).toContain(
      "Nothing in this project matched a pack",
    );
    expect(edit.stdout).toBe("");
    expect(stop.stdout).toBe("");
  });

  it("stops a worker that is still reading when the session ends", async () => {
    installFakeSuss(project, { extractMs: 60_000 });
    runHook(event("session-start"), project, { SUSS_SUPERVISOR_START_MS: "0" });
    await eventually(() => fs.existsSync(sessionFile("worker.lock")));
    const worker = Number(fs.readFileSync(sessionFile("worker.lock"), "utf8"));
    expect(alive(worker)).toBe(true);

    const end = runHook(
      event("session-end", { reason: "prompt_input_exit" }),
      project,
      {},
    );

    expect(end.status).toBe(0);
    expect(end.stdout).toBe("");
    await eventually(() => !alive(worker));
    expect(fs.existsSync(sessionFile("state"))).toBe(false);
    expect(
      fs.existsSync(sessionFile("prompts.jsonl")) ||
        fs.existsSync(sessionFile("ended")),
    ).toBe(true);
  });

  it("prints nothing and exits 0 for input it cannot read or a hook it does not know", () => {
    const unknown = runHook(event("pre-edit"), project, {});

    expect(unknown.status).toBe(0);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain('there is no "pre-edit" hook');
  });
});

describe("with the suss this repository builds", () => {
  beforeEach(() => {
    fs.cpSync(FIXTURE, project, {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes(".suss"),
    });
  });

  function change(file: string, from: string, to: string) {
    const target = path.join(project, file);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(from, to));
    return edited(file);
  }

  it("says nothing more about the 409 after an edit elsewhere in the same file", () => {
    runHook(event("session-start"), project, {});
    const add409 = runHook(
      change(
        "src/orders/create.ts",
        "  const created = await orders.insert({ sku, quantity });",
        '  if (await orders.findOpen(sku)) {\n    res.status(409).json({ error: "duplicate" });\n    return;\n  }\n  const created = await orders.insert({ sku, quantity });',
      ),
      project,
      {},
    );
    const helperAbove = runHook(
      change(
        "src/orders/create.ts",
        "export const ordersRouter = Router();",
        'export function describeOrder(sku: string) {\n  return "order for " + sku;\n}\n\nexport const ordersRouter = Router();',
      ),
      project,
      {},
    );

    expect(add409.output?.decision).toBe("block");
    expect(String(add409.output?.reason)).toContain(
      "unhandledProviderCase at POST /orders",
    );
    expect(helperAbove.status).toBe(0);
    expect(helperAbove.stdout).toBe("");
  });
});
