/**
 * Reads a project function a client caller hands its response to as part
 * of the caller.
 *
 *   const response = await fetch(`/api/orders/${id}`);
 *   return readOrder(response);
 *
 * `readOrder` throws on `!response.ok`. Read alone, the caller tests
 * nothing, so every failure looks unhandled. The helper's paths are read
 * the way the caller's were, with each parameter replaced by what the
 * caller passed, and each becomes a path of the caller. A helper is
 * followed only when one of its paths tests the response or its parsed
 * body, so a call that logs the response leaves the caller as it was.
 */

import { Node } from "ts-morph";

import { predicateRefs } from "@suss/behavioral-ir";
import { MAX_HELPER_PATHS, mergeReadShapes } from "@suss/extractor";

import { recordFileDependency } from "./depTracking.js";
import { substitutePredicate } from "./predicates.js";
import {
  collectParameterFieldAccesses,
  findResponseAccessor,
} from "./shapes/fieldAccesses.js";
import { resolveSubject } from "./subjects.js";

import type { Predicate, TypeShape, ValueRef } from "@suss/behavioral-ir";
import type { RawBranch, ResponsePropertyMapping } from "@suss/extractor";
import type { CallExpression } from "ts-morph";
import type { FunctionRoot } from "./conditions.js";
import type { ResolutionStore } from "./facts/store.js";

export interface ResponseHandOffOptions {
  /** The callee text the caller's own conditions use for the response. */
  responseCallee: string;
  /** The callee texts they use for its parsed body, such as `res.json`. */
  bodyCallees: readonly string[];
  /** The pack's response members, to tell a body field from a status read. */
  responseSemantics: ResponsePropertyMapping[] | undefined;
  resolution: ResolutionStore;
}

/**
 * The callee texts the caller's conditions use for the parsed body of
 * the response this call returns: `res.json` for
 * `const res = await fetch(url)`.
 */
export function bodyCalleesOf(
  call: CallExpression,
  semantics: readonly ResponsePropertyMapping[] | undefined,
): string[] {
  const accessor = findResponseAccessor(call);
  if (accessor?.kind !== "identifier") {
    return [];
  }
  return (semantics ?? [])
    .filter((m) => m.access === "method" && m.semantics.type === "body")
    .map((m) => `${accessor.name}.${m.name}`);
}

/** A project function a call hands the response to, and what it passed for each parameter. */
export interface HandedResponse {
  helper: FunctionRoot;
  /** Parameter name to the caller's value for the argument written there. */
  passed: Map<string, ValueRef>;
}

/** The helper a call hands the response or its parsed body to; null for any other call. */
export function responseHandedAt(
  call: CallExpression,
  options: ResponseHandOffOptions,
): HandedResponse | null {
  const handsResponse = call
    .getArguments()
    .some(
      (argument) =>
        Node.isExpression(argument) &&
        isResponseValue(resolveSubject(argument), options),
    );
  if (!handsResponse) {
    return null;
  }
  const helper = projectFunction(
    options.resolution.resolveCallable(call.getExpression()),
  );
  if (helper === null) {
    return null;
  }
  const passed = parametersPassed(helper, call, options.resolution);
  if (![...passed.values()].some((ref) => isResponseValue(ref, options))) {
    return null;
  }
  recordFileDependency(helper.getSourceFile().getFilePath());
  return { helper, passed };
}

/**
 * The helper's paths in the caller's terms, from the paths read in its
 * body. Null when no path tests the response, or when there are too many
 * paths to splice.
 */
export function helperPathsFor(
  { helper, passed }: HandedResponse,
  read: readonly RawBranch[],
  options: ResponseHandOffOptions,
): RawBranch[] | null {
  const fields = fieldsReadInHelper(helper, read, passed, options);
  const branches = read.map((branch, index) => {
    const expectedInput = fields[index] ?? null;
    return {
      ...substituted(branch, passed),
      ...(expectedInput === null ? {} : { expectedInput }),
    };
  });
  const testsResponse = branches.some((branch) =>
    branch.conditions.some(
      (condition) =>
        condition.structured !== null &&
        readsResponse(condition.structured, options),
    ),
  );
  return testsResponse && branches.length <= MAX_HELPER_PATHS ? branches : null;
}

