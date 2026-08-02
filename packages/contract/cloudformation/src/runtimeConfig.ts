// runtimeConfig.ts — extract runtime-configuration provider summaries
// from CFN/SAM resources that declare an env-var contract.
//
// Recognized resource types and where their env vars live:
//
//   AWS::Lambda::Function           Properties.Environment.Variables
//   AWS::Serverless::Function       Properties.Environment.Variables
//                                   Properties.CodeUri  (SAM)
//   AWS::ECS::TaskDefinition        Properties.ContainerDefinitions[*].Environment
//                                   (one summary per container)
//
// Each summary carries `metadata.runtimeContract.envVars` (the FULL
// set the process sees, including platform-injected vars) and
// `metadata.runtimeContract.envVarSources` (provenance per name —
// "template", "globals" or "platform"). The pairing checker uses the
// source distinction so platform-injected vars never fire
// boundaryFieldUnused, and so a name the whole document supplies is
// judged across the document rather than function by function.

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { codeScopePath } from "@suss/ir-core";
import { refTarget } from "@suss/manifest-aws";

import type { BehavioralSummary, DeployableUnit } from "@suss/behavioral-ir";

interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

/**
 * Env vars the runtime injects into the process automatically,
 * regardless of what the template declares. Sourced from each
 * platform's documentation:
 *
 *   Lambda: https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html
 *           "Reserved environment variables"
 *   ECS:    https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_metadata.html
 *           plus the AWS_DEFAULT_REGION the Fargate runtime sets.
 */
const PLATFORM_INJECTED: Record<
  "lambda" | "ecs-task" | "container" | "k8s-deployment",
  ReadonlyArray<string>
> = {
  lambda: [
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_LAMBDA_FUNCTION_NAME",
    "AWS_LAMBDA_FUNCTION_VERSION",
    "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
    "AWS_LAMBDA_LOG_GROUP_NAME",
    "AWS_LAMBDA_LOG_STREAM_NAME",
    "AWS_LAMBDA_RUNTIME_API",
    "AWS_EXECUTION_ENV",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "LAMBDA_TASK_ROOT",
    "LAMBDA_RUNTIME_DIR",
    "_HANDLER",
    "_X_AMZN_TRACE_ID",
    "TZ",
  ],
  "ecs-task": [
    "AWS_DEFAULT_REGION",
    "AWS_REGION",
    "ECS_CONTAINER_METADATA_URI",
    "ECS_CONTAINER_METADATA_URI_V4",
    "ECS_AGENT_URI",
  ],
  container: [],
  "k8s-deployment": [
    "KUBERNETES_SERVICE_HOST",
    "KUBERNETES_SERVICE_PORT",
    "KUBERNETES_PORT",
    "HOSTNAME",
  ],
};

/**
 * Walk the template's resources and emit one runtime-config provider
 * summary per Lambda / ECS task / etc. that declares an environment
 * block. Resources without an Environment property still emit a
 * summary so the checker can flag any env-var read scoped to them
 * as `boundaryFieldUnknown` (aspect: read) — declaring no vars is
 * itself a contract.
 */
export function buildRuntimeConfigSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
  inheritedEnvVars: Record<string, string[]> = {},
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];

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
        sourceFile,
        inherited: inheritedEnvVars[logicalId] ?? [],
      });
      if (summary !== null) {
        summaries.push(summary);
      }
    } else if (type === "AWS::ECS::TaskDefinition") {
      summaries.push(...buildEcsTaskSummaries(logicalId, resource, sourceFile));
    }
  }

  return summaries;
}

function buildLambdaSummary(opts: {
  logicalId: string;
  resource: CloudFormationResource;
  sourceFile: string;
  /** Variables the SAM Globals section supplies to this function. */
  inherited: string[];
}): BehavioralSummary | null {
  const { logicalId, resource, sourceFile } = opts;
  const props = resource.Properties ?? {};
  const envVariables =
    (props.Environment as { Variables?: Record<string, unknown> } | undefined)
      ?.Variables ?? {};
  const templateVars = readEnvVariables(envVariables);
  const envVarTargets = readEnvVarTargets(envVariables);
  const codeScope = readCodeScope(resource);
  return buildSummary({
    logicalId,
    sourceFile,
    deploymentTarget: "lambda",
    templateVars,
    inheritedVars: opts.inherited,
    envVarTargets,
    codeScope,
  });
}

