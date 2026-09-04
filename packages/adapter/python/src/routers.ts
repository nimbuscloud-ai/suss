// routers.ts: router prefix composition, through chains of any length.
//
// A route declared on a sub-router (`@router.get("/x")` where `router
// = APIRouter(prefix="/items")`) is served at a path the route file
// never states: the mount call (`app.include_router(router,
// prefix="/api")`) supplies one prefix and the constructor supplies
// another. This module reads exactly that much, ahead of discovery:
// every module-level router construction, every mount call whose
// router argument is a bare name (bound in the same file, or imported
// from the file that constructed it), and the literal prefixes on
// both, composing chains through the shared mount composition.
// Everything else abstains with a reason: a non-literal prefix, a
// router nobody mounts by name, mounts that disagree, or one that
// overrides the prefix the constructor stated. Discovery turns an
// abstention into a unit that keeps its name and gives no path, so
// it pairs with nothing rather than with whatever a guessed path
// would have named.
//
// A route reaches its router through a function decorator in one
// library and through a class decorator in another. Neither shape
// changes the question this module answers, so both go through the
// same index.
//
// Every prefix, at either site, is read by `readPrefixKeyword` and
// comes back stated, unstated, or unreadable. Which spelling lands
// where differs by library and the pack says so: this package's
// README has the grid, every cell of it checked against a running
// app. Read it before teaching a new library's mount to compose.
//
// The object a mount is called on states a prefix of its own where
// the pack says so, in front of the other two.

import { type MountEdge, mountPathsOf } from "@suss/resolution";

import {
  bodyStatements,
  field,
  rangeOf,
  stringLiteralValue,
  stripDecorators,
} from "./ast.js";
import { readCallArguments } from "./decorators.js";
import {
  containedValues,
  objectReturnedBy,
  resolveCalls,
  subjectConstructions,
} from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";
import { resolveModule } from "./moduleResolver.js";
import { resolveName } from "./scope.js";

