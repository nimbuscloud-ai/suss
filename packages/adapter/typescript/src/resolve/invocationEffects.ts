/**
 * invocationEffects.ts: capture every call in a unit's body as an
 * `invocation` RawEffect, wherever the call is written: a statement of
 * its own, an argument, an element of a literal, an arm of a ternary,
 * the receiver of a method chain. Which calls a summary keeps is
 * decided in assembly by node identity, so no position needs a rule of
 * its own here.
 *
 * The walk descends into nested arrows and function expressions, since
 * their calls are behavior of the enclosing unit, and stops at named
 * nested declarations, pack-declared sub-unit boundaries and
 * decorators. The README beside this file says how the effects are
 * ordered and what `async` means.
 */

import {
  type CallExpression,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
  type TaggedTemplateExpression,
} from "ts-morph";

import { rawConditionToPredicate } from "@suss/extractor";

import {
  collectAncestorConditionInfosBelow,
  conditionInfoToRawCondition,
  type FunctionRoot,
} from "../conditions.js";
import { startLineOf } from "../lines.js";
import { resolveAliasedSymbol } from "../moduleExports.js";
import {
  type DescentBarriers,
  isDescentStop,
  isModuleScopeStop,
  NO_BARRIERS,
} from "../walk/descent.js";
import { peelSyntax } from "../walk/unwrap.js";
import { callOpsFor } from "./callOps.js";

import type { Effect } from "@suss/behavioral-ir";
import type {
  AccessRecognizer,
  CallOps,
  EffectArg,
  InvocationRecognizer,
  RawCondition,
  RawEffect,
} from "@suss/extractor";

export interface InvocationEffectLocation {
  effect: RawEffect;
  /**
   * The call this came from, so the assembly pass can tell a call
   * apart from a terminal. A terminal built from a call,
   * `res.json(body)`, is that same node; a call whose result the
   * terminal describes, `return toView(row)`, is a different one.
   */
  node: CallExpression;
  /**
   * Start line of the statement enclosing the call. Used by the
   * assembly pass to assign effects to the right branch.
   */
  line: number;
  /**
   * True for a call in a `finally` body, which runs on every path
   * through the try, including the ones that left before it.
   */
  alwaysRuns: boolean;
}

/**
 * Pre-typed `Effect` emitted by an `InvocationRecognizer`. The
 * `line` field mirrors `InvocationEffectLocation.line` so the
 * assembly pass can attribute it to the same branch as the
 * generic invocation effect that came from the same call site.
 */
export interface RecognizedEffectLocation {
  effect: Effect;
  line: number;
  /**
   * What has to be true before the call runs, in the form a branch
   * records its conditions, so the assembly pass can compare the two
   * without going back to the AST.
   */
  preconditions: RawCondition[];
  /** True for a call in a `finally` body. See `InvocationEffectLocation`. */
  alwaysRuns: boolean;
}

/**
 * Context handed to TypeScript-adapter access recognizers: sister
 * to TsInvocationRecognizerContext but for property-access nodes.
 * No `extractArgs` since property accesses don't take arguments.
 */
export interface TsAccessRecognizerContext {
  /** The property-access expression itself. */
  access: Node;
  /** Source file the access lives in. */
  sourceFile: SourceFile;
  /**
   * One-hop lookup from a written name to the value it was bound to,
   * from the run's facts (#300). Gives null when the run has no store,
   * and the recognizer's own pattern match runs on the raw node.
   */
  resolveWrittenValue: (value: Node) => Node | null;
  /**
   * What a declared pack asks about this node, when the node is a call
   * or a tagged template. This walk visits property accesses as well,
   * and there is no call there to ask about, so a declared pack
   * standing on one is handed nothing and matches nothing.
   */
  ops?: CallOps;
}

