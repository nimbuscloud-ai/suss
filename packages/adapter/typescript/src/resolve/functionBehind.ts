/**
 * The one resolver from a reference to the function behind it.
 *
 * Four copies of "follow an identifier to its function declaration"
 * grew across the closure, the render-tree builder, the react pack,
 * and the parameter-read walk, three of them lossy (#674). The walk
 * lives here: alias-following through imports, shorthand properties
 * resolved to the binding they read, overload signatures routed to
 * the declaration with the body, and external code refused. Callers
 * that need only the file and name take `functionTargetOf`; the
 * closure takes `resolveDecl` for the function root itself.
 */

import { Node, SyntaxKind } from "ts-morph";

import { normalizeCalleeText } from "@suss/behavioral-ir";

import { toFunctionRoot } from "../discovery/index.js";
import {
  declarationsBehind,
  hasBody,
  isInExternalCode,
} from "./unfollowedCall.js";

import type {
  CallExpression,
  ClassDeclaration,
  Identifier,
  NewExpression,
  Symbol as TsSymbol,
} from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { TsSubclass } from "./receiverClass.js";

export interface ReachableCandidate {
  func: FunctionRoot;
  name: string;
  /** The subclass the method runs on, when the call reached it through a class that inherits it. */
  receiverClass?: TsSubclass;
}

