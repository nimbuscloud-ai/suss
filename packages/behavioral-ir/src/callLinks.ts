/**
 * Pointing each recorded call at the summary it reaches.
 *
 * An adapter that followed a call knows where the callee is declared
 * and writes that on the effect as `declaredAt`. The summary of the
 * unit declared there is the one the call reaches, so the link is a
 * join on location, which needs nothing from the language the adapter
 * read. Once the link is written the offsets are removed from the
 * effect, so every adapter writes a reached call the same way and the
 * CLI reads one field.
 */

import { normalizeCalleeText } from "./effectIdentity.js";
import { BOUNDARY_ROLE } from "./index.js";
import { summaryIdentifier } from "./summaryId.js";
import { unfollowedCallGap } from "./unfollowedCall.js";

import type { BehavioralSummary, Effect } from "./index.js";

type InvocationEffect = Extract<Effect, { type: "invocation" }>;

/** Where a call's callee is declared, as an adapter wrote it on the effect. */
export type DeclaredAt = NonNullable<InvocationEffect["declaredAt"]>;

/** A call, made through one of the scanned unit's own parameters, to record on its matching invocation effect. */
export interface ParameterCall {
  readonly callee: string;
  readonly parameterIndex: number;
}

/**
 * A place in a file by character offsets, in the one format that
 * writers of `declaredAt` and readers of `location.span` share.
 */
export function declarationKey(
  file: string,
  span: { start: number; end: number },
): string {
  return `${file}:${span.start}-${span.end}`;
}

/** Record on each invocation effect where its callee is declared, so the link step can find the summary there. */
export function placeCalls(
  summary: BehavioralSummary,
  targets: ReadonlyMap<string, DeclaredAt> | undefined,
): void {
  if (targets === undefined) {
    return;
  }
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "invocation") {
        continue;
      }
      const target = targets.get(normalizeCalleeText(effect.callee));
      if (target !== undefined) {
        effect.declaredAt = target;
      }
    }
  }
}

/**
 * Where a scanned body's calls, and the arguments passed by name into
 * them, are declared. A walk fills it with `place` and `placeArg` as it
 * visits each call, and reads it back through `targets` and
 * `argTargets` when it finishes, in the form `placeCalls` and
 * `placeArgTargets` take. Every adapter's reachable-closure walk uses
 * it, so the rule for a shadowed name is defined once.
 */
export class TargetPlacements {
  private readonly byCallee = new Map<string, DeclaredAt | null>();
  private readonly byCalleeAndPosition = new Map<
    string,
    Map<number, DeclaredAt | null>
  >();

  /**
   * Record where a callee is declared. When one callee text is placed at
   * two declarations, as with a shadowed name, neither is kept.
   */
  place(calleeText: string, placed: DeclaredAt | null): void {
    if (placed === null) {
      return;
    }
    settle(this.byCallee, normalizeCalleeText(calleeText), placed);
  }

  // Same shadow handling as `place`, one level down: the argument at
  // this position in calls written as `calleeText`.
  placeArg(calleeText: string, position: number, placed: DeclaredAt): void {
    const key = normalizeCalleeText(calleeText);
    const byPosition = this.byCalleeAndPosition.get(key) ?? new Map();
    this.byCalleeAndPosition.set(key, byPosition);
    settle(byPosition, position, placed);
  }

  /** Every callee text placed at exactly one declaration, as `placeCalls` takes it. */
  get targets(): ReadonlyMap<string, DeclaredAt> {
    return onlySettled(this.byCallee);
  }

  /** Every callee text's argument positions placed at exactly one declaration, as `placeArgTargets` takes them. */
  get argTargets(): ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>> {
    const settled = new Map<string, ReadonlyMap<number, DeclaredAt>>();
    for (const [calleeText, byPosition] of this.byCalleeAndPosition) {
      const positions = onlySettled(byPosition);
      if (positions.size > 0) {
        settled.set(calleeText, positions);
      }
    }
    return settled;
  }
}

