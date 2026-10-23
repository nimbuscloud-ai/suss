/**
 * Splices a project helper's paths into the caller that handed it a
 * value, so a client caller that leaves its status test to a helper
 * still shows which statuses it handles.
 *
 *   resp = requests.get(url)
 *   return check_response(resp)
 *
 * Each adapter finds the call, reads the helper's paths with the
 * caller's terminals, and says which parameter got which value. Splitting
 * the caller's branch along those paths is the same in every language,
 * so it lives here.
 */

import { predicateRefs, replacePredicateRefs } from "@suss/behavioral-ir";

import { type EffectSite, firesOn } from "./effectGuards.js";

import type { Predicate, TypeShape, ValueRef } from "@suss/behavioral-ir";
import type { RawBranch } from "./index.js";

/**
 * Past this many paths a helper is doing more than reading a response,
 * and multiplying every caller path by it would bury the caller's own.
 */
export const MAX_HELPER_PATHS = 16;

/**
 * The caller's branch split along each path of the helper called at
 * `at`. A throw or an exit in the helper ends the caller at the call,
 * and a path that returns goes on to the caller's own ending.
 */
export function throughHelper(
  branch: RawBranch,
  at: { start: number; end: number },
  helperBranches: readonly RawBranch[],
): RawBranch[] {
  return helperBranches.map((helper) => {
    const conditions = [...branch.conditions, ...helper.conditions];
    const expectedInput = mergeReadShapes(
      branch.expectedInput ?? null,
      helper.expectedInput ?? null,
    );
    const reads = expectedInput === null ? {} : { expectedInput };
    if (helper.terminal.kind !== "throw" && helper.terminal.kind !== "exit") {
      return {
        ...branch,
        ...reads,
        conditions,
        isDefault: branch.isDefault && helper.isDefault,
      };
    }
    const { loopAround, ...rest } = branch;
    return {
      ...rest,
      ...reads,
      conditions,
      terminal: { ...helper.terminal, location: at },
      location: at,
      ...(loopAround !== undefined && within(at, loopAround)
        ? { loopAround }
        : {}),
      isDefault: false,
    };
  });
}

function within(
  inner: { start: number; end: number },
  outer: { start: number; end: number },
): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * The fields two readers of one response read between them, as the
 * records of field names a branch's `expectedInput` lists.
 */
export function mergeReadShapes(
  a: TypeShape | null,
  b: TypeShape | null,
): TypeShape | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  if (a.type !== "record" || b.type !== "record") {
    return a.type === "record" ? a : b;
  }
  const properties: Record<string, TypeShape> = { ...a.properties };
  for (const [name, shape] of Object.entries(b.properties)) {
    const known = properties[name];
    properties[name] =
      known === undefined ? shape : (mergeReadShapes(known, shape) ?? shape);
  }
  return { ...a, properties };
}

/**
 * One call in a caller's body that hands a helper the response, in
 * source order. A branch reaches it when an effect written there would
 * fire on the branch.
 */
export interface HandOffSite extends EffectSite {
  /** The helper's paths, in the caller's terms. */
  helper: readonly RawBranch[];
  /** The lines the call is written on. */
  at: { start: number; end: number };
}

/**
 * The branch split at each hand-off on it, in source order. A path that
 * ended in one helper goes no further, so the hand-offs after it are not
 * asked about on that path.
 */
export function splitAtHandOffs(
  branch: RawBranch,
  sites: readonly HandOffSite[],
  from = 0,
): RawBranch[] {
  for (let index = from; index < sites.length; index++) {
    const site = sites[index] as HandOffSite;
    if (!firesOn(site, branch)) {
      continue;
    }
    return throughHelper(branch, site.at, site.helper).flatMap((path) =>
      path.terminal === branch.terminal
        ? splitAtHandOffs(path, sites, index + 1)
        : [path],
    );
  }
  return [branch];
}

/**
 * A helper's paths with each test on a parameter it was handed turned
 * into a test on the caller's variable, keyed parameter to variable.
 * Null when no path tests what it was handed, or when there are too many
 * paths to splice. This is for an adapter that writes a variable's value
 * as a dependency on the variable's name, the way the caller's own tests
 * on it are written.
 */
export function helperPathsOnVariables(
  helperBranches: readonly RawBranch[],
  passed: ReadonlyMap<string, string>,
): RawBranch[] | null {
  const renamed = helperBranches.map((branch) => ({
    ...branch,
    conditions: branch.conditions.map((condition) => ({
      ...condition,
      structured:
        condition.structured === null
          ? null
          : onCallerVariables(condition.structured, passed),
    })),
  }));
  const variables = new Set(passed.values());
  const testsWhatItGot = renamed.some((branch) =>
    branch.conditions.some(
      (condition) =>
        condition.structured !== null &&
        predicateRefs(condition.structured).some((ref) =>
          variables.has(rootName(ref) ?? ""),
        ),
    ),
  );
  return testsWhatItGot && renamed.length <= MAX_HELPER_PATHS ? renamed : null;
}

function onCallerVariables(
  predicate: Predicate,
  passed: ReadonlyMap<string, string>,
): Predicate {
  const rename = (ref: ValueRef): ValueRef => {
    if (ref.type === "derived") {
      return { ...ref, from: rename(ref.from) };
    }
    if (ref.type === "input") {
      const name = passed.get(ref.inputRef);
      return name === undefined
        ? ref
        : { type: "dependency", name, accessChain: ref.path };
    }
    if (ref.type === "dependency") {
      const name = passed.get(ref.name);
      return name === undefined ? ref : { ...ref, name };
    }
    return ref;
  };
  return replacePredicateRefs(predicate, rename);
}

function rootName(ref: ValueRef): string | null {
  if (ref.type === "derived") {
    return rootName(ref.from);
  }
  return ref.type === "dependency" ? ref.name : null;
}