import type { Database } from "@suss/datalog";
import type { DecoratorArg } from "./decorators.js";
import type { ModuleResolverOptions } from "./moduleResolver.js";
import type {
  MountObjectCarrier,
  MountObjectPrefix,
  MountPrefixEffect,
  PrefixTrailingSlash,
  PythonDiscoveryPattern,
  PythonPack,
  RouterComposition,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type { Binding, ModuleBinding, Scope } from "./scope.js";

/** One file, already parsed and bound. `buildRouterIndex` takes a project as a list of these. */
export interface BoundPythonFile {
  /** The absolute path, which is what module resolution joins on. */
  file: string;
  /** The path a gap refers to this file by, which a reader has to be able to open. */
  displayPath: string;
  root: PyNode;
  module: ModuleBinding;
}

/**
 * What the object a decorator hangs on turns out to be. `notRouter` covers the
 * app itself and anything the index never saw constructed, so the decorator's
 * own path stands as written. `composed` gives the prefix to put in front of
 * that path. An `abstain` reason is written to follow "the router this route is
 * declared on ...".
 */
export type RoutePrefixResolution =
  | { kind: "notRouter" }
  | { kind: "composed"; value: string }
  | {
      /**
       * The router is mounted more than once, at prefixes that do not
       * agree. Both are served at run time, so discovery emits one
       * boundary per prefix rather than none (#689).
       */
      kind: "composedMany";
      values: string[];
    }
  | { kind: "abstain"; reason: string };

export interface RouterIndex {
  resolve(
    pattern: PythonDiscoveryPattern,
    module: ModuleBinding,
    objectName: string,
  ): RoutePrefixResolution;
  /**
   * The same answer for a decorator whose object has no variable name to
   * look up, such as one written on `self.router`. The rules give the call
   * that built it, and every construction is already keyed by its call.
   */
  resolveConstruction(
    pattern: PythonDiscoveryPattern,
    module: ModuleBinding,
    constructorName: string,
    constructionKey: string,
  ): RoutePrefixResolution;
  /**
   * The module-level def a name in another module refers to, with that
   * module's own bindings, so a decorator written through a project wrapper
   * can be read where the wrapper is written.
   */
  moduleDef(
    fromFile: string,
    spec: { module: string; relativeLevel: number },
    name: string,
  ): { node: PyNode; module: ModuleBinding } | null;
}

/** An `x = <Constructor>(...)` from an accepted module, and what its call said about a prefix. */
interface Construction {
  /** The constructor's name as its module exports it, so a caller can tell a router from an app from a blueprint. */
  constructorName: string;
  /** The value key of the call this was built by, so a resolved value can be matched to it. */
  valueKey: string;
  /** What the call stated, with the library's trailing-slash handling already applied. */
  prefix: PrefixReading;
  /**
   * True when the same name is assigned a construction more than
   * once. The binder keeps one binding per name, but the library
   * binds a route to whichever object the name held at decoration
   * time, so which construction a decorator or a mount saw is an
   * ordering this reading does not follow. Composing from the last
   * one would report a confident wrong path.
   */
  reassigned: boolean;
}

/**
 * What a prefix keyword says at one site. "unstated" covers a keyword nobody
 * wrote, and one written with a value the library treats as no value at all.
 * "unreadable" means an expression we do not evaluate.
 */
type PrefixReading =
  | { kind: "stated"; value: string }
  | { kind: "unstated" }
  | { kind: "unreadable" };

const UNSTATED_PREFIX: PrefixReading = { kind: "unstated" };
const UNREADABLE_PREFIX: PrefixReading = { kind: "unreadable" };

type OwnPrefixResolution =
  | { kind: "composed"; value: string }
  | { kind: "abstain"; reason: string };

type MountState =
  | {
      kind: "mounted";
      includePrefix: string;
      site: MountSite;
      /** The router construction this mount hangs the child under, or
       * null when the includer is the app or a carrier, which is a
       * chain's root. */
      parentValueKey: string | null;
    }
  | { kind: "abstain"; reason: string };

/** Where a mount call is written: a module's top level, which runs on import, or one function's body, which runs only if something calls it. */
type MountSite = { kind: "module" } | { kind: "function"; node: number };

const MODULE_SITE: MountSite = { kind: "module" };

/** One loop whose routers this reading cannot name, and where a reader will find it. */
interface UnenumerableLoop {
  site: MountSite;
  /** The display path of the file the loop is written in, so its reach can be bounded. */
  file: string;
  location: string;
  /** The one name that stopped a list from mounting, when the rules resolved the list and one element matched no construction. */
  unmatched?: { name: string; resolvedTo: string; matched: number; of: number };
}

/** Whether anything about where a carrier is registered contradicts the prefix its own construction stated. */
type RegistrationState =
  | { kind: "asBuilt" }
  | { kind: "abstain"; reason: string };

type ConstructionsByName = Map<ModuleBinding, Map<string, Construction>>;

interface PatternIndex {
  composition: RouterComposition;
  /** Every construction by the value key of the call that built it, so a resolved value finds one whatever module wrote it. */
  byValueKey: Map<string, Construction>;
  /** The project's facts, when the caller built them, so a loop over a call can be settled. */
  facts?: Database;
  constructions: ConstructionsByName;
  /** Every mount of each construction, one entry per mount call. */
  mounts: Map<Construction, MountState[]>;
  /** The mount edges over every construction, built once on first ask. */
  mountEdges?: ReadonlyMap<string, readonly MountEdge[]>;
  /** Keyed by location, so one loop counts once however many routers ask about it. */
  unenumerableLoops: Map<string, UnenumerableLoop>;
  /** Every construction from the carrier's modules, the app alongside the blueprint, so the two can be told apart. */
  carriers: ConstructionsByName;
  carrierRegistrations: Map<Construction, RegistrationState>;
  /** Per module, the arguments each handoff call passed to a named variable (`api.init_app(bp)`). */
  handoffs: Map<ModuleBinding, Map<string, DecoratorArg[]>>;
  /**
   * What each module-level mount object puts in front of the paths
   * behind it, for a route declared straight on that object rather
   * than on a router it mounts.
   */
  objectPrefixes: Map<ModuleBinding, Map<string, OwnPrefixResolution>>;
}

const NOT_ROUTER: RoutePrefixResolution = { kind: "notRouter" };

export interface RouterIndexOptions extends ModuleResolverOptions {
  /** The project's facts, so a loop over a call can be settled by the rules. */
  facts?: Database;
}

export function buildRouterIndex(
  files: BoundPythonFile[],
  packs: PythonPack[],
  resolverOptions: RouterIndexOptions,
): RouterIndex {
  const byPattern = new Map<PythonDiscoveryPattern, PatternIndex>();
  for (const pack of packs) {
    for (const pattern of pack.discovery) {
      if (pattern.routerComposition !== undefined) {
        byPattern.set(
          pattern,
          buildPatternIndex(
            files,
            pattern.importModule,
            pattern.routerComposition,
            resolverOptions,
          ),
        );
      }
    }
  }

  const byFile = new Map<string, BoundPythonFile>();
  const displayPaths = new Map<ModuleBinding, string>();
  for (const file of files) {
    byFile.set(file.file, file);
    displayPaths.set(file.module, file.displayPath);
  }

  return {
    moduleDef(fromFile, spec, name) {
      const resolution = resolveModule(fromFile, spec, resolverOptions);
      if (resolution.status !== "resolved") {
        return null;
      }
      const bound = byFile.get(resolution.file);
      if (bound === undefined) {
        return null;
      }
      const binding = bound.module.moduleScope.bindings.get(name);
      if (binding?.kind !== "functionDef") {
        return null;
      }
      return { node: binding.node, module: bound.module };
    },

    resolve(pattern, module, objectName) {
      const index = byPattern.get(pattern);
      if (index === undefined) {
        return NOT_ROUTER;
      }

      const construction = index.constructions.get(module)?.get(objectName);
      if (construction === undefined) {
        return declaredOnMountObject(index, module, objectName);
      }

      if (construction.reassigned) {
        return {
          kind: "abstain",
          reason: "shares its variable name with a second router construction",
        };
      }

      return composedPrefixOf(index, construction, displayPaths.get(module));
    },

    resolveConstruction(pattern, module, constructorName, constructionKey) {
      const index = byPattern.get(pattern);
      if (index === undefined) {
        return NOT_ROUTER;
      }

      const construction = index.byValueKey.get(constructionKey);
      if (construction !== undefined) {
        return composedPrefixOf(index, construction, displayPaths.get(module));
      }

      // The index only records a construction written at a module's top
      // level, so a router built anywhere else has no prefix here to
      // compose and its routes give no path rather than a wrong one.
      if (constructorName === index.composition.routerConstructorName) {
        return {
          kind: "abstain",
          reason: unmountedReason(index, displayPaths.get(module)),
        };
      }

      if (index.composition.mountObjectPrefix !== undefined) {
        return {
          kind: "abstain",
          reason:
            "is built where this reading does not read a mount object's prefix",
        };
      }

      return NOT_ROUTER;
    },
  };
}

/** What a construction the index knows composes to, once the caller has found it by name or by call. */
function composedPrefixOf(
  index: PatternIndex,
  construction: Construction,
  routerPath: string | undefined,
): RoutePrefixResolution {
  const ownPrefix = composedOwnPrefix(construction.prefix, index.composition);
  if (ownPrefix.kind === "abstain") {
    return ownPrefix;
  }

  const states = index.mounts.get(construction);
  if (states === undefined || states.length === 0) {
    return { kind: "abstain", reason: unmountedReason(index, routerPath) };
  }

  for (const state of states) {
    if (state.kind === "abstain") {
      return { kind: "abstain", reason: state.reason };
    }

    const rivalled = rivalRegistration(index, state.site, routerPath);
    if (rivalled !== null) {
      return { kind: "abstain", reason: rivalled };
    }
  }

  const composed = composedMountPrefix(index, construction);
  if (composed.kind === "abstain") {
    return composed;
  }

  if (composed.kind === "composedMany") {
    return {
      kind: "composedMany",
      values: composed.values.map((value) => value + ownPrefix.value),
    };
  }

  return { kind: "composed", value: composed.value + ownPrefix.value };
}

/**
 * The one prefix every mount chain lands this construction at, through
 * however many routers in turn. Cycles and chains through a mount that
 * abstained compose to nothing; two mounts landing at different paths
 * do not settle which one a route takes.
 */
type MountPrefixComposition =
  | { kind: "composed"; value: string }
  | { kind: "composedMany"; values: string[] }
  | { kind: "abstain"; reason: string };

function composedMountPrefix(
  index: PatternIndex,
  construction: Construction,
): MountPrefixComposition {
  const paths = mountPathsOf(mountEdgesOf(index), construction.valueKey);
  if (paths === null) {
    return {
      kind: "abstain",
      reason:
        "is mounted through a chain of routers this reading cannot compose",
    };
  }

  const distinct = [...new Set(paths)];
  const only = distinct[0];
  if (only === undefined) {
    return {
      kind: "abstain",
      reason:
        "is mounted through a chain of routers this reading cannot compose",
    };
  }

  if (distinct.length > 1) {
    return { kind: "composedMany", values: distinct };
  }

  return { kind: "composed", value: only };
}

/**
 * A construction whose own mounts abstain, and a router somebody
 * mounts things on without ever being mounted itself, both get a
 * self-edge here: the cycle it makes composes to nothing, so every
 * chain through them abstains instead of dropping the missing hops.
 */
function mountEdgesOf(
  index: PatternIndex,
): ReadonlyMap<string, readonly MountEdge[]> {
  if (index.mountEdges !== undefined) {
    return index.mountEdges;
  }

  const edges = new Map<string, MountEdge[]>();
  const push = (childKey: string, edge: MountEdge): void => {
    const list = edges.get(childKey) ?? [];
    list.push(edge);
    edges.set(childKey, list);
  };

  for (const [target, states] of index.mounts) {
    for (const state of states) {
      if (state.kind === "abstain") {
        push(target.valueKey, { parentId: target.valueKey, prefix: "" });
        continue;
      }
      push(target.valueKey, {
        parentId: state.parentValueKey ?? rootKeyOf(target),
        prefix: state.includePrefix,
      });
    }
  }

  for (const [valueKey, construction] of index.byValueKey) {
    if (!index.mounts.has(construction)) {
      push(valueKey, { parentId: valueKey, prefix: "" });
    }
  }

  index.mountEdges = edges;
  return edges;
}

/** A chain root no construction can collide with. */
function rootKeyOf(target: Construction): string {
  return `root:${target.valueKey}`;
}

/**
 * What a route declared straight on the mount object rather than on a
 * router is served under. flask-restx's `Api` takes route decorators
 * of its own, and a blueprint prefix reaches those the same way it
 * reaches a namespace's.
 */
function declaredOnMountObject(
  index: PatternIndex,
  module: ModuleBinding,
  objectName: string,
): RoutePrefixResolution {
  const objectPrefix = index.objectPrefixes.get(module)?.get(objectName);
  if (objectPrefix === undefined) {
    return NOT_ROUTER;
  }

  if (objectPrefix.kind === "composed" && objectPrefix.value === "") {
    return NOT_ROUTER;
  }

  return objectPrefix;
}

function sameSite(one: MountSite, other: MountSite): boolean {
  if (one.kind === "function" && other.kind === "function") {
    return one.node === other.node;
  }

  return one.kind === other.kind;
}

/** "a loop at main.py:14 mounts" / "loops at main.py:14, api.py:9 mount", so a reader can go read the loop. */
function loopsClause(loops: UnenumerableLoop[], verb: string): string {
  const locations = loops.map((loop) => loop.location).sort();
  if (locations.length === 1) {
    return `a loop at ${locations[0]} ${verb}s`;
  }

  return `loops at ${locations.join(", ")} ${verb}`;
}

/**
 * Whether a loop could plausibly have mounted a router declared in the
 * file at routerPath. A loader reads its collection from somewhere near
 * itself, most often its own package, so the loop's reach is bounded to
 * the directory that contains it. A loop that pulls routers from a
 * sibling package is missed, which trades a possible wrong path for not
 * letting one dynamic loader disable every function-site mount in the
 * run (#243).
 */
function couldReach(loop: UnenumerableLoop, routerPath?: string): boolean {
  if (routerPath === undefined) {
    return true;
  }

  const directory = loop.file.slice(0, loop.file.lastIndexOf("/") + 1);
  return routerPath.startsWith(directory);
}

/** Why a router nobody mounted by name still gives no path, pointing at the loop when there is one to read. */
function unmountedReason(index: PatternIndex, routerPath?: string): string {
  const loops = [...index.unenumerableLoops.values()];

  // A declined list's entries are imports that can come from any
  // package, so this points at the loop that resolved one wherever it is.
  const stopped = loops.find((loop) => loop.unmatched !== undefined);
  if (stopped?.unmatched !== undefined) {
    const { name, resolvedTo, matched, of } = stopped.unmatched;
    return `is not mounted by name in the files read, and a loop at ${stopped.location} mounts a list this reading resolved, where ${matched} of ${of} entries matched a router and ${name} did not (it resolved to ${resolvedTo}), so the whole list is declined rather than most of it mounted`;
  }

  const reachable = loops.filter((loop) => couldReach(loop, routerPath));
  if (reachable.length === 0) {
    return "is never mounted through a single variable binding in the files read";
  }

  return `is not mounted by name in the files read, and ${loopsClause(reachable, "mount")} routers read out of a call this reading does not follow`;
}

/** Why a mount the reading followed still cannot be taken: it only runs if the app calls that function, and a loop elsewhere may register the router instead. */
function rivalRegistration(
  index: PatternIndex,
  site: MountSite,
  routerPath?: string,
): string | null {
  if (site.kind === "module") {
    return null;
  }

  const rivals = [...index.unenumerableLoops.values()].filter(
    (loop) => !sameSite(loop.site, site) && couldReach(loop, routerPath),
  );
  if (rivals.length === 0) {
    return null;
  }

  return `is mounted inside a function, while ${loopsClause(rivals, "mount")} routers this reading cannot name, and which of them the app runs is not written down`;
}

/**
 * What the constructor's own prefix contributes to the path, or why
 * nothing can be said about it. A prefix nobody stated adds nothing,
 * unless the library derives one from elsewhere when it is unstated,
 * and then the path is somewhere this reading never looked.
 */
function composedOwnPrefix(
  prefix: PrefixReading,
  composition: RouterComposition,
): OwnPrefixResolution {
  const readings: Record<
    PrefixReading["kind"],
    (reading: PrefixReading) => OwnPrefixResolution
  > = {
    stated: (reading) => ({
      kind: "composed",
      value: reading.kind === "stated" ? reading.value : "",
    }),
    unreadable: () => ({
      kind: "abstain",
      reason: "declares a prefix that is not a string literal",
    }),
    unstated: () => {
      if (composition.constructorPrefixRequired === true) {
        return {
          kind: "abstain",
          reason:
            "states no prefix where it is constructed, and its library derives one from elsewhere",
        };
      }

      return { kind: "composed", value: "" };
    },
  };
  return readings[prefix.kind](prefix);
}

function buildPatternIndex(
  files: BoundPythonFile[],
  importModule: string[],
  composition: RouterComposition,
  resolverOptions: RouterIndexOptions,
): PatternIndex {
  const index: PatternIndex = {
    composition,
    byValueKey: new Map(),
    ...(resolverOptions.facts !== undefined
      ? { facts: resolverOptions.facts }
      : {}),
    constructions: new Map(),
    mounts: new Map(),
    unenumerableLoops: new Map(),
    carriers: new Map(),
    carrierRegistrations: new Map(),
    handoffs: new Map(),
    objectPrefixes: new Map(),
  };
  const byFile = new Map(files.map((bound) => [bound.file, bound]));
  const scanOf = (bound: BoundPythonFile): Scan => ({
    bound,
    byFile,
    importModule,
    composition,
    resolverOptions,
    index,
  });
  const objectPrefix = composition.mountObjectPrefix;

  for (const bound of files) {
    collectConstructions(bound, importModule, composition, index);
  }

  for (const bound of files) {
    collectReturnedConstructions(bound, importModule, composition, index);
  }

  if (objectPrefix?.carrier !== undefined) {
    const carrier = objectPrefix.carrier;
    for (const bound of files) {
      collectCarrierConstructions(carrier, composition, scanOf(bound));
    }

    for (const bound of files) {
      collectCarrierCalls(carrier, scanOf(bound));
    }
  }

  if (objectPrefix !== undefined) {
    for (const bound of files) {
      collectObjectPrefixes(objectPrefix, scanOf(bound));
    }
  }

  for (const bound of files) {
    collectMounts(
      bound,
      byFile,
      importModule,
      composition,
      resolverOptions,
      index,
    );
  }

  return index;
}

/**
 * The call a module-level name was assigned from, when the thing being called
 * was imported from one of the accepted modules. This follows a single
 * assignment back to a constructor and never a chain, the same one-hop limit
 * `classifyDecorator` uses when it traces an object.
 */
function constructionOf(
  name: string,
  scope: Scope,
  importModule: string[],
): { constructorName: string; call: PyNode } | null {
  const binding = resolveName(scope, name);
  if (binding?.kind !== "assignment" || binding.value?.type !== "call") {
    return null;
  }

  const callee = field(binding.value, "function");
  if (callee === null) {
    return null;
  }
  const constructorName = importedConstructorName(callee, scope, importModule);
  return constructorName === null
    ? null
    : { constructorName, call: binding.value };
}

/** The prefix as the library stores it. A library that drops trailing slashes ends up with something other than what the source wrote. */
const PREFIX_TRAILING_SLASH_READERS: Record<
  PrefixTrailingSlash,
  (prefix: string) => string
> = {
  kept: (prefix) => prefix,
  trimmed: (prefix) => prefix.replace(/\/+$/, ""),
};

/**
 * The four values a library can treat as no value at all, which is what a
 * truthiness check on the argument comes down to. Python decides what the four
 * are. Whether a given library treats them that way is the pack's to say.
 */
const NO_VALUE_LITERALS: Partial<
  Record<DecoratorArg["kind"], (arg: DecoratorArg) => boolean>
> = {
  string: (arg) => arg.kind === "string" && arg.value === "",
  number: (arg) => arg.kind === "number" && arg.value === 0,
  boolean: (arg) => arg.kind === "boolean" && !arg.value,
  none: () => true,
};

/**
 * The string a prefix argument comes down to, or null when nothing here
 * can say. A bare name is followed to what it was assigned, because
 * `prefix=API_V1` and `prefix="/api/v1"` describe the same route, and a
 * settings module is where most projects put the value.
 */
function prefixStringOf(
  arg: DecoratorArg,
  scope: Scope | undefined,
): string | null {
  if (arg.kind === "string") {
    return arg.value;
  }
  if (arg.kind !== "identifier" || scope === undefined) {
    return null;
  }
  const binding = resolveName(scope, arg.name);
  if (
    binding === null ||
    binding.kind !== "assignment" ||
    binding.value === null
  ) {
    return null;
  }
  return stringLiteralValue(binding.value);
}

/** Every site reads a prefix through here, so the same spelling means the same thing at a constructor and at a mount. */
function readPrefixKeyword(
  keywordArgs: Record<string, DecoratorArg>,
  keyword: string,
  composition: RouterComposition,
  scope: Scope,
): PrefixReading {
  const arg = keywordArgs[keyword];
  if (arg === undefined) {
    return UNSTATED_PREFIX;
  }

  if (
    (composition.noValuePrefix ?? "unreadable") === "unstated" &&
    NO_VALUE_LITERALS[arg.kind]?.(arg) === true
  ) {
    return UNSTATED_PREFIX;
  }

  const value = prefixStringOf(arg, scope);
  return value === null ? UNREADABLE_PREFIX : { kind: "stated", value };
}

function constructorPrefix(
  keywordArgs: Record<string, DecoratorArg>,
  composition: RouterComposition,
  scope: Scope,
): PrefixReading {
  const reading = readPrefixKeyword(
    keywordArgs,
    composition.prefixKeyword,
    composition,
    scope,
  );
  if (reading.kind !== "stated") {
    return reading;
  }

  const trailingSlash = composition.constructorPrefixTrailingSlash ?? "kept";
  return {
    kind: "stated",
    value: PREFIX_TRAILING_SLASH_READERS[trailingSlash](reading.value),
  };
}

/** The name, constructor, and call of a `name = <Imported>(...)` statement; null for any other statement. */
function constructionStatement(
  stmt: PyNode,
  scope: Scope,
  importModule: string[],
): { name: string; constructorName: string; call: PyNode } | null {
  if (stmt.type !== "expression_statement") {
    return null;
  }

  const assignment = stmt.namedChildren.find(
    (child): child is PyNode => child !== null && child.type === "assignment",
  );
  if (assignment === undefined) {
    return null;
  }

  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (left?.type !== "identifier" || right?.type !== "call") {
    return null;
  }

  const callee = field(right, "function");
  if (callee === null) {
    return null;
  }
  const constructorName = importedConstructorName(callee, scope, importModule);
  if (constructorName === null) {
    return null;
  }

  return { name: left.text, constructorName, call: right };
}

/**
 * The constructor a call says it is calling, when it comes from one of the
 * pack's modules. A project reaches the same constructor two ways, and
 * both have to name it:
 *
 *   from fastapi import APIRouter   ->   APIRouter(prefix=...)
 *   import fastapi                  ->   fastapi.APIRouter(prefix=...)
 *
 * Null for anything else, including a same-named constructor somebody
 * else exports.
 */
function importedConstructorName(
  callee: PyNode,
  scope: Scope,
  importModule: string[],
): string | null {
  if (callee.type === "identifier") {
    const binding = resolveName(scope, callee.text);
    if (
      binding?.kind !== "importFrom" ||
      !importModule.includes(binding.module)
    ) {
      return null;
    }
    return binding.importedName;
  }

  if (callee.type !== "attribute") {
    return null;
  }
  const object = field(callee, "object");
  const attribute = field(callee, "attribute");
  if (object?.type !== "identifier" || attribute?.type !== "identifier") {
    return null;
  }
  const binding = resolveName(scope, object.text);
  if (binding?.kind !== "import" || !importModule.includes(binding.module)) {
    return null;
  }
  return attribute.text;
}

/**
 * Walks the module's statements rather than its bindings map, because the
 * binder keeps one binding per name, and a name assigned twice has to come out
 * as `reassigned` rather than as its last assignment.
 */
function recordConstruction(
  construction: { name: string; constructorName: string; call: PyNode },
  module: ModuleBinding,
  file: string,
  prefixOf: (keywordArgs: Record<string, DecoratorArg>) => PrefixReading,
  into: ConstructionsByName,
  byValueKey: Map<string, Construction>,
): void {
  const perModule = into.get(module) ?? new Map<string, Construction>();
  into.set(module, perModule);

  const existing = perModule.get(construction.name);
  if (existing !== undefined) {
    existing.reassigned = true;
    return;
  }

  const { keywordArgs } = readCallArguments(
    field(construction.call, "arguments"),
  );
  const recorded: Construction = {
    constructorName: construction.constructorName,
    valueKey: nodeId(file, construction.call),
    prefix: prefixOf(keywordArgs),
    reassigned: false,
  };
  perModule.set(construction.name, recorded);
  byValueKey.set(recorded.valueKey, recorded);
}

function collectConstructions(
  bound: BoundPythonFile,
  importModule: string[],
  composition: RouterComposition,
  index: PatternIndex,
): void {
  for (const stmt of bodyStatements(bound.root)) {
    const construction = constructionStatement(
      stmt,
      bound.module.moduleScope,
      importModule,
    );
    if (
      construction === null ||
      construction.constructorName !== composition.routerConstructorName
    ) {
      continue;
    }

    recordConstruction(
      construction,
      bound.module,
      bound.file,
      (keywordArgs) =>
        constructorPrefix(keywordArgs, composition, bound.module.moduleScope),
      index.constructions,
      index.byValueKey,
    );
  }
}

/**
 * A `return <Constructor>(...)` written directly in a module-level
 * function's own body. A project wrapper built this way binds no
 * module-level name to the construction, so this only reaches
 * `byValueKey`, keyed by the call itself: a mount whose argument is
 * the wrapper's result finds it there once the resolution rules have
 * settled the argument on this call.
 */
function collectReturnedConstructions(
  bound: BoundPythonFile,
  importModule: string[],
  composition: RouterComposition,
  index: PatternIndex,
): void {
  for (const stmt of bodyStatements(bound.root)) {
    const definition = stripDecorators(stmt).definition;
    if (definition.type !== "function_definition") {
      continue;
    }
    // The binder gives every top-level def its own scope, so this is
    // only ever undefined for one nested inside a block this reading
    // does not descend, which the statement above already excluded.
    const scope = bound.module.scopeFor.get(definition.id);

    for (const inner of nestedStatements(definition)) {
      if (inner.type !== "return_statement" || scope === undefined) {
        continue;
      }
      const returned = inner.namedChildren[0];
      if (returned?.type !== "call") {
        continue;
      }
      const callee = field(returned, "function");
      const constructorName =
        callee === null
          ? null
          : importedConstructorName(callee, scope, importModule);
      if (constructorName !== composition.routerConstructorName) {
        continue;
      }

      const { keywordArgs } = readCallArguments(field(returned, "arguments"));
      const valueKey = nodeId(bound.file, returned);
      index.byValueKey.set(valueKey, {
        constructorName,
        valueKey,
        prefix: constructorPrefix(keywordArgs, composition, scope),
        reassigned: false,
      });
    }
  }
}

/**
 * Keeps every construction from the carrier's modules, not only the
 * carrier's own: the plain app is in the same argument position and
 * has no prefix, and telling it from a name this reading could not
 * follow at all is what keeps `Api(app)` composing while
 * `Api(blueprint_from_elsewhere)` abstains. Walks function bodies too,
 * since a factory builds its blueprint where it builds its app, and a
 * name built in two places lands as `reassigned`.
 */
function collectCarrierConstructions(
  carrier: MountObjectCarrier,
  composition: RouterComposition,
  scan: Scan,
): void {
  walkStatements(
    bodyStatements(scan.bound.root),
    modulePosition(scan),
    scan,
    (stmt, position) => {
      const construction = constructionStatement(
        stmt,
        position.scope,
        carrier.importModule,
      );
      if (construction === null) {
        return;
      }

      recordConstruction(
        construction,
        scan.bound.module,
        scan.bound.file,
        (keywordArgs) =>
          readPrefixKeyword(
            keywordArgs,
            carrier.prefixKeyword,
            composition,
            scan.bound.module.moduleScope,
          ),
        scan.index.carriers,
        scan.index.byValueKey,
      );
    },
  );
}

/**
 * The construction a name refers to, followed through exactly one
 * variable binding: a name assigned in this file, or a name imported
 * from the file that assigned it. Anything else (an attribute like
 * `items.router`, a call, an unresolvable import) returns null, and
 * the router it meant stays unmounted, which is what makes its routes
 * abstain.
 */
function constructionNamed(
  name: string,
  scope: Scope,
  scan: Scan,
  constructions: ConstructionsByName = scan.index.constructions,
): Construction | null {
  const binding = resolveName(scope, name);
  if (binding === null) {
    return null;
  }

  const resolvers: Partial<Record<Binding["kind"], () => Construction | null>> =
    {
      assignment: () => constructions.get(scan.bound.module)?.get(name) ?? null,
      importFrom: () => {
        if (binding.kind !== "importFrom") {
          return null;
        }

        const resolution = resolveModule(
          scan.bound.file,
          { module: binding.module, relativeLevel: binding.relativeLevel },
          scan.resolverOptions,
        );
        if (resolution.status !== "resolved") {
          return null;
        }

        const target = scan.byFile.get(resolution.file);
        if (target === undefined) {
          return null;
        }

        return (
          constructions.get(target.module)?.get(binding.importedName) ?? null
        );
      },
    };

  return resolvers[binding.kind]?.() ?? null;
}

/**
 * The construction a name is bound to through a project wrapper's
 * call, once `constructionNamed` does not find an entry by name.
 * Restricted to the two binding kinds `constructionNamed` itself
 * reads, so a parameter or another name this reading cannot key
 * correctly is left alone rather than asked about under the wrong key.
 */
function constructionThroughFacts(
  name: string,
  scope: Scope,
  scan: Scan,
): Construction | null {
  const facts = scan.index.facts;
  const binding = resolveName(scope, name);
  if (facts === undefined || binding === null) {
    return null;
  }
  if (binding.kind !== "assignment" && binding.kind !== "importFrom") {
    return null;
  }

  const nameKey = `${scan.bound.file}#${name}`;
  const constructionKey = subjectConstructions(facts, [nameKey]).get(
    nameKey,
  )?.constructionKey;
  return constructionKey === undefined
    ? null
    : (scan.index.byValueKey.get(constructionKey) ?? null);
}

/** What a prefix written on the mount call does to where the router is mounted. A mount that writes no prefix never gets here. */
const MOUNT_STATE_BY_EFFECT: Record<
  MountPrefixEffect,
  (statedPrefix: string, site: MountSite) => MountState
> = {
  prefixes: (statedPrefix, site) => ({
    kind: "mounted",
    includePrefix: statedPrefix,
    site,
    parentValueKey: null,
  }),
  replaces: () => ({
    kind: "abstain",
    reason:
      "is mounted under a prefix that replaces the one it was constructed with, which this reading does not follow",
  }),
};

function recordMount(
  index: PatternIndex,
  target: Construction,
  state: MountState,
): void {
  const states = index.mounts.get(target) ?? [];
  states.push(state);
  index.mounts.set(target, states);
}

/** Everything a walk over one file needs, from the file itself down to the index it fills in. */
interface Scan {
  bound: BoundPythonFile;
  byFile: Map<string, BoundPythonFile>;
  importModule: string[];
  composition: RouterComposition;
  resolverOptions: ModuleResolverOptions;
  index: PatternIndex;
}

/** What a `for` around a mount call binds one name to: a literal sequence, or an iterable this reading does not evaluate. */
type LoopTarget =
  | { kind: "sequence"; elements: string[] }
  | { kind: "call"; call: PyNode; file: string; location: string }
  | { kind: "unenumerable"; location: string };

/** Where the walk currently is: what resolves a name, what the loops around it bind, and whose body it is in. */
interface WalkPosition {
  scope: Scope;
  loopBindings: Map<string, LoopTarget>;
  site: MountSite;
}

function collectMounts(
  bound: BoundPythonFile,
  byFile: Map<string, BoundPythonFile>,
  importModule: string[],
  composition: RouterComposition,
  resolverOptions: ModuleResolverOptions,
  index: PatternIndex,
): void {
  const scan: Scan = {
    bound,
    byFile,
    importModule,
    composition,
    resolverOptions,
    index,
  };
  walkStatements(
    bodyStatements(bound.root),
    modulePosition(scan),
    scan,
    recordMountStatement,
  );
}

/** Where a walk starts on a file: the module's own scope, nothing bound by a loop, and a site that runs on import. */
function modulePosition(scan: Scan): WalkPosition {
  return {
    scope: scan.bound.module.moduleScope,
    loopBindings: new Map(),
    site: MODULE_SITE,
  };
}

/** What a walk does with each statement it reaches that is not one it descends into. */
type StatementVisitor = (
  stmt: PyNode,
  position: WalkPosition,
  scan: Scan,
) => void;

/** Statement shapes whose body can contain a call the reading follows. Every other block statement is left alone, since the binder records no name written inside one. */
const WALK_DESCENTS: Record<
  string,
  (
    stmt: PyNode,
    position: WalkPosition,
    scan: Scan,
    visit: StatementVisitor,
  ) => void
> = {
  decorated_definition: (stmt, position, scan, visit) => {
    walkStatements([stripDecorators(stmt).definition], position, scan, visit);
  },
  function_definition: (stmt, _position, scan, visit) => {
    // The binder skips a `def` written inside a block it does not
    // descend, and reading one against the enclosing scope would take
    // its locals for module names.
    const scope = scan.bound.module.scopeFor.get(stmt.id);
    if (scope === undefined) {
      return;
    }

    walkStatements(
      nestedStatements(stmt),
      {
        scope,
        loopBindings: new Map(),
        site: { kind: "function", node: stmt.id },
      },
      scan,
      visit,
    );
  },
  for_statement: (stmt, position, scan, visit) => {
    walkStatements(
      nestedStatements(stmt),
      { ...position, loopBindings: loopBindingsOf(stmt, position, scan) },
      scan,
      visit,
    );
  },
};

function nestedStatements(stmt: PyNode): PyNode[] {
  const body = field(stmt, "body");
  return body === null ? [] : bodyStatements(body);
}

function walkStatements(
  statements: PyNode[],
  position: WalkPosition,
  scan: Scan,
  visit: StatementVisitor,
): void {
  for (const stmt of statements) {
    const descend = WALK_DESCENTS[stmt.type];
    if (descend !== undefined) {
      descend(stmt, position, scan, visit);
      continue;
    }

    visit(stmt, position, scan);
  }
}

/** Every identifier a `for` target binds, whether it is one name or a tuple of them. */
function targetNames(node: PyNode): string[] {
  if (node.type === "identifier") {
    return [node.text];
  }

  return bodyStatements(node).flatMap(targetNames);
}

/** The element names of a literal list or tuple of bare names; null for any other iterable. */
function sequenceElementNames(node: PyNode | null): string[] | null {
  if (node === null || (node.type !== "list" && node.type !== "tuple")) {
    return null;
  }

  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child?.type !== "identifier") {
      return null;
    }
    names.push(child.text);
  }
  return names;
}

