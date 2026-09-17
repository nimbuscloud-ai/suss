// envVars.ts: recognize `process.env.X` reads and emit
// `interaction(class: "config-read")` effects on the units that
// contain them.
//
// Pattern:
//   process.env.STRIPE_API_KEY     → config-read for "STRIPE_API_KEY"
//   process.env["FOO"]             → config-read for "FOO"
//   const { FOO } = process.env     → config-read for "FOO"
//   process.env.X ?? "default"     → config-read for "X" with defaulted=true
//   process.env.X || other        → the same; any ||/?? chain with a
//                                    later operand defaults the read
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
  type ArrowFunction,
  type BindingElement,
  type CallExpression,
  type ElementAccessExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type MethodDeclaration,
  Node as N,
  type Node,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

type FunctionLike =
  | FunctionDeclaration
  | ArrowFunction
  | FunctionExpression
  | MethodDeclaration;

import {
  findEnclosingFunction,
  functionTargetOf,
  isDefaultedAt,
  stringValueOf,
  symbolBehind,
} from "@suss/adapter-typescript";
import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { ResolutionStore } from "@suss/adapter-typescript";
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
function bracketRead(
  access: ElementAccessExpression,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  const argument = access.getArgumentExpression();
  if (argument === undefined) {
    return [];
  }
  if (
    N.isStringLiteral(argument) ||
    N.isNoSubstitutionTemplateLiteral(argument)
  ) {
    const name = argument.getLiteralValue();
    if (name.length === 0) {
      return [];
    }
    return [{ name, defaulted: isDefaultedAt(access), node: access }];
  }
  if (N.isIdentifier(argument)) {
    return readsThroughParameter(access, argument, resolution);
  }
  return [];
}

/**
 * `process.env[name]` where `name` is a parameter of the enclosing
 * function: the reads are the literals the callers pass. A helper like
 * `requireEnv("TABLE_NAME")` is how many services spell every env read,
 * and reporting nothing here made each of those variables look unused.
 * Each read is anchored at its call site, so the unit that passed the
 * literal is the unit that reads the variable.
 */
/**
 * One lookup per read site. The same helper is visited once per unit
 * whose closure contains it, and asking the store is the expensive
 * part, so the repeat visits read the first answer.
 */
const CALLER_LOOKUPS = new WeakMap<Node, EnvRead[]>();

function readsThroughParameter(
  access: ElementAccessExpression,
  index: Identifier,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  const remembered = CALLER_LOOKUPS.get(access);
  if (remembered !== undefined) {
    return remembered;
  }
  const found = callerLiteralReads(access, index, resolution);
  CALLER_LOOKUPS.set(access, found);
  return found;
}

function callerLiteralReads(
  access: ElementAccessExpression,
  index: Identifier,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  if (resolution === undefined) {
    return [];
  }
  const enclosing = findEnclosingFunction(access);
  if (enclosing === null) {
    return [];
  }
  const start = enclosing
    .getParameters()
    .find((parameter) => parameter.getName() === index.getText());
  if (start === undefined) {
    return [];
  }

  const defaulted = isDefaultedAt(access);
  const reads: EnvRead[] = [];
  // A worklist, because the literal can be more than one call away:
  // getEnv(name) handing to requireEnv(name) crosses two. A parameter
  // already taken ends a pair of helpers that call each other.
  const pending: ParameterDeclaration[] = [start];
  const taken = new Set<ParameterDeclaration>();
  while (pending.length > 0) {
    const wanted = pending.pop() as ParameterDeclaration;
    if (taken.has(wanted)) {
      continue;
    }
    taken.add(wanted);
    for (const passed of resolution.argumentsPassedTo(wanted)) {
      const literal = stringValueOf(passed.argument, resolution);
      if (literal !== null && literal.length > 0) {
        reads.push({ name: literal, defaulted, node: passed.call });
        continue;
      }
      const forwarded = forwardedParameter(passed.argument, passed.call);
      if (forwarded !== null) {
        pending.push(forwarded);
      }
    }
  }
  return reads;
}

