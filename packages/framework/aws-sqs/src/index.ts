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

  // The constructor leaf name is what we look up in SEND_COMMANDS.
  // For named imports it's just the identifier (`SendMessageCommand`);
  // for namespace imports it's the property name on the namespace
  // (`sqs.SendMessageCommand` → `SendMessageCommand`).
  const ctorLeafName = N.isPropertyAccessExpression(ctorExpr)
    ? ctorExpr.getName()
    : ctorExpr.getText();
  const operation = SEND_COMMANDS[ctorLeafName];
  if (operation === undefined) {
    return null;
  }

  // Verify the command class came from @aws-sdk/client-sqs (not a
  // user-defined class that happens to share the name). For namespace
  // imports we check the namespace's source; for named imports we
  // check the named symbol's source.
  const importCheckTarget = N.isPropertyAccessExpression(ctorExpr)
    ? rootIdentifier(ctorExpr)
    : ctorExpr;
  if (
    importCheckTarget === null ||
    !isImportedFrom(
      importCheckTarget,
      "@aws-sdk/client-sqs",
      recognizerCtx.sourceFile,
    )
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

  // Body extraction: prefer the inner object when MessageBody is
  // `JSON.stringify({...})` (the dominant pattern). Both producer
  // and consumer side go through JSON serialization, so the field
  // sets the body-shape pairing compares are the OBJECT LITERAL's
  // fields, not the JSON.stringify call wrapper. Falls back to
  // raw EffectArg when MessageBody is anything else.
  const rawBody = readPropertyArg(
    input,
    "MessageBody",
    recognizerCtx.extractArgs,
    callNode,
  );
  const body = unwrapJsonStringify(rawBody);

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
 * Walk a property-access chain back to its root Identifier. For
 * `sqs.commands.SendMessageCommand`, returns the `sqs` identifier.
 * Returns null if the root isn't an Identifier (e.g. a function
 * call or `this`-expression).
 */
function rootIdentifier(node: Node): Node | null {
  let current: Node = node;
  while (N.isPropertyAccessExpression(current)) {
    current = current.getExpression();
  }
  return N.isIdentifier(current) ? current : null;
}

/**
 * Walk back from an identifier reference to the import declaration
 * that introduced it. Returns true when the import's module specifier
 * matches `expectedModule`.
 *
 * Handles three import shapes:
 *   - Named: `import { Foo } from "mod"` → ImportSpecifier
 *   - Default: `import Foo from "mod"` → ImportClause
 *   - Namespace: `import * as foo from "mod"` → NamespaceImport
 *
 * Type-only imports work too (the symbol's declarations still include
 * the appropriate specifier shape), though in practice recognizers
 * care about runtime references not type-only ones.
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
    if (N.isNamespaceImport(decl)) {
      // NamespaceImport's parent is ImportClause, whose parent is
      // ImportDeclaration. Walk up two levels.
      const importClause = decl.getParent();
      if (N.isImportClause(importClause)) {
        const importDecl = importClause.getParent();
        if (
          N.isImportDeclaration(importDecl) &&
          importDecl.getModuleSpecifierValue() === expectedModule
        ) {
          return true;
        }
      }
    }
  }
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
 * Unwrap a `JSON.stringify(<inner>)` EffectArg. When the body is a
 * call to JSON.stringify, return the first arg's EffectArg; otherwise
 * return the body unchanged. Works for the common case where
 * `MessageBody: JSON.stringify({ id, total })` should pair against
 * the consumer's destructured `{ id, total }` after JSON.parse.
 *
 * Returns null when the input is null (preserve nullability).
 */
function unwrapJsonStringify(body: EffectArg | null): EffectArg | null {
  if (body === null || typeof body !== "object") {
    return body;
  }
  const candidate = body as {
    kind?: string;
    callee?: string;
    args?: EffectArg[];
  };
  if (candidate.kind !== "call" || candidate.callee !== "JSON.stringify") {
    return body;
  }
  const inner = candidate.args?.[0];
  return inner ?? body;
}

/**
 * Recognize a `JSON.parse(record.body)` shape inside a `for (const record
 * of event.Records)` loop and emit one `interaction(class:
 * "message-receive")` effect carrying the consumer-side body field set.
 *
 * The recognizer leaves `binding.semantics.channel` empty: the channel
 * isn't named in the SQS handler signature (the binding lives on the
 * CFN-declared event-source mapping). The pairing layer joins this
 * effect against the enclosing summary's CFN consumer binding via the
 * codeScope path.
 *
 * v0 extracts the body field set only when the parse result is
 * destructured (`const { id, totalAmount } = JSON.parse(record.body)`).
 * Other shapes (`as Type` casts, opaque variable assignment) emit no
 * field set and the body-shape pairing is skipped (no false positives).
 */
