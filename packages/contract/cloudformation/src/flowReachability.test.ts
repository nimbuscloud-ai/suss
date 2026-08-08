// The fixture's question, answered end to end: reader summaries in,
// the generic walk over them with the ALB selector, and the unit that
// serves each URL out. The pathological templates ride along: a cycle
// of balancers terminates, a chain composes through belongsTo, a
// duplicate priority admits nothing outright, a weighted forward
// reaches every target its weights let carry traffic, an unevaluated
// condition leaves targets possible, never unreachable, and two
// unrelated stacks that spell a listener the same way stay two
// listeners.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeFlow } from "@suss/checker";

import { ALB_MATCH_LANGUAGE, albRouterSelector } from "./albMatch.js";
import {
  cloudFormationFileToSummaries,
  cloudFormationToSummaries,
} from "./index.js";

import type { BehavioralSummary, FlowRequest } from "@suss/behavioral-ir";

const SELECTORS = { [ALB_MATCH_LANGUAGE]: albRouterSelector };

const fixture = path.resolve(
  __dirname,
  "../../../../fixtures/aws-alb/template.yaml",
);

function get(pathname: string): FlowRequest {
  return { method: "GET", host: "shop.example.com", path: pathname };
}

/** A rest route summary the way a framework pack would emit one, placed by its file. */
function routeSummary(over: {
  file: string;
  name: string;
  method: string;
  path: string;
}): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: over.file,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: over.name,
      exportPath: null,
      boundaryBinding: {
        transport: "http",
        semantics: { name: "rest", method: over.method, path: over.path },
        recognition: "test",
      },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

describe("the ALB fixture, walked", () => {
  const summaries = [
    ...cloudFormationFileToSummaries(fixture),
    routeSummary({
      file: "src/orders-app/app.ts",
      name: "allOrders",
      method: "*",
      path: "/api/orders/*",
    }),
    routeSummary({
      file: "src/health/index.ts",
      name: "health",
      method: "GET",
      path: "/api/health",
    }),
  ];

  it("resolves /api/orders/123 to the ECS unit and the route that answers there", () => {
    const view = analyzeFlow(summaries, get("/api/orders/123"), SELECTORS).from(
      "ShopHttpsListener",
    );

    expect(view.units).toEqual({
      certain: ["OrdersTaskDefinition/orders-app"],
      possible: [],
    });
    expect(view.nodes.certain).toContain("OrdersTargetGroup");
    expect(view.answers).toEqual({ certain: [], possible: [] });
    expect(view.claims).toEqual({
      certain: ["src/orders-app/app.ts::allOrders"],
      possible: [],
    });
  });

  it("gives the chain hop by hop, with the rule that carried each hop", () => {
    const [chain] = analyzeFlow(
      summaries,
      get("/api/orders/123"),
      SELECTORS,
    ).from("ShopAlb").chains;

    expect(chain.certainty).toBe("certain");
    expect(chain.hops.map((hop) => hop.to)).toEqual([
      "ShopHttpsListener",
      "OrdersTargetGroup",
      "OrdersTaskDefinition/orders-app",
    ]);
    expect(chain.hops[1].match?.matchId).toBe("OrdersListenerRule");
    expect(chain.hops[1].match?.priority).toBe(10);
    expect(chain.end).toEqual({
      type: "serves",
      unit: "OrdersTaskDefinition/orders-app",
      claims: [
        { ref: "src/orders-app/app.ts::allOrders", certainty: "certain" },
      ],
    });
  });

  it("starts a question at the balancer, which is the one way in", () => {
    expect(
      analyzeFlow(summaries, get("/api/orders/123"), SELECTORS).entries(),
    ).toEqual([
      {
        name: "ShopAlb",
        scope: "cloudformation:fixtures/aws-alb/template.yaml",
      },
    ]);
  });

  it("resolves the exact health-check path through the lower priority, same target kind aside", () => {
    const view = analyzeFlow(
      summaries,
      get("/api/orders/_health"),
      SELECTORS,
    ).from("ShopHttpsListener");

    expect(view.units.certain).toEqual(["OrdersTaskDefinition/orders-app"]);
  });

  it("resolves /api/health to the Lambda unit and its route", () => {
    const view = analyzeFlow(summaries, get("/api/health"), SELECTORS).from(
      "ShopHttpsListener",
    );

    expect(view.units).toEqual({ certain: ["HealthFunction"], possible: [] });
    expect(view.claims.certain).toEqual(["src/health/index.ts::health"]);
  });

  it("lands a path no rule admits on the listener's own 404", () => {
    const view = analyzeFlow(summaries, get("/nope"), SELECTORS).from(
      "ShopHttpsListener",
    );

    expect(view.units).toEqual({ certain: [], possible: [] });
    expect(view.answers.possible).toEqual([]);
    expect(view.answers.certain).toEqual([
      {
        matchId: "ShopHttpsListener#default",
        router: "ShopHttpsListener",
        response: {
          type: "fixed-response",
          statusCode: 404,
          contentType: "text/plain",
          body: "not found",
        },
      },
    ]);
  });
});

