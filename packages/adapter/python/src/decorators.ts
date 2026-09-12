// decorators.ts: decorator lowering and module classification.
//
// A decorator expression is really two applications: the factory call
// that builds the decorator (`app.route("/x")`) and the decoration
// itself, which applies that result to the function. Discovery only
// needs the first one. What name did the call's callee resolve to, and
// which module did that name come from? `classifyDecorator` reads that
// much and stops, without building call facts nothing downstream reads
// yet.
//
// This is the same recipe the TypeScript packs use for a decorator
// re-exported through a project's own wrapper: classify the name as an
// import of module X, and let the pack list every module X it accepts.

import { dispatchByType } from "@suss/behavioral-ir";

import {
  enclosingFunction,
  field,
  rangeOf,
  stringLiteralValue,
} from "./ast.js";
import {
  constructionBehind,
  moduleOf,
  writtenNodeOf,
} from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { DispatchTable } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { Range } from "./ast.js";
import type { PyNode } from "./parser.js";
import type { ModuleBinding } from "./scope.js";
import type { BuiltValue } from "./values/evaluator.js";

/** An argument as written, plus its node so a reader can evaluate what it comes down to. */
export type DecoratorArg = DecoratorArgShape & { readonly node: PyNode };

type DecoratorArgShape =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "none" }
  /** A bare name. The caller resolves it, using the scope it already has. */
  | { kind: "identifier"; name: string }
  /** One dotted hop, `routers.orders`. The caller decides what the object is. */
  | { kind: "attribute"; objectName: string; attributeName: string }
  | { kind: "list"; items: DecoratorArg[] }
  | { kind: "other" };

export interface DecoratorClassification {
  /** The name as its source module exports it, not the local alias or attribute path it was written under. */
  importedName: string | null;
  /** The dotted module the name was imported from. It is null whenever `importedName` is null. */
  module: string | null;
  /** The local variable an attribute decorator hangs on, `app` in `@app.get(...)`. */
  objectName: string | null;
  args: DecoratorArg[];
  keywordArgs: Record<string, DecoratorArg>;
  /** Where the decorator is written. Anything we read out of its arguments uses this as its provenance. */
  range: Range;
  /**
   * The module the decorator's object lives in, when the decorator was read
   * through a project wrapper written in another file. The router prefix is
   * resolved there, since that is where the namespace is constructed.
   */
  objectModule?: ModuleBinding;
  /**
   * The call the rules say built the object this decorator hangs on. A
   * router the index never saw under a name is looked up by this call
   * instead, and a decorator on `self.router` has no name to look up.
   */
  subjectConstruction?: { key: string; constructorName: string };
}

/** What a decorator hangs on and which of its methods it calls, for `@app.get(...)` and `@self.app.get(...)` alike. */
export interface DecoratorReceiver {
  /** The expression the method is called on, whatever kind it is. */
  object: PyNode;
  /** The method's own name, `get` in `@app.get("/x")`. */
  attributeName: string;
  args: DecoratorArg[];
  keywordArgs: Record<string, DecoratorArg>;
  range: Range;
}

/**
 * The receiver and method a decorator is written as, without resolving
 * either. Whoever calls this has another way to say what the receiver is,
 * so nothing here reads the scope.
 */
export function decoratorReceiver(
  decoratorNode: PyNode,
): DecoratorReceiver | null {
  const range = rangeOf(decoratorNode);
  const expr = decoratorNode.namedChild(0);
  if (expr === null) {
    return null;
  }

  const applied = expr.type === "call" ? field(expr, "function") : expr;
  if (applied === null || applied.type !== "attribute") {
    return null;
  }
  const object = field(applied, "object");
  const attribute = field(applied, "attribute");
  if (object === null || attribute === null) {
    return null;
  }

  const argumentList = expr.type === "call" ? field(expr, "arguments") : null;
  const { args, keywordArgs } =
    argumentList?.type === "argument_list"
      ? readCallArguments(argumentList)
      : { args: [], keywordArgs: {} };
  return { object, attributeName: attribute.text, args, keywordArgs, range };
}

function readArg(node: PyNode): DecoratorArg {
  return { ...argShapeOf(node), node };
}

