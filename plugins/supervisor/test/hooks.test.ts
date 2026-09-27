/**
 * Each hook fed the JSON Claude Code writes on its stdin, with what it
 * prints and its exit code checked. Most tests run a stand-in suss the
 * project installs, so they can make suss report whatever the case
 * needs; the last block runs the suss this repository builds.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { runHook } from "../demo/play.mjs";
import { fakeSussCalls, installFakeSuss, scriptFakeSuss } from "./fakeSuss.js";

import type {
  IntentCheck,
  SinceFinding,
  SinceReport,
} from "../scripts/types.js";
import type { FakeScript } from "./fakeSuss.js";

const FIXTURE = path.resolve(__dirname, "../../../fixtures/supervisor-orders");
const KEEP_INTENT = path.resolve(__dirname, "../scripts/keepIntent.mjs");
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
      {
        key: "POST /orders",
        label: "POST /orders",
        units: ["src/orders/create.ts::post"],
      },
    ],
    run: [],
  };
}

/** What `check --since` says after an edit that makes a helper read a new variable. */
function helperReadsVariable(): SinceReport {
  const helper = "src/composition.ts::getAccountService";
  return {
    since: "/before",
    findings: [],
    resolved: [],
    changedBoundaries: [
      { key: "function-call:reachable", label: null, units: [helper] },
      {
        key: "runtime-config:@suss/runtime-node",
        label: "runtime-config ACCOUNTS_REGION",
        units: [helper],
      },
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

  it("keeps each prompt in the session record and says where the change list goes", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});

    const prompt = runHook(
      event("prompt", { prompt: "Add a cancel endpoint." }),
      project,
      {},
    );

    expect(prompt.status).toBe(0);
    expect(prompt.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `suss: if this request will change code, write the change list for it to ${sessionFile("intent.yaml")} before your first edit, the way the suss:intent skill describes, and print it for the developer. Skip this for a request that changes no code.`,
      },
    });
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

  it("names the variable an edit started reading and the helper it reads it in", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    scriptFakeSuss(project, { check: helperReadsVariable() });

    const edit = runHook(edited("src/composition.ts"), project, {});

    expect(edit.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "suss: this edit changed runtime-config ACCOUNTS_REGION through getAccountService.",
      },
    });
  });

  it("says nothing after an edit that changed only functions inside the project", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    const report = helperReadsVariable();
    scriptFakeSuss(project, {
      check: {
        ...report,
        changedBoundaries: report.changedBoundaries.slice(0, 1),
      },
    });

    const edit = runHook(edited("src/accountService.ts"), project, {});

    expect(edit.status).toBe(0);
    expect(edit.stdout).toBe("");
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

function verdicts(parts: Partial<IntentCheck> = {}): IntentCheck {
  return {
    version: 1,
    entries: [],
    notAsked: [],
    explained: [],
    fromWrappers: [],
    text: "the verdicts",
    ...parts,
  };
}

const NOT_DONE = {
  said: "+ POST /orders/{id}/cancel responds 200, 404",
  verdict: "notDone" as const,
  reason: "the diff does not show POST /orders/{id}/cancel added or changed.",
  units: [],
  asked: "Add a cancel endpoint.",
  requested: true,
};

const UNCHECKED = {
  said: "~ AccountService takes an optional region",
  verdict: "unchecked" as const,
  reason:
    "suss has no boundary spelled AccountService, so it cannot check this entry.",
  units: [],
  asked: null,
  requested: null,
};

const UNASKED_409 = {
  identity: "POST /orders\nserves src/orders/create.ts::post + responds 409",
  boundary: "POST /orders",
  lines: [
    {
      does: "serves" as const,
      boundary: "POST /orders",
      unit: "post",
      file: "src/orders/create.ts",
      change: "added" as const,
      text: ["+ responds 409 { error }"],
      conditionMoved: false,
    },
  ],
};

function writeChangeList(): void {
  fs.writeFileSync(
    sessionFile("intent.yaml"),
    "changes:\n  - adds: POST /orders/:id/cancel\n",
  );
}

describe("with a change list", () => {
  it("says nothing more about the change list once the session has one", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    writeChangeList();

    const prompt = runHook(
      event("prompt", { prompt: "Also return 410 for an archived order." }),
      project,
      {},
    );

    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toBe("");
  });

  it("reads nothing again after an edit to the change list", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});

    const edit = runHook(
      edited(path.join(".suss", "session", SESSION, "intent.yaml")),
      project,
      {},
    );

    expect(edit.status).toBe(0);
    expect(edit.stdout).toBe("");
    expect(fs.existsSync(sessionFile("edits.jsonl"))).toBe(false);
  });

  it("gives intent check both readings and the developer's messages", () => {
    installFakeSuss(project, { intent: verdicts() });
    runHook(event("session-start"), project, {});
    runHook(event("prompt", { prompt: "Add a cancel endpoint." }), project, {});
    writeChangeList();

    runHook(event("stop"), project, {});

    const call = fakeSussCalls(project).find((args) => args[0] === "intent");
    expect(call).toEqual([
      "intent",
      "check",
      sessionFile("intent.yaml"),
      "--before",
      sessionFile(path.join("state", "baseline")),
      "--after",
      sessionFile(path.join("state", "current")),
      "--prompts",
      sessionFile("prompts.jsonl"),
      "--json",
    ]);
  });

  it("shows what changed when no entry of the change list can be checked", () => {
    installFakeSuss(project, {
      intent: verdicts({
        entries: [UNCHECKED],
        text: "1 unchecked.\n\nunchecked   ~ AccountService takes an optional region",
      }),
      diff: "1 unit inside the project changed.\n\nsrc/accountService.ts\n  ~ AccountService\n",
    });
    runHook(event("session-start"), project, {});
    writeChangeList();

    const stop = runHook(event("stop"), project, {});

    const report = String(stop.output?.systemMessage);
    expect(report).toContain("1 unchecked.");
    expect(report).toContain("src/accountService.ts\n  ~ AccountService");
    expect(
      fakeSussCalls(project).filter((args) => args[0] === "inspect"),
    ).toContainEqual([
      "inspect",
      "--diff",
      sessionFile(path.join("state", "baseline")),
      sessionFile(path.join("state", "current")),
      "--json",
    ]);
  });

  it("shows the diff when only a module line moved", () => {
    installFakeSuss(project, {
      diff: "Module lines\n\n  catalog now calls billing's saveInvoice (src/billing/invoiceStore.ts) from priceFor, and billing does not export it.\n",
      onlyModulesMoved: true,
    });
    runHook(event("session-start"), project, {});

    const stop = runHook(event("stop"), project, {});

    expect(String(stop.output?.systemMessage)).toContain(
      "catalog now calls billing's saveInvoice",
    );
  });

  it("leaves the diff out when the verdicts account for what changed", () => {
    installFakeSuss(project, {
      intent: verdicts({
        entries: [{ ...NOT_DONE, verdict: "done", reason: null }],
        text: "1 done.",
      }),
      diff: "the diff",
    });
    runHook(event("session-start"), project, {});
    writeChangeList();

    const stop = runHook(event("stop"), project, {});

    expect(String(stop.output?.systemMessage)).not.toContain("the diff");
  });

  it("blocks a stop once on an entry not done, then passes and puts the list away", () => {
    installFakeSuss(project, {
      intent: verdicts({ entries: [NOT_DONE], text: "not done  + POST ..." }),
    });
    runHook(event("session-start"), project, {});
    writeChangeList();

    const first = runHook(event("stop"), project, {});
    const second = runHook(
      event("stop", { stop_hook_active: true }),
      project,
      {},
    );

    expect(first.output?.decision).toBe("block");
    expect(String(first.output?.reason)).toContain(
      "suss: the code and the change list do not agree yet.\nFinish each entry marked not done.",
    );
    expect(String(first.output?.reason)).toContain("not done  + POST ...");
    expect(second.output?.decision).toBeUndefined();
    expect(String(second.output?.systemMessage)).toContain(
      "suss: what changed since the session started, against the change list.",
    );
    expect(fs.existsSync(sessionFile("intent.yaml"))).toBe(false);
    expect(fs.readdirSync(sessionFile("intents"))).toHaveLength(1);
  });

  it("blocks once on a change nobody asked for, and passes with the explanation", () => {
    installFakeSuss(project, { intent: verdicts({ notAsked: [UNASKED_409] }) });
    runHook(event("session-start"), project, {});
    writeChangeList();

    const first = runHook(event("stop"), project, {});
    scriptFakeSuss(project, {
      intent: verdicts({
        explained: [
          {
            said: "~ POST /orders responds 409",
            why: "duplicates were charged twice",
            lines: UNASKED_409.lines,
          },
        ],
        text: "explained  ~ POST /orders responds 409",
      }),
    });
    const second = runHook(
      event("stop", { stop_hook_active: true }),
      project,
      {},
    );

    expect(first.output?.decision).toBe("block");
    expect(String(first.output?.reason)).toContain(
      "For each boundary marked not asked, revert the change, or add an entry under explained:",
    );
    expect(second.output?.decision).toBeUndefined();
    expect(String(second.output?.systemMessage)).toContain(
      "explained  ~ POST /orders responds 409",
    );
  });

  it("blocks once when the change list does not fit its schema", () => {
    installFakeSuss(project, {
      intentRefuses:
        "The change list does not fit its schema:\n  - changes.0: an entry has exactly one of adds, removes or changes",
    });
    runHook(event("session-start"), project, {});
    writeChangeList();

    const first = runHook(event("stop"), project, {});
    const second = runHook(
      event("stop", { stop_hook_active: true }),
      project,
      {},
    );

    expect(first.output?.decision).toBe("block");
    expect(String(first.output?.reason)).toContain(
      `suss: could not read the change list at ${sessionFile("intent.yaml")}.`,
    );
    expect(String(first.output?.reason)).toContain(
      "an entry has exactly one of adds, removes or changes",
    );
    expect(second.output?.decision).toBeUndefined();
  });

  const SUSS_FAILURES: Array<{
    name: string;
    script: FakeScript;
    env: Record<string, string>;
    says: string;
  }> = [
    {
      name: "runs past its time",
      script: { intentMs: 10_000 },
      env: { SUSS_SUPERVISOR_COMPARE_MS: "500" },
      says: "suss did not finish within 1s",
    },
    {
      name: "is a release without the command",
      script: { intentFails: "missing" },
      env: {},
      says: 'There is no "intent check". intent has outcomes.',
    },
    {
      name: "crashes",
      script: { intentFails: "crash" },
      env: {},
      says: "TypeError: Cannot read properties of undefined (reading 'transitions')",
    },
  ];

  for (const failure of SUSS_FAILURES) {
    it(`tells the developer once, and blocks nothing, when intent check ${failure.name}`, () => {
      installFakeSuss(project, failure.script);
      runHook(event("session-start"), project, {});
      writeChangeList();

      const stop = runHook(event("stop"), project, failure.env);
      const next = runHook(event("stop"), project, failure.env);

      expect(stop.status).toBe(0);
      expect(stop.output?.decision).toBeUndefined();
      const notice = String(stop.output?.systemMessage);
      expect(notice).toContain("suss: what changed since the session started.");
      expect(notice).not.toContain("could not read the change list");
      expect(notice).toContain(
        `suss could not check this turn's work against the change list, so this report shows what changed instead. ${failure.says}`,
      );
      expect(fs.existsSync(sessionFile("intent.yaml"))).toBe(false);
      expect(next.stdout).toBe("");
    });
  }

  it("keeps a suss failure out of a stop that blocks on something else", () => {
    installFakeSuss(project, { intentFails: "crash" });
    runHook(event("session-start"), project, {});
    writeChangeList();
    scriptFakeSuss(project, {
      intentFails: "crash",
      check: sinceReport([storeError()]),
    });

    const blocked = runHook(event("stop"), project, {});
    const passed = runHook(event("stop"), project, {});

    expect(blocked.output?.decision).toBe("block");
    expect(String(blocked.output?.reason)).not.toContain(
      "could not check this turn's work",
    );
    expect(passed.output?.decision).toBeUndefined();
    expect(String(passed.output?.systemMessage)).toContain(
      "suss could not check this turn's work against the change list",
    );
  });

  it("reports as it did before when the session has no change list", () => {
    installFakeSuss(project, { intent: verdicts({ entries: [NOT_DONE] }) });
    runHook(event("session-start"), project, {});

    const stop = runHook(event("stop"), project, {});

    expect(stop.stdout).toBe("");
    expect(fakeSussCalls(project).some((args) => args[0] === "intent")).toBe(
      false,
    );
  });
});

