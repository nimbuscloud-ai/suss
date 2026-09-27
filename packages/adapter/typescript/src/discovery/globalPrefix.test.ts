import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import {
  agreedGlobalPrefix,
  type GlobalPrefix,
  globalPrefixesIn,
  globalPrefixKey,
  pathUnderGlobalPrefix,
} from "./globalPrefix.js";
import { buildMountPrefixIndex } from "./mountPrefix.js";

import type { GlobalPrefixCall, PatternPack } from "@suss/extractor";

const CALL: GlobalPrefixCall = {
  method: "setGlobalPrefix",
  application: {
    importModule: "@acme/web",
    importName: "AppFactory",
    factory: "create",
  },
  exclude: {
    option: "exclude",
    pathKey: "path",
    methodKey: "method",
    methods: { 0: "GET", 1: "POST", 5: "*" },
  },
};

const LIBRARY = `
  export declare enum Verb { GET = 0, POST = 1, ALL = 5 }
  export interface App { setGlobalPrefix(prefix: string, options?: unknown): void }
  export declare class AppFactory { static create(module: unknown): Promise<App>; }
`;

function projectWith(files: Record<string, string>) {
  const project = createTestProject();
  project.createSourceFile("/node_modules/@acme/web/index.d.ts", LIBRARY);
  const sourceFiles = Object.entries(files).map(([path, text]) =>
    project.createSourceFile(path, text),
  );
  return { project, sourceFiles };
}

function prefixesIn(files: Record<string, string>): Array<GlobalPrefix | null> {
  const { sourceFiles } = projectWith(files);
  const store = new ResolutionStore();
  return sourceFiles.flatMap((file) => globalPrefixesIn(file, CALL, store));
}

describe("globalPrefixesIn", () => {
  it("reads a prefix set on the app the factory made, with its exclusions", () => {
    expect(
      prefixesIn({
        "/main.ts": `
          import { AppFactory, Verb } from "@acme/web";
          const SKIPPED = ["/health"];
          export async function boot() {
            const app = await AppFactory.create({});
            app.setGlobalPrefix("api", {
              exclude: [...SKIPPED, { path: "export", method: Verb.GET }, { path: "all", method: Verb.ALL }],
            });
          }
        `,
      }),
    ).toEqual([
      {
        prefix: "api",
        excluded: [
          { path: "/health", method: null },
          { path: "export", method: "GET" },
          { path: "all", method: null },
        ],
      },
    ]);
  });

  it("follows the app into a function in another file every caller hands it to", () => {
    expect(
      prefixesIn({
        "/configure.ts": `
          export function configure(app: { setGlobalPrefix(p: string): void }) {
            app.setGlobalPrefix("v1");
          }
        `,
        "/api.ts": `
          import { AppFactory } from "@acme/web";
          import { configure } from "./configure";
          export async function boot() { configure(await AppFactory.create({})); }
        `,
        "/worker.ts": `
          import { AppFactory } from "@acme/web";
          import { configure } from "./configure";
          export async function boot() {
            const app = await AppFactory.create({});
            configure(app);
          }
        `,
      }),
    ).toEqual([{ prefix: "v1", excluded: [] }]);
  });

  it("leaves a call alone on anything else, including a parameter one caller hands something else", () => {
    expect(
      prefixesIn({
        "/configure.ts": `
          export function configure(app: { setGlobalPrefix(p: string): void }) {
            app.setGlobalPrefix("v1");
          }
        `,
        "/main.ts": `
          import { AppFactory } from "@acme/web";
          import { configure } from "./configure";
          declare const other: { setGlobalPrefix(p: string): void };
          export async function boot() {
            configure(await AppFactory.create({}));
            configure(other);
            other.setGlobalPrefix("nope");
          }
        `,
      }),
    ).toEqual([]);
  });

  it("reads the default an environment variable falls back to", () => {
    expect(
      prefixesIn({
        "/main.ts": `
          import { AppFactory } from "@acme/web";
          const PREFIX = process.env.API_PREFIX ?? "api";
          export async function boot() {
            const app = await AppFactory.create({});
            app.setGlobalPrefix(PREFIX);
          }
        `,
      }),
    ).toEqual([{ prefix: "api", excluded: [] }]);
  });

  it("gives null for a prefix that does not read as one string", () => {
    expect(
      prefixesIn({
        "/main.ts": `
          import { AppFactory } from "@acme/web";
          export async function boot(prefix: string) {
            const app = await AppFactory.create({});
            app.setGlobalPrefix(prefix);
          }
        `,
      }),
    ).toEqual([null]);
  });
});

