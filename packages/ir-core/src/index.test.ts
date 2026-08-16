import { describe, expect, it } from "vitest";

import {
  type BoundaryBinding,
  functionCallBinding,
  graphqlOperationBinding,
  graphqlResolverBinding,
  messageBusBinding,
  packageExportBinding,
  restBinding,
  runtimeConfigBinding,
  storageBinding,
  TypeShapeSchema,
} from "./index.js";

describe("binding constructors", () => {
  it("restBinding uppercases the method and keeps the three-layer shape", () => {
    const b: BoundaryBinding = restBinding({
      transport: "http",
      method: "get",
      path: "/users/:id",
      recognition: "express",
    });
    expect(b).toEqual({
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/users/:id" },
      recognition: "express",
    });
  });

  it("restBinding carries declaredResponses when provided", () => {
    const b = restBinding({
      transport: "http",
      method: "GET",
      path: "/x",
      recognition: "openapi",
      declaredResponses: [200, 404],
    });
    expect(b.semantics).toMatchObject({ declaredResponses: [200, 404] });
  });

  it("functionCallBinding omits optional identity fields when unset", () => {
    const b = functionCallBinding({
      transport: "in-process",
      recognition: "react",
    });
    expect(b.semantics).toEqual({ name: "function-call" });
  });

  it("functionCallBinding carries every optional identity field when set", () => {
    const b = functionCallBinding({
      transport: "in-process",
      recognition: "ts",
      module: "./components/Button",
      exportName: "Button",
      package: "@acme/ui",
      exportPath: ["components", "Button"],
    });
    expect(b.semantics).toEqual({
      name: "function-call",
      module: "./components/Button",
      exportName: "Button",
      package: "@acme/ui",
      exportPath: ["components", "Button"],
    });
  });

  it("graphqlOperationBinding carries the operation name when set, omits it when not", () => {
    const named = graphqlOperationBinding({
      transport: "http",
      recognition: "apollo-client",
      operationType: "query",
      operationName: "GetUser",
    });
    expect(named.semantics).toEqual({
      name: "graphql-operation",
      operationType: "query",
      operationName: "GetUser",
    });
    const anon = graphqlOperationBinding({
      transport: "http",
      recognition: "apollo-client",
      operationType: "mutation",
    });
    expect(anon.semantics).toEqual({
      name: "graphql-operation",
      operationType: "mutation",
    });
  });

  it("packageExportBinding defaults transport to in-process and carries the export path", () => {
    const b = packageExportBinding({
      recognition: "package-exports",
      packageName: "@suss/ir-core",
      exportPath: ["restBinding"],
    });
    expect(b).toEqual({
      transport: "in-process",
      semantics: {
        name: "function-call",
        package: "@suss/ir-core",
        exportPath: ["restBinding"],
      },
      recognition: "package-exports",
    });
  });

  it("graphqlResolverBinding binds typeName.fieldName", () => {
    const b = graphqlResolverBinding({
      transport: "http",
      recognition: "apollo",
      typeName: "Query",
      fieldName: "user",
    });
    expect(b.semantics).toEqual({
      name: "graphql-resolver",
      typeName: "Query",
      fieldName: "user",
    });
  });

  it("runtimeConfigBinding uses the os transport", () => {
    const b = runtimeConfigBinding({
      recognition: "cfn",
      deploymentTarget: "lambda",
      instanceName: "OrderProducer",
    });
    expect(b.transport).toBe("os");
    expect(b.semantics).toMatchObject({
      name: "runtime-config",
      deploymentTarget: "lambda",
    });
  });

  it("storageBinding uses the storage system as transport", () => {
    const b = storageBinding({
      recognition: "prisma",
      storageSystem: "postgres",
      scope: "default",
      container: "User",
    });
    expect(b.transport).toBe("postgres");
    expect(b.semantics).toMatchObject({
      name: "storage",
      container: "User",
    });
  });

  it("messageBusBinding uses the bus as transport and carries the channel", () => {
    const b = messageBusBinding({
      recognition: "sqs",
      messageBus: "sqs",
      channel: "OrdersQueue",
    });
    expect(b).toEqual({
      transport: "sqs",
      semantics: {
        name: "message-bus",
        messageBus: "sqs",
        channel: "OrdersQueue",
      },
      recognition: "sqs",
    });
  });
});

describe("TypeShapeSchema", () => {
  it("parses a nested record shape (recursion holds)", () => {
    const shape = {
      type: "record",
      properties: {
        id: { type: "text" },
        nested: {
          type: "record",
          properties: { count: { type: "integer" } },
        },
      },
    };
    expect(TypeShapeSchema.parse(shape)).toEqual(shape);
  });

  it("rejects an unknown shape kind", () => {
    expect(() => TypeShapeSchema.parse({ type: "not-a-shape" })).toThrow();
  });
});
