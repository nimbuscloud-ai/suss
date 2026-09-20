// processSurface.ts: recognize reads of the Node `process` global
// (argv, cwd, platform, version, versions). Each becomes an effect
// stamped with an opacity reason so downstream tooling sees the
// dependency on the runtime surface.
//
// `process.env.X` reads are deliberately NOT handled here, the
// sibling `envVarRecognizer` (envVars.ts) owns that slice and emits
// a pairing-grade `config-read` interaction. The two recognizers
// partition the `process.*` space without duplication: the env-var
// recognizer fires only on `process.env.X`, and the process-surface
// recognizer here skips that shape explicitly.

import {
  type ElementAccessExpression,
  Node,
  type PropertyAccessExpression,
} from "ts-morph";

import { configBinding, opaqueRuntimeRead } from "./configBinding.js";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type { DeploymentOptions } from "./configBinding.js";

export type ProcessSurfaceOptions = DeploymentOptions;

/**
 * Read of `process.env.X`, let the sibling `envVarRecognizer`
 * handle these. Returns true when `node` is the outer `.X` access on
 * a `process.env` chain.
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
  where: ProcessSurfaceOptions,
): AccessRecognizer {
  return (access, _ctx) => {
    const node = access as Node;
    if (Node.isPropertyAccessExpression(node)) {
      return recognizeProperty(node, where);
    }
    if (Node.isElementAccessExpression(node)) {
      return recognizeElementAccess(node, where);
    }
    return null;
  };
}

function recognizeProperty(
  node: PropertyAccessExpression,
  where: DeploymentOptions,
): Effect[] | null {
  // Skip env-var reads: handled by the sibling envVarRecognizer.
  if (isProcessEnvVarRead(node)) {
    return null;
  }

  const subject = node.getExpression();
  const name = node.getName();

  // process.argv as a runtime-config channel, same shape as env vars.
  if (isProcessIdentifier(subject) && name === "argv") {
    return [argvRead(where, node.getText(), null)];
  }

  // process.cwd / .platform / .version / etc. opaque metadata.
  if (isProcessIdentifier(subject) && OPAQUE_PROPERTY_NAMES.has(name)) {
    return [opaqueRuntimeRead(node.getText())];
  }

  return null;
}

function recognizeElementAccess(
  node: ElementAccessExpression,
  where: DeploymentOptions,
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
  return [argvRead(where, node.getText(), indexLabel)];
}

function argvRead(
  where: DeploymentOptions,
  callee: string,
  indexLabel: string | null,
): Effect {
  // argv[N] as `argv[0]`, `argv[1]`, …; bare `argv` (slice / loop) as
  // `argv`. The pairing dispatcher treats both as the same channel.
  const name = indexLabel !== null ? `argv[${indexLabel}]` : "argv";
  return {
    type: "interaction",
    binding: configBinding(where),
    callee,
    interaction: {
      class: "config-read",
      name,
      defaulted: false,
    },
  };
}

export function processSurfaceRecognizer(
  opts: ProcessSurfaceOptions = {},
): AccessRecognizer {
  return makeProcessSurfaceRecognizer(opts);
}
