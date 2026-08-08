// A person asks who serves a request.
//
// The aws-alb fixture is a service with the answer spread across four
// places: a CloudFormation template declaring the load balancer and
// its listener rules, an Express app mounting a router, a middleware
// picking a handler off the sub-path, and a Lambda behind a second
// target group. No single file says who serves
// GET https://shop.example.com/api/orders/123. `inspect --flow` walks
// it, and this journey asserts the chain a person reads back.

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

describe("ask who serves a request", () => {
  const summaries = workspace("flow");

  beforeAll(() => {
    const code = runSuss([
      "extract",
      "-p",
      path.join(fixture("aws-alb"), "tsconfig.json"),
      "-f",
      "express",
      "-f",
      "fetch",
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    const infra = runSuss([
      "contract",
      "--from",
      "cloudformation",
      path.join(fixture("aws-alb"), "template.yaml"),
      "-o",
      path.join(summaries, "infra.json"),
    ]);
    expect(infra.status, infra.stderr).toBe(0);
  });

  it("walks the chain from the load balancer to the code that answers", () => {
    const flow = runSuss([
      "inspect",
      "--flow",
      "GET https://shop.example.com/api/orders/123",
      "--dir",
      summaries,
    ]);

    expect(flow.status, flow.stderr).toBe(0);
    expect(flow.stdout).toContain("in by ShopAlb");
    expect(flow.stdout).toContain("ShopHttpsListener belongs to ShopAlb");
    // The wildcard rule is the one that matches this URL, and the
    // priority and pattern say why.
    expect(flow.stdout).toContain(
      "OrdersListenerRule takes it (priority 10; path-pattern /api/orders/*)",
    );
    expect(flow.stdout).toContain("OrdersTargetGroup fronts it");
    expect(flow.stdout).toContain("OrdersTaskDefinition/orders-app serves it");
    // The Express route that answers it, in the file it lives in.
    expect(flow.stdout).toContain("* /api/orders/*");
    expect(flow.stdout).toContain("src/orders-app/middleware/dispatch.ts");
  });

  it("picks the exact rule over the wildcard for the health path", () => {
    const flow = runSuss([
      "inspect",
      "--flow",
      "GET https://shop.example.com/api/orders/_health",
      "--dir",
      summaries,
    ]);

    expect(flow.status, flow.stderr).toBe(0);
    expect(flow.stdout).toContain("GET /api/orders/_health");
    expect(flow.stdout).toContain("src/orders-app/routes/ordersRouter.ts");
  });

  it("walks a Lambda target group the same way as a container one", () => {
    const flow = runSuss([
      "inspect",
      "--flow",
      "GET https://shop.example.com/api/health",
      "--dir",
      summaries,
    ]);

    expect(flow.status, flow.stderr).toBe(0);
    expect(flow.stdout).toContain(
      "HealthListenerRule takes it (priority 20; path-pattern /api/health)",
    );
    expect(flow.stdout).toContain("HealthTargetGroup fronts it");
    expect(flow.stdout).toContain("HealthFunction");
  });

  // The Lambda side stops one hop short of the ECS side. The template
  // declares the health handler as an AWS::Lambda::Function with a
  // SussCodeScope pointing at src/health, and the flow walk reads that
  // resource type, but @suss/framework-aws-lambda discovers handlers
  // only through AWS::Serverless::Function Events blocks, so no
  // summary is ever produced for the code behind it. The fixture's own
  // README asks for both target kinds to land on a handler.
  it.fails(
    "lands on the Lambda's handler, as it does on the container's",
    () => {
      const flow = runSuss([
        "inspect",
        "--flow",
        "GET https://shop.example.com/api/health",
        "--dir",
        summaries,
      ]);

      expect(flow.stdout).toContain("serves it");
      expect(flow.stdout).not.toContain("Nothing serves it");
    },
  );

  it("says what it needs when the request is left off", () => {
    const flow = runSuss(["inspect", "--flow", "--dir", summaries]);

    // A person who typed --flow and forgot the request in quotes. Node
    // throws a TypeError here, which used to reach them as ten frames
    // of node internals for what is a typo.
    expect(flow.status).toBe(1);
    expect(flow.stderr).toContain("--flow");
    expect(flow.stderr).toContain("Run `suss --help` for the flags.");
    expect(flow.stderr).not.toContain("    at ");
  });

  it("says what it needs when the request is empty", () => {
    const flow = runSuss(["inspect", "--flow", "", "--dir", summaries]);

    expect(flow.status).toBe(1);
    expect(flow.stderr).toContain("needs the request to ask about");
    expect(flow.stderr).not.toContain("    at ");
  });
});
