// summary-builder.ts — Assemble BehavioralSummary objects from parsed
// AppSync CFN + SDL input.
//
// The schema-first angle drives most of the shape here: every
// resolver's observable behavior is gated by its SDL field
// declaration. The stub emits one summary per (TypeName, FieldName)
// declared by a Resolver resource that matches an indexed SDL field.
// Dangling resolvers (no SDL declaration for the target field) still
// produce a summary — they're a real boundary that AppSync would
// fail at deploy time, and surfacing them is more useful than
// silently dropping.

import { graphqlResolverBinding } from "@suss/behavioral-ir";

import { schemaKey } from "./schema.js";

import type {
  BehavioralSummary,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type { AppSyncApi, AppSyncFunction, AppSyncResolver } from "./cfn.js";
import type { FieldInfo, SchemaIndex } from "./schema.js";

export interface BuildOptions {
  /** Logical source path recorded on each summary's `location.file`. */
  source?: string;
}

export function buildResolverSummaries(
  apis: AppSyncApi[],
  resolvers: AppSyncResolver[],
  functions: AppSyncFunction[],
  schemasByApi: Map<string, SchemaIndex>,
  options: BuildOptions = {},
): BehavioralSummary[] {
  const sourceFile = options.source ?? "appsync";
  const apiById = indexApisByLogicalId(apis);
  const functionById = indexFunctionsByLogicalId(functions);
  return resolvers.map((resolver) =>
    buildOne(resolver, apiById, functionById, schemasByApi, sourceFile),
  );
}

function indexApisByLogicalId(apis: AppSyncApi[]): Map<string, AppSyncApi> {
  const out = new Map<string, AppSyncApi>();
  for (const api of apis) {
    out.set(api.logicalId, api);
  }
  return out;
}

function indexFunctionsByLogicalId(
  functions: AppSyncFunction[],
): Map<string, AppSyncFunction> {
  const out = new Map<string, AppSyncFunction>();
  for (const fn of functions) {
    out.set(fn.logicalId, fn);
  }
  return out;
}

function buildOne(
  resolver: AppSyncResolver,
  apiById: Map<string, AppSyncApi>,
  functionById: Map<string, AppSyncFunction>,
  schemasByApi: Map<string, SchemaIndex>,
  sourceFile: string,
): BehavioralSummary {
  const api =
    resolver.apiLogicalId === null
      ? null
      : (apiById.get(resolver.apiLogicalId) ?? null);
  const schema =
    resolver.apiLogicalId === null
      ? null
      : (schemasByApi.get(resolver.apiLogicalId) ?? null);
  const field =
    schema?.get(schemaKey(resolver.typeName, resolver.fieldName)) ?? null;

  const ownerKey = `${resolver.typeName}.${resolver.fieldName}`;

  return {
    kind: "resolver",
    location: {
      file: `${sourceFile}:${resolver.logicalId}`,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: ownerKey,
      exportPath: null,
      boundaryBinding: graphqlResolverBinding({
        // AppSync is invoked over HTTPS-to-AWS. Keeping transport
        // explicit here matches the aws-apigateway stub's posture
        // and leaves room for a future AWS-SDK-direct transport
        // ("aws-sdk") once Lambda-invoke semantics land.
        transport: "aws-https",
        recognition: "appsync",
        typeName: resolver.typeName,
        fieldName: resolver.fieldName,
      }),
    },
    inputs: buildInputs(field),
    transitions: buildTransitions(ownerKey, resolver, field),
    gaps: [],
    confidence: { source: "stub", level: "high" },
    metadata: {
      appsync: {
        apiLogicalId: resolver.apiLogicalId,
        apiName: api?.name ?? null,
        dataSourceLogicalId: resolver.dataSourceLogicalId,
        kind: resolver.kind,
        authenticationType: api?.authenticationType ?? null,
        // Surface when the SDL couldn't be matched so downstream
        // consumers can distinguish "schema said X" from "we didn't
        // see a schema at all."
        schemaMatched: field !== null,
        // For PIPELINE resolvers, surface the ordered function
        // chain so downstream tools can show the dispatch path.
        // Each entry resolves `logicalId` → (Name, DataSource).
        // Empty for UNIT resolvers; empty with `kind: "PIPELINE"`
        // means the Functions array was dynamically-referenced
        // and we couldn't resolve it statically.
        ...(resolver.pipelineFunctionLogicalIds.length > 0
          ? {
              pipelineFunctions: resolver.pipelineFunctionLogicalIds.map(
                (logicalId) => {
                  const fn = functionById.get(logicalId) ?? null;
                  return {
                    logicalId,
                    name: fn?.name ?? null,
                    dataSourceLogicalId: fn?.dataSourceLogicalId ?? null,
                  };
                },
              ),
            }
          : {}),
      },
      // Surface the inline SDL so the checker can resolve nested
      // selections against this resolver's return type. Repeated
      // across every resolver from the same API by design — each
      // summary travels independently; keeping the SDL on-hand is
      // simpler than cross-summary schema lookup, and the checker
      // caches parses per-SDL.
      ...(api?.schemaSdl != null
        ? { graphql: { schemaSdl: api.schemaSdl } }
        : {}),
    },
  };
}

function buildInputs(field: FieldInfo | null): Input[] {
  if (field === null) {
    return [];
  }
  return field.args.map<Input>((arg, index) => ({
    type: "parameter",
    name: arg.name,
    position: index,
    role: "args",
    shape: arg.shape,
  }));
}

/**
 * Default transitions for a v0 AppSync resolver summary:
 *
 *   1. Success: returns the SDL-declared shape. Marked default so
 *      unmatched consumer branches pair against it.
 *   2. Throw: AppSync resolvers surface failures as errors[] on the
 *      response (per GraphQL spec). V0 emits one generic throw
 *      transition so downstream consumer-satisfaction checking has
 *      somewhere to pair against when the consumer branches on an
 *      error path. Richer modeling (request-mapping validation 400,
 *      auth 401, datasource 502) is a follow-up tied to VTL / JS
 *      resolver parsing.
 *
 * When the schema doesn't declare the field, the success transition
 * falls back to a `ref: unknown` return — we still model the
 * boundary, just without shape detail.
 */
function buildTransitions(
  ownerKey: string,
  resolver: AppSyncResolver,
  field: FieldInfo | null,
): Transition[] {
  const returnShape: TypeShape = field?.returnShape ?? { type: "unknown" };
  const successSource =
    field !== null
      ? "aws::appsync::resolver.success"
      : "aws::appsync::resolver.success-no-schema";

  return [
    {
      id: `${ownerKey}:return:success`,
      conditions: [],
      output: { type: "return", value: returnShape },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: true,
      confidence: { source: "stub", level: "high" },
      metadata: {
        source: successSource,
        resolverKind: resolver.kind,
      },
    },
    {
      id: `${ownerKey}:throw:error`,
      conditions: [
        {
          type: "opaque",
          sourceText: "aws:appsync:resolver-error",
          reason: "externalFunction",
        },
      ],
      output: {
        type: "throw",
        exceptionType: null,
        message: null,
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
      confidence: { source: "stub", level: "medium" },
      metadata: {
        source: "aws::appsync::resolver.error-path",
      },
    },
  ];
}
