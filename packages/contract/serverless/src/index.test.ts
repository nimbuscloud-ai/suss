import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readMessageBusMetadata,
  readRuntimeContractMetadata,
} from "@suss/behavioral-ir";

import { serverlessFileToSummaries, serverlessToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { UnreadWiring } from "./translate.js";

const fixture = path.resolve(
  __dirname,
  "../../../../fixtures/serverless/serverless.yml",
);

function summariesFromFixture(): BehavioralSummary[] {
  return serverlessFileToSummaries(fixture, { onUnread: () => {} });
}

function restOf(summary: BehavioralSummary) {
  const semantics = summary.identity.boundaryBinding?.semantics;
  return semantics?.name === "rest"
    ? { method: semantics.method, path: semantics.path }
    : null;
}

function channelOf(summary: BehavioralSummary): string | null {
  const semantics = summary.identity.boundaryBinding?.semantics;
  return semantics?.name === "message-bus" ? semantics.channel : null;
}

function named(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const summary = summaries.find((s) => s.identity.name === name);
  if (summary === undefined) {
    throw new Error(
      `no summary named ${name}; got ${summaries.map((s) => s.identity.name).join(", ")}`,
    );
  }

  return summary;
}

describe("the serverless fixture", () => {
  it("finds a deployable unit per function, named as the document writes it", () => {
    const units = summariesFromFixture()
      .map((s) => s.identity.deployableUnit)
      .filter((unit) => unit !== undefined);

    expect(units).toEqual(
      expect.arrayContaining([
        { deploymentTarget: "lambda", instanceName: "createOrder" },
        { deploymentTarget: "lambda", instanceName: "processOrders" },
      ]),
    );
  });

  it("reads the httpApi event as the route it deploys", () => {
    const route = summariesFromFixture().find(
      (s) => restOf(s) !== null,
    ) as BehavioralSummary;

    expect(restOf(route)).toEqual({ method: "POST", path: "/api/orders" });
  });

  it("names the code behind the route", () => {
    const route = summariesFromFixture().find(
      (s) => restOf(s) !== null,
    ) as BehavioralSummary;
    const http = route.metadata?.http as {
      implementingHandler?: { modulePath: string; exportName: string };
    };

    expect(http.implementingHandler).toMatchObject({
      modulePath: "src/handlers/createOrder",
      exportName: "handler",
    });
  });

  it("marks a provider variable as the service-wide default it is", () => {
    const contract = readRuntimeContractMetadata(
      named(summariesFromFixture(), "processOrders"),
    );

    expect(contract?.envVarSources).toMatchObject({
      SERVICE_NAME: "globals",
      ORDERS_TABLE: "globals",
      BATCH_SIZE: "template",
    });
    expect(contract?.runtime).toBe("nodejs20.x");
  });

  it("scopes a function's code to the service directory the framework packages", () => {
    expect(
      named(summariesFromFixture(), "createOrder").metadata?.codeScope,
    ).toEqual({
      kind: "codeUri",
      path: ".",
      entry: "src/handlers/createOrder",
    });
  });

  it("joins the sqs event to the queue the resources block declares", () => {
    const summaries = summariesFromFixture();
    const consumer = named(summaries, "processOrders.sqs0");
    const provider = named(summaries, "OrdersQueue");

    expect(channelOf(consumer)).toBe("OrdersQueue");
    expect(channelOf(provider)).toBe("OrdersQueue");
    expect(consumer.kind).toBe("consumer");
    expect(provider.kind).toBe("library");
  });

  it("keeps a queue named at deploy time as the reference that names it", () => {
    expect(channelOf(named(summariesFromFixture(), "processOrders.sqs1"))).toBe(
      "env:AUDIT_QUEUE_ARN",
    );
  });

  it("resolves what the resources block states and leaves the deploy-time part visible", () => {
    const queue = named(summariesFromFixture(), "OrdersQueue");

    expect(readMessageBusMetadata(queue)?.physicalName).toBe(
      "order-desk-audit-${opt:stage}",
    );
  });

  it("labels the two blocks as one service, the way a nested document is labelled", () => {
    const summaries = summariesFromFixture();

    expect(named(summaries, "processOrders").location.file).toBe(
      "serverless:fixtures/serverless/serverless.yml",
    );
    expect(named(summaries, "OrdersQueue").location.file).toBe(
      "serverless:fixtures/serverless/serverless.yml#resources",
    );
  });

  it("says serverless for what it keys itself and apigateway for the routes", () => {
    const recognitions = new Set(
      summariesFromFixture().map(
        (s) => s.identity.boundaryBinding?.recognition,
      ),
    );

    expect(recognitions).toEqual(new Set(["serverless", "apigateway"]));
  });
});

describe("what the reader does not read", () => {
  function unreadFrom(document: Parameters<typeof serverlessToSummaries>[0]) {
    const unread: UnreadWiring[] = [];
    serverlessToSummaries(document, { onUnread: (w) => unread.push(w) });

    return unread;
  }

  it("names an event kind it does not translate", () => {
    const unread = unreadFrom({
      functions: {
        stream: {
          handler: "src/stream.handler",
          events: [{ kinesis: { arn: "arn:aws:kinesis:::x" } }],
        },
      },
    });

    expect(unread).toEqual([
      {
        functionName: "stream",
        kind: "kinesis",
        reason: "this reader does not translate that event kind yet",
      },
    ]);
  });

  it("says a service loads plugins, which can declare what this document does not", () => {
    const unread = unreadFrom({ plugins: ["serverless-wsgi"], functions: {} });

    expect(unread).toHaveLength(1);
    expect(unread[0].kind).toBe("plugins");
  });

  it("drops a function whose handler the document does not state, and says so", () => {
    const summaries = serverlessToSummaries(
      {
        functions: {
          mystery: { handler: { "Fn::ImportValue": "elsewhere" } },
        },
      },
      { onUnread: () => {} },
    );

    expect(summaries).toEqual([]);
  });

  it("keeps a route whose path the document does state and skips the one it does not", () => {
    const unread: UnreadWiring[] = [];
    const summaries = serverlessToSummaries(
      {
        functions: {
          api: {
            handler: "src/api.handler",
            events: [
              { httpApi: { method: "GET", path: "/health" } },
              { httpApi: { method: "GET", path: "/${env:PREFIX}/x" } },
            ],
          },
        },
      },
      { onUnread: (w) => unread.push(w) },
    );

    expect(summaries.filter((s) => restOf(s) !== null).map(restOf)).toEqual([
      { method: "GET", path: "/health" },
    ]);
    expect(unread).toHaveLength(1);
  });
});

describe("reporting what went unread", () => {
  it("writes a line naming the function, the event kind, and what stopped it", () => {
    const written: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));

      return true;
    }) as typeof process.stderr.write;
    try {
      serverlessToSummaries({
        functions: {
          stream: {
            handler: "src/stream.handler",
            events: [{ kinesis: {} }],
          },
        },
      });
    } finally {
      process.stderr.write = stderr;
    }

    expect(written.join("")).toContain("stream.kinesis");
  });
});

