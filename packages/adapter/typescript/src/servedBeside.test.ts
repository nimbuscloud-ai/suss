import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readServedBesideMetadata } from "@suss/behavioral-ir";
import { createFixtureProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";
import { pathToRegexpSource } from "./servedBeside.js";

import type { ServedBesideEntry } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

function matches(pattern: string, path: string): boolean {
  const source = pathToRegexpSource(pattern);
  if (source === null) {
    throw new Error(`${pattern} did not read`);
  }
  return new RegExp(source).test(path);
}

describe("a Next.js matcher read as a regular expression", () => {
  it("leaves out the paths a negative lookahead names", () => {
    const matcher = "/((?!api/|_next/|favicon.ico).*)";

    expect(matches(matcher, "/orders/7")).toBe(true);
    expect(matches(matcher, "/")).toBe(true);
    expect(matches(matcher, "/api/orders/7")).toBe(false);
    expect(matches(matcher, "/favicon.ico")).toBe(false);
  });

  it("takes the slash before a parameter that repeats or is optional along with it", () => {
    expect(matches("/docs/:path*", "/docs")).toBe(true);
    expect(matches("/docs/:path*", "/docs/a/b")).toBe(true);
    expect(matches("/docs/:path+", "/docs")).toBe(false);
    expect(matches("/docs/:path+", "/docs/a")).toBe(true);
    expect(matches("/docs/:lang?", "/docs")).toBe(true);
    expect(matches("/docs/:lang?", "/docs/en")).toBe(true);
    expect(matches("/docs/:lang?", "/docs/en/intro")).toBe(false);
  });

  it("keeps a parameter's own expression and an escaped character", () => {
    expect(matches("/blog/:slug(\\d+)", "/blog/42")).toBe(true);
    expect(matches("/blog/:slug(\\d+)", "/blog/hello")).toBe(false);
    expect(matches("/a\\.b/(x|y)", "/a.b/y")).toBe(true);
  });

  it("does not read a brace group or a group left open", () => {
    expect(pathToRegexpSource("/blog{/:post}?")).toBeNull();
    expect(pathToRegexpSource("/blog/(a|b")).toBeNull();
  });
});

const routeTerminals: PatternPack["terminals"] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
];

/** A file-convention framework stating what it serves beside its routes, as the Next.js pack does. */
const nextLike: PatternPack = {
  name: "shop-next",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: {
        type: "fileConvention",
        filePattern: "**/app/**/route.{ts,js}",
        exportNames: ["GET", "POST"],
      },
      bindingExtraction: {
        method: { type: "fromExportName" },
        path: {
          type: "fromFilename",
          root: "app",
          dropBasenames: ["route", "page"],
          dynamic: "brackets",
        },
      },
    },
    {
      kind: "handler",
      match: {
        type: "fileConvention",
        filePattern: "**/pages/api/**/*.{ts,js}",
        exportNames: ["default"],
      },
      bindingExtraction: {
        method: { type: "literal", value: "*" },
        path: {
          type: "fromFilename",
          root: "pages",
          dropBasenames: ["index"],
          dynamic: "brackets",
        },
      },
    },
  ],
  terminals: routeTerminals,
  inputMapping: { type: "positionalParams", params: [] },
  servedBeside: {
    pages: [
      {
        filePattern: "**/app/**/page.{tsx,jsx}",
        path: {
          type: "fromFilename",
          root: "app",
          dropBasenames: ["route", "page"],
          dynamic: "brackets",
        },
      },
      {
        filePattern: "**/app/**/sitemap.ts",
        path: { type: "fromFilename", root: "app", dynamic: "brackets" },
        suffixed: true,
      },
    ],
    staticDirectories: ["public"],
    config: {
      files: ["shop.config.ts"],
      rules: [
        { key: "rewrites", by: "rewrite" },
        { key: "redirects", by: "redirect" },
      ],
      unread: ["basePath"],
    },
    middleware: {
      files: ["middleware.ts"],
      export: "config",
      property: "matcher",
    },
    patternSyntax: "pathToRegexp",
  },
};

