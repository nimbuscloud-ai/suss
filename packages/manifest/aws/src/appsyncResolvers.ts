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

/** One GraphQL field and the Lambdas behind it. */
export interface AppSyncResolverBinding {
  typeName: string;
  fieldName: string;
  /**
   * Every Lambda a request for this field runs, in pipeline order.
   * Usually one. A pipeline can chain several, and nothing in the
   * template says which of them is the one that produces the value:
   * the first is as often an auth step as it is the resolver, and the
   * last is as often a formatter. So all of them are reported, and a
   * reader that needs to pick says so itself.
   *
   * Empty when the field is served by something other than a Lambda.
   */
  lambdaFunctionLogicalIds: string[];
}

/**
 * SAM groups a GraphQLApi's data sources by category. It accepts the
 * singular and the plural for each, so both spellings turn up in
 * templates people write.
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
        bindings.push({
          typeName,
          fieldName,
          lambdaFunctionLogicalIds: dataSources
            .map((name) => lambdaByDataSource.get(name) ?? null)
            .filter((id): id is string => id !== null),
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
  // A resolver names a data source by logical id or by the Name
  // property, and the two need not match. Logical ids are unique across
  // a template, names only within one API, and every one of these
  // resources says which API it belongs to. So a name is looked up
  // against the resolver's own API, and two APIs are free to use the
  // same one.
  const lambdaByLogicalId = new Map<string, string>();
  const lambdaByApiAndName = new Map<string, string>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::DataSource") {
      continue;
    }
    const props = asRecord(resource.Properties) ?? {};
    const lambdaConfig = asRecord(props.LambdaConfig);
    const lambda =
      lambdaConfig === null ? null : refTarget(lambdaConfig.LambdaFunctionArn);
    if (lambda === null) {
      continue;
    }
    lambdaByLogicalId.set(logicalId, lambda);
    const name = stringOf(props.Name);
    if (name !== null) {
      lambdaByApiAndName.set(
        apiScopedKey(refTarget(props.ApiId), name),
        lambda,
      );
    }
  }

  // A pipeline resolver names functions, and each function names the
  // data source. This is also the shape the SAM transform expands the
  // shorthand into, so it has to be read whichever way the template was
  // authored. Function names are scoped the same way data-source names
  // are.
  const dataSourceByLogicalId = new Map<string, string>();
  const dataSourceByApiAndName = new Map<string, string>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::FunctionConfiguration") {
      continue;
    }
    const props = asRecord(resource.Properties) ?? {};
    const dataSource = refTarget(props.DataSourceName);
    if (dataSource === null) {
      continue;
    }
    dataSourceByLogicalId.set(logicalId, dataSource);
    const name = stringOf(props.Name);
    if (name !== null) {
      dataSourceByApiAndName.set(
        apiScopedKey(refTarget(props.ApiId), name),
        dataSource,
      );
    }
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
    const apiId = refTarget(props.ApiId);
    const lookup =
      (byLogicalId: Map<string, string>, byName: Map<string, string>) =>
      (reference: string): string | undefined =>
        byLogicalId.get(reference) ??
        byName.get(apiScopedKey(apiId, reference));

    bindings.push({
      typeName,
      fieldName,
      lambdaFunctionLogicalIds: rawDataSourcesReached(
        props,
        lookup(dataSourceByLogicalId, dataSourceByApiAndName),
      )
        .map(lookup(lambdaByLogicalId, lambdaByApiAndName))
        .filter((id): id is string => id !== undefined),
    });
  }
  return bindings;
}

/** A name only means something next to the API it was declared in. */
function apiScopedKey(apiId: string | null, name: string): string {
  return `${apiId ?? ""}::${name}`;
}

/** The data sources a raw resolver reads, unit or pipeline. */
function rawDataSourcesReached(
  props: Record<string, unknown>,
  dataSourceOf: (reference: string) => string | undefined,
): string[] {
  const direct = refTarget(props.DataSourceName);
  if (direct !== null) {
    return [direct];
  }
  const pipeline = asRecord(props.PipelineConfig);
  const functions = Array.isArray(pipeline?.Functions)
    ? pipeline.Functions
    : [];
  return functions
    .map((fn) => {
      const reference = refTarget(fn);
      return reference === null ? undefined : dataSourceOf(reference);
    })
    .filter((name): name is string => name !== undefined);
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
