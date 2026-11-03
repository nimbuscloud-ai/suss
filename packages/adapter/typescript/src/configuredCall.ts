/**
 * Reads a call that the project's dependency stub says sends a message.
 *
 * A pack recognizes library calls by their command class, so a project
 * that sends through a wrapper of its own writes no call the pack knows.
 * The stub describes the wrapper in one of two forms: the receiver's
 * type and the method that sends, or an export of the module. An export
 * matches the calls `suss infer stub` attributes to it, so a drafted
 * stub reads back the calls it was drafted from. Both forms say which
 * arguments the subject and the body are.
 *
 * Which export or typed receiver a call reaches is the adapter's to
 * tell, and the pack decides what the call means on the bus.
 */

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import { matchingImportDeclarations } from "./discovery/importScan.js";
import { attributedCall } from "./discovery/packageImport.js";
import { ResolutionStore } from "./facts/store.js";
import { receiverTypesOf } from "./values/receiverType.js";

import type { CallOps, configuredCallOption, EffectArg } from "@suss/extractor";
import type { z } from "zod";

/**
 * A call the project has declared to be its own dispatcher. The
 * declaration a project config is parsed against lives with the other
 * shared pack options, so this reader and the packs that take it under
 * `producers` describe one shape.
 */
export type ConfiguredCallSpec = z.infer<typeof configuredCallOption>;

type ReceiverCallSpec = Extract<ConfiguredCallSpec, { receiver: string }>;
type ExportCallSpec = Exclude<ConfiguredCallSpec, ReceiverCallSpec>;

/** Which arguments of a matched call the subject and body are. */
interface ArgumentPositions {
  subject: number;
  body: number | undefined;
}

export interface ConfiguredCallRead {
  /**
   * The subject the call sends to, or null when nothing in the source
   * settles it.
   */
  subject: string | null;
  /** The body argument's extracted shape, or null when none applies. */
  body: EffectArg | null;
  /** Source text of the callee, for the effect's `callee` field. */
  callee: string;
}

/** The parts of a recognizer context this helper needs. */
export interface ConfiguredCallContext {
  sourceFile: SourceFile;
  /** What the call's arguments settle to, read the way a declared pack reads them. */
  ops: CallOps;
  /**
   * The run's store, which says which export a call reaches. A context
   * built without one gets a store of its own for the export form.
   */
  resolution?: ResolutionStore;
}

/**
 * Read `call` as the configured send, or return null. The subject is
 * read the way an SDK send reads its channel, so one nothing settles
 * records the send with no channel instead of a guessed one.
 */
export function readConfiguredCall(
  call: CallExpression,
  ctx: ConfiguredCallContext,
  spec: ConfiguredCallSpec,
): ConfiguredCallRead | null {
  const positions = positionsInMatchingCall(call, ctx, spec);
  if (positions === null) {
    return null;
  }

  const subject = ctx.ops.valueAt(positions.subject)?.name("nothing") ?? null;
  const body =
    positions.body === undefined
      ? null
      : (ctx.ops.valueAt(positions.body)?.asArg() ?? null);

  return {
    subject: subject === "" ? null : subject,
    body,
    callee: call.getExpression().getText(),
  };
}

/** Where the subject and body are when `call` is the one `spec` describes, or null. */
function positionsInMatchingCall(
  call: CallExpression,
  ctx: ConfiguredCallContext,
  spec: ConfiguredCallSpec,
): ArgumentPositions | null {
  if ("receiver" in spec) {
    return callsTheMethod(call, ctx, spec)
      ? { subject: spec.subjectArg, body: spec.bodyArg }
      : null;
  }

  return callsTheExport(call, ctx, spec)
    ? { subject: spec.subject.at, body: spec.payload?.at }
    : null;
}

function callsTheMethod(
  call: CallExpression,
  ctx: ConfiguredCallContext,
  spec: ReceiverCallSpec,
): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return false;
  }

  if (callee.getName() !== spec.method) {
    return false;
  }

  // Cheap checks first: the type query below asks the checker to walk
  // the receiver, and every call in the file would otherwise pay for it.
  const declaring = matchingImportDeclarations(
    ctx.sourceFile,
    spec.module,
    undefined,
    true,
  );
  if (declaring.length === 0) {
    return false;
  }

  const receiverTypes = receiverTypesOf(callee.getExpression());
  return receiverTypes.some((type) => type.name === spec.receiver);
}

/**
 * Whether `call` reaches the export the way a stub draft attributes it:
 * `publishEntry(...)` after a named import, `ledger.publishEntry(...)`
 * through a namespace import, or `client.send(...)` on an instance the
 * module's `Client` made, for an export written `Client.send`.
 */
function callsTheExport(
  call: CallExpression,
  ctx: ConfiguredCallContext,
  spec: ExportCallSpec,
): boolean {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee) && !Node.isPropertyAccessExpression(callee)) {
    return false;
  }

  const reached = attributedCall(
    call,
    [spec.module],
    ctx.resolution ?? new ResolutionStore(),
  );
  return reached !== null && reached.exportPath.join(".") === spec.export;
}

/**
 * The identifier a property-access chain starts from, so `client.send`
 * and `sqs.client.send` both come back as the name a pack can look up.
 * Null when the chain starts from something else, a call or a literal.
 */
export function rootIdentifier(node: Node): Node | null {
  let current: Node = node;
  while (Node.isPropertyAccessExpression(current)) {
    current = current.getExpression();
  }
  return Node.isIdentifier(current) ? current : null;
}
