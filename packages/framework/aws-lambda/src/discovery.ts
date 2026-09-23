/**
 * The pack's `discoverUnits` callback. Lambda handlers are wired up in
 * the template's `Events` block, so for each source file the callback
 * finds the handlers the nearest template points at it and emits one
 * unit per HTTP route and per AppSync operation field.
 *
 * A handler that an SQS, Schedule or SNS event reaches gets a
 * `recognized-not-http` accounting unit, so suss never drops a
 * recognized handler without a trace. That unit records the bus and
 * leaves the channel blank, because only the template shows which queue
 * delivers to it.
 */

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

function deployableUnit(entry: HandlerEntry): DeployableUnit {
  return { deploymentTarget: "lambda", instanceName: entry.functionLogicalId };
}

function httpRouteUnits(
  entry: HandlerEntry,
  func: FunctionRoot,
): DiscoveredCustomUnit[] {
  const units: DiscoveredCustomUnit[] = [];
  for (const route of entry.httpRoutes) {
    // One REST binding cannot stand for every verb, so the declared side
    // covers an ANY route. The accounting unit records its event type.
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
 * A client can send only these root operations, so only a field on one of
 * them gets a graphql-resolver binding. AppSync can deploy a field on any
 * other type as its own Lambda, but no client can address that field by
 * itself, so its handler only records the field in metadata.
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
 * The binding records the bus the template routes to the handler and
 * leaves the channel blank, so the unit does not claim http (#128). The
 * declared consumer for the same deployed function fills the channel in
 * later. When the event types map to no single bus, the unit is invoked
 * by name and the deployed function is its boundary.
 *
 * Nothing constrains what these handlers return, so the unit uses the
 * longer terminal list and reads any returned object.
 */
function accountingUnit(
  entry: HandlerEntry,
  func: FunctionRoot,
): DiscoveredCustomUnit {
  const eventTypes = accountedEventTypes(entry);
  const backs = typeFields(entry);
  const wire = messageBusWire(eventTypes);
  const unit = deployableUnit(entry);
  return {
    func,
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    terminals: NON_HTTP_TERMINALS,
    ...(wire !== null
      ? { channelInfo: { messageBus: wire, channel: null } }
      : { invocationInfo: unit }),
    deployableUnit: unit,
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
 * A Schedule creates an EventBridge rule, so its bus is eventbridge.
 * Kinesis and DynamoDB stream events are left off, and a unit they reach
 * is invoked by name.
 */
const EVENT_WIRES: Record<string, MessageBusSemantics["messageBus"]> = {
  SQS: "aws_sqs",
  SNS: "aws.sns",
  S3: "s3",
  Schedule: "eventbridge",
  ScheduleV2: "eventbridge",
  EventBridgeRule: "eventbridge",
  CloudWatchEvent: "eventbridge",
};

/**
 * The one bus every event type behind this unit maps to, or null when a
 * type is unmapped or two types map to different buses.
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

/** Every event that is not HTTP, plus every ANY route. */
function accountedEventTypes(entry: HandlerEntry): string[] {
  return [
    ...entry.nonHttpEvents.map((e) => e.eventType),
    ...entry.httpRoutes
      .filter((r) => r.method === "ANY")
      .map((r) => r.eventType),
  ];
}

function hasBindableRoute(entry: HandlerEntry): boolean {
  return entry.httpRoutes.some((r) => r.method !== "ANY");
}

export function awsLambdaDiscovery(): NonNullable<
  PatternPack["discoverUnits"]
> {
  return (sourceFile, ctx) => {
    const sf = sourceFile as SourceFile;
    const tsCtx = ctx as TsDiscoveryContext;
    const filePath = tsCtx.getFilePath(sf);

    const entries = handlersForFile(filePath);
    if (entries.length === 0) {
      return [];
    }

    const exported = new Map<string, FunctionRoot>();
    for (const { name, func } of tsCtx.exportedFunctions(sf)) {
      exported.set(name, func);
    }

    const units: DiscoveredCustomUnit[] = [];
    for (const entry of entries) {
      const func = exported.get(entry.exportName);
      if (func === undefined) {
        // The template points at an export this file lacks, after a rename
        // or a build mismatch. The declared route still exists on the
        // contract side.
        continue;
      }
      // A route and a GraphQL field are independent boundaries, and one
      // handler can serve both.
      units.push(...httpRouteUnits(entry, func));
      units.push(...graphqlResolverUnits(entry, func));
      // A queue feeding a handler that also serves a route or an operation
      // still gets an accounting unit, so the queue stays visible. So does
      // a handler that bound to nothing at all.
      const unaccountedEvents = accountedEventTypes(entry);
      const boundToNothing =
        !hasBindableRoute(entry) && operationFields(entry).length === 0;
      if (unaccountedEvents.length > 0 || boundToNothing) {
        units.push(accountingUnit(entry, func));
      }
    }
    return units;
  };
}
