import { describe, expect, it } from "vitest";

import {
  functionCallBinding,
  messageBusBinding,
  restBinding,
} from "@suss/ir-core";

import { draftedReceives } from "./intentReceives.js";

import type {
  BehavioralSummary,
  Input,
  Output,
  Predicate,
  Transition,
} from "@suss/behavioral-ir";

const fnBinding = functionCallBinding({
  transport: "in-process",
  recognition: "package-exports",
  package: "@suss/checker",
  exportPath: ["checkPair"],
});

const busBinding = messageBusBinding({
  recognition: "aws-sqs",
  messageBus: "aws_sqs",
  channel: "orders",
});

function param(name: string, role: string, position = 0): Input {
  return { type: "parameter", name, position, role, shape: null };
}

function transition(opts: {
  id: string;
  output: Output;
  conditions?: Predicate[];
  expectedInput?: Transition["expectedInput"];
}): Transition {
  return {
    id: opts.id,
    conditions: opts.conditions ?? [],
    output: opts.output,
    effects: [],
    location: { start: 1, end: 2 },
    isDefault: false,
    ...(opts.expectedInput !== undefined
      ? { expectedInput: opts.expectedInput }
      : {}),
  };
}

const RETURNS: Output = { type: "return", value: null };

function unit(opts: {
  inputs: Input[];
  transitions: Transition[];
  reads: Array<{ input: string; path: string[] }>;
}): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "src/index.ts",
      range: { start: 1, end: 9 },
      exportName: "checkPair",
    },
    identity: { name: "checkPair", exportPath: null, boundaryBinding: null },
    inputs: opts.inputs,
    transitions: opts.transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    inputReads: opts.reads,
  };
}

/** A boundary with no middleware registered around it. */
const noWrappers = () => [];

/** A guard that the value at this parameter is missing. */
function missing(inputRef: string, path: string[] = []): Predicate {
  return {
    type: "truthinessCheck",
    subject: { type: "input", inputRef, path },
    negated: true,
  };
}

describe("which fields a draft calls required", () => {
  it("counts a 4xx response as turning the caller away", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("req", "request")],
          transitions: [
            transition({
              id: "t400",
              conditions: [missing("req", ["id"])],
              output: {
                type: "response",
                statusCode: { type: "literal", value: 400 },
                body: null,
                headers: {},
              },
            }),
            transition({ id: "t-ok", output: RETURNS }),
          ],
          reads: [{ input: "req", path: ["id"] }],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ "request.id": { required: true } });
  });

  it("leaves a field alone when the branch that checks it serves the caller", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("req", "request")],
          transitions: [
            transition({
              id: "t200",
              conditions: [missing("req", ["id"])],
              output: {
                type: "response",
                statusCode: { type: "literal", value: 200 },
                body: null,
                headers: {},
              },
            }),
          ],
          reads: [{ input: "req", path: ["id"] }],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ "request.id": {} });
  });

  it("counts a branch that returns nothing as turning the caller away", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("o", "options")],
          transitions: [
            transition({
              id: "t-null",
              conditions: [
                {
                  type: "nullCheck",
                  subject: { type: "input", inputRef: "o", path: ["stream"] },
                  negated: false,
                },
              ],
              output: { type: "return", value: { type: "null" } },
            }),
          ],
          reads: [{ input: "o", path: ["stream"] }],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ "options.stream": { required: true } });
  });

  it("walks a compound guard, so both fields of an and come out required", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("o", "options")],
          transitions: [
            transition({
              id: "t-throw",
              conditions: [
                {
                  type: "compound",
                  op: "and",
                  operands: [missing("o", ["a"]), missing("o", ["b"])],
                },
              ],
              output: {
                type: "throw",
                exceptionType: "TypeError",
                message: null,
              },
            }),
          ],
          reads: [
            { input: "o", path: ["a"] },
            { input: "o", path: ["b"] },
          ],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({
      "options.a": { required: true },
      "options.b": { required: true },
    });
  });

  it("walks a negated guard", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("o", "options")],
          transitions: [
            transition({
              id: "t-throw",
              conditions: [{ type: "negation", operand: missing("o", ["a"]) }],
              output: {
                type: "throw",
                exceptionType: "TypeError",
                message: null,
              },
            }),
          ],
          reads: [{ input: "o", path: ["a"] }],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ "options.a": { required: true } });
  });

  it("leaves a guard that is about something else alone", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("o", "options")],
          transitions: [
            transition({
              id: "t-throw",
              conditions: [
                {
                  type: "comparison",
                  left: { type: "state", name: "count" },
                  op: "eq",
                  right: { type: "literal", value: 0 },
                },
                {
                  type: "truthinessCheck",
                  subject: { type: "state", name: "count" },
                  negated: true,
                },
              ],
              output: {
                type: "throw",
                exceptionType: "TypeError",
                message: null,
              },
            }),
          ],
          reads: [{ input: "o", path: ["a"] }],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ "options.a": {} });
  });
});

