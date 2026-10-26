/**
 * Lambda handlers in Python and Ruby. Those adapters take packs as data,
 * so the pack hands each one the functions the template points at in a
 * file, and the adapter finds each function by the name the `Handler`
 * gives it: `handler`, or `Billing::Handler.process` for a Ruby class
 * method. Each handler then has a summary with its deployable unit, and
 * the call walk starts from it, as it does from a TypeScript handler.
 *
 * Neither adapter reads a Lambda's response envelope yet, so a handler
 * gets no route binding. A field AppSync routes here binds the handler
 * to that field. A handler whose events all come from one message bus
 * is that bus's consumer, and any other is bound as the deployed function.
 */

import {
  graphqlResolverBinding,
  messageBusBinding,
  unitInvocationBinding,
} from "@suss/behavioral-ir";

import {
  deployableUnit,
  METADATA_NAMESPACE,
  messageBusWire,
  operationFields,
} from "./discovery.js";
import { type HandlerEntry, handlersForFile } from "./templateIndex.js";

import type { BoundaryBinding } from "@suss/behavioral-ir";
import type { DeclaredEntryPoint, DeclaredEntryUnit } from "@suss/extractor";

/**
 * The handlers the nearest template points at in a file, for the pack
 * called `recognition`. Each binding records that name, so the run's
 * report counts the handlers as that pack's work.
 */
export function lambdaEntryPoints(
  recognition: string,
): (filePath: string) => DeclaredEntryPoint[] {
  return (filePath) =>
    handlersForFile(filePath).map((entry) => ({
      name: entry.exportName,
      units: entryUnits(entry, recognition),
    }));
}

/**
 * AppSync passes a field's arguments to the handler and takes what it
 * returns as the field's value, with no envelope to read, so a field
 * AppSync routes here binds the handler to that field, as in TypeScript.
 * A handler that something else also reaches keeps its own unit for it.
 */
function entryUnits(
  entry: HandlerEntry,
  recognition: string,
): DeclaredEntryUnit[] {
  const operations = operationFields(entry);
  const fields = operations.map((field) =>
    resolverUnit(entry, field, recognition),
  );
  const reachedOtherwise =
    entry.httpRoutes.length > 0 ||
    entry.nonHttpEvents.length > 0 ||
    entry.graphqlFields.length > operations.length;
  return fields.length > 0 && !reachedOtherwise
    ? fields
    : [...fields, handlerUnit(entry, recognition)];
}

function resolverUnit(
  entry: HandlerEntry,
  field: { typeName: string; fieldName: string },
  recognition: string,
): DeclaredEntryUnit {
  return {
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    binding: graphqlResolverBinding({
      transport: "aws-https",
      recognition,
      typeName: field.typeName,
      fieldName: field.fieldName,
    }),
    deployableUnit: deployableUnit(entry),
    metadata: {
      [METADATA_NAMESPACE]: {
        handler: entry.handler,
        recognition: "appsync-resolver",
      },
    },
  };
}

function handlerUnit(
  entry: HandlerEntry,
  recognition: string,
): DeclaredEntryUnit {
  const eventTypes = [
    ...entry.httpRoutes.map((route) => route.eventType),
    ...entry.nonHttpEvents.map((event) => event.eventType),
  ];
  return {
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    binding: handlerBinding(entry, eventTypes, recognition),
    deployableUnit: deployableUnit(entry),
    metadata: {
      [METADATA_NAMESPACE]: {
        handler: entry.handler,
        recognition: "handler-entry",
        eventTypes,
        ...(entry.graphqlFields.length > 0
          ? { graphqlTypeFields: entry.graphqlFields }
          : {}),
      },
    },
  };
}

function handlerBinding(
  entry: HandlerEntry,
  eventTypes: string[],
  recognition: string,
): BoundaryBinding {
  // A field AppSync routes here is an event too, and no bus delivers it.
  const wire =
    entry.graphqlFields.length > 0 ? null : messageBusWire(eventTypes);
  if (wire !== null) {
    return messageBusBinding({ recognition, messageBus: wire, channel: null });
  }
  return unitInvocationBinding({ recognition, ...deployableUnit(entry) });
}