/**
 * Context handed to TypeScript-adapter recognizers. Recognizers in
 * `@suss/framework-prisma` (and other packs) receive this and use
 * the type-checker / source-file primitives to decide whether the
 * call site matches their semantics. `extractArgs` reuses the same
 * `EffectArg` builder the adapter uses for `invocation` effects, so
 * recognizers don't have to re-implement literal/object/identifier
 * shape extraction.
 */
export interface TsInvocationRecognizerContext {
  /** The call expression itself (also passed as the first arg). */
  call: CallExpression;
  /** Source file the call lives in. Useful for import resolution. */
  sourceFile: SourceFile;
  /**
   * Convert the call's arguments to `EffectArg[]` using the same
   * literal / object / identifier extraction the adapter applies to
   * `invocation` effects. Recognizers call this when they want
   * field-level shape (e.g. Prisma's `select: { id: true }`).
   */
  extractArgs(): EffectArg[];
  /**
   * Whether `identifier` was introduced by an import of
   * `expectedModule`. Recognizers use this to tell a library's export
   * apart from a local class that happens to share its name.
   *
   * Named, default, and namespace imports all match. So does an import
   * through a project-local barrel that re-exports the module: the
   * aliased symbol is still in the package that declared it.
   */
  isImportedFrom(identifier: Node, expectedModule: string): boolean;
  /**
   * The expression `value` is written as, followed through const
   * bindings, imports, and re-export barrels. A recognizer asks this
   * before claiming the source does not name something:
   *
   *   const url = "https://sqs/.../orders";
   *   client.send(new SendMessageCommand({ QueueUrl: url }));
   *
   * Resolving `url` gives back the string literal, and the recognizer's
   * own pattern match runs on that. Null when the value has no written
   * form (a parameter, a call result), which is exactly when null on the
   * binding is correct.
   */
  resolveWrittenValue(value: Node): Node | null;
  /**
   * What a declared pack asks about this call, in the vocabulary
   * `@suss/extractor` defines. A pack written as a chain of data links
   * reads only this; the members above are what a pack written as code
   * reaches for.
   */
  ops: CallOps;
}

/**
 * Everything a recognizer may ask about one call site.
 *
 * A pack's tests build it here too, so a pack that passes them has run
 * against the context extraction gives it.
 */
export function invocationContextFor(
  call: CallExpression,
  resolveWrittenValue?: (value: Node) => Node | null,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
): TsInvocationRecognizerContext {
  // Built on the first read rather than up front: most calls reach no
  // declared pack, and following a receiver costs more than the walk.
  let ops: CallOps | null = null;
  return {
    call,
    sourceFile: call.getSourceFile(),
    extractArgs: () => extractArgs(call),
    isImportedFrom: (identifier, expectedModule) =>
      isImportedFrom(identifier, expectedModule, originatesFrom),
    // A context built without a store gives null, and the recognizer's
    // own pattern match runs on the raw node.
    resolveWrittenValue: resolveWrittenValue ?? (() => null),
    get ops(): CallOps {
      ops ??= callOpsFor(
        call,
        resolveWrittenValue,
        originatesFrom,
        anchorCallsOf,
      );
      return ops;
    },
  };
}

/**
 * Whether a value's chain reaches the module, asked of the store. The
 * adapter binds it; a context built bare falls back to the checker's
 * alias resolution.
 */
export type OriginatesFrom = (value: Node, module: string) => boolean;

/** The calls behind a value that a caller's own check accepts, from the store. */
export type AnchorCallsOf = (
  value: Node,
  matches: (call: Node) => boolean,
) => Node[];

export function isImportedFrom(
  identifier: Node,
  expectedModule: string,
  originatesFrom?: OriginatesFrom,
): boolean {
  if (!Node.isIdentifier(identifier)) {
    return false;
  }
  const symbol = identifier.getSymbol();
  if (symbol === undefined) {
    return false;
  }

  for (const decl of symbol.getDeclarations()) {
    if (importSpecifierMatches(decl, expectedModule)) {
      return true;
    }
  }

  if (originatesFrom !== undefined) {
    return originatesFrom(identifier, expectedModule);
  }

  const aliased = resolveAliasedSymbol(symbol) ?? symbol;
  return aliased
    .getDeclarations()
    .some((decl) =>
      decl
        .getSourceFile()
        .getFilePath()
        .includes(`/node_modules/${expectedModule}/`),
    );
}

