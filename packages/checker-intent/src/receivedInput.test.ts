import { describe, expect, it } from "vitest";

import {
  functionCallBinding,
  messageBusBinding,
  restBinding,
} from "@suss/ir-core";

import { checkIntentAgreement } from "./index.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Input,
} from "@suss/behavioral-ir";
import type { IntentInputField, IntentSummary } from "@suss/intent-ir";

const checkerIntentBinding = functionCallBinding({
  transport: "in-process",
  recognition: "intent",
  package: "@suss/checker",
  exportPath: ["checkPair"],
});
const checkerCodeBinding = functionCallBinding({
  transport: "in-process",
  recognition: "package-exports",
  package: "@suss/checker",
  exportPath: ["checkPair"],
});

function field(path: string[], required = false): IntentInputField {
  return { path, shape: null, required };
}

function intent(
  boundary: BoundaryBinding,
  receives: IntentInputField[],
): IntentSummary {
  return {
    kind: "boundary",
    name: "checker-check-pair",
    purpose: "Run the checks for one summary pair.",
    audience: "downstream-consumers",
    source: "author",
    boundary,
    receives,
    outcomes: [
      {
        id: "findings",
        when: "called with a provider and a consumer",
        conditions: [],
        kind: "return",
        status: null,
        body: null,
        errorType: null,
        effects: [],
      },
    ],
  };
}

function parameter(name: string, role: string | null, position = 0): Input {
  return { type: "parameter", name, position, role, shape: null };
}

function code(opts: {
  boundary: BoundaryBinding;
  inputs: Input[];
  reads?: Array<{ input: string; path: string[] }>;
  name?: string;
  kind?: BehavioralSummary["kind"];
}): BehavioralSummary {
  const name = opts.name ?? "checkPair";
  return {
    kind: opts.kind ?? "library",
    location: {
      file: "src/index.ts",
      range: { start: 1, end: 20 },
      exportName: name,
    },
    identity: { name, exportPath: null, boundaryBinding: opts.boundary },
    inputs: opts.inputs,
    transitions: [
      {
        id: "t0",
        conditions: [],
        output: { type: "return", value: null },
        effects: [],
        location: { start: 1, end: 5 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(opts.reads !== undefined ? { inputReads: opts.reads } : {}),
  };
}

/** Every finding about what the boundary is handed, and nothing else. */
function aboutInput(result: { findings: Array<{ kind: string }> }) {
  return result.findings.filter(
    (f) => f.kind === "unreadInputField" || f.kind === "undeclaredInputRead",
  );
}

describe("a declared field no transition reads", () => {
  it("is a warning when the author said the boundary needs it", () => {
    const result = checkIntentAgreement(
      [
        intent(checkerIntentBinding, [
          field(["provider"], true),
          field(["consumer"], true),
        ]),
      ],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [
            parameter("provider", "provider"),
            parameter("c", "consumer", 1),
          ],
          reads: [{ input: "provider", path: [] }],
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([
      {
        kind: "unreadInputField",
        severity: "warning",
        boundary: "fn:@suss/checker::checkPair",
        intent: { name: "checker-check-pair" },
        code: "src/index.ts::checkPair",
        message:
          'Intent "checker-check-pair" says fn:@suss/checker::checkPair receives consumer and needs it; checkPair never reads it.',
      },
    ]);
  });

  it("is info when the author left it optional", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [field(["provider"]), field(["options"])])],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [
            parameter("provider", "provider"),
            parameter("o", "options", 1),
          ],
          reads: [{ input: "provider", path: [] }],
        }),
      ],
    );
    expect(aboutInput(result).map((f) => [f.kind, f.severity])).toEqual([
      ["unreadInputField", "info"],
    ]);
  });

  it("is satisfied by a read that goes deeper than the declared field", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [field(["provider"], true)])],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [parameter("provider", "provider")],
          reads: [{ input: "provider", path: ["identity", "name"] }],
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([]);
  });

  it("is satisfied by a read of the object the declared field sits in", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [field(["pair", "provider"], true)])],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [parameter("pair", "pair")],
          reads: [{ input: "pair", path: [] }],
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([]);
  });
});