describe("chained and cyclic balancers", () => {
  function loadBalancer(): Record<string, unknown> {
    return {
      Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
      Properties: {},
    };
  }

  function listener(lb: string, targetGroup: string): Record<string, unknown> {
    return {
      Type: "AWS::ElasticLoadBalancingV2::Listener",
      Properties: {
        LoadBalancerArn: { Ref: lb },
        DefaultActions: [
          { Type: "forward", TargetGroupArn: { Ref: targetGroup } },
        ],
      },
    };
  }

  function albTargetGroup(fronted: string): Record<string, unknown> {
    return {
      Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
      Properties: { TargetType: "alb", Targets: [{ Id: { Ref: fronted } }] },
    };
  }

  it("composes a chain of balancers through belongsTo", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        LbA: loadBalancer(),
        LbB: loadBalancer(),
        LbC: loadBalancer(),
        ListenerA: listener("LbA", "TgA"),
        ListenerB: listener("LbB", "TgB"),
        TgA: albTargetGroup("LbB"),
        TgB: albTargetGroup("LbC"),
      },
    });
    const view = analyzeFlow(summaries, get("/anything"), SELECTORS).from(
      "ListenerA",
    );

    expect(view.nodes.certain).toEqual(
      expect.arrayContaining(["TgA", "LbB", "ListenerB", "TgB", "LbC"]),
    );
    expect(view.nodes.possible).toEqual([]);
  });

  it("terminates on a cycle of balancers and reports the closed loop", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        LbA: loadBalancer(),
        LbB: loadBalancer(),
        ListenerA: listener("LbA", "TgA"),
        ListenerB: listener("LbB", "TgB"),
        TgA: albTargetGroup("LbB"),
        TgB: albTargetGroup("LbA"),
      },
    });
    // Returning at all is the termination proof; the loop closing over
    // its own entry is the walk reporting the cycle as declared.
    const view = analyzeFlow(summaries, get("/anything"), SELECTORS).from(
      "ListenerA",
    );

    expect(view.nodes.certain).toEqual([
      "LbA",
      "LbB",
      "ListenerA",
      "ListenerB",
      "TgA",
      "TgB",
    ]);
  });
});

describe("contested and gated matches", () => {
  it("admits nothing outright when two rules share a priority and both match", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            DefaultActions: [
              {
                Type: "fixed-response",
                FixedResponseConfig: { StatusCode: "404" },
              },
            ],
          },
        },
        RuleA: rule("/x/*", "TgA", 15),
        RuleB: rule("/x/y", "TgB", 15),
        TgA: bareTargetGroup(),
        TgB: bareTargetGroup(),
      },
    });
    const view = analyzeFlow(summaries, get("/x/y"), SELECTORS).from(
      "MyListener",
    );

    expect(view.nodes.certain).toEqual([]);
    expect(view.nodes.possible).toEqual(["TgA", "TgB"]);
    // One of the tied rules takes the request, so the default below
    // them never answers it.
    expect(view.answers).toEqual({ certain: [], possible: [] });
  });

  it("leaves targets possible, never unreachable, under an unevaluated condition", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        GateRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 1,
            Conditions: [
              {
                Field: "path-pattern",
                PathPatternConfig: { Values: ["/x/*"] },
              },
              {
                Field: "http-header",
                HttpHeaderConfig: { Values: ["X-Canary=1"] },
              },
            ],
            Actions: [{ Type: "forward", TargetGroupArn: { Ref: "TgGate" } }],
          },
        },
        MainRule: rule("/x/*", "TgMain", 2),
        TgGate: bareTargetGroup(),
        TgMain: bareTargetGroup(),
      },
    });
    const view = analyzeFlow(summaries, get("/x/y"), SELECTORS).from(
      "MyListener",
    );

    expect(view.nodes.certain).toEqual([]);
    expect(view.nodes.possible).toEqual(["TgGate", "TgMain"]);
  });

  function rule(
    pattern: string,
    targetGroup: string,
    priority: number,
  ): Record<string, unknown> {
    return {
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: priority,
        Conditions: [
          { Field: "path-pattern", PathPatternConfig: { Values: [pattern] } },
        ],
        Actions: [{ Type: "forward", TargetGroupArn: { Ref: targetGroup } }],
      },
    };
  }

  function bareTargetGroup(): Record<string, unknown> {
    return {
      Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
      Properties: { TargetType: "ip" },
    };
  }
});

