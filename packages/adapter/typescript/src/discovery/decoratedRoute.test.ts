import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { discoverDecoratedRoutes } from "./decoratedRoute.js";

import type { DiscoveryPattern } from "@suss/extractor";

const MATCH: Extract<DiscoveryPattern["match"], { type: "decoratedRoute" }> = {
  type: "decoratedRoute",
  importModule: "@acme/web",
  classDecorators: ["Controller"],
  methodDecoratorRouteMap: { Get: "GET" },
  statusCodeConstants: { "Status.GONE": 410 },
  declaredStatuses: {
    importModule: "@acme/docs",
    decorators: { Responds: null, RespondsMissing: 404 },
    statusKey: "status",
  },
};

function declaredStatusesIn(source: string): Record<string, unknown> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/@acme/web/index.d.ts",
    `export const Controller: (...args: unknown[]) => ClassDecorator;
     export const Get: (...args: unknown[]) => MethodDecorator;`,
  );
  project.createSourceFile(
    "/node_modules/@acme/docs/index.d.ts",
    `export const Responds: (options: { status: unknown }) => MethodDecorator & ClassDecorator;
     export const RespondsMissing: () => MethodDecorator & ClassDecorator;`,
  );
  const file = project.createSourceFile("/invoices.ts", source);
  const units = discoverDecoratedRoutes(
    file,
    MATCH,
    "handler",
    new ResolutionStore(),
  );
  return Object.fromEntries(
    units.map((unit) => [unit.name, unit.declaredStatuses ?? []]),
  );
}

describe("statuses a route's decorators declare", () => {
  it("reads them from the method and the class, by a fixed status or one in the options", () => {
    expect(
      declaredStatusesIn(`
        import { Controller, Get } from "@acme/web";
        import { Responds, RespondsMissing as Missing } from "@acme/docs";
        import { Status } from "@acme/web";
        const CONFLICT = 409;
        declare const picked: number;

        @Missing()
        @Controller("invoices")
        export class Invoices {
          @Responds({ status: 200 })
          @Responds({ status: CONFLICT })
          @Responds({ status: Status.GONE })
          @Responds({ status: picked })
          @Get(":id")
          show() { return {}; }

          @Get()
          list() { return []; }
        }
      `),
    ).toEqual({
      "Invoices.show": [200, 404, 409, 410],
      "Invoices.list": [404],
    });
  });

  it("leaves them out when the file imports none of the decorators", () => {
    expect(
      declaredStatusesIn(`
        import { Controller, Get } from "@acme/web";
        declare const Responds: (options: unknown) => MethodDecorator;

        @Controller("invoices")
        export class Invoices {
          @Responds({ status: 200 })
          @Get()
          list() { return []; }
        }
      `),
    ).toEqual({ "Invoices.list": [] });
  });
});
