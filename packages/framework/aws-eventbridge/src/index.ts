// @suss/framework-aws-eventbridge: recognize AWS EventBridge
// producer-side calls in TypeScript and emit one
// `interaction(class: "message-send")` effect per PutEvents entry.
//
// Producer-side recognition only. Consumer-side target Lambdas gain
// their message-bus boundaryBinding via the contract-source pass that
// walks CFN/SAM `AWS::Events::Rule` + `Events:{Type: EventBridgeRule |
// Schedule}` blocks (lives in @suss/contract-cloudformation, not this
// package). There is no consumer-side body recognizer here yet: an
// EventBridge target handler reads `event.detail`, which a follow-up
// message-receive recognizer can extract; until then body-shape pairing
// isn't available for EventBridge (orphan / unused / unresolvable /
// schedule accounting still work off the CFN summaries).
//
// AWS SDK v3 (modular) only for v0:
//
//   import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
//   const client = new EventBridgeClient({});
//   await client.send(new PutEventsCommand({
//     Entries: [{
//       EventBusName: process.env.ORDER_EVENT_BUS_NAME,
//       Source: "orders.service",
//       DetailType: "OrderPlaced",
//       Detail: JSON.stringify(order),
//     }],
//   }));
//
// AWS SDK v2 (`new AWS.EventBridge().putEvents(...).promise()`) is a
// follow-up: the surface is similar but the call shape differs.
//
// A service that publishes through its own EventPublisher writes no
// PutEventsCommand of its own, so this recognizer never fires on it.
// Such a project says which publisher in the pack's `producers` option:
//
//   { module: "@acme/async", receiver: "EventPublisher",
//     method: "emit", subjectArg: 0, bodyArg: 1 }
//
// which reads `publisher.emit("user.deleted", data, opts)` as a send on
// channel "user.deleted". A subject the source does not state as a
// string yields no effect.
//
// CHANNEL IDENTITY SCHEME
// -----------------------
// One event bus multiplexes many event types, and a rule subscribes to a subset
// of them keyed by DetailType. So keying on the bus alone, the way SQS keys a
// queue, is not specific enough: two producers writing different DetailTypes to
// the same bus reach different consumers. The channel therefore includes both
// parts, encoded as:
//
//     channel = `${bus}#${detailType}`
//
//   - `bus` is the event bus identity the producer names in
//     `EventBusName`:
//       * env-derived (`process.env.ORDER_EVENT_BUS_NAME`) → the env-var
//         name ("ORDER_EVENT_BUS_NAME"). The checker's chain-collapse
//         resolves it to the CFN EventBus logical id via the producer
//         Lambda's Environment block: exactly the SQS QueueUrl → queue
//         resolution, applied to the bus segment of the channel.
//       * literal string → the literal bus name.
//       * omitted → "default" (EventBridge routes to the account's
//         default event bus when EventBusName is absent).
//   - `detailType` is the literal `DetailType` string on the entry.
//
// Consumer/provider summaries in @suss/contract-cloudformation key the
// same `${bus}#${detailType}` channel (bus = EventBus CFN logical id or
// "default", detailType = each literal from the rule's EventPattern
// `detail-type`), so producers pair with consumers via shared channel.
//
// An entry whose EventBusName or DetailType can't be reduced to the
// scheme above (dynamic bus builder, non-literal DetailType) is asked
// of the resolution store first. What still cannot be named is
// recorded with a null channel and pairs with nothing.

import {
  type CallExpression,
  Node as N,
  type Node,
  type SourceFile,
} from "ts-morph";

import { readConfiguredCall } from "@suss/adapter-typescript";
import { formatChannel, messageBusBinding } from "@suss/behavioral-ir";

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
 * Map from `@aws-sdk/client-eventbridge` command class name to the
 * EventBridge operation kind. v0 covers the message-send command;
 * future: rule/target management commands aren't message boundaries.
 */
const SEND_COMMANDS: Record<string, string> = {
  PutEventsCommand: "putEvents",
};

/**
 * Recognize a `*.send(new PutEventsCommand({ Entries: [...] }))` shape
 * and emit one `interaction(class: "message-send")` effect per entry
 * whose (bus, detailType) channel identity resolves.
 */