function loopBindingsOf(
  stmt: PyNode,
  position: WalkPosition,
  scan: Scan,
): Map<string, LoopTarget> {
  const bindings = new Map(position.loopBindings);
  const left = field(stmt, "left");
  if (left === null) {
    return bindings;
  }

  const elements = sequenceElementNames(field(stmt, "right"));
  if (left.type === "identifier" && elements !== null) {
    bindings.set(left.text, { kind: "sequence", elements });
    return bindings;
  }

  const location = `${scan.bound.displayPath}:${rangeOf(stmt).start}`;
  const iterated = field(stmt, "right");
  if (left.type === "identifier" && iterated?.type === "call") {
    bindings.set(left.text, {
      kind: "call",
      call: iterated,
      file: scan.bound.file,
      location,
    });
    return bindings;
  }

  for (const name of targetNames(left)) {
    bindings.set(name, { kind: "unenumerable", location });
  }
  return bindings;
}

/** The mount call a statement is, when it is one this library defines; null otherwise. */
function mountCallOf(
  stmt: PyNode,
  scope: Scope,
  scan: Scan,
): {
  call: PyNode;
  objectName: string;
  includerConstructorName: string;
  includerCall: PyNode;
} | null {
  if (stmt.type !== "expression_statement") {
    return null;
  }

  const call = stmt.namedChild(0);
  if (call === null || call.type !== "call") {
    return null;
  }

  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return null;
  }

  const objectNode = field(callee, "object");
  const attributeNode = field(callee, "attribute");
  if (
    objectNode?.type !== "identifier" ||
    attributeNode?.text !== scan.composition.includeMethodName
  ) {
    return null;
  }

  // The mount only counts when whatever it is called on was itself
  // constructed from an accepted module: `app.include_router(...)`
  // where `app = FastAPI()`. A same-named method on some other
  // object is not this library's mount.
  const includer = constructionOf(objectNode.text, scope, scan.importModule);
  if (includer === null) {
    return null;
  }

  return {
    call,
    objectName: objectNode.text,
    includerConstructorName: includer.constructorName,
    includerCall: includer.call,
  };
}

