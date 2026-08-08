// flow.test.ts: what `suss inspect --flow` answers at the terminal.
//
// The worked example is the ALB fixture: a client asks for
// GET https://shop.example.com/api/orders/123, and the answer has to
// name every hop between the balancer and the handler. The rest of the
// cases are the ones that go wrong in practice: nothing serves the
// request, a hop nobody can settle, and two stacks that spell their
// listener the same way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withRoutingMetadata } from "@suss/behavioral-ir";
import {
  cloudFormationFileToSummaries,
  cloudFormationToSummaries,
} from "@suss/contract-cloudformation";

import { runCli } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

interface CapturedIO {
  stdout: string;
  stderr: string;
}

async function capture(
  args: string[],
): Promise<{ exit: number; io: CapturedIO }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await runCli(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {
    exit,
    io: { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") },
  };
}

const repoRoot = path.resolve(__dirname, "../../..");
const albFixture = path.join(repoRoot, "fixtures/aws-alb/template.yaml");

/** The orders-app route the fixture's Express app declares, as a pack would summarize it. */
const ordersRoute: BehavioralSummary = {
  kind: "handler",
  location: {
    file: "src/orders-app/app.ts",
    range: { start: 1, end: 1 },
    exportName: null,
  },
  identity: {
    name: "allOrders",
    exportPath: null,
    boundaryBinding: {
      transport: "http",
      semantics: { name: "rest", method: "*", path: "/api/orders/*" },
      recognition: "express",
    },
  },
  inputs: [],
  transitions: [],
  gaps: [],
  confidence: { source: "inferred_static", level: "high" },
};

/** One service's stack, with a listener name every service in the repo reuses. */
function serviceTemplate(pattern: string, targetGroup: string): object {
  return {
    Resources: {
      Alb: {
        Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        Properties: {},
      },
      HttpListener: {
        Type: "AWS::ElasticLoadBalancingV2::Listener",
        Properties: {
          LoadBalancerArn: { Ref: "Alb" },
          DefaultActions: [
            {
              Type: "fixed-response",
              FixedResponseConfig: { StatusCode: "404" },
            },
          ],
        },
      },
      ApiRule: {
        Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
        Properties: {
          ListenerArn: { Ref: "HttpListener" },
          Priority: 1,
          Conditions: [
            { Field: "path-pattern", PathPatternConfig: { Values: [pattern] } },
            {
              Field: "http-header",
              HttpHeaderConfig: { Values: ["X-Canary=1"] },
            },
          ],
          Actions: [{ Type: "forward", TargetGroupArn: { Ref: targetGroup } }],
        },
      },
      [targetGroup]: {
        Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
        Properties: { TargetType: "ip" },
      },
    },
  };
}

let dir: string;

function writeSummaries(name: string, summaries: BehavioralSummary[]): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(summaries));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-flow-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("inspect --flow over the ALB fixture", () => {
  beforeEach(() => {
    writeSummaries("infra.json", cloudFormationFileToSummaries(albFixture));
    writeSummaries("app.json", [ordersRoute]);
  });

  it("names every hop from the balancer to the handler that serves it", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET https://shop.example.com/api/orders/123",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("GET https://shop.example.com/api/orders/123");
    expect(io.stdout).toContain("in by ShopAlb");
    expect(io.stdout).toContain(
      "What serves it, as the declarations settle it",
    );
    expect(io.stdout).toContain("-> ShopHttpsListener");
    expect(io.stdout).toContain(
      "-> OrdersTargetGroup   OrdersListenerRule takes it (priority 10; path-pattern /api/orders/*)",
    );
    expect(io.stdout).toContain("OrdersTaskDefinition/orders-app serves it");
    expect(io.stdout).toContain(
      "allOrders answers it: * /api/orders/*   (src/orders-app/app.ts)",
    );
  });

  it("reads one summaries file as happily as a folder", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET https://shop.example.com/api/orders/123",
      path.join(dir, "infra.json"),
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("-> OrdersTargetGroup");
  });

  it("lands a path no rule takes on the listener's own response", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET https://shop.example.com/nope",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("Nothing serves it. What answers it instead");
    expect(io.stdout).toContain(
      'ShopHttpsListener answers it itself: 404 text/plain "not found"',
    );
  });

  it("writes the same answer as JSON when asked", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET https://shop.example.com/api/orders/123",
      "--dir",
      dir,
      "--json",
    ]);
    const answer = JSON.parse(io.stdout) as {
      request: { method: string; path: string };
      entry: { name: string; scope: string };
      chains: { end: { type: string; unit?: string }; certainty: string }[];
    };

    expect(exit).toBe(0);
    expect(answer.request).toEqual({
      method: "GET",
      host: "shop.example.com",
      path: "/api/orders/123",
    });
    expect(answer.entry.name).toBe("ShopAlb");
    expect(answer.chains[0].certainty).toBe("certain");
    expect(answer.chains[0].end).toMatchObject({
      type: "serves",
      unit: "OrdersTaskDefinition/orders-app",
    });
  });
});

