/**
 * Which functions each runtime runs, worked out from where it starts and
 * the calls those starts make, so an environment read is charged only to
 * the runtimes that reach it.
 *
 * A runtime starts at its handler, at the module-init unit of every file
 * its import closure loads, and at every unit a framework runs from a
 * file it loads, such as a route behind `Mangum(app)`. Only a call whose
 * function the source settles charges. What only a call through a table
 * reaches is listed as possibly reached, and the pairing reports it as
 * unchecked. The README beside this file says why a function in the
 * import closure is not charged for being there.
 */

import {
  entryFileAmong,
  readCodeScope,
  runsIn,
  sameProject,
  sameUnit,
  summaryFileKey,
} from "@suss/behavioral-ir";

import { functionOf, readCallFacts } from "../calls/callFacts.js";

import type {
  BehavioralSummary,
  CodeUnitKind,
  PlacedRuntime,
  UnitsByFile,
} from "@suss/behavioral-ir";
import type { FunctionKey } from "../calls/callFacts.js";

/** What one runtime runs, by function. */
export interface RuntimeCharge {
  /** The functions its starts reach through calls the source settles, the starts included. */
  charged: ReadonlySet<FunctionKey>;
  /** The functions it reaches only through a call that may run another one instead. */
  possibly: ReadonlySet<FunctionKey>;
  /** Whether a handler starts it, so a report can say why a read went unreached. */
  hasHandler: boolean;
}

/**
 * The units a framework calls into once the file that registers them is
 * loaded. A library function, a client call site and a test are called
 * by other code, and a component runs in a browser, so none of them
 * starts a runtime on its own.
 */
const FRAMEWORK_RUNS: Record<CodeUnitKind, boolean> = {
  handler: true,
  loader: true,
  action: true,
  middleware: true,
  resolver: true,
  worker: true,
  consumer: true,
  "scheduled-callback": true,
  library: false,
  client: false,
  caller: false,
  component: false,
  hook: false,
  "module-init": false,
  test: false,
};

/** Each placed runtime's charge, from one reach question over every start. */
export function chargeRuntimes(
  code: readonly BehavioralSummary[],
  placed: readonly PlacedRuntime[],
  byFile: UnitsByFile,
  contested: ReadonlySet<string>,
): Map<PlacedRuntime, RuntimeCharge> {
  const charges = new Map<PlacedRuntime, RuntimeCharge>();
  if (placed.length === 0) {
    return charges;
  }
  const startsOf = new Map(
    placed.map((runtime) => [
      runtime,
      startsFor(runtime, code, byFile, contested),
    ]),
  );
  const allStarts = new Set(
    [...startsOf.values()].flatMap((starts) => [...starts.keys]),
  );
  const facts = readCallFacts(code);
  const certain = facts.reachedFromEach(allStarts, {
    certainOnly: true,
    paths: false,
  });
  // Without a call through a table the second question has the same answer.
  const anyCall = code.some(makesPossibleCall)
    ? facts.reachedFromEach(allStarts, { paths: false })
    : certain;

  for (const [runtime, starts] of startsOf) {
    const charged = new Set(starts.keys);
    const possibly = new Set<FunctionKey>();
    for (const start of starts.keys) {
      for (const reached of certain.get(start)?.functions.keys() ?? []) {
        charged.add(reached);
      }
      for (const reached of anyCall.get(start)?.functions.keys() ?? []) {
        possibly.add(reached);
      }
    }
    for (const key of charged) {
      possibly.delete(key);
    }
    charges.set(runtime, {
      charged,
      possibly,
      hasHandler: starts.hasHandler,
    });
  }
  return charges;
}

function makesPossibleCall(summary: BehavioralSummary): boolean {
  return summary.transitions.some((transition) =>
    transition.effects.some(
      (effect) =>
        effect.type === "invocation" &&
        (effect.possibleSummaries?.length ?? 0) > 0,
    ),
  );
}

interface Starts {
  keys: Set<FunctionKey>;
  hasHandler: boolean;
}

function startsFor(
  placed: PlacedRuntime,
  code: readonly BehavioralSummary[],
  byFile: UnitsByFile,
  contested: ReadonlySet<string>,
): Starts {
  const { scope } = placed;
  const declared = scope.unit;
  const handlers = code.filter((summary) => {
    const own = summary.identity.deployableUnit;
    return (
      own !== undefined && declared !== undefined && sameUnit(own, declared)
    );
  });
  const named = handlers.length > 0 ? [] : namedByEntryExport(placed, code);
  const loaded = (summary: BehavioralSummary): boolean => {
    const key = summaryFileKey(summary);
    if (contested.has(key)) {
      return false;
    }
    return scope.closure?.has(key) ?? runsIn(summary, scope, byFile);
  };
  const runByFramework = code.filter(
    (summary) =>
      FRAMEWORK_RUNS[summary.kind] &&
      summary.identity.deployableUnit === undefined &&
      runsIn(summary, scope, byFile) &&
      !contested.has(summaryFileKey(summary)),
  );
  const moduleInits = code.filter(
    (summary) => summary.kind === "module-init" && loaded(summary),
  );
  return {
    keys: new Set(
      [...handlers, ...named, ...runByFramework, ...moduleInits].map(
        functionOf,
      ),
    ),
    hasHandler: handlers.length > 0 || named.length > 0,
  };
}

/**
 * The function a runtime's template says is its handler, found by its
 * name in the entry file. A pack that discovered the handler stamps it
 * with the runtime's unit instead, so this is for a runtime no pack
 * placed, such as one a Terraform configuration declares.
 */
function namedByEntryExport(
  placed: PlacedRuntime,
  code: readonly BehavioralSummary[],
): BehavioralSummary[] {
  const { entry, entryExport, workspace } = readCodeScope(placed.runtime);
  if (entry === undefined || entryExport === undefined) {
    return [];
  }
  return code.filter(
    (summary) =>
      sameProject(summary.location.workspace, workspace) &&
      entryFileAmong(entry, [summary.location.file]) !== undefined &&
      exportsAs(summary, entryExport),
  );
}

/** Whether a summary is the function a template spells as `name`, as `handler` or `Reports::Nightly.run`. */
function exportsAs(summary: BehavioralSummary, name: string): boolean {
  const path = summary.identity.exportPath;
  if (path !== undefined && path !== null && path.join(".") === name) {
    return true;
  }
  return summary.identity.name === name;
}
