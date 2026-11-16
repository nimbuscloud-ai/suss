import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createTypeScriptAdapter,
  discoverUnits,
  ResolutionStore,
} from "@suss/adapter-typescript";
import { restBinding } from "@suss/behavioral-ir";
import { pairSummaries } from "@suss/checker";
import { declaredMatchOf, JSX_ROUTE_UNREAD } from "@suss/extractor";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { REACT_ROUTER_ROUTES, reactRouterFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { Project, SourceFile } from "ts-morph";

/** The pack's route table pattern, the one discovery entry that reads routes. */
const ROUTE_PATTERNS = reactRouterFramework().discovery.filter(
  (d) => d.match.type === "routeTable",
);

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

async function runOverRouteDeclarations(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(fixturesDir, "*.tsx");

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [reactRouterFramework()],
  });

  return await adapter.extractAll();
}

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

describe("reactRouterFramework: pack shape", () => {
  it("exposes loader/action/component discovery entries", () => {
    const pack = reactRouterFramework();
    expect(pack.name).toBe("react-router");
    expect(pack.discovery.map((d) => d.kind).sort()).toEqual([
      "action",
      "component",
      "component",
      "loader",
    ]);
    expect(pack.inputMapping.type).toBe("objectParam");
    expect(pack.contractReading).toBeUndefined();
  });

  it("declares the route table a jsxElementRoute match with the router's names is read as", () => {
    const routes = ROUTE_PATTERNS[0];
    expect(routes?.match).toEqual({
      type: "routeTable",
      table: REACT_ROUTER_ROUTES,
      through: "element",
      unread: JSX_ROUTE_UNREAD,
    });
    expect(routes?.requiresImport).toEqual([
      "react-router",
      "react-router-dom",
    ]);
    expect(
      declaredMatchOf({
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
      }),
    ).toEqual(routes?.match);
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

describe("reactRouterFramework: integration", () => {
  // ts-morph project setup dominates, so build the summaries once.
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers both loader and action kinds from named exports", () => {
    // The fixture exports `loader` and `action`, and no `default`.
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

    // json() and data() default to 200, redirect() to 302.
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

  it("gives a destructured params the pathParams role the pack declares", () => {
    // The fixture writes `loader({ params })`, and the pack declares
    // `params: "pathParams"`. That declaration used to be ignored, so
    // every loader came back with one input roled "request" and nothing
    // knew the route had path parameters.
    const loader = summaries.find((s) => s.kind === "loader");
    if (!loader) {
      throw new Error("loader summary missing");
    }
    expect(
      loader.inputs.map((input) =>
        input.type === "parameter"
          ? `${input.name}:${input.role}@${input.position}`
          : input.type,
      ),
    ).toEqual(["params:pathParams@0"]);
  });

  it("action assembles two response transitions from the json/redirect helpers", () => {
    const action = summaries.find((s) => s.kind === "action");
    expect(action).toBeDefined();

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

  it("has no unhandled-case gaps when no contract reading is configured", () => {
    for (const s of summaries) {
      expect(s.gaps.filter((g) => g.type === "unhandledCase")).toEqual([]);
      expect(Object.keys(s.metadata ?? {})).toEqual([]);
    }
  });
});

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

  const unitIn = (name: string, file: string): BehavioralSummary | undefined =>
    routed.find(
      (s) =>
        s.kind === "component" &&
        s.identity.name === name &&
        s.location.file.endsWith(`/${file}`),
    );

  const unreadOf = (name: string, file: string): string[] =>
    unitIn(name, file)?.gaps.map((g) => g.description) ?? [];

  it("reads the component a route renders through parentheses", () => {
    expect(routeOf("Profile")).toBe("/profile");
    expect(routeOf("PageLoader")).toBe("/audit");
    expect(unitIn("profile", "parenthesizedElements.tsx")).toBeUndefined();
    expect(unitIn("audit", "parenthesizedElements.tsx")).toBeUndefined();
  });

  it("labels a parenthesized element under a path it cannot read by its component", () => {
    expect(unreadOf("PageLoader", "parenthesizedElements.tsx")).toContainEqual(
      expect.stringContaining("not written as a string literal"),
    );
  });

  it("serves nothing for a route that says index={false}, and keeps the routes inside it", () => {
    expect(routeOf("ProjectList")).toBe("/projects");
    expect(routed.some((s) => s.identity.name === "ProjectBoard")).toBe(false);
    expect(routeOf("BoardColumns")).toBe("/projects/board");
  });

  it("names a router argument it cannot read by the name under the cast", () => {
    expect(unreadOf("pluginRoutes", "castRouter.tsx")).toContainEqual(
      expect.stringContaining("not written as an array literal"),
    );
  });

  it("announces a spread among a route's children where its collection is written", () => {
    const source = fs.readFileSync(
      path.join(fixturesDir, "spreadChildren.tsx"),
      "utf8",
    );
    const spread = unitIn("adminRoutes", "spreadChildren.tsx");
    expect(spread?.location.span?.start).toBe(source.indexOf("adminRoutes]"));
    expect(spread?.gaps.map((g) => g.description)).toContainEqual(
      expect.stringContaining("A spread stands in for routes"),
    );
    expect(routeOf("AdminShell")).toBe("/admin");
    expect(routeOf("AdminHome")).toBe("/admin");
    expect(routeOf("AuditLog")).toBeNull();
  });

  it("claims no path for routes a function returns, as a router's list or a route's children", () => {
    expect(unreadOf("embedRoutes", "builtRoutes.tsx")).toContainEqual(
      expect.stringContaining("this router is created from"),
    );
    expect(unreadOf("preferenceRoutes", "builtRoutes.tsx")).toContainEqual(
      expect.stringContaining("nested under this one"),
    );
    expect(routeOf("Calendar")).toBe("/calendar");
    expect(routeOf("PreferencesShell")).toBe("/preferences");
    expect(routeOf("NotificationSettings")).toBeNull();
    expect(routeOf("EmbedWidget")).toBeNull();
  });

  it("nests a route written in another route's element under it, when that route is written with children", () => {
    expect(routeOf("InboxLayout")).toBe("/inbox");
    expect(routeOf("Compose")).toBe("/inbox/compose");
    expect(routeOf("Thread")).toBe("/inbox/:threadId");
  });

  it("claims a route written in a self-closing route's element from the top", () => {
    expect(routeOf("HelpLayout")).toBe("/help/*");
    expect(routeOf("HelpArticles")).toBe("/articles");
  });

  it("nests routes written behind a condition and inside a fragment", () => {
    expect(routeOf("Dashboard")).toBe("/dashboard");
    expect(routeOf("Labs")).toBe("/dashboard/labs");
    expect(routeOf("LabsBeta")).toBe("/dashboard/labs/beta");
  });

  it("claims no path for a route mapped from a list, whose path is the item's", () => {
    expect(unreadOf("Report", "conditionalRoutes.tsx")).toContainEqual(
      expect.stringContaining("not written as a string literal"),
    );
    expect(routeOf("DailyReport")).toBeNull();
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
    // The router renders both the layout and its index route at
    // /billing, so a caller of that URL pairs with both.
    expect(paired).toEqual([
      "loadBilling<->Billing",
      "loadBilling<->Shell",
      "loadUser<->UserDetail",
    ]);
  });
});

describe("reactRouterFramework: each way a route is written", () => {
  function makeFile(source: string, project = createTestProject()): SourceFile {
    return project.createSourceFile("routes.tsx", source);
  }

  function unitsOf(file: SourceFile) {
    return discoverUnits(file, ROUTE_PATTERNS, new ResolutionStore());
  }

  function routesOf(file: SourceFile): string[] {
    return unitsOf(file)
      .map((u) =>
        u.routeInfo === undefined
          ? `${u.name} (no route)`
          : `${u.routeInfo.method} ${u.routeInfo.path}`,
      )
      .sort();
  }

  it("reads a route element's path and the component it renders", () => {
    const [unit] = unitsOf(
      makeFile(`
        import { Route } from "react-router-dom";
        function Users() { return <ul />; }
        export const tree = <Route path="/users" element={<Users />} />;
      `),
    );
    expect(unit.routeInfo).toEqual({ method: "GET", path: "/users" });
    expect(unit.name).toBe("Users");
    expect(unit.func).not.toBeNull();
  });

  it("reads a route element's path from a name imported from another module", () => {
    const project: Project = createTestProject();
    project.createSourceFile("paths.ts", 'export const USERS_PATH = "/users";');
    const [unit] = unitsOf(
      makeFile(
        `
        import { Route } from "react-router-dom";
        import { USERS_PATH } from "./paths.js";
        function Users() { return <ul />; }
        export const tree = <Route path={USERS_PATH} element={<Users />} />;
      `,
        project,
      ),
    );
    expect(unit.routeInfo).toEqual({ method: "GET", path: "/users" });
  });

  it("joins a nested route's path onto its parent's, and gives an index route the parent's path", () => {
    const file = makeFile(`
      import { Route } from "react-router-dom";
      function List() { return <ul />; }
      function Detail() { return <li />; }
      export const tree = (
        <Route path="/users">
          <Route index element={<List />} />
          <Route path=":id" element={<Detail />} />
        </Route>
      );
    `);
    expect(routesOf(file)).toEqual(["GET /users", "GET /users/:id"]);
  });

  it("lets a nested route with an absolute path stand alone", () => {
    const file = makeFile(`
      import { Route } from "react-router-dom";
      function Help() { return <p />; }
      export const tree = (
        <Route path="/users">
          <Route path="/help" element={<Help />} />
        </Route>
      );
    `);
    expect(routesOf(file)).toEqual(["GET /help"]);
  });

  it("matches a route element imported under another name", () => {
    const file = makeFile(`
      import { Route as Screen } from "react-router-dom";
      function Home() { return <main />; }
      export const tree = <Screen path="/" element={<Home />} />;
    `);
    expect(routesOf(file)).toEqual(["GET /"]);
  });

  it("ignores an element of the same name that came from somewhere else", () => {
    const file = makeFile(`
      import { Route } from "some-other-lib";
      function Home() { return <main />; }
      export const tree = <Route path="/" element={<Home />} />;
    `);
    expect(routesOf(file)).toEqual([]);
  });

  it("reads route objects from an array bound to a name above the call", () => {
    const file = makeFile(`
      import { createBrowserRouter } from "react-router-dom";
      function Home() { return <main />; }
      function Billing() { return <aside />; }
      const routes = [
        { path: "/", element: <Home /> },
        { path: "/billing", element: <Billing /> },
      ];
      export const router = createBrowserRouter(routes);
    `);
    expect(routesOf(file)).toEqual(["GET /", "GET /billing"]);
  });

  it("reads route objects written with quoted keys", () => {
    const file = makeFile(`
      import { createBrowserRouter } from "react-router-dom";
      function Home() { return <main />; }
      function Billing() { return <aside />; }
      export const router = createBrowserRouter([
        { "path": "/", "element": <Home /> },
        { "path": "/billing", "element": <Billing />, "children": [] },
      ]);
    `);
    expect(routesOf(file)).toEqual(["GET /", "GET /billing"]);
  });

  it("reads routes nested under a route object, joining their paths onto its own", () => {
    const file = makeFile(`
      import { createBrowserRouter } from "react-router-dom";
      function Shell() { return <div />; }
      function Overview() { return <p />; }
      function Invoice() { return <dl />; }
      function Lines() { return <tbody />; }
      export const router = createBrowserRouter([
        {
          path: "/billing",
          element: <Shell />,
          children: [
            { index: true, element: <Overview /> },
            {
              path: "invoices",
              element: <Invoice />,
              children: [{ path: ":id", element: <Lines /> }],
            },
          ],
        },
      ]);
    `);
    expect(routesOf(file)).toEqual([
      "GET /billing",
      "GET /billing",
      "GET /billing/invoices",
      "GET /billing/invoices/:id",
    ]);
  });

  it("composes a nested route object's path the same way the element tree does", () => {
    const project = createTestProject();
    const objects = project.createSourceFile(
      "objects.tsx",
      `
      import { createBrowserRouter } from "react-router-dom";
      function Detail() { return <li />; }
      export const router = createBrowserRouter([
        { path: "/users", children: [{ path: ":id", element: <Detail /> }] },
      ]);
    `,
    );
    const elements = project.createSourceFile(
      "elements.tsx",
      `
      import { Route } from "react-router-dom";
      function Detail() { return <li />; }
      export const tree = (
        <Route path="/users">
          <Route path=":id" element={<Detail />} />
        </Route>
      );
    `,
    );
    expect(routesOf(objects)).toEqual(routesOf(elements));
    expect(routesOf(objects)).toEqual(["GET /users/:id"]);
  });

  it("lets a nested route object with an absolute path stand alone", () => {
    const file = makeFile(`
      import { createBrowserRouter } from "react-router-dom";
      function Help() { return <p />; }
      export const router = createBrowserRouter([
        { path: "/users", children: [{ path: "/help", element: <Help /> }] },
      ]);
    `);
    expect(routesOf(file)).toEqual(["GET /help"]);
  });

  it("abstains on every route nested under a path built at runtime", () => {
    const units = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        function Detail() { return <li />; }
        const base = "/tenants/" + String(Math.random());
        export const router = createBrowserRouter([
          { path: base, children: [{ path: ":id", element: <Detail /> }] },
        ]);
      `),
    );
    expect(units.map((u) => u.routeInfo)).toEqual([undefined]);
    expect(units[0].unreadBinding).toContain("nested under");
  });

  it("abstains on a children array it cannot read, keeping the route above it", () => {
    const units = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        import { childRoutes } from "./children";
        function Shell() { return <div />; }
        export const router = createBrowserRouter([
          { path: "/billing", element: <Shell />, children: childRoutes },
        ]);
      `),
    );
    expect(units.map((u) => u.routeInfo?.path)).toEqual([
      "/billing",
      undefined,
    ]);
    expect(units[1].unreadBinding).toContain("nested under this one");
  });

  it("abstains on a spread inside a children array", () => {
    const units = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        import { more } from "./more";
        function Shell() { return <div />; }
        function Overview() { return <p />; }
        export const router = createBrowserRouter([
          {
            path: "/billing",
            element: <Shell />,
            children: [{ index: true, element: <Overview /> }, ...more],
          },
        ]);
      `),
    );
    expect(units.map((u) => u.routeInfo?.path)).toEqual([
      "/billing",
      "/billing",
      undefined,
    ]);
    expect(units[2].unreadBinding).toContain("A spread stands in for routes");
  });

  it("reads one array of routes under each route that nests it", () => {
    const file = makeFile(`
      import { createBrowserRouter } from "react-router-dom";
      function Shell() { return <div />; }
      function Overview() { return <p />; }
      const shared = [{ path: "overview", element: <Overview /> }];
      export const router = createBrowserRouter([
        { path: "/billing", element: <Shell />, children: shared },
        { path: "/admin", element: <Shell />, children: shared },
      ]);
    `);
    expect(routesOf(file)).toEqual([
      "GET /admin",
      "GET /admin/overview",
      "GET /billing",
      "GET /billing/overview",
    ]);
  });

  it("abstains on a path built at runtime, saying what it could not read", () => {
    const [unit] = unitsOf(
      makeFile(`
        import { Route } from "react-router-dom";
        function Settings() { return <form />; }
        const where = "/settings/" + String(Math.random());
        export const tree = <Route path={where} element={<Settings />} />;
      `),
    );
    expect(unit.routeInfo).toBeUndefined();
    expect(unit.unreadBinding).toContain("not written as a string literal");
  });

  it("abstains on every route a nested tree hangs under an unreadable path", () => {
    const units = unitsOf(
      makeFile(`
        import { Route } from "react-router-dom";
        function Detail() { return <li />; }
        const base = "/tenants/" + String(Math.random());
        export const tree = (
          <Route path={base}>
            <Route path=":id" element={<Detail />} />
          </Route>
        );
      `),
    );
    expect(units.map((u) => u.routeInfo)).toEqual([undefined]);
    expect(units[0].unreadBinding).toContain("nested under");
  });

  it("abstains on a spread standing in for routes declared elsewhere", () => {
    const units = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        import { extra } from "./extra";
        function Home() { return <main />; }
        export const router = createBrowserRouter([
          { path: "/", element: <Home /> },
          ...extra,
        ]);
      `),
    );
    const spread = units.find((u) => u.unreadBinding !== undefined);
    expect(spread?.unreadBinding).toContain("A spread stands in for routes");
    expect(units.some((u) => u.routeInfo?.path === "/")).toBe(true);
  });

  it("abstains on a route object a call builds", () => {
    const [unit] = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        import { buildRoute } from "./build";
        export const router = createBrowserRouter([buildRoute("/x")]);
      `),
    );
    expect(unit.routeInfo).toBeUndefined();
    expect(unit.unreadBinding).toContain("built by a call");
  });

  it("abstains when the routes a router is created from are not an array here", () => {
    const [unit] = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        import { routes } from "./routes-elsewhere";
        export const router = createBrowserRouter(routes);
      `),
    );
    expect(unit.unreadBinding).toContain("not written as an array literal");
  });

  it("says nothing extra about route elements handed to the router through createRoutesFromElements", () => {
    const file = makeFile(`
      import { createBrowserRouter, createRoutesFromElements, Route } from "react-router-dom";
      function Home() { return <main />; }
      export const router = createBrowserRouter(
        createRoutesFromElements(<Route path="/" element={<Home />} />),
      );
    `);
    expect(routesOf(file)).toEqual(["GET /"]);
  });

  it("reports a route whose element is computed as a boundary with nothing behind it", () => {
    const [unit] = unitsOf(
      makeFile(`
        import { Route } from "react-router-dom";
        import { pick } from "./pick";
        export const tree = <Route path="/x" element={pick()} />;
      `),
    );
    expect(unit.routeInfo).toEqual({ method: "GET", path: "/x" });
    expect(unit.func).toBeNull();
    expect(unit.announcedAt).toBeDefined();
  });

  it("produces nothing for a route that renders nothing", () => {
    const file = makeFile(`
      import { Route } from "react-router-dom";
      export const tree = <Route path="/x" />;
    `);
    expect(unitsOf(file)).toEqual([]);
  });

  it("reads the component a route renders through parentheses and casts", () => {
    const units = unitsOf(
      makeFile(`
        import { createBrowserRouter, Route } from "react-router-dom";
        function Profile() { return <form />; }
        function Audit() { return <table />; }
        export const tree = <Route path="/profile" element={(<Profile />)} />;
        export const router = createBrowserRouter([
          { path: "/audit", element: (<Audit />) as unknown },
        ]);
      `),
    );
    expect(units.map((u) => `${u.name} ${u.routeInfo?.path}`).sort()).toEqual([
      "Audit /audit",
      "Profile /profile",
    ]);
    expect(units.every((u) => u.func !== null)).toBe(true);
  });

  it("names an abstention after the component a route renders in parentheses", () => {
    const [unit] = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        function Team() { return <ul />; }
        const where = "/team/" + String(Math.random());
        export const router = createBrowserRouter([{ path: where, element: (<Team />) }]);
      `),
    );
    expect(unit.name).toBe("Team");
    expect(unit.unreadBinding).toContain("not written as a string literal");
  });

  it("serves nothing for a route whose index reads false, and keeps the routes inside it", () => {
    const file = makeFile(`
      import { Route } from "react-router-dom";
      function List() { return <ul />; }
      function Board() { return <section />; }
      function Columns() { return <ol />; }
      export const tree = (
        <Route path="/projects">
          <Route index={true} element={<List />} />
          <Route index={false} element={<Board />}>
            <Route path="board" element={<Columns />} />
          </Route>
        </Route>
      );
    `);
    expect(routesOf(file)).toEqual(["GET /projects", "GET /projects/board"]);
  });

  it("reads a route object's index flag through a cast", () => {
    const file = makeFile(`
      import { createBrowserRouter } from "react-router-dom";
      function Overview() { return <p />; }
      function Draft() { return <p />; }
      export const router = createBrowserRouter([
        {
          path: "/billing",
          children: [
            { index: true as const, element: <Overview /> },
            { index: false, element: <Draft /> },
          ],
        },
      ]);
    `);
    expect(routesOf(file)).toEqual(["GET /billing"]);
  });

  it("announces a spread where the collection it unpacks is written, through a cast", () => {
    const units = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        import { extra, more } from "./extra";
        export const router = createBrowserRouter([...extra, ...(more as never[])]);
      `),
    );
    expect(units.map((u) => [u.name, u.announcedAt?.getText()])).toEqual([
      ["extra", "extra"],
      ["more", "more"],
    ]);
  });

  it("labels a value it cannot read by the name under a cast, or else by its source text", () => {
    const units = unitsOf(
      makeFile(`
        import { createBrowserRouter } from "react-router-dom";
        import { routes, settings } from "./elsewhere";
        export const one = createBrowserRouter(routes as never);
        export const two = createBrowserRouter([
          { path: "/settings", children: settings.routes },
        ]);
      `),
    );
    expect(units.map((u) => u.name)).toEqual(["routes", "settings.routes"]);
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
    // forever.
    expect(warnings.join("")).not.toContain("overflowed the call stack");
    expect(summaries.map((s) => s.identity.name)).toEqual(["Home"]);
  }, 60_000);
});
