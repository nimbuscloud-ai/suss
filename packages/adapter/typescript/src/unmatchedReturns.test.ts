// A pack's terminals describe the shapes it knows. A function that
// returns something none of them match used to produce a summary with
// no transitions and no gaps, which reads as a function that does
// nothing rather than one nobody read.

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { countUnmatchedReturns } from "./assembly.js";

import type { TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

const HTTP_TERMINALS: TerminalPattern[] = [
  {
    kind: "response",
    match: { type: "returnShape", requiredProperties: ["statusCode"] },
    extraction: {},
  },
];

function countIn(source: string, name: string): number {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile("/mod.ts", source);
  const decl = file.getVariableDeclarationOrThrow(name);
  const func = decl.getInitializerOrThrow() as unknown as FunctionRoot;
  return countUnmatchedReturns(func, HTTP_TERMINALS);
}

describe("countUnmatchedReturns", () => {
  it("counts a return the terminals do not describe", () => {
    expect(
      countIn(
        `export const handler = async () => {
           return { batchItemFailures: [] };
         };`,
        "handler",
      ),
    ).toBe(1);
  });

  it("counts nothing when a terminal claims the return", () => {
    expect(
      countIn(
        `export const handler = async () => {
           return { statusCode: 200, body: "" };
         };`,
        "handler",
      ),
    ).toBe(0);
  });

  it("counts each unmatched return separately", () => {
    expect(
      countIn(
        `export const handler = async (flag: boolean) => {
           if (flag) {
             return { batchItemFailures: [] };
           }
           return { ok: true };
         };`,
        "handler",
      ),
    ).toBe(2);
  });

  it("leaves a bare return alone, since falling off the end covers it", () => {
    expect(
      countIn(
        `export const handler = async (flag: boolean) => {
           if (flag) {
             return;
           }
         };`,
        "handler",
      ),
    ).toBe(0);
  });

  it("does not count returns belonging to a nested function", () => {
    expect(
      countIn(
        `export const handler = async () => {
           const inner = () => {
             return { somethingElse: true };
           };
           return { statusCode: 200, body: inner() };
         };`,
        "handler",
      ),
    ).toBe(0);
  });
});
