/**
 * Lambda handlers in Python and Ruby. Those adapters take packs as data,
 * so the pack hands each one the functions the template points at in a
 * file, and the adapter finds each function by the name the `Handler`
 * gives it: `handler`, or `Billing::Handler.process` for a Ruby class
 * method. Each handler then has a summary with its deployable unit, and
 * the call walk starts from it, as it does from a TypeScript handler.
 *
 * Neither adapter reads a Lambda's response envelope yet, so a handler
 * gets no route or resolver binding. Its events are listed on the unit
 * instead. A handler whose events all come from one message bus is that
 * bus's consumer, as in TypeScript, and any other handler is bound as
 * the deployed function, invoked by name.
 */

import { messageBusBinding, unitInvocationBinding } from "@suss/behavioral-ir";

import {
  deployableUnit,
  METADATA_NAMESPACE,
  messageBusWire,
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
      units: [handlerUnit(entry, recognition)],
    }));
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
