/**
 * testCode.ts: where test code stops counting as evidence about
 * production code.
 *
 * A test calls production code with stand-in values, so what a test
 * passes never decides what production code reads, and a call from a
 * test never grounds what a production wrapper sends. Pairing keeps the
 * same rule for whole summaries.
 */

import { isTestFile } from "@suss/behavioral-ir";

import type { Node } from "ts-morph";

export function inTestFile(node: Node): boolean {
  return isTestFile(node.getSourceFile().getFilePath());
}

/** Whether `call` is a test calling `callee` when `callee` is production code. */
export function testCallingProduction(call: Node, callee: Node): boolean {
  return inTestFile(call) && !inTestFile(callee);
}