describe("agreedGlobalPrefix", () => {
  const api = { prefix: "api", excluded: [] };

  it("takes the prefix every call agrees on", () => {
    expect(agreedGlobalPrefix([api, { ...api }])).toEqual(api);
  });

  it("takes none when calls disagree, one cannot be read, or there are none", () => {
    expect(agreedGlobalPrefix([api, { prefix: "v2", excluded: [] }])).toBe(
      null,
    );
    expect(agreedGlobalPrefix([api, null])).toBe(null);
    expect(agreedGlobalPrefix([])).toBe(null);
  });
});

describe("pathUnderGlobalPrefix", () => {
  const prefix: GlobalPrefix = {
    prefix: "/api/",
    excluded: [
      { path: "health", method: null },
      { path: "users/:id", method: "GET" },
      { path: "static/(.*)", method: null },
      { path: "files/{*rest}", method: null },
    ],
  };

  it("puts the prefix in front of a route, and of the root", () => {
    expect(pathUnderGlobalPrefix(prefix, "GET", "/orders")).toBe("/api/orders");
    expect(pathUnderGlobalPrefix(prefix, "GET", "/")).toBe("/api");
  });

  it("leaves out an excluded path, for its method alone when one is given", () => {
    expect(pathUnderGlobalPrefix(prefix, "GET", "/health")).toBe("/health");
    expect(pathUnderGlobalPrefix(prefix, "GET", "/users/:userId")).toBe(
      "/users/:userId",
    );
    expect(pathUnderGlobalPrefix(prefix, "DELETE", "/users/:id")).toBe(
      "/api/users/:id",
    );
    expect(pathUnderGlobalPrefix(prefix, "GET", "/users/me")).toBe(
      "/api/users/me",
    );
  });

  it("leaves out everything under an excluded wildcard", () => {
    expect(pathUnderGlobalPrefix(prefix, "GET", "/static/a/b")).toBe(
      "/static/a/b",
    );
    expect(pathUnderGlobalPrefix(prefix, "GET", "/files/x")).toBe("/files/x");
    expect(pathUnderGlobalPrefix(prefix, "GET", "/stat")).toBe("/api/stat");
  });

  it("changes nothing with no prefix or an empty one", () => {
    expect(pathUnderGlobalPrefix(null, "GET", "/orders")).toBe("/orders");
    expect(
      pathUnderGlobalPrefix({ prefix: "/", excluded: [] }, "GET", "/orders"),
    ).toBe("/orders");
  });
});

describe("the global prefix in the mount prefix index", () => {
  const pack = {
    name: "acme",
    discovery: [
      {
        kind: "handler",
        match: {
          type: "decoratedRoute",
          importModule: "@acme/web",
          classDecorators: ["Controller"],
          methodDecoratorRouteMap: { Get: "GET" },
          globalPrefix: CALL,
        },
      },
    ],
  } as unknown as PatternPack;
  const key = globalPrefixKey(CALL);

  function indexFor(prefix: string) {
    const { sourceFiles } = projectWith({
      "/main.ts": `
        import { AppFactory } from "@acme/web";
        export async function boot() {
          const app = await AppFactory.create({});
          app.setGlobalPrefix(${JSON.stringify(prefix)});
        }
      `,
    });
    return buildMountPrefixIndex(
      new Map(sourceFiles.map((file) => [file, [pack]])),
      new ResolutionStore(),
    );
  }

  it("answers the pattern's key, and says when the prefix changed", () => {
    const index = indexFor("api");
    expect(index.globalPrefixFor?.(key)).toEqual({
      prefix: "api",
      excluded: [],
    });
    const recorded = index.prefixForId?.(key);
    expect(indexFor("api").prefixForId?.(key)).toBe(recorded);
    expect(indexFor("v2").prefixForId?.(key)).not.toBe(recorded);
  });
});