describe("a read the receives block does not list", () => {
  it("is info, and names the path and the unit", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [field(["provider"], true)])],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [
            parameter("provider", "provider"),
            parameter("o", "options", 1),
          ],
          reads: [
            { input: "provider", path: [] },
            { input: "o", path: ["stream"] },
          ],
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([
      {
        kind: "undeclaredInputRead",
        severity: "info",
        boundary: "fn:@suss/checker::checkPair",
        intent: { name: "checker-check-pair" },
        code: "src/index.ts::checkPair",
        message:
          'checkPair reads options.stream off what it was handed at fn:@suss/checker::checkPair; intent "checker-check-pair" does not declare it under receives.',
      },
    ]);
  });

  it("says nothing at all when the doc has no receives block", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [])],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [parameter("o", "options")],
          reads: [{ input: "o", path: ["stream"] }],
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([]);
  });

  it("reports one finding for a path read in more than one place", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [field(["provider"])])],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [
            parameter("provider", "provider"),
            parameter("o", "options", 1),
          ],
          reads: [
            { input: "provider", path: [] },
            { input: "o", path: ["stream"] },
            { input: "o", path: ["stream"] },
          ],
        }),
      ],
    );
    expect(aboutInput(result)).toHaveLength(1);
  });
});

describe("a read set too short to compare against", () => {
  it("reports nothing when a rest parameter could be consuming anything", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [field(["provider"], true)])],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [parameter("args", "rest")],
          reads: [{ input: "args", path: ["0"] }],
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([]);
  });

  it("reports nothing when the unit was handed the payload whole", () => {
    const result = checkIntentAgreement(
      [
        {
          ...intent(
            messageBusBinding({
              recognition: "intent",
              messageBus: "aws_sqs",
              channel: "orders",
            }),
            [field(["orderId"], true)],
          ),
        },
      ],
      [
        code({
          boundary: messageBusBinding({
            recognition: "aws-sqs",
            messageBus: "aws_sqs",
            channel: "orders",
          }),
          inputs: [parameter("event", "event")],
          reads: [{ input: "event", path: [] }],
          name: "handler",
          kind: "worker",
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([]);
  });

  it("reports nothing when the summary recorded no reads at all", () => {
    const result = checkIntentAgreement(
      [intent(checkerIntentBinding, [field(["provider"], true)])],
      [code({ boundary: checkerCodeBinding, inputs: [] })],
    );
    expect(aboutInput(result)).toEqual([]);
  });

  it("reports nothing on a REST boundary, whose sections are not mapped yet", () => {
    const restIntentBinding = restBinding({
      transport: "http",
      method: "GET",
      path: "/invoices",
      recognition: "intent",
    });
    const result = checkIntentAgreement(
      [intent(restIntentBinding, [field(["headers", "x-tenant-id"], true)])],
      [
        code({
          boundary: restBinding({
            transport: "http",
            method: "GET",
            path: "/invoices",
            recognition: "express",
          }),
          inputs: [parameter("req", "request")],
          reads: [{ input: "req", path: ["headers", "x-tenant"] }],
          name: "list",
          kind: "handler",
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([]);
  });
});

describe("a message-bus boundary, read through the envelope", () => {
  const busIntentBinding = messageBusBinding({
    recognition: "intent",
    messageBus: "aws_sqs",
    channel: "orders",
  });
  const busCodeBinding = messageBusBinding({
    recognition: "aws-sqs",
    messageBus: "aws_sqs",
    channel: "orders",
  });

  it("compares a declared body field against what the handler pulled out", () => {
    const result = checkIntentAgreement(
      [
        intent(busIntentBinding, [
          field(["orderId"], true),
          field(["total"], true),
        ]),
      ],
      [
        code({
          boundary: busCodeBinding,
          inputs: [parameter("event", "event")],
          reads: [{ input: "event", path: ["orderId"] }],
          name: "handler",
          kind: "worker",
        }),
      ],
    );
    expect(aboutInput(result).map((f) => [f.kind, f.severity])).toEqual([
      ["unreadInputField", "warning"],
    ]);
  });

  it("reports nothing when the handler was given the platform envelope", () => {
    const result = checkIntentAgreement(
      [intent(busIntentBinding, [field(["orderId"], true)])],
      [
        code({
          boundary: busCodeBinding,
          inputs: [parameter("event", "event")],
          reads: [{ input: "event", path: ["Records", "body"] }],
          name: "handler",
          kind: "worker",
        }),
      ],
    );
    expect(aboutInput(result)).toEqual([]);
  });
});

describe("provenance", () => {
  it("softens a required field on an uncurated draft to info", () => {
    const result = checkIntentAgreement(
      [
        {
          ...intent(checkerIntentBinding, [field(["consumer"], true)]),
          source: "inferred",
        },
      ],
      [
        code({
          boundary: checkerCodeBinding,
          inputs: [parameter("provider", "provider")],
          reads: [{ input: "provider", path: [] }],
        }),
      ],
    );
    expect(aboutInput(result).map((f) => [f.kind, f.severity])).toContainEqual([
      "unreadInputField",
      "info",
    ]);
  });
});
