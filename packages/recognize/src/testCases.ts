/**
 * Test cases as a runner collects them, read through the module ops every
 * adapter hands out. pytest writes a case as a function of the module, or
 * as a method of a class it collects by its name or by its ancestry, and
 * it collects a class written inside a collected class the same way,
 * under a title of its own.
 *
 * The reader says what each case is: its titles, the function it runs
 * and where that function is written. The adapter builds the unit.
 * `caseRuns` gives the reach walk each case with the functions the runner
 * calls before it. A module's own cases are the
 * functions and classes it declares at its top level, the last of two
 * with one name winning as it does in pytest. One it imports is not one.
 */

import { isListedTestFile, matchesTestFileName } from "@suss/extractor";
import { bySourceOrder } from "@suss/resolution";

import type {
  BeforeCase,
  ClassCases,
  ClassValueOps,
  ModuleOps,
  TestCasesMatch,
  ValueOps,
} from "@suss/extractor";

/** One title of a case. */
export interface CaseTitle {
  readonly text: string;
  /** Whether the reader could not settle the title and kept its source text. */
  readonly unresolved: boolean;
}

/** One case a runner collects. */
export interface FoundCase {
  /** The classes around the case, outermost first, then its own name. */
  readonly titles: readonly CaseTitle[];
  /** The function the case runs. */
  readonly runs: ValueOps;
  /** The function's key, which the unit is recorded at. */
  readonly at: string;
}

/** What the adapter hands the reader beside the match. */
export interface CaseReading {
  readonly module: ModuleOps;
}

/** A case, with the functions the runner calls before it, in the order it calls them. */
export interface CaseRun {
  readonly found: FoundCase;
  readonly before: readonly ValueOps[];
}

/** Whether the runner collects the file at all, whatever the PRDs list. */
export function collectsFile(match: TestCasesMatch, path: string): boolean {
  return matchesTestFileName(path, match.files.matching);
}

/** The cases the runner collects in one module, in source order, when the file is collected and listed. */
export function discoverTestCases(
  match: TestCasesMatch,
  module: ModuleOps,
): FoundCase[] {
  const path = module.path();
  if (
    !collectsFile(match, path) ||
    !isListedTestFile(path, match.files.listed)
  ) {
    return [];
  }
  return collectedIn(match, module).map((one) => one.found);
}

/**
 * Every case the runner collects in the module, whatever the PRDs list,
 * by its function's key, each with what runs before it. The reach walk
 * asks about each test function it reaches, so the adapter reads a file
 * once and keeps what it needs, rather than the ops.
 */
export function caseRuns(
  match: TestCasesMatch,
  read: CaseReading,
): ReadonlyMap<string, CaseRun> {
  if (!collectsFile(match, read.module.path())) {
    return new Map();
  }
  return new Map(
    collectedIn(match, read.module).map((one) => [
      one.found.at,
      { found: one.found, before: beforeCase(match, one, read.module) },
    ]),
  );
}

interface Collected {
  readonly found: FoundCase;
  /** The classes around the case, outermost first. */
  readonly classes: readonly ClassValueOps[];
}

function collectedIn(match: TestCasesMatch, module: ModuleOps): Collected[] {
  return [...functionCases(match, module), ...classCases(match, module)].sort(
    (a, b) => bySourceOrder(a.found.at, b.found.at),
  );
}

function functionCases(match: TestCasesMatch, module: ModuleOps): Collected[] {
  if (match.functions === undefined) {
    return [];
  }
  const pattern = new RegExp(match.functions.pattern);
  return module.exports().flatMap(({ name, value }) => {
    const fn = pattern.test(name) ? writtenFunction(value) : null;
    return fn === null ? [] : caseRunning(fn, [name], []);
  });
}

/** The function an export is itself, as a `def` is, and not one a name or a call gives it. */
function writtenFunction(value: ValueOps): ValueOps | null {
  const fn = value.function?.() ?? null;
  return fn !== null && fn.site?.() === value.site?.() ? fn : null;
}

function classCases(match: TestCasesMatch, module: ModuleOps): Collected[] {
  const classes = match.classes;
  if (classes === undefined) {
    return [];
  }
  const found: Collected[] = [];
  for (const cls of module.classes()) {
    const name = cls.name();
    if (name !== null && collectsClass(classes, name, cls)) {
      collectClass(classes, cls, [name], [], found);
    }
  }
  return found;
}

function collectClass(
  classes: ClassCases,
  cls: ClassValueOps,
  titles: readonly string[],
  around: readonly ClassValueOps[],
  found: Collected[],
): void {
  const within = [...around, cls];
  const methods = new RegExp(classes.methods.pattern);
  for (const member of cls.members("instance")) {
    if (methods.test(member.name)) {
      found.push(
        ...caseRunning(member.value, [...titles, member.name], within),
      );
    }
  }
  if (classes.nested !== true) {
    return;
  }
  for (const nested of cls.classes()) {
    const inner = nested.value.asClass?.() ?? null;
    if (inner !== null && collectsClass(classes, nested.name, inner)) {
      collectClass(classes, inner, [...titles, nested.name], within, found);
    }
  }
}

function collectsClass(
  classes: ClassCases,
  name: string,
  cls: ClassValueOps,
): boolean {
  return (
    (classes.named !== undefined && new RegExp(classes.named).test(name)) ||
    reachesCaseBase(classes, cls)
  );
}

function reachesCaseBase(classes: ClassCases, cls: ClassValueOps): boolean {
  return (classes.inherits ?? []).some((spec) => cls.inherits(spec));
}

/** A case is recorded at its function's key, so a function the adapter cannot key is no case. */
function caseRunning(
  fn: ValueOps,
  titles: readonly string[],
  classes: readonly ClassValueOps[],
): Collected[] {
  const at = fn.site?.();
  return at === undefined
    ? []
    : [
        {
          found: {
            titles: titles.map((text) => ({ text, unresolved: false })),
            runs: fn,
            at,
          },
          classes,
        },
      ];
}

/**
 * The module's functions first, then each class's methods from the
 * outermost class in. A class the runner collects by its ancestry runs
 * the methods listed for that, and any other class the ones listed for a
 * class collected by its name.
 */
function beforeCase(
  match: TestCasesMatch,
  collected: Collected,
  module: ModuleOps,
): ValueOps[] {
  const before: BeforeCase | undefined = match.before;
  if (before === undefined) {
    return [];
  }
  const inModule = [
    ...(before.module?.always ?? []),
    ...(collected.classes.length === 0
      ? (before.module?.forFunctions ?? [])
      : []),
  ];
  const fromModule = inModule.flatMap((name) => {
    const fn = moduleFunction(module, name);
    return fn === null ? [] : [fn];
  });
  const fromClasses = collected.classes.flatMap((cls) => {
    const names =
      match.classes !== undefined && reachesCaseBase(match.classes, cls)
        ? before.methods?.byAncestry
        : before.methods?.byName;
    return (names ?? []).flatMap((name) => {
      const method = cls.method(name, "instance");
      return method === null ? [] : [method];
    });
  });
  return [...fromModule, ...fromClasses];
}

function moduleFunction(module: ModuleOps, name: string): ValueOps | null {
  for (const exported of module.exports()) {
    const fn = exported.name === name ? writtenFunction(exported.value) : null;
    if (fn !== null) {
      return fn;
    }
  }
  return null;
}
