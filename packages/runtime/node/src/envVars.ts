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
  type PropertyAccessExpression,
  type SourceFile,
  type VariableDeclaration,
  VariableDeclarationKind,
} from "ts-morph";

type FunctionLike =
  | FunctionDeclaration
  | ArrowFunction
  | FunctionExpression
  | MethodDeclaration;

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
    return readsThroughParameter(access, argument);
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
 * One lookup per read site. The same helper is visited once per unit whose
 * closure contains it, and findReferences is the expensive part, so the
 * repeat visits read the first answer.
 */
const CALLER_LOOKUPS = new WeakMap<Node, EnvRead[]>();

function readsThroughParameter(
  access: ElementAccessExpression,
  index: Identifier,
): EnvRead[] {
  const remembered = CALLER_LOOKUPS.get(access);
  if (remembered !== undefined) {
    return remembered;
  }
  const found = callerLiteralReads(access, index);
  CALLER_LOOKUPS.set(access, found);
  return found;
}

function callerLiteralReads(
  access: ElementAccessExpression,
  index: Identifier,
): EnvRead[] {
  const enclosing = enclosingFunction(access);
  if (enclosing === undefined) {
    return [];
  }
  const at = enclosing
    .getParameters()
    .findIndex((parameter) => parameter.getName() === index.getText());
  if (at === -1) {
    return [];
  }

  const defaulted = isDefaultedAt(access);
  const reads: EnvRead[] = [];
  // A worklist over parameters, because the literal can be more than one
  // call away: getEnv(name) handing to requireEnv(name) crosses two. A
  // parameter already taken is skipped, so a pair of helpers calling each
  // other ends instead of going round.
  const pending: { fn: FunctionLike; at: number }[] = [{ fn: enclosing, at }];
  const taken = new Set<string>();
  while (pending.length > 0) {
    const wanted = pending.pop() as { fn: FunctionLike; at: number };
    const key = `${wanted.fn.getPos()}:${wanted.at}`;
    if (taken.has(key)) {
      continue;
    }
    taken.add(key);
    for (const call of callSitesOf(wanted.fn)) {
      const passed = call.getArguments()[wanted.at];
      if (passed === undefined) {
        continue;
      }
      const literal = literalBehind(passed);
      if (literal !== null && literal.length > 0) {
        reads.push({ name: literal, defaulted, node: call });
        continue;
      }
      const forwarded = forwardedParameter(passed, call);
      if (forwarded !== null) {
        pending.push(forwarded);
      }
    }
  }
  return reads;
}

function enclosingFunction(node: Node): FunctionLike | undefined {
  return node.getFirstAncestor(
    (candidate): candidate is FunctionLike =>
      N.isFunctionDeclaration(candidate) ||
      N.isArrowFunction(candidate) ||
      N.isFunctionExpression(candidate) ||
      N.isMethodDeclaration(candidate),
  );
}

/**
 * The string an argument comes down to: written in place, or one hop away
 * in a const whose initializer is written in place.
 */
function literalBehind(passed: Node): string | null {
  if (N.isStringLiteral(passed) || N.isNoSubstitutionTemplateLiteral(passed)) {
    return passed.getLiteralValue();
  }
  if (!N.isIdentifier(passed)) {
    return null;
  }
  for (const definition of passed.getDefinitionNodes()) {
    if (!N.isVariableDeclaration(definition)) {
      continue;
    }
    const initializer = definition.getInitializer();
    if (
      initializer !== undefined &&
      definition.getVariableStatement()?.getDeclarationKind() ===
        VariableDeclarationKind.Const &&
      (N.isStringLiteral(initializer) ||
        N.isNoSubstitutionTemplateLiteral(initializer))
    ) {
      return initializer.getLiteralValue();
    }
  }
  return null;
}

/** The caller's own parameter an argument passes along, for the worklist. */
function forwardedParameter(
  passed: Node,
  call: CallExpression,
): { fn: FunctionLike; at: number } | null {
  if (!N.isIdentifier(passed)) {
    return null;
  }
  const caller = enclosingFunction(call);
  if (caller === undefined) {
    return null;
  }
  const at = caller
    .getParameters()
    .findIndex((parameter) => parameter.getName() === passed.getText());
  return at === -1 ? null : { fn: caller, at };
}

/** Every call whose callee resolves to this function, found through its name. */
function callSitesOf(fn: FunctionLike): CallExpression[] {
  const named = N.isVariableDeclaration(fn.getParent())
    ? (fn.getParent() as VariableDeclaration).getNameNode()
    : (fn as { getNameNode?: () => Node | undefined }).getNameNode?.();
  if (named === undefined || !N.isIdentifier(named)) {
    return [];
  }
  const calls: CallExpression[] = [];
  for (const reference of named.findReferencesAsNodes()) {
    const parent = reference.getParent();
    if (parent === undefined) {
      continue;
    }
    if (N.isCallExpression(parent) && parent.getExpression() === reference) {
      calls.push(parent);
      continue;
    }
    // A method call's callee is the property access containing the name,
    // so the call is one level further up.
    if (
      N.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === reference
    ) {
      const grandparent = parent.getParent();
      if (
        grandparent !== undefined &&
        N.isCallExpression(grandparent) &&
        grandparent.getExpression() === parent
      ) {
        calls.push(grandparent);
      }
    }
  }
  return calls;
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
  if (N.isCallExpression(node)) {
    return readsThroughHelperCall(node);
  }
  if (!N.isPropertyAccessExpression(node)) {
    return [];
  }
  return isProcessEnv(node) ? readsThroughEnvObject(node) : dottedRead(node);
}

