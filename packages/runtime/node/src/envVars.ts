// envVars.ts: recognize `process.env.X` reads and emit
// `interaction(class: "config-read")` effects on the units that
// contain them.
//
// Pattern:
//   process.env.STRIPE_API_KEY     → config-read for "STRIPE_API_KEY"
//   process.env["FOO"]             → config-read for "FOO"
//   const { FOO } = process.env     → config-read for "FOO"
//   process.env.X ?? "default"     → config-read for "X" with defaulted=true
//
// The adapter hands access recognizers property accesses and nothing
// else, so the three spellings are recognized from the one node they
// all share, `process.env`, by asking what encloses it. A dotted read
// is enclosed by the property access naming the variable, a bracket
// read by an element access, and a destructuring by the declaration it
// initializes.
//
// `process.env` is Node-defined behavior, the env-var channel is part
// of the deployable unit's runtime-config contract, so this lives
// alongside the rest of the process surface in the node runtime pack.
// The sibling `processSurfaceRecognizer` (processSurface.ts) covers
// argv / cwd / platform / etc. and skips `process.env.X` so the two
// recognizers partition the `process.*` space without duplication.
//
// Pairing identity for config-read interactions doesn't need a
// boundaryBinding: the env-var name IS the channel identity, and
// runtime-config providers carry the full env-var set in their
// metadata. The recognizer emits effects with a synthetic binding
// (recognition: "@suss/runtime-node", semantics: runtime-config) so
// the unified pairing dispatcher can route the effect to the right
// finding generator. `checkRuntimeConfig` matches the emitted
// effects against runtime-config provider summaries (Lambda env-var
// declarations, ECS env blocks, etc.).

