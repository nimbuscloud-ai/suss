// What the reader answers for the ALB fixture: the compute units, and
// now the routing chain in front of them, listener rules and the
// listener's own default action as routesTo / answers edges with their
// match recorded as data, target groups as fronts edges naming what
// backs them. The second test below used to pin the routing's absence;
// it is promoted here to assert the paths it now finds.
//
// The rest of this file pins the reader against the pathological
// shapes the fixture does not exercise: an unresolvable forward
// target, a weighted forward, conditions with nothing to say, two
// rules sharing one priority, a target group fronting nothing, and a
// target group fronting another load balancer, chained and cyclic.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { readRoutingMetadata } from "@suss/behavioral-ir";

import {
  cloudFormationFileToSummaries,
  cloudFormationToSummaries,
} from "./index.js";

import type { BehavioralSummary, RoutingMetadata } from "@suss/behavioral-ir";

const fixture = path.resolve(
  __dirname,
  "../../../../fixtures/aws-alb/template.yaml",
);

function summariesFromFixture(): BehavioralSummary[] {
  return cloudFormationFileToSummaries(fixture);
}

interface RoutingEntry {
  summary: BehavioralSummary;
  routing: RoutingMetadata;
}

function routingEntries(summaries: BehavioralSummary[]): RoutingEntry[] {
  const entries: RoutingEntry[] = [];
  for (const summary of summaries) {
    const routing = readRoutingMetadata(summary);
    if (routing !== undefined) {
      entries.push({ summary, routing });
    }
  }
  return entries;
}

function edgesOf(
  summaries: BehavioralSummary[],
  edge: RoutingMetadata["edge"],
): RoutingEntry[] {
  return routingEntries(summaries).filter(
    (entry) => entry.routing.edge === edge,
  );
}

describe("the ALB flow template", () => {
  it("finds the compute unit behind each target group", () => {
    const units = summariesFromFixture().map((s) => ({
      instanceName: s.identity.deployableUnit?.instanceName,
      deploymentTarget: s.identity.deployableUnit?.deploymentTarget,
      codeScope: s.metadata?.codeScope,
    }));

    expect(units).toEqual(
      expect.arrayContaining([
        {
          instanceName: "OrdersTaskDefinition/orders-app",
          deploymentTarget: "ecs-task",
          codeScope: { kind: "codeUri", path: "src/orders-app" },
        },
        {
          instanceName: "HealthFunction",
          deploymentTarget: "lambda",
          codeScope: { kind: "codeUri", path: "src/health" },
        },
      ]),
    );
  });

  it("says which unit serves each listener path", () => {
    // The listener rules route /api/orders/* to the ECS service and
    // /api/health to the Lambda, and now a routesTo edge carries each
    // path as match data. This is the gap the fixture existed to close.
    const everything = JSON.stringify(summariesFromFixture());

    expect(everything).toContain("/api/orders");
    expect(everything).toContain("/api/health");
  });

  it("emits a routesTo edge per listener rule, with its match and priority", () => {
    const summaries = summariesFromFixture();
    const routesTo = edgesOf(summaries, "routesTo");
    expect(routesTo).toHaveLength(4);

    const byName = new Map(
      routesTo.map((entry) => [entry.summary.identity.name, entry.routing]),
    );

    expect(byName.get("OrdersHealthRule")).toMatchObject({
      router: "ShopHttpsListener",
      target: "OrdersTargetGroup",
      matchId: "OrdersHealthRule",
      priority: 9,
      conditions: [
        {
          field: "path-pattern",
          values: ["/api/orders/_health"],
          evaluated: true,
        },
      ],
    });
    expect(byName.get("OrdersListenerRule")).toMatchObject({
      router: "ShopHttpsListener",
      target: "OrdersTargetGroup",
      matchId: "OrdersListenerRule",
      priority: 10,
      conditions: [
        { field: "path-pattern", values: ["/api/orders/*"], evaluated: true },
      ],
    });
    expect(byName.get("HealthListenerRule")).toMatchObject({
      router: "ShopHttpsListener",
      target: "HealthTargetGroup",
      matchId: "HealthListenerRule",
      priority: 20,
      conditions: [
        { field: "path-pattern", values: ["/api/health"], evaluated: true },
      ],
    });
    expect(byName.get("HealthPrefixRule")).toMatchObject({
      router: "ShopHttpsListener",
      target: "HealthTargetGroup",
      matchId: "HealthPrefixRule",
      priority: 21,
      conditions: [
        { field: "path-pattern", values: ["/api/health/*"], evaluated: true },
      ],
    });
  });

  it("emits an answers edge for the listener's fixed-response default", () => {
    const summaries = summariesFromFixture();
    const answers = edgesOf(summaries, "answers");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.routing).toMatchObject({
      router: "ShopHttpsListener",
      matchId: "ShopHttpsListener#default",
      response: {
        type: "fixed-response",
        statusCode: 404,
        contentType: "text/plain",
        body: "not found",
      },
    });
  });

  it("fronts each target group with the resource behind it", () => {
    const summaries = summariesFromFixture();
    const fronts = edgesOf(summaries, "fronts");
    expect(fronts).toHaveLength(2);
    const byTarget = new Map(
      fronts.map((entry) => [entry.routing.target, entry.routing]),
    );

    expect(byTarget.get("OrdersTargetGroup")).toMatchObject({
      resource: "OrdersTaskDefinition/orders-app",
    });
    expect(byTarget.get("HealthTargetGroup")).toMatchObject({
      resource: "HealthFunction",
    });
  });
});

