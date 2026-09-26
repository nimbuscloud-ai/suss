/**
 * Summaries for the change list tests: an orders service with a create
 * route and a cancel route, a client of the create route, and helpers a
 * route calls. The builders keep each test to the one thing it changes
 * between the reading before and the reading after.
 */

import { restBinding, storageBinding } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  Effect,
  Transition,
} from "@suss/behavioral-ir";

const CONFIDENT = { source: "inferred_static", level: "high" } as const;

/** A response, under a guard written as `when`, or the fall-through when there is none. */
export function responds(
  status: number,
  options: { effects?: Effect[]; when?: string; id?: string } = {},
): Transition {
  return {
    id: options.id ?? `t:${status}:${options.when ?? "otherwise"}`,
    conditions:
      options.when === undefined
        ? []
        : [
            {
              type: "opaque",
              sourceText: options.when,
              reason: "unsupportedSyntax",
            },
          ],
    output: {
      type: "response",
      statusCode: { type: "literal", value: status },
      body: null,
      headers: {},
    },
    effects: options.effects ?? [],
    location: { start: 1, end: 2 },
    isDefault: options.when === undefined,
  };
}

export function route(
  method: string,
  routePath: string,
  transitions: Transition[],
  name = "handler",
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: `src/${name}.ts`,
      range: { start: 1, end: 30 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "express",
        method,
        path: routePath,
      }),
      id: `test::src/${name}.ts::${name}`,
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: CONFIDENT,
  };
}

/** A client of `POST /orders`. */
export function caller(transitions: Transition[]): BehavioralSummary {
  return {
    ...route("POST", "/orders", transitions, "submitOrder"),
    kind: "client",
  };
}

/** A function in the project that a route calls, with one transition. */
export function helper(name: string, effects: Effect[]): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: `src/${name}.ts`,
      range: { start: 1, end: 10 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: null,
      id: `test::src/${name}.ts::${name}`,
    },
    inputs: [],
    transitions: [
      {
        id: `${name}:1`,
        conditions: [],
        output: { type: "return", value: null },
        effects,
        location: { start: 1, end: 5 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };
}

export function calls(name: string): Effect {
  return {
    type: "invocation",
    callee: name,
    args: [],
    async: true,
    summary: `test::src/${name}.ts::${name}`,
  };
}

export function touches(
  kind: "read" | "write",
  table: string,
  fields: string[] = [],
): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "pg",
      storageSystem: "postgresql",
      scope: "default",
      container: table,
    }),
    callee: "pool.query",
    interaction: {
      class: "storage-access",
      kind,
      fields,
      selector: ["id"],
      operation: kind === "read" ? "select" : "update",
    },
  };
}

/** `POST /orders/:id/cancel`: 404 when the order is missing, 200 after reading it. */
export function cancelRoute(effects: Effect[] = []): BehavioralSummary {
  return route(
    "POST",
    "/orders/:id/cancel",
    [
      responds(404, { when: "!found" }),
      responds(200, { effects: [touches("read", "orders"), ...effects] }),
    ],
    "cancel",
  );
}

export const CREATE_BEFORE = route(
  "POST",
  "/orders",
  [responds(400, { when: "!sku" }), responds(201, { id: "created" })],
  "create",
);

/** The create route after a 409 for an open order, which moves the 201 below it. */
export const CREATE_WITH_409 = route(
  "POST",
  "/orders",
  [
    responds(400, { when: "!sku" }),
    responds(409, { when: "open" }),
    responds(201, { id: "created-after-open" }),
  ],
  "create",
);
