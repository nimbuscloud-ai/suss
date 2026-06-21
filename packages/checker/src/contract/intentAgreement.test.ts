import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { checkIntentAgreement } from "./intentAgreement.js";

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

const userRecordShape: TypeShape = {
  type: "record",
  properties: {
    id: { type: "text" },
    fullName: { type: "text" },
  },
};

const userRecordShapeDriftingName: TypeShape = {
  type: "record",
  properties: {
    id: { type: "text" },
    name: { type: "text" },
  },
};

const errorRecordShape: TypeShape = {
  type: "record",
  properties: { error: { type: "text" } },
};

function intentSummary(
  args: {
    statuses: Array<{ status: number; body: TypeShape | null }>;
    path?: string;
  } = { statuses: [] },
): BehavioralSummary {
  const path = args.path ?? "/users/:id";
  return {
    kind: "handler",
    location: {
      file: `intent:GET ${path}`,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: `GET ${path} (intent)`,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path,
        recognition: "intent",
      }),
    },
    inputs: [],
    transitions: args.statuses.map((entry, idx) => ({
      id: `intent-${idx}`,
      conditions:
        idx === args.statuses.length - 1
          ? []
          : [
              {
                type: "opaque",
                sourceText: `case ${idx}`,
                reason: "complexExpression",
              },
            ],
      output: {
        type: "response",
        statusCode: { type: "literal", value: entry.status },
        body: entry.body,
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: idx === args.statuses.length - 1,
    })),
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      intent: { purpose: "Look up a user.", audience: "web-client" },
    },
  };
}

function implSummary(
  args: {
    statuses: Array<{ status: number; body: TypeShape | null }>;
    path?: string;
    recognition?: string;
  } = { statuses: [] },
): BehavioralSummary {
  const path = args.path ?? "/users/:id";
  return {
    kind: "handler",
    location: {
      file: "src/users.ts",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: "getUser",
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path,
        recognition: args.recognition ?? "express",
      }),
    },
    inputs: [],
    transitions: args.statuses.map((entry, idx) => ({
      id: `impl-${idx}`,
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: entry.status },
        body: entry.body,
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: idx === args.statuses.length - 1,
    })),
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata: {},
  };
}

describe("checkIntentAgreement", () => {
  it("emits no findings when intent and implementation agree", () => {
    const findings = checkIntentAgreement([
      intentSummary({
        statuses: [
          { status: 404, body: errorRecordShape },
          { status: 200, body: userRecordShape },
        ],
      }),
      implSummary({
        statuses: [
          { status: 404, body: errorRecordShape },
          { status: 200, body: userRecordShape },
        ],
      }),
    ]);
    expect(findings).toEqual([]);
  });

  it("emits intentUnimplemented when intent declares a status the implementation never produces", () => {
    const findings = checkIntentAgreement([
      intentSummary({
        statuses: [
          { status: 410, body: errorRecordShape },
          { status: 200, body: userRecordShape },
        ],
      }),
      implSummary({
        statuses: [{ status: 200, body: userRecordShape }],
      }),
    ]);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("intentUnimplemented");
    const finding = findings.find((f) => f.kind === "intentUnimplemented");
    expect(finding?.description).toMatch(/410/);
    expect(finding?.severity).toBe("error");
  });

  it("emits intentExceeded when the implementation produces a status the intent doesn't declare", () => {
    const findings = checkIntentAgreement([
      intentSummary({ statuses: [{ status: 200, body: userRecordShape }] }),
      implSummary({
        statuses: [
          { status: 500, body: errorRecordShape },
          { status: 200, body: userRecordShape },
        ],
      }),
    ]);
    const finding = findings.find((f) => f.kind === "intentExceeded");
    expect(finding).toBeDefined();
    expect(finding?.description).toMatch(/500/);
    expect(finding?.severity).toBe("error");
  });

  it("emits intentFieldMismatch when shared-status body shapes disagree", () => {
    const findings = checkIntentAgreement([
      intentSummary({ statuses: [{ status: 200, body: userRecordShape }] }),
      implSummary({
        statuses: [{ status: 200, body: userRecordShapeDriftingName }],
      }),
    ]);
    const finding = findings.find((f) => f.kind === "intentFieldMismatch");
    expect(finding).toBeDefined();
    expect(finding?.description).toMatch(/200/);
    expect(finding?.severity).toBe("error");
  });

  it("does nothing when no intent summary exists at the boundary", () => {
    const findings = checkIntentAgreement([
      implSummary({ statuses: [{ status: 200, body: userRecordShape }] }),
    ]);
    expect(findings).toEqual([]);
  });

  it("does nothing when an intent summary has no implementation at its boundary", () => {
    const findings = checkIntentAgreement([
      intentSummary({ statuses: [{ status: 200, body: userRecordShape }] }),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not pair across distinct boundaries", () => {
    const findings = checkIntentAgreement([
      intentSummary({
        path: "/users/:id",
        statuses: [{ status: 200, body: userRecordShape }],
      }),
      implSummary({
        path: "/invoices/:id",
        statuses: [{ status: 200, body: userRecordShape }],
      }),
    ]);
    expect(findings).toEqual([]);
  });
});