/**
 * Whether `expectedModule` declares the method a call goes to. A pack
 * asks this when the receiver came from somewhere the source does not
 * spell out: `const redis = await this.getClient()` says nothing about
 * ioredis, and the type of `redis.get` says everything.
 *
 * A client cached on an untyped global, `global.x || new Redis()`,
 * types as `any`, so the method has no symbol. With `resolve` supplied,
 * what the receiver was written as still says which library: the value
 * comes down to a construction or a factory call of something imported
 * from it.
 */
export function methodDeclaredIn(
  callee: Node,
  expectedModule: string,
  resolve?: (value: Node) => Node | null,
  originatesFrom?: OriginatesFrom,
): boolean {
  if (!Node.isPropertyAccessExpression(callee)) {
    return false;
  }
  const declarations = callee.getNameNode().getSymbol()?.getDeclarations();
  if (
    declarations !== undefined &&
    declarations.some((declaration) =>
      declaration
        .getSourceFile()
        .getFilePath()
        .includes(`/node_modules/${expectedModule}/`),
    )
  ) {
    return true;
  }
  if (resolve === undefined) {
    return false;
  }
  const written = resolve(callee.getExpression());
  const made = maker(written);
  return (
    made !== null &&
    isImportedFrom(rootIdentifier(made), expectedModule, originatesFrom)
  );
}

/** The callee of a construction or call, which says which library it is. */
function maker(written: Node | null): Node | null {
  if (written === null) {
    return null;
  }
  if (Node.isNewExpression(written) || Node.isCallExpression(written)) {
    return written.getExpression();
  }
  return null;
}

/** `AWS.S3` and `S3` both come down to the identifier that was imported. */
function rootIdentifier(expression: Node): Node {
  let root = expression;
  while (Node.isPropertyAccessExpression(root)) {
    root = root.getExpression();
  }
  return root;
}

/** Whether an import-shaped declaration imports from `expectedModule`. */
function importSpecifierMatches(decl: Node, expectedModule: string): boolean {
  if (Node.isImportSpecifier(decl)) {
    return (
      decl.getImportDeclaration().getModuleSpecifierValue() === expectedModule
    );
  }
  // An ImportClause's parent is the declaration; a NamespaceImport is
  // one level deeper, under the clause.
  const owner = Node.isNamespaceImport(decl) ? decl.getParent() : decl;
  if (!Node.isImportClause(owner)) {
    return false;
  }
  const importDecl = owner.getParent();
  return (
    Node.isImportDeclaration(importDecl) &&
    importDecl.getModuleSpecifierValue() === expectedModule
  );
}

export function extractInvocationEffects(
  func: FunctionRoot,
  barriers: DescentBarriers = NO_BARRIERS,
): InvocationEffectLocation[] {
  const calls: CallExpression[] = [];

  func.forEachDescendant((node, traversal) => {
    if (isDescentStop(node, func, barriers) || Node.isDecorator(node)) {
      traversal.skip();
      return;
    }
    if (Node.isCallExpression(node)) {
      calls.push(node);
    }
  });

  // A call finishes after everything written inside it, so ordering by
  // end puts a call in argument position before the call it feeds.
  calls.sort((a, b) => a.getEnd() - b.getEnd());
  return calls.map((call) => invocationAt(call, func));
}

