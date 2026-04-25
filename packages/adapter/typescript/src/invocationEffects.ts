// invocationEffects.ts — Capture call expressions as `invocation`
// RawEffects. Two patterns covered:
//
//   1. Bare expression-statement calls — `setCount(n);`,
//      `onChange(value);`, `emitter.emit("x", y);`. Result is
//      discarded; the call fires for side effect.
//   2. Container-building calls — `return [...checkProviderCoverage(p, c),
//      ...checkConsumerSatisfaction(p, c)]` and similar. The call's
//      return value is composed into an array or object literal;
//      the call still *fires* when the container expression
//      evaluates. Without this, orchestrator functions that
//      compose sub-checks via spread show `effects: []` and the
//      graph has no edges through them.
//
// Scope:
//   * Skip nested function bodies — their calls belong to those
//     functions' summaries.
//   * Don't classify semantics. All captured calls become
//     `invocation` effects with the callee's source text.
//   * Async detection via `Node.isAwaitExpression` on the call.

import { type CallExpression, Node } from "ts-morph";

import {
  collectAncestorConditionInfos,
  conditionInfoToRawCondition,
  type FunctionRoot,
} from "./conditions.js";

import type { EffectArg, RawCondition, RawEffect } from "@suss/extractor";

export interface InvocationEffectLocation {
  effect: RawEffect;
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
   * them — otherwise single-line orchestrators lose their effects.
   */
  neverTerminal: boolean;
}

export function extractInvocationEffects(
  func: FunctionRoot,
): InvocationEffectLocation[] {
  const results: InvocationEffectLocation[] = [];

  func.forEachDescendant((node, traversal) => {
    if (
      node !== func &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return;
    }

    // Case 1: bare expression statement — `foo();`, `await foo();`.
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
          line: node.getStartLineNumber(),
          neverTerminal: false,
        });
      }
      return;
    }

    // Case 2: spread-element call in an array/object literal —
    // `[...foo()]`, `{...foo()}`. The spread could be inside a
    // return, a variable declaration, a function argument — in
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

    // Case 3: direct call element in an array literal or property
    // assignment value — `[foo(), bar()]`, `{ key: foo() }`. These
    // also fire when the container evaluates. Skip arguments to
    // other calls (`foo(bar())`) — those are argument positions,
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
 * Extract structured arguments from a CallExpression. Captures
 * literal values (strings, numbers, booleans), object literals
 * whose fields resolve to literals, and array literals whose
 * elements resolve to literals. Anything not a literal becomes
 * `null` in the positional slot — the caller retains the argument
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

function extractArg(node: Node, depth: number): EffectArg {
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
  // Template literals with substitutions (`Error: ${x}`) — preserve
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
  // over-constants indirection — `const QUEUE_URL = process.env.QUEUE_URL;
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
  // Nested call — `log(formatError(e))`, `enqueue(buildPayload(ctx))`.
  // Recurse into the arguments with decremented depth so the shape of
  // the composition survives in the summary.
  if (Node.isCallExpression(node)) {
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
          // `{ userId }` — shorthand expands to `{ userId: userId }`.
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
      // Record every named field, even when the value is opaque — the
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
 * simple module-level binding — string literals, numeric constants,
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
    // Only follow module-level declarations — local consts (inside a
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
    // Re-enter extractArg on the initializer — covers literals,
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
  // Module-level consts sit inside a VariableDeclarationList → VariableStatement
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
  if (Node.isParenthesizedExpression(node)) {
    return unwrapCasts(node.getExpression());
  }
  if (Node.isAsExpression(node)) {
    return unwrapCasts(node.getExpression());
  }
  if (Node.isNonNullExpression(node)) {
    return unwrapCasts(node.getExpression());
  }
  if (Node.isSatisfiesExpression(node)) {
    return unwrapCasts(node.getExpression());
  }
  return node;
}

/**
 * Walk up from a composition-position call to find the enclosing
 * statement line. This is what should be used for branch
 * attribution — the line of the statement that contains the
 * container expression.
 */
function enclosingStatementLine(node: Node): number {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (Node.isStatement(current)) {
      return current.getStartLineNumber();
    }
    current = current.getParent();
  }
  return node.getStartLineNumber();
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
