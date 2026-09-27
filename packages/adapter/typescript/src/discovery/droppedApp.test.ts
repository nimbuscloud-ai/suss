// The router is mounted on the served app at "/api" and on a second app at
// "/t". Two mounts that disagree compose to no prefix, so "/ping" means the
// second mount was kept and "/api/ping" means it was dropped.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

function packFor(
  name: string,
  importName: string,
  mountMethod: string,
): PatternPack {
  return {
    name,
    protocol: "http",
    languages: ["typescript"],
    discovery: [
      {
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: name,
          importName,
          registrationChain: [".get", ".post"],
        },
        bindingExtraction: {
          method: { type: "fromRegistration", position: "methodName" },
          path: { type: "fromArgument", position: 0 },
        },
        mount: { method: mountMethod, prefixPosition: 0, targetPosition: 1 },
        requiresImport: [name],
      },
    ],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
  };
}

const expressLike = packFor("express", "express", "use");
const honoLike = packFor("hono", "Hono", "route");

function pathsOf(summaries: BehavioralSummary[]): string[] {
  return summaries
    .map((s) => {
      const sem = s.identity.boundaryBinding?.semantics;
      return sem?.name === "rest" ? sem.path : null;
    })
    .filter((p): p is string => p !== null)
    .sort();
}

async function pathsFor(pack: PatternPack, source: string): Promise<string[]> {
  const project = createTestProject();
  project.createSourceFile("/app.ts", source);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [pack],
    cacheDir: null,
  });
  return pathsOf(await adapter.extractAll());
}

const EXPRESS_HEAD = `
  import express from "express";
  declare function serve(app: unknown): void;
  declare const ready: boolean;
  export let outer: unknown;
  const app = express();
  const orders = express();
  orders.get("/ping", (req, res) => { res.json({}); });
  app.use("/api", orders);
`;

/** A function building a second app and mounting `orders` on it at "/t", then `body`. */
function withTestApp(
  body: string,
  signature = "function buildTestApp(holder: any, apps: any[])",
): string {
  return `${EXPRESS_HEAD}
  ${signature} {
    const testApp = express();
    testApp.use("/t", orders);
    ${body}
  }`;
}

