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

import type { ReceiverOrigin, UnsettledName } from "@suss/recognize";
import type { AstCapableOps } from "@suss/recognize/ast";
import type { CallExpression, PropertyAccessExpression } from "ts-morph";

/** One-hop lookup from a written name to the value it was bound to. */
type Resolve = (value: Node) => Node | null;

/** What every origin check is handed. */
interface Receiver {
  /** The property access the call goes through. */
  callee: PropertyAccessExpression;
  resolve: Resolve;
}

/** One check per way a pack can pin down a receiver. */
const ORIGIN: Record<
  ReceiverOrigin["origin"],
  (origin: ReceiverOrigin, receiver: Receiver) => boolean
> = {
  declaredBy: (origin, receiver) =>
    origin.importedFrom.some((module) =>
      methodDeclaredIn(receiver.callee, module, receiver.resolve),
    ),
  constructed: (origin, receiver) =>
    origin.importedFrom.some((module) =>
      isImportedFrom(madeBy(receiver), module),
    ),
};

/**
 * What made the receiver, as the name the source called it. A client
 * the program keeps in a const or hands round as a parameter comes back
 * through the fact layer as the `new` or the factory call that made it.
 */
function madeBy(receiver: Receiver): Node {
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
  call: CallExpression,
  resolveWrittenValue?: Resolve,
): AstCapableOps {
  const resolve = resolveWrittenValue ?? (() => null);
  const expression = call.getExpression();
  const callee = Node.isPropertyAccessExpression(expression)
    ? expression
    : null;
  // Reading the argument list off ts-morph is the one repeated cost
  // here, and a chain reads several positions of the same call.
  let args: Node[] | null = null;
  const argumentsOf = (): Node[] => {
    args ??= call.getArguments();
    return args;
  };

  return {
    method: () => (callee === null ? null : callee.getName()),
    receiverIsFrom: (origin) =>
      callee !== null && ORIGIN[origin.origin](origin, { callee, resolve }),
    argumentCount: () => argumentsOf().length,
    nameAt: (index, unsettled) =>
      nameAt(argumentsOf()[index], unsettled, resolve),
    calleeText: () => expression.getText(),
    ast: () => call,
  };
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
