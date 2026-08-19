import { describe, expect, it } from "vitest";

import {
  bodyFieldTruthy,
  consumer,
  provider,
  recordBody,
  response,
  transition,
} from "../__fixtures__/pairs.js";
import {
  bodyFieldsConsumerReads,
  failureOnlyBodyFields,
} from "./contentDiscrimination.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

const unknown: TypeShape = { type: "unknown" };

const consumerReading = (expectedInput: TypeShape): BehavioralSummary => {
  const c = consumer("client", [
    transition("ct-default", {
      output: { type: "return", value: null },
      isDefault: true,
    }),
  ]);
  c.transitions[0] = { ...c.transitions[0], expectedInput };
  return c;
};

describe("failureOnlyBodyFields", () => {
  it("keeps a field the failing body returns and the succeeding one does not", () => {
    const p = provider("api", [
      transition("t-404", { output: response(404, recordBody("error")) }),
      transition("t-200", { output: response(200, recordBody("link")) }),
    ]);
    expect(failureOnlyBodyFields(p)).toEqual(new Map([[404, new Set(["error"])]]));
  });

  it("drops a field both bodies return", () => {
    const p = provider("api", [
      transition("t-404", { output: response(404, recordBody("message")) }),
      transition("t-200", { output: response(200, recordBody("message")) }),
    ]);
    expect(failureOnlyBodyFields(p)).toEqual(new Map([[404, new Set()]]));
  });

  it("reads every variant when a body is a union of shapes", () => {
    const union: TypeShape = {
      type: "union",
      variants: [recordBody("error"), recordBody("code")],
    };
    const p = provider("api", [
      transition("t-400", { output: response(400, union) }),
      transition("t-200", { output: response(200, recordBody("ok")) }),
    ]);
    expect(failureOnlyBodyFields(p).get(400)).toEqual(
      new Set(["error", "code"]),
    );
  });

  it("says nothing about a provider that only succeeds", () => {
    const p = provider("api", [
      transition("t-200", { output: response(200, recordBody("link")) }),
    ]);
    expect(failureOnlyBodyFields(p).size).toBe(0);
  });
});

describe("bodyFieldsConsumerReads", () => {
  it("collects what a guard tests and what a branch reads", () => {
    const c = consumerReading({
      type: "record",
      properties: { body: { type: "record", properties: { link: unknown } } },
    });
    c.transitions[0] = {
      ...c.transitions[0],
      conditions: [bodyFieldTruthy("error")],
    };
    expect(bodyFieldsConsumerReads(c)).toEqual(new Set(["error", "link"]));
  });

  it("leaves out the accessor the client reaches the body through", () => {
    const c = consumerReading({
      type: "record",
      properties: { body: { type: "record", properties: { body: unknown } } },
    });
    expect(bodyFieldsConsumerReads(c)).toEqual(new Set());
  });
});
