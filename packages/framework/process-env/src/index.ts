// @suss/framework-process-env — recognize `process.env.X` reads in
// TypeScript code and emit `interaction(class: "config-read")` effects
// on the transitions that contain them.
//
// Pattern:
//   process.env.STRIPE_API_KEY     → config-read for "STRIPE_API_KEY"
//   process.env["FOO"]             → config-read for "FOO"
//   process.env.X ?? "default"     → config-read for "X" with defaulted=true
//
// The recognizer fires on PropertyAccessExpression nodes (sister to
// invocationRecognizers but for property reads). Each match emits one
// effect; pairing logic in checkRuntimeConfig matches them against
// runtime-config provider summaries (Lambda env-var declarations,
// ECS env blocks, etc.).
//
// Pairing identity for config-read interactions doesn't need a
// boundaryBinding — the env-var name IS the channel identity, and
// runtime-config providers carry the full env-var set in their
// metadata. The recognizer emits effects with a synthetic binding
// (recognition: "@suss/framework-process-env", semantics:
// runtime-config) so the unified pairing dispatcher can route the
// effect to the right finding generator.

import {
  Node as N,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer, PatternPack } from "@suss/extractor";

export interface ProcessEnvRecognizerOptions {
  /**
   * Deployment target context for the emitted binding. Defaults to
   * `"lambda"` since that's the dominant deployment for which suss
   * has runtime-config providers today (CFN/SAM Lambda env-var
   * declarations). The value isn't load-bearing for pairing — the
   * env-var name does the work — but it keeps the binding's
   * semantics shape consistent with provider summaries.
   */
  deploymentTarget?: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  /**
   * Instance name placeholder for the emitted binding. The pairing
   * dispatcher uses metadata.codeScope on runtime-config providers
   * to scope reads to a specific instance, so this is informational.
   * Defaults to `"<unknown>"`.
   */
  instanceName?: string;
}

function makeRecognizer(opts: ProcessEnvRecognizerOptions): AccessRecognizer {
  const deploymentTarget = opts.deploymentTarget ?? "lambda";
  const instanceName = opts.instanceName ?? "<unknown>";
  return (access, ctx) =>
    recognizeProcessEnvRead(access, ctx, deploymentTarget, instanceName);
}

function recognizeProcessEnvRead(
  access: unknown,
  _ctx: unknown,
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment",
  instanceName: string,
): Effect[] | null {
  const node = access as PropertyAccessExpression;
  if (!N.isPropertyAccessExpression(node)) {
    return null;
  }
  // The shape we want: process.env.X (a chain of two property accesses
  // where the inner is `process.env` and the outer is the var name).
  const envExpr = node.getExpression();
  if (!N.isPropertyAccessExpression(envExpr)) {
    return null;
  }
  if (envExpr.getName() !== "env") {
    return null;
  }
  const root = envExpr.getExpression();
  if (!N.isIdentifier(root) || root.getText() !== "process") {
    return null;
  }

  const varName = node.getName();
  if (varName.length === 0) {
    return null;
  }

  // Detect the `?? "fallback"` pattern to mark defaulted reads. The
  // node's parent is the BinaryExpression when this applies.
  const parent = node.getParent();
  const defaulted =
    parent !== undefined && isNullishCoalescingWith(parent, node);

  return [
    {
      type: "interaction",
      binding: runtimeConfigBinding({
        recognition: "@suss/framework-process-env",
        deploymentTarget,
        instanceName,
      }),
      callee: node.getText(),
      interaction: {
        class: "config-read",
        name: varName,
        defaulted,
      },
    },
  ];
}

function isNullishCoalescingWith(parent: Node, child: Node): boolean {
  if (!N.isBinaryExpression(parent)) {
    return false;
  }
  const op = parent.getOperatorToken().getKind();
  // SyntaxKind.QuestionQuestionToken === 61 in TS 5.x. Avoid importing
  // the SyntaxKind enum just for this — string-equality on the token
  // text is robust to TS version drift and clearer for readers.
  if (parent.getOperatorToken().getText() !== "??") {
    void op;
    return false;
  }
  // Make sure WE are on the left of the ?? (the env read), not the
  // fallback on the right. `process.env.X ?? "default"` defaults X;
  // `getDefault() ?? process.env.X` doesn't (env read is the fallback
  // FOR something else, not the thing being defaulted).
  return parent.getLeft() === child;
}

/**
 * Walk PropertyAccessExpression nodes for `process.env.X` reads
 * inside an `index.ts`-style source file. Used by tests and by
 * downstream packs that want to consume env-var reads outside the
 * recognizer dispatch (rare). Most consumers should let the adapter
 * wire the recognizer via the pack.
 */
export function findProcessEnvReads(
  sourceFile: SourceFile,
): Array<{ name: string; defaulted: boolean; line: number }> {
  const out: Array<{ name: string; defaulted: boolean; line: number }> = [];
  sourceFile.forEachDescendant((node) => {
    if (!N.isPropertyAccessExpression(node)) {
      return;
    }
    const envExpr = node.getExpression();
    if (!N.isPropertyAccessExpression(envExpr)) {
      return;
    }
    if (envExpr.getName() !== "env") {
      return;
    }
    const root = envExpr.getExpression();
    if (!N.isIdentifier(root) || root.getText() !== "process") {
      return;
    }
    const parent = node.getParent();
    const defaulted =
      parent !== undefined && isNullishCoalescingWith(parent, node);
    out.push({
      name: node.getName(),
      defaulted,
      line: node.getStartLineNumber(),
    });
  });
  return out;
}

/**
 * Pack export. Recognizer-only — no discovery patterns or terminals.
 * The runtime-config provider summaries it pairs against come from
 * @suss/contract-cloudformation (or future container/k8s contract
 * sources).
 */
export function processEnvFramework(
  options: ProcessEnvRecognizerOptions = {},
): PatternPack {
  return {
    name: "process-env",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    accessRecognizers: [makeRecognizer(options)],
  };
}

export default processEnvFramework;
