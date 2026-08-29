// invocationEffects.ts: Capture call expressions as `invocation`
// RawEffects. Two patterns covered:
//
//   1. Bare expression-statement calls: `setCount(n);`,
//      `onChange(value);`, `emitter.emit("x", y);`. Result is
//      discarded; the call fires for side effect.
//   2. Container-building calls: `return [...checkProviderCoverage(p, c),
//      ...checkConsumerSatisfaction(p, c)]` and similar. The call's
//      return value is composed into an array or object literal;
//      the call still *fires* when the container expression
//      evaluates. Without this, orchestrator functions that
//      compose sub-checks via spread show `effects: []` and the
//      graph has no edges through them.
//
// Scope:
//   * Descend into nested function expressions / arrows (Promise
//     executors, `.then` callbacks, `forEach` bodies, IIFEs): their
//     calls are behavior of the enclosing unit. Named nested
//     declarations and pack-declared sub-unit boundaries are hard
//     stops (see `walk/descent.ts`).
//   * Don't classify semantics. All captured calls become
//     `invocation` effects with the callee's source text.
//   * Async detection via `Node.isAwaitExpression` on the call.

import {
  type CallExpression,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
  type TaggedTemplateExpression,
} from "ts-morph";

import {
  collectAncestorConditionInfos,
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
   * apart from a terminal on the same line. A terminal built from a
   * call, `res.json(body)`, is that same node; a call whose result the
   * terminal describes, `return toView(row)`, is a different one.
   */
  node?: Node;
  /**
   * Start line of the containing statement (expression statement or
   * the statement enclosing a container-building call). Used by the
   * assembly pass to assign effects to the right branch.
   */
  line: number;
  /**
   * True when the effect is a container-building call (spread or
   * direct element in an array/object literal) rather than an
   * expression-statement call. Container calls are never themselves
   * terminals, so the assembly-level terminal-line dedup must skip
   * them: otherwise single-line orchestrators lose their effects.
   */
  neverTerminal: boolean;
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
      ops ??= callOpsFor(call, resolveWrittenValue, originatesFrom);
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
  const results: InvocationEffectLocation[] = [];

  func.forEachDescendant((node, traversal) => {
    if (isDescentStop(node, func, barriers)) {
      traversal.skip();
      return;
    }

    // Case 1: bare expression statement: `foo();`, `await foo();`.
    if (Node.isExpressionStatement(node)) {
      const { call, async } = unwrapCall(node.getExpression());
      if (call !== null) {
        const preconditions = collectPreconditions(node, func);
        results.push({
          effect: {
            type: "invocation",
            callee: call.getExpression().getText(),
            args: extractArgs(call),
            async,
            ...(preconditions.length > 0 ? { preconditions } : {}),
          },
          line: startLineOf(node),
          neverTerminal: false,
        });
      }
      return;
    }

    // Case 2: spread-element call in an array/object literal ,
    // `[...foo()]`, `{...foo()}`. The spread could be inside a
    // return, a variable declaration, a function argument: in
    // each case the call still fires when the container is built.
    if (Node.isSpreadElement(node)) {
      const parent = node.getParent();
      if (
        parent !== undefined &&
        (Node.isArrayLiteralExpression(parent) ||
          Node.isObjectLiteralExpression(parent))
      ) {
        const { call, async } = unwrapCall(node.getExpression());
        if (call !== null) {
          const preconditions = collectPreconditions(node, func);
          results.push({
            effect: {
              type: "invocation",
              callee: call.getExpression().getText(),
              args: extractArgs(call),
              async,
              ...(preconditions.length > 0 ? { preconditions } : {}),
            },
            line: enclosingStatementLine(node),
            neverTerminal: true,
          });
        }
      }
      return;
    }

    // Case 4: a call whose result is given a name, `const a = foo()`.
    // The commonest call there is, and the one this walker used to miss,
    // so a handler that fetched something and then answered looked as
    // though it had called nothing. What a summary said about the code
    // and what the code did came apart there.
    if (Node.isVariableDeclaration(node)) {
      const initializer = node.getInitializer();
      if (initializer !== undefined) {
        const { call, async } = unwrapCall(initializer);
        if (call !== null) {
          const preconditions = collectPreconditions(node, func);
          results.push({
            effect: {
              type: "invocation",
              callee: call.getExpression().getText(),
              args: extractArgs(call),
              async,
              ...(preconditions.length > 0 ? { preconditions } : {}),
            },
            line: enclosingStatementLine(node),
            neverTerminal: true,
          });
        }
      }
      return;
    }

    // Case 4: the call a return hands back: `return toView(row)`.
    // The terminal reader describes what comes out of it, and nothing
    // recorded that the call happened, so nothing knew this unit calls
    // that one.
    if (Node.isReturnStatement(node)) {
      const returned = node.getExpression();
      const { call, async } =
        returned === undefined
          ? { call: null, async: false }
          : unwrapCall(returned);
      if (call !== null) {
        const preconditions = collectPreconditions(node, func);
        results.push({
          effect: {
            type: "invocation",
            callee: call.getExpression().getText(),
            args: extractArgs(call),
            async,
            ...(preconditions.length > 0 ? { preconditions } : {}),
          },
          line: startLineOf(node),
          neverTerminal: false,
          node: call,
        });
      }
      return;
    }

    // Case 5: the call an arrow hands back with no `return` written,
    // `xs.map(x => toView(x))`. The walk descends into the arrow, and
    // the call is in a position none of the cases above cover, so
    // nothing recorded it.
    if (Node.isArrowFunction(node)) {
      const body = node.getBody();
      const { call, async } = Node.isExpression(body)
        ? unwrapCall(body)
        : { call: null, async: false };
      if (call !== null) {
        const preconditions = collectPreconditions(node, func);
        results.push({
          effect: {
            type: "invocation",
            callee: call.getExpression().getText(),
            args: extractArgs(call),
            async: async || node.isAsync(),
            ...(preconditions.length > 0 ? { preconditions } : {}),
          },
          line: startLineOf(node),
          neverTerminal: false,
          node: call,
        });
      }
      return;
    }

    // Case 3: direct call element in an array literal or property
    // assignment value: `[foo(), bar()]`, `{ key: foo() }`. These
    // also fire when the container evaluates. Skip arguments to
    // other calls (`foo(bar())`): those are argument positions,
    // not composition positions.
    if (Node.isCallExpression(node)) {
      const parent = node.getParent();
      if (parent === undefined) {
        return;
      }
      const isArrayElement = Node.isArrayLiteralExpression(parent);
      const isPropertyValue =
        Node.isPropertyAssignment(parent) && parent.getInitializer() === node;
      if (isArrayElement || isPropertyValue) {
        const preconditions = collectPreconditions(node, func);
        results.push({
          effect: {
            type: "invocation",
            callee: node.getExpression().getText(),
            args: extractArgs(node),
            async: false,
            ...(preconditions.length > 0 ? { preconditions } : {}),
          },
          line: enclosingStatementLine(node),
          neverTerminal: true,
        });
      }
    }
  });

  return results;
}

