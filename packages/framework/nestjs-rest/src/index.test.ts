import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createDecoratorFixtureProject } from "@suss/test-project";

import { nestjsRestFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project: exercise NestJS REST controller decorator shapes
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/nestjs-rest");

const appFixturesDir = path.resolve(
  __dirname,
  "../../../../fixtures/nestjs-rest-app",
);

async function runAdapter(dir = fixturesDir): Promise<BehavioralSummary[]> {
  const project = createDecoratorFixtureProject(dir, "*.ts");
  // Stub `@nestjs/common` so ts-morph import resolution succeeds.
  // Discovery only needs the decorator names + import module to
  // match: runtime behaviour is irrelevant to static analysis.
  project.createSourceFile(
    path.join(dir, "node_modules/@nestjs/common/index.d.ts"),
    `export declare enum HttpStatus { OK = 200, CREATED = 201, ACCEPTED = 202, NO_CONTENT = 204 }
     export declare enum RequestMethod { GET = 0, POST = 1, PUT = 2, DELETE = 3, PATCH = 4, ALL = 5 }
     export interface INestApplication {
       setGlobalPrefix(prefix: string, options?: { exclude?: Array<string | { path: string; method: RequestMethod }> }): this;
       listen(port: number): Promise<void>;
     }
     export const HttpCode: (status: number) => MethodDecorator;
     export const Controller: (...args: unknown[]) => ClassDecorator;
     export const Get: (...args: unknown[]) => MethodDecorator;
     export const Post: (...args: unknown[]) => MethodDecorator;
     export const Put: (...args: unknown[]) => MethodDecorator;
     export const Delete: (...args: unknown[]) => MethodDecorator;
     export const Patch: (...args: unknown[]) => MethodDecorator;
     export const Options: (...args: unknown[]) => MethodDecorator;
     export const Head: (...args: unknown[]) => MethodDecorator;
     export const All: (...args: unknown[]) => MethodDecorator;
     export const Body: (...args: unknown[]) => ParameterDecorator;
     export const Param: (...args: unknown[]) => ParameterDecorator;
     export const Query: (...args: unknown[]) => ParameterDecorator;
     export const Headers: (...args: unknown[]) => ParameterDecorator;
     export const Req: (...args: unknown[]) => ParameterDecorator;
     export const Request: (...args: unknown[]) => ParameterDecorator;
     export const Res: (...args: unknown[]) => ParameterDecorator;
     export const Response: (...args: unknown[]) => ParameterDecorator;
     export const Next: (...args: unknown[]) => ParameterDecorator;
     export class HttpException { constructor(...args: unknown[]); }
     export class BadRequestException extends HttpException {}`,
  );
  project.createSourceFile(
    path.join(dir, "node_modules/@nestjs/core/index.d.ts"),
    `import type { INestApplication } from "@nestjs/common";
     export declare class NestFactory {
       static create(module: unknown): Promise<INestApplication>;
     }`,
  );

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [nestjsRestFramework()],
    includeReachable: false,
  });

  return await adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Pack-shape sanity
// ---------------------------------------------------------------------------

