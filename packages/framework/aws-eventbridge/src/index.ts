// @suss/framework-aws-eventbridge — recognize AWS EventBridge
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
// follow-up — the surface is similar but the call shape differs.
//
// CHANNEL IDENTITY SCHEME
// -----------------------
// One event bus multiplexes many event types; a rule subscribes to a
// subset keyed by DetailType. So a single (bus) identity — the way SQS
// keys a queue — under-specifies the pairing: two producers writing
// different DetailTypes to the same bus reach different consumers. The
// channel therefore carries BOTH parts, encoded as:
//
//     channel = `${bus}#${detailType}`
//
//   - `bus` is the event bus identity the producer names in
//     `EventBusName`:
//       * env-derived (`process.env.ORDER_EVENT_BUS_NAME`) → the env-var
//         name ("ORDER_EVENT_BUS_NAME"). The checker's chain-collapse
//         resolves it to the CFN EventBus logical id via the producer
//         Lambda's Environment block — exactly the SQS QueueUrl → queue
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
// scheme above (dynamic bus builder, non-literal DetailType) is skipped
// rather than paired on a guessed channel — matching the SQS
// recognizer's "skip on unresolvable channel identity" behaviour. The
// entry is still a PutEvents call; it just can't participate in pairing.

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
  };

  // Shape gate: callee must be PropertyAccess `<receiver>.send`.
  const calleeExpr = callNode.getExpression();
  if (!N.isPropertyAccessExpression(calleeExpr)) {
    return null;
  }
  if (calleeExpr.getName() !== "send") {
    return null;
  }

  // The first arg must be `new <CommandClass>(...)`. Binding on the
  // command class (not the receiver type) mirrors the SQS pack — the
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
  // `.send` call's single arg is the `new PutEventsCommand(input)` — a
  // `call`-shaped EffectArg whose args[0] is the input object literal.
  const callArgs = recognizerCtx.extractArgs();
  const entries = readEntries(callArgs);
  if (entries === null) {
    return null;
  }

  const callee = callNode.getExpression().getText();
  const effects: Effect[] = [];
  for (const entry of entries) {
    const effect = buildEntryEffect(entry, callee);
    if (effect !== null) {
      effects.push(effect);
    }
  }
  return effects.length > 0 ? effects : null;
}

/**
 * Dig the `Entries` array of EffectArgs out of the `.send(new
 * PutEventsCommand({ Entries: [...] }))` argument shape. Returns null
 * when the shape isn't the expected command-object-with-Entries-array
 * (dynamic builders, spreads, missing Entries) — the call is still a
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
 * null when the entry's (bus, detailType) channel identity can't be
 * resolved from literals — the entry is skipped rather than paired on a
 * guessed channel.
 */
function buildEntryEffect(entry: EffectArg, callee: string): Effect | null {
  if (!isEffectArgOfKind(entry, "object")) {
    return null;
  }
  const fields = (entry as { fields: Record<string, EffectArg> }).fields;

  const bus = readBusToken(fields.EventBusName);
  if (bus === null) {
    return null;
  }
  const detailType = readLiteralString(fields.DetailType);
  if (detailType === null) {
    return null;
  }
  const channel = `${bus}#${detailType}`;

  // Body extraction mirrors the SQS pack: prefer the inner object when
  // Detail is `JSON.stringify({...})` (the dominant pattern) so the body
  // field set the consumer sees after JSON.parse pairs against the
  // object literal's fields, not the JSON.stringify wrapper.
  const body = unwrapJsonStringify(fields.Detail ?? null);

  // Source scopes the event on the bus (part of an EventBridge rule's
  // match), but v0 keys pairing on DetailType only per scope guard, so
  // Source rides as the routingKey for inspect rendering — not identity.
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
    return (arg as { value: string }).value;
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
    return (arg as { value: string }).value;
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
 * Pack export. One producer-side invocation recognizer plus an import
 * gate admitting `@aws-sdk/client-eventbridge`.
 */
export function eventBridgeFramework(): PatternPack {
  return {
    name: "eventbridge",
    protocol: "eventbridge",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    // Skip files that don't import `@aws-sdk/client-eventbridge`.
    requiresImport: ["@aws-sdk/client-eventbridge"],
    invocationRecognizers: [eventBridgeRecognizer as InvocationRecognizer],
  };
}

export default eventBridgeFramework;