/**
 * The constructions a loop's own call comes down to. The rules settle the
 * call on an object, the object says what it contains, and each of those is
 * followed to the construction it is. Empty when any step does not settle,
 * and then the loop keeps its abstention.
 */
type ReturnedConstructions =
  | { kind: "settled"; found: Construction[] }
  | {
      kind: "unmatched";
      name: string;
      resolvedTo: string;
      matched: number;
      of: number;
    }
  | { kind: "unread" };

function constructionsReturnedBy(
  target: Extract<LoopTarget, { kind: "call" }>,
  index: PatternIndex,
): ReturnedConstructions {
  const facts = index.facts;
  if (facts === undefined) {
    return { kind: "unread" };
  }

  const callKey = nodeId(target.file, target.call);
  resolveCalls(facts, [callKey]);
  const returned = objectReturnedBy(facts, callKey);
  if (returned === null) {
    return { kind: "unread" };
  }

  // What the object contains are names, and each has to be asked about in
  // its own right before the rules will follow it to what it was built as.
  const contained = containedValues(facts, returned);
  const settled = subjectConstructions(facts, contained);

  const found: Construction[] = [];
  for (const value of contained) {
    // A value nothing settled is presumably a construction call already.
    const resolved = settled.get(value)?.constructionKey ?? value;
    const construction = index.byValueKey.get(resolved);
    if (construction === undefined) {
      return {
        kind: "unmatched",
        name: value,
        resolvedTo: resolved,
        matched: found.length,
        of: contained.length,
      };
    }
    found.push(construction);
  }
  return { kind: "settled", found };
}

