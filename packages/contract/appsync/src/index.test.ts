import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appsyncFileToSummaries,
  appsyncToSummaries,
  type CfnTemplate,
} from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/appsync");

function restSemanticsOf(
  summary: BehavioralSummary,
): { typeName: string | null; fieldName: string } | null {
  const sem = summary.identity.boundaryBinding?.semantics;
  return sem?.name === "graphql-resolver"
    ? { typeName: sem.typeName, fieldName: sem.fieldName }
    : null;
}

// ---------------------------------------------------------------------------
// Fixture-driven — covers the end-to-end path on a realistic template
// ---------------------------------------------------------------------------

describe("appsyncFileToSummaries — petstore fixture", () => {
  const file = path.join(fixturesDir, "petstore.yaml");
  const summaries = appsyncFileToSummaries(file);

  it("emits one summary per AWS::AppSync::Resolver resource", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["Mutation.createPet", "Query.pet", "Query.pets"]);
    for (const s of summaries) {
      expect(s.kind).toBe("resolver");
    }
  });

  it("binds each resolver via graphql-resolver semantics on aws-https transport", () => {
    const pets = summaries.find((s) => s.identity.name === "Query.pets");
    expect(pets?.identity.boundaryBinding).toEqual({
      transport: "aws-https",
      semantics: {
        name: "graphql-resolver",
        typeName: "Query",
        fieldName: "pets",
      },
      recognition: "appsync",
    });
  });

  it("pulls arg shapes from the SDL for fields that declare them", () => {
    const pet = summaries.find((s) => s.identity.name === "Query.pet");
    expect(pet?.inputs).toEqual([
      {
        type: "parameter",
        name: "id",
        position: 0,
        role: "args",
        shape: { type: "ref", name: "ID!" },
      },
    ]);
    const create = summaries.find(
      (s) => s.identity.name === "Mutation.createPet",
    );
    const argNames = create?.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.name : "?"));
    expect(argNames).toEqual(["name", "species"]);
  });

  it("emits a default success transition with the SDL-declared return shape", () => {
    const pet = summaries.find((s) => s.identity.name === "Query.pet");
    const defaultTxn = pet?.transitions.find((t) => t.isDefault === true);
    expect(defaultTxn?.output.type).toBe("return");
    if (defaultTxn?.output.type === "return") {
      expect(defaultTxn.output.value).toEqual({ type: "ref", name: "Pet" });
    }
  });

  it("emits a throw transition so consumer error-path branches can pair", () => {
    const pets = summaries.find((s) => s.identity.name === "Query.pets");
    const errorTxn = pets?.transitions.find((t) => t.output.type === "throw");
    expect(errorTxn).toBeDefined();
    expect(errorTxn?.isDefault).toBe(false);
  });

  it("carries AppSync provenance metadata on each summary", () => {
    const pets = summaries.find((s) => s.identity.name === "Query.pets");
    const meta = pets?.metadata?.appsync as
      | {
          apiName?: string | null;
          kind?: string;
          authenticationType?: string | null;
          schemaMatched?: boolean;
          schemaSource?: unknown;
        }
      | undefined;
    expect(meta?.apiName).toBe("PetStore");
    expect(meta?.kind).toBe("UNIT");
    expect(meta?.authenticationType).toBe("AMAZON_COGNITO_USER_POOLS");
    expect(meta?.schemaMatched).toBe(true);
    expect(meta?.schemaSource).toEqual({ status: "inline" });
  });
});

// ---------------------------------------------------------------------------
// Hand-crafted inputs — exercise edge cases without a file on disk
// ---------------------------------------------------------------------------

