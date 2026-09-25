/**
 * Recognizes AWS SQS sends, and the `JSON.parse(record.body)` read in an
 * SQS handler, and records a `message-send` or `message-receive` effect
 * for each so the two sides pair.
 *
 * Only AWS SDK v3 is read. A handler gets its queue binding from
 * `@suss/contract-cloudformation`. The README explains how the queue is
 * identified from `QueueUrl` and how a project declares its own
 * dispatcher in a dependency stub.
 */

import { type CallExpression, Node as N, type Node } from "ts-morph";
import { z } from "zod";

import {
  climbSyntax,
  readConfiguredCall,
  receiverTypeMatching,
} from "@suss/adapter-typescript";
import { messageBusBinding } from "@suss/behavioral-ir";
import { configuredCallOption } from "@suss/extractor";
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
import type { PackDeclaration } from "@suss/ir-core";
import type { Match } from "@suss/recognize";

const SQS = "@aws-sdk/client-sqs";

/**
 * The message is the first argument to the command's constructor, and
 * the command is the first argument to `send`.
 */
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

function sendDeclarations(): Match[] {
  return [
    messageSends({
      wire: "aws_sqs",
      client: constructedFrom(SQS),
      messages: { each: "theInput" },
      channel: [{ property: ["QueueUrl"] }],
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
      // The queue is on the command input, once, beside the list of messages.
      channel: [{ property: ["QueueUrl"], on: "theInput" }],
      body: "MessageBody",
    })
      .methods(INSIDE_THE_COMMAND(["SendMessageBatchCommand"]))
      .example(
        'client.send(new SendMessageBatchCommand({ QueueUrl: "orders", Entries: [{ MessageBody: "{}" }] }))',
      ),
  ];
}

/**
 * Recognizes `JSON.parse(record.body)` inside a `for (const record of
 * event.Records)` loop and records a `message-receive` effect with the
 * fields the handler destructures.
 *
 * Only a destructured parse result gives fields. For a cast or an
 * assignment to a plain variable, the effect has no body and suss skips
 * the body comparison.
 */
function messageReceiveRecognizer(
  call: unknown,
  ctx: unknown,
): Effect[] | null {
  const callNode = call as CallExpression;
  // Every check below reads only the syntax tree.
  void ctx;

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

  if (!isSqsRecordIdentifier(recordExpr) && !isTypedSqsRecord(recordExpr)) {
    return null;
  }

  const fields = extractDestructuredFields(callNode);

  return [
    {
      type: "interaction",
      // The CloudFormation event source mapping sets the queue, so the
      // pairing pass joins this effect to its consumer by code scope.
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
 * Accepts the loop variable of any `for...of` over a property named
 * `Records`, which covers `event.Records` and
 * `(event as SQSEvent).Records`.
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
 * Accepts a record typed with the Lambda event types, which covers a
 * record handed to a callback, as in `event.Records.map((record) => ...)`,
 * or to a helper that takes one.
 */
function isTypedSqsRecord(recordExpr: Node): boolean {
  return (
    receiverTypeMatching(recordExpr, {
      named: ["SQSRecord"],
      declaredIn: (filePath) => filePath.includes("/aws-lambda/"),
    }) !== null
  );
}

/**
 * Returns the properties destructured from the parse result, or null
 * when the result is not destructured. A trailing cast is looked
 * through, so `const { id } = JSON.parse(record.body) as Order` counts.
 */
function extractDestructuredFields(
  call: CallExpression,
): Record<string, EffectArg> | null {
  const parent = climbSyntax(call).getParent();
  if (parent === undefined || !N.isVariableDeclaration(parent)) {
    return null;
  }
  const nameNode = parent.getNameNode();
  if (!N.isObjectBindingPattern(nameNode)) {
    return null;
  }
  const fields: Record<string, EffectArg> = {};
  for (const element of nameNode.getElements()) {
    // The producer wrote the property names, so `{ total: totalAmount }`
    // records `total` and drops the local alias.
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
    // Pairing compares field names only, so the value is a placeholder.
    fields[fieldName] = {
      kind: "identifier",
      name: fieldName,
    };
  }
  return fields;
}

/**
 * A send method on a project's own dispatcher. A service that wraps the
 * SDK never writes `SendMessageCommand`, so the SDK declaration never
 * matches its sends.
 */
export type SqsProducer = ConfiguredCallSpec;

/**
 * A dependency stub fills `producers`, and the CLI refuses a config file
 * that sets it.
 */
export const optionsSchema = z
  .object({
    /**
     * Each dispatcher adds a recognizer, and the pack also reads files
     * that import the dispatcher's module.
     */
    producers: z.array(configuredCallOption).optional(),
  })
  .strict();

export type SqsPackOptions = z.infer<typeof optionsSchema>;

/**
 * The channel is the subject the call passes. A wrapper picks its queue
 * only at run time, and the consumer expects the same subject, so the
 * subject alone is enough to pair the two.
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
 * Reads SDK sends, handler reads of `record.body`, and sends through
 * each configured dispatcher.
 */
export function sqsFramework(options: SqsPackOptions = {}): PatternPack {
  const producers = options.producers ?? [];
  return pack("sqs", sendDeclarations(), {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-sqs",
    protocol: "sqs",
    // A handler file imports `SQSEvent` from aws-lambda and often never
    // imports the SQS client.
    requiresImport: ["aws-lambda", ...producers.map((p) => p.module)],
    recognizers: [
      messageReceiveRecognizer as InvocationRecognizer,
      ...producers.map(configuredProducerRecognizer),
    ],
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-sqs",
  dependencies: [{ ecosystem: "npm", name: "@aws-sdk/client-sqs" }],
  reads:
    "AWS SDK v3 SQS producer calls. Each one becomes a message-send interaction.",
};

export default sqsFramework;