describe("routesTo: unresolvable and malformed shapes", () => {
  function withListenerAndRule(rule: Record<string, unknown>) {
    return cloudFormationToSummaries({
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
        MyRule: rule,
      },
    });
  }

  it("records a forward to a target group nothing declares, rather than dropping the rule", () => {
    const summaries = withListenerAndRule({
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: 1,
        Conditions: [
          { Field: "path-pattern", PathPatternConfig: { Values: ["/x"] } },
        ],
        Actions: [{ Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } }],
      },
    });
    const routesTo = edgesOf(summaries, "routesTo");
    expect(routesTo).toHaveLength(1);
    expect(routesTo[0]?.routing.target).toBeNull();
    expect(routesTo[0]?.routing.unresolvedTarget).toMatchObject({
      reference: "NoSuchGroup",
      reason: expect.stringContaining("no resource named NoSuchGroup"),
    });
  });

  it("emits one routesTo row per target group in a weighted forward, sharing the matchId", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        TgA: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        TgB: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        WeightedRule: {
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
                    { TargetGroupArn: { Ref: "TgA" }, Weight: 70 },
                    { TargetGroupArn: { Ref: "TgB" }, Weight: 30 },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo").filter(
      (entry) => entry.routing.matchId === "WeightedRule",
    );
    expect(routesTo).toHaveLength(2);
    expect(
      routesTo.every((entry) => entry.routing.matchId === "WeightedRule"),
    ).toBe(true);
    const byTarget = new Map(
      routesTo.map((entry) => [entry.routing.target, entry.routing]),
    );
    expect(byTarget.get("TgA")?.weight).toBe(70);
    expect(byTarget.get("TgB")?.weight).toBe(30);
  });

  it("records a rule with no conditions as an empty match, not a guess", () => {
    const summaries = withListenerAndRule({
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: 2,
        Actions: [{ Type: "fixed-response", FixedResponseConfig: {} }],
      },
    });
    // The rule's action is non-forward, so it lands as an answers edge;
    // conditions live on that same match record either way. Cover the
    // no-Conditions case directly through the routesTo path instead,
    // since that is what the fixture's rules exercise.
    const summariesWithForward = withListenerAndRule({
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: 2,
        Actions: [{ Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } }],
      },
    });
    const ruleAnswer = edgesOf(summaries, "answers").find(
      (entry) => entry.summary.identity.name === "MyRule",
    );
    expect(ruleAnswer?.routing.matchId).toBe("MyRule");
    expect(
      edgesOf(summariesWithForward, "routesTo")[0]?.routing.conditions,
    ).toEqual([]);
  });

  it("reads a host-header-only condition as evaluated", () => {
    const summaries = withListenerAndRule({
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: 3,
        Conditions: [
          {
            Field: "host-header",
            HostHeaderConfig: { Values: ["shop.example.com"] },
          },
        ],
        Actions: [{ Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } }],
      },
    });
    expect(edgesOf(summaries, "routesTo")[0]?.routing.conditions).toEqual([
      { field: "host-header", values: ["shop.example.com"], evaluated: true },
    ]);
  });

  it("carries an unsupported condition field as data, marked unevaluated", () => {
    const summaries = withListenerAndRule({
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: 4,
        Conditions: [
          {
            Field: "http-request-method",
            HttpRequestMethodConfig: { Values: ["POST"] },
          },
        ],
        Actions: [{ Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } }],
      },
    });
    expect(edgesOf(summaries, "routesTo")[0]?.routing.conditions).toEqual([
      { field: "http-request-method", values: ["POST"], evaluated: false },
    ]);
  });

  it("records a condition with no readable Field as unevaluated with a null field", () => {
    const summaries = withListenerAndRule({
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: 6,
        Conditions: [{ Values: ["/mystery"] }],
        Actions: [{ Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } }],
      },
    });
    expect(edgesOf(summaries, "routesTo")[0]?.routing.conditions).toEqual([
      { field: null, values: ["/mystery"], evaluated: false },
    ]);
  });

  it("records a path-pattern condition with no readable values as empty, never admitting", () => {
    const summaries = withListenerAndRule({
      Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
      Properties: {
        ListenerArn: { Ref: "MyListener" },
        Priority: 7,
        Conditions: [{ Field: "path-pattern" }],
        Actions: [{ Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } }],
      },
    });
    expect(edgesOf(summaries, "routesTo")[0]?.routing.conditions).toEqual([
      { field: "path-pattern", values: [], evaluated: true },
    ]);
  });

  it("records two rules sharing one priority, never dropping or merging either", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        RuleA: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 15,
            Conditions: [
              {
                Field: "path-pattern",
                PathPatternConfig: { Values: ["/a"] },
              },
            ],
            Actions: [
              { Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } },
            ],
          },
        },
        RuleB: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 15,
            Conditions: [
              {
                Field: "path-pattern",
                PathPatternConfig: { Values: ["/b"] },
              },
            ],
            Actions: [
              { Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } },
            ],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo");
    expect(routesTo).toHaveLength(2);
    expect(routesTo.every((entry) => entry.routing.priority === 15)).toBe(true);
    expect(routesTo.map((entry) => entry.summary.identity.name).sort()).toEqual(
      ["RuleA", "RuleB"],
    );
  });
});