function eventBridgeRecognizer(call: unknown, ctx: unknown): Effect[] | null {
  const callNode = call as CallExpression;
  const recognizerCtx = ctx as {
    sourceFile: SourceFile;
    extractArgs: () => EffectArg[];
    isImportedFrom: (identifier: Node, expectedModule: string) => boolean;
    resolveWrittenValue?: (value: Node) => Node | null;
  };
  // A host older than the resolution-threaded context returns null here, and
  // the pattern match runs on the raw nodes, the way it always did.
  const resolveValue = recognizerCtx.resolveWrittenValue ?? (() => null);

  // Shape gate: callee must be PropertyAccess `<receiver>.send`.
  const calleeExpr = callNode.getExpression();
  if (!N.isPropertyAccessExpression(calleeExpr)) {
    return null;
  }
  if (calleeExpr.getName() !== "send") {
    return null;
  }

  // The first arg must be `new <CommandClass>(...)`. Binding on the
  // command class (not the receiver type) mirrors the SQS pack: the
  // command class identity is the discriminator, not the client type.
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
  // Named imports → the identifier (`PutEventsCommand`); namespace
  // imports → the property name (`eb.PutEventsCommand` → `PutEventsCommand`).
  const ctorLeafName = N.isPropertyAccessExpression(ctorExpr)
    ? ctorExpr.getName()
    : ctorExpr.getText();
  if (SEND_COMMANDS[ctorLeafName] === undefined) {
    return null;
  }

  // Verify the command class came from @aws-sdk/client-eventbridge (not
  // a user-defined class sharing the name).
  const importCheckTarget = N.isPropertyAccessExpression(ctorExpr)
    ? rootIdentifier(ctorExpr)
    : ctorExpr;
  if (
    importCheckTarget === null ||
    !recognizerCtx.isImportedFrom(
      importCheckTarget,
      "@aws-sdk/client-eventbridge",
    )
  ) {
    return null;
  }

  // Navigate the extracted arg tree to the PutEvents Entries array. The
  // `.send` call's single arg is the `new PutEventsCommand(input)`: a
  // `call`-shaped EffectArg whose args[0] is the input object literal.
  const callArgs = recognizerCtx.extractArgs();
  const entries = readEntries(callArgs);
  if (entries === null) {
    return null;
  }

  const callee = callNode.getExpression().getText();
  const astEntries = readAstEntries(firstArg);
  const effects: Effect[] = [];
  for (const [index, entry] of entries.entries()) {
    const effect = buildEntryEffect(
      entry,
      callee,
      astEntries?.[index],
      resolveValue,
    );
    if (effect !== null) {
      effects.push(effect);
    }
  }
  return effects.length > 0 ? effects : null;
}

/**
 * The entry object literals as AST nodes, lined up index for index with the
 * EffectArg entries. The AST is the only place we can resolve an identity kept
 * in a const, since the EffectArg tree only tells us "identifier". Null when the
 * Entries array is not written out at the call.
 */
function readAstEntries(command: Node): Node[] | null {
  if (!N.isNewExpression(command)) {
    return null;
  }
  const input = command.getArguments()[0];
  if (input === undefined || !N.isObjectLiteralExpression(input)) {
    return null;
  }
  for (const prop of input.getProperties()) {
    if (!N.isPropertyAssignment(prop) || prop.getName() !== "Entries") {
      continue;
    }
    const init = prop.getInitializer();
    if (init === undefined || !N.isArrayLiteralExpression(init)) {
      return null;
    }
    return init.getElements();
  }
  return null;
}

/** The initializer of `name` on an entry object literal, when written there. */
function astField(entry: Node | undefined, name: string): Node | null {
  if (entry === undefined || !N.isObjectLiteralExpression(entry)) {
    return null;
  }
  for (const prop of entry.getProperties()) {
    if (N.isPropertyAssignment(prop) && prop.getName() === name) {
      return prop.getInitializer() ?? null;
    }
  }
  return null;
}

/**
 * The bus token a single expression gives us, with no resolution: either a
 * non-empty string literal, or the env-var name in `process.env.X`.
 */