/**
 * `requireEnv("TABLE_NAME")` read from the call: the callee's body reads
 * `process.env` through the parameter this literal lands in. The reverse
 * walk in `readsThroughParameter` only fires where the helper's own body
 * is walked, and a call at module scope is in no unit's body (#326), so
 * the call resolves forward too. Anchoring at the call keeps the read in
 * the caller's file whatever file defines the helper.
 */
function readsThroughHelperCall(call: CallExpression): EnvRead[] {
  const reads: EnvRead[] = [];
  const callee = functionBehindCallee(call.getExpression());
  if (callee === null) {
    return reads;
  }
  call.getArguments().forEach((passed, at) => {
    const literal = literalBehind(passed);
    if (literal === null || literal.length === 0) {
      return;
    }
    const read = parameterReachesEnvRead(callee, at);
    if (read !== null) {
      reads.push({ name: literal, defaulted: read.defaulted, node: call });
    }
  });
  return reads;
}

/** The function a callee expression is written against, or null when nothing this reader follows defines one. */
function functionBehindCallee(callee: Node): FunctionLike | null {
  const nameNode = N.isPropertyAccessExpression(callee)
    ? callee.getNameNode()
    : callee;
  if (!N.isIdentifier(nameNode)) {
    return null;
  }
  for (const definition of nameNode.getDefinitionNodes()) {
    if (
      N.isFunctionDeclaration(definition) ||
      N.isMethodDeclaration(definition)
    ) {
      return definition;
    }
    if (N.isVariableDeclaration(definition)) {
      const initializer = definition.getInitializer();
      if (
        initializer !== undefined &&
        (N.isArrowFunction(initializer) || N.isFunctionExpression(initializer))
      ) {
        return initializer;
      }
    }
  }
  return null;
}

/** Keyed on the compiler node, which a re-parse replaces, so an edited file never reads a stale answer. */
const PARAM_ENV_READS = new WeakMap<
  object,
  Map<number, { defaulted: boolean } | null>
>();

/**
 * Whether a function's parameter reaches a `process.env[...]` read,
 * through however many helpers forward it. The worklist mirrors
 * `callerLiteralReads` in the other direction, and the taken set ends a
 * pair of helpers calling each other.
 */
function parameterReachesEnvRead(
  fn: FunctionLike,
  at: number,
): { defaulted: boolean } | null {
  const byParameter =
    PARAM_ENV_READS.get(fn.compilerNode) ??
    new Map<number, { defaulted: boolean } | null>();
  PARAM_ENV_READS.set(fn.compilerNode, byParameter);
  const remembered = byParameter.get(at);
  if (remembered !== undefined) {
    return remembered;
  }

  let found: { defaulted: boolean } | null = null;
  const pending: { fn: FunctionLike; at: number }[] = [{ fn, at }];
  const taken = new Set<string>();
  while (pending.length > 0 && found === null) {
    const wanted = pending.pop() as { fn: FunctionLike; at: number };
    const key = `${wanted.fn.getPos()}:${wanted.at}`;
    if (taken.has(key)) {
      continue;
    }
    taken.add(key);
    const parameter = wanted.fn.getParameters()[wanted.at];
    if (parameter === undefined) {
      continue;
    }
    const name = parameter.getName();
    wanted.fn.forEachDescendant((node) => {
      if (found !== null) {
        return;
      }
      if (
        N.isElementAccessExpression(node) &&
        isProcessEnv(node.getExpression())
      ) {
        const argument = node.getArgumentExpression();
        if (argument !== undefined && argument.getText() === name) {
          found = { defaulted: isDefaultedAt(node) };
        }
        return;
      }
      if (N.isCallExpression(node)) {
        node.getArguments().forEach((argument, position) => {
          if (!N.isIdentifier(argument) || argument.getText() !== name) {
            return;
          }
          const next = functionBehindCallee(node.getExpression());
          if (next !== null && next !== wanted.fn) {
            pending.push({ fn: next, at: position });
          }
        });
      }
    });
  }
  byParameter.set(at, found);
  return found;
}

/**
 * Whether something else supplies a value when this read comes back
 * empty. `process.env.X ?? "default"` and `process.env.X || other`
 * both do, and so does the middle of a chain: in
 * `process.env.A || process.env.B || undefined`, B's fallback is the
 * chain's tail. The climb stops when the read is the final operand
 * (`getDefault() ?? process.env.X`), where the read IS the fallback
 * and its absence propagates.
 */
function isDefaultedAt(node: Node): boolean {
  let child: Node = node;
  let parent = child.getParent();
  while (parent !== undefined) {
    if (N.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.getParent();
      continue;
    }

    if (!N.isBinaryExpression(parent)) {
      return false;
    }
    // String-equality on the token text rather than the SyntaxKind
    // enum, which renumbers between TypeScript releases.
    const op = parent.getOperatorToken().getText();
    if (op !== "??" && op !== "||") {
      return false;
    }

    if (parent.getLeft() === child) {
      return true;
    }
    child = parent;
    parent = parent.getParent();
  }
  return false;
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
  // A helper call resolves from the call and from the bracket read in
  // the callee, with the same anchor, so one of the pair is dropped.
  const seen = new Set<string>();
  sourceFile.forEachDescendant((node) => {
    for (const read of envReadsAt(node)) {
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
  return (access, _ctx) =>
    recognizeProcessEnvRead(access, deploymentTarget, instanceName);
}
