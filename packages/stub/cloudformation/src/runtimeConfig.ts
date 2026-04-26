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
// "template" vs "platform"). The pairing checker uses the source
// distinction so platform-injected vars never fire envVarUnused.

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

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
 * as `envVarUnprovided` — declaring no vars is itself a contract.
 */
export function buildRuntimeConfigSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
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
      const summary = buildLambdaSummary(logicalId, resource, sourceFile);
      if (summary !== null) {
        summaries.push(summary);
      }
    } else if (type === "AWS::ECS::TaskDefinition") {
      summaries.push(...buildEcsTaskSummaries(logicalId, resource, sourceFile));
    }
  }

  return summaries;
}

function buildLambdaSummary(
  logicalId: string,
  resource: CloudFormationResource,
  sourceFile: string,
): BehavioralSummary | null {
  const props = resource.Properties ?? {};
  const templateVars = readEnvVariables(
    (props.Environment as { Variables?: Record<string, unknown> } | undefined)
      ?.Variables,
  );
  const codeScope = readCodeScope(resource);
  return buildSummary({
    logicalId,
    sourceFile,
    deploymentTarget: "lambda",
    templateVars,
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
  codeScope: { kind: "codeUri" | "unknown"; path?: string };
}): BehavioralSummary | null {
  const platformVars = PLATFORM_INJECTED[opts.deploymentTarget] ?? [];
  const merged = new Set<string>();
  const sources: Record<string, "template" | "platform"> = {};
  for (const v of opts.templateVars) {
    merged.add(v);
    sources[v] = "template";
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
    },
    identity: {
      name: opts.logicalId,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: "cloudformation",
        deploymentTarget: opts.deploymentTarget,
        instanceName: opts.logicalId,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      runtimeContract: {
        envVars: [...merged].sort(),
        envVarSources: sources,
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
    return { kind: "codeUri", path: normalizeCodeUri(codeUri) };
  }
  // Escape hatch for raw CFN / authored projects without CodeUri:
  // a `Metadata.SussCodeScope` annotation lets the user tell the
  // stub which source directory backs this runtime.
  const metaScope = resource.Metadata?.SussCodeScope;
  if (typeof metaScope === "string" && metaScope.length > 0) {
    return { kind: "codeUri", path: normalizeCodeUri(metaScope) };
  }
  return { kind: "unknown" };
}

function normalizeCodeUri(raw: string): string {
  // Trim leading "./" so the path matches summary location.file paths
  // (which are project-relative without a leading slash). Trailing
  // slash is preserved when present so prefix-match in the checker
  // keeps "src/foo/" from matching "src/foobar/".
  let p = raw.trim();
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}
