// configuredCall.ts — read a method call on a receiver whose type a
// pack's configuration names.
//
// Sibling of `discoveryContext.ts`'s `exportedCallConfigString`, for
// invocation recognizers rather than discovery. A pack that recognizes
// library calls by their command class can only see the libraries it
// ships knowledge of. A project that sends every message through its
// own wrapper writes no such call, so the pack sees nothing. This
// helper lets the project describe the wrapper instead: which module
// declares it, which type the receiver has, which method sends, and
// which argument carries the subject and the body.
//
// What it reads is a shape the TypeScript language already gives us —
// a call on a typed receiver — so it lives with the adapter. What the
// call means on the bus is the pack's judgment, so the pack builds the
// effect from what this returns.

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import type { EffectArg } from "@suss/extractor";

/**
 * A call a project names as its own dispatcher.
 *
 * `receiver` is the type name, not the variable: a service holds its
 * dispatcher in a field, a closure, or a constructor parameter, and
 * only the type is stable across those.
 */
export interface ConfiguredCallSpec {
  /** Module the receiver's type is declared in. */
  module: string;
  /** Type name of the receiver, as exported from that module. */
  receiver: string;
  /** Method that performs the send. */
  method: string;
  /** Argument index carrying the subject. */
  subjectArg: number;
  /**
   * Argument index carrying the message body. Left out when the
   * method takes no single body argument (a batch method takes a
   * list of entries), and then the read carries no body.
   */
  bodyArg?: number;
}

export interface ConfiguredCallRead {
  /** The subject the call names, always a string the source states. */
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
 * Read `call` as the configured send, or answer null.
 *
 * A subject that is not a string the source states (a variable built
 * at runtime, a template with substitutions, a computed key) answers
 * null, and the pack emits nothing. Naming a channel we cannot read
 * would pair a producer against the wrong consumer, which is worse
 * than not seeing the producer at all.
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
 * Whether the file imports the module the spec names. Sub-path
 * imports count, the way `requiresImport` counts them: a package
 * that publishes `@scope/pkg/sqs` is still that package.
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
 * The name of the receiver's type, or null when the checker cannot
 * name one. A JavaScript file, or a receiver the checker widens to
 * `any`, answers null and the call is left alone.
 */
function receiverTypeName(receiver: Node): string | null {
  const symbol = receiver.getType().getSymbol();
  return symbol === undefined ? null : symbol.getName();
}

/** The value of a string-shaped argument, or null for anything else. */
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