function invocationAt(
  call: CallExpression,
  func: FunctionRoot,
): InvocationEffectLocation {
  const preconditions = collectPreconditions(call, func);
  return {
    effect: {
      type: "invocation",
      callee: call.getExpression().getText(),
      args: extractArgs(call),
      async: isAwaited(call),
      ...(preconditions.length > 0 ? { preconditions } : {}),
    },
    node: call,
    line: enclosingStatementLine(call),
    alwaysRuns: runsOnEveryPath(call, func),
  };
}

/** Whether the caller waits on the result: `await f()`, through any parentheses. */
function isAwaited(call: CallExpression): boolean {
  let current: Node | undefined = call.getParent();
  while (current !== undefined && Node.isParenthesizedExpression(current)) {
    current = current.getParent();
  }
  return current !== undefined && Node.isAwaitExpression(current);
}

/**
 * Walk the function body for `InvocationRecognizer` dispatch only.
 * Visits every `CallExpression` in the body under the same descent
 * rule as `extractInvocationEffects`, so a recognizer fires inside a
 * Promise executor or `.then` callback as if the call were inline.
 *
 * Kept apart from the invocation walk because what it hands back is
 * different: a recognized effect is additive to the invocation effect
 * from the same call and skips assembly's terminal dedup, so it
 * records its own line and preconditions rather than a node.
 */
