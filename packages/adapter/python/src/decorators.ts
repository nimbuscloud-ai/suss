/**
 * Works out which library a decorator comes from, for discovery.
 *
 * `@app.route("/x")` is two steps: the call that builds the decorator, and
 * applying the result to the function. Discovery needs only the first, so
 * `classifyDecorator` reads which name the callee resolved to and which
 * module that name came from, and stops there.
 *
 * A decorator re-exported through a project wrapper is handled the same
 * way the TypeScript packs handle one: the name is classified as an import
 * of some module, and the pack lists every module it accepts.
 */

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

/** An argument as written, plus its node so a reader can evaluate it. */
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
  /** The name as its source module exports it, whatever alias or attribute path the file wrote it under. */
  importedName: string | null;
  /** The dotted module the name was imported from. It is null whenever `importedName` is null. */
  module: string | null;
  /** The local variable an attribute decorator is called on, `app` in `@app.get(...)`. */
  objectName: string | null;
  args: DecoratorArg[];
  keywordArgs: Record<string, DecoratorArg>;
  /** Where the decorator is written. Anything read out of its arguments reports this as its location. */
  range: Range;
  /**
   * The module the decorator's object lives in, when the decorator was read
   * through a project wrapper written in another file. The router prefix is
   * resolved there, since that is where the namespace is constructed.
   */
  objectModule?: ModuleBinding;
  /**
   * The call the rules say built the object this decorator is called on.
   * The router index looks a router up by this call when it never saw the
   * router under a name, as with a decorator on `self.router`.
   */
  subjectConstruction?: { key: string; constructorName: string };
}

/** The object a decorator is called on and the method it calls, for `@app.get(...)` and `@self.app.get(...)` alike. */
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
 * either. The caller works out what the receiver is by its own means, so
 * nothing here reads the scope.
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
    // A spread is not an argument at a position. Counting `Api(**opts)` as
    // one would leave every route under it without a path. DESIGN.md covers
    // a spread dictionary that sets the prefix keyword itself.
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
 * The callee a decorator resolves to, from the call that built its object.
 * Two constructions from the same module still decide which pack the
 * route belongs to. The construction key is left out then, so the router
 * index looks the router up by the name the two share. Two constructions
 * from different modules resolve to nothing.
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
 * exports it. For `@obj.method`, the call that built `obj` decides the
 * module when the rules find one, and the file's imports decide otherwise.
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
  // above it, and the decorator is still called on the app.
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
 * The rules resolve the wrapper call to the library call inside it,
 * wherever the wrapper is written. A wrapper that rearranges its
 * parameters gives null, because the arguments written at the decorator
 * are then different from the ones the library receives.
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