/** The first of these declarations the walk can follow into. */
export function functionAmong(
  declarations: readonly Node[],
  calleeName: string,
): ReachableCandidate | null {
  for (const decl of declarations) {
    const resolved = resolveDecl(decl, calleeName);
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

/**
 * The project function a call comes down to, or null when a dependency
 * declares the callee and this run never read it. A `new` comes down to
 * the constructor it runs.
 */
export function functionCalledAt(
  call: CallExpression | NewExpression,
): ReachableCandidate | null {
  if (Node.isNewExpression(call)) {
    return constructorCalledAt(call);
  }
  const callee = calleeRunBy(call);
  if (Node.isSuperExpression(callee)) {
    return baseConstructorCalledAt(callee);
  }
  return functionAmong(
    declarationsBehind(callee.getSymbol()),
    normalizeCalleeText(callee.getText()),
  );
}

/** The methods the language gives every function. */
export type FunctionMethod = "call" | "apply" | "bind";

interface FunctionMethodUse {
  /** Whether calling the method runs the function, which `bind` does not. */
  runs: boolean;
  /** Which argument the function is handed first, or null when they go in an array. */
  argumentsFrom: number | null;
}

/**
 * `fn.call(self, a)` and `fn.apply(self, [a])` run `fn`, and
 * `fn.bind(self)` hands back a function that runs it.
 */
const FUNCTION_METHODS: Record<FunctionMethod, FunctionMethodUse> = {
  call: { runs: true, argumentsFrom: 1 },
  apply: { runs: true, argumentsFrom: null },
  bind: { runs: false, argumentsFrom: 1 },
};

const FUNCTION_METHOD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(FUNCTION_METHODS),
);

/** The interfaces the TypeScript library declares those methods on. */
const FUNCTION_INTERFACES: ReadonlySet<string> = new Set([
  "Function",
  "CallableFunction",
  "NewableFunction",
]);

/** A call to one of the language's own function methods, and the function it is called on. */
export interface FunctionMethodCall extends FunctionMethodUse {
  fn: Node;
  method: FunctionMethod;
}

/**
 * The function method a call makes, or null for any other call. A class
 * the project writes can declare a `call` of its own, as a service
 * object does, and a call to that runs the class's method. So the method
 * has to be the one the TypeScript library declares on a function, and
 * a call whose method the checker cannot see is left as it is.
 */
export function functionMethodCall(
  call: CallExpression,
): FunctionMethodCall | null {
  const callee = call.getExpression();
  if (
    !Node.isPropertyAccessExpression(callee) ||
    !FUNCTION_METHOD_NAMES.has(callee.getName())
  ) {
    return null;
  }
  const declarations =
    callee.getNameNode().getSymbol()?.getDeclarations() ?? [];
  if (declarations.length === 0 || !declarations.every(declaredOnFunction)) {
    return null;
  }
  const method = callee.getName() as FunctionMethod;
  return { fn: callee.getExpression(), method, ...FUNCTION_METHODS[method] };
}

function declaredOnFunction(declaration: Node): boolean {
  const owner = declaration.getParent();
  return (
    declaration.getSourceFile().isDeclarationFile() &&
    owner !== undefined &&
    Node.isInterfaceDeclaration(owner) &&
    FUNCTION_INTERFACES.has(owner.getName())
  );
}

/** The expression whose function a call runs: the callee, or the function `call` and `apply` are called on. */
export function calleeRunBy(call: CallExpression): Node {
  const method = functionMethodCall(call);
  return method?.runs === true ? method.fn : call.getExpression();
}

/**
 * Which of a call's arguments the function it runs takes first: 0, 1
 * past the receiver `fn.call(self, a)` is given, or null when
 * `fn.apply(self, args)` hands them over in an array.
 */
export function firstArgumentHanded(
  call: CallExpression | NewExpression,
): number | null {
  const method = Node.isCallExpression(call) ? functionMethodCall(call) : null;
  return method === null || !method.runs ? 0 : method.argumentsFrom;
}

/** How a `new` is spelled as a callee: `new Client` for `new Client(args)`. */
export function constructionCallee(construction: NewExpression): string {
  return `new ${normalizeCalleeText(construction.getExpression().getText())}`;
}

/** The one class among these declarations, or null when there is none or several. */
export function classAmong(
  declarations: readonly Node[],
): ClassDeclaration | null {
  const classes = declarations.filter((one) => Node.isClassDeclaration(one));
  return classes.length === 1 ? (classes[0] as ClassDeclaration) : null;
}

/**
 * The constructor `new Client()` runs: the class's own, or the nearest
 * base class's when the class writes none, since that one runs instead.
 * Null when the class is a dependency's, or when no class in its chain
 * writes a constructor with a body.
 */
export function constructorCalledAt(
  construction: NewExpression,
): ReachableCandidate | null {
  const made = construction.getExpression();
  // `new this()` makes whichever subclass the method runs on, which the
  // receiver walk reads instead.
  if (Node.isThisExpression(made)) {
    return null;
  }
  const cls = classAmong(declarationsBehind(made.getSymbol()));
  return cls === null ? null : constructorOf(cls);
}

/** The constructor `super(...)` runs: the nearest one up the enclosing class's chain. */
export function baseConstructorCalledAt(
  superKeyword: Node,
): ReachableCandidate | null {
  const owner = superKeyword.getFirstAncestorByKind(
    SyntaxKind.ClassDeclaration,
  );
  const base = owner?.getBaseClass();
  return base === undefined ? null : constructorOf(base);
}

/**
 * The parameter defaults a call runs: those of the parameters it passes
 * nothing for. A default is evaluated at the call that leaves its
 * argument out, so what it reads is that call's, and a caller that
 * passes the argument never runs it.
 */
export function defaultsRunBy(call: CallExpression | NewExpression): Node[] {
  const callee = functionCalledAt(call);
  const from = firstArgumentHanded(call);
  if (callee === null || from === null) {
    return [];
  }
  const passed = Math.max(0, call.getArguments().length - from);
  return callee.func.getParameters().flatMap((parameter, at) => {
    const initializer = parameter.getInitializer();
    return at < passed ||
      initializer === undefined ||
      parameter.isRestParameter()
      ? []
      : [initializer];
  });
}

/** The deepest a base class chain is followed, past what any project writes. */
const MAX_BASE_CLASSES = 32;

function constructorOf(cls: ClassDeclaration): ReachableCandidate | null {
  let at: ClassDeclaration | undefined = cls;
  for (let depth = 0; at !== undefined && depth < MAX_BASE_CLASSES; depth++) {
    if (isInExternalCode(at.getSourceFile())) {
      return null;
    }
    const written = at.getConstructors().find(hasBody);
    if (written !== undefined) {
      return { func: written, name: declName(written) ?? "constructor" };
    }
    at = at.getBaseClass();
  }
  return null;
}

/**
 * The symbol a reference resolves to. A shorthand property
 * (`{ roomId }`) gives its identifier the property's symbol, and the
 * local binding it reads is behind `getValueSymbol`.
 */
export function symbolBehind(node: Identifier): TsSymbol | undefined {
  const parent = node.getParent();
  if (parent !== undefined && Node.isShorthandPropertyAssignment(parent)) {
    return parent.getValueSymbol();
  }
  return node.getSymbol();
}

/**
 * The function an identifier refers to, as its declaration's file and
 * name, for joins that never walk the body. Null when the reference
 * does not land on a project function.
 */
export function functionTargetOf(
  node: Identifier,
): { func: FunctionRoot; file: string; name: string } | null {
  const resolved = functionAmong(
    declarationsBehind(symbolBehind(node)),
    node.getText(),
  );
  if (resolved === null) {
    return null;
  }
  return {
    func: resolved.func,
    file: resolved.func.getSourceFile().getFilePath(),
    name: resolved.name,
  };
}

/**
 * Follow a declaration node to an underlying function-shaped declaration
 * we can extract from. Returns null for declarations that don't resolve
 * (namespaces, classes without a called method, external-module imports,
 * parameters, etc.): the closure skips those.
 */
export function resolveDecl(
  decl: Node,
  calleeName: string,
): ReachableCandidate | null {
  if (isInExternalCode(decl.getSourceFile())) {
    return null;
  }
  const fn = toFunctionRoot(decl);
  if (fn !== null) {
    if (!hasBody(fn)) {
      return null;
    }
    return { func: fn, name: declName(decl) ?? calleeName };
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (
      init !== undefined &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return { func: init as FunctionRoot, name: decl.getName() };
    }
    return null;
  }
  return null;
}

/**
 * Best-effort name extraction for a reached declaration: used for
 * `summary.identity.name`. FunctionDeclaration / MethodDeclaration have
 * a direct name. Arrow/function expressions bound to a variable borrow
 * the variable name.
 */
function declName(decl: Node): string | null {
  if (Node.isConstructorDeclaration(decl)) {
    const owner = decl.getParent();
    return Node.isClassDeclaration(owner)
      ? `${owner.getName() ?? "<anon>"}.constructor`
      : null;
  }
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    const n = decl.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  if (Node.isFunctionExpression(decl)) {
    const n = decl.getName();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  const parent = decl.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return null;
}
