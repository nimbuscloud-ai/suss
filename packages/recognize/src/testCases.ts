/**
 * Test cases as a runner collects them, read through the module ops every
 * adapter hands out. pytest writes a case as a function of the module, or
 * as a method of a class it collects by its name or by its ancestry, and
 * it collects a class written inside a collected class the same way,
 * under a title of its own. vitest writes its cases as calls.
 *
 * The reader says what each case is: its titles, the function it runs
 * and where that function is written. The adapter builds the unit.
 * `caseRuns` gives the reach walk each case with the functions the runner
 * calls before it. A module's own cases are the functions and classes it
 * declares at its top level, the last of two with one name winning as in
 * pytest. One it imports is not one.
 */

import { isListedTestFile, matchesTestFileName } from "@suss/extractor";
import { bySourceOrder } from "@suss/resolution";

import { callCases } from "./caseCalls.js";

import type {
  BeforeCase,
  CallOps,
  ClassCases,
  ClassValueOps,
  Decorator,
  MockRule,
  ModuleOps,
  Patchers,
  ReceiverOrigin,
  SkipRules,
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
  /** The classes or groups around the case, outermost first, then its own title. */
  readonly titles: readonly CaseTitle[];
  /** The function the case runs, or null for a case written as a call that passes none, such as `it.todo("later")`. */
  readonly runs: ValueOps | null;
  /** The key the unit is recorded at: the function's, or for a case written as a call, the call's. */
  readonly at: string;
  /**
   * What is written on the case: the function's decorators, then for
   * each class around it, innermost first, its decorators and the
   * markers its `skips.decorators.variable` lists, then the module's.
   */
  readonly markers: readonly Decorator[];
  readonly skipped: boolean;
  /** The mock calls the reader finds in force for the case. Only the calls form reads them here. */
  readonly mocks: readonly FoundMock[];
}

/** A call that replaces something before a case runs, and what it replaces. */
export interface FoundMock {
  readonly call: CallOps;
  readonly read: MockRead;
}

/** Whether the decorator, or what a marker variable lists, comes from one of the origins: a call by its callee. */
export function decoratorIsFrom(
  decorator: Decorator,
  origins: readonly ReceiverOrigin[],
): boolean {
  if (decorator.form === "call") {
    return origins.some((origin) => decorator.call.isFrom(origin));
  }
  return origins.some((origin) => valueIsFrom(decorator.value, origin));
}

/** What a patcher replaces: the object at a dotted path, or a member of the argument at a position. */
export type MockRead =
  | { readonly replaces: "path"; readonly path: string }
  | {
      readonly replaces: "member";
      readonly member: string;
      readonly of: number;
    };

/**
 * What the call replaces, by the first mock rule whose patchers it is
 * one of and whose argument it writes as a string, or null. `takes` says
 * whether the function the call is written in, or the case it patches,
 * takes a parameter by that name, for a patcher a fixture hands it.
 */
export function mockRead(
  rules: readonly MockRule[],
  call: CallOps,
  takes: (parameter: string) => boolean,
): MockRead | null {
  for (const rule of rules) {
    const read = MOCK_READS[mockKind(rule)](rule as never, call, takes);
    if (read !== null) {
      return read;
    }
  }
  return null;
}

type MockKind = "replacesModule" | "replacesMember";

function mockKind(rule: MockRule): MockKind {
  return "replacesModule" in rule ? "replacesModule" : "replacesMember";
}

const MOCK_READS: {
  readonly [K in MockKind]: (
    rule: Extract<MockRule, Record<K, unknown>>,
    call: CallOps,
    takes: (parameter: string) => boolean,
  ) => MockRead | null;
} = {
  replacesModule: ({ replacesModule: { by, path } }, call, takes) => {
    const text = patches(by, call, takes) ? stringAt(call, path.at) : null;
    return text === null ? null : { replaces: "path", path: text };
  },
  replacesMember: ({ replacesMember: { by, member, of } }, call, takes) => {
    const name = patches(by, call, takes) ? stringAt(call, member.at) : null;
    return name === null
      ? null
      : { replaces: "member", member: name, of: of.at };
  },
};

function patches(
  by: Patchers,
  call: CallOps,
  takes: (parameter: string) => boolean,
): boolean {
  if ((by.from ?? []).some((origin) => call.isFrom(origin))) {
    return true;
  }
  const [root, ...rest] = call.calleeText().split(".");
  const method = rest.join(".");
  return (by.handed ?? []).some(
    (one) =>
      one.parameter === root && one.methods.includes(method) && takes(root),
  );
}

