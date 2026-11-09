/**
 * The handlers a template points at, as the entries of the pack's
 * `manifest` discovery pattern. Lambda handlers are wired up in the
 * template's `Events` block, so for each source file the pattern asks the
 * nearest template which handlers are in it, and the adapter finds each
 * function by the path the `Handler` spells. A TypeScript handler gets
 * one unit per HTTP route and per AppSync operation field.
 *
 * A handler that an SQS, Schedule or SNS event reaches gets a
 * `recognized-not-http` accounting unit, so suss never drops a
 * recognized handler without a trace. That unit records the bus and
 * leaves the channel blank, because only the template shows which queue
 * delivers to it.
 */

import { type HandlerEntry, handlersForFile } from "./templateIndex.js";
import { NON_HTTP_TERMINALS } from "./terminals.js";

import type { DeployableUnit, MessageBusSemantics } from "@suss/behavioral-ir";
import type { ManifestEntry, UnitSpec } from "@suss/extractor";

/** Metadata namespace stamped on every unit this pack discovers. */
export const METADATA_NAMESPACE = "awsLambda";

export function deployableUnit(entry: HandlerEntry): DeployableUnit {
  return { deploymentTarget: "lambda", instanceName: entry.functionLogicalId };
}

/** Where a handler is in its file, as the manifest pattern looks it up. */
type HandlerPath = (
  exportName: string,
) => Pick<ManifestEntry, "path" | "member">;

/** A function at the top of the file, under the name the `Handler` gives it. */
export const exportedAs: HandlerPath = (exportName) => ({ path: [exportName] });

/** The handlers the nearest template points at in a file, each at the path its language spells and with the units it gets. */
export function handlerEntries(
  filePath: string,
  units: (entry: HandlerEntry) => UnitSpec[],
  at: HandlerPath,
): ManifestEntry[] {
  return handlersForFile(filePath).map((entry) => ({
    ...at(entry.exportName),
    units: units(entry),
  }));
}

/** The handlers in a TypeScript or JavaScript file. A template that points at an export the file lacks, after a rename, finds nothing there. */
export function typescriptHandlerEntries(filePath: string): ManifestEntry[] {
  return handlerEntries(filePath, typescriptUnits, exportedAs);
}

/**
 * A route and a GraphQL field are independent boundaries, and one
 * handler can serve both. A queue feeding a handler that also serves a
 * route or an operation still gets an accounting unit, so the queue
 * stays visible. So does a handler that bound to nothing at all.
 */
function typescriptUnits(entry: HandlerEntry): UnitSpec[] {
  const boundToNothing =
    !hasBindableRoute(entry) && operationFields(entry).length === 0;
  const accounted =
    accountedEventTypes(entry).length > 0 || boundToNothing
      ? [accountingUnit(entry)]
      : [];
  return [
    ...httpRouteUnits(entry),
    ...graphqlResolverUnits(entry),
    ...accounted,
  ];
}

function httpRouteUnits(entry: HandlerEntry): UnitSpec[] {
  const units: UnitSpec[] = [];
  for (const route of entry.httpRoutes) {
    // One REST binding cannot stand for every verb, so the declared side
    // covers an ANY route. The accounting unit records its event type.
    if (route.method === "ANY") {
      continue;
    }
    units.push({
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

/**
 * One unit per operation field AppSync routes to the handler, in every
 * language. AppSync calls the Lambda over `aws-https`, the transport the
 * AppSync contract writes for the same field.
 */
export function graphqlResolverUnits(entry: HandlerEntry): UnitSpec[] {
  return operationFields(entry).map((field) => ({
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    resolverInfo: {
      typeName: field.typeName,
      fieldName: field.fieldName,
      transport: "aws-https",
    },
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
function accountingUnit(entry: HandlerEntry): UnitSpec {
  const eventTypes = accountedEventTypes(entry);
  const backs = typeFields(entry);
  const wire = messageBusWire(eventTypes);
  const unit = deployableUnit(entry);
  return {
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
export function messageBusWire(
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