export function runInvocationRecognizers(
  func: FunctionRoot,
  recognizers: InvocationRecognizer[],
  barriers: DescentBarriers = NO_BARRIERS,
  resolveWrittenValue?: (value: Node) => Node | null,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
): RecognizedEffectLocation[] {
  if (recognizers.length === 0) {
    return [];
  }
  const out: RecognizedEffectLocation[] = [];
  const sourceFile = func.getSourceFile();

  func.forEachDescendant((node, traversal) => {
    if (isDescentStop(node, func, barriers)) {
      traversal.skip();
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const ctx = invocationContextFor(
      node,
      resolveWrittenValue,
      originatesFrom,
      anchorCallsOf,
    );
    const line = enclosingStatementLine(node);
    const preconditions = collectPreconditions(node, func);
    const alwaysRuns = runsOnEveryPath(node, func);
    for (const recognizer of recognizers) {
      let emitted: Effect[] | null = null;
      try {
        emitted = recognizer(node, ctx);
      } catch (err) {
        // A recognizer throwing shouldn't take down the whole
        // extraction, but it also shouldn't disappear silently ,
        // the user has no way to know their pack is buggy. Log to
        // stderr with file + line so authors can find the call site
        // that broke the recognizer, and continue.
        const filePath = sourceFile.getFilePath();
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[suss] invocationRecognizer threw at ${filePath}:${line}: ${message}\n`,
        );
        emitted = null;
      }
      if (emitted === null || emitted.length === 0) {
        continue;
      }
      for (const eff of emitted) {
        out.push({
          effect: withPreconditions(eff, preconditions),
          line,
          preconditions,
          alwaysRuns,
        });
      }
    }
  });

  return out;
}

/**
 * Walk the function body for property-access recognizer dispatch.
 * Visits every PropertyAccessExpression in the body, descending through
 * nested function expressions / arrows the same way
 * `runInvocationRecognizers` does.
 *
 * Same scope contract: recognizers fire on every PropertyAccess in
 * the body, regardless of whether it's read as an arg, assigned to
 * a const, or evaluated for its side effect. Pack authors handle
 * dedup if they care about position.
 */
export function runAccessRecognizers(
  func: FunctionRoot,
  recognizers: AccessRecognizer[],
  barriers: DescentBarriers = NO_BARRIERS,
  resolveWrittenValue?: (value: Node) => Node | null,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
): RecognizedEffectLocation[] {
  return dispatchAccessRecognizers(
    func,
    recognizers,
    (node) => isDescentStop(node, func, barriers),
    resolveWrittenValue,
    originatesFrom,
    anchorCallsOf,
  );
}

/**
 * The same dispatch over a module's own top-level statements, for
 * reads that happen when the module loads rather than when any unit
 * runs. `isModuleScopeStop` keeps the walk out of every function and
 * class, so nothing another pass summarizes is counted twice.
 */
export function runAccessRecognizersAtModuleScope(
  sourceFile: SourceFile,
  recognizers: AccessRecognizer[],
  resolveWrittenValue?: (value: Node) => Node | null,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
): RecognizedEffectLocation[] {
  return dispatchAccessRecognizers(
    sourceFile,
    recognizers,
    isModuleScopeStop,
    resolveWrittenValue,
    originatesFrom,
    anchorCallsOf,
  );
}

/** The nodes this walk stops at, which is every shape a pack can guard. */
export type Accessed =
  | PropertyAccessExpression
  | CallExpression
  | TaggedTemplateExpression;

/**
 * What one node is handed. The ops are built on the first read rather
 * than up front, the way the invocation walk builds them: most nodes
 * reach no declared pack, and a pack written as code never asks.
 *
 * A pack's tests build it here too, so a pack that passes them has run
 * against the context extraction gives it.
 */
export function accessContextFor(
  node: Accessed,
  sourceFile: SourceFile,
  resolveWrittenValue: (value: Node) => Node | null = () => null,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
): TsAccessRecognizerContext {
  const given = { access: node, sourceFile, resolveWrittenValue };
  if (Node.isPropertyAccessExpression(node)) {
    return given;
  }
  let ops: CallOps | undefined;
  return {
    ...given,
    get ops(): CallOps {
      ops ??= callOpsFor(
        node,
        resolveWrittenValue,
        originatesFrom,
        anchorCallsOf,
      );
      return ops;
    },
  };
}

function dispatchAccessRecognizers(
  root: Node,
  recognizers: AccessRecognizer[],
  isStop: (node: Node) => boolean,
  resolveWrittenValue?: (value: Node) => Node | null,
  originatesFrom?: OriginatesFrom,
  anchorCallsOf?: AnchorCallsOf,
): RecognizedEffectLocation[] {
  if (recognizers.length === 0) {
    return [];
  }
  const out: RecognizedEffectLocation[] = [];
  const sourceFile = root.getSourceFile();
  // A helper call and the bracket read behind it resolve to the same
  // effect at the same line; stating it twice adds nothing.
  const seenEffects = new Set<string>();

  root.forEachDescendant((node, traversal) => {
    if (isStop(node)) {
      traversal.skip();
      return;
    }
    // Calls too: `requireEnv("X")` contains no property access, and the
    // env recognizer resolves it through the callee's body (#326). A
    // tagged template as well, since a library can take its whole
    // argument as one: `prisma.$queryRaw` and `gql` both do.
    // Every recognizer guards its shapes and returns null on the rest.
    if (
      !Node.isPropertyAccessExpression(node) &&
      !Node.isCallExpression(node) &&
      !Node.isTaggedTemplateExpression(node)
    ) {
      return;
    }
    const ctx = accessContextFor(
      node,
      sourceFile,
      resolveWrittenValue,
      originatesFrom,
      anchorCallsOf,
    );
    const line = enclosingStatementLine(node);
    const preconditions = collectPreconditions(node, root);
    const alwaysRuns = runsOnEveryPath(node, root);
    for (const recognizer of recognizers) {
      let emitted: Effect[] | null = null;
      try {
        emitted = recognizer(node, ctx);
      } catch (err) {
        const filePath = sourceFile.getFilePath();
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[suss] accessRecognizer threw at ${filePath}:${line}: ${message}\n`,
        );
        emitted = null;
      }
      if (emitted === null || emitted.length === 0) {
        continue;
      }
      for (const eff of emitted) {
        const effect = withPreconditions(eff, preconditions);
        const key = `${line}:${JSON.stringify(effect)}`;
        if (seenEffects.has(key)) {
          continue;
        }
        seenEffects.add(key);
        out.push({ effect, line, preconditions, alwaysRuns });
      }
    }
  });

  return out;
}

