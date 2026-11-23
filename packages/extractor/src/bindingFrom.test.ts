import { describe, expect, it } from "vitest";

import { requestBindingFrom } from "./bindingFrom.js";
import { assembleSummary, paramToInput } from "./index.js";
import { writtenValueRef } from "./valueSources.js";

import type { ValueRef } from "@suss/behavioral-ir";
import type { RawCodeStructure, RawCondition } from "./index.js";
import type { ValueOps } from "./ops.js";

const METHOD = { written: "method" } as unknown as ValueOps;
const URL = { written: "url" } as unknown as ValueOps;

const methodParameter: ValueRef = {
  type: "input",
  inputRef: "method",
  path: [],
};
const urlParameter: ValueRef = { type: "input", inputRef: "url", path: [] };

/** A source walk that looks each value up in a table. */
function sourcesFrom(table: Map<ValueOps, ValueRef[]>) {
  return (values: readonly ValueOps[]) =>
    new Map(values.map((value) => [value, table.get(value) ?? []]));
}

const methodIsGet: RawCondition = {
  sourceText: 'method == "get"',
  structured: {
    type: "comparison",
    left: methodParameter,
    op: "eq",
    right: { type: "literal", value: "get" },
  },
  polarity: "positive",
  source: "explicit",
};

describe("requestBindingFrom", () => {
  it("keeps a method that comes from a parameter, and the host of a URL parameter", () => {
    expect(
      requestBindingFrom(
        { method: METHOD, host: { value: URL, within: "url" } },
        [],
        sourcesFrom(
          new Map([
            [METHOD, [methodParameter]],
            [URL, [urlParameter]],
          ]),
        ),
      ),
    ).toEqual({
      method: [methodParameter],
      host: [
        {
          type: "derived",
          from: urlParameter,
          derivation: { type: "propertyAccess", property: "host" },
        },
      ],
    });
  });

  it("keeps a host given on its own as it came", () => {
    expect(
      requestBindingFrom(
        { host: { value: URL, within: "host" } },
        [],
        sourcesFrom(new Map([[URL, [urlParameter]]])),
      ),
    ).toEqual({ host: [urlParameter] });
  });

  it("records nothing for values written out in the call", () => {
    const written: ValueRef = { type: "literal", value: "POST" };
    expect(
      requestBindingFrom(
        { method: METHOD },
        [],
        sourcesFrom(new Map([[METHOD, [written]]])),
      ),
    ).toBeUndefined();
    expect(requestBindingFrom(undefined, [], sourcesFrom(new Map()))).toBe(
      undefined,
    );
  });

  it("keeps the conditions on the request only when one is about an input", () => {
    const opaque: RawCondition = {
      sourceText: "ready?",
      structured: null,
      polarity: "positive",
      source: "explicit",
    };
    expect(
      requestBindingFrom(undefined, [opaque], sourcesFrom(new Map())),
    ).toBeUndefined();
    expect(
      requestBindingFrom(
        undefined,
        [opaque, methodIsGet],
        sourcesFrom(new Map()),
      ),
    ).toEqual({ when: [opaque, methodIsGet] });
  });
});

describe("writtenValueRef", () => {
  it("is the literal a default settles to, or a hole quoting the default", () => {
    expect(writtenValueRef("get", ":get")).toEqual({
      type: "literal",
      value: "get",
    });
    expect(writtenValueRef(null, "nil")).toEqual({
      type: "literal",
      value: null,
    });
    expect(writtenValueRef(undefined, "Time.now\n  .utc")).toEqual({
      type: "unresolved",
      sourceText: "Time.now .utc",
    });
  });
});

describe("a parameter's default and a binding's sources in a summary", () => {
  it("puts the default on the parameter's input", () => {
    expect(
      paramToInput({
        name: "method",
        position: 1,
        role: "method",
        typeText: null,
        default: { type: "literal", value: "get" },
      }),
    ).toEqual({
      type: "parameter",
      name: "method",
      position: 1,
      role: "method",
      shape: null,
      default: { type: "literal", value: "get" },
    });
  });

  it("writes the conditions in `when` as predicates", () => {
    const raw: RawCodeStructure = {
      identity: {
        name: "fetch",
        kind: "client",
        file: "app/client.rb",
        range: { start: 1, end: 5 },
        exportName: "fetch",
        exportPath: ["fetch"],
      },
      boundaryBinding: null,
      bindingFrom: {
        method: [methodParameter],
        when: [{ ...methodIsGet, polarity: "negative" }],
      },
      parameters: [],
      branches: [],
      dependencyCalls: [],
      declaredContract: null,
    };
    expect(assembleSummary(raw).bindingFrom).toEqual({
      method: [methodParameter],
      when: [{ type: "negation", operand: methodIsGet.structured }],
    });
  });
});