function settle<K>(
  map: Map<K, DeclaredAt | null>,
  key: K,
  placed: DeclaredAt,
): void {
  const known = map.get(key);
  if (known === undefined) {
    map.set(key, placed);
    return;
  }
  if (
    known !== null &&
    declarationKey(known.file, known.span) !==
      declarationKey(placed.file, placed.span)
  ) {
    map.set(key, null);
  }
}

function onlySettled<K>(
  map: ReadonlyMap<K, DeclaredAt | null>,
): ReadonlyMap<K, DeclaredAt> {
  const out = new Map<K, DeclaredAt>();
  for (const [key, value] of map) {
    if (value !== null) {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * Record on each invocation effect where an identifier argument that is
 * itself a project function is declared, keyed by its position among
 * the call's arguments. `linkArgs` later turns each entry into
 * `argsSummary`, the same way `placeCalls` feeds `declaredAt` into
 * `linkCallsToSummaries`. Every adapter that follows an argument passed
 * by name uses this, because once the walk has resolved the argument,
 * matching the effect by callee text is the same in every language.
 */
export function placeArgTargets(
  summary: BehavioralSummary,
  argTargets: ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>> | undefined,
): void {
  if (argTargets === undefined) {
    return;
  }
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "invocation") {
        continue;
      }
      const byPosition = argTargets.get(normalizeCalleeText(effect.callee));
      if (byPosition === undefined) {
        continue;
      }
      const argsDeclaredAt: Record<string, DeclaredAt> = {};
      for (const [position, target] of byPosition) {
        argsDeclaredAt[String(position)] = target;
      }
      if (Object.keys(argsDeclaredAt).length > 0) {
        effect.argsDeclaredAt = argsDeclaredAt;
      }
    }
  }
}

/**
 * Record on each invocation effect which of the scanned unit's own
 * parameters it calls. A caller elsewhere that passes a function into
 * that position is joined to this call through it.
 */
export function placeCalleeParameters(
  summary: BehavioralSummary,
  parameterCalls: readonly ParameterCall[] | undefined,
): void {
  if (parameterCalls === undefined) {
    return;
  }
  const byCallee = new Map(
    parameterCalls.map(({ callee, parameterIndex }) => [
      normalizeCalleeText(callee),
      parameterIndex,
    ]),
  );
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "invocation") {
        continue;
      }
      const parameterIndex = byCallee.get(normalizeCalleeText(effect.callee));
      if (parameterIndex !== undefined) {
        effect.calleeParameter = parameterIndex;
      }
    }
  }
}

/**
 * A call through one of a unit's own parameters is a gap only once the
 * whole run is scanned and nothing anywhere passes a function into
 * that position: until then it is the ordinary `callerSupplied` stop,
 * which nothing records. `key` identifies a scanned unit the same way
 * across `parameterCallsByKey`, `summariesByKey`, and the position
 * strings in `passedPositions`, whatever scheme an adapter's own walk
 * uses to key a unit.
 */
export function recordParameterGaps(
  parameterCallsByKey: ReadonlyMap<string, readonly ParameterCall[]>,
  summariesByKey: ReadonlyMap<string, BehavioralSummary[]>,
  passedPositions: ReadonlySet<string>,
): void {
  for (const [key, parameterCalls] of parameterCallsByKey) {
    const unbound = parameterCalls.filter(
      ({ parameterIndex }) => !passedPositions.has(`${key}#${parameterIndex}`),
    );
    if (unbound.length === 0) {
      continue;
    }
    for (const summary of summariesByKey.get(key) ?? []) {
      summary.gaps.push(
        ...unbound.map(({ callee }) =>
          unfollowedCallGap({ callee, reason: "unboundParameter" }),
        ),
      );
    }
  }
}

