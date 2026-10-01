import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { discoverDecoratedRoutes } from "./decoratedRoute.js";
import { buildMountPrefixIndex } from "./mountPrefix.js";
import {
  type AppVersioning,
  agreedVersioning,
  routeVersioningKey,
  versioningIn,
  versioningOf,
  versionSegmentsOf,
} from "./routeVersioning.js";

import type {
  DiscoveryPattern,
  PatternPack,
  RouteVersioning,
} from "@suss/extractor";

const VERSIONING: RouteVersioning = {
  option: "version",
  decorator: "Version",
  neutral: "EVERY_VERSION",
  call: {
    method: "useVersions",
    application: {
      importModule: "@acme/web",
      importName: "AppFactory",
      factory: "create",
    },
  },
  typeKey: "type",
  types: { "Placement.URL": "path", "Placement.HEADER": "outsidePath" },
  typeNumbers: { 0: "path", 1: "outsidePath" },
  defaultType: "path",
  pathPrefix: { key: "prefix", default: "v" },
  defaultVersionKey: "defaultVersion",
};

const LIBRARY = `
  export declare enum Placement { URL = 0, HEADER = 1 }
  export declare const EVERY_VERSION: unique symbol;
  export interface App { useVersions(options?: unknown): void }
  export declare class AppFactory { static create(module: unknown): Promise<App>; }
  export const Controller: (...args: unknown[]) => ClassDecorator;
  export const Get: (...args: unknown[]) => MethodDecorator;
  export const Version: (version: unknown) => MethodDecorator;
`;

const MATCH = {
  type: "decoratedRoute",
  importModule: "@acme/web",
  classDecorators: ["Controller"],
  methodDecoratorRouteMap: { Get: "GET" },
  versioning: VERSIONING,
} as const;

const PACK = {
  name: "acme",
  discovery: [{ kind: "handler", match: MATCH }],
} as unknown as PatternPack;

function projectWith(files: Record<string, string>) {
  const project = createTestProject();
  project.createSourceFile("/node_modules/@acme/web/index.d.ts", LIBRARY);
  return Object.entries(files).map(([path, text]) =>
    project.createSourceFile(path, text),
  );
}

function appVersioningOf(files: Record<string, string>): AppVersioning {
  const store = new ResolutionStore();
  return agreedVersioning(
    projectWith(files).map((file) =>
      versioningIn(file, VERSIONING, ["@acme/web"], store),
    ),
  );
}

function bootWith(call: string): Record<string, string> {
  return {
    "/main.ts": `
      import { AppFactory, Placement } from "@acme/web";
      export async function boot(picked: Placement) {
        const app = await AppFactory.create({});
        ${call}
      }
    `,
  };
}

/** Every route the files declare, as `name: METHOD path`. */
function routesIn(files: Record<string, string>): string[] {
  const sourceFiles = projectWith(files);
  const store = new ResolutionStore();
  const index = buildMountPrefixIndex(
    new Map(sourceFiles.map((file) => [file, [PACK]])),
    store,
  );
  return sourceFiles
    .flatMap((file) =>
      discoverDecoratedRoutes(
        file,
        MATCH as Extract<DiscoveryPattern["match"], { type: "decoratedRoute" }>,
        "handler",
        store,
        undefined,
        index,
      ),
    )
    .map(
      (unit) =>
        `${unit.name}: ${unit.routeInfo?.method} ${unit.routeInfo?.path}`,
    )
    .sort();
}

describe("versioningIn and agreedVersioning", () => {
  it("reads the placement, the prefix and the default version", () => {
    expect(
      appVersioningOf(
        bootWith(
          `app.useVersions({ type: Placement.URL, prefix: "ver", defaultVersion: ["1", "2"] });`,
        ),
      ),
    ).toEqual({
      kind: "on",
      placement: "path",
      pathPrefix: "ver",
      defaultVersion: { kind: "listed", versions: ["1", "2"] },
    });
  });

  it("takes the default placement for a call with no options, and no text for a false prefix", () => {
    expect(appVersioningOf(bootWith("app.useVersions();"))).toEqual({
      kind: "on",
      placement: "path",
      pathPrefix: "v",
      defaultVersion: { kind: "unstated" },
    });
    expect(
      appVersioningOf(
        bootWith("app.useVersions({ type: Placement.HEADER, prefix: false });"),
      ),
    ).toMatchObject({ placement: "outsidePath", pathPrefix: "" });
  });

  it("is off when the run makes an application and nothing turns versioning on", () => {
    expect(appVersioningOf(bootWith("void app;"))).toEqual({ kind: "off" });
  });

  it("is unread with no application in the run, a placement that does not read, or calls that disagree", () => {
    expect(appVersioningOf({ "/other.ts": "export const x = 1;" })).toEqual({
      kind: "unread",
    });
    expect(
      appVersioningOf(bootWith("app.useVersions({ type: picked });")),
    ).toEqual({ kind: "unread" });
    expect(appVersioningOf(bootWith("app.useVersions(picked);"))).toEqual({
      kind: "unread",
    });
    expect(
      appVersioningOf(
        bootWith(
          "app.useVersions({ type: Placement.URL }); app.useVersions({ type: Placement.HEADER });",
        ),
      ),
    ).toEqual({ kind: "unread" });
  });

  it("reads a call on an app the run cannot follow back to the factory", () => {
    expect(
      appVersioningOf({
        "/configure.ts": `
          import { Placement } from "@acme/web";
          export function configure(app: { useVersions(options?: unknown): void }) {
            app.useVersions({ type: Placement.HEADER });
          }
        `,
        "/main.ts": `
          import { AppFactory } from "@acme/web";
          import { configure } from "./configure";
          declare function testApp(): { useVersions(options?: unknown): void };
          export async function boot() {
            configure(await AppFactory.create({}));
            configure(testApp());
          }
        `,
      }),
    ).toMatchObject({ kind: "on", placement: "outsidePath" });
  });
});

