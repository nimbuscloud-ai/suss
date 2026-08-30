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

import { field, rangeOf, stringLiteralValue } from "./ast.js";
import { resolveName } from "./scope.js";

import type { Range } from "./ast.js";
import type { PyNode } from "./parser.js";
import type { ModuleBinding, Scope } from "./scope.js";

export type DecoratorArg =
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
  relativeLevel: number;
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
   * The call the rules say built the object this decorator hangs on, when
   * the lexical scope could not say. A router prefix is looked up by this
   * call rather than by a variable name, because there may not be one.
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

const UNRESOLVED: Pick<
  DecoratorClassification,
  "importedName" | "module" | "objectName" | "relativeLevel"
> = {
  importedName: null,
  module: null,
  objectName: null,
  relativeLevel: 0,
};

/**
 * Where an identifier's value came from, either an import or one hop
 * back to a call on something imported (`app = FastAPI()`). One hop,
 * not a general points-to analysis.
 */
function resolveObjectModule(
  name: string,
  scope: Scope,
): { module: string; relativeLevel: number } | null {
  const binding = resolveName(scope, name);
  if (binding?.kind === "import") {
    return { module: binding.module, relativeLevel: binding.relativeLevel };
  }
  if (binding?.kind === "assignment" && binding.value?.type === "call") {
    const callee = field(binding.value, "function");
    return callee === null ? null : calleeModule(callee, scope);
  }
  return null;
}

/**
 * The module a call's constructor comes from, whichever way the call
 * reaches it. Both spellings put the same object in the variable:
 *
 *   from fastapi import APIRouter   ->   APIRouter()
 *   import fastapi                  ->   fastapi.APIRouter()
 *
 * so a route decorated with what either one returns belongs to the same
 * pack.
 */
function calleeModule(
  callee: PyNode,
  scope: Scope,
): { module: string; relativeLevel: number } | null {
  if (callee.type === "identifier") {
    const binding = resolveName(scope, callee.text);
    return binding?.kind === "importFrom"
      ? { module: binding.module, relativeLevel: binding.relativeLevel }
      : null;
  }
  if (callee.type !== "attribute") {
    return null;
  }
  const object = field(callee, "object");
  if (object?.type !== "identifier") {
    return null;
  }
  const binding = resolveName(scope, object.text);
  return binding?.kind === "import"
    ? { module: binding.module, relativeLevel: binding.relativeLevel }
    : null;
}

/** An attribute chain deeper than one property access (`a.b.route`) is left unresolved, and its decorator is not discovered. */
function resolveCallee(
  expr: PyNode,
  scope: Scope,
): Pick<
  DecoratorClassification,
  "importedName" | "module" | "objectName" | "relativeLevel"
> {
  if (expr.type === "identifier") {
    const binding = resolveName(scope, expr.text);
    if (binding?.kind === "importFrom") {
      return {
        importedName: binding.importedName,
        module: binding.module,
        objectName: null,
        relativeLevel: binding.relativeLevel,
      };
    }
    return UNRESOLVED;
  }
  if (expr.type === "attribute") {
    const object = field(expr, "object");
    const attribute = field(expr, "attribute");
    if (object === null || attribute === null || object.type !== "identifier") {
      return UNRESOLVED;
    }
    const origin = resolveObjectModule(object.text, scope);
    if (origin === null) {
      return UNRESOLVED;
    }
    return {
      importedName: attribute.text,
      module: origin.module,
      objectName: object.text,
      relativeLevel: origin.relativeLevel,
    };
  }
  return UNRESOLVED;
}

export function classifyDecorator(
  decoratorNode: PyNode,
  scope: Scope,
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
      callee !== null ? resolveCallee(callee, scope) : UNRESOLVED;
    const { args, keywordArgs } =
      argumentList?.type === "argument_list"
        ? readCallArguments(argumentList)
        : { args: [], keywordArgs: {} };
    return { ...resolved, args, keywordArgs, range };
  }

  return { ...resolveCallee(expr, scope), args: [], keywordArgs: {}, range };
}

/** The def a name refers to, in whichever module declares it. */
export type ModuleDefLookup = (
  spec: { module: string; relativeLevel: number },
  name: string,
) => { node: PyNode; module: ModuleBinding } | null;

/**
 * Read a decorator through a one-hop project wrapper:
 *
 *     def api_route(path):
 *         return orders_namespace.route(path)
 *
 * The wrapper's body has to be a single return of an attribute call whose
 * positional arguments are exactly the wrapper's parameters in order.
 * Anything else, a second statement or a rearranged argument, gives null and
 * the decorator stays what it was.
 */
export function unwrapDecorator(
  decoratorNode: PyNode,
  scope: Scope,
  ownModule: ModuleBinding,
  moduleDef: ModuleDefLookup,
): DecoratorClassification | null {
  const expr = decoratorNode.namedChild(0);
  if (expr === null || expr.type !== "call") {
    return null;
  }
  const callee = field(expr, "function");
  if (callee === null || callee.type !== "identifier") {
    return null;
  }

  const wrapper = wrapperBehind(callee.text, scope, ownModule, moduleDef);
  if (wrapper === null) {
    return null;
  }

  const inner = singleReturnedCall(wrapper.node);
  if (inner === null) {
    return null;
  }
  const innerCallee = field(inner, "function");
  if (innerCallee === null || innerCallee.type !== "attribute") {
    return null;
  }
  if (!passesParametersThrough(wrapper.node, inner)) {
    return null;
  }

  const resolved = resolveCallee(innerCallee, wrapper.module.moduleScope);
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
    objectModule: wrapper.module,
  };
}

function wrapperBehind(
  name: string,
  scope: Scope,
  ownModule: ModuleBinding,
  moduleDef: ModuleDefLookup,
): { node: PyNode; module: ModuleBinding } | null {
  const binding = resolveName(scope, name);
  if (binding?.kind === "functionDef") {
    return { node: binding.node, module: ownModule };
  }
  if (binding?.kind === "importFrom") {
    return moduleDef(
      { module: binding.module, relativeLevel: binding.relativeLevel },
      binding.importedName,
    );
  }
  return null;
}

/** The call a body consists of returning, when a return is all the body does. */
function singleReturnedCall(def: PyNode): PyNode | null {
  const body = field(def, "body");
  if (body === null) {
    return null;
  }
  const statements = body.namedChildren.filter(
    (child): child is PyNode => child !== null && child.type !== "comment",
  );
  if (statements.length !== 1 || statements[0]?.type !== "return_statement") {
    return null;
  }
  const returned = statements[0].namedChildren[0];
  return returned !== null && returned?.type === "call" ? returned : null;
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