/**
 * The response fields each helper branch reads off the parameters that
 * were handed the response or its parsed body, so the caller's expected
 * fields include them.
 */
function fieldsReadInHelper(
  helper: FunctionRoot,
  branches: readonly RawBranch[],
  passed: ReadonlyMap<string, ValueRef>,
  options: ResponseHandOffOptions,
): (TypeShape | null)[] {
  const locations = branches.map((branch) => branch.location);
  let fields: (TypeShape | null)[] = branches.map(() => null);
  for (const [parameter, ref] of passed) {
    const prefix = placeInResponse(ref, options);
    if (prefix === null) {
      continue;
    }
    const read = collectParameterFieldAccesses(
      parameter,
      prefix,
      helper,
      locations,
      options.responseSemantics,
    );
    fields = fields.map((known, index) =>
      mergeReadShapes(known, read[index]?.expectedInput ?? null),
    );
  }
  return fields;
}

/** Where a value handed to a helper is in the response: `[]` for the response, `["json"]` for `res.json()`. */
function placeInResponse(
  ref: ValueRef,
  options: ResponseHandOffOptions,
): string[] | null {
  if (ref.type !== "dependency" || ref.accessChain.length > 0) {
    return null;
  }
  if (ref.name === options.responseCallee) {
    return [];
  }
  if (!options.bodyCallees.includes(ref.name)) {
    return null;
  }
  const method = ref.name.split(".").pop();
  return method === undefined ? null : [method];
}

/** The function a callee resolved to, when its body is in the project. */
function projectFunction(target: Node | null): FunctionRoot | null {
  if (
    target === null ||
    target.getSourceFile().isFromExternalLibrary() ||
    target.getSourceFile().isDeclarationFile()
  ) {
    return null;
  }
  if (
    Node.isFunctionDeclaration(target) ||
    Node.isFunctionExpression(target) ||
    Node.isArrowFunction(target) ||
    Node.isMethodDeclaration(target)
  ) {
    return target.getBody() === undefined ? null : target;
  }
  return null;
}

/**
 * Each of the helper's parameters this call writes, by name, to the
 * caller's value for the argument written there.
 */
function parametersPassed(
  helper: FunctionRoot,
  call: CallExpression,
  resolution: ResolutionStore,
): Map<string, ValueRef> {
  const passed = new Map<string, ValueRef>();
  for (const parameter of helper.getParameters()) {
    const name = parameter.getNameNode();
    if (!Node.isIdentifier(name)) {
      continue;
    }
    for (const { call: through, argument } of resolution.argumentsPassedTo(
      parameter,
    )) {
      if (sameNode(through, call) && Node.isExpression(argument)) {
        passed.set(name.getText(), resolveSubject(argument));
      }
    }
  }
  return passed;
}

function sameNode(a: Node, b: Node): boolean {
  return (
    a.getStart() === b.getStart() &&
    a.getEnd() === b.getEnd() &&
    a.getSourceFile() === b.getSourceFile()
  );
}

function substituted(
  branch: RawBranch,
  passed: Map<string, ValueRef>,
): RawBranch {
  return {
    ...branch,
    conditions: branch.conditions.map((condition) => ({
      ...condition,
      structured:
        condition.structured === null
          ? null
          : substitutePredicate(condition.structured, passed),
    })),
  };
}

function readsResponse(
  predicate: Predicate,
  options: ResponseHandOffOptions,
): boolean {
  return predicateRefs(predicate).some((ref) => isFromResponse(ref, options));
}

/**
 * Whether a value is the response or its parsed body itself. A field read
 * off one, such as a URL handed to a formatter, does not make the callee
 * a reader of the response.
 */
function isResponseValue(
  ref: ValueRef,
  options: ResponseHandOffOptions,
): boolean {
  return ref.type === "dependency" && isFromResponse(ref, options);
}

/** Whether a value is the response or its parsed body, or read off one of them. */
function isFromResponse(
  ref: ValueRef,
  options: ResponseHandOffOptions,
): boolean {
  const root = rootOf(ref);
  return (
    root.type === "dependency" &&
    root.accessChain.length === 0 &&
    (root.name === options.responseCallee ||
      options.bodyCallees.includes(root.name))
  );
}

function rootOf(ref: ValueRef): ValueRef {
  return ref.type === "derived" ? rootOf(ref.from) : ref;
}
