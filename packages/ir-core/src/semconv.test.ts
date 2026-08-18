import { describe, expect, it } from "vitest";

import {
  functionCallBinding,
  graphqlOperationBinding,
  messageBusBinding,
  restBinding,
  semconvAttributes,
  storageBinding,
} from "./index.js";

describe("semconvAttributes", () => {
  it("reads a store under the database attributes", () => {
    expect(
      semconvAttributes(
        storageBinding({
          recognition: "prisma",
          storageSystem: "postgresql",
          scope: "orders",
          container: "users",
        }),
      ),
    ).toEqual({
      "db.system.name": "postgresql",
      "db.namespace": "orders",
      "db.collection.name": "users",
    });
  });

  it("leaves out a container the source never named", () => {
    const attributes = semconvAttributes(
      storageBinding({
        recognition: "aws-dynamodb",
        storageSystem: "aws.dynamodb",
        scope: "default",
        container: null,
      }),
    );
    expect(attributes).toEqual({ "db.system.name": "aws.dynamodb" });
  });

  it("leaves out the default scope, which no span states", () => {
    const attributes = semconvAttributes(
      storageBinding({
        recognition: "aws-dynamodb",
        storageSystem: "aws.dynamodb",
        scope: "default",
        container: "Orders",
      }),
    );
    expect(attributes["db.namespace"]).toBeUndefined();
  });

  it("reads a queue under the messaging attributes", () => {
    expect(
      semconvAttributes(
        messageBusBinding({
          recognition: "aws-sqs",
          messageBus: "aws_sqs",
          channel: "order-events",
        }),
      ),
    ).toEqual({
      "messaging.system": "aws_sqs",
      "messaging.destination.name": "order-events",
    });
  });

  it("reads a route under http.route and the method beside it", () => {
    expect(
      semconvAttributes(
        restBinding({
          transport: "http",
          recognition: "express",
          method: "get",
          path: "/users/:id",
        }),
      ),
    ).toEqual({
      "http.request.method": "GET",
      "http.route": "/users/:id",
    });
  });

  it("leaves out a method that stands for every method", () => {
    const attributes = semconvAttributes(
      restBinding({
        transport: "http",
        recognition: "aws-apigateway",
        method: "*",
        path: "/users",
      }),
    );
    expect(attributes).toEqual({ "http.route": "/users" });
  });

  it("reads a GraphQL operation under the graphql attributes", () => {
    expect(
      semconvAttributes(
        graphqlOperationBinding({
          transport: "http",
          recognition: "apollo",
          operationType: "query",
          operationName: "GetUser",
        }),
      ),
    ).toEqual({
      "graphql.operation.type": "query",
      "graphql.operation.name": "GetUser",
    });
  });

  it("says nothing for a boundary nobody crosses at run time", () => {
    expect(
      semconvAttributes(
        functionCallBinding({
          transport: "in-process",
          recognition: "react",
          module: "./components/Button",
          exportName: "Button",
        }),
      ),
    ).toEqual({});
  });
});
