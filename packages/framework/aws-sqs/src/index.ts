// @suss/framework-aws-sqs: recognize AWS SQS producer-side calls in
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
// follow-up: the surface is similar but the call shape differs.
//
// A service that sends through its own dispatcher writes no
// SendMessageCommand of its own, so this recognizer never fires on it.
// Such a project says which dispatcher in the pack's `producers`
// option:
//
//   { module: "@acme/async", receiver: "CommandDispatcher",
//     method: "dispatch", subjectArg: 0, bodyArg: 1 }
//
// which reads `dispatcher.dispatch("order.placed", order, { queueUrl })`
// as a send on channel "order.placed": the same subject the consumer
// names, so the two pair. A subject the source does not state as a
// string yields no effect.
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

import { readConfiguredCall, rootIdentifier } from "@suss/adapter-typescript";
import { messageBusBinding } from "@suss/behavioral-ir";
import { unwrapJsonStringify } from "@suss/extractor";

import type {
  ConfiguredCallContext,
  ConfiguredCallSpec,
} from "@suss/adapter-typescript";
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
    isImportedFrom: (identifier: Node, expectedModule: string) => boolean;
    resolveWrittenValue?: (value: Node) => Node | null;
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
  //      possible but expensive and not strictly needed: the command
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

  // The constructor leaf name is what we look up in SEND_COMMANDS. For a named
  // import that is the identifier (`SendMessageCommand`), and for a namespace
  // import it is the property name (`sqs.SendMessageCommand`).
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
    !recognizerCtx.isImportedFrom(importCheckTarget, "@aws-sdk/client-sqs")
  ) {
    return null;
  }

  // Extract the command's first arg: the input object literal.
  const ctorArgs = firstArg.getArguments();
  if (ctorArgs.length === 0) {
    return null;
  }
  const input = ctorArgs[0];
  if (!N.isObjectLiteralExpression(input)) {
    // Object spreads / dynamic builders not supported in v0.
    return null;
  }

  // A send whose queue is named by a variable, a parameter, or a
  // config lookup used to be dropped entirely, so a service that sends to a
  // queue it works out at runtime looked like a service that sends nothing. The
  // send happened either way. A null channel says the code never gave us a
  // name, and it pairs with nothing rather than pairing with the wrong thing.
  // A host older than the resolution-threaded context returns null here, and
  // the pattern match runs on the raw node, the way it always did.
  const channel = readQueueUrlChannel(
    input,
    recognizerCtx.resolveWrittenValue ?? (() => null),
  );

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
        messageBus: "aws_sqs",
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
 * Read the QueueUrl property of the SendMessageCommand input object
 * and return the channel identifier as a string. Two forms give us a channel:
 *   - `QueueUrl: process.env.ORDERS_QUEUE_URL` gives "ORDERS_QUEUE_URL"
 *   - `QueueUrl: "https://sqs..."` gives the literal URL
 *
 * Anything else goes to the resolution store first. A const set to a literal,
 * here or in another file, resolves to that literal and gives us the channel:
 *
 *   const url = "https://sqs/.../orders";
 *   new SendMessageCommand({ QueueUrl: url })   // the literal URL
 *
 * Null means the chain leaves what the code states (a parameter, a
 * config lookup, a call result). The send is still recorded; the
 * channel is null on its binding.
 */
function readQueueUrlChannel(
  input: Node,
  resolveWrittenValue: (value: Node) => Node | null,
): string | null {
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
    const named = channelNamedBy(initializer);
    if (named !== null) {
      return named;
    }
    const resolved = resolveWrittenValue(initializer);
    return resolved === null ? null : channelNamedBy(resolved);
  }
  return null;
}

/** The channel a single expression names, with no resolution. */
function channelNamedBy(expr: Node): string | null {
  // process.env.X
  if (N.isPropertyAccessExpression(expr)) {
    const text = expr.getText();
    const match = text.match(/^process\.env\.(\w+)$/);
    return match === null ? null : (match[1] ?? null);
  }

  // "literal-url"
  if (N.isStringLiteral(expr)) {
    return expr.getLiteralValue();
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
  // The ctx is unused for now: the recognizer's structural checks
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
      // Channel intentionally null: the queue a handler drains is
      // stated by the CFN event-source mapping, so this side does not
      // name it and the pairing pass joins by codeScope instead.
      binding: messageBusBinding({
        recognition: "@suss/framework-aws-sqs",
        messageBus: "aws_sqs",
        channel: null,
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
    // the producer's chosen names: which match the property names
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
    // Placeholder leaf: the pairing layer compares field-name SETS,
    // not value shapes, in v0. Future: thread the typed shape.
    fields[fieldName] = {
      kind: "identifier",
      name: fieldName,
    };
  }
  return fields;
}

/**
 * A send method on a project's own dispatcher. The pack recognizes
 * `SendMessageCommand` by name, and a service that wraps the SDK
 * writes no such call, so the project describes its wrapper here
 * instead.
 */
export type SqsProducer = ConfiguredCallSpec;

export interface SqsPackOptions {
  /**
   * Dispatchers this project sends through. Each one adds a
   * recognizer and widens the import gate to the module it names.
   */
  producers?: SqsProducer[];
}

/**
 * One recognizer per configured dispatcher method. The subject the
 * call names is the channel, with no bus segment: a wrapper knows
 * which queue it writes to only at runtime, and the consumer names
 * the same subject, so pairing has what it needs and nothing is
 * invented.
 */
function configuredProducerRecognizer(
  spec: ConfiguredCallSpec,
): InvocationRecognizer {
  return ((call: unknown, ctx: unknown): Effect[] | null => {
    const read = readConfiguredCall(
      call as CallExpression,
      ctx as ConfiguredCallContext,
      spec,
    );
    if (read === null) {
      return null;
    }
    return [
      {
        type: "interaction",
        binding: messageBusBinding({
          recognition: "@suss/framework-aws-sqs",
          messageBus: "aws_sqs",
          channel: read.subject,
        }),
        callee: read.callee,
        interaction: {
          class: "message-send",
          ...(read.body !== null ? { body: read.body } : {}),
        },
      },
    ];
  }) as InvocationRecognizer;
}

/**
 * Pack export. Two invocation recognizers: producer-side and
 * consumer-side: plus one per configured dispatcher, and an import
 * gate that admits `@aws-sdk/client-sqs` (producer files),
 * `aws-lambda` (consumer files; SQSEvent type comes from there), and
 * every module a configured dispatcher is declared in.
 */
export function sqsFramework(options: SqsPackOptions = {}): PatternPack {
  const producers = options.producers ?? [];
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
    requiresImport: [
      ...new Set([
        "@aws-sdk/client-sqs",
        "aws-lambda",
        ...producers.map((p) => p.module),
      ]),
    ],
    invocationRecognizers: [
      sqsRecognizer as InvocationRecognizer,
      messageReceiveRecognizer as InvocationRecognizer,
      ...producers.map(configuredProducerRecognizer),
    ],
  };
}

export default sqsFramework;