describe("versionSegmentsOf", () => {
  const uri: AppVersioning = {
    kind: "on",
    placement: "path",
    pathPrefix: "v",
    defaultVersion: { kind: "listed", versions: ["1"] },
  };

  it("gives one segment per version, none for every version, and the default for a route that states none", () => {
    expect(
      versionSegmentsOf(uri, { kind: "listed", versions: ["2", null, "2"] }),
    ).toEqual(["v2", null]);
    expect(versionSegmentsOf(uri, { kind: "unstated" })).toEqual(["v1"]);
  });

  it("gives no segment when the version is outside the path or versioning is off", () => {
    const header: AppVersioning = { ...uri, placement: "outsidePath" };
    expect(
      versionSegmentsOf(header, { kind: "listed", versions: ["2"] }),
    ).toEqual([null]);
    expect(
      versionSegmentsOf({ kind: "off" }, { kind: "listed", versions: ["2"] }),
    ).toEqual([null]);
  });

  it("gives null for a version that does not read, or a stated version under unread versioning", () => {
    expect(versionSegmentsOf(uri, { kind: "unread" })).toBe(null);
    expect(
      versionSegmentsOf(
        { kind: "unread" },
        { kind: "listed", versions: ["2"] },
      ),
    ).toBe(null);
    expect(
      versionSegmentsOf(
        { kind: "unread" },
        { kind: "listed", versions: [null] },
      ),
    ).toEqual([null]);
    expect(versionSegmentsOf({ kind: "unread" }, { kind: "unstated" })).toEqual(
      [null],
    );
  });
});

describe("versioned routes", () => {
  const controller = `
    import { Controller, EVERY_VERSION, Get, Version } from "@acme/web";
    const SHARED = { path: "invoices", version: "3" };
    declare const built: { path: string };
    declare const picked: string;

    @Controller({ path: "invoices", version: ["1", "2"] })
    export class Invoices {
      @Get() list() { return []; }
      @Version(EVERY_VERSION) @Get("status") status() { return {}; }
      @Version() @Get("bare") bare() { return {}; }
      @Version(picked) @Get("picked") pickedRoute() { return {}; }
    }

    @Controller(SHARED)
    export class Shared { @Get() list() { return []; } }

    @Controller(built)
    export class Built { @Get() list() { return []; } }

    @Controller("receipts")
    export class Receipts { @Get() list() { return []; } }
  `;

  it("puts each version in the path and claims no path for a version that does not read", () => {
    expect(
      routesIn({
        ...bootWith("app.useVersions({ type: Placement.URL });"),
        "/invoices.ts": controller,
      }),
    ).toEqual([
      "Built.list: GET null",
      "Invoices.bare: GET null",
      "Invoices.list: GET /v1/invoices",
      "Invoices.list: GET /v2/invoices",
      "Invoices.pickedRoute: GET null",
      "Invoices.status: GET /invoices/status",
      "Receipts.list: GET /receipts",
      "Shared.list: GET /v3/invoices",
    ]);
  });

  it("records how the application serves versions, so a cached walk sees a change", () => {
    const sourceFiles = projectWith(bootWith("app.useVersions();"));
    const index = buildMountPrefixIndex(
      new Map(sourceFiles.map((file) => [file, [PACK]])),
      new ResolutionStore(),
    );
    const key = routeVersioningKey(VERSIONING);
    expect(versioningOf(index, key)).toMatchObject({ kind: "on" });
    expect(index.prefixForId?.(key)).toContain('"placement":"path"');
    expect(versioningOf(undefined, key)).toEqual({ kind: "unread" });
  });
});