describe("fronts: unresolvable and chained shapes", () => {
  it("records a target group fronting nothing, per the unresolvable convention", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        LonelyTargetGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
      },
    });
    const fronts = edgesOf(summaries, "fronts");
    expect(fronts).toHaveLength(1);
    expect(fronts[0]?.routing.resource).toBeNull();
    expect(fronts[0]?.routing.unresolvedResource).toMatchObject({
      reference: "LonelyTargetGroup",
      reason: "no ECS::Service registers this target group",
    });
  });

  it("reads a chain of NLB-fronting-ALB target groups as one hop per fact, without collapsing it", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        LbA: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {},
        },
        LbB: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {},
        },
        LbC: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {},
        },
        TgA: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "alb", Targets: [{ Id: { Ref: "LbB" } }] },
        },
        TgB: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "alb", Targets: [{ Id: { Ref: "LbC" } }] },
        },
      },
    });
    const fronts = edgesOf(summaries, "fronts");
    const byTarget = new Map(
      fronts.map((entry) => [entry.routing.target, entry.routing]),
    );
    expect(byTarget.get("TgA")).toMatchObject({ resource: "LbB" });
    expect(byTarget.get("TgB")).toMatchObject({ resource: "LbC" });
  });

  it("terminates on a cyclic pair of NLB target groups, recording both edges", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        LbA: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {},
        },
        LbB: {
          Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
          Properties: {},
        },
        TgA: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "alb", Targets: [{ Id: { Ref: "LbB" } }] },
        },
        TgB: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "alb", Targets: [{ Id: { Ref: "LbA" } }] },
        },
      },
    });
    // Reaching this assertion at all is the proof the reader
    // terminated rather than hanging on the cycle.
    const fronts = edgesOf(summaries, "fronts");
    const byTarget = new Map(
      fronts.map((entry) => [entry.routing.target, entry.routing]),
    );
    expect(byTarget.get("TgA")).toMatchObject({ resource: "LbB" });
    expect(byTarget.get("TgB")).toMatchObject({ resource: "LbA" });
  });

  it("qualifies a fronts edge's resource by the stack path, matching the runtime-config summary it names", () => {
    const template = {
      Resources: {
        OrdersTargetGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        OrdersCluster: { Type: "AWS::ECS::Cluster" },
        OrdersTaskDefinition: {
          Type: "AWS::ECS::TaskDefinition",
          Metadata: { SussCodeScope: "src/orders-app" },
          Properties: {
            ContainerDefinitions: [{ Name: "orders-app" }],
          },
        },
        OrdersService: {
          Type: "AWS::ECS::Service",
          Properties: {
            Cluster: { Ref: "OrdersCluster" },
            TaskDefinition: { Ref: "OrdersTaskDefinition" },
            LoadBalancers: [
              {
                ContainerName: "orders-app",
                ContainerPort: 3000,
                TargetGroupArn: { Ref: "OrdersTargetGroup" },
              },
            ],
          },
        },
      },
    };
    const summaries = cloudFormationToSummaries(template, {
      stackPath: ["OrdersStack"],
    });
    const fronts = edgesOf(summaries, "fronts").find(
      (entry) => entry.routing.target === "OrdersTargetGroup",
    );
    expect(fronts?.routing.resource).toBe(
      "OrdersStack/OrdersTaskDefinition/orders-app",
    );
    const unit = summaries.find(
      (s) =>
        s.identity.deployableUnit?.instanceName ===
        "OrdersStack/OrdersTaskDefinition/orders-app",
    );
    expect(unit).toBeDefined();
  });

  it("leaves a fronted load balancer bare under a stack path, matching router and target", () => {
    // An NLB target group fronting an ALB inside a child stack: the
    // fronted resource is ALB infrastructure, and every other edge
    // names the balancer by its bare logical id, so this one does too.
    const summaries = cloudFormationToSummaries(
      {
        Resources: {
          InnerAlb: {
            Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
            Properties: {},
          },
          NlbTargetGroup: {
            Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
            Properties: {
              TargetType: "alb",
              Targets: [{ Id: { Ref: "InnerAlb" } }],
            },
          },
          InnerListener: {
            Type: "AWS::ElasticLoadBalancingV2::Listener",
            Properties: { DefaultActions: [{ Type: "fixed-response" }] },
          },
          LonelyTargetGroup: {
            Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
            Properties: { TargetType: "ip" },
          },
        },
      },
      { stackPath: ["EdgeStack"] },
    );
    const fronts = edgesOf(summaries, "fronts");
    const byTarget = new Map(
      fronts.map((entry) => [entry.routing.target, entry.routing]),
    );
    expect(byTarget.get("NlbTargetGroup")?.resource).toBe("InnerAlb");

    // The stack path leaves the rest of the routing rows alone too: an
    // answers row and an unresolved fronts row have no unit to qualify.
    const answers = edgesOf(summaries, "answers");
    expect(answers[0]?.routing.router).toBe("InnerListener");
    expect(byTarget.get("LonelyTargetGroup")?.resource).toBeNull();
  });
});

