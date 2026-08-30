/**
 * wrapperIndex.ts, finding the functions registered around a handler
 * rather than as one.
 *
 * Express's `app.use(requireCaller)` and Hono's `app.onError(handle)`
 * register a function that runs for every route on the app without
 * appearing in any of their bodies, which is why a 401 or a 500 turns
 * up in a route's contract and in no handler. The function is usually
 * written in another file than the app registering it, so finding it
 * means asking the store the question `registrationCall` already asks.
 * A wrapper found here becomes a unit of its own, summarized like any
 * other, and the edge built here is a reference to that summary.
 */

import { Node, type SourceFile } from "ts-morph";

import { joinMountedPath } from "@suss/resolution";

import { nodeId } from "../facts/extract.js";
import { functionNameOrAnon } from "./graphqlShared.js";
import {
  registrationSubjectsOf,
  storeCanFindSubjects,
  subjectNodeFor,
} from "./registrationCall.js";
import { functionValueOf, stringValueOf } from "./resolveValue.js";

import type { WrapperReference } from "@suss/behavioral-ir";
import type { DiscoveryPattern, PatternPack } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { MountPrefixIndex } from "./registrationCall.js";
import type { DiscoveredUnit } from "./shared.js";

export type { WrapperReference };

export interface WrapperIndex {
  /**
   * The wrappers registered on `subjectId`, the creation site of the
   * routable a unit was registered on. Empty when nothing wraps it.
   */
  wrappersFor(subjectId: string): readonly WrapperReference[];
  /**
   * The wrappers `pack` registers in `file`, as units to summarize
   * beside whatever else the file declares.
   */
  unitsIn(file: string, pack: string): readonly DiscoveredUnit[];
}

const NO_WRAPPERS: WrapperIndex = { wrappersFor: () => [], unitsIn: () => [] };

/** What `functionNameOrAnon` gives back for a function with no name. */
const ANONYMOUS = "<anon>";

type RegistrationMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationCall" }
>;

type WrapsPattern = NonNullable<DiscoveryPattern["wraps"]>;

interface PackWrapperWork {
  sourceFile: SourceFile;
  pattern: DiscoveryPattern;
  match: RegistrationMatch;
  wraps: WrapsPattern;
}

/** One registration a file states, before the candidates are folded together. */
export interface WrapperCandidate {
  /** Identity of the routable the registration call was made on. */
  subjectId: string;
  /** Identity of the registration call, so one call's candidates group. */
  callId: string;
  /** Identity of the registered function, for the same reason. */
  targetId: string;
  /** Whether the declaration that matched constrained the target's arity. */
  byArity: boolean;
  /** The registered function, which becomes a unit in its own right. */
  target: FunctionRoot;
  /** The pattern that matched, which the walk reads the wrapper's shape from. */
  pattern: DiscoveryPattern;
  /** The file the registration call is in, which is the walk that owns the unit. */
  registeredIn: string;
  /** Whether the function had a name of its own to go by. */
  named: boolean;
  reference: WrapperReference;
}

/**
 * Scan every file a pack's discovery gate already applies to for the
 * wrapper registrations the pack declares through
 * `DiscoveryPattern.wraps`. What comes back is the wrappers as units to
 * summarize, and the edge from each wrapped unit to them.
 */
export function buildWrapperIndex(
  packsByFile: ReadonlyMap<SourceFile, readonly PatternPack[]>,
  resolution: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
): WrapperIndex {
  // Kept per pack, because which registrations one pack's candidates
  // are the narrowest reading of is a question about that pack alone.
  const workByPack = new Map<string, PackWrapperWork[]>();

  for (const [sourceFile, packs] of packsByFile) {
    for (const pack of packs) {
      const work = workByPack.get(pack.name) ?? [];
      for (const pattern of pack.discovery) {
        if (pattern.match.type !== "registrationCall") {
          continue;
        }
        if (pattern.wraps !== undefined) {
          work.push({
            sourceFile,
            pattern,
            match: pattern.match,
            wraps: pattern.wraps,
          });
        }
      }
      if (work.length > 0) {
        workByPack.set(pack.name, work);
      }
    }
  }

  const bySubject = new Map<string, WrapperReference[]>();
  const unitsByFile = new Map<string, DiscoveredUnit[]>();
  let found = false;

  for (const [packName, work] of workByPack) {
    const candidates: WrapperCandidate[] = [];
    for (const { sourceFile, pattern, match, wraps } of work) {
      candidates.push(
        ...discoverWrapperRegistrations(
          sourceFile,
          pattern,
          match,
          wraps,
          resolution,
          mountPrefixes,
        ),
      );
    }

    for (const candidate of mostSpecific(candidates)) {
      found = true;
      const references = bySubject.get(candidate.subjectId) ?? [];
      references.push(candidate.reference);
      bySubject.set(candidate.subjectId, references);

      const key = unitKey(candidate.registeredIn, packName);
      const units = unitsByFile.get(key) ?? [];
      units.push(unitFor(candidate));
      unitsByFile.set(key, units);
    }
  }

  if (!found) {
    return NO_WRAPPERS;
  }

  return {
    wrappersFor: (subjectId) => bySubject.get(subjectId) ?? [],
    unitsIn: (file, pack) => unitsByFile.get(unitKey(file, pack)) ?? [],
  };
}