/**
 * The constructions one mount call registers: the argument's own, the ones a
 * loop's written-out list binds it from, or the ones the rules settle a
 * loop's call on. Empty when nothing settles, and then the loop is recorded
 * as one this reading could not enumerate.
 */
function mountedConstructions(
  arg: DecoratorArg | undefined,
  position: WalkPosition,
  scan: Scan,
): Construction[] {
  if (arg?.kind === "attribute") {
    const construction = constructionThroughModule(arg, position.scope, scan);
    return construction === null ? [] : [construction];
  }

  if (arg?.kind !== "identifier") {
    return [];
  }

  const named = (name: string): Construction[] => {
    const construction =
      constructionNamed(name, position.scope, scan) ??
      constructionThroughFacts(name, position.scope, scan);
    return construction === null ? [] : [construction];
  };

  const target = position.loopBindings.get(arg.name);
  if (target === undefined) {
    return named(arg.name);
  }

  if (target.kind === "sequence") {
    return target.elements.flatMap(named);
  }

  if (target.kind === "call") {
    const returned = constructionsReturnedBy(target, scan.index);
    if (returned.kind === "settled" && returned.found.length > 0) {
      return returned.found;
    }
    scan.index.unenumerableLoops.set(target.location, {
      site: position.site,
      file: scan.bound.displayPath,
      location: target.location,
      ...(returned.kind === "unmatched" ? { unmatched: returned } : {}),
    });
    return [];
  }

  scan.index.unenumerableLoops.set(target.location, {
    site: position.site,
    file: scan.bound.displayPath,
    location: target.location,
  });
  return [];
}