/**
 * Extract structured arguments from a CallExpression. Captures
 * literal values (strings, numbers, booleans), object literals
 * whose fields resolve to literals, and array literals whose
 * elements resolve to literals. Anything not a literal becomes
 * `null` in the positional slot: the caller retains the argument
 * count but the value is opaque.
 *
 * Depth is bounded to prevent runaway on pathological source, but
 * set high enough that realistic patterns (stage metadata, nested
 * event payloads, error objects with contexts) survive intact.
 */
const MAX_ARG_DEPTH = 8;

function extractArgs(call: CallExpression): EffectArg[] {
  return call.getArguments().map((arg) => extractArg(arg, MAX_ARG_DEPTH));
}

/**
 * One value in the form an effect records an argument, for ops handed
 * to a declared pack. The same reading a call's own arguments get, so
 * a body a pack asks for pairs the way an inline argument would.
 */
export function effectArgOf(node: Node): EffectArg {
  return extractArg(node, MAX_ARG_DEPTH);
}

function extractArg(node: Node, depth: number): EffectArg {
  // Unwrap type-cast wrappers: `value as Type`, `<Type>value`,
  // `value satisfies Type`, and the non-null assertion `value!`.
  // These are TS-only annotations that don't affect runtime shape;
  // recursing into the inner expression preserves field/argument
  // capture through `as any` casts in test code and in real-world
  // patterns (e.g. ts-rest body shapes coerced via `as`).
  {
    const bare = peelSyntax(node);
    if (bare !== node) {
      return extractArg(bare, depth);
    }
  }
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return { kind: "string", value: node.getLiteralValue() };
  }
  if (Node.isNumericLiteral(node)) {
    return { kind: "number", value: node.getLiteralValue() };
  }
  if (Node.isTrueLiteral(node)) {
    return { kind: "boolean", value: true };
  }
  if (Node.isFalseLiteral(node)) {
    return { kind: "boolean", value: false };
  }
  // Template literals with substitutions (`Error: ${x}`): preserve
  // source text so the composition is visible even when runtime
  // value isn't resolvable. Simple template literals without
  // substitutions already match Node.isNoSubstitutionTemplateLiteral
  // above and flow through as `{ kind: "string" }`.
  if (Node.isTemplateExpression(node)) {
    return { kind: "template", sourceText: node.getText() };
  }
  // Identifier and access-chain references. Property/element access
  // chains (`user.profile.email`, `process.env.QUEUE_URL`, `config["host"]`)
  // are captured with their full source text as the identifier name.
  // Bare identifiers get an extra hop of resolution: if the identifier
  // is bound at module level to a simple initializer (literal, property
  // access, template, nested call), inline that initializer's EffectArg
  // form instead of the identifier name. That collapses the closure-
  // over-constants indirection: `const QUEUE_URL = process.env.QUEUE_URL;
  // send(QUEUE_URL)` reads the same as `send(process.env.QUEUE_URL)` at
  // the call site.
  if (Node.isIdentifier(node)) {
    const inlined = inlineModuleBinding(node, depth);
    if (inlined !== null) {
      return inlined;
    }
    return { kind: "identifier", name: node.getText() };
  }
  if (
    Node.isPropertyAccessExpression(node) ||
    Node.isElementAccessExpression(node)
  ) {
    return { kind: "identifier", name: node.getText() };
  }
  if (depth <= 0) {
    return null;
  }
  // Nested call: `log(formatError(e))`, `enqueue(buildPayload(ctx))`.
  // Recurse into the arguments with decremented depth so the shape of
  // the composition survives in the summary.
  if (Node.isCallExpression(node)) {
    const element = mapCallbackReturn(node);
    if (element !== null) {
      return { kind: "array", items: [extractArg(element, depth - 1)] };
    }
    return {
      kind: "call",
      callee: node.getExpression().getText(),
      args: node.getArguments().map((a) => extractArg(a, depth - 1)),
    };
  }
  // `new Foo(...)`: same shape as a call. Lets recognizers that
  // walk over command-pattern argument objects (AWS SDK v3
  // `client.send(new SendMessageCommand({...}))`) reach the inner
  // object-literal fields without re-implementing the unwrap.
  if (Node.isNewExpression(node)) {
    return {
      kind: "call",
      callee: node.getExpression().getText(),
      args: node.getArguments().map((a) => extractArg(a, depth - 1)),
    };
  }
  if (Node.isObjectLiteralExpression(node)) {
    const fields: Record<string, EffectArg> = {};
    for (const prop of node.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) {
        const nameNode = prop.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          // `{ userId }`: shorthand expands to `{ userId: userId }`.
          fields[nameNode.getText()] = {
            kind: "identifier",
            name: nameNode.getText(),
          };
        }
        continue;
      }
      if (!Node.isPropertyAssignment(prop)) {
        continue;
      }
      const nameNode = prop.getNameNode();
      if (
        !Node.isIdentifier(nameNode) &&
        !Node.isStringLiteral(nameNode) &&
        !Node.isNoSubstitutionTemplateLiteral(nameNode)
      ) {
        continue;
      }
      const name = Node.isIdentifier(nameNode)
        ? nameNode.getText()
        : nameNode.getLiteralValue();
      const initializer = prop.getInitializer();
      if (initializer === undefined) {
        continue;
      }
      // Record every named field, even when the value is opaque: the
      // field *name* is information about the call's shape. Previously
      // null-valued fields were skipped and all-null objects collapsed
      // to null; that lost the shape itself.
      fields[name] = extractArg(initializer, depth - 1);
    }
    return { kind: "object", fields };
  }
  if (Node.isArrayLiteralExpression(node)) {
    // Preserve positional slots even when elements are opaque; keep the
    // array shape even when every slot is null so readers see a call
    // took an array argument rather than an unknown single value.
    const items = node.getElements().map((el) => extractArg(el, depth - 1));
    return { kind: "array", items };
  }
  return null;
}