describe("the shape a draft writes beside a field", () => {
  it("leaves a shape off when the path is not in what the branch expects", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("o", "options")],
          transitions: [
            transition({
              id: "t-ok",
              output: RETURNS,
              expectedInput: { type: "text" },
            }),
          ],
          reads: [{ input: "o", path: ["stream"] }],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ "options.stream": {} });
  });

  it("leaves a shape off when the vocabulary cannot spell it", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("o", "options")],
          transitions: [
            transition({
              id: "t-ok",
              output: RETURNS,
              expectedInput: {
                type: "record",
                properties: { options: { type: "unknown" } },
              },
            }),
          ],
          reads: [{ input: "o", path: [] }],
        }),
      ],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ options: {} });
  });
});

describe("the block a REST route drafts", () => {
  const routeBinding = restBinding({
    transport: "http",
    method: "GET",
    path: "/invoices/:id",
    recognition: "express",
  });

  /** Where an Express handler reads each part of the request. */
  const EXPRESS_SPELLING = {
    headers: { path: ["request", "headers"], saysWhichField: true },
    query: { path: ["request", "query"], saysWhichField: true },
    params: { path: ["request", "params"], saysWhichField: true },
    body: { path: ["request", "body"], saysWhichField: true },
  };

  function route(opts: {
    transitions: Transition[];
    reads: Array<{ input: string; path: string[] }>;
  }): BehavioralSummary {
    return {
      ...unit({
        inputs: [param("req", "request"), param("res", "response", 1)],
        transitions: opts.transitions,
        reads: opts.reads,
      }),
      metadata: { requestSpelling: EXPRESS_SPELLING },
    };
  }

  it("writes each read under the section of the request it came from", () => {
    const receives = draftedReceives(
      [
        route({
          transitions: [
            transition({
              id: "t401",
              conditions: [missing("req", ["headers", "x-tenant-id"])],
              output: {
                type: "response",
                statusCode: { type: "literal", value: 401 },
                body: null,
                headers: {},
              },
            }),
            transition({ id: "t-ok", output: RETURNS }),
          ],
          reads: [
            { input: "req", path: ["headers", "x-tenant-id"] },
            { input: "req", path: ["query", "dryRun"] },
            { input: "req", path: ["params", "id"] },
          ],
        }),
      ],
      routeBinding,
      noWrappers,
    );
    expect(receives).toEqual({
      headers: { "x-tenant-id": { required: true } },
      query: { dryRun: {} },
      params: { id: {} },
    });
  });

  it("writes a body read as a property of the body shape", () => {
    const receives = draftedReceives(
      [
        route({
          transitions: [transition({ id: "t-ok", output: RETURNS })],
          reads: [{ input: "req", path: ["body", "note"] }],
        }),
      ],
      routeBinding,
      noWrappers,
    );
    expect(receives).toEqual({
      body: { properties: { note: { type: "unknown" } } },
    });
  });

  it("says the route takes a body when it read one without naming a field", () => {
    const receives = draftedReceives(
      [
        route({
          transitions: [transition({ id: "t-ok", output: RETURNS })],
          reads: [{ input: "req", path: ["body"] }],
        }),
      ],
      routeBinding,
      noWrappers,
    );
    expect(receives).toEqual({ body: { type: "unknown" } });
  });

  it("writes nothing for a route that reads no part of the request", () => {
    const receives = draftedReceives(
      [
        route({
          transitions: [transition({ id: "t-ok", output: RETURNS })],
          reads: [{ input: "res", path: ["json"] }],
        }),
      ],
      routeBinding,
      noWrappers,
    );
    expect(receives).toBeNull();
  });
});

describe("what a draft leaves out", () => {
  it("writes a field once when two units of one boundary both read it", () => {
    const reading = {
      inputs: [param("o", "options")],
      transitions: [transition({ id: "t-ok", output: RETURNS })],
      reads: [{ input: "o", path: ["stream"] }],
    };
    const receives = draftedReceives(
      [unit(reading), unit(reading)],
      fnBinding,
      noWrappers,
    );
    expect(receives).toEqual({ "options.stream": {} });
  });

  it("skips a unit whose read set is too short to write down", () => {
    const receives = draftedReceives(
      [
        unit({
          inputs: [param("event", "event")],
          transitions: [transition({ id: "t-ok", output: RETURNS })],
          reads: [{ input: "event", path: [] }],
        }),
        unit({
          inputs: [param("event", "event")],
          transitions: [transition({ id: "t-ok", output: RETURNS })],
          reads: [{ input: "event", path: ["orderId"] }],
        }),
      ],
      busBinding,
      noWrappers,
    );
    expect(receives).toEqual({ orderId: {} });
  });
});
