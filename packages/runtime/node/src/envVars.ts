/**
 * Environment variable reads, each reported as a `config-read` effect
 * named after the variable. `process.env.FOO`, `process.env["FOO"]` and
 * `const { FOO } = process.env` all count, and so does each of them off
 * `import.meta.env`. So do a call to a project helper such as
 * `requireEnv("FOO")` and the keys of a schema parsed against the
 * environment. A read is defaulted when the program handles the variable
 * being unset, for example with `??` after the read.
 *
 * The three direct spellings share the environment object's node, so
 * each is recognized there by looking at what encloses it. The README
 * covers helpers and schemas.
 */

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
  declarationsBehind,
  dottedPathOf,
  findEnclosingFunction,
  functionTargetOf,
  isDefaultedAt,
  stringValueOf,
  symbolBehind,
  toFunctionRoot,
} from "@suss/adapter-typescript";

import { configBinding, opaqueRuntimeRead } from "./configBinding.js";
import { schemaEnvReads, schemaEnvReadsInside } from "./schemaEnv.js";

import type { ResolutionStore } from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type { DeploymentOptions } from "./configBinding.js";

export type EnvVarRecognizerOptions = DeploymentOptions;

/**
 * The objects whose properties are the environment, as the code spells
 * them. Node gives a program `process.env`. Vite and Bun give it
 * `import.meta.env`, which a program reads the same way.
 */
export const ENVIRONMENT_OBJECTS: readonly string[] = [
  "process.env",
  "import.meta.env",
];

/** The spelling a read gets when the code does not write the object at the read, as with a schema. */
const PROCESS_ENV = "process.env";

const IMPORT_META_ENV = "import.meta.env";

/**
 * The keys Vite sets on `import.meta.env` from the build itself: the
 * mode, the base URL, and whether the build is for production,
 * development or the server. No deployment declares them, so a read of
 * one is a metadata read, the way a read of `import.meta.url` is.
 */
const VITE_BUILD_KEYS = new Set(["MODE", "BASE_URL", "PROD", "DEV", "SSR"]);

interface EnvRead {
  name: string;
  defaulted: boolean;
  /** Where the read is reported, which sets its line number. */
  node: Node;
  /** The environment object the read is off, as the code spells it. */
  object: string;
}

/**
 * Every spelling gets the dotted name, so a consumer grouping reads by
 * variable never has to parse an index argument or a binding pattern.
 */
const readName = (read: EnvRead): string => `${read.object}.${read.name}`;

/** `process.env` or `import.meta.env` as the code spells it, or null for any other node. */
function environmentSpelling(node: Node): string | null {
  if (!N.isPropertyAccessExpression(node) || node.getName() !== "env") {
    return null;
  }
  const path = dottedPathOf(node);
  return path !== null && ENVIRONMENT_OBJECTS.includes(path) ? path : null;
}

function dottedRead(node: PropertyAccessExpression): EnvRead[] {
  const object = environmentSpelling(node.getExpression());
  if (object === null) {
    return [];
  }
  return [
    { name: node.getName(), defaulted: isDefaultedAt(node), node, object },
  ];
}

/**
 * `process.env["NAME"]`. Pairing needs the variable's name, so an index
 * that does not resolve to a literal reports nothing.
 */
function bracketRead(
  access: ElementAccessExpression,
  object: string,
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
    return [{ name, defaulted: isDefaultedAt(access), node: access, object }];
  }
  if (N.isIdentifier(argument)) {
    return readsThroughParameter(access, argument, object, resolution);
  }
  return [];
}

/**
 * A helper is visited once for each unit whose closure contains it, and
 * the store query is the costly part, so later visits reuse the answer.
 */
const CALLER_LOOKUPS = new WeakMap<Node, EnvRead[]>();

/**
 * `process.env[name]` where `name` is a parameter. The reads are the
 * literals callers pass, each reported at its call, so the unit that
 * passed the name is recorded as reading the variable.
 */
function readsThroughParameter(
  access: ElementAccessExpression,
  index: Identifier,
  object: string,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  const remembered = CALLER_LOOKUPS.get(access);
  if (remembered !== undefined) {
    return remembered;
  }
  const found = callerLiteralReads(access, index, object, resolution);
  CALLER_LOOKUPS.set(access, found);
  return found;
}

