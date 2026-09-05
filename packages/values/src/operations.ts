/**
 * Operations on sequences and strings that every language's rows need:
 * appending to a sequence, joining one into a string, comparing two
 * values. A row is one line that calls one of these.
 */

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
