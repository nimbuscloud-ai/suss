/**
 * Pointing each recorded call at the summary it reaches.
 *
 * An adapter that followed a call knows where the callee is declared
 * and writes that on the effect as `declaredAt`. The summary of the
 * unit declared there is the one the call reaches, so the link is a
 * join on location, which needs nothing from the language the adapter
 * read. Once the link is written the offsets have served their purpose
 * and come off the effect, so every adapter's output spells a reached
 * call the same way and the CLI reads one field.
 */

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
 * A place in a file by character offsets, spelled the one way every
 * writer of `declaredAt` and every reader of `location.span` agrees on.
 */
export function declarationKey(
  file: string,
  span: { start: number; end: number },
): string {
  return `${file}:${span.start}-${span.end}`;
}

/** Say on each invocation effect where its callee is declared, so the link step can find the summary there. */
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
      const target = targets.get(effect.callee);
      if (target !== undefined) {
        effect.declaredAt = target;
      }
    }
  }
}

/**
 * Say on each invocation effect where an identifier argument that is
 * itself a project function is declared, keyed by its position among
 * the call's arguments. `linkArgs` later turns each entry into
 * `argsSummary`, the same way `placeCalls` feeds `declaredAt` into
 * `linkCallsToSummaries`. Shared by every adapter that follows an
 * argument passed by name into a call: matching the effect by callee
 * text and writing a location is language-independent once the walk
 * has resolved the argument to a declaration.
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
      const byPosition = argTargets.get(effect.callee);
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
 * Say on each invocation effect which of the scanned unit's own
 * parameters it calls. A caller elsewhere that passes a function into
 * that position joins to this call by it.
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
      callee,
      parameterIndex,
    ]),
  );
  for (const transition of summary.transitions) {
    for (const effect of transition.effects) {
      if (effect.type !== "invocation") {
        continue;
      }
      const parameterIndex = byCallee.get(effect.callee);
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
 * A call the adapter placed says where its callee is declared, and the
 * summary of the unit declared there is the one it reaches. A callee
 * declared outside the run has no summary there and gets no link,
 * whatever else in the run shares its name. Only a call the adapter
 * could not place at all is matched by name, and then only against the
 * summaries in its own file, since that is where an unqualified call
 * usually goes. Two summaries with one name leave the call saying only
 * what it said before: a reader can see a missing link, and cannot see
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
 * link goes to a provider, since that is the id callers know it by,
 * else to the first one written.
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
