// Each event kind, in both spellings the framework accepts, and what
// each one abstains on.

import { describe, expect, it } from "vitest";

import { EVENT_TRANSLATIONS } from "./events.js";
import { createVariableResolver } from "./variables.js";

const ctx = {
  resolver: createVariableResolver({
    custom: { basePath: "api" },
  }),
};

function translate(kind: string, raw: unknown) {
  return EVENT_TRANSLATIONS[kind](raw, ctx);
}

describe("httpApi", () => {
  it("reads the string spelling", () => {
    expect(translate("httpApi", "POST /orders")).toEqual({
      kind: "event",
      event: {
        Type: "HttpApi",
        Properties: { Method: "POST", Path: "/orders" },
      },
    });
  });

  it("reads the map spelling and resolves the path", () => {
    expect(
      translate("httpApi", {
        method: "get",
        path: "/${self:custom.basePath}/orders",
      }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "HttpApi",
        Properties: { Method: "GET", Path: "/api/orders" },
      },
    });
  });

  it("abstains when the path is stated at deploy time", () => {
    const translated = translate("httpApi", {
      method: "GET",
      path: "/${env:BASE}/orders",
    });
    expect(translated.kind).toBe("abstained");
  });

  it("abstains on a catch-all with no method and path", () => {
    expect(translate("httpApi", "*").kind).toBe("abstained");
  });

  it("abstains when the event names neither", () => {
    expect(translate("httpApi", { method: "GET" }).kind).toBe("abstained");
    expect(translate("httpApi", ["GET", "/x"]).kind).toBe("abstained");
  });
});

describe("http", () => {
  it("gives a path written without one a leading slash", () => {
    expect(translate("http", "GET users/list")).toEqual({
      kind: "event",
      event: {
        Type: "Api",
        Properties: { Method: "GET", Path: "/users/list" },
      },
    });
  });

  it("reads the map spelling", () => {
    expect(
      translate("http", { method: "delete", path: "/users/{id}" }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "Api",
        Properties: { Method: "DELETE", Path: "/users/{id}" },
      },
    });
  });
});

describe("sqs", () => {
  it("reads a bare ARN", () => {
    expect(
      translate("sqs", "arn:aws:sqs:us-east-1:123456789012:orders"),
    ).toEqual({
      kind: "event",
      event: {
        Type: "SQS",
        Properties: {
          Queue: "arn:aws:sqs:us-east-1:123456789012:orders",
        },
      },
    });
  });

  it("reads an intrinsic under the map spelling", () => {
    expect(
      translate("sqs", { arn: { "Fn::GetAtt": ["OrdersQueue", "Arn"] } }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "SQS",
        Properties: { Queue: { "Fn::GetAtt": ["OrdersQueue", "Arn"] } },
      },
    });
  });

  it("keeps a deploy-time ARN as its reference", () => {
    expect(translate("sqs", "${env:AUDIT_QUEUE_ARN}")).toEqual({
      kind: "event",
      event: { Type: "SQS", Properties: { Queue: "env:AUDIT_QUEUE_ARN" } },
    });
  });

  it("abstains when nothing names a queue", () => {
    expect(translate("sqs", {}).kind).toBe("abstained");
  });
});

describe("sns", () => {
  it("reads a topic name", () => {
    expect(translate("sns", "dispatch")).toEqual({
      kind: "event",
      event: { Type: "SNS", Properties: { Topic: "dispatch" } },
    });
  });

  it("carries a filterPolicy through", () => {
    expect(
      translate("sns", {
        topicName: "dispatch",
        filterPolicy: { kind: ["a"] },
      }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "SNS",
        Properties: { Topic: "dispatch", FilterPolicy: { kind: ["a"] } },
      },
    });
  });

  it("abstains when nothing names a topic", () => {
    expect(translate("sns", {}).kind).toBe("abstained");
  });
});

describe("schedule", () => {
  it("reads the rate string", () => {
    expect(translate("schedule", "rate(1 hour)")).toEqual({
      kind: "event",
      event: { Type: "Schedule", Properties: { Schedule: "rate(1 hour)" } },
    });
  });

  it("reads the first rate of the list spelling", () => {
    expect(
      translate("schedule", { rate: ["cron(0 9 * * ? *)"], enabled: true }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "Schedule",
        Properties: { Schedule: "cron(0 9 * * ? *)", Enabled: true },
      },
    });
  });

  it("carries a rule deployed switched off, which invokes nothing", () => {
    expect(
      translate("schedule", { rate: "rate(1 hour)", enabled: false }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "Schedule",
        Properties: { Schedule: "rate(1 hour)", Enabled: false },
      },
    });
  });

  it("carries an explicitly enabled rule too", () => {
    expect(
      translate("schedule", { rate: "cron(0 9 * * ? *)", enabled: true }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "Schedule",
        Properties: { Schedule: "cron(0 9 * * ? *)", Enabled: true },
      },
    });
  });

  it("says nothing about enablement when the document says nothing", () => {
    const translated = translate("schedule", "rate(1 hour)");
    const properties =
      translated.kind === "event" ? translated.event.Properties : undefined;

    expect(properties).not.toHaveProperty("Enabled");
  });

  it("stays a schedule even when the rate is stated at deploy time", () => {
    // A schedule carries no message, so the rate is not what the
    // boundary is keyed on; the wiring is still declared.
    expect(translate("schedule", { rate: { some: "map" } })).toEqual({
      kind: "event",
      event: { Type: "Schedule", Properties: {} },
    });
  });
});

describe("eventBridge", () => {
  it("reads a pattern and its bus", () => {
    expect(
      translate("eventBridge", {
        eventBus: "orders",
        pattern: { "detail-type": ["order.placed"] },
      }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "EventBridgeRule",
        Properties: {
          Pattern: { "detail-type": ["order.placed"] },
          EventBusName: "orders",
        },
      },
    });
  });

  it("becomes a schedule when that is what it states", () => {
    expect(translate("eventBridge", { schedule: "rate(10 minutes)" })).toEqual({
      kind: "event",
      event: { Type: "Schedule", Properties: { Schedule: "rate(10 minutes)" } },
    });
  });

  it("carries enablement onto the schedule it becomes", () => {
    expect(
      translate("eventBridge", {
        schedule: "rate(10 minutes)",
        enabled: false,
      }),
    ).toEqual({
      kind: "event",
      event: {
        Type: "Schedule",
        Properties: { Schedule: "rate(10 minutes)", Enabled: false },
      },
    });
  });

  it("abstains when it states neither", () => {
    expect(translate("eventBridge", { input: {} }).kind).toBe("abstained");
    expect(translate("eventBridge", "orders").kind).toBe("abstained");
  });
});
