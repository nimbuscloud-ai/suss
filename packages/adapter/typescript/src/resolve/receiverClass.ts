/**
 * Which class a method call runs on, when that is a subclass of the class
 * the method is written in. `CreateInvoice.call(args)` runs the `call`
 * that `BaseService` declares with `this` set to `CreateInvoice`, so
 * `new this(args).run()` inside it runs `CreateInvoice.run`. The type
 * checker types that `this` as `BaseService`, so the walk reads the call
 * on the subclass instead.
 *
 * A receiver comes from `this` when it is `this`, `new this(...)`, or a
 * `const` the scanned method gives one of those. Anything else keeps the
 * checker's answer.
 */

import { Node } from "ts-morph";

import { peelSyntax } from "../walk/unwrap.js";
import { functionAmong } from "./functionBehind.js";
import { declarationsBehind } from "./unfollowedCall.js";

import type { SubclassPlace } from "@suss/resolution";
import type { ClassDeclaration, Type } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ReachableCandidate } from "./functionBehind.js";

/** A class a method runs on, with its declaration for looking members up. */
export interface TsSubclass {
  readonly node: ClassDeclaration;
  readonly name: string;
  readonly file: string;
}

/** Whether a value is the class itself or one of it. */
type ReceiverForm = "class" | "instance";

/**
 * The method a call runs when its receiver decides the class. Null when
 * the receiver decides nothing the checker's answer did not.
 */
export function candidateOnReceiver(
  callee: Node,
  checked: ReachableCandidate | null,
  scanning: FunctionRoot | undefined,
  runsOn: TsSubclass | undefined,
): ReachableCandidate | null {
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const receiver = callee.getExpression();
  const name = callee.getName();
  const own = scanning === undefined ? null : ownForm(receiver, scanning, 0);
  const selfClass =
    runsOn ?? (scanning === undefined ? null : classOf(scanning));
  if (own !== null && selfClass !== null) {
    return memberOn(selfClass, name, own);
  }
  if (checked === null || !Node.isClassDeclaration(checked.func.getParent())) {
    return null;
  }
  const sentTo = classSentTo(receiver);
  return sentTo === null ? null : runningOn(checked, sentTo);
}

/** A method as it runs on a class, marked when the class inherits it. */
export function runningOn(
  candidate: ReachableCandidate,
  cls: TsSubclass,
): ReachableCandidate {
  const owner = candidate.func.getParent();
  if (!Node.isClassDeclaration(owner) || owner === cls.node) {
    return candidate;
  }
  return inherits(cls.node, owner)
    ? { ...candidate, receiverClass: cls }
    : candidate;
}

/** A subclass as a summary records it. */
export function subclassPlace(cls: TsSubclass): SubclassPlace {
  return { name: cls.name, file: cls.file };
}

/** Whether `this` here is the scanned method's own, reached through arrows but not through a nested `function`. */
function ownThis(node: Node, scanning: FunctionRoot): boolean {
  const owner = node.getFirstAncestor(
    (at) =>
      Node.isFunctionDeclaration(at) ||
      Node.isFunctionExpression(at) ||
      Node.isMethodDeclaration(at) ||
      Node.isConstructorDeclaration(at),
  );
  return owner === scanning;
}

function ownForm(
  value: Node,
  scanning: FunctionRoot,
  depth: number,
): ReceiverForm | null {
  const written = peelSyntax(value);
  if (Node.isThisExpression(written)) {
    if (!ownThis(written, scanning) || !Node.isMethodDeclaration(scanning)) {
      return null;
    }
    return scanning.isStatic() ? "class" : "instance";
  }
  if (Node.isNewExpression(written)) {
    return ownForm(written.getExpression(), scanning, depth) === "class"
      ? "instance"
      : null;
  }
  if (!Node.isIdentifier(written) || depth > 0) {
    return null;
  }
  const declaration = written.getSymbol()?.getValueDeclaration();
  const initializer = Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : undefined;
  const isConst =
    Node.isVariableDeclaration(declaration) &&
    declaration.getVariableStatement()?.getDeclarationKind() === "const";
  return initializer === undefined || !isConst
    ? null
    : ownForm(initializer, scanning, depth + 1);
}

/** The class a method is written in, or null for a function outside any class. */
function classOf(scanning: FunctionRoot): TsSubclass | null {
  const owner = scanning.getParent();
  return Node.isClassDeclaration(owner) ? subclassOf(owner) : null;
}

function subclassOf(node: ClassDeclaration): TsSubclass | null {
  const name = node.getName();
  return name === undefined
    ? null
    : { node, name, file: node.getSourceFile().getFilePath() };
}

/**
 * The class a call is sent to: the class itself when the receiver refers
 * to one, or the class of the instance the checker types it as.
 */
function classSentTo(receiver: Node): TsSubclass | null {
  const written = peelSyntax(receiver);
  const named = classDeclarationOf(declarationsBehind(written.getSymbol()));
  if (named !== null) {
    return subclassOf(named);
  }
  const typed = classDeclarationOf(
    written.getType().getSymbol()?.getDeclarations() ?? [],
  );
  return typed === null ? null : subclassOf(typed);
}

function classDeclarationOf(
  declarations: readonly Node[],
): ClassDeclaration | null {
  const classes = declarations.filter((one) => Node.isClassDeclaration(one));
  const [only] = classes;
  return classes.length === 1 && only !== undefined
    ? (only as ClassDeclaration)
    : null;
}

/** The method a class has under a name, its bases' included, as it runs on that class. */
function memberOn(
  cls: TsSubclass,
  name: string,
  form: ReceiverForm,
): ReachableCandidate | null {
  const member = typeOf(cls, form)?.getProperty(name);
  const found =
    member === undefined ? null : functionAmong(member.getDeclarations(), name);
  return found === null ? null : runningOn(found, cls);
}

/** An instance's type, or for the class itself the type of its constructor, which has the statics. */
function typeOf(cls: TsSubclass, form: ReceiverForm): Type | undefined {
  if (form === "instance") {
    return cls.node.getType();
  }
  const symbol = cls.node.getSymbol();
  return symbol === undefined
    ? undefined
    : cls.node
        .getProject()
        .getTypeChecker()
        .getTypeOfSymbolAtLocation(symbol, cls.node);
}

function inherits(cls: ClassDeclaration, base: ClassDeclaration): boolean {
  for (let at = cls.getBaseClass(); at !== undefined; at = at.getBaseClass()) {
    if (at === base) {
      return true;
    }
  }
  return false;
}
