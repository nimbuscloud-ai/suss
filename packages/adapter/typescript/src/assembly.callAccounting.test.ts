// assembly.callAccounting.test.ts: the call-accounting diagnostic
// extractRawBranches emits under collectCallAccounting.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { extractRawBranches } from "./assembly.js";

import type { TerminalPattern } from "@suss/extractor";
import type { Project } from "ts-morph";
import type { CallAccountingEntry } from "./assembly.js";
import type { FunctionRoot } from "./conditions.js";

function getExportedFunction(project: Project, source: string): FunctionRoot {
  const file = project.createSourceFile("callAccounting.ts", source);
  const fn = file.getFunctions().find((f) => f.isExported());
  if (fn === undefined) {
    throw new Error("No exported function found");
  }
  return fn;
}

function outcomeOf(
  entries: CallAccountingEntry[] | undefined,
  callee: string,
): string {
  const entry = entries?.find((e) => e.callee === callee);
  if (entry === undefined) {
    throw new Error(`no call-accounting entry for ${callee}`);
  }
  return entry.outcome;
}

const expressTerminals: TerminalPattern[] = [
  {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition: 1,
      methodChain: ["status", "json"],
    },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 0 },
    },
  },
];

const returnOnly: TerminalPattern[] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
];

describe("extractRawBranches: call accounting", () => {
  it("omits callAccounting when nobody asked for it", () => {
    const project = createTestProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler() {
        return 1;
      }
    `,
    );

    const result = extractRawBranches(fn, returnOnly);

    expect(result.callAccounting).toBeUndefined();
  });

  it("marks a call before the terminal as invocation, a call in the terminal's own chain as terminal, and a call past the return as unreachable", () => {
    const project = createTestProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(req: any, res: any) {
        logger.log("start");
        return res.status(200).json(build());
        deadCall();
      }
    `,
    );

    const result = extractRawBranches(
      fn,
      expressTerminals,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(outcomeOf(result.callAccounting, "logger.log")).toBe("invocation");
    expect(outcomeOf(result.callAccounting, "build")).toBe("invocation");
    expect(outcomeOf(result.callAccounting, "res.status")).toBe("terminal");
    expect(outcomeOf(result.callAccounting, "res.status(200).json")).toBe(
      "terminal",
    );
    expect(outcomeOf(result.callAccounting, "deadCall")).toBe("unreachable");
  });

  it("marks a call whose own guard rules out every branch as unrecorded", () => {
    const project = createTestProject();
    // No terminal covers the `a` branch (this list has no fallthrough
    // pattern), so `sideEffect` is reached, is not a terminal, and
    // fires on no branch even though it runs before `other`'s return.
    const fn = getExportedFunction(
      project,
      `
      export function handler(a: boolean) {
        if (a) {
          sideEffect();
        } else {
          return other();
        }
      }
    `,
    );

    const result = extractRawBranches(
      fn,
      returnOnly,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(outcomeOf(result.callAccounting, "sideEffect")).toBe("unrecorded");
    expect(outcomeOf(result.callAccounting, "other")).toBe("invocation");
  });
});
