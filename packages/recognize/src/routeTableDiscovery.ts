/**
 * The units a route table in one file declares, for a table whose
 * handlers are values: one per route, on the component its handler
 * renders, and one per entry the composer could not read, saying why.
 * Each unit is handed back with the adapter's own node, the component's
 * function or the place a boundary is announced, the way the other
 * declared readers hand back a function.
 */

import { composeAppRoutes } from "./routeTable.js";

import type {
  AstCapableValueOps,
  CallOps,
  EntrySource,
  ModuleOps,
  RouteOutcome,
  RouteTableMatch,
  ValueOps,
} from "@suss/extractor";
import type { DeclaredUnit } from "./discovery.js";

export function readRouteTable(
  match: RouteTableMatch,
  kind: string,
  module: ModuleOps,
): DeclaredUnit[] {
  const set = composeAppRoutes(match.table, [
    { module, displayPath: module.path() },
  ]);
  return set.outcomes.map((outcome) => unitOf(outcome, match, kind));
}

type Served = Extract<RouteOutcome, { kind: "route" }>;
type Abstained = Extract<RouteOutcome, { handler: ValueOps; kind: "unread" }>;
type Unlisted = Extract<RouteOutcome, { at: unknown }>;

function unitOf(
  outcome: RouteOutcome,
  match: RouteTableMatch,
  kind: string,
): DeclaredUnit {
  if (outcome.kind === "route") {
    return servedUnit(outcome, match, kind);
  }
  if ("handler" in outcome) {
    return abstainedUnit(outcome, match, kind);
  }
  return unlistedUnit(outcome, match, kind);
}

/** What a handler renders: the component its tag is, when the tag is written as a name, or something that does not read as one. */
function componentOf(
  handler: ValueOps,
  match: RouteTableMatch,
): ValueOps | null {
  if (match.through !== "element") {
    return handler;
  }
  const tag = handler.form?.() === "element" ? (handler.tag?.() ?? null) : null;
  return tag !== null && tag.form?.() === "name" ? tag : null;
}

/**
 * A route is a unit on the component's function, named by the tag as
 * written, with the component's props as its input. A component that
 * settles to no function is a boundary announced at the entry under the
 * same name, and a handler that is no component is one labelled by the
 * route's path.
 */
function servedUnit(
  served: Served,
  match: RouteTableMatch,
  kind: string,
): DeclaredUnit {
  const routeInfo = { method: served.method, path: served.path };
  const at = nodeOf(entryPlace(served.entry));
  const component = componentOf(served.handler, match);
  if (component === null) {
    return {
      func: null,
      announcedAt: at,
      kind,
      name: served.path,
      nameKind: "label",
      routeInfo,
      foundAt: null,
    };
  }
  const name = component.source?.() ?? "";
  const func = nodeOf(component.function?.() ?? null);
  if (func === null) {
    return {
      func: null,
      announcedAt: at,
      kind,
      name,
      routeInfo,
      foundAt: null,
    };
  }
  return {
    func,
    kind,
    name,
    routeInfo,
    inputMapping: { type: "componentProps", paramPosition: 0 },
    foundAt: null,
  };
}

/** An entry whose path did not read, labelled by the component it renders, else by its own tag, else `declaration`. */
function abstainedUnit(
  abstained: Abstained,
  match: RouteTableMatch,
  kind: string,
): DeclaredUnit {
  const unreadBinding = match.unread[abstained.reason];
  return {
    func: null,
    announcedAt: nodeOf(entryPlace(abstained.entry)),
    kind,
    name: abstentionLabel(abstained, match),
    nameKind: "label",
    ...(unreadBinding === undefined ? {} : { unreadBinding }),
    foundAt: null,
  };
}

function abstentionLabel(abstained: Abstained, match: RouteTableMatch): string {
  const component = componentOf(abstained.handler, match);
  if (component !== null) {
    return component.source?.() ?? "";
  }
  if (abstained.entry.form === "element") {
    return abstained.entry.value.tag?.()?.source?.() ?? "";
  }
  return "declaration";
}

/** A list item or a list that did not read, said where it is, or at the root call whose list it is. */
function unlistedUnit(
  unlisted: Unlisted,
  match: RouteTableMatch,
  kind: string,
): DeclaredUnit {
  return {
    func: null,
    announcedAt: nodeOf(
      "call" in unlisted.at ? unlisted.at.call : unlisted.at.value,
    ),
    kind,
    name: labelOf(unlisted.value),
    nameKind: "label",
    unreadBinding: match.unread[unlisted.reason],
    foundAt: null,
  };
}

/** What a value that did not read goes by: a call by its callee, and anything else by its source text. */
function labelOf(value: ValueOps): string {
  const call = value.asCall?.() ?? null;
  return call === null ? (value.source?.() ?? "") : call.calleeText();
}

function entryPlace(entry: EntrySource): ValueOps | CallOps {
  return entry.form === "call" ? entry.call : entry.value;
}

/** The adapter's own node for the value or the call. */
function nodeOf(value: ValueOps | CallOps | null): unknown {
  return (value as Partial<AstCapableValueOps> | null)?.ast?.() ?? null;
}