/**
 * Runs /suss:keep-intent's script the way the Bash tool would, in the
 * project directory, with none of the variables Claude Code may set.
 */
function keepIntent(args: string[]) {
  const {
    CLAUDE_SESSION_ID: _session,
    CLAUDE_PROJECT_DIR: _project,
    CLAUDE_PLUGIN_ROOT: _plugin,
    ...env
  } = process.env;
  return spawnSync(process.execPath, [KEEP_INTENT, ...args], {
    cwd: project,
    env,
    encoding: "utf8",
  });
}

/** A path in the session record, as the script sees it from the project directory. */
function seenFromProject(name: string): string {
  return path.join(fs.realpathSync(project), ".suss", "session", SESSION, name);
}

function keepCall(): string[] | undefined {
  return fakeSussCalls(project).find(
    (args) => args[0] === "intent" && args[1] === "keep",
  );
}

describe("/suss:keep-intent with no session id", () => {
  it("keeps the change list of the session a hook marked as current", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    runHook(event("prompt", { prompt: "Add a cancel endpoint." }), project, {});
    writeChangeList();

    const kept = keepIntent(["--audience", "the web client"]);

    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain("Kept 1 intent document.");
    expect(keepCall()).toEqual([
      "intent",
      "keep",
      seenFromProject("intent.yaml"),
      "--dir",
      seenFromProject(path.join("state", "current")),
      "--audience",
      "the web client",
      "--into",
      path.join(fs.realpathSync(project), "intent"),
    ]);
  });

  it("ignores a session id that was never filled in", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    writeChangeList();

    const literal = keepIntent([
      "--session",
      "${CLAUDE_SESSION_ID}",
      "--audience",
      "the web client",
    ]);
    const empty = keepIntent(["--session", "", "--audience", "the web client"]);

    expect([literal.status, empty.status]).toEqual([0, 0]);
    expect(keepCall()?.[2]).toBe(seenFromProject("intent.yaml"));
  });

  it("keeps the list the last passing stop filed away", () => {
    installFakeSuss(project, { intent: verdicts() });
    runHook(event("session-start"), project, {});
    writeChangeList();
    runHook(event("stop"), project, {});

    const kept = keepIntent(["--audience", "the web client"]);

    expect(kept.status).toBe(0);
    expect(keepCall()?.[2]).toMatch(
      new RegExp(`${seenFromProject("intents")}/[^/]+\\.yaml$`),
    );
  });

  it("follows the session the developer last typed in, and an ending session leaves another's mark", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});
    runHook(event("session-start", { session_id: "other" }), project, {});
    const current = path.join(project, ".suss", "session", "current.json");
    const afterOtherStarted = JSON.parse(fs.readFileSync(current, "utf8"));

    runHook(event("prompt", { prompt: "Carry on." }), project, {});
    const afterPrompt = JSON.parse(fs.readFileSync(current, "utf8"));
    runHook(event("session-end", { session_id: "other" }), project, {});

    expect(afterOtherStarted.session).toBe("other");
    expect(afterPrompt.session).toBe(SESSION);
    expect(JSON.parse(fs.readFileSync(current, "utf8")).session).toBe(SESSION);
  });

  it("says so when no session is running, and when the session has no list", () => {
    installFakeSuss(project, {});
    runHook(event("session-start"), project, {});

    const noList = keepIntent(["--audience", "the web client"]);
    runHook(event("session-end"), project, {});
    const noSession = keepIntent(["--audience", "the web client"]);
    const noAudience = keepIntent([]);

    expect(noList.status).toBe(1);
    expect(noList.stderr).toContain(
      `Session ${SESSION} has no change list yet.`,
    );
    expect(noSession.status).toBe(1);
    expect(noSession.stderr).toContain(
      "No session of the suss plugin is running in this project",
    );
    expect(noAudience.status).toBe(1);
    expect(noAudience.stderr).toContain("keep-intent needs --audience");
    expect(keepCall()).toBeUndefined();
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

  it("writes the change list as a boundary document through /suss:keep-intent's script", () => {
    runHook(event("session-start"), project, {});
    runHook(
      event("prompt", {
        prompt:
          "Add POST /orders/:id/cancel. Return 404 when the order does not exist.",
      }),
      project,
      {},
    );
    fs.writeFileSync(
      sessionFile("intent.yaml"),
      'asked: "Add POST /orders/:id/cancel."\nchanges:\n  - adds: POST /orders/:id/cancel\n    outcomes: [200, 404]\n',
    );
    fs.writeFileSync(path.join(project, "src/orders/cancel.ts"), CANCEL_ROUTE);
    runHook(edited("src/orders/cancel.ts"), project, {});

    const kept = keepIntent(["--audience", "the web client"]);

    expect(kept.status).toBe(0);
    const doc = YAML.parse(
      fs.readFileSync(
        path.join(project, "intent", "post-orders-id-cancel.intent.yaml"),
        "utf8",
      ),
    );
    expect(doc).toMatchObject({
      kind: "boundary",
      purpose: "Add POST /orders/:id/cancel.",
      audience: "the web client",
      source: "author",
    });
    expect(doc.transitions.map((t: { id: string }) => t.id)).toEqual([
      "200-ok",
      "404-not-found",
    ]);
  });
});

const CANCEL_ROUTE = `import { Router } from "express";

import { pool } from "../db";

export const cancelRouter = Router();

cancelRouter.post("/orders/:id/cancel", async (req, res) => {
  const found = await pool.query("SELECT id FROM orders WHERE id = $1", [req.params.id]);
  if (found.rowCount === 0) {
    res.status(404).json({ error: "no such order" });
    return;
  }
  res.status(200).json({ id: req.params.id });
});
`;