const ROUTE = "export async function GET() { return Response.json({}); }\n";

let made: string[] = [];

afterEach(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  made = [];
});

/** What the pack states beside its routes for a project written from these files. */
async function statedFor(
  files: Record<string, string>,
  pack: PatternPack = nextLike,
): Promise<ServedBesideEntry[] | undefined> {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-served-beside-")),
  );
  made.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const adapter = createTypeScriptAdapter({
    project: createFixtureProject(root, "**/*.ts", "**/*.tsx"),
    frameworks: [pack],
    projectRoot: root,
  });
  const summaries = await adapter.extractAll();
  const route = summaries.find(
    (summary) => readServedBesideMetadata(summary) !== undefined,
  );
  return route === undefined
    ? undefined
    : readServedBesideMetadata(route)?.entries.map((entry) => ({
        ...entry,
        file: path.relative(root, entry.file),
      }));
}

describe("what a file-convention framework serves beside its routes", () => {
  it("lists its pages, its metadata files, its public files, its config's rules and its matcher", async () => {
    const entries = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "app/orders/[id]/page.tsx":
        "export default function Page() { return null; }\n",
      "app/sitemap.ts": "export default function sitemap() { return []; }\n",
      "public/robots.txt": "",
      "shop.config.ts": `
        const config = {
          async rewrites() {
            return {
              beforeFiles: [{ source: "/old/:path*", destination: "/new/:path*" }],
              fallback: [{ source: "/((?!api/).*)", destination: "https://old.example.com" }],
            };
          },
          async redirects() {
            return [{ source: "/home", destination: "/", permanent: true }];
          },
        };
        export default config;
      `,
      "middleware.ts": `
        export const config = { matcher: ["/account/:path*", { source: "/admin/:path*" }] };
        export default function middleware() { return undefined; }
      `,
    });

    expect(
      entries?.map((entry) => [entry.by, entry.path ?? entry.pattern]),
    ).toEqual([
      ["page", "/orders/{id}"],
      ["page", "/sitemap{suffix*}"],
      ["static", "/robots.txt"],
      ["rewrite", "/old/:path*"],
      ["rewrite", "^\\/(?:(?:(?!api/).*))\\/?$"],
      ["redirect", "/home"],
      ["middleware", "/account/:path*"],
      ["middleware", "/admin/:path*"],
    ]);
  });

  it("covers every path when the config moves every route, spreads a key, or is wrapped in a call", async () => {
    const moved = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "shop.config.ts": `export default { basePath: "/docs" };\n`,
    });
    const spread = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "shop.config.ts": "const base = {};\nexport default { ...base };\n",
    });
    const wrapped = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "shop.config.ts": `import { withPlugin } from "plugin";\nexport default withPlugin({});\n`,
    });

    expect(moved?.map((entry) => entry.by)).toEqual(["unread"]);
    expect(spread?.map((entry) => entry.by)).toEqual(["unread"]);
    expect(wrapped?.map((entry) => entry.by)).toEqual(["unread"]);
  });

  it("covers every path for a rule list it cannot read and a middleware with no matcher", async () => {
    const entries = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "shop.config.ts": `
        const paths = ["/a"];
        export default {
          async rewrites() { return paths.map((source) => ({ source, destination: "/" })); },
          async redirects() { return [{ source: process.env.FROM, destination: "/" }]; },
        };
      `,
      "middleware.ts":
        "export default function middleware() { return undefined; }\n",
    });

    expect(entries?.map((entry) => [entry.by, entry.path ?? null])).toEqual([
      ["unread", null],
      ["unread", null],
      ["middleware", "/{path*}"],
    ]);
  });

  it("covers the path of a route file it read no route from, and the method of an export that gave none", async () => {
    const entries = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "app/api/session/route.ts": `
        import { makeHandlers } from "auth-kit";
        export const { GET, POST } = makeHandlers();
      `,
      "app/api/teams/route.ts": `
        import { makeHandlers } from "auth-kit";
        export async function GET() { return Response.json({}); }
        export const { POST } = makeHandlers();
      `,
      "pages/api/confirm.ts": `export { default } from "../../lib/confirm";\n`,
      "lib/confirm.ts": `
        export default function confirm(req, res) { return res.json({}); }
      `,
    });

    expect(
      entries?.map((entry) => [entry.by, entry.path, entry.methods ?? null]),
    ).toEqual([
      ["unread", "/api/session", null],
      ["unread", "/api/teams", ["POST"]],
      ["unread", "/api/confirm", null],
    ]);
  });

  it("reads the route and page files the program leaves out where its routes and pages are", async () => {
    // The project these tests build takes only `.ts` and `.tsx` files.
    const entries = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "app/api/legacy/route.js": "export async function POST() {}\n",
      "app/about/page.jsx": "export default function About() {}\n",
      "pages/api/new.ts": "export default function handler() {}\n",
      "pages/api/old.js": "export default function handler() {}\n",
      "scripts/app/route.js": "export async function GET() {}\n",
    });

    expect(
      entries?.map((entry) => [entry.by, entry.path, entry.methods ?? null]),
    ).toEqual([
      ["page", "/about", ["GET", "HEAD"]],
      ["unread", "/api/legacy", null],
      ["unread", "/api/old", null],
    ]);
  });

  it("says nothing for a pack that recognized no route", async () => {
    expect(
      await statedFor({ "lib/panel.ts": "export const x = 1;\n" }),
    ).toBeUndefined();
  });
});