function busTokenOf(expr: Node): string | null {
  if (N.isStringLiteral(expr)) {
    const value = expr.getLiteralValue();
    return value === "" ? null : value;
  }
  const match = expr.getText().match(/^process\.env\.(\w+)$/);
  return match === null ? null : (match[1] ?? null);
}

/** The detail type a single expression gives us, meaning a non-empty string literal. */
function detailTypeOf(expr: Node): string | null {
  if (!N.isStringLiteral(expr)) {
    return null;
  }
  const value = expr.getLiteralValue();
  return value === "" ? null : value;
}

/**
 * Read one half of the identity from the entry's AST, resolving a value the
 * call does not write out. A `const bus = "orders";` one import away gives us
 * the bus, the same as writing it in the entry would.
 */
function resolvedHalf(
  entry: Node | undefined,
  name: string,
  readToken: (expr: Node) => string | null,
  resolve: (value: Node) => Node | null,
): string | null {
  const expr = astField(entry, name);
  if (expr === null) {
    return null;
  }
  const direct = readToken(expr);
  if (direct !== null) {
    return direct;
  }
  const resolved = resolve(expr);
  return resolved === null ? null : readToken(resolved);
}

/**
 * Dig the `Entries` array of EffectArgs out of the `.send(new
 * PutEventsCommand({ Entries: [...] }))` argument shape. Returns null
 * when the shape isn't the expected command-object-with-Entries-array
 * (dynamic builders, spreads, missing Entries): the call is still a
 * PutEvents, but no entry can be paired.
 */
function readEntries(callArgs: EffectArg[]): EffectArg[] | null {
  const commandArg = callArgs[0];
  if (!isEffectArgOfKind(commandArg, "call")) {
    return null;
  }
  const ctorArgs = (commandArg as { args?: EffectArg[] }).args ?? [];
  const inputArg = ctorArgs[0];
  if (!isEffectArgOfKind(inputArg, "object")) {
    return null;
  }
  const fields = (inputArg as { fields?: Record<string, EffectArg> }).fields;
  const entriesArg = fields?.Entries;
  if (!isEffectArgOfKind(entriesArg, "array")) {
    return null;
  }
  return (entriesArg as { items?: EffectArg[] }).items ?? [];
}

/**
 * Build one message-send effect from a single PutEvents entry. Returns
 * null only when the entry isn't an object literal at all; an entry
 * whose bus or detail type the code names at runtime is still a send,
 * recorded with a null channel.
 */
function buildEntryEffect(
  entry: EffectArg,
  callee: string,
  astEntry: Node | undefined,
  resolve: (value: Node) => Node | null,
): Effect | null {
  if (!isEffectArgOfKind(entry, "object")) {
    return null;
  }
  const fields = (entry as { fields: Record<string, EffectArg> }).fields;

  // A put whose bus or detail type is only known at runtime used to be dropped
  // entirely, so the event went unrecorded rather than recorded without a name.
  // A null channel says the code never gave us one, and it pairs with nothing.
  // The AST is asked first, with resolution, so a name kept in a const still
  // works. The EffectArg readers take over when the entry is not written out.
  const bus =
    fields.EventBusName === undefined
      ? readBusToken(undefined)
      : (resolvedHalf(astEntry, "EventBusName", busTokenOf, resolve) ??
        readBusToken(fields.EventBusName));
  const detailType =
    resolvedHalf(astEntry, "DetailType", detailTypeOf, resolve) ??
    readLiteralString(fields.DetailType);
  // Either half missing means the code did not name this boundary, and
  // a put named by half of one would pair across buses. The put still
  // happened, so it is recorded with nothing claimed about where it went.
  const channel =
    bus === null || detailType === null ? null : formatChannel(bus, detailType);

  // Body extraction mirrors the SQS pack: prefer the inner object when
  // Detail is `JSON.stringify({...})` (the dominant pattern) so the body
  // field set the consumer sees after JSON.parse pairs against the
  // object literal's fields, not the JSON.stringify wrapper.
  const body = unwrapJsonStringify(fields.Detail ?? null);

  // Source scopes the event on the bus (part of an EventBridge rule's
  // match), but v0 keys pairing on DetailType only per scope guard, so
  // Source rides as the routingKey for inspect rendering: not identity.
  const source = readLiteralString(fields.Source);

  return {
    type: "interaction",
    binding: messageBusBinding({
      recognition: "@suss/framework-aws-eventbridge",
      messageBus: "eventbridge",
      channel,
    }),
    callee,
    interaction: {
      class: "message-send",
      ...(body !== null ? { body } : {}),
      ...(source !== null ? { routingKey: source } : {}),
    },
  };
}