/**
 * Walk the function body for `InvocationRecognizer` dispatch only.
 * Visits EVERY `CallExpression` in the body, descending through nested
 * function expressions / arrows so a recognizer fires inside a Promise
 * executor or `.then` callback as if the call were inline. Named nested
 * declarations and pack-declared sub-unit boundaries are hard stops.
 *
 * Distinct from `extractInvocationEffects` because the existing
 * walker is intentionally narrow: it captures a specific subset
 * of call positions (bare expression statement, container building)
 * to avoid double-counting calls that already become terminals
 * (`return foo()`) or whose return value is consumed (`const x =
 * foo()`). Recognizers don't have those concerns: emitting a
 * `interaction(class: "storage-access")` for `const user = await db.user.findUnique(...)`
 * is exactly what the demo needs. Coupling recognizer reach to the
 * invocation walker's scope would silently drop the dominant
 * Prisma pattern.
 */
export function runInvocationRecognizers(
  func: FunctionRoot,
  recognizers: InvocationRecognizer[],
  barriers: DescentBarriers = NO_BARRIERS,
  resolveWrittenValue?: (value: Node) => Node | null,
  originatesFrom?: OriginatesFrom,
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
    const ctx = invocationContextFor(node, resolveWrittenValue, originatesFrom);
    const line = enclosingStatementLine(node);
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
        out.push({ effect: eff, line });
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
): RecognizedEffectLocation[] {
  return dispatchAccessRecognizers(
    func,
    recognizers,
    (node) => isDescentStop(node, func, barriers),
    resolveWrittenValue,
    originatesFrom,
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
): RecognizedEffectLocation[] {
  return dispatchAccessRecognizers(
    sourceFile,
    recognizers,
    isModuleScopeStop,
    resolveWrittenValue,
    originatesFrom,
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
): TsAccessRecognizerContext {
  const given = { access: node, sourceFile, resolveWrittenValue };
  if (Node.isPropertyAccessExpression(node)) {
    return given;
  }
  let ops: CallOps | undefined;
  return {
    ...given,
    get ops(): CallOps {
      ops ??= callOpsFor(node, resolveWrittenValue, originatesFrom);
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
    );
    const line = enclosingStatementLine(node);
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
        const key = `${line}:${JSON.stringify(eff)}`;
        if (seenEffects.has(key)) {
          continue;
        }
        seenEffects.add(key);
        out.push({ effect: eff, line });
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
 * reaching `node` within `func`. Reuses the same walker transitions
 * use for `conditions`; produces RawConditions that downstream
 * convert to Predicates in the IR.
 *
 * For a call inside `if (result === "nomatch") { findings.push(...) }`
 * this returns `[result === "nomatch"]` as a positive RawCondition.
 * For a call inside an else branch, the condition is negated.
 */
function collectPreconditions(node: Node, func: FunctionRoot): RawCondition[] {
  return collectAncestorConditionInfos(node, func).map(
    conditionInfoToRawCondition,
  );
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
 * Walk up from a composition-position call to find the enclosing
 * statement line. This is what should be used for branch
 * attribution: the line of the statement that contains the
 * container expression.
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

/**
 * If the expression is a `CallExpression` (possibly awaited / `void`'d /
 * parenthesised), return the call and whether it's `await`-wrapped.
 * Handles the two common forms of top-level side-effecting calls:
 *
 *   setCount(n);
 *   await fetchUser(id);
 */
function unwrapCall(node: Node): {
  call: CallExpression | null;
  async: boolean;
} {
  if (Node.isAwaitExpression(node)) {
    const inner = node.getExpression();
    if (Node.isCallExpression(inner)) {
      return { call: inner, async: true };
    }
    return { call: null, async: false };
  }
  if (Node.isParenthesizedExpression(node)) {
    return unwrapCall(node.getExpression());
  }
  if (Node.isCallExpression(node)) {
    return { call: node, async: false };
  }
  return { call: null, async: false };
}