describe("appsyncToSummaries — template shape edge cases", () => {
  function api(overrides: Partial<CfnTemplate["Resources"]> = {}): CfnTemplate {
    return {
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T", AuthenticationType: "API_KEY" },
        },
        Schema: {
          Type: "AWS::AppSync::GraphQLSchema",
          Properties: {
            ApiId: { Ref: "Api" },
            Definition: "type Query { ping: String }",
          },
        },
        ...overrides,
      },
    };
  }

  it("emits nothing when there are no AppSync resolvers", () => {
    const summaries = appsyncToSummaries(api());
    expect(summaries).toEqual([]);
  });

  it("still emits a resolver summary when the SDL is missing (schemaMatched=false)", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "ping",
          },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    const meta = summaries[0].metadata?.appsync as
      | { schemaMatched?: boolean }
      | undefined;
    expect(meta?.schemaMatched).toBe(false);
    // No inputs when the SDL didn't declare the field.
    expect(summaries[0].inputs).toEqual([]);
    // The default transition still carries a return output — just
    // with an `unknown` shape in place of the SDL-declared one.
    const defaultTxn = summaries[0].transitions.find((t) => t.isDefault);
    expect(defaultTxn?.output.type).toBe("return");
    if (defaultTxn?.output.type === "return") {
      expect(defaultTxn.output.value).toEqual({ type: "unknown" });
    }
  });

  it("skips resolvers missing TypeName or FieldName", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: { ApiId: { Ref: "X" }, TypeName: "Query" }, // no FieldName
        },
      },
    });
    expect(summaries).toEqual([]);
  });

  it("defaults an omitted Kind to UNIT", () => {
    const summaries = appsyncToSummaries(
      api({
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "ping",
          },
        },
      }),
    );
    const meta = summaries[0].metadata?.appsync as
      | { kind?: string }
      | undefined;
    expect(meta?.kind).toBe("UNIT");
  });

  it("flags PIPELINE resolvers via metadata.appsync.kind", () => {
    const summaries = appsyncToSummaries(
      api({
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "ping",
            Kind: "PIPELINE",
          },
        },
      }),
    );
    const meta = summaries[0].metadata?.appsync as
      | { kind?: string }
      | undefined;
    expect(meta?.kind).toBe("PIPELINE");
  });

  it("accepts Fn::GetAtt on ApiId (computed via intrinsic)", () => {
    const summaries = appsyncToSummaries(
      api({
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { "Fn::GetAtt": ["Api", "ApiId"] },
            TypeName: "Query",
            FieldName: "ping",
          },
        },
      }),
    );
    expect(summaries).toHaveLength(1);
    expect(restSemanticsOf(summaries[0])).toEqual({
      typeName: "Query",
      fieldName: "ping",
    });
  });

  it("records a remote s3:// DefinitionS3Location as an unresolved schema gap", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        Schema: {
          Type: "AWS::AppSync::GraphQLSchema",
          Properties: {
            ApiId: { Ref: "Api" },
            DefinitionS3Location: "s3://bucket/schema.graphql",
          },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "ping",
          },
        },
      },
    });
    const meta = summaries[0].metadata?.appsync as
      | { schemaMatched?: boolean; schemaSource?: unknown }
      | undefined;
    expect(meta?.schemaMatched).toBe(false);
    expect(meta?.schemaSource).toEqual({
      status: "unresolved",
      location: "s3://bucket/schema.graphql",
      reason: "remote",
    });
  });

  it("records a relative schema path with no base dir as unresolved (no-base-dir)", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        Schema: {
          Type: "AWS::AppSync::GraphQLSchema",
          Properties: {
            ApiId: { Ref: "Api" },
            DefinitionS3Location: "./schema.graphql",
          },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "ping",
          },
        },
      },
    });
    const meta = summaries[0].metadata?.appsync as
      | { schemaSource?: unknown }
      | undefined;
    expect(meta?.schemaSource).toEqual({
      status: "unresolved",
      location: "./schema.graphql",
      reason: "no-base-dir",
    });
  });

  it("records a missing local schema file as unresolved (not-found)", () => {
    const summaries = appsyncToSummaries(
      {
        Resources: {
          Api: {
            Type: "AWS::AppSync::GraphQLApi",
            Properties: { Name: "T" },
          },
          Schema: {
            Type: "AWS::AppSync::GraphQLSchema",
            Properties: {
              ApiId: { Ref: "Api" },
              DefinitionS3Location: "./nope.graphql",
            },
          },
          R: {
            Type: "AWS::AppSync::Resolver",
            Properties: {
              ApiId: { Ref: "Api" },
              TypeName: "Query",
              FieldName: "ping",
            },
          },
        },
      },
      { baseDir: fixturesDir },
    );
    const meta = summaries[0].metadata?.appsync as
      | { schemaSource?: unknown }
      | undefined;
    expect(meta?.schemaSource).toEqual({
      status: "unresolved",
      location: "./nope.graphql",
      reason: "not-found",
    });
  });

  it("resolves a relative external schema against an explicit baseDir", () => {
    const summaries = appsyncToSummaries(
      {
        Resources: {
          Api: {
            Type: "AWS::AppSync::GraphQLApi",
            Properties: { Name: "T" },
          },
          Schema: {
            Type: "AWS::AppSync::GraphQLSchema",
            Properties: {
              ApiId: { Ref: "Api" },
              DefinitionS3Location: "./schema.graphql",
            },
          },
          R: {
            Type: "AWS::AppSync::Resolver",
            Properties: {
              ApiId: { Ref: "Api" },
              TypeName: "Query",
              FieldName: "note",
            },
          },
        },
      },
      { baseDir: path.join(fixturesDir, "external-schema") },
    );
    const meta = summaries[0].metadata?.appsync as
      | { schemaMatched?: boolean; schemaSource?: unknown }
      | undefined;
    expect(meta?.schemaMatched).toBe(true);
    expect(meta?.schemaSource).toEqual({
      status: "external-file",
      location: "./schema.graphql",
    });
  });

  it("tolerates malformed SDL (parse error) without throwing", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        Schema: {
          Type: "AWS::AppSync::GraphQLSchema",
          Properties: {
            ApiId: { Ref: "Api" },
            Definition: "type Query { // not graphql syntax",
          },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "ping",
          },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    const meta = summaries[0].metadata?.appsync as
      | { schemaMatched?: boolean }
      | undefined;
    expect(meta?.schemaMatched).toBe(false);
  });

  it("captures pipeline resolver's function chain in metadata", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        Schema: {
          Type: "AWS::AppSync::GraphQLSchema",
          Properties: {
            ApiId: { Ref: "Api" },
            Definition: "type Query { userWithPosts: String }",
          },
        },
        GetUser: {
          Type: "AWS::AppSync::FunctionConfiguration",
          Properties: {
            ApiId: { Ref: "Api" },
            Name: "GetUser",
            DataSourceName: { Ref: "UsersDS" },
          },
        },
        GetPosts: {
          Type: "AWS::AppSync::FunctionConfiguration",
          Properties: {
            ApiId: { Ref: "Api" },
            Name: "GetPosts",
            DataSourceName: { Ref: "PostsDS" },
          },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "userWithPosts",
            Kind: "PIPELINE",
            PipelineConfig: {
              Functions: [
                { "Fn::GetAtt": ["GetUser", "FunctionId"] },
                { "Fn::GetAtt": ["GetPosts", "FunctionId"] },
              ],
            },
          },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    const meta = summaries[0].metadata?.appsync as
      | {
          kind?: string;
          pipelineFunctions?: Array<{
            logicalId: string;
            name: string | null;
            dataSourceLogicalId: string | null;
          }>;
        }
      | undefined;
    expect(meta?.kind).toBe("PIPELINE");
    expect(meta?.pipelineFunctions).toEqual([
      {
        logicalId: "GetUser",
        name: "GetUser",
        dataSourceLogicalId: "UsersDS",
        lambdaFunctionLogicalId: null,
        codeUri: null,
        runtime: null,
      },
      {
        logicalId: "GetPosts",
        name: "GetPosts",
        dataSourceLogicalId: "PostsDS",
        lambdaFunctionLogicalId: null,
        codeUri: null,
        runtime: null,
      },
    ]);
  });

  it("tolerates a PIPELINE resolver with unresolvable Functions (dynamic intrinsic)", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "something",
            Kind: "PIPELINE",
            PipelineConfig: {
              Functions: [{ "Fn::ImportValue": "NotStaticallyKnown" }],
            },
          },
        },
      },
    });
    const meta = summaries[0].metadata?.appsync as
      | { kind?: string; pipelineFunctions?: unknown }
      | undefined;
    expect(meta?.kind).toBe("PIPELINE");
    // No statically-resolvable function IDs → key omitted entirely.
    expect(meta?.pipelineFunctions).toBeUndefined();
  });

  it("indexes interface-type fields as resolver targets", () => {
    // AppSync allows resolvers on interface types; schema parsing
    // should index those the same as object types. Useful when a
    // project defines `interface Node { id: ID! }` and attaches a
    // type resolver.
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        Schema: {
          Type: "AWS::AppSync::GraphQLSchema",
          Properties: {
            ApiId: { Ref: "Api" },
            Definition:
              "interface Node { id: ID! } type Pet implements Node { id: ID! name: String! } type Query { node(id: ID!): Node }",
          },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Node",
            FieldName: "id",
          },
        },
      },
    });
    const meta = summaries[0].metadata?.appsync as
      | { schemaMatched?: boolean }
      | undefined;
    expect(meta?.schemaMatched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// External schema file — raw AppSync with DefinitionS3Location local path
// ---------------------------------------------------------------------------

interface AppsyncMeta {
  apiName?: string | null;
  kind?: string;
  authenticationType?: string | null;
  dataSourceLogicalId?: string | null;
  lambdaFunctionLogicalId?: string | null;
  codeUri?: string | null;
  runtime?: string | null;
  schemaMatched?: boolean;
  schemaSource?: unknown;
  pipelineFunctions?: Array<{
    logicalId: string;
    name: string | null;
    dataSourceLogicalId: string | null;
    lambdaFunctionLogicalId: string | null;
    codeUri: string | null;
    runtime: string | null;
  }>;
}

function appsyncMeta(summary: BehavioralSummary | undefined): AppsyncMeta {
  return (summary?.metadata?.appsync ?? {}) as AppsyncMeta;
}

describe("appsyncFileToSummaries — external schema file (raw AppSync)", () => {
  const file = path.join(fixturesDir, "external-schema", "template.yaml");
  const summaries = appsyncFileToSummaries(file);

  it("emits one summary per resolver, sourced from the external SDL", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["Mutation.createNote", "Query.note", "Query.notes"]);
  });

  it("marks the schema as an external file and matches fields against it", () => {
    const note = summaries.find((s) => s.identity.name === "Query.note");
    const meta = appsyncMeta(note);
    expect(meta.schemaMatched).toBe(true);
    expect(meta.schemaSource).toEqual({
      status: "external-file",
      location: "./schema.graphql",
    });
    expect(note?.inputs).toEqual([
      {
        type: "parameter",
        name: "id",
        position: 0,
        role: "args",
        shape: { type: "ref", name: "ID!" },
      },
    ]);
  });

  it("attributes the Lambda behind a resolver's data source", () => {
    const create = summaries.find(
      (s) => s.identity.name === "Mutation.createNote",
    );
    expect(appsyncMeta(create).lambdaFunctionLogicalId).toBe("NotesFunction");
  });

  it("leaves lambda attribution null for a non-Lambda (DynamoDB) data source", () => {
    const notes = summaries.find((s) => s.identity.name === "Query.notes");
    expect(appsyncMeta(notes).lambdaFunctionLogicalId).toBeNull();
  });
});

