/**
 * The discovery patterns every adapter reads the same way. A pack states
 * where a unit's function is (a deploy manifest, an export, a class
 * reaching a library base, a directive, a registration call) and this
 * reader finds it through the module ops each adapter hands out over its
 * own facts, so one declaration finds the same units in TypeScript,
 * Python and Ruby.
 *
 * Every reader ends the same way: a value whose `function()` settles to
 * one function, handed back as the adapter's own node so the adapter
 * builds the unit on it the way it builds any other.
 */

import picomatch from "picomatch";

import type {
  AstCapableValueOps,
  CallOps,
  DeclaredDiscoveryMatch,
  DiscoveredCustomUnit,
  ManifestEntry,
  MarkedMatch,
  MemberPick,
  ModuleOps,
  NamedExportMatch,
  RegisteredFunctionMatch,
  SubclassOfMatch,
  UnitSpec,
  ValueOps,
} from "@suss/extractor";

/**
 * A unit a declared pattern found. `foundAt` is the path of names from
 * the top of the file to the function, the export and then each member,
 * which Python and Ruby give a unit as its export path. Null for a
 * function no export leads to.
 */
export interface DeclaredUnit extends DiscoveredCustomUnit {
  readonly foundAt: readonly string[] | null;
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

function readSubclasses(
  match: SubclassOfMatch,
  kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  const takes = nameFilter(match.members.names, match.members.pattern);
  return module.exports().flatMap(({ name, value }) => {
    const cls = value.asClass?.() ?? null;
    if (cls === null || !cls.inherits(match.inherits)) {
      return [];
    }
    return cls
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
  });
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
  if (match.scopes.includes("module") && module.marked(match.word)) {
    for (const { name, value } of module.exports()) {
      const func = nodeOfFunction(value);
      if (func !== null && !taken.has(func)) {
        taken.add(func);
        units.push({ func, kind, name, foundAt: [name] });
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
      units.push({ func, kind, name, foundAt: null });
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
  return module.calls().flatMap((call) => {
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
