/**
 * Reads of the `process` global other than `process.env`. A read of
 * `process.argv` becomes a config read, the same kind of effect an
 * environment variable gets. Reads such as `process.cwd` or
 * `process.platform` become metadata reads, which record the unit's
 * dependency on the runtime without being paired against anything.
 *
 * `envVarRecognizer` handles `process.env.X`, and this recognizer skips
 * it, so no read produces two effects.
 */

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

/** True when `node` is the `.X` access in `process.env.X`. */
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
 * `env` and `argv` are left out because they are config reads.
 * envVarRecognizer handles `env`, and argvRead handles `argv`.
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
  if (isProcessEnvVarRead(node)) {
    return null;
  }

  const subject = node.getExpression();
  const name = node.getName();

  if (isProcessIdentifier(subject) && name === "argv") {
    return [argvRead(where, node.getText(), null)];
  }

  if (isProcessIdentifier(subject) && OPAQUE_PROPERTY_NAMES.has(name)) {
    return [opaqueRuntimeRead(node.getText())];
  }

  return null;
}

function recognizeElementAccess(
  node: ElementAccessExpression,
  where: DeploymentOptions,
): Effect[] | null {
  // Only `process.argv[N]`. A computed key such as `process[key]` could
  // be any property.
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
  // `process.argv[1]` is named `argv[1]` and any other use is named
  // `argv`. Pairing treats both as the same channel.
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
