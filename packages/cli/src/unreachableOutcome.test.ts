/**
 * What `inspect --diff` says about an outcome whose test can never pass:
 * that it can no longer happen and why, that it can happen again, or
 * that a new outcome can never happen.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { inspectDiff, whyUnreachable } from "./inspect.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
  TypeShape,
  Unreachable,
} from "@suss/behavioral-ir";

const NOT_ORDER: Predicate = {
  type: "truthinessCheck",
  subject: { type: "dependency", name: "loadOrder", accessChain: [] },
  negated: true,
};

const ALWAYS_AN_OBJECT: Unreachable = {
  condition: 0,
  values: { type: "record", properties: {} },
  every: "truthy",
};

function notFound(unreachable?: Unreachable): Transition {
  return {
    id: "get:response:404:abc",
    conditions: [NOT_ORDER],
    output: {
      type: "response",
      statusCode: { type: "literal", value: 404 },
      body: null,
      headers: {},
    },
    effects: [],
    location: { start: 3, end: 3 },
    isDefault: false,
    ...(unreachable === undefined ? {} : { unreachable }),
  };
}

function route(transitions: Transition[]): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/orders.ts",
      range: { start: 1, end: 10 },
      exportName: "get",
    },
    identity: {
      name: "get",
      exportPath: ["get"],
      boundaryBinding: restBinding({
        transport: "http",
        recognition: "test",
        method: "GET",
        path: "/orders/:id",
      }),
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function diffOf(
  before: BehavioralSummary,
  after: BehavioralSummary,
  json = false,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-unreachable-"));
  const paths = {
    before: path.join(dir, "before.json"),
    after: path.join(dir, "after.json"),
  };
  fs.writeFileSync(paths.before, JSON.stringify([before]));
  fs.writeFileSync(paths.after, JSON.stringify([after]));
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    inspectDiff({ ...paths, json });
  } finally {
    process.stdout.write = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return written.join("");
}

describe("an outcome whose test can never pass", () => {
  it("says it can no longer happen when only that changed", () => {
    const out = diffOf(
      route([notFound()]),
      route([notFound(ALWAYS_AN_OBJECT)]),
    );
    expect(out).toContain("1 boundary changed: 1 outcome.");
    expect(out).toContain(
      "~ responds 404  when  !loadOrder()\n      can no longer happen: loadOrder() is always an empty object, which is truthy",
    );
  });

  it("says it can happen again", () => {
    const out = diffOf(
      route([notFound(ALWAYS_AN_OBJECT)]),
      route([notFound()]),
    );
    expect(out).toContain("can happen again");
    const json = JSON.parse(
      diffOf(route([notFound(ALWAYS_AN_OBJECT)]), route([notFound()]), true),
    ) as { boundaries: { outcomes: { canHappenAgain?: true }[] }[] };
    expect(json.boundaries[0]?.outcomes[0]?.canHappenAgain).toBe(true);
  });

  it("says a new outcome can never happen", () => {
    const out = diffOf(route([]), route([notFound(ALWAYS_AN_OBJECT)]));
    expect(out).toContain(
      "can never happen: loadOrder() is always an empty object, which is truthy",
    );
  });
});

describe("whyUnreachable", () => {
  const because = (values: TypeShape, every: Unreachable["every"] = "falsy") =>
    whyUnreachable(notFound({ condition: 0, values, every }));

  it("words each kind of value", () => {
    expect(because({ type: "null" })).toBe(
      "loadOrder() is always null, which is falsy",
    );
    expect(
      because({
        type: "union",
        variants: [{ type: "null" }, { type: "undefined" }, { type: "null" }],
      }),
    ).toBe("loadOrder() is always null or undefined, which is falsy");
    expect(
      [
        { type: "record", properties: { id: { type: "text" } } },
        { type: "dictionary", values: { type: "text" } },
        { type: "array", items: { type: "number" } },
        { type: "literal", value: "" },
        { type: "text" },
        { type: "integer" },
        { type: "number" },
        { type: "boolean" },
        { type: "ref", name: "Order" },
        { type: "unknown" },
      ].map((values) => because(values as TypeShape, "truthy")),
    ).toEqual([
      "loadOrder() is always an object, which is truthy",
      "loadOrder() is always an object, which is truthy",
      "loadOrder() is always a list, which is truthy",
      'loadOrder() is always "", which is truthy',
      "loadOrder() is always a string, which is truthy",
      "loadOrder() is always a number, which is truthy",
      "loadOrder() is always a number, which is truthy",
      "loadOrder() is always a boolean, which is truthy",
      "loadOrder() is always Order, which is truthy",
      "loadOrder() is always unknown, which is truthy",
    ]);
  });

  it("says nothing for an outcome that can run, and names the condition when it tests no one value", () => {
    expect(whyUnreachable(notFound())).toBeNull();
    expect(
      whyUnreachable({
        ...notFound(ALWAYS_AN_OBJECT),
        conditions: [
          { type: "opaque", sourceText: "x", reason: "complexExpression" },
        ],
      }),
    ).toBe("its condition is always an empty object, which is truthy");
  });
});