/**
 * The construction one dotted hop reaches: `routers.orders` mounts the
 * router the `routers` module constructs at its top level under the
 * `orders` name. One hop, so `a.b.c` stays unread.
 */
function constructionThroughModule(
  arg: { objectName: string; attributeName: string },
  scope: Scope,
  scan: Scan,
): Construction | null {
  const binding = resolveName(scope, arg.objectName);
  if (binding === null) {
    return null;
  }

  const spec = importedModuleSpec(binding);
  if (spec === null) {
    return null;
  }

  const resolution = resolveModule(scan.bound.file, spec, scan.resolverOptions);
  if (resolution.status !== "resolved") {
    return null;
  }

  const target = scan.byFile.get(resolution.file);
  if (target === undefined) {
    return null;
  }

  return (
    scan.index.constructions.get(target.module)?.get(arg.attributeName) ?? null
  );
}

/** The module a binding refers to, when it refers to one at all. `from pkg import routers` refers to `pkg.routers` whenever no name shadows it. */
function importedModuleSpec(
  binding: Binding,
): { module: string; relativeLevel: number } | null {
  if (binding.kind === "import") {
    return { module: binding.module, relativeLevel: binding.relativeLevel };
  }

  if (binding.kind === "importFrom") {
    return {
      module:
        binding.module === ""
          ? binding.importedName
          : `${binding.module}.${binding.importedName}`,
      relativeLevel: binding.relativeLevel,
    };
  }

  return null;
}