/**
 * Point each call at the summary it reaches, and drop `declaredAt`.
 *
 * A call the adapter placed records where its callee is declared, and
 * the summary of the unit declared there is the one it reaches. A
 * callee declared outside the run has no summary there and gets no
 * link, whatever else in the run shares its name. Only a call the
 * adapter could not place at all is matched by name, and then only
 * against the summaries in its own file, since that is where an
 * unqualified call usually goes. When two summaries share the name, the
 * call stays unlinked, since a reader can notice a missing link but not
 * a wrong one.
 */
export function linkCallsToSummaries(summaries: BehavioralSummary[]): void {
  const byLocation = new Map<string, BehavioralSummary[]>();
  const byFileAndName = new Map<string, BehavioralSummary[]>();

  for (const summary of summaries) {
    // A label is there for the reader and nothing in the code can call
    // it, so a callee segment that matches one is a coincidence.
    if (summary.identity.nameKind === "label") {
      continue;
    }

    if (summary.location.span !== undefined) {
      remember(
        byLocation,
        declarationKey(summary.location.file, summary.location.span),
        summary,
      );
    }
    remember(
      byFileAndName,
      `${summary.location.file}::${summary.identity.name}`,
      summary,
    );
  }

  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation") {
          continue;
        }
        const reached = summaryReachedBy(
          effect,
          summary.location.file,
          byLocation,
          byFileAndName,
        );
        delete effect.declaredAt;
        if (reached !== null) {
          effect.summary = summaryIdentifier(reached);
        }
        linkArgs(effect, byLocation);
      }
    }
  }
}

/**
 * The same link, per argument position: an argument that is itself a
 * project function reaches the summary declared there, by the same
 * location join `declaredAt` uses for the callee.
 */
function linkArgs(
  effect: InvocationEffect,
  byLocation: ReadonlyMap<string, BehavioralSummary[]>,
): void {
  if (effect.argsDeclaredAt === undefined) {
    return;
  }
  const argsSummary: Record<string, string> = {};
  for (const [position, target] of Object.entries(effect.argsDeclaredAt)) {
    const reached = summaryAtPlace(
      byLocation.get(declarationKey(target.file, target.span)) ?? [],
    );
    if (reached !== null) {
      argsSummary[position] = summaryIdentifier(reached);
    }
  }
  delete effect.argsDeclaredAt;
  if (Object.keys(argsSummary).length > 0) {
    effect.argsSummary = argsSummary;
  }
}

function remember(
  index: Map<string, BehavioralSummary[]>,
  key: string,
  summary: BehavioralSummary,
): void {
  const found = index.get(key);
  if (found === undefined) {
    index.set(key, [summary]);
    return;
  }
  found.push(summary);
}

function summaryReachedBy(
  effect: InvocationEffect,
  callerFile: string,
  byLocation: ReadonlyMap<string, BehavioralSummary[]>,
  byFileAndName: ReadonlyMap<string, BehavioralSummary[]>,
): BehavioralSummary | null {
  const declaredAt = effect.declaredAt;
  if (declaredAt !== undefined) {
    return summaryAtPlace(
      byLocation.get(declarationKey(declaredAt.file, declaredAt.span)) ?? [],
    );
  }
  // A method call includes its receiver, and the last segment is the
  // function, which is what a summary is named after.
  const called = effect.callee.split(".").pop() ?? effect.callee;
  return onlyAnswer(byFileAndName, `${callerFile}::${called}`);
}

/**
 * Every summary at one place describes the same body: a function
 * exported through two packages has a provider summary per package,
 * and one that also calls out has a consumer summary beside them. The
 * link goes to a provider, because callers know the function by the
 * provider's id, and otherwise to the first summary.
 */
function summaryAtPlace(found: BehavioralSummary[]): BehavioralSummary | null {
  const provider = found.find(
    (summary) => BOUNDARY_ROLE[summary.kind] === "provider",
  );
  return provider ?? found[0] ?? null;
}

function onlyAnswer(
  index: ReadonlyMap<string, BehavioralSummary[]>,
  key: string,
): BehavioralSummary | null {
  const found = index.get(key) ?? [];
  return found.length === 1 ? (found[0] as BehavioralSummary) : null;
}
