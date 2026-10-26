/**
 * Runtime-config provider summaries for the resources that set
 * environment variables: Lambda and SAM functions
 * (`Environment.Variables`) and ECS task definitions (each container's
 * `Environment`, one summary per container).
 *
 * `envVars` lists every variable the process sees, including the ones
 * the platform sets. `envVarSources` says where each came from:
 * "template", "globals" or "platform". The checker uses that so a
 * platform variable never counts as unused, and so a variable from SAM
 * Globals is judged once for the whole document.
 */

import {
  runtimeConfigBinding,
  withRuntimeContractMetadata,
} from "@suss/behavioral-ir";
import {
  codeScopePath,
  ecsContainerInstanceName,
  PLATFORM_INJECTED_ENV_VARS,
} from "@suss/ir-core";
import { parseHandler, refTarget } from "@suss/manifest-aws";

import {
  locationOf,
  type TemplatePlace,
  templatePlace,
} from "./templatePlace.js";

import type { BehavioralSummary, DeployableUnit } from "@suss/behavioral-ir";

interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

/**
 * One runtime-config provider summary per Lambda function or ECS
 * container. A function with no Environment block still gets one,
 * because declaring no variables is a contract too: the checker reports
 * a read of any variable in that function's code as `boundaryFieldUnknown`.
 */
export function buildRuntimeConfigSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
  inheritedEnvVars: Record<string, string[]> = {},
  recognition = "cloudformation",
  lines?: ReadonlyMap<string, number>,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const place = templatePlace(sourceFile, lines);

  for (const [logicalId, resource] of Object.entries(resources)) {
    const type = resource.Type;
    if (type === undefined) {
      continue;
    }
    if (
      type === "AWS::Lambda::Function" ||
      type === "AWS::Serverless::Function"
    ) {
      const summary = buildLambdaSummary({
        logicalId,
        resource,
        place,
        inherited: inheritedEnvVars[logicalId] ?? [],
        recognition,
      });
      if (summary !== null) {
        summaries.push(summary);
      }
    } else if (type === "AWS::ECS::TaskDefinition") {
      summaries.push(
        ...buildEcsTaskSummaries(logicalId, resource, place, recognition),
      );
    }
  }

  return summaries;
}

function buildLambdaSummary(opts: {
  logicalId: string;
  resource: CloudFormationResource;
  place: TemplatePlace;
  /** Variables the SAM Globals section supplies to this function. */
  inherited: string[];
  recognition: string;
}): BehavioralSummary | null {
  const { logicalId, resource } = opts;
  const props = resource.Properties ?? {};
  const envVariables =
    (props.Environment as { Variables?: Record<string, unknown> } | undefined)
      ?.Variables ?? {};
  const templateVars = readEnvVariables(envVariables);
  const envVarTargets = readEnvVarTargets(envVariables);
  const envVarValues = readEnvVarValues(envVariables);
  const codeScope = readCodeScope(resource);
  const runtime = props.Runtime;
  return buildSummary({
    logicalId,
    declaredAt: logicalId,
    place: opts.place,
    deploymentTarget: "lambda",
    templateVars,
    inheritedVars: opts.inherited,
    envVarTargets,
    envVarValues,
    codeScope,
    recognition: opts.recognition,
    ...(typeof runtime === "string" ? { runtime } : {}),
  });
}

function buildEcsTaskSummaries(
  logicalId: string,
  resource: CloudFormationResource,
  place: TemplatePlace,
  recognition: string,
): BehavioralSummary[] {
  const props = resource.Properties ?? {};
  const containers = props.ContainerDefinitions;
  if (!Array.isArray(containers)) {
    return [];
  }
  const codeScope = readCodeScope(resource);
  const summaries: BehavioralSummary[] = [];
  for (const containerRaw of containers) {
    if (typeof containerRaw !== "object" || containerRaw === null) {
      continue;
    }
    const container = containerRaw as {
      Name?: unknown;
      Environment?: unknown;
    };
    const containerName =
      typeof container.Name === "string" ? container.Name : "container";
    const envEntries = container.Environment;
    const templateVars = readEcsEnvironmentList(envEntries);
    const summary = buildSummary({
      // The ALB flow reader's `fronts` edges build the container's
      // instance name with the same helper, so the two match.
      logicalId: ecsContainerInstanceName(logicalId, containerName),
      declaredAt: logicalId,
      place,
      deploymentTarget: "ecs-task",
      templateVars,
      codeScope,
      recognition,
    });
    if (summary !== null) {
      summaries.push(summary);
    }
  }
  return summaries;
}

