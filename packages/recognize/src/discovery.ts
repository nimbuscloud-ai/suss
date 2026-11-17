/**
 * The discovery patterns every adapter reads the same way. A pack states
 * where a unit's function is (a deploy manifest, an export, a class
 * reaching a library base, a directive, a registration call) and this
 * reader finds it through the module ops over each adapter's facts, so
 * one declaration finds the same units in TypeScript, Python and Ruby.
 *
 * Every reader ends the same way: a value whose `function()` settles to
 * one function, handed back as the adapter's own node so the adapter
 * builds the unit on it the way it builds any other. An entry object's
 * members have no function, so it hands back the values instead. A unit
 * a class-body call declares has a function only when what the call
 * runs is found, and hands the call back in `namedBy`.
 */

import picomatch from "picomatch";

import { lastValueWins } from "@suss/extractor";

import { isWrittenOnSelf } from "./classBody.js";
import { readRouteTable } from "./routeTableDiscovery.js";

import type {
  AstCapableValueOps,
  CallOps,
  ClassValueOps,
  DeclaredDiscoveryMatch,
  DecoratedMatch,
  Decorator,
  DiscoveredCustomUnit,
  EntryMember,
  EntryObject,
  EntryObjectMatch,
  ManifestEntry,
  MarkedMatch,
  MemberPick,
  ModuleOps,
  NamedExportMatch,
  NamingCall,
  ReceiverOrigin,
  RegisteredFunctionMatch,
  RunsPick,
  SubclassOfMatch,
  UnitSpec,
  ValueEntry,
  ValueOps,
} from "@suss/extractor";

/**
 * A unit a declared pattern found. `foundAt` is the path of names from
 * the top of the file to the function, the export and then each member,
 * which Python and Ruby give a unit as its export path. Null for a
 * function no export leads to. A `decorated` pattern says which decorator
 * it found the unit under in `decoratedBy`.
 */
export interface DeclaredUnit extends DiscoveredCustomUnit {
  readonly foundAt: readonly string[] | null;
  readonly decoratedBy?: DecoratedBy;
  readonly namedBy?: NamedBy;
}

/**
 * The call in a class body a `subclassOf` pattern found a unit under,
 * for an adapter that reads the rest of what the call declares. The
 * unit's `func` is the method it runs, or null when no pick found one.
 */
export interface NamedBy {
  /** The call, the last one in the body under the unit's name. */
  readonly call: CallOps;
  /** The class whose body writes the call. */
  readonly cls: ClassValueOps;
  /** The class's part of the unit's name. */
  readonly className: string;
  /** The unit's own part of its name, after the call's naming, or the argument's source when the name does not settle. */
  readonly name: string;
  /** Whether the argument settles to a name. One that does not runs nothing. */
  readonly settled: boolean;
  /** The first pick the call writes, or null when none applies. */
  readonly runs: RunsFound | null;
}

/** What one of a naming call's `runs` picks found. */
export interface RunsFound {
  readonly pick: RunsPick;
  /** The keyword the pick read, `mutation` or `resolver_method`, or null for a pick of the unit's own name. */
  readonly keyword: string | null;
  /** The value written under that keyword: the class a `classAt` pick refers to, or the method's name. */
  readonly written: ValueOps | null;
  /** The name of the method the pick looked for, or null when the keyword's value does not settle to one. */
  readonly methodName: string | null;
  /** The method, or null when no class the pick reached defines it, or the class is not one the run read. */
  readonly method: ValueOps | null;
}

/** The decorator a `decorated` pattern found a unit under. */
export interface DecoratedBy {
  /** The decorator's method, `middleware` in `@app.middleware("http")`. */
  readonly method: string;
  readonly decorator: Decorator;
  /** The value the method is called on, as the source writes it: `app`. */
  readonly receiver: ValueOps;
  /** The call that value was written as, which the pattern's `on` accepted: `FastAPI()`. */
  readonly on: CallOps;
}

/** The units a declared pattern finds in one module. `kind` is the pattern's own, for a unit the match builds without a spec. */
export function discoverDeclared(
  match: DeclaredDiscoveryMatch,
  kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  return (READERS[match.type] as Reader<DeclaredDiscoveryMatch>)(
    match,
    kind,
    module,
  );
}

/**
 * The entry export and the members beside it, when the module's entry
 * comes to an object with the target. Null for a module with no such
 * entry.
 */