describe("appsyncFileToSummaries, list-form intrinsics", () => {
  // The template names everything through the shared loader's tag set,
  // in the list and flow forms. A reader with its own scalar-only copy
  // leaves these unresolved and loses the resolver's Lambda.
  const file = path.join(fixturesDir, "list-form", "template.yaml");
  const summaries = appsyncFileToSummaries(file);

  it("reads a resolver whose api is named by a list-form GetAtt", () => {
    expect(summaries.map((s) => s.identity.name)).toEqual(["Query.note"]);
  });

  it("attributes the Lambda behind a list-form GetAtt data source", () => {
    expect(appsyncMeta(summaries[0]).lambdaFunctionLogicalId).toBe(
      "NotesFunction",
    );
  });
});

// ---------------------------------------------------------------------------
// SAM shorthand — AWS::Serverless::GraphQLApi
// ---------------------------------------------------------------------------

describe("appsyncFileToSummaries — SAM AWS::Serverless::GraphQLApi", () => {
  const file = path.join(fixturesDir, "serverless", "template.yaml");
  const summaries = appsyncFileToSummaries(file);

  it("emits one summary per Resolvers.<Type>.<field>", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["Mutation.addPost", "Query.post", "Query.posts"]);
    for (const s of summaries) {
      expect(s.kind).toBe("resolver");
    }
  });

  it("binds each resolver via graphql-resolver semantics on aws-https", () => {
    const posts = summaries.find((s) => s.identity.name === "Query.posts");
    expect(posts?.identity.boundaryBinding).toEqual({
      transport: "aws-https",
      semantics: {
        name: "graphql-resolver",
        typeName: "Query",
        fieldName: "posts",
      },
      recognition: "appsync",
    });
  });

  it("resolves SchemaUri to the external SDL and carries API metadata", () => {
    const posts = summaries.find((s) => s.identity.name === "Query.posts");
    const meta = appsyncMeta(posts);
    expect(meta.apiName).toBe("Blog");
    expect(meta.authenticationType).toBe("AWS_IAM");
    expect(meta.schemaMatched).toBe(true);
    expect(meta.schemaSource).toEqual({
      status: "external-file",
      location: "./schema.graphql",
    });
  });

  it("attributes Lambda data source + resolver code for a UNIT resolver", () => {
    const posts = summaries.find((s) => s.identity.name === "Query.posts");
    const meta = appsyncMeta(posts);
    expect(meta.kind).toBe("UNIT");
    expect(meta.dataSourceLogicalId).toBe("BlogApiPostsResolverDataSource");
    expect(meta.lambdaFunctionLogicalId).toBe("PostsFunction");
    expect(meta.codeUri).toBe("./resolvers/posts.js");
    expect(meta.runtime).toBe("APPSYNC_JS");
  });

  it("expands a PIPELINE resolver's function chain with lambda + code", () => {
    const addPost = summaries.find(
      (s) => s.identity.name === "Mutation.addPost",
    );
    const meta = appsyncMeta(addPost);
    expect(meta.kind).toBe("PIPELINE");
    expect(meta.pipelineFunctions).toEqual([
      {
        logicalId: "BlogApivalidatePost",
        name: "validatePost",
        dataSourceLogicalId: "BlogApiPostsResolverDataSource",
        lambdaFunctionLogicalId: "PostsFunction",
        codeUri: "./functions/validatePost.js",
        runtime: "APPSYNC_JS",
      },
      {
        logicalId: "BlogApiwritePost",
        name: "writePost",
        dataSourceLogicalId: "BlogApiPostsResolverDataSource",
        lambdaFunctionLogicalId: "PostsFunction",
        codeUri: "./functions/writePost.js",
        runtime: "APPSYNC_JS",
      },
    ]);
  });

  it("derives mutation inputs + return shape from the external SDL", () => {
    const addPost = summaries.find(
      (s) => s.identity.name === "Mutation.addPost",
    );
    const argNames = addPost?.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.name : "?"));
    expect(argNames).toEqual(["title", "body"]);
    const defaultTxn = addPost?.transitions.find((t) => t.isDefault === true);
    if (defaultTxn?.output.type === "return") {
      expect(defaultTxn.output.value).toEqual({ type: "ref", name: "Post!" });
    }
  });
});

