// decorators.ts: decorator lowering and module classification.
//
// A decorator expression is really two applications: the factory call
// that builds the decorator (`app.route("/x")`) and the decoration
// itself (applying that result to the function). Discovery only needs
// the first: what name did the call's callee resolve to, and which
// module did that name come from. `classifyDecorator` reads that much
// and stops there, the way the language-adapters proposal describes
// it ("`@app.route("/x")` desugars to two call facts... before any
// resolution rule sees it") without materializing call facts nobody
// downstream reads yet.
//
// This is the same recipe the TypeScript packs use for a decorator
// re-exported through a project's own wrapper: classify the name as
// import-of-module-X, and let the pack list every module X it accepts
// (see PythonPack.importModule in pack.ts).

import { field, rangeOf, stringLiteralValue } from "./ast.js";
import { resolveName } from "./scope.js";

import type { Range } from "./ast.js";
import type { PyNode } from "./parser.js";
import type { Scope } from "./scope.js";

export type DecoratorArg =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  /** A bare name, e.g. `response_model=TodoResponse`: the class the name resolves to (if any) is for the caller to look up via the scope it already has. */
  | { kind: "identifier"; name: string }
  | { kind: "list"; items: DecoratorArg[] }
  | { kind: "other" };

export interface DecoratorClassification {
  /**
   * The decorator's own name as its source module exports it (not the
   * local alias or attribute path it was written under). Null when
   * the underlying name couldn't be traced to an import at all (a
   * project-local function, an unresolved attribute chain, …).
   */
  importedName: string | null;
  /** Dotted module the name was imported from; null alongside a null `importedName`. */
  module: string | null;
  /**
   * The local variable a resolved attribute decorator hangs on (`app`
   * in `@app.get(...)`), so discovery can ask what that variable was
   * constructed as (a router with a prefix, say). Null when the
   * decorator was a plain name rather than an attribute.
   */
  objectName: string | null;
  relativeLevel: number;
  /** Positional call arguments, in order; empty for a bare decorator (`@staticmethod`). */
  args: DecoratorArg[];
  keywordArgs: Record<string, DecoratorArg>;
  /**
   * Where the decorator is written. A reading of one of its arguments
   * carries this as the provenance of what it found, which is the
   * syntax a reader would go look at. Per-argument ranges wait until
   * something in the IR has a place to put them.
   */
  range: Range;
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
  if (node.type === "identifier") {
    return { kind: "identifier", name: node.text };
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

/**
 * Positional and keyword arguments of any call's argument list, read
 * the same way for a decorator call and for a router mount call
 * (routers.ts): literals become values, bare names stay names, and
 * anything else is `other`.
 */
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
 * Where an identifier's value was constructed from, when it names a
 * module directly (an import) or was built one hop away by a call to
 * something imported (`app = FastAPI()`). The second case is the
 * ordinary FastAPI / flask shape: the routing object is a local
 * variable, not an import, and its own decorator methods (`.get`,
 * `.post`, …) only classify against a configured module by tracing
 * that one assignment back to its constructor. Same bound as the
 * axios pack's `factoryMethods` option on the TypeScript side: one
 * hop, not a general points-to analysis.
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
    if (callee?.type === "identifier") {
      const calleeBinding = resolveName(scope, callee.text);
      if (calleeBinding?.kind === "importFrom") {
        return {
          module: calleeBinding.module,
          relativeLevel: calleeBinding.relativeLevel,
        };
      }
    }
  }
  return null;
}

/**
 * Resolve the name a decorator's callee (or, for a bare decorator, the
 * decorator itself) traces to. An attribute chain deeper than one
 * property access (`a.b.route`) is left unresolved: v0's fixtures
 * write a wrapper's re-export as a direct import, matching the
 * measured corpus's dominant shape, and an unresolved decorator
 * degrades to "not discovered" rather than guessing through a chain
 * nobody configured.
 */
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
    // `import myapp.wrappers.restx as api` then `@api.route(...)`, or
    // `app = FastAPI()` then `@app.get(...)`: either way, the
    // attribute name is what the decorator names on the resolved
    // module's surface.
    return {
      importedName: attribute.text,
      module: origin.module,
      objectName: object.text,
      relativeLevel: origin.relativeLevel,
    };
  }
  return UNRESOLVED;
}

/** Classify one `decorator` node: what it names, where that name came from, and its call arguments. */
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