function argShapeOf(node: PyNode): DecoratorArgShape {
  const literal = stringLiteralValue(node);
  if (literal !== null) {
    return { kind: "string", value: literal };
  }
  if (node.type === "integer") {
    const value = Number.parseInt(node.text, 10);
    if (Number.isFinite(value)) {
      return { kind: "number", value };
    }
    return { kind: "other" };
  }
  if (node.type === "none") {
    return { kind: "none" };
  }
  if (node.type === "true" || node.type === "false") {
    return { kind: "boolean", value: node.type === "true" };
  }
  if (node.type === "identifier") {
    return { kind: "identifier", name: node.text };
  }
  if (node.type === "attribute") {
    const object = field(node, "object");
    const attribute = field(node, "attribute");
    if (object?.type === "identifier" && attribute?.type === "identifier") {
      return {
        kind: "attribute",
        objectName: object.text,
        attributeName: attribute.text,
      };
    }
    return { kind: "other" };
  }
  if (node.type === "list") {
    return {
      kind: "list",
      items: node.namedChildren
        .filter((child): child is PyNode => child !== null)
        .map(readArg),
    };
  }
  return { kind: "other" };
}

/** Both decorator calls and router mounts read their arguments through here. */
export function readCallArguments(argumentList: PyNode | null): {
  args: DecoratorArg[];
  keywordArgs: Record<string, DecoratorArg>;
} {
  const args: DecoratorArg[] = [];
  const keywordArgs: Record<string, DecoratorArg> = {};
  if (argumentList === null) {
    return { args, keywordArgs };
  }
  for (const child of argumentList.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "keyword_argument") {
      const nameNode = field(child, "name");
      const valueNode = field(child, "value");
      if (nameNode !== null && valueNode !== null) {
        keywordArgs[nameNode.text] = readArg(valueNode);
      }
      continue;
    }
    // `f(**cfg)` and `f(*rest)` spread a value the call does not write
    // out. Neither one is an argument at a position, and counting a spread as
    // the first positional argument made `Api(**authorizations())` look like
    // a construction on something this reading could not identify, which
    // left every route under it with no path.
    //
    // A spread dictionary could carry the prefix keyword itself. Reading
    // the keywords that are written and leaving it there is what keeps
    // the routes; see the Python adapter README.
    if (child.type === "dictionary_splat" || child.type === "list_splat") {
      continue;
    }
    args.push(readArg(child));
  }
  return { args, keywordArgs };
}

/** Everything a classification says about its callee, before the arguments are read. */
type ResolvedCallee = Pick<
  DecoratorClassification,
  "importedName" | "module" | "objectName" | "subjectConstruction"
>;

const UNRESOLVED: ResolvedCallee = {
  importedName: null,
  module: null,
  objectName: null,
};

/**
 * What the call that built a decorator's object says about the decorator.
 * Two constructions out of the same module still say which pack the route
 * belongs to, and leaving out the construction key sends the router index
 * looking by name, where it reports the name the two share. Two that
 * disagree about the module say nothing.
 */
function builtObjectCallee(
  built: BuiltValue,
  attributeName: string,
  objectName: string | null,
): ResolvedCallee | null {
  const table: DispatchTable<BuiltValue, ResolvedCallee | null> = {
    noCall: () => null,
    oneCall: ({ construction }) => ({
      importedName: attributeName,
      module: construction.origin.module,
      objectName,
      subjectConstruction: {
        key: construction.key,
        constructorName: construction.origin.name,
      },
    }),
    severalCalls: ({ constructions }) => {
      const modules = new Set(
        constructions.map((construction) => construction.origin.module),
      );
      const agreed = [...modules][0];
      if (modules.size !== 1 || agreed === undefined) {
        return null;
      }
      return { importedName: attributeName, module: agreed, objectName };
    },
  };
  return dispatchByType(table, built);
}

/**
 * A decorator's callee, as the name a module exports and the module that
 * exports it. An attribute chain deeper than one property access
 * (`a.b.route`) is left unresolved, and its decorator is not discovered.
 */