describe("what the answer says when it is not settled", () => {
  it("marks a chain gated on a condition nobody evaluated as possible, not certain", async () => {
    writeSummaries(
      "infra.json",
      cloudFormationToSummaries(serviceTemplate("/alpha/*", "TgAlpha"), {
        source: "cloudformation:services/alpha/template.yaml",
      }),
    );
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain(
      "once something the declarations leave open is decided at run time",
    );
    expect(io.stdout).toContain(
      "ApiRule may take it (priority 1; path-pattern /alpha/*; http-header X-Canary=1 (not evaluated here))",
    );
    expect(io.stdout).not.toContain("as the declarations settle it");
  });

  it("says where the walk stopped and what refused, when nothing takes it", async () => {
    // A router with no default action of its own: nothing answers the
    // request, so the useful answer is which of its rules refused.
    writeSummaries("infra.json", [
      {
        kind: "library",
        location: {
          file: "cloudformation:services/alpha/template.yaml",
          range: { start: 1, end: 1 },
          exportName: null,
        },
        identity: { name: "ApiRule", exportPath: null, boundaryBinding: null },
        inputs: [],
        transitions: [],
        gaps: [],
        confidence: { source: "declared", level: "high" },
        metadata: withRoutingMetadata(undefined, {
          edge: "routesTo",
          router: "HttpListener",
          target: "TgAlpha",
          matchId: "ApiRule",
          priority: 7,
          matchLanguage: "alb",
          conditions: [
            { field: "path-pattern", values: ["/alpha/*"], evaluated: true },
          ],
        }),
      },
    ]);
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /nothing/here",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("Nothing below HttpListener takes it");
    expect(io.stdout).toContain("ApiRule (priority 7; path-pattern /alpha/*)");
  });

  it("hedges the line that names what serves it, not only the heading", async () => {
    writeSummaries(
      "infra.json",
      cloudFormationToSummaries(serviceTemplate("/alpha/*", "TgAlpha"), {
        source: "cloudformation:services/alpha/template.yaml",
      }),
    );
    const { io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
    ]);

    // The listener's default is reached only if the gated rule does not
    // take the request, so the line that names the response has to say
    // so on its own.
    expect(io.stdout).toContain("HttpListener may answer it itself: 404");
    expect(io.stdout).not.toContain("HttpListener answers it itself");
  });

  it("says where the trail ended when an admitted rule forwards somewhere nothing resolved", async () => {
    writeSummaries("infra.json", [
      {
        kind: "library",
        location: {
          file: "cloudformation:services/alpha/template.yaml",
          range: { start: 1, end: 1 },
          exportName: null,
        },
        identity: { name: "ApiRule", exportPath: null, boundaryBinding: null },
        inputs: [],
        transitions: [],
        gaps: [],
        confidence: { source: "declared", level: "high" },
        metadata: withRoutingMetadata(undefined, {
          edge: "routesTo",
          router: "HttpListener",
          target: null,
          unresolvedTarget: {
            reference: "OrdersStack.TargetGroupArn",
            reason: "another template declares it",
          },
          matchId: "ApiRule",
          priority: 1,
          matchLanguage: "alb",
          conditions: [
            { field: "path-pattern", values: ["/alpha/*"], evaluated: true },
          ],
        }),
      },
    ]);
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("Where the trail ends");
    expect(io.stdout).toContain(
      "HttpListener sends it on, and suss cannot follow where",
    );
    expect(io.stdout).toContain(
      "ApiRule sends it on to OrdersStack.TargetGroupArn: another template declares it",
    );
    expect(io.stdout).not.toContain("nothing below it is declared");
  });

  it("says how many chains it left out rather than dropping them silently", async () => {
    const targets = Array.from({ length: 60 }, (_, index) => `Tg${index}`);
    writeSummaries(
      "infra.json",
      cloudFormationToSummaries(
        {
          Resources: {
            Alb: {
              Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
              Properties: {},
            },
            HttpListener: {
              Type: "AWS::ElasticLoadBalancingV2::Listener",
              Properties: {
                LoadBalancerArn: { Ref: "Alb" },
                DefaultActions: [
                  {
                    Type: "forward",
                    ForwardConfig: {
                      TargetGroups: targets.map((target) => ({
                        TargetGroupArn: { Ref: target },
                        Weight: 1,
                      })),
                    },
                  },
                ],
              },
            },
            ...Object.fromEntries(
              targets.map((target) => [
                target,
                {
                  Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
                  Properties: { TargetType: "ip" },
                },
              ]),
            ),
          },
        },
        { source: "cloudformation:services/alpha/template.yaml" },
      ),
    );
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("and 10 more chains not shown");
  });

  it("ends where the wiring ends, when a target group fronts nothing declared", async () => {
    writeSummaries(
      "infra.json",
      cloudFormationToSummaries(
        {
          Resources: {
            Alb: {
              Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
              Properties: {},
            },
            HttpListener: {
              Type: "AWS::ElasticLoadBalancingV2::Listener",
              Properties: {
                LoadBalancerArn: { Ref: "Alb" },
                DefaultActions: [
                  {
                    Type: "fixed-response",
                    FixedResponseConfig: { StatusCode: "404" },
                  },
                ],
              },
            },
            ApiRule: {
              Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
              Properties: {
                ListenerArn: { Ref: "HttpListener" },
                Priority: 7,
                Conditions: [
                  {
                    Field: "path-pattern",
                    PathPatternConfig: { Values: ["/alpha/*"] },
                  },
                ],
                Actions: [
                  { Type: "forward", TargetGroupArn: { Ref: "TgAlpha" } },
                ],
              },
            },
            TgAlpha: {
              Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
              Properties: { TargetType: "ip" },
            },
          },
        },
        { source: "cloudformation:services/alpha/template.yaml" },
      ),
    );
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("TgAlpha sends it on, and suss cannot follow");
    expect(io.stdout).toContain(
      "the wiring sends it on: no ECS::Service registers this target group",
    );
  });
});