/**
 * The expression a `.map(callback)` call builds each element from, when
 * the callback is written out at the call and comes down to one
 * expression. Every element it produces has that shape, so a pack
 * reading a payload written this way can tell which fields it sets
 * instead of giving up on the whole array (#537).
 *
 * A callback passed by name stays unread, and so does a body with more
 * than one return, since two returns are two shapes and picking one
 * would state a payload the code does not always build.
 */
function mapCallbackReturn(call: CallExpression): Node | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "map") {
    return null;
  }
  const callback = call.getArguments()[0];
  if (
    callback === undefined ||
    !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))
  ) {
    return null;
  }
  const body = callback.getBody();
  if (!Node.isBlock(body)) {
    return body;
  }
  const statements = body.getStatements();
  const only = statements.length === 1 ? statements[0] : undefined;
  return only !== undefined && Node.isReturnStatement(only)
    ? (only.getExpression() ?? null)
    : null;
}

/**
 * Collect the ancestor if/switch/ternary conditions that gate
 * reaching `node` within `root`. Reuses the same walker transitions
 * use for `conditions`; produces RawConditions that downstream
 * convert to Predicates in the IR.
 *
 * For a call inside `if (result === "nomatch") { findings.push(...) }`
 * this returns `[result === "nomatch"]` as a positive RawCondition.
 * For a call inside an else branch, the condition is negated.
 *
 * `root` is the function body for a call inside a unit, and the source
 * file for a read that happens when the module loads.
 */
function collectPreconditions(node: Node, root: Node): RawCondition[] {
  return collectAncestorConditionInfosBelow(node, root).map(
    conditionInfoToRawCondition,
  );
}