function messageReceiveRecognizer(
  call: unknown,
  ctx: unknown,
): Effect[] | null {
  const callNode = call as CallExpression;
  // The ctx is unused for now — the recognizer's structural checks
  // (JSON.parse on .body of a for-of loop variable iterating .Records)
  // don't require the source file. Future shape extensions (e.g. type-
  // checker driven inference) will need it.
  void ctx;

  // Shape gate: callee must be `JSON.parse(...)` (a property access
  // ending in `parse` whose receiver is the `JSON` global).
  const calleeExpr = callNode.getExpression();
  if (!N.isPropertyAccessExpression(calleeExpr)) {
    return null;
  }
  if (calleeExpr.getName() !== "parse") {
    return null;
  }
  const receiver = calleeExpr.getExpression();
  if (!N.isIdentifier(receiver) || receiver.getText() !== "JSON") {
    return null;
  }

  // The arg must be `<X>.body` where X is an identifier.
  const args = callNode.getArguments();
  if (args.length !== 1) {
    return null;
  }
  const arg = args[0];
  if (!N.isPropertyAccessExpression(arg)) {
    return null;
  }
  if (arg.getName() !== "body") {
    return null;
  }
  const recordExpr = arg.getExpression();
  if (!N.isIdentifier(recordExpr)) {
    return null;
  }

  // Confirm the `<X>.body` receiver is the iteration variable of a
  // for-of loop iterating an `event.Records` shape. Walks the
  // identifier's symbol back to its declaration and checks the
  // enclosing ForOfStatement's iterated expression.
  if (!isSqsRecordIdentifier(recordExpr)) {
    return null;
  }

  // Walk up to the enclosing variable declaration to extract the
  // destructured field set, if any.
  const fields = extractDestructuredFields(callNode);

  return [
    {
      type: "interaction",
      // Channel intentionally empty: the SQS consumer binding lives on
      // the CFN event-source mapping summary; the pairing pass joins
      // by codeScope rather than by channel name from this side.
      binding: messageBusBinding({
        recognition: "@suss/framework-aws-sqs",
        messageBus: "sqs",
        channel: "",
      }),
      callee: callNode.getExpression().getText(),
      interaction: {
        class: "message-receive",
        ...(fields !== null
          ? { body: { kind: "object", fields: fields } }
          : {}),
      },
    },
  ];
}

/**
 * True iff `recordExpr` is the iteration variable of a `for...of`
 * loop iterating something whose type ends in `.Records` or whose
 * iterated expression is `<Y>.Records`. Recognises both
 * `for (const record of event.Records)` and
 * `for (const record of (event as SQSEvent).Records)` shapes.
 */
function isSqsRecordIdentifier(recordExpr: Node): boolean {
  if (!N.isIdentifier(recordExpr)) {
    return false;
  }
  const symbol = recordExpr.getSymbol();
  if (symbol === undefined) {
    return false;
  }
  for (const decl of symbol.getDeclarations()) {
    if (!N.isVariableDeclaration(decl)) {
      continue;
    }
    // ForOfStatement -> VariableDeclarationList -> VariableDeclaration
    const declList = decl.getParent();
    if (declList === undefined) {
      continue;
    }
    const forOf = declList.getParent();
    if (forOf === undefined || !N.isForOfStatement(forOf)) {
      continue;
    }
    const iterated = forOf.getExpression();
    if (
      N.isPropertyAccessExpression(iterated) &&
      iterated.getName() === "Records"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Walk up from a `JSON.parse(record.body)` CallExpression to find
 * the enclosing variable declaration's destructuring pattern, if
 * any. Returns the field name set as a Record<name, EffectArg>
 * (with placeholder leaf values), or null when the parse result
 * isn't destructured (assigned to a plain identifier, used inline,
 * etc.).
 *
 * Accepts both:
 *   const { id, total } = JSON.parse(record.body);
 *   const { id, total } = JSON.parse(record.body) as Order;
 */
function extractDestructuredFields(
  call: CallExpression,
): Record<string, EffectArg> | null {
  let parent: Node | undefined = call.getParent();
  while (
    parent !== undefined &&
    (N.isAsExpression(parent) || N.isParenthesizedExpression(parent))
  ) {
    parent = parent.getParent();
  }
  if (parent === undefined || !N.isVariableDeclaration(parent)) {
    return null;
  }
  const nameNode = parent.getNameNode();
  if (!N.isObjectBindingPattern(nameNode)) {
    return null;
  }
  const fields: Record<string, EffectArg> = {};
  for (const element of nameNode.getElements()) {
    // The "field name" is the property the binding extracts. For
    // `{ id, total: totalAmount }`, the property is `id` and `total`
    // (NOT the local alias `totalAmount`). The pairing layer is
    // matching against the producer's emitted field set, which uses
    // the producer's chosen names — which match the property names
    // here, not the consumer's local aliases.
    const propertyNameNode = element.getPropertyNameNode();
    let fieldName: string;
    if (propertyNameNode !== undefined) {
      fieldName = propertyNameNode.getText();
    } else {
      const nameInner = element.getNameNode();
      if (!N.isIdentifier(nameInner)) {
        continue;
      }
      fieldName = nameInner.getText();
    }
    // Placeholder leaf — the pairing layer compares field-name SETS,
    // not value shapes, in v0. Future: thread the typed shape.
    fields[fieldName] = {
      kind: "identifier",
      name: fieldName,
    };
  }
  return fields;
}

/**
 * Pack export. Two invocation recognizers — producer-side and
 * consumer-side — plus an import gate that admits both
 * `@aws-sdk/client-sqs` (producer files) and `aws-lambda` (consumer
 * files; SQSEvent type comes from there).
 */
export function sqsFramework(): PatternPack {
  return {
    name: "sqs",
    protocol: "sqs",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    // Skip files that don't import either `@aws-sdk/client-sqs`
    // (producer side) or `aws-lambda` (consumer side; SQSEvent type).
    // The recognizers' structural checks are quick but the import
    // gate spares walking SQS-irrelevant files in monorepos.
    requiresImport: ["@aws-sdk/client-sqs", "aws-lambda"],
    invocationRecognizers: [
      sqsRecognizer as InvocationRecognizer,
      messageReceiveRecognizer as InvocationRecognizer,
    ],
  };
}

export default sqsFramework;
