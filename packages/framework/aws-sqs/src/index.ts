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
  dottedPathOf,
  peelValue,
  statedFactKey,
  typedAsExported,
} from "@suss/adapter-typescript";
import { messageBusBinding } from "@suss/behavioral-ir";
import { configuredCallOption } from "@suss/extractor";
import {
  configuredSends,
  constructedFrom,
  messageSends,
  pack,
  typed,
} from "@suss/recognize";

import type {
  ResolutionStore,
  TsInvocationRecognizerContext,
} from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type {
  EffectArg,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { ConfiguredCallSpec, Match } from "@suss/recognize";

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

/** The record Lambda hands an SQS handler, as aws-lambda's types declare it. */
const LAMBDA_RECORD = typed({ from: ["aws-lambda"], named: ["SQSRecord"] });

/**
 * Recognizes `JSON.parse(record.body)`, where the record is one element of
 * a read of `Records`, or a value typed as aws-lambda's `SQSRecord`, and
 * records a `message-receive` effect with the fields the handler
 * destructures.
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
  const context = ctx as TsInvocationRecognizerContext;
  const store = context.resolution;
  // A reviver changes the values and not which message was read, so any
  // number of arguments counts.
  const [payload] = callNode.getArguments();
  if (
    store === undefined ||
    payload === undefined ||
    dottedPathOf(callNode.getExpression()) !== "JSON.parse"
  ) {
    return null;
  }

  const facts = new ReceiveFacts(store);
  const body = facts.readAt(facts.keyOf(payload));
  if (
    body === null ||
    body.name !== "body" ||
    !(facts.isRecord(body.object) || facts.typedAsRecord(body.object))
  ) {
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
 * The run's facts, read the way the ops in `@suss/recognize/ops` read
 * them, so a receive found here is the one a declared envelope finds.
 */
class ReceiveFacts {
  private readonly access: ReturnType<ResolutionStore["factAccess"]>;

  constructor(private readonly store: ResolutionStore) {
    this.access = store.factAccess();
  }

  keyOf(node: Node): string {
    return statedFactKey(peelValue(node), this.store);
  }

  /**
   * The key and the object of the read the value is, `x.body` or
   * `x["body"]`. A name set to one read, `const text = record.body`, is
   * that read. Null for anything else.
   */
  readAt(key: string): Read | null {
    const direct = this.readWrittenAt(key);
    if (direct !== null || !this.isName(key)) {
      return direct;
    }
    const reads = this.declaredValuesOf(key).flatMap((value) => {
      const read = this.readWrittenAt(value);
      return read === null ? [] : [read];
    });
    const [only, ...more] = reads;
    return only === undefined || more.length > 0 ? null : only;
  }

  /**
   * Whether the value is one element of a read of `Records`, as a loop
   * or a callback over `event.Records` is given one.
   */
  isRecord(key: string): boolean {
    const collection =
      this.only("elementOf", key) ??
      this.only("elementOf", this.only("binds", key));
    return collection !== null && this.readAt(collection)?.name === "Records";
  }

  typedAsRecord(key: string): boolean {
    const node = this.access.nodeOf(key);
    return (
      node !== undefined && typedAsExported(node, LAMBDA_RECORD, this.store)
    );
  }

  /** The one read written at the key, `o.n` or `o["n"]`, or null. */
  private readWrittenAt(key: string): Read | null {
    const reads = new Map<string, Read>();
    for (const relation of ["readsProperty", "readsEntry"]) {
      for (const row of this.rows(relation, key)) {
        const read = { object: String(row[1]), name: String(row[2]) };
        reads.set(`${read.object}\u0000${read.name}`, read);
      }
    }
    const [only, ...more] = reads.values();
    return only === undefined || more.length > 0 ? null : only;
  }

  /**
   * What a name is bound to through its declaration. A reference binds to
   * its declaration and the declaration to its value, so both rows count.
   */
  private declaredValuesOf(name: string): string[] {
    const bound = (key: string): string[] =>
      this.rows("binds", key).map((row) => String(row[1]));
    const direct = bound(name);
    return [
      ...direct,
      ...direct.filter((key) => this.isName(key)).flatMap(bound),
    ];
  }

  private isName(key: string): boolean {
    return NOT_NAMES.every((relation) => this.rows(relation, key).length === 0);
  }

  /** The one value in the second column of the rows about the key, or null for none or several. */
  private only(relation: string, key: string | null): string | null {
    if (key === null) {
      return null;
    }
    const values = new Set(
      this.rows(relation, key).map((row) => String(row[1])),
    );
    const [one] = values;
    return values.size === 1 && one !== undefined ? one : null;
  }

  private rows(relation: string, key: string): readonly (readonly unknown[])[] {
    const node = this.access.nodeOf(key);
    if (node !== undefined) {
      this.access.state(node);
    }
    return this.access.db.lookup(relation, 0, key);
  }
}

/** A read of one key off an object, as the facts key both. */
interface Read {
  readonly name: string;
  readonly object: string;
}

/** The relations that state a value as something other than a name. */
const NOT_NAMES = [
  "call",
  "readsProperty",
  "objectValue",
  "writtenValue",
  "func",
];

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
 * A send through a project's own dispatcher, a method on it or a function
 * its package exports. A service that wraps the SDK never writes
 * `SendMessageCommand`, so the SDK declaration never matches its sends.
 */
export type SqsProducer = ConfiguredCallSpec;

/**
 * A dependency stub fills `producers`, and the CLI refuses a config file
 * that sets it.
 */
export const optionsSchema = z
  .object({
    /**
     * Each dispatcher adds the declarations for its sends, and the pack
     * also reads files that import the dispatcher's module.
     */
    producers: z.array(configuredCallOption).optional(),
  })
  .strict();

export type SqsPackOptions = z.infer<typeof optionsSchema>;

/**
 * Reads SDK sends, handler reads of `record.body`, and sends through
 * each configured dispatcher. A dispatcher's channel is the subject it
 * is passed, which is what the consumer expects too.
 */
export function sqsFramework(options: SqsPackOptions = {}): PatternPack {
  const producers = (options.producers ?? []).flatMap((producer) =>
    configuredSends(producer, "aws_sqs"),
  );
  return pack("sqs", [...sendDeclarations(), ...producers], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-aws-sqs",
    protocol: "sqs",
    // A handler file imports `SQSEvent` from aws-lambda and often never
    // imports the SQS client.
    requiresImport: ["aws-lambda"],
    recognizers: [messageReceiveRecognizer as InvocationRecognizer],
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