describe("answers: response shapes", () => {
  it("records a rule-based answers row with its priority and conditions, a listener default with neither", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        AdminBlockRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 5,
            Conditions: [
              {
                Field: "path-pattern",
                PathPatternConfig: { Values: ["/admin/*"] },
              },
            ],
            Actions: [
              {
                Type: "fixed-response",
                FixedResponseConfig: { StatusCode: "403" },
              },
            ],
          },
        },
      },
    });
    const answers = edgesOf(summaries, "answers");

    // The rule's own match data rides on its answers row, so a gated
    // 403 is distinguishable from the listener's unconditional default.
    const ruleRow = answers.find(
      (entry) => entry.summary.identity.name === "AdminBlockRule",
    );
    expect(ruleRow?.routing).toMatchObject({
      matchId: "AdminBlockRule",
      priority: 5,
      conditions: [
        { field: "path-pattern", values: ["/admin/*"], evaluated: true },
      ],
      response: { type: "fixed-response", statusCode: 403 },
    });

    const defaultRow = answers.find(
      (entry) => entry.routing.matchId === "MyListener#default",
    );
    expect(defaultRow?.routing.priority).toBeUndefined();
    expect(defaultRow?.routing.conditions).toEqual([]);
  });

  it("reads past an authenticate action to the fixed-response that answers", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        AuthGatedListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            DefaultActions: [
              {
                Type: "authenticate-oidc",
                AuthenticateOidcConfig: {
                  Issuer: "https://issuer.example.com",
                },
              },
              {
                Type: "fixed-response",
                FixedResponseConfig: { StatusCode: "403" },
              },
            ],
          },
        },
      },
    });
    const answers = edgesOf(summaries, "answers");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.routing.response).toMatchObject({
      type: "fixed-response",
      statusCode: 403,
    });
  });

  it("falls back to an authenticate action's own type when nothing follows it", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        AuthOnlyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            DefaultActions: [{ Type: "authenticate-cognito" }],
          },
        },
      },
    });
    const answers = edgesOf(summaries, "answers");
    expect(answers[0]?.routing.response).toEqual({
      type: "authenticate-cognito",
    });
  });

  it("reads a malformed entry after an authenticate action as the null-typed response", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MalformedListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            DefaultActions: [{ Type: "authenticate-cognito" }, "garbage"],
          },
        },
      },
    });
    const answers = edgesOf(summaries, "answers");
    expect(answers[0]?.routing.response).toEqual({ type: null });
  });

  it("records a listener default naming no action at all as the null-typed response", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        BareListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {},
        },
      },
    });
    const answers = edgesOf(summaries, "answers");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.routing.response).toEqual({ type: null });
  });

  it("records a non-fixed-response action by its own type, with no fixed-response fields", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        RedirectListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            DefaultActions: [
              {
                Type: "redirect",
                RedirectConfig: {
                  StatusCode: "HTTP_302",
                  Host: "other.example.com",
                },
              },
            ],
          },
        },
      },
    });
    const answers = edgesOf(summaries, "answers");
    expect(answers[0]?.routing.response).toEqual({ type: "redirect" });
  });

  it("reads a numeric FixedResponseConfig.StatusCode the same as the string form", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        NumericStatusListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: {
            DefaultActions: [
              {
                Type: "fixed-response",
                FixedResponseConfig: { StatusCode: 503 },
              },
            ],
          },
        },
      },
    });
    const answers = edgesOf(summaries, "answers");
    expect(answers[0]?.routing.response).toMatchObject({ statusCode: 503 });
  });

  it("a forward action naming no target group at all still produces one routesTo row", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        BareForwardRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 8,
            Conditions: [
              { Field: "path-pattern", PathPatternConfig: { Values: ["/x"] } },
            ],
            Actions: [{ Type: "forward" }],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo").find(
      (entry) => entry.summary.identity.name === "BareForwardRule",
    );
    expect(routesTo?.routing.target).toBeNull();
    expect(routesTo?.routing.unresolvedTarget?.reason).toBe(
      "a forward action named no target group",
    );
  });

  it("a weighted forward whose ForwardConfig names no TargetGroups list also produces the unresolved row", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        EmptyForwardConfigRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 8,
            Conditions: [
              { Field: "path-pattern", PathPatternConfig: { Values: ["/x"] } },
            ],
            Actions: [{ Type: "forward", ForwardConfig: {} }],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo").find(
      (entry) => entry.summary.identity.name === "EmptyForwardConfigRule",
    );
    expect(routesTo?.routing.target).toBeNull();
  });

  it("reads a string priority the same as a numeric one, and a missing priority as absent", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        StringPriorityRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: "9",
            Conditions: [
              { Field: "path-pattern", PathPatternConfig: { Values: ["/x"] } },
            ],
            Actions: [
              { Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } },
            ],
          },
        },
        NoPriorityRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Conditions: [
              { Field: "path-pattern", PathPatternConfig: { Values: ["/y"] } },
            ],
            Actions: [
              { Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } },
            ],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo");
    expect(
      routesTo.find(
        (entry) => entry.summary.identity.name === "StringPriorityRule",
      )?.routing.priority,
    ).toBe(9);
    expect(
      routesTo.find((entry) => entry.summary.identity.name === "NoPriorityRule")
        ?.routing.priority,
    ).toBeUndefined();
  });

  it("flattens a query-string condition's Key/Value pairs, with and without a Key", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        QueryStringRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 11,
            Conditions: [
              {
                Field: "query-string",
                QueryStringConfig: {
                  Values: [
                    { Key: "sort", Value: "asc" },
                    { Value: "debug" },
                    { Key: "empty" },
                    null,
                  ],
                },
              },
            ],
            Actions: [
              { Type: "forward", TargetGroupArn: { Ref: "NoSuchGroup" } },
            ],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo")[0];
    // The third pair names a Key but no Value at all, so it drops
    // rather than inventing one, the same way a condition with nothing
    // readable drops.
    expect(routesTo?.routing.conditions).toEqual([
      {
        field: "query-string",
        values: ["sort=asc", "debug"],
        evaluated: false,
      },
    ]);
  });

  it("resolves a rule with no Properties at all without crashing", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        BareRule: { Type: "AWS::ElasticLoadBalancingV2::ListenerRule" },
      },
    });
    const answers = edgesOf(summaries, "answers").find(
      (entry) => entry.summary.identity.name === "BareRule",
    );
    expect(answers?.routing.router).toBeNull();
  });
});

