// extract.ts — status-code and body extraction helpers used by every
// terminal matcher. Each matcher constructs an ExtractionContext from
// the source material it has (returned object, throw call args, method
// chain) and asks extractStatusCode / extractBody to produce the
// terminal's status / body fields.

import {
  type CallExpression,
  type Expression,
  Node,
  type ObjectLiteralExpression,
} from "ts-morph";

import { extractShape } from "../shapes/shapes.js";

import type { RawTerminal, TerminalExtraction } from "@suss/extractor";

/** Unwrap `expr as const` / `expr as Type` to the inner expression. */
export function unwrapAs(node: Expression): Expression {
  return Node.isAsExpression(node) ? unwrapAs(node.getExpression()) : node;
}

// ---------------------------------------------------------------------------
// Extraction context
//
// All three matcher types feed extractStatusCode / extractBody, but each
// supplies a different subset of source material. A single context object
// keeps call sites self-documenting (see docs/style.md: 4+ params → object).
// ---------------------------------------------------------------------------

export interface ExtractionContext {
  extraction: TerminalExtraction;
  /** Object literal — supplied by returnShape. */
  returnedObj?: ObjectLiteralExpression;
  /** Args of a throw's call expression — supplied by throwExpression / functionCall. */
  throwCallArgs?: Expression[];
  /** Method-chain calls (innermost → outermost) — supplied by parameterMethodCall. */
  calls?: CallExpression[];
  /** Text of the thrown constructor — supplied by throwExpression only. */
  exceptionType?: string;
}

// ---------------------------------------------------------------------------
// Status-code extraction
// ---------------------------------------------------------------------------

export function extractStatusCode(
  ctx: ExtractionContext,
): RawTerminal["statusCode"] {
  const result = extractStatusCodeFromRule(ctx);
  if (result !== null) {
    return result;
  }
  // Fall back to pack-declared default (e.g. Express res.json() → 200)
  if (ctx.extraction.defaultStatusCode !== undefined) {
    return { type: "literal", value: ctx.extraction.defaultStatusCode };
  }
  return null;
}

/**
 * Resolve a constructor's text (e.g. `HttpError.NotFound`) against a pack
 * codes map, trying the full text first and falling back to the last
 * dot-segment so bare `NotFound` also resolves. Returns null on no match
 * rather than guessing.
 */
function matchConstructorCode(
  ctorText: string,
  codes: Record<string, number>,
): RawTerminal["statusCode"] {
  const fullMatch = codes[ctorText];
  if (fullMatch !== undefined) {
    return { type: "literal", value: fullMatch };
  }
  const lastSegment = ctorText.split(".").pop();
  if (lastSegment !== undefined && lastSegment !== ctorText) {
    const segMatch = codes[lastSegment];
    if (segMatch !== undefined) {
      return { type: "literal", value: segMatch };
    }
  }
  return null;
}

