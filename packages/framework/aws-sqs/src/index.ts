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

import { type CallExpression, Node as N, type Node } from "ts-morph";

import { readConfiguredCall } from "@suss/adapter-typescript";
import { messageBusBinding } from "@suss/behavioral-ir";
import { constructedFrom, messageSends, pack } from "@suss/recognize";

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
import type { Match } from "@suss/recognize";

const SQS = "@aws-sdk/client-sqs";

/** Where a send states its message: one argument into the command. */
const INSIDE_THE_COMMAND = (named: string[]) => ({
  send: {
    input: {
      at: 0,
      of: [
        {
          to: "argument" as const,
          at: 0,
          origin: constructedFrom({ from: [SQS], named }),
        },
      ],
    },
  },
});

/** The declared producer side: one send, and the batch form. */
function sendDeclarations(): Match[] {
  return [
    messageSends({
      wire: "aws_sqs",
      client: constructedFrom(SQS),
      messages: { each: "theInput" },
      channel: [{ property: "QueueUrl" }],
      body: "MessageBody",
    })
      .methods(INSIDE_THE_COMMAND(["SendMessageCommand"]))
      .example(
        'client.send(new SendMessageCommand({ QueueUrl: "orders", MessageBody: "{}" }))',
      ),
    messageSends({
      wire: "aws_sqs",
      client: constructedFrom(SQS),
      messages: { each: "in", property: "Entries" },
      // A batch states the queue once beside the list of messages.
      channel: [{ property: "QueueUrl", on: "theInput" }],
      body: "MessageBody",
    })
      .methods(INSIDE_THE_COMMAND(["SendMessageBatchCommand"]))
      .example(
        'client.send(new SendMessageBatchCommand({ QueueUrl: "orders", Entries: [{ MessageBody: "{}" }] }))',
      ),
  ];
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
  return pack("sqs", sendDeclarations(), {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-sqs",
    protocol: "sqs",
    // The consumer side reads SQSEvent handlers, whose files import
    // aws-lambda rather than the SQS client.
    requiresImport: ["aws-lambda", ...producers.map((p) => p.module)],
    recognizers: [
      messageReceiveRecognizer as InvocationRecognizer,
      ...producers.map(configuredProducerRecognizer),
    ],
  });
}

export default sqsFramework;
