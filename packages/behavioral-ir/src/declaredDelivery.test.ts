import { describe, expect, it } from "vitest";

import { sameUnit, withDeclaredDelivery } from "./index.js";

import type {
  BehavioralSummary,
  CodeUnitKind,
  ConfidenceSource,
  MessageBusSemantics,
  Semantics,
} from "./index.js";

function summary(opts: {
  name: string;
  kind: CodeUnitKind;
  semantics: Semantics;
  instance?: string;
  source?: ConfidenceSource;
}): BehavioralSummary {
  return {
    kind: opts.kind,
    location: {
      file: `${opts.name}.ts`,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: opts.name,
      exportPath: null,
      boundaryBinding: {
        transport: "aws_sqs",
        semantics: opts.semantics,
        recognition: "test",
      },
      ...(opts.instance === undefined
        ? {}
        : {
            deployableUnit: {
              deploymentTarget: "lambda",
              instanceName: opts.instance,
            },
          }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: opts.source ?? "inferred_static", level: "high" },
  };
}

function bus(
  channel: string | null,
  messageBus: MessageBusSemantics["messageBus"] = "aws_sqs",
): MessageBusSemantics {
  return { name: "message-bus", messageBus, channel };
}

/** A handler the aws-lambda pack discovered under a template entry. */
function handler(semantics: Semantics, instance = "PaidWorkerFunction") {
  return summary({
    name: "PaidWorkerFunction.handler",
    kind: "handler",
    semantics,
    instance,
  });
}

/** The template's own record of what is wired to that function. */
function declaration(semantics: Semantics, instance = "PaidWorkerFunction") {
  return summary({
    name: "PaidWorkerFunction.FromPaid",
    kind: "consumer",
    semantics,
    instance,
    source: "declared",
  });
}

const channelOf = (one: BehavioralSummary): string | null | undefined => {
  const semantics = one.identity.boundaryBinding?.semantics;
  return semantics?.name === "message-bus" ? semantics.channel : undefined;
};

describe("withDeclaredDelivery", () => {
  it("gives the handler the queue the template says reaches it", () => {
    const filled = withDeclaredDelivery([
      handler(bus(null)),
      declaration(bus("PaidQueue")),
    ]);

    expect(filled.map(channelOf)).toEqual(["PaidQueue", "PaidQueue"]);
  });

  it("leaves the subject a consumer stated for itself", () => {
    const filled = withDeclaredDelivery([
      handler(bus("billing.invoicePaid")),
      declaration(bus("PaidQueue")),
    ]);

    expect(channelOf(filled[0])).toBe("billing.invoicePaid");
  });

  it("says nothing when two queues feed one function", () => {
    const filled = withDeclaredDelivery([
      handler(bus(null)),
      declaration(bus("PaidQueue")),
      declaration(bus("RetryQueue")),
    ]);

    expect(channelOf(filled[0])).toBeNull();
  });

  it("takes nothing from a declaration about a different bus", () => {
    const filled = withDeclaredDelivery([
      handler(bus(null, "eventbridge")),
      declaration(bus("PaidQueue")),
    ]);

    expect(channelOf(filled[0])).toBeNull();
  });

  it("takes nothing from a declaration about another protocol", () => {
    const filled = withDeclaredDelivery([
      handler(bus(null)),
      declaration({
        name: "rest",
        method: "POST",
        path: "/invoices",
      }),
    ]);

    expect(channelOf(filled[0])).toBeNull();
  });

  it("leaves a handler alone when nothing says where it runs", () => {
    const stray = summary({
      name: "handler",
      kind: "handler",
      semantics: bus(null),
    });

    expect(
      channelOf(withDeclaredDelivery([stray, declaration(bus("Q"))])[0]),
    ).toBeNull();
  });

  it("hands back what it was given when nothing was declared", () => {
    const alone = [handler(bus(null))];

    expect(withDeclaredDelivery(alone)).toEqual(alone);
  });

  it("takes nothing from a declaration with a blank of its own", () => {
    const filled = withDeclaredDelivery([
      handler(bus(null)),
      declaration(bus(null)),
    ]);

    expect(channelOf(filled[0])).toBeNull();
  });

  it("stays out of it once two declarations have disagreed", () => {
    const filled = withDeclaredDelivery([
      handler(bus(null)),
      declaration(bus("PaidQueue")),
      declaration(bus("RetryQueue")),
      declaration(bus("PaidQueue")),
    ]);

    expect(channelOf(filled[0])).toBeNull();
  });

  it("takes nothing from code that happens to be a consumer", () => {
    const inCode = summary({
      name: "queue.consumer",
      kind: "consumer",
      semantics: bus("PaidQueue"),
      instance: "PaidWorkerFunction",
    });

    expect(
      channelOf(withDeclaredDelivery([handler(bus(null)), inCode])[0]),
    ).toBeNull();
  });
});

describe("sameUnit", () => {
  const worker = { deploymentTarget: "lambda", instanceName: "Paid" } as const;

  it("agrees when the target and the instance both do", () => {
    expect(sameUnit(worker, { ...worker })).toBe(true);
  });

  it("tells two instances on one target apart", () => {
    expect(sameUnit(worker, { ...worker, instanceName: "Voided" })).toBe(false);
  });

  it("tells one instance name on two targets apart", () => {
    expect(sameUnit(worker, { ...worker, deploymentTarget: "container" })).toBe(
      false,
    );
  });
});
