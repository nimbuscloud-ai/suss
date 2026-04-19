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
): { typeName: string; fieldName: string } | null {
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
        }
      | undefined;
    expect(meta?.apiName).toBe("PetStore");
    expect(meta?.kind).toBe("UNIT");
    expect(meta?.authenticationType).toBe("AMAZON_COGNITO_USER_POOLS");
    expect(meta?.schemaMatched).toBe(true);
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

  it("leaves schemaSdl null when only DefinitionS3Location is provided", () => {
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
      | { schemaMatched?: boolean }
      | undefined;
    expect(meta?.schemaMatched).toBe(false);
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
      },
      {
        logicalId: "GetPosts",
        name: "GetPosts",
        dataSourceLogicalId: "PostsDS",
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