describe("appsyncToSummaries — SAM shape edge cases", () => {
  it("derives resolvers from inline SchemaInline without a file on disk", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::GraphQLApi",
          Properties: {
            Name: "Inline",
            SchemaInline: "type Query { ping: String }",
            Resolvers: {
              Query: {
                ping: { DataSource: "PingDS" },
              },
            },
          },
        },
      },
    });
    expect(summaries.map((s) => s.identity.name)).toEqual(["Query.ping"]);
    const meta = appsyncMeta(summaries[0]);
    expect(meta.schemaSource).toEqual({ status: "inline" });
    expect(meta.schemaMatched).toBe(true);
    expect(meta.dataSourceLogicalId).toBe("ApiPingDS");
  });

  it("records a remote SchemaUri as an unresolved schema gap", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::GraphQLApi",
          Properties: {
            Name: "Remote",
            SchemaUri: "s3://bucket/schema.graphql",
            Resolvers: {
              Query: {
                ping: { DataSource: "PingDS" },
              },
            },
          },
        },
      },
    });
    const meta = appsyncMeta(summaries[0]);
    expect(meta.schemaMatched).toBe(false);
    expect(meta.schemaSource).toEqual({
      status: "unresolved",
      location: "s3://bucket/schema.graphql",
      reason: "remote",
    });
  });

  it("treats an api with neither SchemaInline nor SchemaUri as schema-absent", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::GraphQLApi",
          Properties: {
            Name: "NoSchema",
            Resolvers: {
              Query: { ping: { DataSource: "PingDS" } },
            },
          },
        },
      },
    });
    expect(summaries.map((s) => s.identity.name)).toEqual(["Query.ping"]);
    expect(appsyncMeta(summaries[0]).schemaMatched).toBe(false);
  });

  it("reads the singular DataSources.Lambda category too", () => {
    // AWS SAM accepts `Lambda` as well as `Lambdas`, the way it does
    // for the DynamoDb and RelationalDatabase categories. A template
    // using the singular used to lose its Lambda attribution.
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::GraphQLApi",
          Properties: {
            Name: "Singular",
            SchemaInline: "type Query { ping: String }",
            DataSources: {
              Lambda: {
                PingDS: {
                  FunctionArn: { "Fn::GetAtt": ["PingFunction", "Arn"] },
                },
              },
            },
            Resolvers: {
              Query: { ping: { DataSource: "PingDS" } },
            },
          },
        },
      },
    });

    expect(summaries.map((s) => s.identity.name)).toEqual(["Query.ping"]);
    expect(appsyncMeta(summaries[0]).lambdaFunctionLogicalId).toBe(
      "PingFunction",
    );
  });

  it("skips malformed DataSources categories and Resolvers blocks", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::GraphQLApi",
          Properties: {
            Name: "Malformed",
            SchemaInline: "type Query { ping: String }",
            DataSources: {
              Lambdas: "not-a-record",
              DynamoDb: { Table: { TableName: "T" } },
            },
            Resolvers: "not-a-record",
          },
        },
      },
    });
    expect(summaries).toHaveLength(0);
  });

  it("reads pipeline resolver Functions and defaults omitted Kind to UNIT", () => {
    const summaries = appsyncToSummaries({
      Resources: {
        Api: {
          Type: "AWS::Serverless::GraphQLApi",
          Properties: {
            Name: "Pipeline",
            SchemaInline: "type Query { ping: String }",
            Resolvers: {
              Query: {
                ping: {
                  Pipeline: ["FnOne", { Bogus: true }],
                },
              },
            },
          },
        },
      },
    });
    expect(summaries).toHaveLength(1);
    const meta = appsyncMeta(summaries[0]) as Record<string, unknown>;
    expect(meta.kind).toBe("PIPELINE");
    // The malformed pipeline entry is dropped; the string entry resolves.
    expect(meta.pipelineFunctions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// File loader — JSON and YAML shapes from disk
// ---------------------------------------------------------------------------

describe("appsyncFileToSummaries — file loading", () => {
  it("loads a JSON template from disk", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suss-appsync-"));
    const file = path.join(tmp, "stack.json");
    const template: CfnTemplate = {
      Resources: {
        Api: {
          Type: "AWS::AppSync::GraphQLApi",
          Properties: { Name: "T" },
        },
        Schema: {
          Type: "AWS::AppSync::GraphQLSchema",
          Properties: {
            ApiId: { Ref: "Api" },
            Definition: "type Query { ping: String }",
          },
        },
        R: {
          Type: "AWS::AppSync::Resolver",
          Properties: {
            ApiId: { Ref: "Api" },
            TypeName: "Query",
            FieldName: "ping",
          },
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(template));
    try {
      const summaries = appsyncFileToSummaries(file);
      expect(summaries.map((s) => s.identity.name)).toEqual(["Query.ping"]);
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });
});
