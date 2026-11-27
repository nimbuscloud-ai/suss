import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { afterEach, describe, expect, it } from "vitest";

import { readServedBesideMetadata } from "@suss/behavioral-ir";
import { testCompilerOptions } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";
import { pathToRegexpSource } from "./servedBeside.js";

import type { ServedBesideEntry } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { CompilerOptions } from "ts-morph";

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
      files: ["shop.config.ts", "shop.config.mjs", "shop.config.js"],
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
  compilerOptions: CompilerOptions = {},
): Promise<ServedBesideEntry[] | undefined> {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-served-beside-")),
  );
  made.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { ...testCompilerOptions, ...compilerOptions },
  });
  project.addSourceFilesAtPaths([
    path.join(root, "**/*.ts"),
    path.join(root, "**/*.tsx"),
  ]);
  const adapter = createTypeScriptAdapter({
    project,
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
      "shop.config.ts": `import { base } from "shared-config";\nexport default { ...base };\n`,
    });
    const wrapped = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "shop.config.ts": `import { withPlugin } from "plugin";\nexport default withPlugin({});\n`,
    });

    expect(moved?.map((entry) => entry.by)).toEqual(["unread"]);
    expect(spread?.map((entry) => entry.by)).toEqual(["unread"]);
    expect(wrapped?.map((entry) => entry.by)).toEqual(["unread"]);
  });

  it("reads past a spread that cannot route a request, and not past one in a rule", async () => {
    const entries = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "shop.config.ts": `
        import { shared, legacy } from "shared-config";
        const common = { reactStrictMode: true };
        export default {
          ...common,
          images: { ...shared.images },
          env: { ...shared.env },
          webpack(config) {
            return { ...config, resolve: { ...config.resolve } };
          },
          async headers() {
            return [...shared.headers];
          },
          async rewrites() {
            return [{ ...legacy, source: "/old/:path*" }];
          },
          async redirects() {
            return [{ source: "/home", destination: "/", permanent: true }];
          },
        };
      `,
    });

    expect(entries?.map((entry) => [entry.by, entry.path ?? null])).toEqual([
      ["unread", null],
      ["redirect", "/home"],
    ]);
  });

  it("keeps a rule a host, a header or a cookie decides as serving its path", async () => {
    const entries = await statedFor({
      "app/api/orders/route.ts": ROUTE,
      "shop.config.ts": `
        export default {
          async redirects() {
            return [
              {
                source: "/docs/:path*",
                has: [{ type: "host", value: "docs.example.com" }],
                destination: "https://example.com/docs/:path*",
                permanent: false,
              },
            ];
          },
          async rewrites() {
            return [
              {
                source: "/beta/:path*",
                missing: [{ type: "cookie", key: "stable" }],
                destination: "/preview/:path*",
              },
            ];
          },
        };
      `,
    });

    expect(entries?.map((entry) => [entry.by, entry.path])).toEqual([
      ["rewrite", "/beta/:path*"],
      ["redirect", "/docs/:path*"],
    ]);
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

  it("reads a JavaScript config in a program that does not allow JavaScript", async () => {
    const config = `
      import { legacy } from "./legacy.mjs";
      const config = {
        async rewrites() {
          return [{ source: "/old/:path*", destination: "/new/:path*" }, legacy];
        },
      };
      export default config;
    `;
    const legacy = `export const legacy = { source: "/legacy", destination: "/" };\n`;
    const typesOnly = { allowJs: false };
    const module = await statedFor(
      {
        "app/api/orders/route.ts": ROUTE,
        "shop.config.mjs": config,
        "legacy.mjs": legacy,
      },
      nextLike,
      typesOnly,
    );
    const script = await statedFor(
      {
        "app/api/orders/route.ts": ROUTE,
        "shop.config.js": config,
        "legacy.mjs": legacy,
      },
      nextLike,
      typesOnly,
    );

    const read = [
      ["rewrite", "/old/:path*"],
      ["rewrite", "/legacy"],
    ];
    expect(module?.map((entry) => [entry.by, entry.path])).toEqual(read);
    expect(script?.map((entry) => [entry.by, entry.path])).toEqual(read);
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
    inert: ["listen"],
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

describe("where an app the pack builds goes", () => {
  const withRunner: PatternPack = {
    ...expressLike,
    servedBeside: {
      ...expressLike.servedBeside,
      runners: [
        {
          origin: "imported",
          importedFrom: ["node:http"],
          named: ["createServer"],
        },
      ],
    },
  };

  /** Each entry that covers any path, by what the source writes there and the methods it covers. */
  const unread = (entries: readonly ServedBesideEntry[] | undefined) =>
    (entries ?? [])
      .filter((entry) => entry.by === "unread")
      .map((entry) => [entry.written ?? null, entry.methods ?? null])
      .sort();

  it("covers any path wherever the app meets code suss does not read", async () => {
    const entries = await statedFor(
      {
        "src/server.ts": `
          import express from "express";
          import { mountDocs, wrap, describe } from "docs-kit";

          export const app = express();
          app.get("/orders", (req, res) => res.json({}));
          app.frontend("/");
          mountDocs(app);
          export const served = wrap(app);
          app.router.use(wrap);
          describe(app.title);
        `,
        "src/legacy.ts": `
          import { app } from "./server";

          app.get("/legacy", (req, res) => res.json({}));
        `,
      },
      withRunner,
    );

    expect(unread(entries)).toEqual([
      ["app.frontend", null],
      ["app.get", ["GET"]],
      ["app.router.use", null],
      ["app.title", null],
      ["mountDocs", null],
      ["wrap", null],
    ]);
  });

  it("leaves out a listed method, a runner and the project's own function", async () => {
    const entries = await statedFor(
      {
        "src/server.ts": `
          import http from "node:http";
          import express, { type Express } from "express";

          const app = express();
          app.get("/orders", (req, res) => res.json({}));

          function addHealth(server: Express) {
            server.get("/health", (req, res) => res.json({ ok: true }));
          }

          addHealth(app);
          http.createServer(app);
          app.listen(3000);
        `,
      },
      withRunner,
    );

    expect(unread(entries)).toEqual([]);
  });
});
