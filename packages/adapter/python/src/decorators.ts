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
import type { Scope } from "./scope.js";

export type DecoratorArg =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "none" }
  /** A bare name. The caller resolves it, using the scope it already has. */
  | { kind: "identifier"; name: string }
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
