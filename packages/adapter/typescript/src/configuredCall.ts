/**
 * Reads a method call whose receiver has a type the project's config
 * points at.
 *
 * A pack recognizes library calls by their command class, so it only
 * sees the libraries it was built with. A project that sends every
 * message through a wrapper of its own writes no such call, and the pack
 * sees nothing. This lets the project describe the wrapper instead:
 * which module declares it, which type the receiver has, which method
 * does the sending, and which arguments the subject and body are in.
 *
 * A call on a typed receiver is something TypeScript already tells us,
 * so reading it belongs to the adapter. What the call means on the bus
 * is the pack's judgment, so the pack builds the effect from this.
 */

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import type { EffectArg } from "@suss/extractor";

/**
 * A call the project has declared to be its own dispatcher.
 *
 * `receiver` is the type name rather than the variable: a service keeps
 * its dispatcher in a field, a closure or a constructor parameter, and
 * the type is the only thing stable across all three.
 */
export interface ConfiguredCallSpec {
  /** Module that declares the receiver's type. */
  module: string;
  /** Type name of the receiver, as exported from that module. */
  receiver: string;
  /** Method that performs the send. */
  method: string;
  /** Argument index carrying the subject. */
  subjectArg: number;
  /**
   * Which argument the message body is. Left out when the method has no
   * single body argument, as a batch method taking a list of entries
   * does, and then no body is reported.
   */
  bodyArg?: number;
}

export interface ConfiguredCallRead {
  /** The subject the call sends to, always a literal string. */
  subject: string;
  /** The body argument's extracted shape, or null when none applies. */
  body: EffectArg | null;
  /** Source text of the callee, for the effect's `callee` field. */
  callee: string;
}

/** The parts of a recognizer context this helper needs. */
export interface ConfiguredCallContext {
  sourceFile: SourceFile;
  extractArgs(): EffectArg[];
}

/**
 * Read `call` as the configured send, or return null.
 *
 * A subject that is not a literal string (a value built at runtime, a
 * template with substitutions, a computed key) returns null and the pack
 * emits nothing. Guessing a channel we cannot read would pair a producer
 * with the wrong consumer, which is worse than missing the producer.
 */
export function readConfiguredCall(
  call: CallExpression,
  ctx: ConfiguredCallContext,
  spec: ConfiguredCallSpec,
): ConfiguredCallRead | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }

  if (callee.getName() !== spec.method) {
    return null;
  }

  // Cheap checks first: the type query below asks the checker to walk
  // the receiver, and every call in the file would otherwise pay for it.
  if (!importsModule(ctx.sourceFile, spec.module)) {
    return null;
  }

  if (receiverTypeName(callee.getExpression()) !== spec.receiver) {
    return null;
  }

  const args = ctx.extractArgs();
  const subject = readStringArg(args[spec.subjectArg]);
  if (subject === null) {
    return null;
  }

  const body = spec.bodyArg === undefined ? null : (args[spec.bodyArg] ?? null);

  return { subject, body, callee: callee.getText() };
}

/**
 * Whether the file imports the module the spec gives. Sub-path imports
 * count, the same way `requiresImport` counts them: a package that
 * publishes `@scope/pkg/sqs` is still that package.
 */
function importsModule(sourceFile: SourceFile, module: string): boolean {
  for (const decl of sourceFile.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    if (specifier === module || specifier.startsWith(`${module}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * The name of the receiver's type, or null when the checker has no name
 * for it. A JavaScript file, or a receiver the checker widens to `any`,
 * gives null and the call is left alone.
 */
function receiverTypeName(receiver: Node): string | null {
  const symbol = receiver.getType().getSymbol();
  return symbol === undefined ? null : symbol.getName();
}

/** The value of a string-literal argument, or null for anything else. */
function readStringArg(arg: EffectArg | undefined): string | null {
  if (arg === null || arg === undefined || typeof arg !== "object") {
    return null;
  }
  const candidate = arg as { kind?: string; value?: unknown };
  if (candidate.kind !== "string" || typeof candidate.value !== "string") {
    return null;
  }
  return candidate.value;
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