function extractStatusCodeFromRule(
  ctx: ExtractionContext,
): RawTerminal["statusCode"] {
  const sc = ctx.extraction.statusCode;
  if (sc === undefined) {
    return null;
  }

  if (sc.from === "constructor") {
    // Look up the thrown expression's constructor name in the pack-supplied
    // mapping. Match against the full text (e.g. "HttpError.NotFound"), falling
    // back to the last dot-segment so "NotFound" alone also resolves. Without
    // a match we return null rather than guessing.
    if (ctx.exceptionType === undefined) {
      return null;
    }
    return matchConstructorCode(ctx.exceptionType, sc.codes);
  }

  if (sc.from === "argumentConstructor") {
    // Wrapper pattern: `throw wrap(new NotFound(...))`. The arg at the
    // configured position carries the status via its class name. Only
    // throwCallArgs is relevant — this source doesn't make sense for
    // parameterMethodCall terminals (no thrown-value wrapping there).
    if (ctx.throwCallArgs === undefined) {
      return null;
    }
    const arg = ctx.throwCallArgs[sc.position];
    if (arg === undefined || !Node.isNewExpression(arg)) {
      return null;
    }
    const ctorText = arg.getExpression().getText();
    return matchConstructorCode(ctorText, sc.codes);
  }

  if (sc.from === "property") {
    if (ctx.returnedObj === undefined) {
      return null;
    }

    for (const prop of ctx.returnedObj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        // Handle shorthand: ShorthandPropertyAssignment
        if (Node.isShorthandPropertyAssignment(prop)) {
          if (prop.getName() === sc.name) {
            return { type: "dynamic", sourceText: prop.getName() };
          }
        }
        continue;
      }

      if (prop.getName() !== sc.name) {
        continue;
      }

      const raw = prop.getInitializer();
      if (raw === undefined) {
        return null;
      }

      const val = unwrapAs(raw);
      if (Node.isNumericLiteral(val)) {
        return { type: "literal", value: Number(val.getText()) };
      }

      return { type: "dynamic", sourceText: val.getText() };
    }

    return null;
  }

  // from: "argument"
  const pos = sc.position;
  const minArgs = sc.minArgs;

  if (ctx.calls !== undefined) {
    // parameterMethodCall: statusCode comes from innermost call (calls[0])
    const innerCall = ctx.calls[0];
    const args = innerCall.getArguments();
    // minArgs guard: skip extraction when arg at `position` is ambiguous in
    // short-form overloads (e.g. res.redirect(url) vs res.redirect(301, url))
    if (minArgs !== undefined && args.length < minArgs) {
      return null;
    }
    const rawArg = args[pos] as Expression | undefined;
    if (rawArg === undefined) {
      return null;
    }

    const arg = unwrapAs(rawArg);
    if (Node.isNumericLiteral(arg)) {
      return { type: "literal", value: Number(arg.getText()) };
    }

    return { type: "dynamic", sourceText: arg.getText() };
  }

  if (ctx.throwCallArgs !== undefined) {
    // minArgs guard (see above)
    if (minArgs !== undefined && ctx.throwCallArgs.length < minArgs) {
      return null;
    }
    const rawArg = ctx.throwCallArgs[pos] as Expression | undefined;
    if (rawArg === undefined) {
      return null;
    }

    const arg = unwrapAs(rawArg);
    if (Node.isNumericLiteral(arg)) {
      return { type: "literal", value: Number(arg.getText()) };
    }

    return { type: "dynamic", sourceText: arg.getText() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

export function extractBody(ctx: ExtractionContext): RawTerminal["body"] {
  const b = ctx.extraction.body;
  if (b === undefined) {
    return null;
  }

  if (b.from === "property") {
    if (ctx.returnedObj === undefined) {
      return null;
    }

    for (const prop of ctx.returnedObj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        if (Node.isShorthandPropertyAssignment(prop)) {
          if (prop.getName() === b.name) {
            return { typeText: prop.getName(), shape: null };
          }
        }
        continue;
      }

      if (prop.getName() !== b.name) {
        continue;
      }

      const val = prop.getInitializer();
      if (val === undefined) {
        return null;
      }

      return { typeText: val.getText(), shape: extractShape(val) };
    }

    return null;
  }

  // from: "argument"
  const pos = b.position;
  const minArgs = b.minArgs;

  if (ctx.calls !== undefined) {
    // parameterMethodCall: body comes from outermost call (calls[N-1])
    const outerCall = ctx.calls[ctx.calls.length - 1];
    const args = outerCall.getArguments();
    // minArgs guard: skip when overload makes this position ambiguous
    if (minArgs !== undefined && args.length < minArgs) {
      return null;
    }
    const arg = args[pos] as Expression | undefined;
    if (arg === undefined) {
      return null;
    }

    return { typeText: arg.getText(), shape: extractShape(arg) };
  }

  if (ctx.throwCallArgs !== undefined) {
    // minArgs guard (see above)
    if (minArgs !== undefined && ctx.throwCallArgs.length < minArgs) {
      return null;
    }
    const arg = ctx.throwCallArgs[pos] as Expression | undefined;
    if (arg === undefined) {
      return null;
    }

    return { typeText: arg.getText(), shape: extractShape(arg) };
  }

  return null;
}
