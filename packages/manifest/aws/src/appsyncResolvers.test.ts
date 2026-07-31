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
      lambdaFunctionLogicalIds: ["PostsFunction"],
    });
  });

  it("follows a unit resolver that names its data source directly", () => {
    const bindings = readAppSyncResolvers(samTemplate("Lambda"));

    expect(bindings).toContainEqual({
      typeName: "Mutation",
      fieldName: "addPost",
      lambdaFunctionLogicalIds: ["PostsFunction"],
    });
  });

  it("reads the plural category spelling too", () => {
    // SAM takes Lambda and Lambdas, and both turn up in practice.
    expect(readAppSyncResolvers(samTemplate("Lambdas"))).toEqual(
      readAppSyncResolvers(samTemplate("Lambda")),
    );
  });

  it("reports a field with no Lambda behind it", () => {
    const bindings = readAppSyncResolvers(samTemplate("Lambda"));
    const comments = bindings.find((b) => b.fieldName === "comments");

    expect(comments?.lambdaFunctionLogicalIds).toEqual([]);
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
        lambdaFunctionLogicalIds: ["PostsFunction"],
      },
    ]);
  });

  it("reports every Lambda a pipeline runs, in order", () => {
    // An auth step ahead of the one that loads the data is the common
    // shape, and nothing in the template says which is which.
    const bindings = readAppSyncResolvers({
      Resources: {
        Api: {
          Type: "AWS::Serverless::GraphQLApi",
          Properties: {
            DataSources: {
              Lambda: {
                CheckAuth: {
                  FunctionArn: { "Fn::GetAtt": ["AuthFn", "Arn"] },
                },
                LoadPosts: {
                  FunctionArn: { "Fn::GetAtt": ["PostsFn", "Arn"] },
                },
              },
            },
            Functions: {
              Auth: { DataSource: "CheckAuth" },
              Load: { DataSource: "LoadPosts" },
            },
            Resolvers: {
              Query: { posts: { Pipeline: ["Auth", "Load"] } },
            },
          },
        },
      },
    });

    expect(bindings).toEqual([
      {
        typeName: "Query",
        fieldName: "posts",
        lambdaFunctionLogicalIds: ["AuthFn", "PostsFn"],
      },
    ]);
  });

  it("follows a raw pipeline resolver through its function configurations", () => {
    // This is also what the SAM transform expands the shorthand into.
    const bindings = readAppSyncResolvers({
      Resources: {
        PostsDS: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            Type: "AWS_LAMBDA",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["PostsFn", "Arn"] },
            },
          },
        },
        InvokePosts: {
          Type: "AWS::AppSync::FunctionConfiguration",
          Properties: { DataSourceName: { "Fn::GetAtt": ["PostsDS", "Name"] } },
        },
        PostsResolver: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            TypeName: "Query",
            FieldName: "posts",
            Kind: "PIPELINE",
            PipelineConfig: {
              Functions: [{ "Fn::GetAtt": ["InvokePosts", "FunctionId"] }],
            },
          },
        },
      },
    });

    expect(bindings).toEqual([
      {
        typeName: "Query",
        fieldName: "posts",
        lambdaFunctionLogicalIds: ["PostsFn"],
      },
    ]);
  });

  it("finds a data source named by its Name rather than its logical id", () => {
    const bindings = readAppSyncResolvers({
      Resources: {
        PostsDataSource: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            Type: "AWS_LAMBDA",
            Name: "posts_lambda",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["PostsFn", "Arn"] },
            },
          },
        },
        PostsResolver: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            TypeName: "Query",
            FieldName: "posts",
            DataSourceName: "posts_lambda",
          },
        },
      },
    });

    expect(bindings[0]?.lambdaFunctionLogicalIds).toEqual(["PostsFn"]);
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
