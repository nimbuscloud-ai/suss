// routers.ts: router prefix composition, one mount hop deep.
//
// A route declared on a sub-router (`@router.get("/x")` where `router
// = APIRouter(prefix="/items")`) is served at a path the route file
// never states: the mount call (`app.include_router(router,
// prefix="/api")`) supplies one prefix and the constructor supplies
// another. This module reads exactly that much, ahead of discovery:
// every module-level router construction, every module-level mount
// call whose router argument is a bare name (bound in the same file,
// or imported from the file that constructed it), and the literal
// prefixes on both. Everything else abstains with a reason: a
// non-literal prefix, a router nobody mounts by name, a router
// mounted twice, a router mounted onto another router (a second hop),
// or a mount that overrides the prefix the constructor stated.
// Discovery turns an abstention into a unit that keeps its name and
// carries no path, so it pairs with nothing rather than with whatever
// a guessed path would have named.
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

import { bodyStatements, field } from "./ast.js";
import { readCallArguments } from "./decorators.js";
import { resolveModule } from "./moduleResolver.js";
import { resolveName } from "./scope.js";

import type { DecoratorArg } from "./decorators.js";
import type { ModuleResolverOptions } from "./moduleResolver.js";
import type {
  MountPrefixEffect,
  PrefixTrailingSlash,
  PythonDiscoveryPattern,
  PythonPack,
  RouterComposition,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type { Binding, ModuleBinding } from "./scope.js";

/** One parsed-and-bound file, the shape `buildRouterIndex` reads a project as. */
export interface BoundPythonFile {
  /** Absolute path, the identity module resolution joins on. */
  file: string;
  root: PyNode;
  module: ModuleBinding;
}

/**
 * What a decorator's base object turns out to be. `notRouter` covers
 * the app itself and anything the index never saw constructed, so the
 * decorator's own path stands as written; `composed` carries the
 * mount-plus-constructor prefix to put in front of that path;
 * `abstain` keeps the route pathless, with a reason phrased to follow
 * "the router this route is declared on ...".
 */
export type RoutePrefixResolution =
  | { kind: "notRouter" }
  | { kind: "composed"; value: string }
  | { kind: "abstain"; reason: string };

export interface RouterIndex {
  resolve(
    pattern: PythonDiscoveryPattern,
    module: ModuleBinding,
    objectName: string,
  ): RoutePrefixResolution;
}

/** A module-level `x = <RouterConstructor>(...)`, and what its call said about the prefix. */
interface RouterConstruction {
  /** What the constructor stated, with the library's trailing-slash handling already applied. */
  prefix: PrefixReading;
  /**
   * True when the same module-level name is assigned a router
   * construction more than once. The binder keeps one binding per
   * name, but the library binds a route to whichever router the name
   * held at decoration time, so which construction a decorator or a
   * mount saw is an ordering this reading does not follow. Composing
   * from the last one would report a confident wrong path.
   */
  reassigned: boolean;
}

/**
 * What a prefix keyword turned out to say at one site. "unstated"
 * covers a keyword nobody wrote and one written with a value the
 * library takes as none of its own; "unreadable" is an expression
 * this reading does not evaluate.
 */
type PrefixReading =
  | { kind: "stated"; value: string }
  | { kind: "unstated" }
  | { kind: "unreadable" };

const UNSTATED_PREFIX: PrefixReading = { kind: "unstated" };
const UNREADABLE_PREFIX: PrefixReading = { kind: "unreadable" };

/** What a construction's own prefix contributes, or why nothing can be said about it. */
type OwnPrefixResolution =
  | { kind: "composed"; value: string }
  | { kind: "abstain"; reason: string };

type MountState =
  | { kind: "mounted"; includePrefix: string }
  | { kind: "abstain"; reason: string };

interface PatternIndex {
  composition: RouterComposition;
  constructions: Map<ModuleBinding, Map<string, RouterConstruction>>;
  mounts: Map<RouterConstruction, MountState>;
}

const NOT_ROUTER: RoutePrefixResolution = { kind: "notRouter" };

/**
 * Scan every file once per composition-bearing pattern and answer
 * discovery's question: given the variable a route decorator hangs
 * on, what prefix (if any) does its mount compose, or why does the
 * reading abstain.
 */
export function buildRouterIndex(
  files: BoundPythonFile[],
  packs: PythonPack[],
  resolverOptions: ModuleResolverOptions,
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

  return {
    resolve(pattern, module, objectName) {
      const index = byPattern.get(pattern);
      if (index === undefined) {
        return NOT_ROUTER;
      }

      const construction = index.constructions.get(module)?.get(objectName);
      if (construction === undefined) {
        return NOT_ROUTER;
      }

      if (construction.reassigned) {
        return {
          kind: "abstain",
          reason: "shares its variable name with a second router construction",
        };
      }

      const ownPrefix = composedOwnPrefix(
        construction.prefix,
        index.composition,
      );
      if (ownPrefix.kind === "abstain") {
        return ownPrefix;
      }

      const mount = index.mounts.get(construction);
      if (mount === undefined) {
        return {
          kind: "abstain",
          reason:
            "is never mounted through a single variable binding in the files read",
        };
      }

      if (mount.kind === "abstain") {
        return { kind: "abstain", reason: mount.reason };
      }

      return {
        kind: "composed",
        value: mount.includePrefix + ownPrefix.value,
      };
    },
  };
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
  resolverOptions: ModuleResolverOptions,
): PatternIndex {
  const index: PatternIndex = {
    composition,
    constructions: new Map(),
    mounts: new Map(),
  };
  const byFile = new Map(files.map((bound) => [bound.file, bound]));

  for (const bound of files) {
    collectConstructions(bound, importModule, composition, index);
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
 * The call node a module-level name was assigned from, when its callee
 * is a name imported from one of the accepted modules. Returns that
 * callee's imported name alongside the call, so a caller can tell the
 * router constructor from the app's. Same one-hop bound as
 * `classifyDecorator`'s object tracing: one assignment back to a
 * constructor, never a chain.
 */
function constructionOf(
  name: string,
  module: ModuleBinding,
  importModule: string[],
): { constructorName: string; call: PyNode } | null {
  const binding = resolveName(module.moduleScope, name);
  if (binding?.kind !== "assignment" || binding.value?.type !== "call") {
    return null;
  }

  const callee = field(binding.value, "function");
  if (callee?.type !== "identifier") {
    return null;
  }

  const calleeBinding = resolveName(module.moduleScope, callee.text);
  if (
    calleeBinding?.kind !== "importFrom" ||
    !importModule.includes(calleeBinding.module)
  ) {
    return null;
  }

  return { constructorName: calleeBinding.importedName, call: binding.value };
}

/**
 * The prefix as the library holds it, which for some libraries is not
 * quite what the source wrote: one joins a route's path to the prefix
 * as written, another drops trailing slashes first, and composing
 * without that reports a doubled slash nobody serves.
 */
const PREFIX_TRAILING_SLASH_READERS: Record<
  PrefixTrailingSlash,
  (prefix: string) => string
> = {
  kept: (prefix) => prefix,
  trimmed: (prefix) => prefix.replace(/\/+$/, ""),
};

/**
 * Whether a written argument is one of the values a library can take
 * as no value at all. Python's `None` and `False`, zero, and the
 * empty string are the four, and a library reaches them all at once
 * by asking whether the value is truthy. Whether this library does
 * that is the pack's to say; what the four are is the language's.
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
 * What a prefix keyword says at one site. Every site reads it through
 * here, so a spelling means the same thing at a constructor and at a
 * mount, which is the property this reading kept getting wrong one
 * site at a time.
 */
function readPrefixKeyword(
  keywordArgs: Record<string, DecoratorArg>,
  composition: RouterComposition,
): PrefixReading {
  const arg = keywordArgs[composition.prefixKeyword];
  if (arg === undefined) {
    return UNSTATED_PREFIX;
  }

  if (
    (composition.noValuePrefix ?? "unreadable") === "unstated" &&
    NO_VALUE_LITERALS[arg.kind]?.(arg) === true
  ) {
    return UNSTATED_PREFIX;
  }

  if (arg.kind === "string") {
    return { kind: "stated", value: arg.value };
  }

  return UNREADABLE_PREFIX;
}

/** The prefix a constructor call leaves the router holding, trailing slash handled the way the library handles it. */
function constructorPrefix(
  keywordArgs: Record<string, DecoratorArg>,
  composition: RouterComposition,
): PrefixReading {
  const reading = readPrefixKeyword(keywordArgs, composition);
  if (reading.kind !== "stated") {
    return reading;
  }

  const trailingSlash = composition.constructorPrefixTrailingSlash ?? "kept";
  return {
    kind: "stated",
    value: PREFIX_TRAILING_SLASH_READERS[trailingSlash](reading.value),
  };
}

/** The name and call of a module-level `name = <RouterConstructor>(...)` statement; null for any other statement. */
function routerConstructionStatement(
  stmt: PyNode,
  module: ModuleBinding,
  importModule: string[],
  composition: RouterComposition,
): { name: string; call: PyNode } | null {
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
  if (callee?.type !== "identifier") {
    return null;
  }

  const calleeBinding = resolveName(module.moduleScope, callee.text);
  if (
    calleeBinding?.kind !== "importFrom" ||
    !importModule.includes(calleeBinding.module) ||
    calleeBinding.importedName !== composition.routerConstructorName
  ) {
    return null;
  }

  return { name: left.text, call: right };
}

/**
 * Walks the module's statements rather than its bindings map: the
 * binder keeps one binding per name, and a name assigned a router
 * construction twice has to surface as `reassigned` instead of
 * quietly reading as whichever assignment came last.
 */
function collectConstructions(
  bound: BoundPythonFile,
  importModule: string[],
  composition: RouterComposition,
  index: PatternIndex,
): void {
  for (const stmt of bodyStatements(bound.root)) {
    const construction = routerConstructionStatement(
      stmt,
      bound.module,
      importModule,
      composition,
    );
    if (construction === null) {
      continue;
    }

    const perModule =
      index.constructions.get(bound.module) ??
      new Map<string, RouterConstruction>();
    index.constructions.set(bound.module, perModule);

    const existing = perModule.get(construction.name);
    if (existing !== undefined) {
      existing.reassigned = true;
      continue;
    }

    const { keywordArgs } = readCallArguments(
      field(construction.call, "arguments"),
    );
    perModule.set(construction.name, {
      prefix: constructorPrefix(keywordArgs, composition),
      reassigned: false,
    });
  }
}

/**
 * The construction a mount call's router argument names, followed
 * through exactly one variable binding: a name assigned in this file,
 * or a name imported from the file that assigned it. Anything else
 * (an attribute like `items.router`, a call, an unresolvable import)
 * returns null, and the router it meant stays unmounted, which is
 * what makes its routes abstain.
 */
function mountTarget(
  arg: DecoratorArg | undefined,
  bound: BoundPythonFile,
  byFile: Map<string, BoundPythonFile>,
  resolverOptions: ModuleResolverOptions,
  index: PatternIndex,
): RouterConstruction | null {
  if (arg?.kind !== "identifier") {
    return null;
  }

  const binding = resolveName(bound.module.moduleScope, arg.name);
  if (binding === null) {
    return null;
  }

  const resolvers: Partial<
    Record<Binding["kind"], () => RouterConstruction | null>
  > = {
    assignment: () =>
      index.constructions.get(bound.module)?.get(arg.name) ?? null,
    importFrom: () => {
      if (binding.kind !== "importFrom") {
        return null;
      }

      const resolution = resolveModule(
        bound.file,
        { module: binding.module, relativeLevel: binding.relativeLevel },
        resolverOptions,
      );
      if (resolution.status !== "resolved") {
        return null;
      }

      const target = byFile.get(resolution.file);
      if (target === undefined) {
        return null;
      }

      return (
        index.constructions.get(target.module)?.get(binding.importedName) ??
        null
      );
    },
  };

  return resolvers[binding.kind]?.() ?? null;
}

/**
 * What a prefix the mount call states leaves the router mounted at,
 * per what the library does with it. A mount that states none, in any
 * of the spellings the library takes as none, never reaches here: it
 * leaves the router mounted where its constructor put it.
 */
const MOUNT_STATE_BY_EFFECT: Record<
  MountPrefixEffect,
  (statedPrefix: string) => MountState
> = {
  prefixes: (statedPrefix) => ({
    kind: "mounted",
    includePrefix: statedPrefix,
  }),
  replaces: () => ({
    kind: "abstain",
    reason:
      "is mounted under a prefix that replaces the one it was constructed with, which this reading does not follow",
  }),
};

function recordMount(
  index: PatternIndex,
  target: RouterConstruction,
  state: MountState,
): void {
  if (index.mounts.has(target)) {
    index.mounts.set(target, {
      kind: "abstain",
      reason: "is mounted more than once",
    });
    return;
  }

  index.mounts.set(target, state);
}

function collectMounts(
  bound: BoundPythonFile,
  byFile: Map<string, BoundPythonFile>,
  importModule: string[],
  composition: RouterComposition,
  resolverOptions: ModuleResolverOptions,
  index: PatternIndex,
): void {
  for (const stmt of bodyStatements(bound.root)) {
    if (stmt.type !== "expression_statement") {
      continue;
    }

    const call = stmt.namedChild(0);
    if (call === null || call.type !== "call") {
      continue;
    }

    const callee = field(call, "function");
    if (callee === null || callee.type !== "attribute") {
      continue;
    }

    const objectNode = field(callee, "object");
    const attributeNode = field(callee, "attribute");
    if (
      objectNode?.type !== "identifier" ||
      attributeNode?.text !== composition.includeMethodName
    ) {
      continue;
    }

    // The mount only counts when whatever it is called on was itself
    // constructed from an accepted module: `app.include_router(...)`
    // where `app = FastAPI()`. A same-named method on some other
    // object is not this library's mount.
    const includer = constructionOf(
      objectNode.text,
      bound.module,
      importModule,
    );
    if (includer === null) {
      continue;
    }

    const { args, keywordArgs } = readCallArguments(field(call, "arguments"));
    const target = mountTarget(args[0], bound, byFile, resolverOptions, index);
    if (target === null) {
      continue;
    }

    if (includer.constructorName === composition.routerConstructorName) {
      recordMount(index, target, {
        kind: "abstain",
        reason:
          "is mounted onto another router, one hop past what this reading follows",
      });
      continue;
    }

    const mountPrefix = readPrefixKeyword(keywordArgs, composition);
    if (mountPrefix.kind === "unreadable") {
      recordMount(index, target, {
        kind: "abstain",
        reason: "is mounted with a prefix that is not a string literal",
      });
      continue;
    }

    // A mount that states nothing leaves the router where its
    // constructor put it, whichever way the library reads a prefix
    // that is stated.
    if (mountPrefix.kind === "unstated") {
      recordMount(index, target, { kind: "mounted", includePrefix: "" });
      continue;
    }

    const effect = composition.mountPrefixEffect ?? "prefixes";
    recordMount(
      index,
      target,
      MOUNT_STATE_BY_EFFECT[effect](mountPrefix.value),
    );
  }
}