function unitKey(file: string, pack: string): string {
  return `${pack}::${file}`;
}

function unitFor(candidate: WrapperCandidate): DiscoveredUnit {
  return {
    func: candidate.target,
    kind: candidate.pattern.kind,
    name: candidate.reference.name,
    pattern: candidate.pattern,
    ...(candidate.named ? {} : { nameKind: "label" as const }),
  };
}

/**
 * The candidates left once each registration call keeps only its
 * narrowest reading.
 *
 * Express writes middleware and error handlers alike as `app.use(fn)`
 * and tells them apart by the function's arity, so a four-argument
 * handler matches the pack's plain declaration as well as its
 * arity-constrained one, and keeping both would say one function runs
 * in two places.
 */
function mostSpecific(
  candidates: readonly WrapperCandidate[],
): WrapperCandidate[] {
  const constrained = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.byArity) {
      constrained.add(`${candidate.callId}|${candidate.targetId}`);
    }
  }
  return candidates.filter(
    (candidate) =>
      candidate.byArity ||
      !constrained.has(`${candidate.callId}|${candidate.targetId}`),
  );
}

/**
 * Every wrapper registration in `sourceFile` matching `wraps`'s shape
 * on a variable this pattern's `match` already treats as the routable.
 *
 * The registered function has to resolve to something concrete and,
 * when the declaration states an arity, to a function declared with
 * exactly that many parameters. A scope the declaration asks for has to
 * read as a string. Any of those failing drops the call rather than
 * guessing, which is the convention mount discovery follows for a
 * prefix and route discovery follows for a path.
 */
export function discoverWrapperRegistrations(
  sourceFile: SourceFile,
  pattern: DiscoveryPattern,
  match: RegistrationMatch,
  wraps: WrapsPattern,
  resolution?: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
): WrapperCandidate[] {
  const subjects = registrationSubjectsOf(
    sourceFile,
    match.importModule,
    match.importName,
    resolution,
  );
  if (
    subjects.size === 0 &&
    !storeCanFindSubjects(sourceFile, match, resolution)
  ) {
    return [];
  }

  const candidates: WrapperCandidate[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      callee.getName() !== wraps.method
    ) {
      return;
    }

    const subjectNode = subjectNodeFor(
      callee.getExpression(),
      subjects,
      match,
      resolution,
    );
    if (subjectNode === undefined) {
      return;
    }

    const args = node.getArguments();
    const targetArg = args[wraps.targetPosition] as Node | undefined;
    if (targetArg === undefined) {
      return;
    }
    const target = functionValueOf(targetArg, resolution);
    if (target === null) {
      return;
    }
    if (
      wraps.arity !== undefined &&
      target.getParameters().length !== wraps.arity
    ) {
      return;
    }

    const scope = scopeOf(args, wraps, resolution);
    if (scope === null) {
      return;
    }

    const subjectId = nodeId(subjectNode);
    const mountedScope =
      scope === undefined
        ? undefined
        : mountedAt(subjectId, mountPrefixes, scope);

    const named = functionNameOrAnon(target) !== ANONYMOUS;
    candidates.push({
      subjectId,
      callId: nodeId(node),
      targetId: nodeId(target),
      byArity: wraps.arity !== undefined,
      target,
      pattern,
      registeredIn: sourceFile.getFilePath(),
      named,
      reference: {
        file: target.getSourceFile().getFilePath(),
        // A function written out at the registration call has no name
        // of its own, so it goes by the method that registered it.
        name: named ? functionNameOrAnon(target) : wraps.method,
        ...(wraps.throwParam === undefined ? {} : { onThrow: true }),
        ...(mountedScope === undefined ? {} : { scope: mountedScope }),
      },
    });
  });

  return candidates;
}

/**
 * `scope` with the prefix its router was mounted under folded in, so it
 * is written in the same terms as the paths of the routes it covers.
 *
 * A mount chain that cannot be stated composes to nothing here, which
 * leaves the scope as written. That is what a route does with its own
 * path in the same situation, and the two stay comparable.
 */
function mountedAt(
  subjectId: string,
  mountPrefixes: MountPrefixIndex | undefined,
  scope: string,
): string {
  const prefix = mountPrefixes?.prefixForId?.(subjectId) ?? "";
  return joinMountedPath(prefix, scope);
}

/**
 * The path pattern a registration narrows itself to: undefined when the
 * declaration asks for none, and null when it asks for one the call
 * does not give as a readable string, which drops the call.
 */
function scopeOf(
  args: readonly Node[],
  wraps: WrapsPattern,
  resolution: ResolutionStore | undefined,
): string | undefined | null {
  if (wraps.scopePosition === undefined) {
    return undefined;
  }
  const scopeArg = args[wraps.scopePosition] as Node | undefined;
  if (scopeArg === undefined) {
    return null;
  }
  return stringValueOf(scopeArg, resolution);
}
