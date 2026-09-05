/**
 * Operations on sequences and strings that every language's rows need:
 * appending to a sequence, joining one into a string, comparing two
 * values. A row is one line that calls one of these.
 */

import { posix } from "node:path";

import { join, joinAll } from "./lattice.js";
import {
  concat,
  constant,
  constantOf,
  force,
  hole,
  holePiece,
  literalOf,
  type Piece,
  string,
  text,
  textPiece,
  unbounded,
  type Value,
} from "./value.js";

/** The sequence with `values` added at the end. */
export function appended(sequence: Value, values: readonly Value[]): Value {
  const content = force(sequence);
  if (content.kind === "sequence") {
    return {
      kind: "sequence",
      items: [
        ...content.items,
        ...values.map((value) => ({ value, presence: "one" as const })),
      ],
    };
  }
  if (content.kind === "unbounded") {
    return unbounded(joinAll([content.element, ...values]));
  }
  return unbounded(hole("value"));
}

/** The sequence with the elements of `other` added at the end. */
export function extended(sequence: Value, other: Value): Value {
  const added = force(other);
  if (added.kind === "sequence") {
    return appended(
      sequence,
      added.items.map((item) => item.value),
    );
  }
  const content = force(sequence);
  const elements =
    content.kind === "sequence"
      ? content.items.map((item) => item.value)
      : content.kind === "unbounded"
        ? [content.element]
        : [hole("value")];
  return unbounded(
    joinAll([
      ...elements,
      added.kind === "unbounded" ? added.element : hole("value"),
    ]),
  );
}

/**
 * The string a sequence makes when its elements are joined with a
 * separator. An element only one branch added becomes a piece that is
 * either that element with its separator or nothing.
 */
export function joined(sequence: Value, separator: Value | undefined): Value {
  const content = force(sequence);
  const sep = separator === undefined ? "," : (literalOf(separator) ?? null);
  if (content.kind === "unbounded" || sep === null) {
    return string([holePiece("value", "any")]);
  }
  if (content.kind !== "sequence") {
    return hole("value");
  }
  const pieces: Piece[] = [];
  content.items.forEach((item, i) => {
    const value = force(item.value);
    const lead = i === 0 ? "" : sep;
    const literal = literalOf(value) ?? constantText(value);
    if (item.presence === "optional") {
      pieces.push(
        literal === null
          ? holePiece(value.kind === "hole" ? value.name : "value", "optional")
          : textPiece([`${lead}${literal}`, ""]),
      );
      return;
    }
    pieces.push(textPiece([lead]));
    if (literal !== null) {
      pieces.push(textPiece([literal]));
      return;
    }
    if (value.kind === "string") {
      pieces.push(...value.pieces);
      return;
    }
    pieces.push(holePiece(value.kind === "hole" ? value.name : "value"));
  });
  return string(pieces);
}

function constantText(value: Value): string | null {
  const c = constantOf(value);
  return c === undefined ? null : String(c);
}

/** `a + b` when either side is a string; a sum when both are numbers. */
export function plus(a: Value, b: Value): Value {
  const left = force(a);
  const right = force(b);
  const lc = constantOf(left);
  const rc = constantOf(right);
  if (typeof lc === "number" && typeof rc === "number") {
    return constant(lc + rc);
  }
  if (left.kind === "constant" && right.kind === "constant") {
    return hole("value");
  }
  return concat([left, right]);
}

/** Whether two values are the same, when both are one literal or constant. */
export function equals(a: Value, b: Value): Value {
  const left = literalOf(a);
  const right = literalOf(b);
  if (left !== null && right !== null) {
    return constant(left === right);
  }
  const lc = constantOf(a);
  const rc = constantOf(b);
  if (lc !== undefined && rc !== undefined) {
    return constant(lc === rc);
  }
  if (
    (left !== null && rc !== undefined) ||
    (lc !== undefined && right !== null)
  ) {
    return constant(false);
  }
  return hole("value");
}