function buildSummary(opts: {
  logicalId: string;
  // The resource that declares the variables, whose line the summary takes.
  declaredAt: string;
  place: TemplatePlace;
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  templateVars: string[];
  // The variables in `templateVars` that came from SAM Globals.
  inheritedVars?: string[];
  // The logical id each `Ref` or `GetAtt` variable points at. Message-bus
  // pairing uses it to get from a variable the code reads to a resource.
  envVarTargets?: Record<string, { kind: "ref"; logicalId: string }>;
  // Plain-text values, so a store named through a variable can pair.
  envVarValues?: Record<string, string>;
  codeScope: ReturnType<typeof readCodeScope>;
  // The SAM `Runtime`, when set.
  runtime?: string;
  recognition: string;
}): BehavioralSummary | null {
  const deployableUnit: DeployableUnit = {
    deploymentTarget: opts.deploymentTarget,
    instanceName: opts.logicalId,
  };
  const platformVars = PLATFORM_INJECTED_ENV_VARS[opts.deploymentTarget] ?? [];
  const inherited = new Set(opts.inheritedVars ?? []);
  const merged = new Set<string>();
  const sources: Record<string, "template" | "globals" | "platform"> = {};
  for (const v of opts.templateVars) {
    merged.add(v);
    sources[v] = inherited.has(v) ? "globals" : "template";
  }
  for (const v of platformVars) {
    if (!merged.has(v)) {
      sources[v] = "platform";
    }
    merged.add(v);
  }

  return {
    kind: "library",
    location: locationOf(opts.place, opts.declaredAt),
    identity: {
      name: opts.logicalId,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: opts.recognition,
        ...deployableUnit,
      }),
      // Also on the identity, because the unit is part of what identifies
      // a runtime-config boundary.
      deployableUnit,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withRuntimeContractMetadata(
      { codeScope: opts.codeScope },
      {
        envVars: [...merged].sort(),
        envVarSources: sources,
        ...(opts.envVarTargets !== undefined &&
        Object.keys(opts.envVarTargets).length > 0
          ? { envVarTargets: opts.envVarTargets }
          : {}),
        ...(opts.envVarValues !== undefined &&
        Object.keys(opts.envVarValues).length > 0
          ? { envVarValues: opts.envVarValues }
          : {}),
        ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
      },
    ),
  };
}

function readEnvVariables(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object") {
    return [];
  }
  return Object.keys(raw as Record<string, unknown>).sort();
}

// The logical id behind each `!Ref X` or `!GetAtt X.Attr` value, so a
// producer that reads a channel from a variable pairs with the resource.
function readEnvVarTargets(
  raw: unknown,
): Record<string, { kind: "ref"; logicalId: string }> {
  const out: Record<string, { kind: "ref"; logicalId: string }> = {};
  if (raw === null || typeof raw !== "object") {
    return out;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const target = readRefTarget(value);
    if (target !== null) {
      out[name] = { kind: "ref", logicalId: target };
    }
  }
  return out;
}

// A plain string value is not a reference, and resolving it as one would
// invent a link the template never made.
function readRefTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return null;
  }
  return refTarget(value);
}

// A store or base URL the code reads from a variable is this string, so
// the boundary can pair with whatever declares it. `!Ref` values are
// handled by readEnvVarTargets.
function readEnvVarValues(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== "object") {
    return out;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[name] = value;
    }
  }
  return out;
}

function readEcsEnvironmentList(raw: unknown): string[] {
  // ECS writes `[{ Name, Value }]` where Lambda writes a map. A Name built
  // with an intrinsic is an object and is skipped.
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const name = (entry as { Name?: unknown }).Name;
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names.sort();
}

/**
 * Where a function's code is and which file it starts in. The queue
 * consumer summaries for the function use the same scope.
 */
export function readCodeScope(resource: CloudFormationResource): {
  kind: "codeUri" | "unknown";
  path?: string;
  entry?: string;
  entryExport?: string;
} {
  // A CodeUri built with an intrinsic cannot be turned into a path.
  const codeUri = resource.Properties?.CodeUri;
  if (typeof codeUri === "string" && codeUri.length > 0) {
    const path = codeScopePath(codeUri);
    const entry = handlerEntry(resource, path);
    return {
      kind: "codeUri",
      path,
      ...(entry !== null
        ? { entry: entry.file, entryExport: entry.exportName }
        : {}),
    };
  }
  // Without a CodeUri, a `Metadata.SussCodeScope` annotation can say
  // which source directory the function runs.
  const metaScope = resource.Metadata?.SussCodeScope;
  if (typeof metaScope === "string" && metaScope.length > 0) {
    return { kind: "codeUri", path: codeScopePath(metaScope) };
  }
  return { kind: "unknown" };
}

// Several functions can share one CodeUri, and the entry file from each
// `Handler` is what keeps their scopes apart. It has no extension, as SAM
// writes it. The export is the function in it that the platform calls.
function handlerEntry(
  resource: CloudFormationResource,
  scopePath: string,
): { file: string; exportName: string } | null {
  const handlerRaw = resource.Properties?.Handler;
  if (typeof handlerRaw !== "string") {
    return null;
  }
  const runtime = resource.Properties?.Runtime;
  const parsed = parseHandler(
    handlerRaw,
    typeof runtime === "string" ? runtime : undefined,
  );
  if (parsed === null) {
    return null;
  }
  return {
    file:
      scopePath === "" || scopePath === "."
        ? parsed.modulePath
        : `${scopePath.replace(/\/$/, "")}/${parsed.modulePath}`,
    exportName: parsed.exportName,
  };
}