describe("a mount on an app that never leaves the function that built it", () => {
  it("claims only the served app's path when the function drops the app", async () => {
    expect(await pathsFor(expressLike, withTestApp(""))).toEqual(["/api/ping"]);
  });

  it("drops a Hono mount the same way", async () => {
    const source = `
      import { Hono } from "hono";
      const app = new Hono();
      const orders = new Hono();
      orders.get("/ping", (c) => c.json({}));
      app.route("/api", orders);
      function buildTestApp() {
        const testApp = new Hono();
        testApp.route("/t", orders);
      }
    `;
    expect(await pathsFor(honoLike, source)).toEqual(["/api/ping"]);
  });

  it.each([
    [
      "registers a route of its own on the app",
      'testApp.get("/health", (req, res) => { res.json({}); });',
    ],
    ["writes to a part of the app", 'testApp.locals.title = "orders";'],
    ["compares the app", "if (testApp === undefined) { return; }"],
  ])("drops the mount when the function %s", async (_, body) => {
    const paths = await pathsFor(expressLike, withTestApp(body));
    expect(paths).toContain("/api/ping");
    expect(paths).not.toContain("/ping");
  });

  it.each([
    ["returns the app", "return testApp;"],
    ["returns the app in an object", "return { testApp };"],
    ["returns the app under a key of an object", "return { app: testApp };"],
    ["returns the app in an array", "return [testApp];"],
    ["exports the app through module.exports", "module.exports = testApp;"],
    ["puts the app on globalThis", "(globalThis as any).app = testApp;"],
    ["pushes the app onto a list", "apps.push(testApp);"],
    ["hands the app to a call", "serve(testApp);"],
    ["hands the app to a construction", "new Map([[1, testApp]]);"],
    ["returns a closure that captures the app", "return () => testApp;"],
    [
      "passes a closure that captures the app",
      "setTimeout(() => serve(testApp));",
    ],
    ["runs a method the pack does not register with", "testApp.listen(3000);"],
    ["calls the app itself", "testApp(holder, holder);"],
    [
      "binds the app to a second name",
      "const served = testApp; return served;",
    ],
    ["writes the app to an outer name", "outer = testApp;"],
    ["writes the app to a parameter's property", "holder.app = testApp;"],
    ["writes the app under a key", 'apps["t"] = testApp;'],
    ["returns the app from a conditional", "return ready ? testApp : null;"],
    ["returns the app after &&", "return ready && testApp;"],
    ["returns the app as a fallback", "return holder || testApp;"],
    [
      "gives the app to a nested function as a default",
      "function inner(a = testApp) { return a; } return inner;",
    ],
    ["hands a property of the app on", "serve({ fetch: testApp.handle });"],
    ["spreads the app into an object", "return { ...testApp };"],
    ["spreads the app into a call", "serve(...[testApp]);"],
    ["spreads the app as call arguments", "serve(...testApp);"],
    ["spreads the app into an array", "return [...testApp];"],
    [
      "keeps the app in a class field",
      "class Holder { app = testApp; } return Holder;",
    ],
    [
      "keeps the app in a static class field",
      "return class { static app = testApp; };",
    ],
    [
      "returns the result of a method called on the app",
      'return testApp.use("/v", orders);',
    ],
    ["returns the app under a cast", "return testApp as unknown;"],
    ["returns the app with a non-null assertion", "return testApp!;"],
  ])("keeps the mount when the function %s", async (_, body) => {
    expect(await pathsFor(expressLike, withTestApp(body))).toEqual(["/ping"]);
  });

  it("keeps the mount when an async function awaits the app before handing it on", async () => {
    const source = withTestApp(
      "serve(await testApp);",
      "async function buildTestApp()",
    );
    expect(await pathsFor(expressLike, source)).toEqual(["/ping"]);
  });

  it.each([
    ["an attribute", "return <Server app={testApp} />;"],
    ["a spread attribute", "return <Server {...testApp} />;"],
    ["a child", "return <Server>{testApp}</Server>;"],
  ])(
    "keeps the mount when the function hands the app to JSX as %s",
    async (_, body) => {
      const project = createTestProject();
      project.createSourceFile(
        "/app.tsx",
        withTestApp(`${body}`).replace(
          "export let outer: unknown;",
          "export let outer: unknown;\n  declare function Server(props: any): any;",
        ),
      );
      const adapter = createTypeScriptAdapter({
        project,
        frameworks: [expressLike],
        cacheDir: null,
      });
      expect(pathsOf(await adapter.extractAll())).toEqual(["/ping"]);
    },
  );

  it("drops a route registered on an app its function drops", async () => {
    const source = withTestApp(
      'testApp.get("/health", (req, res) => { res.json({}); });',
    );
    expect(await pathsFor(expressLike, source)).toEqual(["/api/ping"]);
  });

  it("drops a Hono route registered on an app its function drops", async () => {
    const source = `
      import { Hono } from "hono";
      function buildTestApp() {
        const testApp = new Hono();
        testApp.get("/health", (c) => c.json({}));
      }
    `;
    expect(await pathsFor(honoLike, source)).toEqual([]);
  });

  it.each([
    ["returns the app", "return testApp;"],
    ["listens on the app", "testApp.listen(3000);"],
    ["hands the app to a call", "serve(testApp);"],
  ])(
    "keeps a route registered on the app when the function %s",
    async (_, body) => {
      const source = withTestApp(
        `testApp.get("/health", (req, res) => { res.json({}); });\n    ${body}`,
      );
      expect(await pathsFor(expressLike, source)).toContain("/health");
    },
  );

  it("keeps a route on a router whose registration result the function returns", async () => {
    const source = `
      import express from "express";
      function buildRouter() {
        const router = express();
        return router.get("/health", (req, res) => { res.json({}); });
      }
    `;
    expect(await pathsFor(expressLike, source)).toEqual(["/health"]);
  });

  it("keeps the mount when a generator yields the app", async () => {
    const source = withTestApp("yield testApp;", "function* buildTestApp()");
    expect(await pathsFor(expressLike, source)).toEqual(["/ping"]);
  });

  it("keeps the mount when a method stores the app on its receiver", async () => {
    const source = `${EXPRESS_HEAD}
      class Boot {
        app: unknown;
        start() {
          const testApp = express();
          testApp.use("/t", orders);
          this.app = testApp;
        }
      }
    `;
    expect(await pathsFor(expressLike, source)).toEqual(["/ping"]);
  });

  it("never drops a mount on a module-level app", async () => {
    const source = `${EXPRESS_HEAD}
      const unused = express();
      unused.use("/t", orders);
    `;
    expect(await pathsFor(expressLike, source)).toEqual(["/ping"]);
  });

  it("never drops a mount on a module-level app the file exports as its default", async () => {
    const source = `${EXPRESS_HEAD}
      const exported = express();
      exported.use("/t", orders);
      export default exported;
    `;
    expect(await pathsFor(expressLike, source)).toEqual(["/ping"]);
  });

  it("keeps the mount when the app is written again", async () => {
    const source = withTestApp("", "function buildTestApp()").replace(
      "const testApp = express();",
      "let testApp = express();\n    if (ready) { testApp = express(); }",
    );
    expect(await pathsFor(expressLike, source)).toEqual(["/ping"]);
  });
});