function buildEcsTaskSummaries(
  logicalId: string,
  resource: CloudFormationResource,
  sourceFile: string,
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
      // ECS gives one summary per container, distinguished by the
      // composed instance name `${TaskLogicalId}/${ContainerName}`.
      logicalId: `${logicalId}/${containerName}`,
      sourceFile,
      deploymentTarget: "ecs-task",
      templateVars,
      codeScope,
    });
    if (summary !== null) {
      summaries.push(summary);
    }
  }
  return summaries;
}

function buildSummary(opts: {
  logicalId: string;
  sourceFile: string;
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  templateVars: string[];
  /**
   * The subset of `templateVars` a document-level default supplies
   * rather than the resource itself. Recorded as its own provenance so
   * the checker asks about it once for the document.
   */
  inheritedVars?: string[];
  /**
   * Resolved CFN-ref targets for env vars. Maps the env var NAME the
   * code reads to the LOGICAL ID of the resource it Refs. Lets the
   * message-bus pairing (and any future cross-resource pairing) collapse
   * the env-var → resource chain at check time. Only populated for env
   * vars whose values are recognised CFN intrinsics (Ref, GetAtt). Plain
   * string values produce no entry — they're "data," not "wiring."
   */
  envVarTargets?: Record<string, { kind: "ref"; logicalId: string }>;
  codeScope: { kind: "codeUri" | "unknown"; path?: string };
}): BehavioralSummary | null {
  const deployableUnit: DeployableUnit = {
    deploymentTarget: opts.deploymentTarget,
    instanceName: opts.logicalId,
  };
  const platformVars = PLATFORM_INJECTED[opts.deploymentTarget] ?? [];
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
    location: {
      file: opts.sourceFile,
      range: { start: 1, end: 1 },
      // Runtime-config summaries don't have an export name — they're
      // synthesized from a CFN/SAM resource block, not exported from
      // any module. The schema's required-but-nullable contract reads
      // null as "no exportName applies."
      exportName: null,
    },
    identity: {
      name: opts.logicalId,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "cloudformation",
        ...deployableUnit,
      }),
      // The binding keeps its own copy because the unit is what keys a
      // runtime-config boundary, not incidental to it.
      deployableUnit,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: {
        envVars: [...merged].sort(),
        envVarSources: sources,
        ...(opts.envVarTargets !== undefined &&
        Object.keys(opts.envVarTargets).length > 0
          ? { envVarTargets: opts.envVarTargets }
          : {}),
      },
      codeScope: opts.codeScope,
    },
  };
}

function readEnvVariables(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object") {
    return [];
  }
  return Object.keys(raw as Record<string, unknown>).sort();
}

/**
 * Inspect each Lambda env var value and extract the CFN logical id
 * it resolves to (when the value is `!Ref X` or `!GetAtt X.Attr`).
 * Plain string values are skipped — they're data, not wiring.
 *
 * Used by message-bus pairing (and future cross-resource pairing
 * passes) to bridge env-var-named producer channels to CFN-resource-
 * named provider channels.
 */
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

/**
 * A bare string env-var value is data rather than wiring, so resolving
 * it would invent a reference the template never made. Every other
 * reference shape is the shared one.
 */
function readRefTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return null;
  }
  return refTarget(value);
}

function readEcsEnvironmentList(raw: unknown): string[] {
  // ECS uses [{Name: "FOO", Value: "bar"}, ...] rather than the
  // Lambda map shape. Skip non-string Name entries (CloudFormation
  // Ref or Fn::Sub objects show up as objects; we only capture the
  // declared name when it's static).
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

function readCodeScope(resource: CloudFormationResource): {
  kind: "codeUri" | "unknown";
  path?: string;
} {
  // SAM authoring shape: Properties.CodeUri points at a directory
  // (or a single file). Only string values are useful — Ref / Fn::Sub
  // objects can't be statically resolved to a path.
  const codeUri = resource.Properties?.CodeUri;
  if (typeof codeUri === "string" && codeUri.length > 0) {
    return { kind: "codeUri", path: codeScopePath(codeUri) };
  }
  // Escape hatch for raw CFN / authored projects without CodeUri:
  // a `Metadata.SussCodeScope` annotation lets the user tell the
  // stub which source directory backs this runtime.
  const metaScope = resource.Metadata?.SussCodeScope;
  if (typeof metaScope === "string" && metaScope.length > 0) {
    return { kind: "codeUri", path: codeScopePath(metaScope) };
  }
  return { kind: "unknown" };
}