describe("two documents that spell a node the same way", () => {
  beforeEach(() => {
    writeSummaries(
      "alpha.json",
      cloudFormationToSummaries(serviceTemplate("/alpha/*", "TgAlpha"), {
        source: "cloudformation:services/alpha/template.yaml",
      }),
    );
    writeSummaries(
      "beta.json",
      cloudFormationToSummaries(serviceTemplate("/beta/*", "TgBeta"), {
        source: "cloudformation:services/beta/template.yaml",
      }),
    );
  });

  it("lists the ways in rather than picking one", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(1);
    expect(io.stderr).toContain("2 ways in, so say which one with --entry");
    expect(io.stderr).toContain("cloudformation:services/alpha/template.yaml");
    expect(io.stderr).toContain("cloudformation:services/beta/template.yaml");
  });

  it("says how to pick a document when both declare the entry name", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
      "--entry",
      "HttpListener",
    ]);

    expect(exit).toBe(1);
    expect(io.stderr).toContain('2 documents declare "HttpListener"');
    expect(io.stderr).toContain("Say which one with --scope");
    expect(io.stderr).not.toContain("at Object");
  });

  it("answers one stack's question from that stack's rules only", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
      "--entry",
      "HttpListener",
      "--scope",
      "cloudformation:services/beta/template.yaml",
    ]);

    expect(exit).toBe(0);
    expect(io.stdout).toContain("cloudformation:services/beta/template.yaml");
    expect(io.stdout).not.toContain("TgAlpha");
  });

  it("names the documents that do declare a name it was given the wrong scope for", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /alpha/1",
      "--dir",
      dir,
      "--entry",
      "HttpListener",
      "--scope",
      "cloudformation:services/gamma/template.yaml",
    ]);

    expect(exit).toBe(1);
    expect(io.stderr).toContain(
      'No document called "cloudformation:services/gamma/template.yaml" declares "HttpListener"',
    );
  });
});

describe("questions suss cannot read", () => {
  beforeEach(() => {
    writeSummaries("infra.json", cloudFormationFileToSummaries(albFixture));
  });

  it("asks for a method and a URL when the request is neither", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "who serves orders",
      "--dir",
      dir,
    ]);

    expect(exit).toBe(1);
    expect(io.stderr).toContain("Write the request as a method and a URL");
  });

  it("asks for a file or a folder when it was given neither", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /api/orders/1",
    ]);

    expect(exit).toBe(1);
    expect(io.stderr).toContain("Pass a file or a folder");
  });

  it("asks for the request when --flow is given nothing", async () => {
    const { exit, io } = await capture(["inspect", "--flow", "", "--dir", dir]);

    expect(exit).toBe(1);
    expect(io.stderr).toContain("needs the request to ask about");
  });

  it("names what it can be asked about when the entry is not declared", async () => {
    const { exit, io } = await capture([
      "inspect",
      "--flow",
      "GET /api/orders/1",
      "--dir",
      dir,
      "--entry",
      "NotHere",
    ]);

    expect(exit).toBe(1);
    expect(io.stderr).toContain(
      'Nothing in these summaries is called "NotHere"',
    );
    expect(io.stderr).toContain("ShopAlb");
  });
});
