/**
 * The configuration contract a Wrangler document declares.
 *
 * A Worker reads its variables off the second argument to every
 * trigger, so the channel is the same one a Node process reads through
 * `process.env`, and the summary is the same shape the CloudFormation
 * reader writes for a Lambda: a runtime-config provider, one per
 * deployment, keyed on the deployable unit.
 *
 * The values go on it as well as the names. A Worker addresses a store
 * through a variable rather than by name, `TableName: env.EDITION_TABLE`,
 * so the value is what says which store the access reaches.
 */

import { withRuntimeContractMetadata } from "@suss/behavioral-ir";
import { runtimeConfigBinding } from "@suss/ir-core";

import { BINDING_BLOCKS, bindingNames, RECOGNITION } from "./bindings.js";

import type { BehavioralSummary, EnvVarSource } from "@suss/behavioral-ir";
import type { WranglerDocument } from "./document.js";

/** One Worker as deployed: an environment's document over the default one. */
export interface Deployment {
  /** The name Cloudflare deploys this script under. */
  scriptName: string;
  /** The environment this deployment is, or null for the default one. */
  environment: string | null;
  /** The environment's document with the top-level one behind it. */
  merged: WranglerDocument;
  /** Which variables the top-level document supplied rather than this one. */
  inherited: Set<string>;
}

/**
 * Every deployment a document declares. Wrangler deploys the top-level
 * document as one Worker and each `[env.<name>]` as another, and an
 * environment with no `name` of its own is deployed as
 * `<name>-<environment>`.
 */
export function environmentDocuments(document: WranglerDocument): Deployment[] {
  const rootName = nameOf(document) ?? "worker";
  const deployments: Deployment[] = [
    {
      scriptName: rootName,
      environment: null,
      merged: document,
      inherited: new Set(),
    },
  ];

  const environments = document.env;
  if (environments === null || typeof environments !== "object") {
    return deployments;
  }
  for (const [environment, raw] of Object.entries(environments)) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const overrides = raw as WranglerDocument;
    const merged: WranglerDocument = { ...document, ...overrides };
    // An environment's own document declares no environments, and
    // leaving the parent's here would deploy each of them twice.
    delete merged.env;
    deployments.push({
      scriptName: nameOf(overrides) ?? `${rootName}-${environment}`,
      environment,
      merged,
      inherited: inheritedNames(document, overrides),
    });
  }
  return deployments;
}

/**
 * The variables and bindings an environment takes from the top-level
 * document. An environment that declares a block of its own replaces
 * the whole block, which is Wrangler's rule rather than a merge.
 */
function inheritedNames(
  document: WranglerDocument,
  overrides: WranglerDocument,
): Set<string> {
  const names = new Set<string>();
  if (overrides.vars === undefined) {
    for (const name of Object.keys(varsOf(document))) {
      names.add(name);
    }
  }

  const kept: Record<string, unknown> = {};
  for (const block of BINDING_BLOCKS) {
    if (overrides[block] === undefined) {
      kept[block] = document[block];
    }
  }
  for (const name of bindingNames(kept)) {
    names.add(name);
  }
  return names;
}

function nameOf(document: WranglerDocument): string | null {
  return typeof document.name === "string" && document.name.length > 0
    ? document.name
    : null;
}

function varsOf(document: WranglerDocument): Record<string, unknown> {
  const vars = document.vars;
  return vars !== null && typeof vars === "object" && !Array.isArray(vars)
    ? (vars as Record<string, unknown>)
    : {};
}

export interface RuntimeConfigContext {
  sourceFile: string;
  codeScope: { kind: "codeUri" | "unknown"; path?: string; entry?: string };
}

/** The runtime-config provider one deployment declares. */
export function runtimeConfigSummary(
  deployment: Deployment,
  context: RuntimeConfigContext,
): BehavioralSummary {
  const vars = varsOf(deployment.merged);
  // A binding is a property of the same env object the vars arrive on,
  // so the contract lists it too: a read of `env.SESSIONS` is supplied
  // by the deployment exactly when the document declares the binding.
  const names = [
    ...new Set([...Object.keys(vars), ...bindingNames(deployment.merged)]),
  ].sort();
  const sources: Record<string, EnvVarSource> = {};
  const values: Record<string, string> = {};
  for (const name of names) {
    sources[name] = deployment.inherited.has(name) ? "globals" : "template";
    const value = vars[name];
    if (typeof value === "string") {
      values[name] = value;
    }
  }

  const deployableUnit = {
    deploymentTarget: "worker" as const,
    instanceName: deployment.scriptName,
  };
  return {
    kind: "library",
    location: {
      file: context.sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: {
      name: deployment.scriptName,
      exportPath: null,
      boundaryBinding: runtimeConfigBinding({
        recognition: RECOGNITION,
        ...deployableUnit,
      }),
      deployableUnit,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withRuntimeContractMetadata(
      { codeScope: context.codeScope },
      {
        envVars: names,
        envVarSources: sources,
        ...(Object.keys(values).length > 0 ? { envVarValues: values } : {}),
      },
    ),
  };
}