function callerLiteralReads(
  access: ElementAccessExpression,
  index: Identifier,
  object: string,
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
  // The literal can be more than one call away, as when getEnv(name)
  // passes it to requireEnv(name). `taken` stops two helpers that call
  // each other from looping.
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
        reads.push({ name: literal, defaulted, node: passed.call, object });
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

/** The caller's parameter, when the argument passes one along unchanged. */
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

/** The variable read by one element of `const { A, B: c } = process.env`. */
function bindingRead(element: BindingElement, object: string): EnvRead[] {
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
      // A binding default covers a missing variable the same way `??`
      // does after a dotted read.
      defaulted:
        element.getInitializer() !== undefined || isDefaultedAt(element),
      node: element,
      object,
    },
  ];
}

function destructuredReads(
  declaration: VariableDeclaration,
  object: string,
): EnvRead[] {
  const pattern = declaration.getNameNode();
  if (!N.isObjectBindingPattern(pattern)) {
    return [];
  }
  return pattern
    .getElements()
    .flatMap((element) => bindingRead(element, object));
}

/**
 * Bracket and destructured reads. Both are found from the environment
 * object's node, because the name is in an index argument or a binding
 * pattern.
 */
function readsThroughEnvObject(
  envNode: PropertyAccessExpression,
  object: string,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  const parent = envNode.getParent();
  if (N.isElementAccessExpression(parent)) {
    return bracketRead(parent, object, resolution);
  }
  if (N.isVariableDeclaration(parent)) {
    return destructuredReads(parent, object);
  }
  return [];
}

/**
 * The walk visits both nodes of `process.env.NAME`, so each spelling is
 * recognized at only one of them and a dotted read is reported once.
 */
function envReadsAt(
  node: Node,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  if (N.isCallExpression(node)) {
    const parsed = anchoredAt(schemaEnvReads(node, resolution), node);
    return parsed.length > 0
      ? parsed
      : readsThroughHelperCall(node, resolution);
  }
  if (!N.isPropertyAccessExpression(node)) {
    return [];
  }
  const object = environmentSpelling(node);
  return object === null
    ? dottedRead(node)
    : readsThroughEnvObject(node, object, resolution);
}

/**
 * `requireEnv("TABLE_NAME")`, read forward from the call. A call at module
 * scope is in no unit's body, so readsThroughParameter never sees it (#326).
 */
function readsThroughHelperCall(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): EnvRead[] {
  const callee = functionBehindCallee(call.getExpression(), resolution);
  if (callee === null) {
    return [];
  }
  const sitesNaming = namesReadAtSites(callee, resolution);
  const parameters = callee.getParameters();
  // One read per variable. It counts as defaulted only when every site
  // that reads it supplies a default.
  const byName = new Map<string, { defaulted: boolean; object: string }>();
  call.getArguments().forEach((passed, at) => {
    const parameter = parameters[at];
    if (parameter === undefined) {
      return;
    }
    const sites = sitesNaming(parameter) ?? directEnvReads(callee, parameter);
    const [first] = sites;
    if (first === undefined) {
      return;
    }
    const literal = stringValueOf(passed, resolution);
    if (!namesSomething(literal)) {
      return;
    }
    const everywhere = sites.every(isDefaultedAt);
    const known = byName.get(literal);
    byName.set(literal, {
      defaulted: (known?.defaulted ?? true) && everywhere,
      object: known?.object ?? objectReadAt(first),
    });
  });

  const wrapped = isDefaultedAt(call);
  return [
    ...[...byName].map(([name, read]) => ({
      name,
      defaulted: read.defaulted || wrapped,
      node: call,
      object: read.object,
    })),
    // A config module often parses its schema inside a function that
    // every handler calls, so each call reports the keys that parse reads.
    ...anchoredAt(schemaEnvReadsInside(callee, resolution), call),
  ];
}

/** The environment object a helper's read site is off, or `process.env` when the site does not spell one. */
function objectReadAt(site: Node): string {
  if (!N.isElementAccessExpression(site)) {
    return PROCESS_ENV;
  }
  return environmentSpelling(site.getExpression()) ?? PROCESS_ENV;
}

/**
 * Attaches a node to schema reads so they get a line number. A schema
 * read does not spell the object it parses, so it is named as a read of
 * `process.env`.
 */
function anchoredAt(
  reads: readonly { name: string; defaulted: boolean }[],
  node: Node,
): EnvRead[] {
  return reads.map((read) => ({ ...read, node, object: PROCESS_ENV }));
}

/** The function a call resolves to, or null when it cannot be followed. */
function functionBehindCallee(
  callee: Node,
  resolution: ResolutionStore | undefined,
): FunctionLike | null {
  const nameNode = N.isPropertyAccessExpression(callee)
    ? callee.getNameNode()
    : callee;
  if (!N.isIdentifier(nameNode)) {
    return null;
  }
  const declared = functionTargetOf(nameNode)?.func;
  if (declared !== undefined || resolution === undefined) {
    return declared ?? null;
  }
  return factoryReturnedCallee(nameNode, callee, resolution);
}