/** A router framework stating which of its libraries serve requests when mounted, as the Express pack does. */
const expressLike: PatternPack = {
  name: "shop-express",
  protocol: "http",
  languages: ["typescript"],
  discovery: ["Router", "express"].map((importName) => ({
    kind: "handler",
    match: {
      type: "registrationCall" as const,
      importModule: "express",
      importName,
      registrationChain: [".get"],
    },
    bindingExtraction: {
      method: {
        type: "fromRegistration" as const,
        position: "methodName" as const,
      },
      path: { type: "fromArgument" as const, position: 0 },
    },
    mount: { method: "use", prefixPosition: 0, targetPosition: 1 },
    requiresImport: ["express"],
  })),
  terminals: routeTerminals,
  inputMapping: { type: "positionalParams", params: [] },
  servedBeside: {
    servingCalls: [
      { module: "express", names: ["static"], by: "static" },
      {
        module: "http-proxy-middleware",
        names: ["createProxyMiddleware"],
        by: "proxy",
      },
    ],
  },
};

describe("what a router framework's mounts serve beside its routes", () => {
  it("lists static servers, proxies and mounts it cannot follow, and leaves plain middleware and the routers it mounts out", async () => {
    const entries = await statedFor(
      {
        "src/server.ts": `
          import express, { Router } from "express";
          import cors from "cors";
          import { createProxyMiddleware } from "http-proxy-middleware";
          import { legacyRoutes } from "./legacy";
          import reports from "./not-written";

          const app = express();
          const orders = Router();
          orders.get("/:id", (req, res) => res.json({}));

          function authenticate(req, res, next) { next(); }

          export function mountAll(prefix: string) {
            app.use(cors());
            app.use(express.static("public"));
            app.use("/api/orders", authenticate, orders);
            app.use("/assets", express.static("assets"));
            app.use("/proxy", createProxyMiddleware({ target: "http://backend" }));
            app.use("/legacy", legacyRoutes());
            app.use("/reports", reports);
            app.use(prefix, orders);
            app.listen(3000);
          }
        `,
        "src/legacy.ts": `
          import { Router } from "express";
          export function legacyRoutes() { return Router(); }
        `,
      },
      expressLike,
    );

    expect(
      entries?.map((entry) => [
        entry.by,
        entry.path ?? null,
        entry.methods ?? null,
      ]),
    ).toEqual([
      ["static", "/{path*}", ["GET", "HEAD"]],
      ["static", "/assets/{path*}", ["GET", "HEAD"]],
      ["proxy", "/proxy/{path*}", null],
      ["mount", "/reports/{path*}", null],
      ["mount", null, null],
    ]);
  });
});