describe("fronts: the ECS search's own branches", () => {
  it("records an unresolvable lambda target group that names no target", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        EmptyLambdaGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "lambda", Targets: [] },
        },
      },
    });
    const fronts = edgesOf(summaries, "fronts")[0];
    expect(fronts?.routing.resource).toBeNull();
    expect(fronts?.routing.unresolvedResource?.reason).toBe(
      "a lambda target group named no target",
    );
  });

  it("records an unresolvable alb target group that names no target", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        EmptyAlbGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "alb", Targets: [] },
        },
      },
    });
    const fronts = edgesOf(summaries, "fronts")[0];
    expect(fronts?.routing.resource).toBeNull();
    expect(fronts?.routing.unresolvedResource?.reason).toBe(
      "an alb target group named no target",
    );
  });

  it("skips a service with no LoadBalancers, a malformed LoadBalancers entry, and a service registering a different target group", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        TheTargetGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        OtherTargetGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        ServiceWithNoLoadBalancers: {
          Type: "AWS::ECS::Service",
          Properties: {},
        },
        ServiceWithMalformedEntry: {
          Type: "AWS::ECS::Service",
          Properties: { LoadBalancers: [null, "garbage"] },
        },
        ServiceForOtherGroup: {
          Type: "AWS::ECS::Service",
          Properties: {
            TaskDefinition: { Ref: "SomeTaskDefinition" },
            LoadBalancers: [
              {
                ContainerName: "other",
                TargetGroupArn: { Ref: "OtherTargetGroup" },
              },
            ],
          },
        },
      },
    });
    const fronts = edgesOf(summaries, "fronts").find(
      (entry) => entry.routing.target === "TheTargetGroup",
    );
    expect(fronts?.routing.resource).toBeNull();
    expect(fronts?.routing.unresolvedResource?.reason).toBe(
      "no ECS::Service registers this target group",
    );
  });

  it("records an unresolvable ContainerName on the registering service", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        TheTargetGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        TheService: {
          Type: "AWS::ECS::Service",
          Properties: {
            LoadBalancers: [{ TargetGroupArn: { Ref: "TheTargetGroup" } }],
          },
        },
      },
    });
    const fronts = edgesOf(summaries, "fronts")[0];
    expect(fronts?.routing.resource).toBeNull();
    expect(fronts?.routing.unresolvedResource?.reason).toBe(
      "the registering ECS::Service names no ContainerName",
    );
  });

  it("records an unresolvable TaskDefinition on the registering service", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        TheTargetGroup: {
          Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
          Properties: { TargetType: "ip" },
        },
        TheService: {
          Type: "AWS::ECS::Service",
          Properties: {
            // A dangling TaskDefinition ref, distinct from naming none
            // at all: this exercises resolveEcsTarget's own null check
            // on the resolution, whichever reason produced it.
            TaskDefinition: { Ref: "MissingTaskDefinition" },
            LoadBalancers: [
              {
                ContainerName: "app",
                TargetGroupArn: { Ref: "TheTargetGroup" },
              },
            ],
          },
        },
      },
    });
    const fronts = edgesOf(summaries, "fronts")[0];
    expect(fronts?.routing.resource).toBeNull();
    expect(fronts?.routing.unresolvedResource?.reason).toBe(
      "no resource named MissingTaskDefinition is declared",
    );
  });
});

