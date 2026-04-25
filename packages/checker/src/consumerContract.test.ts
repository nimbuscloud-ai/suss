import { describe, expect, it } from "vitest";

import {
  consumer,
  provider,
  response,
  statusEq,
  transition,
  withContractBodies,
} from "./__fixtures__/pairs.js";
import { checkConsumerContract } from "./consumerContract.js";

import type { TypeShape } from "@suss/behavioral-ir";

const record = (props: Record<string, TypeShape>): TypeShape => ({
  type: "record",
  properties: props,
});
const text: TypeShape = { type: "text" };
const unknown: TypeShape = { type: "unknown" };

function consumerWithFields(
  name: string,
  statusCode: number,
  _fields: Record<string, TypeShape>,
) {
  return consumer(name, [
    transition("ct", {
      conditions: [statusEq(statusCode)],
      output: { type: "return", value: null },
    }),
  ]);
}

function withExpectedInput(
  summary: ReturnType<typeof consumer>,
  transitionIndex: number,
  fields: Record<string, TypeShape>,
) {
  const updated = { ...summary };
  updated.transitions = summary.transitions.map((t, i) => {
    if (i !== transitionIndex) {
      return t;
    }
    return {
      ...t,
      expectedInput: record({ body: record(fields) }),
    };
  });
  return updated;
}

describe("checkConsumerContract", () => {
  it("emits no findings when consumer fields are all in the declared schema", () => {
    const p = withContractBodies(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [
        {
          statusCode: 200,
          body: record({ id: text, name: text, email: text }),
        },
      ],
    );
    const c = withExpectedInput(consumerWithFields("UserPage", 200, {}), 0, {
      id: unknown,
      name: unknown,
    });

    expect(checkConsumerContract(p, c)).toEqual([]);
  });

  it("emits consumerContractViolation when consumer reads an undeclared field", () => {
    const p = withContractBodies(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [{ statusCode: 200, body: record({ id: text, name: text }) }],
    );
    // Consumer reads `role` which is not in the declared schema
    const c = withExpectedInput(consumerWithFields("UserPage", 200, {}), 0, {
      id: unknown,
      name: unknown,
      role: unknown,
    });

    const findings = checkConsumerContract(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("consumerContractViolation");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].description).toContain("undeclared");
  });

  it("emits no findings when no declared contract exists", () => {
    const p = provider("getUser", [
      transition("t-200", { output: response(200), isDefault: true }),
    ]);
    const c = withExpectedInput(consumerWithFields("UserPage", 200, {}), 0, {
      id: unknown,
      role: unknown,
    });

    expect(checkConsumerContract(p, c)).toEqual([]);
  });

  it("emits no findings when declared response has no body schema", () => {
    const p = withContractBodies(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [{ statusCode: 200, body: null }],
    );
    const c = withExpectedInput(consumerWithFields("UserPage", 200, {}), 0, {
      id: unknown,
    });

    expect(checkConsumerContract(p, c)).toEqual([]);
  });

  it("emits no findings when consumer has no expectedInput", () => {
    const p = withContractBodies(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [{ statusCode: 200, body: record({ id: text }) }],
    );
    const c = consumerWithFields("UserPage", 200, {});

    expect(checkConsumerContract(p, c)).toEqual([]);
  });

  it("checks default consumer branch against 2xx declared statuses", () => {
    const p = withContractBodies(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [{ statusCode: 200, body: record({ id: text, name: text }) }],
    );
    // Default branch reads `role` — not in declared schema
    const c = consumer("UserPage", [
      transition("ct-default", {
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);
    const updated = withExpectedInput(c, 0, { id: unknown, role: unknown });

    const findings = checkConsumerContract(p, updated);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("consumerContractViolation");
  });

  it("emits lowConfidence when declared body is opaque (ref type)", () => {
    const p = withContractBodies(
      provider("getUser", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [{ statusCode: 200, body: { type: "ref", name: "User" } }],
    );
    const c = withExpectedInput(consumerWithFields("UserPage", 200, {}), 0, {
      id: unknown,
    });

    const findings = checkConsumerContract(p, c);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("lowConfidence");
  });

  it("handles declared dictionary body (any field access is valid)", () => {
    const p = withContractBodies(
      provider("getConfig", [
        transition("t-200", { output: response(200), isDefault: true }),
      ]),
      [{ statusCode: 200, body: { type: "dictionary", values: text } }],
    );
    const c = withExpectedInput(consumerWithFields("ConfigPage", 200, {}), 0, {
      anyField: unknown,
      anotherField: unknown,
    });

    expect(checkConsumerContract(p, c)).toEqual([]);
  });
});
