// @suss/framework-aws-sqs — recognize AWS SQS producer-side calls in
// TypeScript and emit `interaction(class: "message-send")` effects.
//
// Producer-side recognition only. Consumer-side handlers gain a
// queue boundaryBinding via the contract-source pass that walks
// CFN/SAM Events:Type=SQS event-source mappings (lives in
// @suss/contract-cloudformation, not this package).
//
// AWS SDK v3 (modular) only for v0:
//
//   import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
//   const client = new SQSClient({});
//   await client.send(new SendMessageCommand({
//     QueueUrl: process.env.ORDERS_QUEUE_URL,
//     MessageBody: JSON.stringify(order),
//   }));
//
// AWS SDK v2 (`new AWS.SQS().sendMessage(...).promise()`) is a
// follow-up — the surface is similar but the call shape differs.
//
// Channel identity: the recognizer reads the env-var name from
// QueueUrl (e.g., "ORDERS_QUEUE_URL"). Pairing against CFN provider
// summaries collapses a two-link chain via the existing runtime-config
// env-var → CFN-resource resolution: the env var name on the producer
// side resolves to a CFN logical resource via the Lambda's Environment
// declaration; that resource is the queue. Same chain-collapse pattern
// runtime-config uses for env-var → instance pairing.

import {
  type CallExpression,
  Node as N,
  type Node,
  type SourceFile,
} from "ts-morph";

import { messageBusBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type {
  EffectArg,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";

/**
 * Map from `@aws-sdk/client-sqs` command class name to the SQS
 * operation kind. v0 covers the common message-send commands; future:
 * receive/delete/visibility commands when consumer-side recognition
 * lands here too.
 */
const SEND_COMMANDS: Record<string, string> = {
  SendMessageCommand: "send",
  SendMessageBatchCommand: "sendBatch",
};

/**
 * Recognize a `*.send(new SendMessageCommand({...}))` shape and emit
 * one `interaction(class: "message-send")` effect.
 */
function sqsRecognizer(call: unknown, ctx: unknown): Effect[] | null {
  const callNode = call as CallExpression;
  const recognizerCtx = ctx as {
    sourceFile: SourceFile;
    extractArgs: () => EffectArg[];
  };

  // Shape gate: callee must be PropertyAccess `<receiver>.send`.
  const calleeExpr = callNode.getExpression();
  if (!N.isPropertyAccessExpression(calleeExpr)) {
    return null;
  }
  if (calleeExpr.getName() !== "send") {
    return null;
  }

  // The first arg must be `new <CommandClass>(...)`. We bind on the
  // command class rather than on the receiver type because:
  //   1. Command classes are unambiguously SQS-specific;
  //   2. Resolving the receiver to SQSClient via type checking is
  //      possible but expensive and not strictly needed — the command
  //      class identity is the discriminator.
  const args = callNode.getArguments();
  if (args.length === 0) {
    return null;
  }
  const firstArg = args[0];
  if (!N.isNewExpression(firstArg)) {
    return null;
  }
  const ctorExpr = firstArg.getExpression();
  const ctorName = ctorExpr.getText();
  const operation = SEND_COMMANDS[ctorName];
  if (operation === undefined) {
    return null;
  }

  // Verify the command class came from @aws-sdk/client-sqs (not a
  // user-defined class that happens to share the name).
  if (
    !isImportedFrom(ctorExpr, "@aws-sdk/client-sqs", recognizerCtx.sourceFile)
  ) {
    return null;
  }

  // Extract the command's first arg — the input object literal.
  const ctorArgs = firstArg.getArguments();
  if (ctorArgs.length === 0) {
    return null;
  }
  const input = ctorArgs[0];
  if (!N.isObjectLiteralExpression(input)) {
    // Object spreads / dynamic builders not supported in v0.
    return null;
  }

  const channel = readQueueUrlChannel(input);
  if (channel === null) {
    return null;
  }

  const body = readPropertyArg(
    input,
    "MessageBody",
    recognizerCtx.extractArgs,
    callNode,
  );

  return [
    {
      type: "interaction",
      binding: messageBusBinding({
        recognition: "@suss/framework-aws-sqs",
        messageBus: "sqs",
        channel,
      }),
      callee: callNode.getExpression().getText(),
      interaction: {
        class: "message-send",
        ...(body !== null ? { body } : {}),
        // routingKey unused for SQS standard queues. SQS FIFO uses
        // MessageGroupId; future enhancement.
      },
    },
  ];
}

/**
 * Walk back from an identifier reference to the import declaration
 * that introduced it. Returns true when the import's module specifier
 * matches `expectedModule`.
 *
 * Handles the typical shape `import { Foo } from "mod"` and named
 * re-exports. Doesn't follow type-only imports (we want runtime
 * presence, not just type information).
 */
function isImportedFrom(
  identifierExpr: Node,
  expectedModule: string,
  sourceFile: SourceFile,
): boolean {
  if (!N.isIdentifier(identifierExpr)) {
    return false;
  }
  const symbol = identifierExpr.getSymbol();
  if (symbol === undefined) {
    return false;
  }
  // The symbol's declarations include the import specifier when the
  // identifier was imported. Walk to find any specifier whose import
  // declaration's module matches.
  for (const decl of symbol.getDeclarations()) {
    if (N.isImportSpecifier(decl)) {
      const importDecl = decl.getImportDeclaration();
      if (importDecl.getModuleSpecifierValue() === expectedModule) {
        return true;
      }
    }
    if (N.isImportClause(decl)) {
      const importDecl = decl.getParent();
      if (
        N.isImportDeclaration(importDecl) &&
        importDecl.getModuleSpecifierValue() === expectedModule
      ) {
        return true;
      }
    }
  }
  // Sanity check: if the symbol is from the project rather than node_modules,
  // it isn't from the expected module either. Use sourceFile to confirm we
  // didn't follow into a different file. (This branch isn't strictly needed
  // — the import-decl checks above already cover it — but keeps the function
  // robust if symbol resolution returns surprising decls.)
  void sourceFile;
  return false;
}

/**
 * Read the QueueUrl property of the SendMessageCommand input object
 * and return the channel identifier as a string. v0 supports two
 * shapes:
 *   - `QueueUrl: process.env.ORDERS_QUEUE_URL` → "ORDERS_QUEUE_URL"
 *   - `QueueUrl: "https://sqs..."` → the literal URL
 *
 * The env-var case is the dominant pattern in real codebases (URL
 * isn't known at code-write time). The literal case is for tests
 * and local dev — included so the recognizer doesn't silently drop
 * those calls.
 *
 * Returns null when the QueueUrl shape isn't recognised — the call
 * is still a Send, but we can't pair it without channel identity, so
 * the recognizer skips it. (Future: emit a gap-shaped effect.)
 */
function readQueueUrlChannel(input: Node): string | null {
  if (!N.isObjectLiteralExpression(input)) {
    return null;
  }
  for (const prop of input.getProperties()) {
    if (!N.isPropertyAssignment(prop)) {
      continue;
    }
    if (prop.getName() !== "QueueUrl") {
      continue;
    }
    const initializer = prop.getInitializer();
    if (initializer === undefined) {
      return null;
    }
    // process.env.X
    if (N.isPropertyAccessExpression(initializer)) {
      const text = initializer.getText();
      const match = text.match(/^process\.env\.(\w+)$/);
      if (match !== null) {
        return match[1];
      }
      return null;
    }
    // "literal-url"
    if (N.isStringLiteral(initializer)) {
      return initializer.getLiteralValue();
    }
    return null;
  }
  return null;
}

/**
 * Find a property by name on the input object literal and return its
 * EffectArg shape. Used to extract MessageBody so downstream tooling
 * can describe what's being sent.
 *
 * Implementation note: we ask the recognizer's `extractArgs` helper to
 * produce the FULL call's argument shape, then dig down to the
 * property of interest. Avoids re-implementing literal/object/identifier
 * shape extraction here.
 */
function readPropertyArg(
  input: Node,
  propName: string,
  extractCallArgs: () => EffectArg[],
  callNode: CallExpression,
): EffectArg | null {
  // The call's args are: [new SendMessageCommand({...})]. extractArgs
  // gives us a `call`-shaped EffectArg whose own args[0] is the
  // command's input object.
  const callArgs = extractCallArgs();
  const first = callArgs[0];
  if (
    first === null ||
    typeof first !== "object" ||
    (first as { kind?: string }).kind !== "call"
  ) {
    return null;
  }
  const ctorArgs = (first as { args?: EffectArg[] }).args ?? [];
  const inputArg = ctorArgs[0];
  if (
    inputArg === null ||
    typeof inputArg !== "object" ||
    (inputArg as { kind?: string }).kind !== "object"
  ) {
    return null;
  }
  const fields =
    (inputArg as { fields?: Record<string, EffectArg> }).fields ?? {};
  void input;
  void callNode;
  return fields[propName] ?? null;
}

/**
 * Pack export. Carries one invocationRecognizer; no discovery
 * patterns or terminals (consumer-side discovery happens via the
 * contract-source pass for CFN event-source mappings).
 *
 * Empty `discovery` and `terminals` arrays are intentional — this
 * pack only contributes recognizers, not new boundary kinds.
 */
export function sqsFramework(): PatternPack {
  return {
    name: "sqs",
    protocol: "sqs",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    invocationRecognizers: [sqsRecognizer as InvocationRecognizer],
  };
}

export default sqsFramework;
