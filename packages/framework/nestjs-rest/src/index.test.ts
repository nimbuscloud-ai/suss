import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { nestjsRestFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — exercise NestJS REST controller decorator shapes
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/nestjs-rest");

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99,
      module: 99,
      moduleResolution: 100,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      skipLibCheck: true,
    },
  });
  // Stub `@nestjs/common` so ts-morph import resolution succeeds.
  // Discovery only needs the decorator names + import module to
  // match — runtime behaviour is irrelevant to static analysis.
  project.createSourceFile(
    "node_modules/@nestjs/common/index.d.ts",
    `export const Controller: (...args: unknown[]) => ClassDecorator;
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
  project.addSourceFilesAtPaths(path.join(fixturesDir, "*.ts"));

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
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the controller fixture
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
