// Both ways of writing an AppSync API, read for the one question a
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
    // An auth step running ahead of the one that loads the data is
    // common, and nothing in the template says which is which.
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

  it("keeps two APIs apart when both name a data source the same", () => {
    // Names are unique per API, not per template, so a public and an
    // admin API can each have one called posts. The template says which
    // API each resource belongs to, so both resolve.
    const bindings = readAppSyncResolvers({
      Resources: {
        PublicPostsDS: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            ApiId: { Ref: "PublicApi" },
            Type: "AWS_LAMBDA",
            Name: "posts",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["PublicPostsFn", "Arn"] },
            },
          },
        },
        AdminPostsDS: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            ApiId: { Ref: "AdminApi" },
            Type: "AWS_LAMBDA",
            Name: "posts",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["AdminPostsFn", "Arn"] },
            },
          },
        },
        PublicPostsResolver: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "PublicApi" },
            TypeName: "Query",
            FieldName: "posts",
            DataSourceName: "posts",
          },
        },
        AdminPostsResolver: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "AdminApi" },
            TypeName: "Query",
            FieldName: "allPosts",
            DataSourceName: "posts",
          },
        },
      },
    });

    expect(bindings).toEqual([
      {
        typeName: "Query",
        fieldName: "posts",
        lambdaFunctionLogicalIds: ["PublicPostsFn"],
      },
      {
        typeName: "Query",
        fieldName: "allPosts",
        lambdaFunctionLogicalIds: ["AdminPostsFn"],
      },
    ]);
  });

  it("keeps two APIs apart when both name a pipeline function the same", () => {
    const bindings = readAppSyncResolvers({
      Resources: {
        PublicDS: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            ApiId: { Ref: "PublicApi" },
            Type: "AWS_LAMBDA",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["PublicFn", "Arn"] },
            },
          },
        },
        AdminDS: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            ApiId: { Ref: "AdminApi" },
            Type: "AWS_LAMBDA",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["AdminFn", "Arn"] },
            },
          },
        },
        PublicInvoke: {
          Type: "AWS::AppSync::FunctionConfiguration",
          Properties: {
            ApiId: { Ref: "PublicApi" },
            Name: "invoke",
            DataSourceName: { Ref: "PublicDS" },
          },
        },
        AdminInvoke: {
          Type: "AWS::AppSync::FunctionConfiguration",
          Properties: {
            ApiId: { Ref: "AdminApi" },
            Name: "invoke",
            DataSourceName: { Ref: "AdminDS" },
          },
        },
        PublicResolver: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "PublicApi" },
            TypeName: "Query",
            FieldName: "posts",
            PipelineConfig: { Functions: ["invoke"] },
          },
        },
      },
    });

    expect(bindings[0]?.lambdaFunctionLogicalIds).toEqual(["PublicFn"]);
  });

  it("prefers a logical id over a name another data source uses", () => {
    const bindings = readAppSyncResolvers({
      Resources: {
        PostsDS: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            Type: "AWS_LAMBDA",
            Name: "posts",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["PostsFn", "Arn"] },
            },
          },
        },
        CommentsDS: {
          Type: "AWS::AppSync::DataSource",
          Properties: {
            Type: "AWS_LAMBDA",
            Name: "PostsDS",
            LambdaConfig: {
              LambdaFunctionArn: { "Fn::GetAtt": ["CommentsFn", "Arn"] },
            },
          },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            TypeName: "Query",
            FieldName: "posts",
            DataSourceName: "PostsDS",
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
