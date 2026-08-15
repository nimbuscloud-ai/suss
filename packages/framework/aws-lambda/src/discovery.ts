// discovery.ts: the pack's `discoverUnits` callback.
//
// AWS Lambda HTTP handlers aren't registered in code: the wiring lives
// in the SAM/CFN template's `Events` block. So discovery keys off the
// template rather than an in-code registration call: for each source
// file, find the handlers the reachable template declares against it and
// emit one unit per HTTP route (carrying a REST binding via `routeInfo`).
//
// Non-HTTP event handlers (SQS/Schedule/SNS) are out of scope for HTTP
// extraction: the message-bus pass in @suss/contract-cloudformation
// owns SQS consumers: but they're surfaced as `recognized-not-http`
// accounting units so a recognized handler is never silently dropped.
// An SQS consumer built by a subject-naming handler factory also gets
// a message-bus binding on that subject, so it pairs with producers.

import { type HandlerEntry, handlersForFile } from "./templateIndex.js";
import { NON_HTTP_TERMINALS } from "./terminals.js";

import type {
  FunctionRoot,
  TsDiscoveryContext,
} from "@suss/adapter-typescript";
import type { DeployableUnit, MessageBusSemantics } from "@suss/behavioral-ir";
import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

/** Metadata namespace stamped on every unit this pack discovers. */
export const METADATA_NAMESPACE = "awsLambda";

/** The Lambda a template entry deploys. */
function deployableUnit(entry: HandlerEntry): DeployableUnit {
  return { deploymentTarget: "lambda", instanceName: entry.functionLogicalId };
}

function httpRouteUnits(
  entry: HandlerEntry,
  func: FunctionRoot,
): DiscoveredCustomUnit[] {
  const units: DiscoveredCustomUnit[] = [];
  for (const route of entry.httpRoutes) {
    // ANY expands to every verb; a single REST binding can't represent
    // it, so v0 leaves it for the declared-route side. Recorded below in
    // the accounting metadata rather than dropped.
    if (route.method === "ANY") {
      continue;
    }
    units.push({
      func,
      kind: "handler",
      name: `${entry.functionLogicalId}.${entry.exportName}`,
      routeInfo: { method: route.method, path: route.path },
      deployableUnit: deployableUnit(entry),
      metadata: {
        [METADATA_NAMESPACE]: {
          handler: entry.handler,
          eventId: route.eventId,
          apiEventType: route.eventType,
        },
      },
    });
  }
  return units;
}

/**
 * The three root types are the operations a client can send, so a handler
 * behind one of their fields is on a boundary, and
 * `resolverInfo` makes the adapter build the graphql-resolver binding
 * that pairs with those operations.
 *
 * Every field has a resolver, per the GraphQL execution spec, and a
 * server usually runs them all in one process. AppSync is the odd one:
 * it lets each field be its own deployed Lambda. So a handler behind a
 * field on some other type is a deployment fact rather than an API
 * surface. No client can address it, the checker only pairs root
 * selections, and the handler keeps whatever binding it would otherwise
 * have with the fields it backs recorded on it.
 */
const OPERATION_ROOT_TYPES = ["Query", "Mutation", "Subscription"];

function operationFields(
  entry: HandlerEntry,
): Array<{ typeName: string; fieldName: string }> {
  return entry.graphqlFields.filter((f) =>
    OPERATION_ROOT_TYPES.includes(f.typeName),
  );
}

function typeFields(
  entry: HandlerEntry,
): Array<{ typeName: string; fieldName: string }> {
  return entry.graphqlFields.filter(
    (f) => !OPERATION_ROOT_TYPES.includes(f.typeName),
  );
}

/** One unit per operation field this handler is routed to. */
function graphqlResolverUnits(
  entry: HandlerEntry,
  func: FunctionRoot,
): DiscoveredCustomUnit[] {
  return operationFields(entry).map((field) => ({
    func,
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    resolverInfo: { typeName: field.typeName, fieldName: field.fieldName },
    deployableUnit: deployableUnit(entry),
    metadata: {
      [METADATA_NAMESPACE]: {
        handler: entry.handler,
        recognition: "appsync-resolver",
      },
    },
  }));
}

/**
 * A handler with no bindable HTTP route (a dedicated SQS/Schedule/SNS
 * consumer, or one whose only route is ANY) still gets one accounting
 * unit, marked `recognized-not-http` with the event types that reached
 * it. Its binding says the wire the template routes to it: the
 * factory-given subject when there is one, otherwise a message-bus
 * binding with no channel, which pairs with nothing but stops the unit
 * claiming http (#128). Only a unit whose event types map to no one
 * technology keeps the function-call fallback.
 *
 * No HTTP envelope constrains what these return, so the unit uses the wider
 * terminal list and any returned object gets read. Route units keep the
 * pack-level list, where a return outside the envelope stays an unread return.
 */
function accountingUnit(
  entry: HandlerEntry,
  func: FunctionRoot,
  channel: string | null,
): DiscoveredCustomUnit {
  const eventTypes = accountedEventTypes(entry);
  const backs = typeFields(entry);
  const wire = channel !== null ? ("sqs" as const) : messageBusWire(eventTypes);
  return {
    func,
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    terminals: NON_HTTP_TERMINALS,
    ...(wire !== null ? { channelInfo: { messageBus: wire, channel } } : {}),
    deployableUnit: deployableUnit(entry),
    metadata: {
      [METADATA_NAMESPACE]: {
        handler: entry.handler,
        recognition: "recognized-not-http",
        eventTypes,
        ...(backs.length > 0 ? { graphqlTypeFields: backs } : {}),
      },
    },
  };
}

