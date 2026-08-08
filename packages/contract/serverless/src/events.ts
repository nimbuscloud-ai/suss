// events.ts: one function's `events` list, translated into the SAM
// event shapes the CloudFormation reader already understands.
//
// Every event kind here maps onto the resource the framework compiles
// it into, so the boundary a serverless.yml declares and the boundary
// the same wiring declares in a SAM template come out as the same
// summary: an httpApi event is an API Gateway v2 route, an http event
// is a REST route, sqs is an event-source mapping, sns is a topic
// subscription, schedule and eventBridge are EventBridge rules.
//
// An event kind the framework defines but this reader does not
// translate abstains by name: the reason travels back to the caller,
// which reports it, so a wiring nobody read is never mistaken for a
// wiring nobody wrote.

import type { VariableResolver } from "./variables.js";

/** A SAM `Events` entry: what the CloudFormation reader consumes. */
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
 * Read a scalar the schema says is a string, resolving `${...}`
 * references. Returns null when the value is absent or resolves to
 * something with no string in it; symbolic references come back as
 * their token so the caller can decide whether a token is usable in
 * that position.
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

/**
 * An event written as a bare string (`httpApi: 'POST /orders'`) or as a
 * map (`httpApi: { method: POST, path: /orders }`). Both spellings are
 * the framework's own.
 */
function asMap(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

/**
 * The method and path an http / httpApi event states, from either
 * spelling. The string form writes them separated by a space. A path
 * the framework accepts without a leading slash gets one, which is what
 * the framework does when it compiles the route.
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
 * CloudFormation intrinsic passes through untouched, so the shared
 * resolver reads it the same way it reads one in a template. A
 * `${...}` reference the document cannot answer stays as its token,
 * which names the binding a deploy supplies rather than claiming the
 * event names nothing.
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
 * A schedule fires on a clock, so the rate is not what the boundary is
 * keyed on; the wiring is declared whether or not the rate resolves.
 * What does change the wiring is `enabled: false`, which deploys the
 * rule switched off: nothing invokes the handler until someone turns
 * it on. SAM states the same thing as `Enabled`, so it travels.
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
 * An eventBridge event states either a pattern (a rule that routes
 * matching events) or a schedule (a rule that fires on a clock). The
 * framework accepts both on the one key, so which one it is decides
 * which SAM event this becomes.
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

/**
 * Every event kind this reader translates, keyed by the name the
 * framework's own schema gives it. A kind absent from this table is
 * one the framework defines and the reader does not read yet; the
 * caller names it rather than dropping it.
 */
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