function stringAt(call: CallOps, at: number): string | null {
  const value = call.valueAt(at)?.evaluated?.() ?? null;
  return typeof value === "string" ? value : null;
}

/** A global is a path through the module's imports, `pytest.mark.skip`; any other origin is read off the call the value is. */
function valueIsFrom(value: ValueOps, origin: ReceiverOrigin): boolean {
  if (origin.origin === "global") {
    return value.globalPath?.(origin.paths) !== undefined;
  }
  return value.asCall?.()?.isFrom(origin) ?? false;
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
  return [
    ...collectedIn(match, module).map((one) => one.found),
    ...callCases(match, module),
  ].sort((a, b) => bySourceOrder(a.at, b.at));
}

/**
 * Every case the runner collects in the module, whatever the PRDs list,
 * by its function's key, each with what runs before it. The reach walk
 * asks about each test function it reaches, so the adapter reads a file
 * once and keeps what it needs, rather than the ops. A case written as a
 * call is left out, since its key is the call's.
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
  readonly classes: readonly CaseClass[];
}

/** A class a case is written in, and the class as a value, for its decorators and what its body assigns. */
interface CaseClass {
  readonly cls: ClassValueOps;
  readonly value: ValueOps | null;
}

function collectedIn(match: TestCasesMatch, module: ModuleOps): Collected[] {
  const found = [
    ...functionCases(match, module),
    ...classCases(match, module),
  ].sort((a, b) => bySourceOrder(a.found.at, b.found.at));
  if (found.length === 0) {
    return found;
  }
  const decorators = decoratorsBySite(module);
  const variable = match.skips?.decorators?.variable;
  const listedIn = (value: ValueOps | null | undefined): Decorator[] =>
    variable === undefined || value === null || value === undefined
      ? []
      : markersListed(value);
  const inModule = listedIn(
    variable === undefined ? null : module.export([variable]),
  );
  return found.map((one) => {
    const markers = [
      ...(decorators.get(one.found.at) ?? []),
      ...[...one.classes]
        .reverse()
        .flatMap((around) => [
          ...(decorators.get(around.value?.site?.() ?? "") ?? []),
          ...listedIn(
            variable === undefined ? null : around.value?.member?.(variable),
          ),
        ]),
      ...inModule,
    ];
    return {
      ...one,
      found: { ...one.found, markers, skipped: skips(match.skips, markers) },
    };
  });
}

function decoratorsBySite(
  module: ModuleOps,
): ReadonlyMap<string, readonly Decorator[]> {
  const bySite = new Map<string, readonly Decorator[]>();
  for (const { definition, decorators } of module.decorated()) {
    const site = definition.site?.();
    if (site !== undefined) {
      bySite.set(site, decorators);
    }
  }
  return bySite;
}

/** A marker variable set to a list gives each item, and set to anything else gives that one value. */
function markersListed(value: ValueOps): Decorator[] {
  const items = value.items();
  return (items.length > 0 ? items : [value]).map((item) => {
    const call = item.asCall?.() ?? null;
    return call === null
      ? { form: "value", value: item }
      : { form: "call", call };
  });
}

function skips(rules: SkipRules | undefined, markers: readonly Decorator[]) {
  const origins = rules?.decorators?.origins;
  return (
    origins !== undefined &&
    markers.some((marker) => decoratorIsFrom(marker, origins))
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
      const value = module.export([name]);
      collectClass(classes, { cls, value }, [name], [], found);
    }
  }
  return found;
}

function collectClass(
  classes: ClassCases,
  written: CaseClass,
  titles: readonly string[],
  around: readonly CaseClass[],
  found: Collected[],
): void {
  const { cls } = written;
  const within = [...around, written];
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
      collectClass(
        classes,
        { cls: inner, value: nested.value },
        [...titles, nested.name],
        within,
        found,
      );
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
  return cls.inherits(classes.inherits ?? []);
}

/** A case is recorded at its function's key, so a function the adapter cannot key is no case. */
function caseRunning(
  fn: ValueOps,
  titles: readonly string[],
  classes: readonly CaseClass[],
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
            markers: [],
            skipped: false,
            mocks: [],
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
  const fromClasses = collected.classes.flatMap(({ cls }) => {
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