describe("weighted forwards", () => {
  function weightedTemplate(weights: [number, number]) {
    return {
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        SplitRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 5,
            Conditions: [
              {
                Field: "path-pattern",
                PathPatternConfig: { Values: ["/split"] },
              },
            ],
            Actions: [
              {
                Type: "forward",
                ForwardConfig: {
                  TargetGroups: [
                    { TargetGroupArn: { Ref: "TgA" }, Weight: weights[0] },
                    { TargetGroupArn: { Ref: "TgB" }, Weight: weights[1] },
                  ],
                },
              },
            ],
          },
        },
        TgA: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        TgB: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
      },
    };
  }

  it("reaches every weighted target outright: the split serves them all", () => {
    const summaries = cloudFormationToSummaries(weightedTemplate([70, 30]));
    const view = analyzeFlow(summaries, get("/split"), SELECTORS).from(
      "MyListener",
    );

    expect(view.nodes.certain).toEqual(["TgA", "TgB"]);
  });

  it("never reaches a target the template gives weight 0: declared to carry nothing", () => {
    const summaries = cloudFormationToSummaries(weightedTemplate([100, 0]));
    const view = analyzeFlow(summaries, get("/split"), SELECTORS).from(
      "MyListener",
    );

    expect(view.nodes.certain).toEqual(["TgA"]);
    expect(view.nodes.possible).toEqual([]);
  });
});

describe("two top-level stacks sharing a logical id", () => {
  // The reviewer's probe: a multi-service monorepo where each service's
  // template names its listener HttpListener. The walk must keep them
  // two nodes and answer each stack's question from its own rules only.
  function serviceTemplate(pattern: string, targetGroup: string) {
    return {
      Resources: {
        HttpListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
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
              {
                Field: "path-pattern",
                PathPatternConfig: { Values: [pattern] },
              },
            ],
            Actions: [
              { Type: "forward", TargetGroupArn: { Ref: targetGroup } },
            ],
          },
        },
        [targetGroup]: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
      },
    };
  }

  const combined = [
    ...cloudFormationToSummaries(serviceTemplate("/alpha/*", "TgAlpha"), {
      source: "services/alpha/template.yaml",
    }),
    ...cloudFormationToSummaries(serviceTemplate("/beta/*", "TgBeta"), {
      source: "services/beta/template.yaml",
    }),
  ];

  it("answers each stack's query from its own rules only", () => {
    const analysis = analyzeFlow(combined, get("/alpha/1"), SELECTORS);

    const alpha = analysis.from("HttpListener", "services/alpha/template.yaml");
    expect(alpha.nodes).toEqual({ certain: ["TgAlpha"], possible: [] });
    expect(alpha.answers).toEqual({ certain: [], possible: [] });

    // The same request through the other stack's listener never sees
    // alpha's rules: beta's own rule refuses /alpha/1, so its declared
    // default answers.
    const beta = analysis.from("HttpListener", "services/beta/template.yaml");
    expect(beta.nodes).toEqual({ certain: [], possible: [] });
    expect(beta.answers.certain).toEqual([
      {
        matchId: "HttpListener#default",
        router: "HttpListener",
        response: { type: "fixed-response", statusCode: 404 },
      },
    ]);
  });

  it("refuses the bare listener name both stacks declare", () => {
    const analysis = analyzeFlow(combined, get("/alpha/1"), SELECTORS);

    expect(() => analysis.from("HttpListener")).toThrow(
      /2 documents declare a node named "HttpListener"/,
    );
  });

  it("keeps two template.yaml files in different directories apart, read off disk", () => {
    // Read by basename, both of these were one document and one scope,
    // so either stack's rules could answer the other's question.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-two-stacks-"));
    try {
      const write = (service: string, template: object): string => {
        const dir = path.join(root, "services", service);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "template.yaml");
        fs.writeFileSync(file, JSON.stringify(template));
        return file;
      };
      const summaries = [
        ...cloudFormationFileToSummaries(
          write("alpha", serviceTemplate("/alpha/*", "TgAlpha")),
        ),
        ...cloudFormationFileToSummaries(
          write("beta", serviceTemplate("/beta/*", "TgBeta")),
        ),
      ];
      const analysis = analyzeFlow(summaries, get("/alpha/1"), SELECTORS);

      expect(analysis.scopesOf("HttpListener")).toHaveLength(2);
      expect(() => analysis.from("HttpListener")).toThrow(
        /2 documents declare a node named "HttpListener"/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