export function negated(value: Value): Value {
  const c = constantOf(value);
  if (c !== undefined) {
    return constant(!c);
  }
  const literal = literalOf(value);
  return literal === null ? hole("value") : constant(literal === "");
}

/** `a ?? b`, `a || b` and `a && b`, with the choice folded when the left side settles it. */
export function fallback(
  a: Value,
  b: Value,
  takesLeft: (left: Value) => boolean | null,
): Value {
  const left = force(a);
  const settled = takesLeft(left);
  if (settled === true) {
    return left;
  }
  if (settled === false) {
    return force(b);
  }
  return join(left, b);
}

/** Whether a value is certainly not null or undefined, or certainly is. */
export function isPresent(value: Value): boolean | null {
  const forced = force(value);
  if (
    forced.kind === "string" ||
    forced.kind === "sequence" ||
    forced.kind === "record" ||
    forced.kind === "unbounded"
  ) {
    return true;
  }
  if (forced.kind !== "constant") {
    return null;
  }
  const present = forced.options.map(
    (option) => option !== null && option !== undefined,
  );
  if (present.every(Boolean)) {
    return true;
  }
  return present.some(Boolean) ? null : false;
}

/** An operand a row was handed nothing for. */
export function operand(value: Value | null | undefined): Value {
  return value ?? hole("value");
}

/**
 * `a ?? b` and `a || b` when one side is a hole: the other side, which
 * is how the resolution rules read a fallback. `process.env.X ?? "/v1"`
 * is then `/v1`, the one thing the source says about its shape.
 */
export function readableFallback(
  a: Value,
  b: Value,
  takesLeft: (left: Value) => boolean | null,
): Value {
  const left = force(a);
  const right = force(b);
  if (left.kind === "hole") {
    return right;
  }
  if (right.kind === "hole") {
    return left;
  }
  return fallback(left, right, takesLeft);
}

/** A path join of literal segments is folded as the library would; otherwise the segments are joined with `/`. */
export function joinedPath(args: readonly Value[]): Value {
  const forced = args.map(force);
  const literals = forced.map(literalOf);
  if (literals.every((literal) => literal !== null)) {
    return text(posix.join(...(literals as string[])));
  }
  return concat(
    forced.flatMap((arg, i) => (i === 0 ? [arg] : [text("/"), arg])),
  );
}

const PERCENT_PLACEHOLDER = /%[sdr]/g;

/** `"/api/%s" % v`, `"/%s/%s" % (a, b)` and `format("/%s", v)`: each placeholder takes the next argument. */
export function percentFormatted(
  template: Value,
  args: readonly Value[],
): Value {
  const literal = literalOf(template);
  if (literal === null) {
    return hole("value");
  }
  const parts: Value[] = [];
  let last = 0;
  let position = 0;
  for (const match of literal.matchAll(PERCENT_PLACEHOLDER)) {
    parts.push(text(literal.slice(last, match.index)));
    const argument = args[position];
    parts.push(argument === undefined ? hole("value") : concat([argument]));
    position += 1;
    last = match.index + match[0].length;
  }
  parts.push(text(literal.slice(last)));
  return concat(parts);
}

/** The single operand of a `%` format, or the items of a tuple or array operand. */
export function formatArguments(operand: Value): readonly Value[] {
  const forced = force(operand);
  return forced.kind === "sequence"
    ? forced.items.map((item) => item.value)
    : [forced];
}

/** A literal with its whitespace trimmed; anything else is a hole. */
export function stripped(
  value: Value,
  side: "both" | "start" | "end" = "both",
): Value {
  const literal = literalOf(value);
  if (literal === null) {
    return hole("value");
  }
  if (side === "start") {
    return text(literal.trimStart());
  }
  if (side === "end") {
    return text(literal.trimEnd());
  }
  return text(literal.trim());
}

/** A read of the environment is its default when one is written, else a hole named after the variable. */
export function environmentRead(args: readonly Value[]): Value {
  const name = literalOf(operand(args[0]));
  const fallbackValue = args[1];
  if (fallbackValue !== undefined) {
    return force(fallbackValue);
  }
  return hole(name ?? "value");
}
