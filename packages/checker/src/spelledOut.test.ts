// A summary that names its types has to check the same as one that
// spells them out. Otherwise writing a type down once costs a finding.

import { describe, expect, it } from "vitest";

import { checkPair } from "./index.js";
import { summaryWithDefinitionsInlined } from "./spelledOut.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

const USER: TypeShape = {
  type: "record",
  properties: { id: { type: "text" }, email: { type: "text" } },
};

const restBinding = {
  transport: "http" as const,
  semantics: { name: "rest" as const, method: "GET", path: "/users/{id}" },
  recognition: "test",
};

function summary(over: {
  kind: BehavioralSummary["kind"];
  name: string;
  body: TypeShape;
  defs?: Record<string, TypeShape>;
}): BehavioralSummary {
  return {
    kind: over.kind,
    location: {
      file: "src/a.ts",
      range: { start: 1, end: 9 },
      exportName: over.name,
    },
    identity: {
      name: over.name,
      exportPath: [over.name],
      boundaryBinding: restBinding,
    },
    inputs: [],
    transitions: [
      {
        id: "t1",
        conditions: [],
        output: {
          type: "response",
          statusCode: { type: "literal", value: 200 },
          body: over.body,
          headers: {},
        },
        effects: [],
        location: { start: 2, end: 8 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(over.defs === undefined ? {} : { definitions: over.defs }),
  };
}

// The key is what the producer builds out of the type itself, and the
// ref carries it. A name alone would not do: every instantiation of one
// generic reports the same name.
const USER_KEY = "User@abc123def456";
const NAMED: TypeShape = {
  type: "ref",
  name: "User",
  from: "src/models.ts",
  def: USER_KEY,
};
const TABLE = { [USER_KEY]: USER };

describe("a summary that names its types", () => {
  it("spells them out on the way in", () => {
    const named = summary({
      kind: "handler",
      name: "getUser",
      body: NAMED,
      defs: TABLE,
    });

    const spelled = summaryWithDefinitionsInlined(named);
    const body = spelled.transitions[0]?.output;

    expect(body?.type === "response" && body.body).toEqual(USER);
  });

  it("leaves a name nobody wrote down as a name", () => {
    const named = summary({ kind: "handler", name: "getUser", body: NAMED });

    const spelled = summaryWithDefinitionsInlined(named);
    const body = spelled.transitions[0]?.output;

    expect(body?.type === "response" && body.body).toEqual(NAMED);
  });

  it("checks the same as one that spells them out", () => {
    const namedProvider = summary({
      kind: "handler",
      name: "getUser",
      body: NAMED,
      defs: TABLE,
    });
    const spelledProvider = summary({
      kind: "handler",
      name: "getUser",
      body: USER,
    });
    const consumer = summary({ kind: "client", name: "UserPage", body: USER });

    expect(checkPair(namedProvider, consumer).map((f) => f.kind)).toEqual(
      checkPair(spelledProvider, consumer).map((f) => f.kind),
    );
  });

  it("stops rather than following a type that names itself", () => {
    const selfReferring: Record<string, TypeShape> = {
      "Node@feed0000": {
        type: "record",
        properties: {
          id: { type: "text" },
          child: {
            type: "ref",
            name: "Node",
            from: "src/models.ts",
            def: "Node@feed0000",
          },
        },
      },
    };
    const named = summary({
      kind: "handler",
      name: "getNode",
      body: {
        type: "ref",
        name: "Node",
        from: "src/models.ts",
        def: "Node@feed0000",
      },
      defs: selfReferring,
    });

    // Terminates, and the depth it stops at leaves a ref standing.
    const spelled = summaryWithDefinitionsInlined(named);
    expect(JSON.stringify(spelled)).toContain('"ref"');
  });
});
