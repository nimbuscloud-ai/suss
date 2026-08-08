// events.ts: one function's `events` list, translated into the SAM
// event shapes the CloudFormation reader already understands.
//
// Every event kind here maps onto the resource the framework compiles
// it into, so the boundary a serverless.yml declares and the boundary
// the same wiring declares in a SAM template come out as the same
// summary. An httpApi event is an API Gateway v2 route, an http event
// is a REST route, sqs is an event-source mapping, sns is a topic
// subscription, and schedule and eventBridge are EventBridge rules.
//
// An event kind the framework defines but this reader does not
// translate abstains by name. The reason travels back to the caller,
// which reports it, so a wiring nobody read is never mistaken for a
// wiring nobody wrote.

import type { VariableResolver } from "./variables.js";

/** A SAM `Events` entry, which is what the CloudFormation reader consumes. */
export interface SamEvent {
  Type: string;
  Properties?: Record<string, unknown>;
}

/** What one event entry produced, or why it produced nothing. */
export type EventTranslation =
  | { kind: "event"; event: SamEvent }
  | { kind: "abstained"; reason: string };

interface EventContext {
  resolver: VariableResolver;
}

/**
 * Null when the value is absent or contains no string. A symbolic
 * reference comes back as its token, so the caller decides whether a
 * token is usable in that position.
 */
function readString(
  raw: unknown,
  ctx: EventContext,
): { value: string; symbolic: boolean } | null {
  if (typeof raw !== "string") {
    return null;
  }
  const resolved = ctx.resolver.resolveString(raw);
  return resolved.kind === "resolved"
    ? { value: resolved.value, symbolic: false }
    : { value: resolved.token, symbolic: true };
}

function asMap(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

/**
 * The method and path, from either spelling the framework accepts:
 * `POST /orders`, or a map of `method` and `path`.
 */
function readRoute(
  raw: unknown,
  ctx: EventContext,
): { method: string; path: string } | { abstain: string } {
  const asString = readString(raw, ctx);
  if (asString !== null) {
    if (asString.symbolic) {
      return {
        abstain: `route is written as ${asString.value}, which the document does not state`,
      };
    }
    const space = asString.value.trim().indexOf(" ");
    if (space === -1) {
      return {
        abstain: `route "${asString.value}" names no method and path`,
      };
    }
    return {
      method: asString.value.slice(0, space).trim().toUpperCase(),
      path: withLeadingSlash(asString.value.slice(space + 1).trim()),
    };
  }

  const map = asMap(raw);
  if (map === null) {
    return { abstain: "event is neither a route string nor a map" };
  }
  const method = readString(map.method, ctx);
  const path = readString(map.path, ctx);
  if (method === null || path === null) {
    return { abstain: "event names no method or no path" };
  }
  if (method.symbolic || path.symbolic) {
    return {
      abstain: `route method or path is written as ${method.symbolic ? method.value : path.value}, which the document does not state`,
    };
  }

  return {
    method: method.value.toUpperCase(),
    path: withLeadingSlash(path.value),
  };
}

function withLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * The reference an event makes to a queue, a topic, or a bus. A
 * non-string passes through untouched, so a CloudFormation intrinsic
 * stays what the document wrote.
 */
function readReference(raw: unknown, ctx: EventContext): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  const resolved = ctx.resolver.resolveString(raw);
  return resolved.kind === "resolved" ? resolved.value : resolved.token;
}

const httpApiEvent = (raw: unknown, ctx: EventContext): EventTranslation => {
  const route = readRoute(raw, ctx);
  if ("abstain" in route) {
    return { kind: "abstained", reason: route.abstain };
  }

  return {
    kind: "event",
    event: {
      Type: "HttpApi",
      Properties: { Method: route.method, Path: route.path },
    },
  };
};

const httpEvent = (raw: unknown, ctx: EventContext): EventTranslation => {
  const route = readRoute(raw, ctx);
  if ("abstain" in route) {
    return { kind: "abstained", reason: route.abstain };
  }

  return {
    kind: "event",
    event: {
      Type: "Api",
      Properties: { Method: route.method, Path: route.path },
    },
  };
};

const sqsEvent = (raw: unknown, ctx: EventContext): EventTranslation => {
  const map = asMap(raw);
  const arn = map === null ? raw : map.arn;
  const queue = readReference(arn, ctx);
  if (queue === undefined || queue === null || queue === "") {
    return { kind: "abstained", reason: "sqs event names no queue" };
  }

  return {
    kind: "event",
    event: { Type: "SQS", Properties: { Queue: queue } },
  };
};

const snsEvent = (raw: unknown, ctx: EventContext): EventTranslation => {
  const map = asMap(raw);
  const named = map === null ? raw : (map.arn ?? map.topicName);
  const topic = readReference(named, ctx);
  if (topic === undefined || topic === null || topic === "") {
    return { kind: "abstained", reason: "sns event names no topic" };
  }
  const filterPolicy = map?.filterPolicy;

  return {
    kind: "event",
    event: {
      Type: "SNS",
      Properties: {
        Topic: topic,
        ...(filterPolicy !== undefined ? { FilterPolicy: filterPolicy } : {}),
      },
    },
  };
};

/**
 * A schedule fires on a clock, so the wiring is declared whether or not
 * the rate resolves. `enabled: false` deploys the rule switched off,
 * which does carry through, as SAM's `Enabled`.
 */
const scheduleEvent = (raw: unknown, ctx: EventContext): EventTranslation => {
  const map = asMap(raw);
  const rate = map === null ? raw : (map.rate ?? map.schedule);
  const expression = Array.isArray(rate) ? rate[0] : rate;
  const stated = readReference(expression, ctx);
  const enabled = map?.enabled;

  return {
    kind: "event",
    event: {
      Type: "Schedule",
      Properties: {
        ...(typeof stated === "string" ? { Schedule: stated } : {}),
        ...(typeof enabled === "boolean" ? { Enabled: enabled } : {}),
      },
    },
  };
};

/**
 * The framework accepts both a pattern and a schedule on the one key,
 * so whichever one is written decides which SAM event this becomes.
 */
const eventBridgeEvent = (
  raw: unknown,
  ctx: EventContext,
): EventTranslation => {
  const map = asMap(raw);
  if (map === null) {
    return { kind: "abstained", reason: "eventBridge event is not a map" };
  }
  if (map.schedule !== undefined && map.pattern === undefined) {
    return scheduleEvent({ rate: map.schedule, enabled: map.enabled }, ctx);
  }
  if (map.pattern === undefined) {
    return {
      kind: "abstained",
      reason: "eventBridge event states neither a pattern nor a schedule",
    };
  }
  const eventBus = readReference(map.eventBus, ctx);

  return {
    kind: "event",
    event: {
      Type: "EventBridgeRule",
      Properties: {
        Pattern: map.pattern,
        ...(eventBus !== undefined && eventBus !== null
          ? { EventBusName: eventBus }
          : {}),
      },
    },
  };
};

/** Keyed by the name the framework's own schema uses for each event kind. */
export const EVENT_TRANSLATIONS: Record<
  string,
  (raw: unknown, ctx: EventContext) => EventTranslation
> = {
  httpApi: httpApiEvent,
  http: httpEvent,
  sqs: sqsEvent,
  sns: snsEvent,
  schedule: scheduleEvent,
  eventBridge: eventBridgeEvent,
};
