// throws.ts — match `throw <expr>` statements and produce a throw
// terminal. Status code / body / message extraction delegates to the
// shared extract helpers.

import { type Expression, Node } from "ts-morph";

import {
  type ExtractionContext,
  extractBody,
  extractStatusCode,
} from "./extract.js";

import type { RawTerminal, TerminalPattern } from "@suss/extractor";
import type { FoundTerminal } from "./shared.js";

export function tryMatchThrowExpression(
  node: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "throwExpression" }>,
): FoundTerminal | null {
  if (!Node.isThrowStatement(node)) {
    return null;
  }

  const thrownExpr = node.getExpression();
  const constructorPattern = match.constructorPattern;
  const classified = classifyThrownExpression(thrownExpr, constructorPattern);
  if (classified === null) {
    return null;
  }
  const { callArgs, exceptionType } = classified;

  const ctx: ExtractionContext = {
    extraction: pattern.extraction,
    ...(callArgs !== null ? { throwCallArgs: callArgs } : {}),
    ...(exceptionType !== null ? { exceptionType } : {}),
  };
  const statusCode = extractStatusCode(ctx);
  const body = extractBody(ctx);
  const message = extractThrowMessage(callArgs);

  const terminal: RawTerminal = {
    kind: "throw",
    statusCode,
    body,
    exceptionType,
    message,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    renderTree: null,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}

/**
 * Pull the literal message string out of a thrown constructor's arguments.
 * Covers the two dominant shapes:
 *
 *   throw new Error("boom");            // message = "boom"
 *   throw new HttpError(404, "boom");   // message = "boom"  (first string arg)
 *
 * The first string-literal argument (StringLiteral or no-substitution
 * template literal) is returned regardless of position, so constructors
 * that put the code before the message still surface the message. Template
 * literals with substitutions (`Error: ${e}`) preserve their source text —
 * runtime value isn't resolvable, but the composition stays visible.
 * Returns null when no static message is present (no string args, or the
 * thrown expression is a bare identifier / member access).
 */
function extractThrowMessage(callArgs: Expression[] | null): string | null {
  if (callArgs === null) {
    return null;
  }
  for (const arg of callArgs) {
    if (
      Node.isStringLiteral(arg) ||
      Node.isNoSubstitutionTemplateLiteral(arg)
    ) {
      return arg.getLiteralValue();
    }
    if (Node.isTemplateExpression(arg)) {
      return arg.getText();
    }
  }
  return null;
}

/**
 * Inspect a `throw <expr>` expression and produce the (exceptionType,
 * callArgs) pair the terminal builder needs. Three shapes:
 *   - `throw fn(args)`          — callExpression; callArgs filled.
 *   - `throw new Ctor(args)`    — newExpression; callArgs filled.
 *   - `throw err` / `throw obj` — identifier / member / etc; no args.
 *
 * When the match specifies `constructorPattern`, the leading portion
 * of the callee text has to match it; anything else returns null.
 * Without a pattern, any throw matches and `exceptionType` is the
 * thrown expression's text.
 */
function classifyThrownExpression(
  thrown: Node,
  constructorPattern: string | undefined,
): { callArgs: Expression[] | null; exceptionType: string } | null {
  if (Node.isCallExpression(thrown) || Node.isNewExpression(thrown)) {
    const calleeText = thrown.getExpression().getText();
    if (
      constructorPattern !== undefined &&
      !calleeText.startsWith(constructorPattern)
    ) {
      return null;
    }
    return {
      callArgs: (thrown.getArguments() ?? []) as Expression[],
      exceptionType: calleeText,
    };
  }
  // Any-other-shape throw. If the pattern constrains a specific
  // constructor, this bare-identifier (or member access) can't match.
  if (constructorPattern !== undefined) {
    return null;
  }
  return { callArgs: null, exceptionType: thrown.getText() };
}
