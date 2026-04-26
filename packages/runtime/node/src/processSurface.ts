// processSurface.ts — recognize reads of the Node `process` global
// (argv, cwd, platform, version, versions). Each becomes an effect
// stamped with an opacity reason so downstream tooling sees the
// dependency on the runtime surface.
//
// `process.env.X` reads are deliberately NOT handled here — they're
// already covered by @suss/framework-process-env, which emits a
// pairing-grade `config-read` interaction. Subsuming that recognizer
// is its own follow-up (per the design doc); for now both packs can
// be loaded together without duplication because the env-var
// recognizer fires only on `process.env.X`, and the process-surface
// recognizer here skips that shape explicitly.

import {
  type ElementAccessExpression,
  Node,
  type PropertyAccessExpression,
} from "ts-morph";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";

export interface ProcessSurfaceOptions {
  /**
   * Deployment context for argv reads. Same shape as the env-var
   * recognizer's option — argv and env-vars share the runtime-config
   * channel concept.
   */
  deploymentTarget?: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  /**
   * Instance name placeholder for the emitted runtime-config binding.
   * Informational; pairing dispatcher uses provider-side metadata to
   * scope reads.
   */
  instanceName?: string;
}

/**
 * Read of `process.env.X` — let the env-var pack handle these.
 * Returns true when `node` is the outer `.X` access on a
 * `process.env` chain.
 */
function isProcessEnvVarRead(node: PropertyAccessExpression): boolean {
  const inner = node.getExpression();
  if (!Node.isPropertyAccessExpression(inner)) {
    return false;
  }
  if (inner.getName() !== "env") {
    return false;
  }
  const root = inner.getExpression();
  return Node.isIdentifier(root) && root.getText() === "process";
}

function isProcessIdentifier(node: Node): boolean {
  return Node.isIdentifier(node) && node.getText() === "process";
}

/**
 * Property accesses we treat as opaque runtime-metadata reads.
 * Excludes `env` (handled by env-var pack) and `argv` (handled
 * separately as a runtime-config channel).
 */
const OPAQUE_PROPERTY_NAMES = new Set([
  "cwd",
  "platform",
  "version",
  "versions",
  "pid",
  "ppid",
  "arch",
  "execPath",
  "execArgv",
]);

function makeProcessSurfaceRecognizer(
  opts: ProcessSurfaceOptions,
): AccessRecognizer {
  const deploymentTarget = opts.deploymentTarget ?? "lambda";
  const instanceName = opts.instanceName ?? "<unknown>";

  return (access, _ctx) => {
    const node = access as Node;
    if (Node.isPropertyAccessExpression(node)) {
      return recognizeProperty(node, deploymentTarget, instanceName);
    }
    if (Node.isElementAccessExpression(node)) {
      return recognizeElementAccess(node, deploymentTarget, instanceName);
    }
    return null;
  };
}

function recognizeProperty(
  node: PropertyAccessExpression,
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment",
  instanceName: string,
): Effect[] | null {
  // Skip env-var reads — handled by @suss/framework-process-env.
  if (isProcessEnvVarRead(node)) {
    return null;
  }

  const subject = node.getExpression();
  const name = node.getName();

  // process.argv as a runtime-config channel — same shape as env vars.
  if (isProcessIdentifier(subject) && name === "argv") {
    return [argvRead(deploymentTarget, instanceName, node.getText(), null)];
  }

  // process.cwd / .platform / .version / etc. — opaque metadata.
  if (isProcessIdentifier(subject) && OPAQUE_PROPERTY_NAMES.has(name)) {
    return [opaqueProcessRead(node.getText(), `process.${name}`)];
  }

  return null;
}

function recognizeElementAccess(
  node: ElementAccessExpression,
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment",
  instanceName: string,
): Effect[] | null {
  // Only `process.argv[N]` is recognized via element access. Other
  // element-access patterns (process[someComputedKey]) are too
  // dynamic to attribute statically.
  const subject = node.getExpression();
  if (!Node.isPropertyAccessExpression(subject)) {
    return null;
  }
  if (subject.getName() !== "argv") {
    return null;
  }
  const root = subject.getExpression();
  if (!isProcessIdentifier(root)) {
    return null;
  }

  const arg = node.getArgumentExpression();
  let indexLabel: string | null = null;
  if (arg !== undefined && Node.isNumericLiteral(arg)) {
    indexLabel = String(arg.getLiteralValue());
  }
  return [argvRead(deploymentTarget, instanceName, node.getText(), indexLabel)];
}

function argvRead(
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment",
  instanceName: string,
  callee: string,
  indexLabel: string | null,
): Effect {
  // argv[N] as `argv[0]`, `argv[1]`, …; bare `argv` (slice / loop) as
  // `argv`. The pairing dispatcher treats both as the same channel.
  const name = indexLabel !== null ? `argv[${indexLabel}]` : "argv";
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: "@suss/runtime-node",
      deploymentTarget,
      instanceName,
    }),
    callee,
    interaction: {
      class: "config-read",
      name,
      defaulted: false,
    },
  };
}

function opaqueProcessRead(callee: string, _label: string): Effect {
  // Opaque runtime-metadata reads don't have a pairing target — they
  // describe the unit's dependency on the runtime, not a contract.
  // Use a runtime-config interaction with a synthetic "<runtime>"
  // name so the pairing dispatcher routes it correctly while keeping
  // the channel name distinct from real env-var / argv channels.
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: "@suss/runtime-node",
      deploymentTarget: "lambda",
      instanceName: "<runtime>",
    }),
    callee,
    interaction: {
      class: "config-read",
      name: callee,
      defaulted: false,
    },
  };
}

export function processSurfaceRecognizer(
  opts: ProcessSurfaceOptions = {},
): AccessRecognizer {
  return makeProcessSurfaceRecognizer(opts);
}