/** The caller's own parameter an argument passes along, for the worklist. */
function forwardedParameter(
  passed: Node,
  call: Node,
): ParameterDeclaration | null {
  if (!N.isIdentifier(passed)) {
    return null;
  }
  const caller = findEnclosingFunction(call);
  if (caller === null) {
    return null;
  }
  const behind = symbolBehind(passed)?.getValueDeclaration();
  if (behind === undefined || !N.isParameterDeclaration(behind)) {
    return null;
  }
  return behind.getParent() === caller ? behind : null;
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
function readsThroughEnvObject(
  envNode: PropertyAccessExpression,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  const parent = envNode.getParent();
  if (N.isElementAccessExpression(parent)) {
    return bracketRead(parent, resolution);
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
function envReadsAt(
  node: Node,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  if (N.isCallExpression(node)) {
    return readsThroughHelperCall(node, resolution);
  }
  if (!N.isPropertyAccessExpression(node)) {
    return [];
  }
  return isProcessEnv(node)
    ? readsThroughEnvObject(node, resolution)
    : dottedRead(node);
}

/**
 * `requireEnv("TABLE_NAME")` read from the call: the callee's body reads
 * `process.env` through the parameter this literal lands in. The reverse
 * walk in `readsThroughParameter` only fires where the helper's own body
 * is walked, and a call at module scope is in no unit's body (#326), so
 * the call resolves forward too. Anchoring at the call keeps the read in
 * the caller's file whatever file defines the helper.
 */
function readsThroughHelperCall(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  const callee = functionBehindCallee(call.getExpression());
  if (callee === null) {
    return [];
  }
  const sitesNaming = namesReadAtSites(callee, resolution);
  const parameters = callee.getParameters();
  // One read per variable, however many sites end up reading it: a
  // default only counts when every one of them supplies one.
  const defaultedByName = new Map<string, boolean>();
  call.getArguments().forEach((passed, at) => {
    const parameter = parameters[at];
    if (parameter === undefined) {
      return;
    }
    const sites = sitesNaming(parameter) ?? directEnvReads(callee, parameter);
    if (sites.length === 0) {
      return;
    }
    const literal = stringValueOf(passed, resolution);
    if (!namesSomething(literal)) {
      return;
    }
    const everywhere = sites.every(isDefaultedAt);
    defaultedByName.set(
      literal,
      (defaultedByName.get(literal) ?? true) && everywhere,
    );
  });

  const wrapped = isDefaultedAt(call);
  return [...defaultedByName].map(([name, atSites]) => ({
    name,
    defaulted: atSites || wrapped,
    node: call,
  }));
}

/** The function a callee expression is written against, or null when nothing this reader follows defines one. */
function functionBehindCallee(callee: Node): FunctionLike | null {
  const nameNode = N.isPropertyAccessExpression(callee)
    ? callee.getNameNode()
    : callee;
  if (!N.isIdentifier(nameNode)) {
    return null;
  }
  return functionTargetOf(nameNode)?.func ?? null;
}

/** Whether a value read back off an argument is a variable's name. */
function namesSomething(value: string | null): value is string {
  return value !== null && value.length > 0;
}

/**
 * Where each of a callee's parameters is read as an environment
 * variable's name, through however many helpers forward it along the
 * way. The store works that out for a whole project in one question,
 * asked from the reads rather than from the parameters, so a call whose
 * callee reads nothing costs a lookup and no query.
 *
 * Null back from the store means the rules had no facts to go on, and
 * without a store there is no question to ask at all. Both leave this
 * reader the callee's own body, which is the case most services spell.
 */
function namesReadAtSites(
  fn: FunctionLike,
  resolution: ResolutionStore | undefined,
): (parameter: ParameterDeclaration) => readonly Node[] | null {
  if (resolution === undefined) {
    return () => null;
  }
  const namers = resolution.envNamers(fn.getSourceFile());
  return (parameter) => namers.sitesNaming(parameter);
}

/** `process.env[name]` in the callee's own body, the one hop read from syntax. */
function directEnvReads(
  fn: FunctionLike,
  parameter: ParameterDeclaration,
): Node[] {
  const direct = directEnvRead(fn, parameter);
  return direct === null ? [] : [direct];
}

/**
 * `process.env[name]` read directly in a function's own body, or a
 * closure nested in it. The shape is specific to this runtime surface,
 * so nothing in the fact vocabulary reads it on this reader's behalf.
 */
function directEnvRead(
  fn: FunctionLike,
  parameter: ParameterDeclaration,
): ElementAccessExpression | null {
  for (const access of fn.getDescendantsOfKind(
    SyntaxKind.ElementAccessExpression,
  )) {
    if (!isProcessEnv(access.getExpression())) {
      continue;
    }
    const argument = access.getArgumentExpression();
    if (
      argument !== undefined &&
      N.isIdentifier(argument) &&
      symbolBehind(argument)?.getValueDeclaration() === parameter
    ) {
      return access;
    }
  }
  return null;
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
  resolution: ResolutionStore | undefined,
): Effect[] | null {
  const reads = envReadsAt(access as Node, resolution);
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
  resolution?: ResolutionStore,
): Array<{ name: string; defaulted: boolean; line: number }> {
  const out: Array<{ name: string; defaulted: boolean; line: number }> = [];
  // A helper call resolves from the call and from the bracket read in
  // the callee, with the same anchor, so one of the pair is dropped.
  const seen = new Set<string>();
  sourceFile.forEachDescendant((node) => {
    for (const read of envReadsAt(node, resolution)) {
      const key = `${read.node.getPos()}:${read.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
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
  return (access, ctx) =>
    recognizeProcessEnvRead(
      access,
      deploymentTarget,
      instanceName,
      (ctx as { resolution?: ResolutionStore }).resolution,
    );
}
