/**
 * Lambda handlers in Python and Ruby. The pack hands each adapter the
 * functions the template points at in a file, through the same manifest
 * pattern the TypeScript pack declares, and the adapter finds each one by
 * the path the `Handler` spells: `handler`, or `Billing::Handler.process`
 * for a Ruby class method. Each handler then has a summary with its
 * deployable unit, and the call walk starts from it, as it does from a
 * TypeScript handler.
 *
 * Neither adapter reads a Lambda's response envelope yet, so a handler
 * gets no route binding. A field AppSync routes here binds the handler
 * to that field. A handler whose events all come from one message bus
 * is that bus's consumer, and any other is bound as the deployed function.
 */

import {
  deployableUnit,
  exportedAs,
  graphqlResolverUnits,
  handlerEntries,
  METADATA_NAMESPACE,
  messageBusWire,
} from "./discovery.js";

import type { ManifestEntry, UnitSpec } from "@suss/extractor";
import type { HandlerEntry } from "./templateIndex.js";

/** The handlers the nearest template points at in a Python file. */
export function pythonHandlerEntries(filePath: string): ManifestEntry[] {
  return handlerEntries(filePath, entryUnits, exportedAs);
}

/** The same for a Ruby file, where a class method is found through its class's constant path. */
export function rubyHandlerEntries(filePath: string): ManifestEntry[] {
  return handlerEntries(filePath, entryUnits, rubyHandlerPath);
}

/** `Billing::Handler.process` is a class method of `Billing::Handler`; a name with no dot is a method at the top of the file. */
function rubyHandlerPath(
  exportName: string,
): Pick<ManifestEntry, "path" | "member"> {
  const dot = exportName.lastIndexOf(".");
  if (dot === -1) {
    return { path: [exportName] };
  }
  return {
    path: exportName.slice(0, dot).split("::"),
    member: { name: exportName.slice(dot + 1), singleton: true },
  };
}

/**
 * AppSync passes a field's arguments to the handler and takes what it
 * returns as the field's value, with no envelope to read, so a field
 * AppSync routes here binds the handler to that field, as in TypeScript.
 * A handler that something else also reaches keeps its own unit for it.
 */
function entryUnits(entry: HandlerEntry): UnitSpec[] {
  const fields = graphqlResolverUnits(entry);
  const reachedOtherwise =
    entry.httpRoutes.length > 0 ||
    entry.nonHttpEvents.length > 0 ||
    entry.graphqlFields.length > fields.length;
  return fields.length > 0 && !reachedOtherwise
    ? fields
    : [...fields, handlerUnit(entry)];
}

function handlerUnit(entry: HandlerEntry): UnitSpec {
  const eventTypes = [
    ...entry.httpRoutes.map((route) => route.eventType),
    ...entry.nonHttpEvents.map((event) => event.eventType),
  ];
  // A field AppSync routes here is an event too, and no bus delivers it.
  const wire =
    entry.graphqlFields.length > 0 ? null : messageBusWire(eventTypes);
  return {
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    ...(wire !== null
      ? { channelInfo: { messageBus: wire, channel: null } }
      : { invocationInfo: deployableUnit(entry) }),
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
