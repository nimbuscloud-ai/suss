/**
 * What this adapter can tell a declared pack about a call.
 *
 * Every question here was already worked out somewhere in this adapter,
 * once per pack that needed it. Collecting them behind the one
 * interface `@suss/extractor` declares is what lets a pack stop being a
 * walk over ts-morph and start being data.
 *
 * Two of the receiver origins are implemented. The migration plan for
 * #542 lists four more, and each one adds an entry to `ORIGIN` beside
 * the union member it matches.
 */

import { Node } from "ts-morph";

import { rootIdentifier } from "../configuredCall.js";
import { parameterReads } from "../parameterReads.js";
import { peelValue } from "../walk/unwrap.js";
import {
  effectArgOf,
  isImportedFrom,
  methodDeclaredIn,
} from "./invocationEffects.js";
import { readName } from "./readName.js";

import type {
  AstCapableOps,
  ReceiverOrigin,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "@suss/extractor";
import type {
  CallExpression,
  NewExpression,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  TaggedTemplateExpression,
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
    madeFromNamed(origin, madeExpression(receiver)) &&
    origin.importedFrom.some((module) =>
      isImportedFrom(madeBy(receiver), module),
    ),
};

/**
 * Whether the export a value was made from is one the pack asked for.
 * A pack that says nothing takes whatever the module exports. Every AWS
 * SDK command comes from the one module and goes through the one
 * `send`, so without this a batch send and a single send are the same
 * call.
 *
 * The export's own name is the rightmost part of the constructor
 * expression. Through a namespace import the source writes
 * `new eb.PutEventsCommand(...)`, and the root identifier is the
 * namespace, which no pack ever asked for by name.
 */
function madeFromNamed(origin: ReceiverOrigin, made: Node): boolean {
  if (origin.origin !== "constructed" || origin.named === undefined) {
    return true;
  }
  return origin.named.includes(constructorName(made));
}

/** The rightmost name of what a value was constructed with. */
function constructorName(made: Node): string {
  const expression =
    Node.isNewExpression(made) || Node.isCallExpression(made)
      ? made.getExpression()
      : made;
  return Node.isPropertyAccessExpression(expression)
    ? expression.getName()
    : expression.getText();
}

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
    madeFromNamed(origin, receiver.expression) &&
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
  const made = madeExpression(receiver);
  const expression =
    Node.isNewExpression(made) || Node.isCallExpression(made)
      ? made.getExpression()
      : made;
  return rootIdentifier(expression) ?? expression;
}

/**
 * The construction itself, before any root is taken. The import check
 * wants the root identifier and the export-name check wants the
 * rightmost part, so both read off this.
 */
function madeExpression(receiver: Receiver): Node {
  if (receiver.callee === null) {
    return receiver.expression;
  }
  const written = receiver.resolve(receiver.callee.getExpression());
  if (
    written === null ||
    (!Node.isNewExpression(written) && !Node.isCallExpression(written))
  ) {
    return receiver.callee;
  }
  return written;
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
    namedCallee: () => Node.isIdentifier(expression),
    parameterReadsAt: (index) => selectorReadsOf(argumentsOf()[index]),
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
    name: (unsettled) => readName(written(), { resolve, unsettled }),
    flag: () => literalFlag(written()),
    entries: (unsettled) => entriesOf(written(), unsettled, resolve),
    items: () => itemsOf(written(), resolve),
    asArg: () => effectArgOf(written()),
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
/**
 * What a selector lambda reads off its first parameter, one name per
 * distinct first segment; a parameter used whole reads `*`. Null when
 * the argument is not a function of one plain-named parameter.
 */
function selectorReadsOf(argument: Node | undefined): readonly string[] | null {
  if (
    argument === undefined ||
    (!Node.isArrowFunction(argument) && !Node.isFunctionExpression(argument))
  ) {
    return null;
  }

  const parameter = argument.getParameters()[0];
  if (parameter === undefined || !Node.isIdentifier(parameter.getNameNode())) {
    return null;
  }

  const names = new Set<string>();
  for (const read of parameterReads(argument, [parameter.getName()])) {
    names.add(read.path[0] ?? "*");
  }
  return [...names];
}

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
 * One store ask: the `isWrittenAs` rules follow bindings, imports,
 * and wrappers to a fixpoint, so there is no hop loop here. A value
 * the store leaves unresolved is a missing base fact to emit, per the
 * walkers-and-rules design, and a syntactic fallback here would hide
 * exactly those gaps.
 */
function settled(value: Node | undefined, resolve: Resolve): Node | null {
  const step = unwrapped(value ?? null);
  if (step === null || !Node.isIdentifier(step)) {
    return step;
  }
  return unwrapped(resolve(step));
}

/**
 * A value with the wrappers taken off. A document read back off a query
 * is written as `await User.findById(id)`, and what made it is the call
 * inside the await rather than the await itself.
 */
function unwrapped(value: Node | null): Node | null {
  return value === null ? null : peelValue(value);
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