describe("nestjsRestFramework — pack shape", () => {
  it("declares the expected discovery, terminals, and inputMapping", () => {
    const pack = nestjsRestFramework();
    expect(pack.name).toBe("nestjs-rest");
    expect(pack.languages).toEqual(["typescript"]);
    expect(pack.discovery).toHaveLength(1);
    expect(pack.discovery[0].match.type).toBe("decoratedRoute");
    expect(pack.inputMapping.type).toBe("decoratedParams");
  });

  it("ships only the decorator @nestjs/common declares", () => {
    const match = nestjsRestFramework().discovery[0].match;
    expect(match.type).toBe("decoratedRoute");
    if (match.type === "decoratedRoute") {
      expect(match.classDecorators).toEqual(["Controller"]);
    }
  });

  it("adds the wrapper decorators a project names", () => {
    const match = nestjsRestFramework({
      classDecorators: ["WidgetController"],
    }).discovery[0].match;
    if (match.type === "decoratedRoute") {
      expect(match.classDecorators).toEqual(["Controller", "WidgetController"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: run the adapter against the controller fixture
// ---------------------------------------------------------------------------

describe("nestjsRestFramework — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 60_000);

  it("discovers every HTTP-verb method on the controller", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual([
      "HealthController.ping",
      "ItemsController.archive",
      "ItemsController.remove",
      "ReportsController.summary",
      "UsersController.create",
      "UsersController.list",
      "UsersController.one",
      "UsersController.patch",
      "UsersController.remove",
      "UsersController.update",
    ]);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
      expect(s.identity.boundaryBinding?.recognition).toBe("nestjs-rest");
    }
  });

  it("joins class-prefix and method-suffix into a leading-slash path", () => {
    const list = summaries.find(
      (s) => s.identity.name === "UsersController.list",
    );
    if (!list) {
      throw new Error("list missing");
    }
    expect(list.identity.boundaryBinding?.semantics).toMatchObject({
      name: "rest",
      method: "GET",
      path: "/users",
    });

    const one = summaries.find(
      (s) => s.identity.name === "UsersController.one",
    );
    expect(one?.identity.boundaryBinding?.semantics).toMatchObject({
      method: "GET",
      path: "/users/:id",
    });
  });

  it("keeps a prefix that arrives through an imported constant", () => {
    const summary = summaries.find(
      (s) => s.identity.name === "ReportsController.summary",
    );
    expect(summary?.identity.boundaryBinding?.semantics).toMatchObject({
      name: "rest",
      method: "GET",
      path: "/reports/summary",
    });
  });

  it("maps each verb decorator to the matching HTTP method", () => {
    const verbsByName = Object.fromEntries(
      summaries.map((s) => [
        s.identity.name,
        s.identity.boundaryBinding?.semantics.name === "rest"
          ? s.identity.boundaryBinding.semantics.method
          : null,
      ]),
    );
    expect(verbsByName).toMatchObject({
      "UsersController.list": "GET",
      "UsersController.one": "GET",
      "UsersController.create": "POST",
      "UsersController.update": "PUT",
      "UsersController.patch": "PATCH",
      "UsersController.remove": "DELETE",
      "HealthController.ping": "GET",
    });
  });

  it("gives a method that runs off the end the same 200 as a bare return", () => {
    const outputs = ["ItemsController.remove", "ItemsController.archive"].map(
      (name) => {
        const found = summaries.find((s) => s.identity.name === name);
        if (found === undefined) {
          throw new Error(`${name} missing`);
        }
        return found.transitions.map((t) => t.output);
      },
    );
    const response = [
      {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
      },
    ];
    expect(outputs[0]).toMatchObject(response);
    expect(outputs[1]).toMatchObject(response);
  });

  it("handles bare @Controller() (no prefix) by mounting at root", () => {
    const ping = summaries.find(
      (s) => s.identity.name === "HealthController.ping",
    );
    expect(ping?.identity.boundaryBinding?.semantics).toMatchObject({
      method: "GET",
      path: "/ping",
    });
  });

  it("maps @Body / @Param / @Query / @Headers / @Req to framework roles", () => {
    const create = summaries.find(
      (s) => s.identity.name === "UsersController.create",
    );
    if (!create) {
      throw new Error("create missing");
    }
    const roles = create.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    expect(roles).toEqual(["requestBody", "headers"]);

    const remove = summaries.find(
      (s) => s.identity.name === "UsersController.remove",
    );
    if (!remove) {
      throw new Error("remove missing");
    }
    const removeRoles = remove.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    expect(removeRoles).toEqual(["pathParams", "request"]);
  });
});

describe("nestjsRestFramework: the status a route sends", () => {
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter(appFixturesDir);
  }, 60_000);

  function statusesOf(name: string): unknown[] {
    const found = summaries.find((s) => s.identity.name === name);
    if (found === undefined) {
      throw new Error(`${name} missing`);
    }
    return found.transitions
      .filter((t) => t.output.type === "response")
      .map((t) => (t.output.type === "response" ? t.output.statusCode : null));
  }

  it("sends 201 for a POST and 200 for a GET", () => {
    expect(statusesOf("OrdersController.create")).toEqual([
      { type: "literal", value: 201 },
    ]);
    expect(statusesOf("OrdersController.list")).toEqual([
      { type: "literal", value: 200 },
    ]);
  });

  it("puts the global prefix the bootstrap sets in front of every route it does not exclude", () => {
    const routes = Object.fromEntries(
      summaries
        .filter((s) => s.kind === "handler")
        .map((s) => {
          const semantics = s.identity.boundaryBinding?.semantics;
          return [
            s.identity.name,
            semantics?.name === "rest"
              ? `${semantics.method} ${semantics.path}`
              : null,
          ];
        }),
    );
    expect(routes).toEqual({
      "OrdersController.list": "GET /api/orders",
      "OrdersController.create": "POST /api/orders",
      "OrdersController.importMany": "POST /api/orders/import",
      "OrdersController.replace": "PUT /api/orders/:reference",
      "OrdersController.remove": "DELETE /api/orders/:reference",
      "HealthController.check": "GET /health",
      "HealthController.exportOrders": "GET /orders/export",
      "HealthController.scheduleExport": "POST /api/orders/export",
    });
  });

  it("sends what @HttpCode says, as a literal, a constant or an enum member", () => {
    expect(statusesOf("OrdersController.importMany")).toEqual([
      { type: "literal", value: 200 },
    ]);
    expect(statusesOf("OrdersController.replace")).toEqual([
      { type: "literal", value: 202 },
    ]);
    expect(statusesOf("OrdersController.remove")).toEqual([
      { type: "literal", value: 204 },
    ]);
  });
});
