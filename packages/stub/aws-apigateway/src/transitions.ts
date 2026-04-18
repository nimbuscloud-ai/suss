// transitions.ts — Helpers for building Transition records that carry
// the conventions this package promises to consumers:
//
//  - Handler-attributed transitions: no opaque predicate, metadata
//    points at the integration that declared the status. Used for
//    status codes the backend itself can produce.
//
//  - Platform-injected transitions: one per status code, with a single
//    opaque "platform:apiGateway:..." predicate so the checker treats
//    them as a single sub-case (consumers don't have to disambiguate
//    why a 403 fired). Metadata aggregates the contributing causes
//    so inspect/diff can still attribute them.

import type { Predicate, Transition } from "@suss/behavioral-ir";
import type { ConfigRef, PlatformCause } from "./config.js";

export interface PlatformContribution {
  cause: PlatformCause;
  configRef?: ConfigRef;
  /**
   * Free-form note shown alongside `cause` in inspect output. Kept on
   * the metadata, not the predicate, so it doesn't force consumer
   * disambiguation.
   */
  note?: string;
}

/**
 * Build a PlatformContribution that respects exactOptionalPropertyTypes —
 * `configRef` is omitted when undefined rather than set to undefined.
 */
export function makeContribution(
  cause: PlatformCause,
  configRef: ConfigRef | undefined,
): PlatformContribution {
  if (configRef === undefined) {
    return { cause };
  }
  return { cause, configRef };
}

export function handlerTransition(args: {
  ownerKey: string;
  statusCode: number;
  source: string;
  configRef: ConfigRef | undefined;
}): Transition {
  return {
    id: `${args.ownerKey}:integration:${args.statusCode}`,
    conditions: [],
    output: {
      type: "response",
      statusCode: { type: "literal", value: args.statusCode },
      body: null,
      headers: {},
    },
    effects: [],
    location: { start: 0, end: 0 },
    isDefault: false,
    confidence: { source: "stub", level: "high" },
    metadata: {
      source: args.source,
      ...(args.configRef !== undefined ? { configRef: args.configRef } : {}),
    },
  };
}

/**
 * Build a single transition for a status code that the platform can
 * produce, aggregating every configuration-driven contribution that
 * lands on the same code. Returns null if `contributions` is empty.
 */
export function platformTransition(args: {
  ownerKey: string;
  statusCode: number;
  contributions: PlatformContribution[];
}): Transition | null {
  if (args.contributions.length === 0) {
    return null;
  }
  const causes = unique(args.contributions.map((c) => c.cause));
  const refs = args.contributions
    .map((c) => c.configRef)
    .filter((r): r is ConfigRef => r !== undefined);
  const predicate: Predicate = {
    type: "opaque",
    sourceText: `aws:apigateway:status-${args.statusCode}`,
    reason: "externalFunction",
  };
  return {
    id: `${args.ownerKey}:platform:${args.statusCode}`,
    conditions: [predicate],
    output: {
      type: "response",
      statusCode: { type: "literal", value: args.statusCode },
      body: null,
      headers: {},
    },
    effects: [],
    location: { start: 0, end: 0 },
    isDefault: false,
    confidence: { source: "stub", level: "high" },
    metadata: {
      source: "aws::apigateway::platform",
      platform: "apiGateway",
      causes,
      ...(refs.length > 0 ? { configRefs: refs } : {}),
    },
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
