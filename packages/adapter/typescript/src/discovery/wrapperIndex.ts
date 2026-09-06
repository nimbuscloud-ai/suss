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

import { factKeyOf, nodeId } from "../facts/extract.js";
import {
  classifyStop,
  declarationsBehind,
  worthRecording,
} from "../resolve/unfollowedCall.js";
import { functionNameOrAnon } from "./graphqlShared.js";
import {
  registrationSubjectsOf,
  storeCanFindSubjects,
  subjectNodeFor,
} from "./registrationCall.js";
import {
  functionValueOf,
  objectLiteralOf,
  propertiesOf,
  propertyFunctionOf,
  propertyNameOf,
  propertyValueOf,
  stringValueOf,
} from "./resolveValue.js";

import type { UnfollowedCall, WrapperReference } from "@suss/behavioral-ir";
import type {
  DiscoveryPattern,
  PatternPack,
  WrapperMethodRegistration,
  WrapperOptionRegistration,
  WrapperRegistration,
} from "@suss/extractor";
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
   * The registrations on `subjectId` whose function the store could not
   * settle on, so a route there is read without a wrapper it has.
   */
  unfollowedFor(subjectId: string): readonly UnfollowedCall[];
  /**
   * The wrappers `pack` registers in `file`, as units to summarize
   * beside whatever else the file declares.
   */
  unitsIn(file: string, pack: string): readonly DiscoveredUnit[];
}

const NO_WRAPPERS: WrapperIndex = {
  wrappersFor: () => [],
  unfollowedFor: () => [],
  unitsIn: () => [],
};

/** What `functionNameOrAnon` gives back for a function with no name. */
const ANONYMOUS = "<anon>";

type RegistrationMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationCall" }
>;

interface PackWrapperWork {
  sourceFile: SourceFile;
  pattern: DiscoveryPattern;
  match: RegistrationMatch;
  wraps: WrapperRegistration;
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

/** A registration whose function could not be settled on, kept per subject. */
export interface UnresolvedRegistration {
  subjectId: string;
  /** Identity of the registration call, so two patterns reading it record one stop. */
  callId: string;
  stop: UnfollowedCall;
}

/** What one file's scan for a pattern turns up. */
export interface WrapperScan {
  candidates: WrapperCandidate[];
  unresolved: UnresolvedRegistration[];
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
  const unfollowedBySubject = new Map<string, UnfollowedCall[]>();
  const unitsByFile = new Map<string, DiscoveredUnit[]>();
  const stopsSeen = new Set<string>();
  let found = false;