export function discoverEntryObject(
  match: EntryObjectMatch,
  module: ModuleOps,
): EntryObject | null {
  const exported = module.exports();
  for (const { name, value } of exported) {
    const entry = name === match.entry ? (value.object?.() ?? null) : null;
    const target = entry?.property(match.target) ?? null;
    if (entry === null || target === null) {
      continue;
    }
    const shared = inputsOf(entry, match.inputs);
    const members = exported.flatMap((member): EntryMember[] => {
      const object =
        member.name === match.entry ? null : (member.value.object?.() ?? null);
      return object === null
        ? []
        : [
            {
              name: member.name,
              line: member.line,
              value: object,
              inputs: lastValueWins([
                ...shared,
                ...inputsOf(object, match.inputs),
              ]),
            },
          ];
    });
    return { entry, target, members };
  }
  return null;
}

/** The entries of the object under `name`, the ones whose key the source settles. */
function inputsOf(
  object: ValueOps,
  name: string,
): (ValueEntry & { readonly key: string })[] {
  return (object.property(name)?.object?.()?.entries("nothing") ?? []).filter(
    (entry): entry is ValueEntry & { readonly key: string } =>
      entry.key !== null,
  );
}

type Reader<M extends DeclaredDiscoveryMatch> = (
  match: M,
  kind: string,
  module: ModuleOps,
) => DeclaredUnit[];

const READERS: {
  readonly [T in DeclaredDiscoveryMatch["type"]]: Reader<
    Extract<DeclaredDiscoveryMatch, { type: T }>
  >;
} = {
  manifest: readManifest,
  namedExport: readNamedExports,
  subclassOf: readSubclasses,
  marked: readMarked,
  registeredFunction: readRegistrations,
  decorated: readDecorated,
  routeTable: readRouteTable,
};

function readManifest(
  match: { entries: (filePath: string) => ManifestEntry[] },
  _kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  return match.entries(module.path()).flatMap((entry) => {
    const func = nodeOfFunction(entryValue(module, entry));
    const foundAt =
      entry.member === undefined
        ? entry.path
        : [...entry.path, entry.member.name];
    return func === null
      ? []
      : entry.units.map((spec) => built(spec, func, foundAt));
  });
}

/** The value a manifest entry spells: the export, each member inside it, then the method it gives. */
function entryValue(module: ModuleOps, entry: ManifestEntry): ValueOps | null {
  return module.export(entry.path, entry.member);
}

function readNamedExports(
  match: NamedExportMatch,
  kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  if (inSkippedFile(module.path(), match.skipFiles)) {
    return [];
  }
  const takes = nameFilter(match.names, match.pattern);
  return module
    .exports()
    .filter((exported) => takes(exported.name))
    .flatMap(({ name, value }) => {
      if (match.members !== undefined) {
        return memberUnits(name, value, match.members);
      }
      const found = value.function?.() ?? null;
      if (found === null || !endsIn(found, match.bodyEndsIn)) {
        return [];
      }
      const func = nodeOfFunction(found);
      return func === null ? [] : [{ func, kind, name, foundAt: [name] }];
    });
}

/** Whether the function returns a value written in the form, when the pattern asks for one. */
function endsIn(
  found: ValueOps,
  form: NamedExportMatch["bodyEndsIn"],
): boolean {
  if (form === undefined) {
    return true;
  }
  return (found.returns?.() ?? []).some(
    (returned) => returned.form?.() === form,
  );
}

/** One unit per listed member the exported object states a function under, the first under each name. */
function memberUnits(
  exported: string,
  value: ValueOps,
  pick: MemberPick,
): DeclaredUnit[] {
  const object = value.object?.() ?? null;
  if (object === null) {
    return [];
  }
  const units: DeclaredUnit[] = [];
  const taken = new Set<string>();
  for (const { key, value: held } of object.entries("nothing")) {
    const spec = key === null ? undefined : pick.named[key];
    if (key === null || spec === undefined || taken.has(key)) {
      continue;
    }
    const func = nodeOfFunction(held);
    if (func !== null) {
      taken.add(key);
      units.push(built(spec, func, [exported, key]));
    }
  }
  return units;
}

/**
 * The exported classes, then each class in `classes()` whose `name()` no
 * export has. Only Ruby gives a class a name of its own, as
 * `Billing::Nightly` inside `module Billing`. TypeScript and Python give
 * a class the name it is exported under, or none.
 */