/**
 * A handler factory whose config says which subject the consumer expects, as in
 * `myFactory({ subject: "widget.created" }, async ({ parsed }) => ...)`. The
 * subject is the channel a producer publishes on, so it becomes the unit's
 * message-bus binding.
 *
 * AWS declares no such factory, so a project configures its own. The queue
 * itself stays on the declared side, since the message-bus pass in
 * @suss/contract-cloudformation reads the template's SQS wiring. What the code
 * adds is which subject this consumer listens for.
 */
export interface SubjectFactory {
  /** The property on the factory's config object that contains the subject. */
  property: string;
  /**
   * Factory functions the project builds its consumers with. Naming
   * them is not required: the adapter reads whatever call built the
   * export. Name them when two factories in the same service put
   * different things under the same property.
   */
  callees?: string[];
  /**
   * Which argument position the config object is in. When this is left out,
   * every object argument is read.
   */
  argIndex?: number;
}

/**
 * The subject a handler's factory config gives, when the template routes SQS to
 * it and the subject is a readable string. Anything else, whether that is no
 * configured factory, no factory call, or a computed subject, returns null and
 * the unit keeps its default binding.
 */
function subjectChannel(
  entry: HandlerEntry,
  sf: SourceFile,
  tsCtx: TsDiscoveryContext,
  factories: SubjectFactory[],
): string | null {
  const consumesSqs = entry.nonHttpEvents.some((e) => e.eventType === "SQS");
  if (!consumesSqs) {
    return null;
  }
  for (const factory of factories) {
    const subject = tsCtx.exportedCallConfigString(
      sf,
      entry.exportName,
      factory,
    );
    if (subject !== null) {
      return subject;
    }
  }
  return null;
}

/**
 * The wire behind a SAM event type. A Schedule creates an EventBridge
 * rule, so its wire is eventbridge. Event types this does not cover
 * (Kinesis, DynamoDB streams) stay off the map rather than guessed.
 */
const EVENT_WIRES: Record<string, MessageBusSemantics["messageBus"]> = {
  SQS: "sqs",
  SNS: "sns",
  S3: "s3",
  Schedule: "eventbridge",
  ScheduleV2: "eventbridge",
  EventBridgeRule: "eventbridge",
  CloudWatchEvent: "eventbridge",
};

/**
 * The one bus technology every event type behind this unit maps to, or
 * null when any type is unmapped or two types disagree. A mapped unit
 * gets a message-bus binding whose transport says the wire instead of
 * the pack's http (#128); null keeps the old fallback, so an unmapped
 * stream event still claims http until the enum grows.
 */
function messageBusWire(
  eventTypes: string[],
): MessageBusSemantics["messageBus"] | null {
  const wires = new Set<MessageBusSemantics["messageBus"] | null>(
    eventTypes.map((type) => EVENT_WIRES[type] ?? null),
  );
  if (wires.size !== 1) {
    return null;
  }
  const [wire] = wires;
  return wire ?? null;
}

/** Events that reach a handler but do not bind to a route of their own. */
function accountedEventTypes(entry: HandlerEntry): string[] {
  return [
    ...entry.nonHttpEvents.map((e) => e.eventType),
    ...entry.httpRoutes
      .filter((r) => r.method === "ANY")
      .map((r) => r.eventType),
  ];
}

/**
 * True when the handler has at least one HTTP route we can bind to a
 * single method.
 */
function hasBindableRoute(entry: HandlerEntry): boolean {
  return entry.httpRoutes.some((r) => r.method !== "ANY");
}

export function awsLambdaDiscovery(
  subjectFactories: SubjectFactory[] = [],
): NonNullable<PatternPack["discoverUnits"]> {
  return (sourceFile, ctx) => {
    const sf = sourceFile as SourceFile;
    const tsCtx = ctx as TsDiscoveryContext;
    const filePath = tsCtx.getFilePath(sf);

    const entries = handlersForFile(filePath);
    if (entries.length === 0) {
      return [];
    }

    // Map exported function names to their bodies once per file.
    const exported = new Map<string, FunctionRoot>();
    for (const { name, func } of tsCtx.exportedFunctions(sf)) {
      exported.set(name, func);
    }

    const units: DiscoveredCustomUnit[] = [];
    for (const entry of entries) {
      const func = exported.get(entry.exportName);
      if (func === undefined) {
        // The template asks for an export this file doesn't provide (renamed
        // handler, build artifact mismatch). Nothing to extract; the
        // declared route still exists on the contract side.
        continue;
      }
      // A route and a GraphQL field are independent boundaries, and one
      // handler can serve both.
      units.push(...httpRouteUnits(entry, func));
      units.push(...graphqlResolverUnits(entry, func));
      // The accounting unit covers a handler that bound to nothing, and
      // also the events that reach a bound handler without a boundary of
      // their own. A queue that feeds a resolver was reported before the
      // resolver binding existed, and has to keep being reported.
      // Events that reach a handler without a boundary of their own get
      // reported whatever else that handler bound to, so a queue feeding
      // a route or an operation stays visible. A handler that bound to
      // nothing at all gets one too, so nothing recognized is dropped.
      const unaccountedEvents = accountedEventTypes(entry);
      const boundToNothing =
        !hasBindableRoute(entry) && operationFields(entry).length === 0;
      if (unaccountedEvents.length > 0 || boundToNothing) {
        units.push(
          accountingUnit(
            entry,
            func,
            subjectChannel(entry, sf, tsCtx, subjectFactories),
          ),
        );
      }
    }
    return units;
  };
}
