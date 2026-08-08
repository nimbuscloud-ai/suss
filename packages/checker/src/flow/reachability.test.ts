// The walk's generic half, tested without any reader: facts read off
// the routing namespace, admission dispatched by match language,
// serving claims placed by code scope, and the two certainty
// relations. Everything protocol-specific arrives through the
// selector table or the semantics registry, the way a caller wires it.

import { describe, expect, it } from "vitest";

import { withRoutingMetadata } from "@suss/behavioral-ir";

import { analyzeFlow } from "./reachability.js";
import { collectFlowInputs, scopedFlowNode } from "./routingFacts.js";

import type {
  BehavioralSummary,
  RouterMatchSelector,
  RoutingMetadata,
} from "@suss/behavioral-ir";

const DOCUMENT = "infra/template.yaml";

function routingSummary(
  name: string,
  routing: RoutingMetadata,
  file: string = DOCUMENT,
): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: { name, exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withRoutingMetadata(undefined, routing),
  };
}

function unitSummary(
  instanceName: string,
  codeScope: string,
): BehavioralSummary {
  return {
    kind: "library",
    location: {
      file: "infra/template.yaml",
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: instanceName,
      exportPath: null,
      boundaryBinding: null,
      deployableUnit: { deploymentTarget: "ecs-task", instanceName },
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: { codeScope: { kind: "codeUri", path: codeScope } },
  };
}

function restRoute(over: {
  file: string;
  name: string;
  method: string | null;
  path: string | null;
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

const REQUEST = { method: "GET", host: null, path: "/a" };

/** Admits every match whose id says yes, for wiring tests only. */
const toySelector: RouterMatchSelector = (records) => ({
  admitted: records
    .map((record) => record.matchId)
    .filter((matchId) => matchId.startsWith("yes")),
  possible: records
    .map((record) => record.matchId)
    .filter((matchId) => matchId.startsWith("maybe")),
});

const TOY = { toy: toySelector };

describe("collectFlowInputs", () => {
  it("skips a row with an unresolved end: nothing to join on", () => {
    const inputs = collectFlowInputs([
      routingSummary("broken", {
        edge: "routesTo",
        router: "L",
        target: null,
        unresolvedTarget: { reference: "Gone", reason: "not declared" },
        matchId: "R1",
        conditions: [],
        matchLanguage: "toy",
      }),
      routingSummary("dangling", {
        edge: "fronts",
        target: "Tg",
        resource: null,
        unresolvedResource: { reference: "Tg", reason: "nothing registers it" },
      }),
    ]);

    expect(inputs.edges.routesTo).toEqual([]);
    expect(inputs.edges.fronts).toEqual([]);
    // The match record is still there: the rule exists even though its
    // target does not resolve, and a selector may still rank it.
    expect(
      inputs.edges.routers
        .get(scopedFlowNode(DOCUMENT, "L"))
        ?.records.has("R1"),
    ).toBe(true);
  });

  it("collapses a weighted forward's rows into one match record and drops only the weight-0 edge", () => {
    const inputs = collectFlowInputs([
      routingSummary("split#0", {
        edge: "routesTo",
        router: "L",
        target: "TgA",
        matchId: "split",
        priority: 5,
        conditions: [],
        matchLanguage: "toy",
        weight: 100,
      }),
      routingSummary("split#1", {
        edge: "routesTo",
        router: "L",
        target: "TgB",
        matchId: "split",
        priority: 5,
        conditions: [],
        matchLanguage: "toy",
        weight: 0,
      }),
    ]);

    expect(inputs.edges.routesTo).toEqual([
      [
        scopedFlowNode(DOCUMENT, "L"),
        scopedFlowNode(DOCUMENT, "TgA"),
        scopedFlowNode(DOCUMENT, "split"),
      ],
    ]);
    expect(
      inputs.edges.routers.get(scopedFlowNode(DOCUMENT, "L"))?.records.size,
    ).toBe(1);
  });

  it("reads units off summaries that declare both a unit and its code scope", () => {
    const inputs = collectFlowInputs([
      unitSummary("Task/app", "src/app"),
      restRoute({
        file: "src/app/routes.ts",
        name: "r",
        method: "GET",
        path: "/a",
      }),
      restRoute({
        file: "src/other/loose.ts",
        name: "stray",
        method: "GET",
        path: "/a",
      }),
    ]);

    expect(inputs.units).toEqual(
      new Set([scopedFlowNode(DOCUMENT, "Task/app")]),
    );
    expect(inputs.claims).toEqual([
      {
        ref: "src/app/routes.ts::r",
        binding: expect.objectContaining({ transport: "http" }),
        units: [{ scope: DOCUMENT, instanceName: "Task/app" }],
      },
    ]);
  });
});

describe("admission dispatch", () => {
  const edges = (language?: string) => [
    routingSummary("edge", {
      edge: "routesTo",
      router: "L",
      target: "Tg",
      matchId: "yes-1",
      conditions: [],
      ...(language !== undefined ? { matchLanguage: language } : {}),
    }),
  ];

  it("walks an edge its language's selector admits", () => {
    const view = analyzeFlow(edges("toy"), REQUEST, TOY).from("L");
    expect(view.nodes).toEqual({ certain: ["Tg"], possible: [] });
  });

  it("abstains for a language with no selector: possible, never admitted, never refused", () => {
    const view = analyzeFlow(edges("other"), REQUEST, TOY).from("L");
    expect(view.nodes).toEqual({ certain: [], possible: ["Tg"] });
  });

  it("abstains for a match that names no language at all", () => {
    const view = analyzeFlow(edges(), REQUEST, TOY).from("L");
    expect(view.nodes).toEqual({ certain: [], possible: ["Tg"] });
  });

  it("abstains for a router whose rows disagree on their language", () => {
    const summaries = [
      ...edges("toy"),
      routingSummary("other-edge", {
        edge: "routesTo",
        router: "L",
        target: "Tg2",
        matchId: "yes-2",
        conditions: [],
        matchLanguage: "other",
      }),
    ];
    const view = analyzeFlow(summaries, REQUEST, TOY).from("L");
    expect(view.nodes).toEqual({ certain: [], possible: ["Tg", "Tg2"] });
  });

  it("ignores a selector answer naming a match the router never declared", () => {
    const rogue: RouterMatchSelector = () => ({
      admitted: ["yes-1", "invented"],
      possible: ["also-invented"],
    });
    const view = analyzeFlow(edges("toy"), REQUEST, { toy: rogue }).from("L");
    expect(view.nodes).toEqual({ certain: ["Tg"], possible: [] });
  });
});

describe("possible chains and serving claims", () => {
  it("keeps a chain through a possible hop possible to its end", () => {
    const summaries = [
      routingSummary("gate", {
        edge: "routesTo",
        router: "L",
        target: "Tg",
        matchId: "maybe-1",
        conditions: [],
        matchLanguage: "toy",
      }),
      routingSummary("backing", {
        edge: "fronts",
        target: "Tg",
        resource: "Task/app",
      }),
      unitSummary("Task/app", "src/app"),
    ];
    const view = analyzeFlow(summaries, REQUEST, TOY).from("L");

    expect(view.nodes).toEqual({ certain: [], possible: ["Task/app", "Tg"] });
    expect(view.units).toEqual({ certain: [], possible: ["Task/app"] });
  });

  it("answers with the serving claims of a reached unit, by each protocol's own matching", () => {
    const summaries = [
      routingSummary("edge", {
        edge: "routesTo",
        router: "L",
        target: "Tg",
        matchId: "yes-1",
        conditions: [],
        matchLanguage: "toy",
      }),
      routingSummary("backing", {
        edge: "fronts",
        target: "Tg",
        resource: "Task/app",
      }),
      unitSummary("Task/app", "src/app"),
      restRoute({
        file: "src/app/a.ts",
        name: "hit",
        method: "GET",
        path: "/a",
      }),
      restRoute({
        file: "src/app/a.ts",
        name: "miss",
        method: "GET",
        path: "/b",
      }),
      restRoute({
        file: "src/app/a.ts",
        name: "unnamed",
        method: "GET",
        path: null,
      }),
    ];
    const view = analyzeFlow(summaries, REQUEST, TOY).from("L");

    expect(view.units.certain).toEqual(["Task/app"]);
    // The named route that matches is certain; the route whose path
    // nothing named might still answer, so it stays possible; the
    // route that matches another path is neither.
    expect(view.claims).toEqual({
      certain: ["src/app/a.ts::hit"],
      possible: ["src/app/a.ts::unnamed"],
    });
  });

  it("claims nothing for a unit the walk never reaches", () => {
    const summaries = [
      routingSummary("edge", {
        edge: "routesTo",
        router: "L",
        target: "Tg",
        matchId: "yes-1",
        conditions: [],
        matchLanguage: "toy",
      }),
      unitSummary("Task/app", "src/app"),
      restRoute({
        file: "src/app/a.ts",
        name: "hit",
        method: "GET",
        path: "/a",
      }),
    ];
    const view = analyzeFlow(summaries, REQUEST, TOY).from("L");

    expect(view.claims).toEqual({ certain: [], possible: [] });
  });

  it("answers a possible terminal response as possible, and a certain one as certain", () => {
    const summaries = [
      routingSummary("maybe-answer", {
        edge: "answers",
        router: "L",
        matchId: "maybe-a",
        conditions: [],
        matchLanguage: "toy",
        response: { type: "fixed-response", statusCode: 403 },
      }),
      routingSummary("sure-answer", {
        edge: "answers",
        router: "L",
        matchId: "yes-a",
        conditions: [],
        matchLanguage: "toy",
        response: { type: "fixed-response", statusCode: 404 },
      }),
    ];
    const view = analyzeFlow(summaries, REQUEST, TOY).from("L");

    expect(view.answers.certain).toEqual([
      {
        matchId: "yes-a",
        router: "L",
        response: { type: "fixed-response", statusCode: 404 },
      },
    ]);
    expect(view.answers.possible).toEqual([
      {
        matchId: "maybe-a",
        router: "L",
        response: { type: "fixed-response", statusCode: 403 },
      },
    ]);
  });
});

describe("document scoping", () => {
  // Two unrelated documents, same router and matchId spellings,
  // different targets. Nothing may join across them.
  const summaries = [
    routingSummary(
      "edge",
      {
        edge: "routesTo",
        router: "L",
        target: "TgAlpha",
        matchId: "yes-1",
        conditions: [],
        matchLanguage: "toy",
      },
      "services/alpha/template.yaml",
    ),
    routingSummary(
      "edge",
      {
        edge: "routesTo",
        router: "L",
        target: "TgBeta",
        matchId: "yes-1",
        conditions: [],
        matchLanguage: "toy",
      },
      "services/beta/template.yaml",
    ),
  ];

  it("answers each document's router from its own edges only", () => {
    const analysis = analyzeFlow(summaries, REQUEST, TOY);

    expect(analysis.from("L", "services/alpha/template.yaml").nodes).toEqual({
      certain: ["TgAlpha"],
      possible: [],
    });
    expect(analysis.from("L", "services/beta/template.yaml").nodes).toEqual({
      certain: ["TgBeta"],
      possible: [],
    });
  });

  it("refuses a bare entry two documents both declare", () => {
    const analysis = analyzeFlow(summaries, REQUEST, TOY);

    expect(() => analysis.from("L")).toThrow(
      /2 documents declare a node named "L"/,
    );
  });

  it("answers an empty view for a name no document declares", () => {
    const view = analyzeFlow(summaries, REQUEST, TOY).from("Nowhere");

    expect(view.nodes).toEqual({ certain: [], possible: [] });
  });

  it("shares one scope across a nested tree, so in-tree joins still hold", () => {
    // A child document's summaries carry the root label plus the stack
    // path that reaches them; the walk scopes by the root part, so a
    // routing edge and the unit it fronts, both in the child, join.
    const child = "cloudformation:root.yaml#OrdersStack";
    const nested = [
      routingSummary(
        "edge",
        {
          edge: "routesTo",
          router: "L",
          target: "Tg",
          matchId: "yes-1",
          conditions: [],
          matchLanguage: "toy",
        },
        child,
      ),
      routingSummary(
        "backing",
        { edge: "fronts", target: "Tg", resource: "OrdersStack/Task/app" },
        child,
      ),
    ];
    const view = analyzeFlow(nested, REQUEST, TOY).from(
      "L",
      "cloudformation:root.yaml",
    );

    expect(view.nodes.certain).toEqual(["OrdersStack/Task/app", "Tg"]);
  });
});

describe("the chain behind an answer", () => {
  const wiring = [
    routingSummary("listener-of", {
      edge: "belongsTo",
      router: "L",
      resource: "Lb",
    }),
    routingSummary("forward", {
      edge: "routesTo",
      router: "L",
      target: "Tg",
      matchId: "yes-1",
      priority: 10,
      conditions: [{ field: "path-pattern", values: ["/a"], evaluated: true }],
      matchLanguage: "toy",
    }),
    routingSummary("backing", {
      edge: "fronts",
      target: "Tg",
      resource: "Task/app",
    }),
    unitSummary("Task/app", "src/app"),
  ];

  it("names the way in: what hands traffic on and takes none", () => {
    expect(analyzeFlow(wiring, REQUEST, TOY).entries()).toEqual([
      { name: "Lb", scope: DOCUMENT },
    ]);
  });

  it("walks balancer to listener to target group to unit, and names the handler", () => {
    const summaries = [
      ...wiring,
      restRoute({
        file: "src/app/routes.ts",
        name: "getA",
        method: "GET",
        path: "/a",
      }),
    ];
    const [chain] = analyzeFlow(summaries, REQUEST, TOY).from("Lb").chains;

    expect(chain.certainty).toBe("certain");
    expect(chain.hops.map((hop) => [hop.from, hop.to, hop.edge])).toEqual([
      ["Lb", "L", "belongsTo"],
      ["L", "Tg", "routesTo"],
      ["Tg", "Task/app", "fronts"],
    ]);
    expect(chain.hops[1].match).toEqual({
      matchId: "yes-1",
      priority: 10,
      conditions: [{ field: "path-pattern", values: ["/a"], evaluated: true }],
    });
    expect(chain.end).toEqual({
      type: "serves",
      unit: "Task/app",
      claims: [{ ref: "src/app/routes.ts::getA", certainty: "certain" }],
    });
  });

  it("says a unit was reached and nothing inside it answers", () => {
    const [chain] = analyzeFlow(wiring, REQUEST, TOY).from("Lb").chains;

    expect(chain.end).toEqual({ type: "unserved", unit: "Task/app" });
  });

  it("carries the doubt: an unsettled hop leaves the whole chain possible", () => {
    const unsettled = [
      routingSummary("forward", {
        edge: "routesTo",
        router: "L",
        target: "Tg",
        matchId: "maybe-1",
        conditions: [
          { field: "http-header", values: ["X-Canary=1"], evaluated: false },
        ],
        matchLanguage: "toy",
      }),
    ];
    const [chain] = analyzeFlow(unsettled, REQUEST, TOY).from("L").chains;

    expect(chain.hops[0].certainty).toBe("possible");
    expect(chain.certainty).toBe("possible");
  });

  it("says which declarations refused, when nothing below the last hop took it", () => {
    const refusing = [
      routingSummary("forward", {
        edge: "routesTo",
        router: "L",
        target: "Tg",
        matchId: "no-1",
        priority: 3,
        conditions: [
          { field: "path-pattern", values: ["/b"], evaluated: true },
        ],
        matchLanguage: "toy",
      }),
    ];
    const [chain] = analyzeFlow(refusing, REQUEST, TOY).from("L").chains;

    expect(chain.end).toEqual({
      type: "stops",
      node: "L",
      refused: [
        {
          matchId: "no-1",
          priority: 3,
          conditions: [
            { field: "path-pattern", values: ["/b"], evaluated: true },
          ],
        },
      ],
    });
  });

  it("ends on the declared response when the request lands on one", () => {
    const defaulted = [
      routingSummary("default", {
        edge: "answers",
        router: "L",
        matchId: "yes-default",
        conditions: [],
        matchLanguage: "toy",
        response: { type: "fixed-response", statusCode: 404 },
      }),
    ];
    const [chain] = analyzeFlow(defaulted, REQUEST, TOY).from("L").chains;

    expect(chain.end).toEqual({
      type: "answers",
      router: "L",
      answer: {
        matchId: "yes-default",
        router: "L",
        response: { type: "fixed-response", statusCode: 404 },
      },
      certainty: "certain",
    });
  });

  it("says an admitted rule sent it somewhere nothing could follow", () => {
    // The rule takes the request; its target lives in another stack, so
    // the walk has nowhere to go. Reporting the node as declaring
    // nothing would lose the one fact the reader needs.
    const crossStack = [
      routingSummary("forward", {
        edge: "routesTo",
        router: "L",
        target: null,
        unresolvedTarget: {
          reference: "OrdersStack.TargetGroup",
          reason: "declared in another template",
        },
        matchId: "yes-1",
        conditions: [],
        matchLanguage: "toy",
      }),
    ];
    const [chain] = analyzeFlow(crossStack, REQUEST, TOY).from("L").chains;

    expect(chain.certainty).toBe("certain");
    expect(chain.end).toEqual({
      type: "unfollowed",
      node: "L",
      edges: [
        {
          matchId: "yes-1",
          scopedMatchId: scopedFlowNode(DOCUMENT, "yes-1"),
          reference: "OrdersStack.TargetGroup",
          reason: "declared in another template",
        },
      ],
    });
  });

  it("keeps a rule that refused out of the trail-ends answer", () => {
    const refusedCrossStack = [
      routingSummary("forward", {
        edge: "routesTo",
        router: "L",
        target: null,
        unresolvedTarget: { reference: "Gone", reason: "not declared" },
        matchId: "no-1",
        conditions: [],
        matchLanguage: "toy",
      }),
    ];
    const [chain] = analyzeFlow(refusedCrossStack, REQUEST, TOY).from(
      "L",
    ).chains;

    expect(chain.end.type).toBe("stops");
  });

  it("says a target group fronts something it could not follow", () => {
    const dangling = [
      routingSummary("forward", {
        edge: "routesTo",
        router: "L",
        target: "Tg",
        matchId: "yes-1",
        conditions: [],
        matchLanguage: "toy",
      }),
      routingSummary("backing", {
        edge: "fronts",
        target: "Tg",
        resource: null,
        unresolvedResource: {
          reference: "arn:aws:elasticloadbalancing:...",
          reason: "an arn no resource in this template answers to",
        },
      }),
    ];
    const [chain] = analyzeFlow(dangling, REQUEST, TOY).from("L").chains;

    expect(chain.end).toMatchObject({ type: "unfollowed", node: "Tg" });
  });

  it("counts the chains it did not keep rather than dropping them silently", () => {
    // One router forwarding to 60 target groups: more chains than an
    // answer prints, and the answer has to say how many more.
    const many = [
      ...Array.from({ length: 60 }, (_, index) =>
        routingSummary(`edge-${index}`, {
          edge: "routesTo",
          router: "L",
          target: `Tg${index}`,
          matchId: `yes-${index}`,
          conditions: [],
          matchLanguage: "toy",
        }),
      ),
    ];
    const view = analyzeFlow(many, REQUEST, TOY).from("L");

    expect(view.chains).toHaveLength(50);
    expect(view.omitted).toEqual({ count: 10, exact: true });
  });

  it("reports a cycle as a loop rather than walking it twice", () => {
    const cyclic = [
      routingSummary("out", {
        edge: "routesTo",
        router: "L",
        target: "Tg",
        matchId: "yes-1",
        conditions: [],
        matchLanguage: "toy",
      }),
      routingSummary("back", { edge: "fronts", target: "Tg", resource: "Lb" }),
      routingSummary("listener-of", {
        edge: "belongsTo",
        router: "L",
        resource: "Lb",
      }),
    ];
    const chains = analyzeFlow(cyclic, REQUEST, TOY).from("Lb").chains;

    expect(chains.map((chain) => chain.end)).toContainEqual({
      type: "loops",
      node: "Lb",
    });
  });
});