function readSubclasses(
  match: SubclassOfMatch,
  kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  const exported = module.exports();
  const exportedNames = new Set(exported.map(({ name }) => name));
  const fromExports = exported.flatMap(({ name, value }) => {
    const cls = value.asClass?.() ?? null;
    return cls === null ? [] : subclassUnits(match, kind, name, cls);
  });
  const nested = module.classes().flatMap((cls) => {
    const name = cls.name();
    return name === null || exportedNames.has(name)
      ? []
      : subclassUnits(match, kind, name, cls);
  });
  return [...fromExports, ...nested];
}

/** A unit for each member the match takes and each naming call, when the class's ancestry reaches the base. */
function subclassUnits(
  match: SubclassOfMatch,
  kind: string,
  name: string,
  cls: ClassValueOps,
): DeclaredUnit[] {
  if (match.skipClasses?.includes(name) || !cls.inherits(match.inherits)) {
    return [];
  }
  const takes = nameFilter(match.members.names, match.members.pattern);
  const members = cls
    .members(match.members.kind)
    .filter((member) => takes(member.name))
    .flatMap((member) => {
      const func = nodeOfFunction(member.value);
      return func === null
        ? []
        : [
            {
              func,
              kind,
              name: `${name}.${member.name}`,
              foundAt: [name, member.name],
            },
          ];
    });
  return [...members, ...namingCallUnits(match, kind, name, cls)];
}

/**
 * A unit for each call in the class body that the match's `calls`
 * lists, named by the class and the call's argument. A library such as
 * graphql-ruby keeps one declaration per name, so the last call under a
 * name wins, at the place of the first.
 */
function namingCallUnits(
  match: SubclassOfMatch,
  kind: string,
  written: string,
  cls: ClassValueOps,
): DeclaredUnit[] {
  const listed = match.calls;
  if (listed === undefined) {
    return [];
  }
  const calls = cls.bodyCalls().filter(isWrittenOnSelf);
  const className = classPartOf(match.className, written, calls);
  const byName = new Map<string, NamedBy>();
  for (const call of calls) {
    const naming = listed[call.calleeText()];
    const named =
      naming === undefined ? null : namedByCall(call, naming, cls, className);
    if (named !== null) {
      byName.set(named.name, named);
    }
  }
  return [...byName.values()].map((named) => ({
    func: nodeOfFunction(named.runs?.method ?? null),
    kind,
    name: `${className}.${named.name}`,
    foundAt: [className, named.name],
    namedBy: named,
  }));
}

/** What one naming call declares, or null when it writes no argument where its name goes. */
function namedByCall(
  call: CallOps,
  naming: NamingCall,
  cls: ClassValueOps,
  className: string,
): NamedBy | null {
  const at = naming.name.at;
  const argument = call.valueAt(at);
  if (argument === null) {
    return null;
  }
  const settled = call.nameAt(at, "nothing");
  if (settled === null) {
    const source = argument.source?.() ?? "";
    return { call, cls, className, name: source, settled: false, runs: null };
  }
  return {
    call,
    cls,
    className,
    name: namedAs(settled, call, naming.naming),
    settled: true,
    runs: firstRunsPick(naming.runs, call, cls, settled),
  };
}

/** The unit's part of its name: camel case unless the call's keyword turns it off. */
function namedAs(
  settled: string,
  call: CallOps,
  naming: NamingCall["naming"],
): string {
  if (naming === undefined) {
    return settled;
  }
  const written = call.keywordAt?.(naming.camel.keyword)?.literal?.();
  const camel = typeof written === "boolean" ? written : naming.camel.default;
  return camel ? camelCased(settled) : settled;
}

/** `user_name` as `userName`, each part after an underscore starting in upper case. */
function camelCased(name: string): string {
  const [first, ...rest] = name.split("_");
  return [
    first,
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
  ].join("");
}

