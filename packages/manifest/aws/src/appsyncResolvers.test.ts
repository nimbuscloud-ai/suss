// Both authoring shapes of an AppSync API, read for the one question a
// framework pack asks: which Lambda serves this GraphQL field.

import { describe, expect, it } from "vitest";

import { readAppSyncResolvers } from "./appsyncResolvers.js";

import type { CloudFormationTemplate } from "./templateLoader.js";

const samTemplate = (dataSourceCategory: string): CloudFormationTemplate => ({
  Resources: {
    Api: {
      Type: "AWS::Serverless::GraphQLApi",
      Properties: {
        SchemaUri: "schema.graphql",
        DataSources: {
          [dataSourceCategory]: {
            Posts: { FunctionArn: { "Fn::GetAtt": ["PostsFunction", "Arn"] } },
          },
          DynamoDb: { Comments: { TableName: "comments" } },
        },
        Functions: {
          InvokePosts: { DataSource: "Posts" },
          InvokeComments: { DataSource: "Comments" },
        },
        Resolvers: {
          Query: {
            posts: { Pipeline: ["InvokePosts"] },
            comments: { Pipeline: ["InvokeComments"] },
          },
          Mutation: {
            addPost: { DataSource: "Posts" },
          },
        },
      },
    },
  },
});

describe("readAppSyncResolvers", () => {
  it("follows a pipeline resolver to the Lambda behind its data source", () => {
    const bindings = readAppSyncResolvers(samTemplate("Lambda"));

    expect(bindings).toContainEqual({
      typeName: "Query",
      fieldName: "posts",
      lambdaFunctionLogicalId: "PostsFunction",
    });
  });

  it("follows a unit resolver that names its data source directly", () => {
    const bindings = readAppSyncResolvers(samTemplate("Lambda"));

    expect(bindings).toContainEqual({
      typeName: "Mutation",
      fieldName: "addPost",
      lambdaFunctionLogicalId: "PostsFunction",
    });
  });

  it("reads the plural category spelling too", () => {
    // SAM takes Lambda and Lambdas, and real templates use both.
    expect(readAppSyncResolvers(samTemplate("Lambdas"))).toEqual(
      readAppSyncResolvers(samTemplate("Lambda")),
    );
  });

  it("reports a field with no Lambda behind it", () => {
    const bindings = readAppSyncResolvers(samTemplate("Lambda"));
    const comments = bindings.find((b) => b.fieldName === "comments");

    expect(comments?.lambdaFunctionLogicalId).toBeNull();
  });

  it("reads raw AppSync resources", () => {
    const bindings = readAppSyncResolvers({
      Resources: {
        PostsSource: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            Type: "AWS_LAMBDA",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["PostsFunction", "Arn"] },
            },
          },
        },
        PostsResolver: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            TypeName: "Query",
            FieldName: "posts",
            DataSourceName: { Ref: "PostsSource" },
          },
        },
      },
    });

    expect(bindings).toEqual([
      {
        typeName: "Query",
        fieldName: "posts",
        lambdaFunctionLogicalId: "PostsFunction",
      },
    ]);
  });

  it("says nothing about a template with no AppSync in it", () => {
    expect(
      readAppSyncResolvers({
        Resources: {
          Fn: { Type: "AWS::Serverless::Function", Properties: {} },
        },
      }),
    ).toEqual([]);
  });

  it("skips malformed blocks rather than throwing", () => {
    expect(
      readAppSyncResolvers({
        Resources: {
          Api: {
            Type: "AWS::Serverless::GraphQLApi",
            Properties: {
              DataSources: { Lambda: "not-a-record" },
              Resolvers: "not-a-record",
            },
          },
        },
      }),
    ).toEqual([]);
  });
});