/**
 * The function returned by `makeReader` in `const requireEnv =
 * makeReader(process.env)`. Store queries are costly, so only a name
 * declared as a call's result is asked about.
 */
function factoryReturnedCallee(
  nameNode: Identifier,
  callee: Node,
  resolution: ResolutionStore,
): FunctionLike | null {
  if (!isDeclaredAsCall(nameNode)) {
    return null;
  }
  const returned = resolution.resolveReturnedCallable(callee);
  return returned === null ? null : toFunctionRoot(returned);
}

/** True when every declaration of the name sets it to a call's result. */
function isDeclaredAsCall(nameNode: Identifier): boolean {
  const declarations = declarationsBehind(symbolBehind(nameNode));
  return declarations.length > 0 && declarations.every(isVariableSetToCall);
}

function isVariableSetToCall(declaration: Node): boolean {
  if (!N.isVariableDeclaration(declaration)) {
    return false;
  }
  const initializer = declaration.getInitializer();
  return initializer !== undefined && N.isCallExpression(initializer);
}

function namesSomething(value: string | null): value is string {
  return value !== null && value.length > 0;
}

/**
 * The read sites where each parameter ends up as a variable name, from one
 * query for the whole project. Null means the store had no facts, and the
 * caller then looks in the callee's own body. The README explains why.
 */
function namesReadAtSites(
  fn: FunctionLike,
  resolution: ResolutionStore | undefined,
): (parameter: ParameterDeclaration) => readonly Node[] | null {
  if (resolution === undefined) {
    return () => null;
  }
  const namers = resolution.envNamers(fn.getProject());
  return (parameter) => namers.sitesNaming(parameter);
}

function directEnvReads(
  fn: FunctionLike,
  parameter: ParameterDeclaration,
): Node[] {
  const direct = directEnvRead(fn, parameter);
  return direct === null ? [] : [direct];
}

/** `process.env[name]` in the function's own body or a closure inside it. */
function directEnvRead(
  fn: FunctionLike,
  parameter: ParameterDeclaration,
): ElementAccessExpression | null {
  for (const access of fn.getDescendantsOfKind(
    SyntaxKind.ElementAccessExpression,
  )) {
    if (environmentSpelling(access.getExpression()) === null) {
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

/** Whether the read is of a key the bundler sets, which is no environment variable. */
function readsBuildKey(read: EnvRead): boolean {
  return read.object === IMPORT_META_ENV && VITE_BUILD_KEYS.has(read.name);
}

function configReadEffect(read: EnvRead, where: DeploymentOptions): Effect {
  if (readsBuildKey(read)) {
    return opaqueRuntimeRead(readName(read));
  }
  return {
    type: "interaction",
    binding: configBinding(where),
    callee: readName(read),
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
    },
  };
}

function recognizeProcessEnvRead(
  access: unknown,
  where: DeploymentOptions,
  resolution: ResolutionStore | undefined,
): Effect[] | null {
  const reads = envReadsAt(access as Node, resolution);
  if (reads.length === 0) {
    return null;
  }
  return reads.map((read) => configReadEffect(read, where));
}

/**
 * Every environment variable read in a source file, with its line. This
 * runs outside extraction, which uses `envVarRecognizer` through the pack
 * instead.
 */
export function findProcessEnvReads(
  sourceFile: SourceFile,
  resolution?: ResolutionStore,
): Array<{ name: string; defaulted: boolean; line: number }> {
  const out: Array<{ name: string; defaulted: boolean; line: number }> = [];
  // A helper call is found both at the call and at the bracket read in
  // its callee, reported at the same node, so the second is dropped.
  const seen = new Set<string>();
  sourceFile.forEachDescendant((node) => {
    for (const read of envReadsAt(node, resolution)) {
      const key = `${read.node.getPos()}:${read.name}`;
      if (seen.has(key) || readsBuildKey(read)) {
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
 * The access recognizer for environment variable reads.
 * `processSurfaceRecognizer` handles the rest of `process`.
 */
export function envVarRecognizer(
  opts: EnvVarRecognizerOptions = {},
): AccessRecognizer {
  return (access, ctx) =>
    recognizeProcessEnvRead(
      access,
      opts,
      (ctx as { resolution?: ResolutionStore }).resolution,
    );
}
