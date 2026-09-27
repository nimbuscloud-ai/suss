import { describe, expect, it } from "vitest";

import { declarationKey } from "@suss/behavioral-ir";

import { markReturnsAsExitCode } from "./exitCode.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function summaryAt(
  file: string,
  start: number,
  metadata?: Record<string, unknown>,
): BehavioralSummary {
  return {
    location: { file, span: { start, end: start + 10 } },
    ...(metadata === undefined ? {} : { metadata }),
  } as unknown as BehavioralSummary;
}

describe("markReturnsAsExitCode", () => {
  it("marks a summary whose function is in the set, keeping its other metadata", () => {
    const summary = summaryAt("/app/cli.ts", 5, { kept: true });
    markReturnsAsExitCode(
      [summary],
      new Set([declarationKey("/app/cli.ts", { start: 5, end: 15 })]),
    );
    expect(summary.metadata).toEqual({
      kept: true,
      process: { exitCodeFrom: "return" },
    });
  });

  it("resolves a shortened file against the workspace root before matching", () => {
    const summary = summaryAt("src/cli.py", 0);
    markReturnsAsExitCode(
      [summary],
      new Set([declarationKey("/repo/src/cli.py", { start: 0, end: 10 })]),
      "/repo",
    );
    expect(summary.metadata?.process).toEqual({ exitCodeFrom: "return" });
  });

  it("clears a mark a reused summary kept, down to no metadata when nothing else is left", () => {
    const summary = summaryAt("/app/cli.ts", 5, {
      process: { exitCodeFrom: "return" },
    });
    markReturnsAsExitCode([summary], new Set());
    expect(summary.metadata).toBeUndefined();
  });

  it("clears only the mark, leaving the rest of the process metadata and the other keys", () => {
    const summary = summaryAt("/app/cli.ts", 5, {
      kept: true,
      process: { exitCodeFrom: "return", other: 1 },
    });
    markReturnsAsExitCode([summary], new Set());
    expect(summary.metadata).toEqual({ kept: true, process: { other: 1 } });
  });

  it("drops the process key when the mark was all it had", () => {
    const summary = summaryAt("/app/cli.ts", 5, {
      kept: true,
      process: { exitCodeFrom: "return" },
    });
    markReturnsAsExitCode([summary], new Set());
    expect(summary.metadata).toEqual({ kept: true });
  });

  it("leaves a summary with no span, or no mark to clear, alone", () => {
    const bare = {
      location: { file: "/app/cli.ts" },
      metadata: { kept: true },
    } as unknown as BehavioralSummary;
    markReturnsAsExitCode([bare], new Set(["/app/cli.ts:0-10"]));
    expect(bare.metadata).toEqual({ kept: true });
  });
});