/**
 * Resolve an entry's EventBusName EffectArg to the channel's bus token:
 *   - absent → "default" (EventBridge default event bus)
 *   - `process.env.X` identifier → "X" (env-derived; chain-collapsed by
 *     the checker to the CFN EventBus logical id)
 *   - literal string → the literal bus name
 *   - anything else (dynamic identifier, call) → null (unresolvable)
 */
function readBusToken(arg: EffectArg | undefined): string | null {
  if (arg === undefined) {
    return "default";
  }
  if (isEffectArgOfKind(arg, "string")) {
    // An empty literal gives nothing, same as a value decided at
    // runtime.
    const value = (arg as { value: string }).value;
    return value === "" ? null : value;
  }
  if (isEffectArgOfKind(arg, "identifier")) {
    const name = (arg as { name: string }).name;
    const match = name.match(/^process\.env\.(\w+)$/);
    return match !== null ? match[1] : null;
  }
  return null;
}

/**
 * Read a literal-string EffectArg's value, or null when the arg isn't a
 * string literal (identifier, call, absent).
 */
function readLiteralString(arg: EffectArg | undefined): string | null {
  if (isEffectArgOfKind(arg, "string")) {
    // An empty literal gives nothing, same as a value decided at
    // runtime.
    const value = (arg as { value: string }).value;
    return value === "" ? null : value;
  }
  return null;
}

function isEffectArgOfKind(arg: EffectArg | undefined, kind: string): boolean {
  return (
    arg !== null &&
    arg !== undefined &&
    typeof arg === "object" &&
    (arg as { kind?: string }).kind === kind
  );
}

/**
 * Unwrap a `JSON.stringify(<inner>)` EffectArg. When the body is a call
 * to JSON.stringify, return the first arg's EffectArg; otherwise return
 * the body unchanged. Returns null when the input is null.
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
 * Walk a property-access chain back to its root Identifier. For
 * `eb.commands.PutEventsCommand`, returns the `eb` identifier. Returns
 * null if the root isn't an Identifier.
 */
function rootIdentifier(node: Node): Node | null {
  let current: Node = node;
  while (N.isPropertyAccessExpression(current)) {
    current = current.getExpression();
  }
  return N.isIdentifier(current) ? current : null;
}

/**
 * A publish method on a project's own publisher. The pack recognizes
 * `PutEventsCommand` by name, and a service that wraps the SDK writes
 * no such call, so the project describes its publisher here instead.
 */
export type EventBridgeProducer = ConfiguredCallSpec;

export interface EventBridgePackOptions {
  /**
   * Publishers this project emits through. Each one adds a recognizer
   * and widens the import gate to the module it names.
   */
  producers?: EventBridgeProducer[];
}

/**
 * One recognizer per configured publisher method. The subject the
 * call names is the channel, with no bus segment: a publisher takes
 * its bus from constructor config the call site never states, and the
 * checker treats an unstated bus as agreeing with any, so the subject
 * alone pairs against the rule that routes it.
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
          recognition: "@suss/framework-aws-eventbridge",
          messageBus: "eventbridge",
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
 * Pack export. The producer-side invocation recognizer plus one per
 * configured publisher, and an import gate admitting
 * `@aws-sdk/client-eventbridge` and every module a configured
 * publisher is declared in.
 */
export function eventBridgeFramework(
  options: EventBridgePackOptions = {},
): PatternPack {
  const producers = options.producers ?? [];
  return {
    name: "eventbridge",
    protocol: "eventbridge",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    // Skip files that don't import `@aws-sdk/client-eventbridge`.
    requiresImport: [
      ...new Set([
        "@aws-sdk/client-eventbridge",
        ...producers.map((p) => p.module),
      ]),
    ],
    invocationRecognizers: [
      eventBridgeRecognizer as InvocationRecognizer,
      ...producers.map(configuredProducerRecognizer),
    ],
  };
}

export default eventBridgeFramework;