function recordMountStatement(
  stmt: PyNode,
  position: WalkPosition,
  scan: Scan,
): void {
  const mountCall = mountCallOf(stmt, position.scope, scan);
  if (mountCall === null) {
    return;
  }

  const { args, keywordArgs } = readCallArguments(
    field(mountCall.call, "arguments"),
  );
  // Read in the scope the mount is written in, so an `Api` a factory
  // builds is the one whose prefix goes in front, not a same-named one
  // at the top of the file.
  const objectPrefix = mountObjectPrefix(
    mountCall.objectName,
    mountCall.includerCall,
    position.scope,
    scan,
  );
  const includerKey = nodeId(scan.bound.file, mountCall.includerCall);
  const state = mountStateOf(
    mountCall.includerConstructorName,
    scan.index.byValueKey.get(includerKey) ?? null,
    keywordArgs,
    objectPrefix,
    scan.composition,
    position.site,
    position.scope,
  );
  const mounted =
    args[0] ??
    (scan.composition.routerKeyword === undefined
      ? undefined
      : keywordArgs[scan.composition.routerKeyword]);
  for (const target of mountedConstructions(mounted, position, scan)) {
    recordMount(scan.index, target, state);
  }
}

/** Where one mount call leaves whatever it mounts, or why nothing can be said about it. */
function mountStateOf(
  includerConstructorName: string,
  includer: Construction | null,
  keywordArgs: Record<string, DecoratorArg>,
  objectPrefix: OwnPrefixResolution,
  composition: RouterComposition,
  site: MountSite,
  scope: Scope,
): MountState {
  const base = mountBaseOf(
    includerConstructorName,
    includer,
    objectPrefix,
    composition,
  );
  if (base.kind === "abstain") {
    return base;
  }

  const mountPrefix = readPrefixKeyword(
    keywordArgs,
    composition.prefixKeyword,
    composition,
    scope,
  );
  if (mountPrefix.kind === "unreadable") {
    return {
      kind: "abstain",
      reason: "is mounted with a prefix that is not a string literal",
    };
  }

  // A mount that states nothing leaves the router where its
  // constructor put it, whichever way the library reads a prefix
  // that is stated.
  if (mountPrefix.kind === "unstated") {
    return {
      kind: "mounted",
      includePrefix: base.value,
      site,
      parentValueKey: base.parentValueKey,
    };
  }

  const effect = composition.mountPrefixEffect ?? "prefixes";
  const state = MOUNT_STATE_BY_EFFECT[effect](mountPrefix.value, site);
  if (state.kind === "abstain") {
    return state;
  }

  return {
    ...state,
    includePrefix: base.value + state.includePrefix,
    parentValueKey: base.parentValueKey,
  };
}

type MountBase =
  | { kind: "composed"; value: string; parentValueKey: string | null }
  | { kind: "abstain"; reason: string };

/**
 * What goes in front of a mount's own stated prefix. A carrier
 * contributes its object prefix and roots the chain; a router
 * contributes its constructor prefix and hands its own mounts on, so
 * the chain composes hop by hop.
 */
function mountBaseOf(
  includerConstructorName: string,
  includer: Construction | null,
  objectPrefix: OwnPrefixResolution,
  composition: RouterComposition,
): MountBase {
  if (includerConstructorName !== composition.routerConstructorName) {
    if (objectPrefix.kind === "abstain") {
      return {
        kind: "abstain",
        reason: `is mounted on an object that ${objectPrefix.reason}`,
      };
    }

    return {
      kind: "composed",
      value: objectPrefix.value,
      parentValueKey: null,
    };
  }

  // A reassigned includer lands here too: the binder keeps the last
  // assignment, whose call the construction index never records.
  if (includer === null) {
    return {
      kind: "abstain",
      reason: "is mounted onto a router this reading never saw constructed",
    };
  }

  const parentOwn = composedOwnPrefix(includer.prefix, composition);
  if (parentOwn.kind === "abstain") {
    return {
      kind: "abstain",
      reason: `is mounted onto a router that ${parentOwn.reason}`,
    };
  }

  return {
    kind: "composed",
    value: parentOwn.value,
    parentValueKey: includer.valueKey,
  };
}

/**
 * Records where each carrier is registered and where each mount object
 * was handed one. Registration is read only to abstain: a call that
 * restates the prefix, puts the carrier inside another carrier, or
 * registers it a second time serves the carrier's routes somewhere its
 * own construction no longer says.
 */
function collectCarrierCalls(carrier: MountObjectCarrier, scan: Scan): void {
  walkStatements(
    bodyStatements(scan.bound.root),
    modulePosition(scan),
    scan,
    (stmt, position) => {
      const call = attributeCallOf(stmt);
      if (call === null) {
        return;
      }

      if (call.attribute === carrier.handoffMethodName) {
        recordHandoff(call, scan);
        return;
      }

      if (call.attribute === carrier.registerMethodName) {
        recordRegistrationCall(call, carrier, position, scan);
      }
    },
  );
}

/** An `object.attribute(...)` call, which is the shape of a handoff and a registration alike. */
interface AttributeCall {
  objectName: string;
  attribute: string;
  args: DecoratorArg[];
  keywordArgs: Record<string, DecoratorArg>;
}

