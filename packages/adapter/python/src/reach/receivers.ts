/**
 * Which object a method call runs on, for a callee that reads fields off
 * its receiver.
 *
 * A method many objects share can read a field its constructor set, and
 * what it reads depends on which object it runs on. A summary records two
 * things about a call: that it is on the body's own receiver, so it runs
 * on the same object, or the constructions its receiver was made at. A
 * reader copies the callee once for each. The constructions are what the
 * receiver is written as, when every one of those is a call that makes a
 * class of the run, and every call of a round is asked about together.
 */

import { enclosingFunction, field } from "../ast.js";
import { constructedClasses, constructionRef } from "../constructions.js";
import {
  passingParameters,
  settleWrittenValues,
  writtenValuesOf,
} from "../facts/resolve.js";
import { nodeId, readKey } from "../facts/values.js";

import type { ReceiverOf } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { PyNode } from "../parser.js";
import type { BoundPythonFile } from "../routers.js";

/** The object a method call is made on, `repo` in `repo.get_one(1)`, or null for a call written as a name. */
export function receiverOf(call: PyNode): PyNode | null {
  const callee = field(call, "function");
  return callee?.type === "attribute" ? field(callee, "object") : null;
}

/** The name a method calls the instance it runs on, or null for a function, a static method or a class method. */
export function ownReceiverName(
  facts: Database,
  file: string,
  fn: PyNode,
): string | null {
  const row = facts
    .lookup("selfReceiver", 0, nodeId(file, fn))
    .find((one) => String(one[2]) === "instance");
  if (row === undefined) {
    return null;
  }
  const param = String(row[1]);
  return param.slice(param.lastIndexOf("#") + 1);
}

/** A call on the body's own receiver, or null for one on anything else. */
export function onOwnReceiver(
  call: PyNode,
  facts: Database,
  file: string,
  fn: PyNode,
): ReceiverOf | null {
  const receiver = receiverOf(call);
  const own = ownReceiverName(facts, file, fn);
  return receiver?.type === "identifier" &&
    own !== null &&
    receiver.text === own
    ? { own: true }
    : null;
}

/**
 * The constructions each call's receiver was made at, by the call node's
 * id. A receiver that can also be something other than a construction of
 * the run is left out. So is one that can be several constructions and
 * passes a parameter on the way, since each caller passes only some.
 */
export function receiverConstructions(
  calls: readonly { call: PyNode; receiver: PyNode; file: BoundPythonFile }[],
  facts: Database,
  files: ReadonlyMap<string, BoundPythonFile>,
): Map<number, ReceiverOf> {
  const asked = calls.map(({ call, receiver, file }) => ({
    call,
    receiver,
    key: readKey(file.file, receiver, enclosingFunction(receiver)),
  }));
  const found = new Map<number, ReceiverOf>();
  if (asked.length === 0) {
    return found;
  }
  settleWrittenValues(
    facts,
    asked.flatMap(({ receiver, key }) =>
      receiver.type === "call" ? [] : [key],
    ),
  );
  // A receiver written as a call, `Repo(session).get_one(1)`, is the
  // construction itself.
  const written = asked.map(({ call, receiver, key }) => ({
    call,
    key,
    values: receiver.type === "call" ? [key] : writtenValuesOf(facts, key),
  }));
  const made = constructedClasses(
    [...new Set(written.flatMap(({ values }) => values))],
    facts,
    files,
  );
  const settled = written.flatMap(({ call, key, values }) => {
    const refs = values.flatMap((value) => {
      const ref = made.has(value) ? constructionRef(value, files) : null;
      return ref === null ? [] : [ref];
    });
    return refs.length > 0 && refs.length === values.length
      ? [{ call, key, refs: [...new Set(refs)].sort() }]
      : [];
  });
  // One construction is the one every caller passes, so only a receiver
  // with several needs to show none of them came in through a parameter.
  const passing = passingParameters(
    facts,
    settled.flatMap(({ key, refs }) => (refs.length > 1 ? [key] : [])),
  );
  for (const { call, key, refs } of settled) {
    if (!passing.has(key)) {
      found.set(call.id, { made: refs });
    }
  }
  return found;
}
