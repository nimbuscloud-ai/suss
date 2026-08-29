/**
 * A registration that passes a route object, `app.openapi(route, handler)`,
 * where the method and path are properties of that object. Production
 * services keep those objects on a shared contract module and reach them
 * through an import, a property read, and a wrapper call, so each of
 * those hops is covered here.
 */

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { discoverUnits } from "./index.js";

import type { DiscoveryPattern } from "@suss/extractor";

const OPENAPI_DISCOVERY: DiscoveryPattern[] = [
  {
    kind: "handler",
    match: {
      type: "registrationCall",
      importModule: "@hono/zod-openapi",
      importName: "OpenAPIHono",
      registrationChain: [".openapi"],
    },
    bindingExtraction: {
      method: { type: "fromArgumentProperty", position: 0, property: "method" },
      path: { type: "fromArgumentProperty", position: 0, property: "path" },
    },
    requiresImport: ["@hono/zod-openapi"],
  },
];

const WRAPPERS = [
  { callee: "createRoute", argument: 0, module: "@hono/zod-openapi" },
];

const ROUTES = `
  import { createRoute } from "@hono/zod-openapi";
  export const routes = { mint: createRoute({ method: "post", path: "/p" }) };
`;

const EXPECTED = { method: "POST", path: "/p" };

function routeOf(files: Record<string, string>, entry: string) {
  const project = createTestProject();
  const created = Object.entries(files).map(
    ([name, text]) => [name, project.createSourceFile(name, text)] as const,
  );
  const file = created.find(([name]) => name === entry)?.[1];
  if (file === undefined) {
    throw new Error(`no entry file ${entry}`);
  }

  const units = discoverUnits(
    file,
    OPENAPI_DISCOVERY,
    new ResolutionStore(WRAPPERS),
  );
  expect(units).toHaveLength(1);
  return units[0]?.routeInfo;
}

describe("a route object the registration names", () => {
  it("reads it from a name in the same file", () => {
    expect(
      routeOf(
        {
          "/a.ts": `
            import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
            const route = createRoute({ method: "post", path: "/p" });
            export function reg(app: OpenAPIHono) {
              app.openapi(route, async (c) => c.json({}, 200));
            }
          `,
        },
        "/a.ts",
      ),
    ).toEqual(EXPECTED);
  });

  it("reads it from a property of an imported object of routes", () => {
    expect(
      routeOf(
        {
          "/routes.ts": ROUTES,
          "/a.ts": `
            import { OpenAPIHono } from "@hono/zod-openapi";
            import { routes } from "./routes.js";
            export function reg(app: OpenAPIHono) {
              app.openapi(routes.mint, async (c) => c.json({}, 200));
            }
          `,
        },
        "/a.ts",
      ),
    ).toEqual(EXPECTED);
  });

  it("reads it when the app arrives as a parameter typed by a type-only import", () => {
    expect(
      routeOf(
        {
          "/routes.ts": ROUTES,
          "/a.ts": `
            import type { OpenAPIHono } from "@hono/zod-openapi";
            import { routes } from "./routes.js";
            type AppEnv = { Variables: { tenant: string } };
            export function reg(app: OpenAPIHono<AppEnv>) {
              app.openapi(routes.mint, async (c) => c.json({}, 200));
            }
          `,
        },
        "/a.ts",
      ),
    ).toEqual(EXPECTED);
  });

  it("reads it through a barrel that re-exports the routes", () => {
    expect(
      routeOf(
        {
          "/routes.ts": ROUTES,
          "/contract.ts": `export { routes } from "./routes.js";`,
          "/a.ts": `
            import type { OpenAPIHono } from "@hono/zod-openapi";
            import { routes } from "./contract.js";
            export function reg(app: OpenAPIHono) {
              app.openapi(routes.mint, async (c) => c.json({}, 200));
            }
          `,
        },
        "/a.ts",
      ),
    ).toEqual(EXPECTED);
  });
});
