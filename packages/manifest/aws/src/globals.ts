// globals.ts: fold the SAM `Globals` section into the resources that
// inherit from it, so every reader sees one set of properties per
// resource and none of them has to know that `Globals` exists.
//
// SAM applies a section's properties to each resource of the matching
// type, and the resource's own value wins where both declare one:
// https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-specification-template-anatomy-globals.html
//
// The combining rules come from that page as well. A map is merged key
// by key, a list holds the section's entries followed by the resource's,
// and anything else is replaced outright by the resource. Merging keys
// is what makes `Globals.Function.Environment.Variables` behave the way
// a template author expects: a function that declares one variable of
// its own still receives the section's others.

import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "./templateLoader.js";

/** The resource type each `Globals` section supplies defaults for. */
const GLOBALS_SECTION_TYPES: Record<string, string> = {
  Api: "AWS::Serverless::Api",
  Function: "AWS::Serverless::Function",
  HttpApi: "AWS::Serverless::HttpApi",
  LayerVersion: "AWS::Serverless::LayerVersion",
  SimpleTable: "AWS::Serverless::SimpleTable",
  StateMachine: "AWS::Serverless::StateMachine",
};

/**
 * The template's resources with each `Globals` section already applied
 * to the resources it covers. A resource of a type no section names, or
 * a template with no `Globals`, comes back untouched.
 */
export function resourcesWithGlobals(
  template: CloudFormationTemplate,
): Record<string, CloudFormationResource> {
  const resources = template.Resources ?? {};
  const defaultsByType = defaultsPerResourceType(template.Globals);
  if (defaultsByType.size === 0) {
    return resources;
  }

  const out: Record<string, CloudFormationResource> = {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    const defaults = defaultsByType.get(resource.Type ?? "");
    out[logicalId] =
      defaults === undefined
        ? resource
        : {
            ...resource,
            Properties: mergedProperties(defaults, resource.Properties ?? {}),
          };
  }
  return out;
}

/**
 * Per function logical id, the environment variables the `Function`
 * section supplies that the function does not declare for itself. A
 * consumer that treats a function's environment as its own contract
 * needs the distinction: a name every function in the document receives
 * says something about the document, not about any one function.
 */
export function inheritedEnvVars(
  template: CloudFormationTemplate,
): Record<string, string[]> {
  const sectionVars = envVarNames(template.Globals?.Function);
  if (sectionVars.length === 0) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [logicalId, resource] of Object.entries(
    template.Resources ?? {},
  )) {
    if (resource.Type !== GLOBALS_SECTION_TYPES.Function) {
      continue;
    }
    const own = new Set(envVarNames(resource.Properties));
    out[logicalId] = sectionVars.filter((name) => !own.has(name));
  }
  return out;
}

function envVarNames(
  properties: Record<string, unknown> | undefined,
): string[] {
  const environment = properties?.Environment;
  if (!isPlainObject(environment)) {
    return [];
  }
  const variables = environment.Variables;
  return isPlainObject(variables) ? Object.keys(variables) : [];
}

function defaultsPerResourceType(
  globals: Record<string, Record<string, unknown>> | undefined,
): Map<string, Record<string, unknown>> {
  const byType = new Map<string, Record<string, unknown>>();
  if (globals === null || typeof globals !== "object") {
    return byType;
  }
  for (const [section, properties] of Object.entries(globals)) {
    const resourceType = GLOBALS_SECTION_TYPES[section];
    if (resourceType === undefined || !isPlainObject(properties)) {
      continue;
    }
    byType.set(resourceType, properties);
  }
  return byType;
}

function mergedProperties(
  defaults: Record<string, unknown>,
  own: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...own };
  for (const [name, fallback] of Object.entries(defaults)) {
    merged[name] = name in own ? combined(fallback, own[name]) : fallback;
  }
  return merged;
}

function combined(fallback: unknown, own: unknown): unknown {
  if (Array.isArray(fallback) && Array.isArray(own)) {
    return [...fallback, ...own];
  }
  if (isMergeableMap(fallback) && isMergeableMap(own)) {
    return mergedProperties(fallback, own);
  }
  return own;
}

function isMergeableMap(value: unknown): value is Record<string, unknown> {
  // An intrinsic parses to an object, and merging two of them would
  // produce a call with both function names in it. The resource's
  // intrinsic replaces the section's, the same way a scalar does.
  return isPlainObject(value) && !isIntrinsic(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIntrinsic(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    (keys[0] === "Ref" || keys[0].startsWith("Fn::") || keys[0] === "Condition")
  );
}
