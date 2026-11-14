/**
 * testCode.ts: where test code stops counting as evidence about
 * production code.
 *
 * A test calls production code with stand-in values, so what a test
 * passes never decides what production code reads. The resolution rules
 * keep a test's call from filling a production function's parameter, and
 * the facts say which side of that line each call and function is on.
 * Pairing keeps the same rule for whole summaries.
 */

import { isTestFile } from "@suss/behavioral-ir";

import type { Node, SourceFile } from "ts-morph";

// Every call a file states asks this, so a file's name is read once.
const testFiles = new WeakMap<SourceFile, boolean>();

export function inTestFile(node: Node): boolean {
  const file = node.getSourceFile();
  const known = testFiles.get(file);
  if (known !== undefined) {
    return known;
  }
  const found = isTestFile(file.getFilePath());
  testFiles.set(file, found);
  return found;
}

/** Whether `call` is a test calling `callee` when `callee` is production code. */
export function testCallingProduction(call: Node, callee: Node): boolean {
  return inTestFile(call) && !inTestFile(callee);
}
