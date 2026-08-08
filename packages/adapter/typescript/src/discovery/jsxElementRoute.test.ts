import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { discoverUnits } from "./index.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";

const PATTERN: DiscoveryPattern = {
  kind: "component",
  match: {
    type: "jsxElementRoute",
    importModule: ["router-lib"],
    routeElement: "Route",
    pathAttribute: "path",
    elementAttribute: "element",
    indexAttribute: "index",
    childrenAttribute: "children",
    routeObjectFactories: ["createRouter"],
    elementsFactories: ["routesFromElements"],
    method: "GET",
  },
};

function makeProject(): Project {
  return createTestProject();
}

function makeFile(source: string): SourceFile {
  return makeProject().createSourceFile("routes.tsx", source);
}

function routesOf(file: SourceFile): string[] {
  return discoverUnits(file, [PATTERN], new ResolutionStore())
    .map((u) =>
      u.routeInfo === undefined
        ? `${u.name} (no route)`
        : `${u.routeInfo.method} ${u.routeInfo.path}`,
    )
    .sort();
}

describe("jsxElementRoute discovery", () => {
  it("reads a route element's path and the component it renders", () => {
    const file = makeFile(`
      import { Route } from "router-lib";
      function Users() { return <ul />; }
      export const tree = <Route path="/users" element={<Users />} />;
    `);
    const [unit] = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(unit.routeInfo).toEqual({ method: "GET", path: "/users" });
    expect(unit.name).toBe("Users");
    expect(unit.func).not.toBeNull();
  });

  it("joins a nested route's path onto its parent's, and gives an index route the parent's path", () => {
    const file = makeFile(`
      import { Route } from "router-lib";
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
      import { Route } from "router-lib";
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
      import { Route as Screen } from "router-lib";
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
      import { createRouter } from "router-lib";
      function Home() { return <main />; }
      function Billing() { return <aside />; }
      const routes = [
        { path: "/", element: <Home /> },
        { path: "/billing", element: <Billing /> },
      ];
      export const router = createRouter(routes);
    `);
    expect(routesOf(file)).toEqual(["GET /", "GET /billing"]);
  });

  it("reads routes nested under a route object, joining their paths onto its own", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      function Shell() { return <div />; }
      function Overview() { return <p />; }
      function Invoice() { return <dl />; }
      function Lines() { return <tbody />; }
      export const router = createRouter([
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
    const project = makeProject();
    const objects = project.createSourceFile(
      "objects.tsx",
      `
      import { createRouter } from "router-lib";
      function Detail() { return <li />; }
      export const router = createRouter([
        { path: "/users", children: [{ path: ":id", element: <Detail /> }] },
      ]);
    `,
    );
    const elements = project.createSourceFile(
      "elements.tsx",
      `
      import { Route } from "router-lib";
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
      import { createRouter } from "router-lib";
      function Help() { return <p />; }
      export const router = createRouter([
        { path: "/users", children: [{ path: "/help", element: <Help /> }] },
      ]);
    `);
    expect(routesOf(file)).toEqual(["GET /help"]);
  });

  it("abstains on every route nested under a path built at runtime", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      function Detail() { return <li />; }
      const base = "/tenants/" + String(1);
      export const router = createRouter([
        { path: base, children: [{ path: ":id", element: <Detail /> }] },
      ]);
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(units.map((u) => u.routeInfo)).toEqual([undefined]);
    expect(units[0].unreadBinding).toContain("nested under");
  });

  it("abstains on a children array it cannot read, keeping the route above it", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      import { childRoutes } from "./children";
      function Shell() { return <div />; }
      export const router = createRouter([
        { path: "/billing", element: <Shell />, children: childRoutes },
      ]);
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(units.map((u) => u.routeInfo?.path)).toEqual([
      "/billing",
      undefined,
    ]);
    expect(units[1].unreadBinding).toContain("nested under this one");
  });

  it("abstains on a spread inside a children array", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      import { more } from "./more";
      function Shell() { return <div />; }
      function Overview() { return <p />; }
      export const router = createRouter([
        {
          path: "/billing",
          element: <Shell />,
          children: [{ index: true, element: <Overview /> }, ...more],
        },
      ]);
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(units.map((u) => u.routeInfo?.path)).toEqual([
      "/billing",
      "/billing",
      undefined,
    ]);
    expect(units[2].unreadBinding).toContain("A spread stands in for routes");
  });

  it("reads one array of routes under each route that nests it", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      function Shell() { return <div />; }
      function Overview() { return <p />; }
      const shared = [{ path: "overview", element: <Overview /> }];
      export const router = createRouter([
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
    const file = makeFile(`
      import { Route } from "router-lib";
      function Settings() { return <form />; }
      const where = "/settings/" + String(1);
      export const tree = <Route path={where} element={<Settings />} />;
    `);
    const [unit] = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(unit.routeInfo).toBeUndefined();
    expect(unit.unreadBinding).toContain("not written as a string literal");
  });

  it("abstains on every route a nested tree hangs under an unreadable path", () => {
    const file = makeFile(`
      import { Route } from "router-lib";
      function Detail() { return <li />; }
      const base = "/tenants/" + String(1);
      export const tree = (
        <Route path={base}>
          <Route path=":id" element={<Detail />} />
        </Route>
      );
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(units.map((u) => u.routeInfo)).toEqual([undefined]);
    expect(units[0].unreadBinding).toContain("nested under");
  });

  it("abstains on a spread standing in for routes declared elsewhere", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      import { extra } from "./extra";
      function Home() { return <main />; }
      export const router = createRouter([
        { path: "/", element: <Home /> },
        ...extra,
      ]);
    `);
    const units = discoverUnits(file, [PATTERN], new ResolutionStore());
    const spread = units.find((u) => u.unreadBinding !== undefined);
    expect(spread?.unreadBinding).toContain("A spread stands in for routes");
    expect(units.some((u) => u.routeInfo?.path === "/")).toBe(true);
  });

  it("abstains on a route object a call builds", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      import { buildRoute } from "./build";
      export const router = createRouter([buildRoute("/x")]);
    `);
    const [unit] = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(unit.routeInfo).toBeUndefined();
    expect(unit.unreadBinding).toContain("built by a call");
  });

  it("abstains when the routes a router is created from are not an array here", () => {
    const file = makeFile(`
      import { createRouter } from "router-lib";
      import { routes } from "./routes-elsewhere";
      export const router = createRouter(routes);
    `);
    const [unit] = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(unit.unreadBinding).toContain("not written as an array literal");
  });

  it("says nothing extra about route elements handed to the factory through the library's own call", () => {
    const file = makeFile(`
      import { createRouter, Route, routesFromElements } from "router-lib";
      function Home() { return <main />; }
      export const router = createRouter(
        routesFromElements(<Route path="/" element={<Home />} />),
      );
    `);
    expect(routesOf(file)).toEqual(["GET /"]);
  });

  it("reports a route whose element is computed as a boundary with nothing behind it", () => {
    const file = makeFile(`
      import { Route } from "router-lib";
      import { pick } from "./pick";
      export const tree = <Route path="/x" element={pick()} />;
    `);
    const [unit] = discoverUnits(file, [PATTERN], new ResolutionStore());
    expect(unit.routeInfo).toEqual({ method: "GET", path: "/x" });
    expect(unit.func).toBeNull();
    expect(unit.announcedAt).toBeDefined();
  });

  it("produces nothing for a route that renders nothing", () => {
    const file = makeFile(`
      import { Route } from "router-lib";
      export const tree = <Route path="/x" />;
    `);
    expect(discoverUnits(file, [PATTERN], new ResolutionStore())).toEqual([]);
  });
});
