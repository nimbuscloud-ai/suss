// discovery.ts — the pack's `discoverUnits` callback.
//
// AWS Lambda HTTP handlers aren't registered in code — the wiring lives
// in the SAM/CFN template's `Events` block. So discovery keys off the
// template rather than an in-code registration call: for each source
// file, find the handlers the reachable template declares against it and
// emit one unit per HTTP route (carrying a REST binding via `routeInfo`).
//
// Non-HTTP event handlers (SQS/Schedule/SNS) are out of scope for HTTP
// extraction — the message-bus pass in @suss/contract-cloudformation
// owns SQS consumers — but they're surfaced as `recognized-not-http`
// accounting units so a recognized handler is never silently dropped.

import { type HandlerEntry, handlersForFile } from "./templateIndex.js";

import type {
  FunctionRoot,
  TsDiscoveryContext,
} from "@suss/adapter-typescript";
import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

/** Metadata namespace stamped on every unit this pack discovers. */
export const METADATA_NAMESPACE = "awsLambda";

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
      metadata: {
        [METADATA_NAMESPACE]: {
          functionLogicalId: entry.functionLogicalId,
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
 * A handler with no bindable HTTP route (a dedicated SQS/Schedule/SNS
 * consumer, or one whose only route is ANY) still gets one accounting
 * unit — no `routeInfo`, so it falls back to a function-call binding and
 * pairs with nothing, but it appears in the summary set marked
 * `recognized-not-http` with the event types that reached it.
 */
function accountingUnit(
  entry: HandlerEntry,
  func: FunctionRoot,
): DiscoveredCustomUnit {
  const eventTypes = [
    ...entry.nonHttpEvents.map((e) => e.eventType),
    ...entry.httpRoutes
      .filter((r) => r.method === "ANY")
      .map((r) => r.eventType),
  ];
  return {
    func,
    kind: "handler",
    name: `${entry.functionLogicalId}.${entry.exportName}`,
    metadata: {
      [METADATA_NAMESPACE]: {
        functionLogicalId: entry.functionLogicalId,
        handler: entry.handler,
        recognition: "recognized-not-http",
        eventTypes,
      },
    },
  };
}

/**
 * True when the handler has at least one HTTP route we can bind to a
 * single method.
 */
function hasBindableRoute(entry: HandlerEntry): boolean {
  return entry.httpRoutes.some((r) => r.method !== "ANY");
}

export const awsLambdaDiscovery: NonNullable<PatternPack["discoverUnits"]> = (
  sourceFile,
  ctx,
) => {
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
      // The template names an export this file doesn't provide (renamed
      // handler, build artifact mismatch). Nothing to extract; the
      // declared route still exists on the contract side.
      continue;
    }
    if (hasBindableRoute(entry)) {
      units.push(...httpRouteUnits(entry, func));
    } else {
      units.push(accountingUnit(entry, func));
    }
  }
  return units;
};
