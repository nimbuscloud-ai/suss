import { describe, expect, it } from "vitest";

import { functionCallBinding, messageBusBinding } from "@suss/ir-core";

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
    );
    expect(receives).toEqual({ options: {} });
  });
});

describe("what a draft leaves out", () => {
  it("writes a field once when two units of one boundary both read it", () => {
    const reading = {
      inputs: [param("o", "options")],
      transitions: [transition({ id: "t-ok", output: RETURNS })],
      reads: [{ input: "o", path: ["stream"] }],
    };
    const receives = draftedReceives([unit(reading), unit(reading)], fnBinding);
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
    );
    expect(receives).toEqual({ orderId: {} });
  });
});