describe("resolveRefOfType: unresolvable reference shapes", () => {
  it("records a reference shape refTarget does not recognize", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        OddRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 12,
            Conditions: [
              { Field: "path-pattern", PathPatternConfig: { Values: ["/x"] } },
            ],
            Actions: [
              {
                Type: "forward",
                TargetGroupArn: { "Fn::Sub": "${SomeParam}" },
              },
            ],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo")[0];
    expect(routesTo?.routing.target).toBeNull();
    expect(routesTo?.routing.unresolvedTarget?.reason).toBe(
      "not a recognized reference",
    );
    expect(routesTo?.routing.unresolvedTarget?.reference).toContain("Fn::Sub");
  });

  it("records a resolved reference pointing at a resource of the wrong type", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        NotATargetGroup: { Type: "AWS::SQS::Queue", Properties: {} },
        WrongTypeRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 13,
            Conditions: [
              { Field: "path-pattern", PathPatternConfig: { Values: ["/x"] } },
            ],
            Actions: [
              { Type: "forward", TargetGroupArn: { Ref: "NotATargetGroup" } },
            ],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo")[0];
    expect(routesTo?.routing.target).toBeNull();
    expect(routesTo?.routing.unresolvedTarget?.reason).toBe(
      "NotATargetGroup is AWS::SQS::Queue, not AWS::ElasticLoadBalancingV2::TargetGroup",
    );
  });

  it("names a resource with no CFN Type as untyped", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        MyListener: {
          Type: "AWS::ElasticLoadBalancingV2::Listener",
          Properties: { DefaultActions: [{ Type: "fixed-response" }] },
        },
        Untyped: { Properties: {} },
        UntypedRule: {
          Type: "AWS::ElasticLoadBalancingV2::ListenerRule",
          Properties: {
            ListenerArn: { Ref: "MyListener" },
            Priority: 14,
            Conditions: [
              { Field: "path-pattern", PathPatternConfig: { Values: ["/x"] } },
            ],
            Actions: [{ Type: "forward", TargetGroupArn: { Ref: "Untyped" } }],
          },
        },
      },
    });
    const routesTo = edgesOf(summaries, "routesTo")[0];
    expect(routesTo?.routing.unresolvedTarget?.reason).toBe(
      "Untyped is untyped, not AWS::ElasticLoadBalancingV2::TargetGroup",
    );
  });
});