/** What the first pick whose keyword the call writes finds, a pick of the unit's own name always applying. */
function firstRunsPick(
  picks: readonly RunsPick[],
  call: CallOps,
  cls: ClassValueOps,
  ownName: string,
): RunsFound | null {
  for (const pick of picks) {
    const found = runsFor(pick, call, cls, ownName);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** What the pick finds, or null when it reads a keyword the call does not write. */
function runsFor(
  pick: RunsPick,
  call: CallOps,
  cls: ClassValueOps,
  ownName: string,
): RunsFound | null {
  if ("classAt" in pick) {
    return wiredRuns(pick, call);
  }
  if (pick.method === "named") {
    return {
      pick,
      keyword: null,
      written: null,
      methodName: ownName,
      method: cls.method(ownName, "instance"),
    };
  }
  const { keyword } = pick.method;
  const written = call.keywordAt?.(keyword) ?? null;
  if (written === null) {
    return null;
  }
  const methodName = written.name("nothing");
  return {
    pick,
    keyword,
    written,
    methodName,
    method: methodName === null ? null : cls.method(methodName, "instance"),
  };
}

/** The method of the class a keyword refers to, when the run read that class. */
function wiredRuns(
  pick: Extract<RunsPick, { classAt: unknown }>,
  call: CallOps,
): RunsFound | null {
  const { keyword } = pick.classAt;
  const written = call.keywordAt?.(keyword) ?? null;
  if (written === null) {
    return null;
  }
  return {
    pick,
    keyword,
    written,
    methodName: pick.method,
    method: written.asClass?.()?.method(pick.method, "instance") ?? null,
  };
}

/**
 * The class's part of a unit's name: the string the body's `call` sets,
 * else the last segment of its own name less `suffixRemoved`, else its
 * whole name when the match says nothing about it.
 */
function classPartOf(
  naming: SubclassOfMatch["className"],
  written: string,
  calls: readonly CallOps[],
): string {
  if (naming === undefined) {
    return written;
  }
  const set = naming.call === undefined ? null : setBy(naming.call, calls);
  if (set !== null) {
    return set;
  }
  const own = written.split("::").at(-1) ?? written;
  const suffix = naming.suffixRemoved;
  return suffix !== undefined && own.endsWith(suffix)
    ? own.slice(0, own.length - suffix.length)
    : own;
}

/** The string the first call under the name writes as its first argument. */
function setBy(name: string, calls: readonly CallOps[]): string | null {
  for (const call of calls) {
    const literal =
      call.calleeText() === name ? call.valueAt(0)?.literal?.() : undefined;
    if (typeof literal === "string") {
      return literal;
    }
  }
  return null;
}

/**
 * A directive at module scope makes every exported function a unit, and
 * at function scope it makes that function one. A function both make a
 * unit is one unit.
 */
function readMarked(
  match: MarkedMatch,
  kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  const units: DeclaredUnit[] = [];
  const taken = new Set<unknown>();
  const marked = (
    func: unknown,
    name: string,
    foundAt: readonly string[] | null,
  ): DeclaredUnit => ({
    func,
    kind,
    name,
    ...match.unit,
    functionCallInfo: { module: module.path(), exportName: name },
    foundAt,
  });
  if (match.scopes.includes("module") && module.marked(match.word)) {
    for (const { name, value } of module.exports()) {
      const func = nodeOfFunction(value);
      if (func !== null && !taken.has(func)) {
        taken.add(func);
        units.push(marked(func, name, [name]));
      }
    }
  }
  if (!match.scopes.includes("function")) {
    return units;
  }
  const counted = { next: 0 };
  for (const { value, assignedName } of module.markedFunctions(match.word)) {
    const func = nodeOfFunction(value);
    if (func === null || taken.has(func)) {
      continue;
    }
    const name = markedName(match, assignedName, counted);
    if (name !== null) {
      taken.add(func);
      units.push(marked(func, name, null));
    }
  }
  return units;
}

/** The first of the pattern's name rules that gives the function a name. */
function markedName(
  match: MarkedMatch,
  assignedName: string | null,
  counted: { next: number },
): string | null {
  for (const rule of match.name) {
    if (rule === "assignedName" && assignedName !== null) {
      return assignedName;
    }
    if (rule === "countInFile") {
      const name = `${match.countedAs}#${counted.next}`;
      counted.next += 1;
      return name;
    }
  }
  return null;
}

function readRegistrations(
  match: RegisteredFunctionMatch,
  kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  if (!mayCallTheStart(match, module)) {
    return [];
  }
  return module.calls(match.in ?? "moduleBody").flatMap((call) => {
    if (!registers(call, match)) {
      return [];
    }
    const handed = call.valueAt(match.handler.at);
    const value =
      match.handler.through === "element" ? (handed?.tag?.() ?? null) : handed;
    const func = nodeOfFunction(value);
    if (func === null || value === null) {
      return [];
    }
    if (match.nameAt === undefined) {
      return [{ func, kind, name: value.source?.() ?? "", foundAt: null }];
    }
    const name = call.nameAt(match.nameAt.at, "nothing");
    const spec = name === null ? undefined : match.nameAt.named[name];
    return spec === undefined ? [] : [built(spec, func, null)];
  });
}

/**
 * Each function written under one of the decorators the pattern lists,
 * in the order the file writes them. A decorator has to write its
 * method's name, so a file whose text has none of them is not read.
 */
function readDecorated(
  match: DecoratedMatch,
  _kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  const methods = new Set(Object.keys(match.named));
  if (![...methods].some((method) => module.mentions(method))) {
    return [];
  }
  module.readingReceivers?.(methods, "decorators");
  return module.decorated().flatMap(({ definition, name, decorators }) => {
    const func = nodeOfFunction(definition);
    if (func === null || name === null) {
      return [];
    }
    return decorators.flatMap((decorator) => {
      const by = decoratedBy(decorator, methods);
      const spec = by === null ? undefined : match.named[by.method];
      return by === null || spec === undefined || !by.on.isFrom(match.on)
        ? []
        : [{ func, ...spec, name, foundAt: null, decoratedBy: by }];
    });
  });
}

/**
 * The method a decorator calls and what it is called on: the receiver of
 * a decorator written as a call, `@app.middleware("http")`, or the object
 * of one written as a member read, `@app.before_request`. Null for any
 * other decorator, and for one whose value was not written as a call.
 */
function decoratedBy(
  decorator: Decorator,
  methods: ReadonlySet<string>,
): DecoratedBy | null {
  if (decorator.form === "call") {
    const { call } = decorator;
    const method = call.method();
    const receiver = call.receiverValue?.() ?? null;
    const on = method !== null && methods.has(method) ? call.receiver() : null;
    return method === null || receiver === null || on === null
      ? null
      : { method, decorator, receiver, on };
  }
  const read = decorator.value.memberRead?.() ?? null;
  const on =
    read !== null && methods.has(read.key)
      ? (read.object.asCall?.({ follow: "namesAndFields" }) ?? null)
      : null;
  return read === null || on === null
    ? null
    : { method: read.key, decorator, receiver: read.object, on };
}

/**
 * A call to a global is written with the global's own name, so a file
 * whose text has none of the paths makes no such call, and listing the
 * module body's calls would state facts for every one of them. A method
 * on a global can be called through a variable imported from another
 * file, so that form is always read. A start every member of which is
 * an import or a construction from a module is read only in a file
 * whose text writes one of those modules.
 */
function mayCallTheStart(
  match: RegisteredFunctionMatch,
  module: ModuleOps,
): boolean {
  const modules = modulesWrittenFor(match.start);
  if (modules !== null) {
    return modules.some((one) => module.mentions(one));
  }
  if (match.method !== undefined || match.start.origin !== "global") {
    return true;
  }
  return match.start.paths.some((path) => module.mentions(path));
}

/**
 * The modules a file has to write for the start to be in it, or null
 * when a member of the start can be reached without the file writing
 * one, as a global can.
 */
function modulesWrittenFor(start: ReceiverOrigin): readonly string[] | null {
  if (start.origin === "anyOf") {
    const each = start.of.map(modulesWrittenFor);
    return each.every((one): one is readonly string[] => one !== null)
      ? each.flat()
      : null;
  }
  const writes = start.origin === "imported" || start.origin === "constructed";
  return writes && start.importedFrom.length > 0 ? start.importedFrom : null;
}

/** Whether the call is the registration: a method on the start, or the start called itself. */
function registers(call: CallOps, match: RegisteredFunctionMatch): boolean {
  if (match.method === undefined) {
    return call.isFrom(match.start);
  }
  return call.method() === match.method && call.receiverIsFrom(match.start);
}

/** Exactly the listed names, or the names the pattern matches, or every name. */
function nameFilter(
  names: readonly string[] | undefined,
  pattern: string | undefined,
): (name: string) => boolean {
  if (names !== undefined) {
    return (name) => names.includes(name);
  }
  if (pattern === undefined) {
    return () => true;
  }
  const matcher = new RegExp(pattern);
  return (name) => matcher.test(name);
}

/** A file path is absolute, so `dot` lets a glob match under a hidden directory above the project. */
function inSkippedFile(
  path: string,
  globs: readonly string[] | undefined,
): boolean {
  return (
    globs !== undefined &&
    globs.length > 0 &&
    picomatch.isMatch(path, [...globs], { dot: true })
  );
}

function built(
  spec: UnitSpec,
  func: unknown,
  foundAt: readonly string[] | null,
): DeclaredUnit {
  return { func, ...spec, foundAt };
}

/** The adapter's node for the one function the value settles to. */
function nodeOfFunction(value: ValueOps | null): unknown {
  const found = value?.function?.() ?? null;
  return (found as Partial<AstCapableValueOps> | null)?.ast?.() ?? null;
}