function resolveCallee(
  expr: PyNode,
  module: ModuleBinding,
  facts: Database | undefined,
): ResolvedCallee {
  if (expr.type === "identifier") {
    const origin = originOf(expr, module);
    return origin === null
      ? UNRESOLVED
      : { importedName: origin.name, module: origin.module, objectName: null };
  }
  if (expr.type !== "attribute") {
    return UNRESOLVED;
  }

  const object = field(expr, "object");
  const attribute = field(expr, "attribute");
  if (object === null || attribute === null) {
    return UNRESOLVED;
  }
  const objectName = object.type === "identifier" ? object.text : null;

  // What a name was assigned wins over what it was imported as. Python
  // lets `import app.store` bind `app` over an `app = FastAPI()` written
  // above it, and the app is what the decorator hangs on.
  const built = builtObjectCallee(
    constructionBehind(object, facts),
    attribute.text,
    objectName,
  );
  if (built !== null) {
    return built;
  }

  const imported = originOf(expr, module);
  return imported === null
    ? UNRESOLVED
    : {
        importedName: imported.name,
        module: imported.module,
        objectName,
      };
}

export function classifyDecorator(
  decoratorNode: PyNode,
  module: ModuleBinding,
  facts?: Database,
): DecoratorClassification {
  const range = rangeOf(decoratorNode);
  const expr = decoratorNode.namedChild(0);
  if (expr === null) {
    return { ...UNRESOLVED, args: [], keywordArgs: {}, range };
  }

  if (expr.type === "call") {
    const callee = field(expr, "function");
    const argumentList = field(expr, "arguments");
    const resolved =
      callee !== null ? resolveCallee(callee, module, facts) : UNRESOLVED;
    const { args, keywordArgs } =
      argumentList?.type === "argument_list"
        ? readCallArguments(argumentList)
        : { args: [], keywordArgs: {} };
    return { ...resolved, args, keywordArgs, range };
  }

  return {
    ...resolveCallee(expr, module, facts),
    args: [],
    keywordArgs: {},
    range,
  };
}

/**
 * Read a decorator through a project wrapper:
 *
 *     def api_route(path):
 *         return orders_namespace.route(path)
 *
 * The rules say what the wrapper's call comes down to, wherever the
 * wrapper is written. A wrapper that rearranges its parameters gives null,
 * because the arguments written here are then not the ones the library is
 * called with.
 */
export function unwrapDecorator(
  decoratorNode: PyNode,
  facts: Database | undefined,
): DecoratorClassification | null {
  const expr = decoratorNode.namedChild(0);
  if (expr === null || expr.type !== "call") {
    return null;
  }

  const inner = writtenNodeOf(expr, facts);
  const innerCallee = inner === null ? null : field(inner, "function");
  if (
    inner === null ||
    innerCallee === null ||
    innerCallee.type !== "attribute"
  ) {
    return null;
  }

  const wrapper = enclosingFunction(inner);
  if (wrapper === null || !passesParametersThrough(wrapper, inner)) {
    return null;
  }

  const wrapperModule = moduleOf(inner);
  const resolved = resolveCallee(innerCallee, wrapperModule, facts);
  if (resolved.importedName === null) {
    return null;
  }

  const argumentList = field(expr, "arguments");
  const { args, keywordArgs } =
    argumentList?.type === "argument_list"
      ? readCallArguments(argumentList)
      : { args: [], keywordArgs: {} };
  return {
    ...resolved,
    args,
    keywordArgs,
    range: rangeOf(decoratorNode),
    objectModule: wrapperModule,
  };
}

/** Whether the inner call's positional arguments are the def's parameters, in order. */
function passesParametersThrough(def: PyNode, inner: PyNode): boolean {
  const params = field(def, "parameters");
  const names = (params?.namedChildren ?? [])
    .filter((child): child is PyNode => child?.type === "identifier")
    .map((child) => child.text);

  const argumentList = field(inner, "arguments");
  const positional = (argumentList?.namedChildren ?? []).filter(
    (child): child is PyNode =>
      child !== null && child.type !== "keyword_argument",
  );
  return (
    positional.length === names.length &&
    positional.every(
      (argument, at) =>
        argument.type === "identifier" && argument.text === names[at],
    )
  );
}