  for (const [packName, work] of workByPack) {
    const candidates: WrapperCandidate[] = [];
    for (const { sourceFile, pattern, match, wraps } of work) {
      const scan = discoverWrapperRegistrations(
        sourceFile,
        pattern,
        match,
        wraps,
        resolution,
        mountPrefixes,
      );
      candidates.push(...scan.candidates);
      for (const { subjectId, callId, stop } of scan.unresolved) {
        if (stopsSeen.has(callId)) {
          continue;
        }
        stopsSeen.add(callId);
        found = true;
        const stops = unfollowedBySubject.get(subjectId) ?? [];
        stops.push(stop);
        unfollowedBySubject.set(subjectId, stops);
      }
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
    unfollowedFor: (subjectId) => unfollowedBySubject.get(subjectId) ?? [],
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
  wraps: WrapperRegistration,
  resolution?: ResolutionStore,
  mountPrefixes?: MountPrefixIndex,
): WrapperScan {
  const subjects = registrationSubjectsOf(
    sourceFile,
    match.importModule,
    match.importName,
    resolution,
  );
  if ("constructorOption" in wraps) {
    return discoverConstructorOptions(
      sourceFile,
      pattern,
      wraps,
      subjects,
      resolution,
    );
  }
  if (
    subjects.size === 0 &&
    !storeCanFindSubjects(sourceFile, match, resolution)
  ) {
    return { candidates: [], unresolved: [] };
  }

  const candidates: WrapperCandidate[] = [];
  const unresolved: UnresolvedRegistration[] = [];

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
    const subjectId = nodeId(subjectNode);
    const target = functionValueOf(targetArg, resolution);
    if (target === null) {
      const stop = factoryStopOf(targetArg);
      if (stop !== null) {
        unresolved.push({ subjectId, callId: nodeId(node), stop });
      }
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

    const mountedScope =
      scope === undefined
        ? undefined
        : mountedAt(subjectId, mountPrefixes, scope);

    candidates.push(
      candidateOf(
        {
          subjectId,
          callId: nodeId(node),
          target,
          label: labelFor(targetArg, wraps),
          byArity: wraps.arity !== undefined,
          onThrow: wraps.throwParam !== undefined,
          scope: mountedScope,
        },
        pattern,
        sourceFile,
      ),
    );
  });

  return { candidates, unresolved };
}

/**
 * The wrapper each construction in `sourceFile` hands its constructor
 * under the option `wraps` asks for, `new OpenAPIHono({ defaultHook })`.
 * The construction is the subject, so the hook covers every route on
 * that app, wherever the route is registered. A construction this file
 * only received as a parameter is read by the file that wrote it.
 */
function discoverConstructorOptions(
  sourceFile: SourceFile,
  pattern: DiscoveryPattern,
  wraps: WrapperOptionRegistration,
  subjects: ReadonlyMap<string, Node>,
  resolution: ResolutionStore | undefined,
): WrapperScan {
  const candidates: WrapperCandidate[] = [];
  const unresolved: UnresolvedRegistration[] = [];
  const seen = new Set<string>();

  for (const construction of subjects.values()) {
    const subjectId = nodeId(construction);
    if (seen.has(subjectId) || construction.getSourceFile() !== sourceFile) {
      continue;
    }
    seen.add(subjectId);

    const option = constructorOptionOf(construction, wraps, resolution);
    if (option === undefined) {
      continue;
    }
    const callId = nodeId(option);
    const written = propertyValueOf(option);
    const target = propertyFunctionOf(option, resolution);
    if (target === null) {
      const stop = written === null ? null : factoryStopOf(written);
      if (stop !== null) {
        unresolved.push({ subjectId, callId, stop });
      }
      continue;
    }

    candidates.push(
      candidateOf(
        {
          subjectId,
          callId,
          target,
          label:
            (written === null ? undefined : factoryNameOf(written)) ??
            wraps.constructorOption,
          byArity: false,
          onThrow: wraps.throwParam !== undefined,
          scope: undefined,
        },
        pattern,
        sourceFile,
      ),
    );
  }

  return { candidates, unresolved };
}

/** The property under `wraps.constructorOption` in the construction's options object. */
function constructorOptionOf(
  construction: Node,
  wraps: WrapperOptionRegistration,
  resolution: ResolutionStore | undefined,
): Node | undefined {
  if (
    !(Node.isNewExpression(construction) || Node.isCallExpression(construction))
  ) {
    return undefined;
  }
  const optionsArg = construction.getArguments()[wraps.targetPosition];
  if (optionsArg === undefined) {
    return undefined;
  }
  const options = objectLiteralOf(optionsArg, resolution);
  if (options === null) {
    return undefined;
  }
  return propertiesOf(options, resolution).find(
    (property) => propertyNameOf(property) === wraps.constructorOption,
  );
}

/** One registration the scan settled on, before it becomes a candidate. */
interface SettledRegistration {
  subjectId: string;
  callId: string;
  target: FunctionRoot;
  /** What the wrapper goes by when the function has no name of its own. */
  label: string;
  byArity: boolean;
  onThrow: boolean;
  scope: string | undefined;
}

function candidateOf(
  registration: SettledRegistration,
  pattern: DiscoveryPattern,
  sourceFile: SourceFile,
): WrapperCandidate {
  const { target, label, onThrow, scope } = registration;
  const named = functionNameOrAnon(target) !== ANONYMOUS;
  return {
    subjectId: registration.subjectId,
    callId: registration.callId,
    targetId: nodeId(target),
    byArity: registration.byArity,
    target,
    pattern,
    registeredIn: sourceFile.getFilePath(),
    named,
    reference: {
      file: target.getSourceFile().getFilePath(),
      name: named ? functionNameOrAnon(target) : label,
      ...(onThrow ? { onThrow: true } : {}),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

/**
 * What a wrapper with no name of its own goes by: the factory that
 * returned it, `requireCaller` for `app.use(requireCaller(config))`,
 * since that is where a reader asking about a 401 wants to land. A
 * function written out at the registration goes by the method.
 */
function labelFor(targetArg: Node, wraps: WrapperMethodRegistration): string {
  return factoryNameOf(targetArg) ?? wraps.method;
}

function factoryNameOf(targetArg: Node): string | undefined {
  const written = factKeyOf(targetArg);
  if (!Node.isCallExpression(written)) {
    return undefined;
  }
  const callee = written.getExpression();
  if (Node.isIdentifier(callee)) {
    return callee.getText();
  }
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getName();
  }
  return undefined;
}

/**
 * The stop a registration leaves when the factory it calls could not be
 * followed to one function. A factory in a dependency leaves none, for
 * the reason the resolve README gives: `app.use(cors())` on every route
 * is volume, and the run already describes the dependency.
 */
function factoryStopOf(targetArg: Node): UnfollowedCall | null {
  const written = factKeyOf(targetArg);
  if (!Node.isCallExpression(written)) {
    return null;
  }
  const callee = factoryNameOf(targetArg);
  if (callee === undefined) {
    return null;
  }
  const reason = classifyStop(
    declarationsBehind(written.getExpression().getSymbol()),
  );
  if (!worthRecording(reason)) {
    return null;
  }
  return { callee, reason: "unresolvedWrapper" };
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
  wraps: WrapperMethodRegistration,
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