describe("a schedule", () => {
  function scheduleConsumer(enabled?: boolean): BehavioralSummary {
    const summaries = serverlessToSummaries({
      functions: {
        nightly: {
          handler: "src/nightly.handler",
          events: [
            {
              schedule:
                enabled === undefined
                  ? "rate(1 day)"
                  : { rate: "rate(1 day)", enabled },
            },
          ],
        },
      },
    });

    return named(summaries, "nightly.schedule0");
  }

  it("wires the handler to the clock", () => {
    expect(readMessageBusMetadata(scheduleConsumer())?.patternResolution).toBe(
      "schedule",
    );
  });

  it("says a rule deployed switched off, which invokes nothing", () => {
    expect(readMessageBusMetadata(scheduleConsumer(false))?.enabled).toBe(
      false,
    );
  });

  it("says nothing about enablement when the document says nothing", () => {
    expect(readMessageBusMetadata(scheduleConsumer())?.enabled).toBeUndefined();
  });
});

describe("a service file that is a program", () => {
  it("states that it did not run it, and does not take the run down", () => {
    const unread: UnreadWiring[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-serverless-ts-"));
    try {
      fs.writeFileSync(
        path.join(dir, "serverless.ts"),
        "export default { service: 'x' };\n",
      );
      const summaries = serverlessFileToSummaries(dir, {
        onUnread: (w) => unread.push(w),
      });

      expect(summaries).toEqual([]);
      expect(unread).toEqual([
        {
          functionName: null,
          kind: "serverless.ts",
          reason:
            "a program declares this service, and a reader does not run one to find out what it says",
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("prefers a parseable service file when the directory holds both", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-serverless-both-"));
    try {
      fs.writeFileSync(path.join(dir, "serverless.ts"), "export default {};\n");
      fs.writeFileSync(
        path.join(dir, "serverless.yml"),
        "functions:\n  worker:\n    handler: app.handler\n",
      );

      expect(serverlessFileToSummaries(dir)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("reading a service from disk", () => {
  it("finds the service file in a directory", () => {
    const fromDirectory = serverlessFileToSummaries(path.dirname(fixture), {
      onUnread: () => {},
    });

    expect(fromDirectory.length).toBe(summariesFromFixture().length);
  });

  it("refuses a path holding no service file", () => {
    expect(() =>
      serverlessFileToSummaries(path.join(__dirname, "nowhere")),
    ).toThrow(/not found/);
  });
});

describe("a service with no resources block", () => {
  it("reads its functions and declares nothing else", () => {
    const summaries = serverlessToSummaries({
      provider: { runtime: "python3.12" },
      functions: { worker: { handler: "app.handler" } },
    });

    expect(summaries).toHaveLength(1);
    expect(readRuntimeContractMetadata(summaries[0])?.runtime).toBe(
      "python3.12",
    );
  });
});

describe("an eventBridge event", () => {
  it("emits the subject a rule routes and the consumer that drains it", () => {
    const summaries = serverlessToSummaries({
      functions: {
        onPlaced: {
          handler: "src/onPlaced.handler",
          events: [
            {
              eventBridge: {
                eventBus: "orders",
                pattern: { "detail-type": ["order.placed"] },
              },
            },
          ],
        },
      },
    });
    const consumer = named(summaries, "onPlaced#order.placed");

    expect(channelOf(consumer)).toBe("orders#order.placed");
    expect(readMessageBusMetadata(consumer)?.patternResolution).toBe("exact");
  });

  it("says a pattern it cannot reduce rather than guessing a subject", () => {
    const summaries = serverlessToSummaries({
      functions: {
        onAny: {
          handler: "src/onAny.handler",
          events: [{ eventBridge: { pattern: { source: ["orders"] } } }],
        },
      },
    });
    const consumer = summaries.find((s) => s.kind === "consumer");

    expect(readMessageBusMetadata(consumer as BehavioralSummary)).toMatchObject(
      {
        patternResolution: "unresolvable",
      },
    );
  });
});