function attributeCallOf(stmt: PyNode): AttributeCall | null {
  if (stmt.type !== "expression_statement") {
    return null;
  }

  const call = stmt.namedChild(0);
  if (call === null || call.type !== "call") {
    return null;
  }

  const callee = field(call, "function");
  if (callee === null || callee.type !== "attribute") {
    return null;
  }

  const objectNode = field(callee, "object");
  const attributeNode = field(callee, "attribute");
  if (objectNode?.type !== "identifier" || attributeNode === null) {
    return null;
  }

  return {
    objectName: objectNode.text,
    attribute: attributeNode.text,
    ...readCallArguments(field(call, "arguments")),
  };
}

function recordHandoff(call: AttributeCall, scan: Scan): void {
  const perModule =
    scan.index.handoffs.get(scan.bound.module) ??
    new Map<string, DecoratorArg[]>();
  scan.index.handoffs.set(scan.bound.module, perModule);

  const handed = perModule.get(call.objectName) ?? [];
  if (call.args[0] !== undefined) {
    handed.push(call.args[0]);
  }

  perModule.set(call.objectName, handed);
}

function recordRegistrationCall(
  call: AttributeCall,
  carrier: MountObjectCarrier,
  position: WalkPosition,
  scan: Scan,
): void {
  const arg = call.args[0];
  if (arg?.kind !== "identifier" || position.loopBindings.has(arg.name)) {
    return;
  }

  const target = constructionNamed(
    arg.name,
    position.scope,
    scan,
    scan.index.carriers,
  );
  if (target === null || target.constructorName !== carrier.constructorName) {
    return;
  }

  recordRegistration(
    scan.index,
    target,
    registrationState(call, carrier, position, scan),
  );
}

function registrationState(
  call: AttributeCall,
  carrier: MountObjectCarrier,
  position: WalkPosition,
  scan: Scan,
): RegistrationState {
  // The three written spellings say three different things, so a
  // written keyword says nothing on its own about where the routes
  // land.
  if (call.keywordArgs[carrier.prefixKeyword] !== undefined) {
    return {
      kind: "abstain",
      reason:
        "is built from one registered under a prefix stated where it is registered",
    };
  }

  const host = constructionNamed(
    call.objectName,
    position.scope,
    scan,
    scan.index.carriers,
  );
  if (host !== null && host.constructorName === carrier.constructorName) {
    return {
      kind: "abstain",
      reason:
        "is built from one registered inside another, one hop past what this reading follows",
    };
  }

  return { kind: "asBuilt" };
}

function recordRegistration(
  index: PatternIndex,
  target: Construction,
  state: RegistrationState,
): void {
  if (index.carrierRegistrations.has(target)) {
    index.carrierRegistrations.set(target, {
      kind: "abstain",
      reason: "is built from one registered more than once",
    });
    return;
  }

  index.carrierRegistrations.set(target, state);
}

/**
 * Reads what every module-level mount object puts in front of the
 * paths behind it, for the routes declared straight on that object.
 * A mount call reads the same thing in whatever scope it is written.
 */
function collectObjectPrefixes(spec: MountObjectPrefix, scan: Scan): void {
  for (const stmt of bodyStatements(scan.bound.root)) {
    const construction = constructionStatement(
      stmt,
      scan.bound.module.moduleScope,
      scan.importModule,
    );
    if (
      construction === null ||
      construction.constructorName === scan.composition.routerConstructorName
    ) {
      continue;
    }

    const perModule =
      scan.index.objectPrefixes.get(scan.bound.module) ??
      new Map<string, OwnPrefixResolution>();
    scan.index.objectPrefixes.set(scan.bound.module, perModule);
    perModule.set(
      construction.name,
      readMountObjectPrefix(
        spec,
        construction.name,
        construction.call,
        scan.bound.module.moduleScope,
        scan,
      ),
    );
  }
}

/** What the object a mount is called on puts in front of everything the constructor and the mount state. */
function mountObjectPrefix(
  objectName: string,
  constructionCall: PyNode,
  scope: Scope,
  scan: Scan,
): OwnPrefixResolution {
  const spec = scan.composition.mountObjectPrefix;
  if (spec === undefined) {
    return { kind: "composed", value: "" };
  }

  return readMountObjectPrefix(spec, objectName, constructionCall, scope, scan);
}

/**
 * The prefix written on the mount object's own construction, behind
 * the one written on whatever that construction was handed.
 */
function readMountObjectPrefix(
  spec: MountObjectPrefix,
  objectName: string,
  constructionCall: PyNode,
  scope: Scope,
  scan: Scan,
): OwnPrefixResolution {
  const { args, keywordArgs } = readCallArguments(
    field(constructionCall, "arguments"),
  );

  const own =
    spec.prefixKeyword === undefined
      ? UNSTATED_PREFIX
      : readPrefixKeyword(
          keywordArgs,
          spec.prefixKeyword,
          scan.composition,
          scan.bound.module.moduleScope,
        );
  if (own.kind === "unreadable") {
    return {
      kind: "abstain",
      reason: "states a prefix of its own that is not a string literal",
    };
  }

  const carried =
    spec.carrier === undefined
      ? { kind: "composed" as const, value: "" }
      : carrierPrefix(
          spec.carrier,
          args[spec.carrier.argumentIndex],
          objectName,
          scope,
          scan,
        );
  if (carried.kind === "abstain") {
    return carried;
  }

  return {
    kind: "composed",
    value: carried.value + (own.kind === "stated" ? own.value : ""),
  };
}

function carrierPrefix(
  carrier: MountObjectCarrier,
  constructorArg: DecoratorArg | undefined,
  objectName: string,
  scope: Scope,
  scan: Scan,
): OwnPrefixResolution {
  const handed =
    scan.index.handoffs.get(scan.bound.module)?.get(objectName) ?? [];
  const candidates = [
    ...(constructorArg === undefined ? [] : [constructorArg]),
    ...handed,
  ];
  if (candidates.length > 1) {
    return { kind: "abstain", reason: "is built from more than one candidate" };
  }

  // Nothing was handed in anywhere this reading can see, so there is
  // no carrier to read a prefix off.
  const candidate = candidates[0];
  if (candidate === undefined) {
    return { kind: "composed", value: "" };
  }

  if (candidate.kind !== "identifier") {
    return {
      kind: "abstain",
      reason: "is built from something this reading cannot follow",
    };
  }

  const construction = constructionNamed(
    candidate.name,
    scope,
    scan,
    scan.index.carriers,
  );
  if (construction === null) {
    return {
      kind: "abstain",
      reason: "is built from something this reading cannot follow",
    };
  }

  if (construction.constructorName !== carrier.constructorName) {
    return { kind: "composed", value: "" };
  }

  if (construction.reassigned) {
    return {
      kind: "abstain",
      reason:
        "is built from one whose variable name holds a second construction",
    };
  }

  const registration = scan.index.carrierRegistrations.get(construction);
  if (registration?.kind === "abstain") {
    return { kind: "abstain", reason: registration.reason };
  }

  const readings: Record<PrefixReading["kind"], () => OwnPrefixResolution> = {
    stated: () => ({
      kind: "composed",
      value:
        construction.prefix.kind === "stated" ? construction.prefix.value : "",
    }),
    unstated: () => ({ kind: "composed", value: "" }),
    unreadable: () => ({
      kind: "abstain",
      reason: "is built from one whose prefix is not a string literal",
    }),
  };
  return readings[construction.prefix.kind]();
}
