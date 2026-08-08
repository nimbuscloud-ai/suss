import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { restBinding } from "@suss/behavioral-ir";
import { pairSummaries } from "@suss/checker";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { reactRouterFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — adds fixtures/react-router/*.ts to an in-memory ts-morph project
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/react-router",
);

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(fixturesDir, "*.ts");

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [reactRouterFramework()],
  });

  return await adapter.extractAll();
}

/** The same, over the fixtures that declare routes in JSX. */
async function runOverRouteDeclarations(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(fixturesDir, "*.tsx");

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [reactRouterFramework()],
  });

  return await adapter.extractAll();
}

/** A caller of one URL, to pair the discovered routes against. */
function consumerOf(name: string, routePath: string): BehavioralSummary {
  return {
    kind: "client",
    location: {
      file: "src/api.ts",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: "http",
        method: "GET",
        path: routePath,
        recognition: "fetch",
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

// ---------------------------------------------------------------------------
// Structural sanity checks
// ---------------------------------------------------------------------------

describe("reactRouterFramework — pack shape", () => {
  it("exposes loader/action/component discovery entries", () => {
    const pack = reactRouterFramework();
    expect(pack.name).toBe("react-router");
    expect(pack.discovery.map((d) => d.kind).sort()).toEqual([
      "action",
      "component",
      "component",
      "loader",
    ]);
    expect(pack.inputMapping.type).toBe("singleObjectParam");
    expect(pack.contractReading).toBeUndefined();
  });

  it("reads route declarations from the names react-router exports", () => {
    const pack = reactRouterFramework();
    const routes = pack.discovery.find(
      (d) => d.match.type === "jsxElementRoute",
    );
    expect(routes?.match).toEqual({
      type: "jsxElementRoute",
      importModule: ["react-router", "react-router-dom"],
      routeElement: "Route",
      pathAttribute: "path",
      elementAttribute: "element",
      indexAttribute: "index",
      childrenAttribute: "children",
      routeObjectFactories: ["createBrowserRouter"],
      elementsFactories: ["createRoutesFromElements"],
      method: "GET",
    });
  });

  it("declares a render terminal, so a routed component's JSX is read", () => {
    const pack = reactRouterFramework();
    const render = pack.terminals.find((t) => t.kind === "render");
    expect(render?.match).toEqual({ type: "jsxReturn" });
  });

  it("ships no throw terminal, since React Router declares no error helper", () => {
    const kinds = reactRouterFramework().terminals.map((t) => t.kind);
    expect(kinds).not.toContain("throw");
  });

  it("adds a throw terminal for each error helper a project names", () => {
    const pack = reactRouterFramework({ errorHelpers: ["widgetError"] });
    const thrown = pack.terminals.filter((t) => t.kind === "throw");
    expect(thrown).toHaveLength(1);
    expect(thrown[0].match).toMatchObject({
      type: "throwExpression",
      constructorPattern: "widgetError",
    });
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the react-router fixture
// ---------------------------------------------------------------------------

describe("reactRouterFramework — integration", () => {
  // ts-morph project setup dominates — build the summaries once and reuse.
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers both loader and action kinds from named exports", () => {
    // The fixture exports `loader` and `action`. No `default` export in this
    // file, so we expect exactly those two code units.
    expect(summaries).toHaveLength(2);
    const kinds = summaries.map((s) => s.kind).sort();
    expect(kinds).toEqual(["action", "loader"]);
  });

  it("claims no route, since the convention is opt-in and unreadable here", () => {
    for (const s of summaries) {
      expect(s.identity.boundaryBinding).toEqual({
        transport: "http",
        semantics: { name: "function-call" },
        recognition: "react-router",
      });
    }
  });

  it("loader assembles three response transitions from the json/redirect helpers", () => {
    const loader = summaries.find((s) => s.kind === "loader");
    expect(loader).toBeDefined();

    // Three detected terminals:
    //   1. json({ error: "not found" }, { status: 404 })  → response, 200 default
    //   2. redirect("/users")                             → response, 302 default
    //   3. json({ user })                                 → default response, 200
    // json()/data() default to 200, redirect() defaults to 302 via
    // the pack's defaultStatusCode extraction.
    expect(loader?.transitions).toHaveLength(3);
    const statuses = loader?.transitions.map((t) =>
      t.output.type === "response" && t.output.statusCode?.type === "literal"
        ? t.output.statusCode.value
        : null,
    );
    expect(statuses).toEqual([200, 302, 200]);
    expect(loader?.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("loader uses singleObjectParam mapping — params destructure is the sole input", () => {
    const loader = summaries.find((s) => s.kind === "loader");
    expect(loader).toBeDefined();
    if (!loader) {
      throw new Error("loader summary missing");
    }
    expect(loader.inputs).toHaveLength(1);
    const [input] = loader.inputs;
    expect(input.type).toBe("parameter");
    if (input.type === "parameter") {
      expect(input.position).toBe(0);
      expect(input.role).toBe("request");
    }
  });

  it("action assembles two response transitions from the json/redirect helpers", () => {
    const action = summaries.find((s) => s.kind === "action");
    expect(action).toBeDefined();

    // Two terminals:
    //   1. json({ error: "name required" }, { status: 400 })  → response, null status
    //   2. redirect(`/users/${params.id}`)                    → default response
    if (!action) {
      throw new Error("action summary missing");
    }
    expect(action.transitions).toHaveLength(2);
    expect(action.transitions.map((t) => t.isDefault)).toEqual([false, true]);
    for (const t of action.transitions) {
      expect(t.output.type).toBe("response");
    }
  });

  it("has high confidence when all conditions resolve to structured predicates", () => {
    for (const s of summaries) {
      expect(s.confidence.level).toBe("high");
      for (const t of s.transitions) {
        for (const c of t.conditions) {
          expect(c.type).not.toBe("opaque");
        }
      }
    }
  });

  it("has no gaps when no contract reading is configured", () => {
    for (const s of summaries) {
      expect(s.gaps).toEqual([]);
      // metadata carries only the derived effects closure (when the
      // unit has effects), and no contract-reading metadata appears.
      const keys = Object.keys(s.metadata ?? {});
      expect(keys.filter((k) => k !== "effectsClosure")).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Routes the app declares itself, in JSX and as route objects
// ---------------------------------------------------------------------------

describe("reactRouterFramework: declared route trees", () => {
  let routed: BehavioralSummary[];
  beforeAll(async () => {
    routed = await runOverRouteDeclarations();
  }, 90_000);

  const routeOf = (name: string): string | null => {
    const semantics = routed.find((s) => s.identity.name === name)?.identity
      .boundaryBinding?.semantics;
    return semantics?.name === "rest" ? semantics.path : null;
  };

  it("joins a child route's path onto the route it is nested under", () => {
    expect(routeOf("UserDetail")).toBe("/users/:id");
  });

  it("gives an index route the path of the route it sits under", () => {
    expect(routeOf("UsersIndex")).toBe("/users");
  });

  it("reads a route element imported under another name", () => {
    expect(routeOf("Reports")).toBe("/reports");
  });

  it("reads the route objects a router is created from, through the name they are bound to", () => {
    expect(routeOf("Home")).toBe("/");
    expect(routeOf("Shell")).toBe("/billing");
  });

  it("joins the paths of routes nested under a route object, two deep", () => {
    expect(routeOf("InvoicesIndex")).toBe("/billing/invoices");
    expect(routeOf("Invoice")).toBe("/billing/invoices/:invoiceId");
    expect(routeOf("InvoiceLines")).toBe("/billing/invoices/:invoiceId/lines");
  });

  it("gives an index child the path of the route object it sits under", () => {
    expect(routeOf("Billing")).toBe("/billing");
  });

  it("records the component a route renders as the unit the route reaches", () => {
    const detail = routed.find((s) => s.identity.name === "UserDetail");
    expect(detail?.kind).toBe("component");
    expect(detail?.location.file).toContain("pages.tsx");
    expect(detail?.transitions.map((t) => t.output.type)).toEqual(["render"]);
  });

  it("claims no path for a route whose path is built at runtime, and says so", () => {
    const settings = routed.find((s) => s.identity.name === "Settings");
    expect(settings?.identity.boundaryBinding?.semantics).toEqual({
      name: "function-call",
    });
    expect(settings?.gaps.map((g) => g.description)).toContain(
      "The path this route declares is not written as a string literal, so no path is claimed and this route pairs with nothing",
    );
  });

  it("claims no path for routes a spread stands in for, and says so", () => {
    const spread = routed.find((s) => s.identity.name === "extraRoutes");
    expect(spread?.identity.boundaryBinding?.semantics).toEqual({
      name: "function-call",
    });
    expect(spread?.gaps.map((g) => g.description)).toContain(
      "A spread stands in for routes declared elsewhere in this array, and they are not read here, so no path is claimed for any of them",
    );
  });

  it("pairs the discovered routes against callers of the same URLs", () => {
    const consumers = [
      consumerOf("loadUser", "/users/{id}"),
      consumerOf("loadBilling", "/billing"),
      consumerOf("loadSettings", "/settings/general"),
    ];

    const result = pairSummaries([...routed, ...consumers]);
    const paired = result.pairs
      .map((p) => `${p.consumer.identity.name}<->${p.provider.identity.name}`)
      .sort();
    // /billing is answered by the layout and by the index route inside
    // it, which is what the router renders there, so a caller of that
    // URL pairs with both.
    expect(paired).toEqual([
      "loadBilling<->Billing",
      "loadBilling<->Shell",
      "loadUser<->UserDetail",
    ]);
  });
});

describe("a route array that holds itself", () => {
  it("reads the routes around it, and claims nothing for the one that loops", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/routes.tsx",
      [
        `import { createBrowserRouter } from "react-router-dom";`,
        "export function Home() {",
        "  return <div />;",
        "}",
        "const routes: any = [",
        `  { path: "/home", element: <Home /> },`,
        `  { path: "/self", children: routes },`,
        "];",
        "export const router = createBrowserRouter(routes);",
      ].join("\n"),
    );

    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    let summaries: BehavioralSummary[];
    try {
      summaries = await createTypeScriptAdapter({
        project,
        frameworks: [reactRouterFramework()],
      }).extractAll();
    } finally {
      process.stderr.write = original;
    }

    // Following the name back into the array it names would walk
    // forever. The route that loops resolves to nothing, and the run
    // still reads every route beside it.
    expect(warnings.join("")).not.toContain("overflowed the call stack");
    expect(summaries.map((s) => s.identity.name)).toEqual(["Home"]);
  }, 60_000);
});
