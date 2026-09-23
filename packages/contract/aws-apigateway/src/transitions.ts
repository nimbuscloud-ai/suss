/**
 * Builds the two kinds of transition this package emits.
 *
 * A status the backend itself can produce gets a transition with no
 * conditions, and its metadata points at the integration that declared it.
 *
 * A status the platform adds gets one transition per status code, guarded
 * by a single opaque `aws:apigateway:status-<code>` predicate. The checker
 * then treats every cause of, say, a 403 as one case, so a consumer does
 * not have to tell them apart. The causes are listed in the metadata for
 * inspect and diff.
 */

import type { Predicate, Transition } from "@suss/behavioral-ir";
import type { ConfigRef, PlatformCause } from "./config.js";

export interface PlatformContribution {
  cause: PlatformCause;
  configRef?: ConfigRef;
  /**
   * A note printed next to `cause` in inspect output. It goes in the
   * metadata because a distinct predicate would split the status into
   * cases a consumer would have to handle separately.
   */
  note?: string;
}

/**
 * Leaves `configRef` off when it is undefined, as
 * exactOptionalPropertyTypes requires.
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
    confidence: { source: "derived", level: "high" },
    metadata: {
      source: args.source,
      ...(args.configRef !== undefined ? { configRef: args.configRef } : {}),
    },
  };
}

/**
 * One transition for a status code the platform can produce, merging
 * every configuration setting that leads to that code. Returns null when
 * `contributions` is empty.
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
    confidence: { source: "derived", level: "high" },
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
