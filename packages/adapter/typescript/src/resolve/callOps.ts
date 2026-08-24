/**
 * What this adapter can tell a declared pack about a call.
 *
 * Every question here was already worked out somewhere in this adapter,
 * once per pack that needed it. Collecting them behind the one
 * interface `@suss/recognize` declares is what lets a pack stop being a
 * walk over ts-morph and start being data.
 *
 * Two of the receiver origins are implemented. The migration plan for
 * #542 lists four more, and each one adds an entry to `ORIGIN` beside
 * the union member it matches.
 */

import { Node } from "ts-morph";

import { rootIdentifier } from "../configuredCall.js";
import { isImportedFrom, methodDeclaredIn } from "./invocationEffects.js";
import { readName } from "./readName.js";

import type {
  ReceiverOrigin,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "@suss/recognize";
import type { AstCapableOps } from "@suss/recognize/ast";
import type {
  CallExpression,
  NewExpression,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  TaggedTemplateExpression,
  VariableDeclaration,
} from "ts-morph";

/**
 * A call, a construction, or a tagged template, which all ask the same
 * questions. A tagged template is a call the source wrote without
 * parentheses: the tag is the callee and the template is the one
 * argument, which is how a pack reaches a statement written that way
 * without a second grammar for it.
 */
type Called = CallExpression | NewExpression | TaggedTemplateExpression;

/** One-hop lookup from a written name to the value it was bound to. */
type Resolve = (value: Node) => Node | null;

/**
 * How many variables a step follows before it gives up. A value put
 * in a variable that came from another variable is ordinary; a longer
 * run of them is a program this cannot read anyway.
 */
const MAX_WRITTEN_HOPS = 4;

/** What every origin check is handed. */
interface Receiver {
  /** The property access the call goes through, when it goes through one. */
  callee: PropertyAccessExpression | null;
  /** The whole callee, which is what made the value where there is no receiver. */
  expression: Node;
  resolve: Resolve;
}

/** One check per way a pack can pin down a receiver. */
const ORIGIN: Record<
  ReceiverOrigin["origin"],
  (origin: ReceiverOrigin, receiver: Receiver) => boolean
> = {
  declaredBy: (origin, receiver) =>
    receiver.callee !== null &&
    origin.importedFrom.some((module) =>
      methodDeclaredIn(receiver.callee as Node, module, receiver.resolve),
    ),
  constructed: (origin, receiver) =>
    origin.importedFrom.some((module) =>
      isImportedFrom(madeBy(receiver), module),
    ),
};

/**
 * One check per way a pack can pin down the call itself.
 *
 * `declaredBy` is the same check either way round, since a method
 * declaration is a fact about the call. `constructed` differs: asked of
 * the receiver it follows what made the receiver through the fact
 * layer, and asked of the call it reads the callee the source wrote,
 * which is what makes it cheap enough to guard a step with.
 */
const CALL_ORIGIN: Record<
  ReceiverOrigin["origin"],
  (origin: ReceiverOrigin, receiver: Receiver) => boolean
> = {
  declaredBy: ORIGIN.declaredBy,
  constructed: (origin, receiver) =>
    origin.importedFrom.some((module) =>
      isImportedFrom(
        rootIdentifier(receiver.expression) ?? receiver.expression,
        module,
      ),
    ),
};

/**
 * What made the receiver, as the name the source called it. A client
 * the program keeps in a const or hands round as a parameter comes back
 * through the fact layer as the `new` or the factory call that made it.
 * A call with no receiver made its own value, so its callee says.
 */
function madeBy(receiver: Receiver): Node {
  if (receiver.callee === null) {
    return rootIdentifier(receiver.expression) ?? receiver.expression;
  }
  const written = receiver.resolve(receiver.callee.getExpression());
  if (
    written === null ||
    (!Node.isNewExpression(written) && !Node.isCallExpression(written))
  ) {
    return receiver.callee;
  }
  return rootIdentifier(written.getExpression()) ?? receiver.callee;
}

/** What a declared pack can ask about one TypeScript call. */
export function callOpsFor(
  call: Called,
  resolveWrittenValue?: Resolve,
): AstCapableOps {
  const resolve = resolveWrittenValue ?? (() => null);
  const expression = calleeOf(call);
  const callee = Node.isPropertyAccessExpression(expression)
    ? expression
    : null;
  // Reading the argument list off ts-morph is the one repeated cost
  // here, and a chain reads several positions of the same call.
  let args: Node[] | null = null;
  const argumentsOf = (): Node[] => {
    args ??= argumentsIn(call);
    return args;
  };

  return {
    method: () => (callee === null ? null : callee.getName()),
    receiverIsFrom: (origin) =>
      ORIGIN[origin.origin](origin, { callee, expression, resolve }),
    isFrom: (origin) =>
      CALL_ORIGIN[origin.origin](origin, { callee, expression, resolve }),
    argumentCount: () => argumentsOf().length,
    nameAt: (index, unsettled) =>
      nameAt(argumentsOf()[index], unsettled, resolve),
    calleeText: () => expression.getText(),
    receiver: () =>
      callee === null ? null : opsOverCall(callee.getExpression(), resolve),
    argument: (index) => opsOverCall(argumentsOf()[index], resolve),
    callee: () => opsOverCall(expression, resolve),
    propertyAt: (index, property, unsettled) =>
      propertyAt(argumentsOf()[index], property, unsettled, resolve),
    valueAt: (index) => {
      const argument = argumentsOf()[index];
      return argument === undefined ? null : valueOpsFor(argument, resolve);
    },
    ast: () => call,
  };
}

/**
 * What a declared pack can ask about one value the source states.
 *
 * Nothing is settled until a question is asked. A pack walking a
 * request map reads the keys of a few objects and never looks at the
 * values under them, and following a name it never reads costs a walk
 * out over the file's imports.
 */
function valueOpsFor(value: Node, resolve: Resolve): ValueOps {
  let settledValue: Node | undefined;
  const written = (): Node => {
    settledValue ??= settled(value, resolve) ?? value;
    return settledValue;
  };

  return {
    text: () => literalText(written()),
    flag: () => literalFlag(written()),
    entries: (unsettled) => entriesOf(written(), unsettled, resolve),
    items: () => itemsOf(written(), resolve),
    property: (name) => {
      const object = written();
      const inside = Node.isObjectLiteralExpression(object)
        ? initializerOf(object, name)
        : null;
      return inside === null ? null : valueOpsFor(inside, resolve);
    },
    parts: () => literalParts(written()),
    holes: () => templateHoles(written(), resolve),
  };
}

/**
 * The text a value states, in the pieces the source wrote it in. A
 * template with holes in it comes back as the text either side of each
 * hole, so a reader can put its own placeholder where the hole was
 * rather than losing the statement to one interpolated value.
 */
function literalParts(value: Node): string[] | null {
  const written = untagged(value);
  const whole = literalText(written);
  if (whole !== null) {
    return [whole];
  }
  if (!Node.isTemplateExpression(written)) {
    return null;
  }
  return [
    written.getHead().getLiteralText(),
    ...written
      .getTemplateSpans()
      .map((span) => span.getLiteral().getLiteralText()),
  ];
}

/** What the source interpolated between those pieces, hole by hole. */
function templateHoles(
  value: Node,
  resolve: Resolve,
): (AstCapableOps | null)[] {
  const written = untagged(value);
  if (!Node.isTemplateExpression(written)) {
    return [];
  }
  return written
    .getTemplateSpans()
    .map((span) => opsOverCall(span.getExpression(), resolve));
}

/**
 * The template a tag was handed. A statement written as a tagged
 * template states its text through the tag, and the text is what a
 * reader is after rather than the tag.
 */
function untagged(value: Node): Node {
  return Node.isTaggedTemplateExpression(value) ? value.getTemplate() : value;
}

/** What an object states, entry by entry. */
function entriesOf(
  value: Node,
  unsettled: UnsettledName,
  resolve: Resolve,
): ValueEntry[] {
  if (!Node.isObjectLiteralExpression(value)) {
    return [];
  }
  const found: ValueEntry[] = [];
  for (const written of value.getProperties()) {
    if (Node.isShorthandPropertyAssignment(written)) {
      const name = written.getNameNode();
      found.push({ key: name.getText(), value: valueOpsFor(name, resolve) });
      continue;
    }
    if (!Node.isPropertyAssignment(written)) {
      continue;
    }
    const stated = written.getInitializer();
    found.push({
      key: entryKey(written, unsettled, resolve),
      value: valueOpsFor(stated ?? written, resolve),
    });
  }
  return found;
}

/**
 * What one entry is called. A key the source computes,
 * `{ [this.tableName]: ... }`, is read the way the same expression
 * would be read on the other side of the colon.
 */
function entryKey(
  written: PropertyAssignment,
  unsettled: UnsettledName,
  resolve: Resolve,
): string | null {
  const name = written.getNameNode();
  if (Node.isComputedPropertyName(name)) {
    return readName(name.getExpression(), { resolve, unsettled });
  }
  return unquoted(written.getName());
}

/** What a list states, item by item. */
function itemsOf(value: Node, resolve: Resolve): ValueOps[] {
  if (!Node.isArrayLiteralExpression(value)) {
    return [];
  }
  return value.getElements().map((element) => valueOpsFor(element, resolve));
}

/** The text of a string the source writes out, or null for anything else. */
function literalText(value: Node): string | null {
  return Node.isStringLiteral(value) ||
    Node.isNoSubstitutionTemplateLiteral(value)
    ? value.getLiteralValue()
    : null;
}

/**
 * The yes or no the source writes out, or null for anything else. A
 * library that asks which fields a call wants takes a map of these, and
 * accepts a number in place of the boolean, so both are read the same
 * way round.
 */
function literalFlag(value: Node): boolean | null {
  if (Node.isTrueLiteral(value) || Node.isFalseLiteral(value)) {
    return Node.isTrueLiteral(value);
  }
  return Node.isNumericLiteral(value) ? value.getLiteralValue() !== 0 : null;
}

/** A property name without the quotes a source that needs them writes. */
function unquoted(name: string): string {
  return name.replace(/^["']|["']$/g, "");
}

/** The ops for a value, when the value is a call the source wrote. */
function opsOverCall(
  value: Node | undefined,
  resolve: Resolve,
): AstCapableOps | null {
  const written = settled(value, resolve);
  if (written === null || !isCalled(written)) {
    return null;
  }
  return callOpsFor(written, resolve);
}

/** Whether a value is a call, a construction or a tagged template. */
function isCalled(value: Node): value is Called {
  return (
    Node.isCallExpression(value) ||
    Node.isNewExpression(value) ||
    Node.isTaggedTemplateExpression(value)
  );
}

/** What the call goes to: the tag, where the source wrote a template. */
function calleeOf(call: Called): Node {
  return Node.isTaggedTemplateExpression(call)
    ? call.getTag()
    : call.getExpression();
}

/** What the call was handed. A tagged template hands over the template. */
function argumentsIn(call: Called): Node[] {
  return Node.isTaggedTemplateExpression(call)
    ? [call.getTemplate()]
    : call.getArguments();
}

/**
 * A value, or what the source wrote it as when it is a local name. A
 * repository class builds the command a few lines above the call, and
 * that has to be followed.
 *
 * The variable's own initializer comes first, since the source states
 * it outright and reading it costs nothing. The fact layer supplies
 * what is left, which is how a step crosses an import to the file a
 * model or a table was declared in.
 *
 * That fallback was removed while a resolution query could answer
 * differently depending on what had been asked before it (#585). The
 * cause of the case that bit here was a construction resolving on to
 * the class it makes an instance of, fixed in #588, so the fallback is
 * back.
 */
function settled(value: Node | undefined, resolve: Resolve): Node | null {
  let step = unwrapped(value ?? null);
  for (let hops = 0; hops < MAX_WRITTEN_HOPS; hops += 1) {
    if (step === null || !Node.isIdentifier(step)) {
      return step;
    }
    const written = variableFor(step)?.getInitializer() ?? resolve(step);
    if (written === null || written === step) {
      return null;
    }
    step = unwrapped(written);
  }
  return null;
}

/**
 * A value with the wrappers taken off. A document read back off a query
 * is written as `await User.findById(id)`, and what made it is the call
 * inside the await rather than the await itself.
 */
function unwrapped(value: Node | null): Node | null {
  let inside = value;
  while (
    inside !== null &&
    (Node.isAwaitExpression(inside) || Node.isParenthesizedExpression(inside))
  ) {
    inside = inside.getExpression();
  }
  return inside;
}

/** The variable a name was declared as, when the source declares one. */
function variableFor(name: Node): VariableDeclaration | null {
  if (!Node.isIdentifier(name)) {
    return null;
  }
  for (const declaration of name.getSymbol()?.getDeclarations() ?? []) {
    if (Node.isVariableDeclaration(declaration)) {
      return declaration;
    }
  }
  return null;
}

/** The name one argument gives, or null when nothing settles it. */
function nameAt(
  argument: Node | undefined,
  unsettled: UnsettledName,
  resolve: Resolve,
): string | null {
  if (argument === undefined) {
    return null;
  }
  return readName(argument, { resolve, unsettled });
}

/** What a named property of the object an argument states says. */
function propertyAt(
  argument: Node | undefined,
  property: string,
  unsettled: UnsettledName,
  resolve: Resolve,
): string | null {
  const stated = objectAt(argument, resolve);
  const written = stated === null ? null : initializerOf(stated, property);
  return written === null ? null : readName(written, { resolve, unsettled });
}

/**
 * The object an argument states. A command puts its inputs in the
 * object it was constructed with, so a construction is unwrapped to the
 * object inside it.
 */
function objectAt(
  argument: Node | undefined,
  resolve: Resolve,
): ObjectLiteralExpression | null {
  const written = settled(argument, resolve);
  if (written === null) {
    return null;
  }
  if (isCalled(written)) {
    return objectAt(argumentsIn(written)[0], resolve);
  }
  return Node.isObjectLiteralExpression(written) ? written : null;
}

/** What one property of an object literal was written as. */
function initializerOf(
  object: ObjectLiteralExpression,
  property: string,
): Node | null {
  for (const written of object.getProperties()) {
    if (Node.isPropertyAssignment(written) && written.getName() === property) {
      return written.getInitializer() ?? null;
    }
  }
  return null;
}