/**
 * Whether `node` is inside a `finally` body below `root`. Cleanup
 * written there runs on the paths that returned or threw above it, so
 * where it is in the file says nothing about which branches reach it.
 */
function runsOnEveryPath(node: Node, root: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined && current !== root) {
    const parent: Node | undefined = current.getParent();
    if (
      parent !== undefined &&
      Node.isTryStatement(parent) &&
      parent.getFinallyBlock() === current
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

/**
 * The same effect, saying what had to be true for it to happen. Only
 * an invocation and an interaction have somewhere to put that, so
 * every other kind comes back as it went in, and a recognizer that
 * worked its own guards out keeps them.
 */
function withPreconditions(
  effect: Effect,
  preconditions: RawCondition[],
): Effect {
  if (preconditions.length === 0) {
    return effect;
  }
  if (effect.type !== "invocation" && effect.type !== "interaction") {
    return effect;
  }
  if (effect.preconditions !== undefined) {
    return effect;
  }
  return {
    ...effect,
    preconditions: preconditions.map(rawConditionToPredicate),
  };
}

/**
 * If `ident` resolves to a module-level `const X = <expr>` whose
 * initializer is something extractArg can produce directly (literal,
 * property/element access chain, template, nested call), return that
 * initializer's EffectArg form. Returns null when the identifier is a
 * function parameter, imported from another module, bound to something
 * with defaults / computation / ambiguous shape, or can't be resolved.
 *
 * This is the "closure-over-constants" fix: `const QUEUE_URL =
 * process.env.QUEUE_URL; send(QUEUE_URL, ...)` reads the same at the
 * call site as `send(process.env.QUEUE_URL, ...)`. Same for any
 * simple module-level binding: string literals, numeric constants,
 * aliased property chains. One hop only, same file only, so we don't
 * traverse arbitrary alias graphs.
 */
function inlineModuleBinding(ident: Node, depth: number): EffectArg {
  if (!Node.isIdentifier(ident)) {
    return null;
  }
  const symbol = ident.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    if (!Node.isVariableDeclaration(decl)) {
      continue;
    }
    // Only follow module-level declarations: local consts (inside a
    // function body) are already opaque-by-scope to this summary; the
    // closure-over pattern we're targeting is file-scope constants
    // aliased to runtime / platform values.
    if (!isModuleScoped(decl)) {
      continue;
    }
    const init = decl.getInitializer();
    if (init === undefined) {
      continue;
    }
    const unwrapped = unwrapCasts(init);
    // Re-enter extractArg on the initializer: covers literals,
    // property access (`process.env.X`, `config.url`), templates,
    // nested calls, everything else extractArg knows about. Depth
    // is decremented so a chain of module-level aliases can't loop
    // forever through self-referential code.
    const captured = extractArg(unwrapped, depth - 1);
    if (captured !== null) {
      return captured;
    }
  }
  return null;
}

function isModuleScoped(decl: Node): boolean {
  // Module-level consts are inside a VariableDeclarationList → VariableStatement
  // whose parent is the SourceFile. Anything else (a VariableStatement nested
  // in a Block / function body / loop) is local scope.
  let current: Node | undefined = decl.getParent();
  while (current !== undefined) {
    if (Node.isSourceFile(current)) {
      return true;
    }
    if (
      Node.isVariableDeclarationList(current) ||
      Node.isVariableStatement(current)
    ) {
      current = current.getParent();
      continue;
    }
    return false;
  }
  return false;
}

function unwrapCasts(node: Node): Node {
  return peelSyntax(node);
}

/**
 * The line of the statement enclosing `node`, which is the line branch
 * attribution goes by. Assembly compares it against where each
 * terminal ends, and the statement is the smallest thing that has an
 * order relative to a terminal.
 */
function enclosingStatementLine(node: Node): number {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (Node.isStatement(current)) {
      return startLineOf(current);
    }
    current = current.getParent();
  }
  return startLineOf(node);
}