import {
  type BindingElement,
  type ElementAccessExpression,
  Node as N,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";

export interface EnvVarRecognizerOptions {
  /**
   * Deployment target context for the emitted binding. Defaults to
   * `"lambda"` since that's the dominant deployment for which suss
   * has runtime-config providers today (CFN/SAM Lambda env-var
   * declarations). The value does not affect pairing, the
   * env-var name does the work, but it keeps the binding's
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

/** One variable a program reads, before it becomes an effect. */
interface EnvRead {
  name: string;
  defaulted: boolean;
  /** The node the read is anchored to, for line numbers. */
  node: Node;
}

/**
 * How an effect spells the read. All three spellings reach the same
 * variable, so all three are named the same way: a consumer grouping
 * reads of one variable should not have to parse an index argument or
 * a binding pattern to see that it is looking at one channel.
 */
const readName = (name: string): string => `process.env.${name}`;

/** Whether a node is the `process.env` object itself. */
function isProcessEnv(node: Node): node is PropertyAccessExpression {
  if (!N.isPropertyAccessExpression(node) || node.getName() !== "env") {
    return false;
  }
  const root = node.getExpression();
  return N.isIdentifier(root) && root.getText() === "process";
}

/** `process.env.NAME`, where the property is the variable's name. */
function dottedRead(node: PropertyAccessExpression): EnvRead[] {
  if (!isProcessEnv(node.getExpression())) {
    return [];
  }
  return [{ name: node.getName(), defaulted: isDefaultedAt(node), node }];
}

/**
 * `process.env["NAME"]`, where the index is the variable's name. An index
 * the pack cannot read back as a literal refers to a variable nothing can
 * pair against, so it reports nothing rather than a guess.
 */
function bracketRead(access: ElementAccessExpression): EnvRead[] {
  const argument = access.getArgumentExpression();
  if (
    argument === undefined ||
    !(
      N.isStringLiteral(argument) || N.isNoSubstitutionTemplateLiteral(argument)
    )
  ) {
    return [];
  }
  const name = argument.getLiteralValue();
  if (name.length === 0) {
    return [];
  }
  return [{ name, defaulted: isDefaultedAt(access), node: access }];
}

/** The variable one element of `const { A, B: c } = process.env` names. */
function bindingRead(element: BindingElement): EnvRead[] {
  if (element.getDotDotDotToken() !== undefined) {
    return [];
  }
  const named = element.getPropertyNameNode() ?? element.getNameNode();
  if (!(N.isIdentifier(named) || N.isStringLiteral(named))) {
    return [];
  }
  const name = N.isIdentifier(named)
    ? named.getText()
    : named.getLiteralValue();
  if (name.length === 0) {
    return [];
  }
  return [
    {
      name,
      // A binding default supplies the value the variable is missing,
      // which is what `??` does for the other two spellings.
      defaulted: element.getInitializer() !== undefined,
      node: element,
    },
  ];
}

/** Every variable `const { ... } = process.env` names. */
function destructuredReads(declaration: VariableDeclaration): EnvRead[] {
  const pattern = declaration.getNameNode();
  if (!N.isObjectBindingPattern(pattern)) {
    return [];
  }
  return pattern.getElements().flatMap(bindingRead);
}

/**
 * The reads spelled through the `process.env` object rather than
 * through a property of it. Both put the variable name somewhere the
 * dotted form does not: in an index argument, or in a binding pattern.
 */
function readsThroughEnvObject(envNode: PropertyAccessExpression): EnvRead[] {
  const parent = envNode.getParent();
  if (N.isElementAccessExpression(parent)) {
    return bracketRead(parent);
  }
  if (N.isVariableDeclaration(parent)) {
    return destructuredReads(parent);
  }
  return [];
}

/**
 * Every variable a property access reads off `process.env`. The walk
 * visits both nodes of `process.env.NAME`, so each spelling is
 * recognized from exactly one of them and the dotted read is reported
 * once.
 */
function envReadsAt(node: Node): EnvRead[] {
  if (!N.isPropertyAccessExpression(node)) {
    return [];
  }
  return isProcessEnv(node) ? readsThroughEnvObject(node) : dottedRead(node);
}

function isDefaultedAt(node: Node): boolean {
  const parent = node.getParent();
  return parent !== undefined && isNullishCoalescingWith(parent, node);
}

function isNullishCoalescingWith(parent: Node, child: Node): boolean {
  if (!N.isBinaryExpression(parent)) {
    return false;
  }
  // String-equality on the token text rather than the SyntaxKind enum,
  // which renumbers between TypeScript releases.
  if (parent.getOperatorToken().getText() !== "??") {
    return false;
  }
  // Make sure WE are on the left of the ?? (the env read), not the
  // fallback on the right. `process.env.X ?? "default"` defaults X;
  // `getDefault() ?? process.env.X` doesn't (env read is the fallback
  // FOR something else, not the thing being defaulted).
  return parent.getLeft() === child;
}

function configReadEffect(
  read: EnvRead,
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment",
  instanceName: string,
): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: "@suss/runtime-node",
      deploymentTarget,
      instanceName,
    }),
    callee: readName(read.name),
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
    },
  };
}

function recognizeProcessEnvRead(
  access: unknown,
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment",
  instanceName: string,
): Effect[] | null {
  const reads = envReadsAt(access as Node);
  if (reads.length === 0) {
    return null;
  }
  return reads.map((read) =>
    configReadEffect(read, deploymentTarget, instanceName),
  );
}

/**
 * Walk a source file for every `process.env` read, in all three
 * spellings. Used by tests and by downstream consumers that want to
 * enumerate env-var reads outside the recognizer dispatch (rare). Most
 * consumers should let the adapter wire the recognizer via the pack.
 */
export function findProcessEnvReads(
  sourceFile: SourceFile,
): Array<{ name: string; defaulted: boolean; line: number }> {
  const out: Array<{ name: string; defaulted: boolean; line: number }> = [];
  sourceFile.forEachDescendant((node) => {
    for (const read of envReadsAt(node)) {
      out.push({
        name: read.name,
        defaulted: read.defaulted,
        line: read.node.getStartLineNumber(),
      });
    }
  });
  return out;
}

/**
 * Access recognizer for `process.env.X` reads. Sister to
 * `processSurfaceRecognizer`: both fire on PropertyAccessExpression
 * nodes; this one owns the `process.env.*` slice, the other owns the
 * rest of the process surface.
 */
export function envVarRecognizer(
  opts: EnvVarRecognizerOptions = {},
): AccessRecognizer {
  const deploymentTarget = opts.deploymentTarget ?? "lambda";
  const instanceName = opts.instanceName ?? "<unknown>";
  return (access, _ctx) =>
    recognizeProcessEnvRead(access, deploymentTarget, instanceName);
}
