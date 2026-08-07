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
// mounted twice, or a router mounted onto another router (a second
// hop). Discovery turns an abstention into a unit that keeps its name
// and carries no path, so it pairs with nothing rather than with
// whatever a guessed path would have named.

import { bodyStatements, field } from "./ast.js";
import { readCallArguments } from "./decorators.js";
import { resolveModule } from "./moduleResolver.js";
import { resolveName } from "./scope.js";

import type { DecoratorArg } from "./decorators.js";
import type { ModuleResolverOptions } from "./moduleResolver.js";
import type {
  DecoratedFunctionRoute,
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
    pattern: DecoratedFunctionRoute,
    module: ModuleBinding,
    objectName: string,
  ): RoutePrefixResolution;
}

/** A module-level `x = <RouterConstructor>(...)`. `ownPrefix` is null when the prefix keyword's value isn't a string literal. */
interface RouterConstruction {
  ownPrefix: string | null;
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

type MountState =
  | { kind: "mounted"; includePrefix: string }
  | { kind: "abstain"; reason: string };

interface PatternIndex {
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
  const byPattern = new Map<DecoratedFunctionRoute, PatternIndex>();
  for (const pack of packs) {
    for (const pattern of pack.discovery) {
      if (
        pattern.type === "decoratedFunctionRoute" &&
        pattern.routerComposition !== undefined
      ) {
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

      if (construction.ownPrefix === null) {
        return {
          kind: "abstain",
          reason: "declares a prefix that is not a string literal",
        };
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
        value: mount.includePrefix + construction.ownPrefix,
      };
    },
  };
}

function buildPatternIndex(
  files: BoundPythonFile[],
  importModule: string[],
  composition: RouterComposition,
  resolverOptions: ModuleResolverOptions,
): PatternIndex {
  const index: PatternIndex = { constructions: new Map(), mounts: new Map() };
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

/** The literal a prefix keyword states: "" when absent, the string when literal, null when written as anything else. */
function prefixOf(
  keywordArgs: Record<string, DecoratorArg>,
  prefixKeyword: string,
): string | null {
  const arg = keywordArgs[prefixKeyword];
  if (arg === undefined) {
    return "";
  }

  if (arg.kind === "string") {
    return arg.value;
  }

  return null;
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
      ownPrefix: prefixOf(keywordArgs, composition.prefixKeyword),
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

    const includePrefix = prefixOf(keywordArgs, composition.prefixKeyword);
    if (includePrefix === null) {
      recordMount(index, target, {
        kind: "abstain",
        reason: "is mounted with a prefix that is not a string literal",
      });
      continue;
    }

    recordMount(index, target, { kind: "mounted", includePrefix });
  }
}
