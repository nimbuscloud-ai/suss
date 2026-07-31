// appsyncResolvers.ts — which GraphQL field each Lambda serves.
//
// AppSync does not wire a field to a handler in code. The template says
// it, across three hops: a resolver names a pipeline function, the
// function names a data source, and the data source names a Lambda. Both
// authoring shapes are covered, the raw AWS::AppSync::* resources and
// the SAM AWS::Serverless::GraphQLApi shorthand whose DataSources,
// Functions, and Resolvers blocks the transform expands into them.
//
// Like the rest of this package, this answers only what the template
// says. Whether a field has an implementation, and whether that
// implementation matches the schema, belongs to a reader above.

import { refTarget } from "./templateLoader.js";

import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "./templateLoader.js";

/** One GraphQL field and the Lambda behind it. */
export interface AppSyncResolverBinding {
  typeName: string;
  fieldName: string;
  /** Null when the field is served by something other than a Lambda. */
  lambdaFunctionLogicalId: string | null;
}

/**
 * SAM groups a GraphQLApi's data sources by category. It accepts the
 * singular and the plural for each, so both spellings appear in real
 * templates.
 */
const LAMBDA_CATEGORIES = ["Lambda", "Lambdas"];

export function readAppSyncResolvers(
  template: CloudFormationTemplate,
): AppSyncResolverBinding[] {
  const resources = template.Resources ?? {};
  return [
    ...fromServerlessShorthand(resources),
    ...fromRawResources(resources),
  ];
}

// ---------------------------------------------------------------------------
// SAM shorthand
// ---------------------------------------------------------------------------

function fromServerlessShorthand(
  resources: Record<string, CloudFormationResource | undefined>,
): AppSyncResolverBinding[] {
  const bindings: AppSyncResolverBinding[] = [];

  for (const resource of Object.values(resources)) {
    if (resource?.Type !== "AWS::Serverless::GraphQLApi") {
      continue;
    }
    const props = asRecord(resource.Properties) ?? {};
    const lambdaByDataSource = shorthandDataSources(props.DataSources);
    const dataSourceByFunction = shorthandFunctions(props.Functions);

    for (const [typeName, fields] of entriesOf(props.Resolvers)) {
      for (const [fieldName, config] of entriesOf(fields)) {
        const dataSources = dataSourcesReached(config, dataSourceByFunction);
        const lambda = dataSources
          .map((name) => lambdaByDataSource.get(name) ?? null)
          .find((id) => id !== null);
        bindings.push({
          typeName,
          fieldName,
          lambdaFunctionLogicalId: lambda ?? null,
        });
      }
    }
  }
  return bindings;
}

/** Data source name to the Lambda logical id behind it. */
function shorthandDataSources(block: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [category, entries] of entriesOf(block)) {
    if (!LAMBDA_CATEGORIES.includes(category)) {
      continue;
    }
    for (const [name, config] of entriesOf(entries)) {
      const props = asRecord(config);
      out.set(name, props === null ? null : refTarget(props.FunctionArn));
    }
  }
  return out;
}

/** Pipeline function name to the data source it reads. */
function shorthandFunctions(block: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, config] of entriesOf(block)) {
    const props = asRecord(config);
    const dataSource = props === null ? null : stringOf(props.DataSource);
    if (dataSource !== null) {
      out.set(name, dataSource);
    }
  }
  return out;
}

/**
 * The data sources a resolver reads: its own for a unit resolver, or
 * every function's for a pipeline.
 */
function dataSourcesReached(
  config: unknown,
  dataSourceByFunction: Map<string, string>,
): string[] {
  const props = asRecord(config);
  if (props === null) {
    return [];
  }
  const direct = stringOf(props.DataSource);
  if (direct !== null) {
    return [direct];
  }
  const pipeline = Array.isArray(props.Pipeline) ? props.Pipeline : [];
  return pipeline
    .map((name) => dataSourceByFunction.get(String(name)))
    .filter((name): name is string => name !== undefined);
}

// ---------------------------------------------------------------------------
// Raw AWS::AppSync::* resources
// ---------------------------------------------------------------------------

function fromRawResources(
  resources: Record<string, CloudFormationResource | undefined>,
): AppSyncResolverBinding[] {
  const lambdaByDataSource = new Map<string, string | null>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::DataSource") {
      continue;
    }
    const props = asRecord(resource.Properties) ?? {};
    const lambdaConfig = asRecord(props.LambdaConfig);
    lambdaByDataSource.set(
      logicalId,
      lambdaConfig === null ? null : refTarget(lambdaConfig.LambdaFunctionArn),
    );
  }

  const bindings: AppSyncResolverBinding[] = [];
  for (const resource of Object.values(resources)) {
    if (resource?.Type !== "AWS::AppSync::Resolver") {
      continue;
    }
    const props = asRecord(resource.Properties) ?? {};
    const typeName = stringOf(props.TypeName);
    const fieldName = stringOf(props.FieldName);
    if (typeName === null || fieldName === null) {
      continue;
    }
    const dataSource = refTarget(props.DataSourceName);
    bindings.push({
      typeName,
      fieldName,
      lambdaFunctionLogicalId:
        dataSource === null
          ? null
          : (lambdaByDataSource.get(dataSource) ?? null),
    });
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entriesOf(value: unknown): Array<[string, unknown]> {
  const record = asRecord(value);
  return record === null ? [] : Object.entries(record);
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
