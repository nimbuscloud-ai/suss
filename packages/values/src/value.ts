/**
 * The abstract values the evaluator computes.
 *
 * A value folds everything the source determines and keeps a hole for
 * everything else. A string is a list of pieces, each a small set of
 * literals or a hole that covers some number of path segments. A
 * sequence and a record keep the elements the source wrote, with an
 * element marked optional when only one branch wrote it. A number,
 * boolean, null or undefined is a small set of constants.
 *
 * A `ref` points at an allocation in the engine's local heap, so two
 * names bound to the same array see the same pushes. A `deferred` value
 * is one nothing has asked the content of yet; `force` computes it once.
 */

export type Range = "one" | "optional" | "many" | "any";

export type Piece =
  | { readonly kind: "text"; readonly options: readonly string[] }
  | { readonly kind: "hole"; readonly name: string; readonly range: Range };

export type Constant = number | boolean | null | undefined;

export type Presence = "one" | "optional";

export interface Item {
  readonly value: Value;
  readonly presence: Presence;
}

export type Value =
  | { readonly kind: "string"; readonly pieces: readonly Piece[] }
  | { readonly kind: "constant"; readonly options: readonly Constant[] }
  | { readonly kind: "sequence"; readonly items: readonly Item[] }
  | { readonly kind: "unbounded"; readonly element: Value }
  | {
      readonly kind: "record";
      readonly fields: ReadonlyMap<string, Item>;
      readonly open: boolean;
    }
  | { readonly kind: "hole"; readonly name: string }
  | { readonly kind: "ref"; readonly id: number }
  | { readonly kind: "deferred"; readonly force: () => Value };

/** A set of literals wider than this becomes a hole. */
export const SET_CAP = 4;

export function text(literal: string): Value {
  return { kind: "string", pieces: normalizePieces([textPiece([literal])]) };
}

export function textPiece(options: readonly string[]): Piece {
  return { kind: "text", options: uniqueSorted(options) };
}

export function holePiece(name: string, range: Range = "one"): Piece {
  return { kind: "hole", name, range };
}

export function string(pieces: readonly Piece[]): Value {
  return { kind: "string", pieces: normalizePieces(pieces) };
}

export function hole(name: string): Value {
  return { kind: "hole", name };
}

export function constant(value: Constant): Value {
  return { kind: "constant", options: [value] };
}

export function sequence(values: readonly Value[]): Value {
  return {
    kind: "sequence",
    items: values.map((value) => ({ value, presence: "one" })),
  };
}

export function unbounded(element: Value): Value {
  return { kind: "unbounded", element };
}

export function record(
  fields: Iterable<readonly [string, Value]>,
  open = false,
): Value {
  const map = new Map<string, Item>();
  for (const [name, value] of fields) {
    map.set(name, { value, presence: "one" });
  }
  return { kind: "record", fields: map, open };
}

export function deferred(compute: () => Value, name = "value"): Value {
  let result: Value | undefined;
  let computing = false;
  return {
    kind: "deferred",
    force: () => {
      if (result !== undefined) {
        return result;
      }
      // A value that depends on itself is unknown.
      if (computing) {
        return hole(name);
      }
      computing = true;
      result = force(compute());
      computing = false;
      return result;
    },
  };
}

/** The value with any deferral computed. Never a `deferred`. */
export function force(value: Value): Value {
  return value.kind === "deferred" ? value.force() : value;
}

function uniqueSorted(options: readonly string[]): readonly string[] {
  return [...new Set(options)].sort();
}

/**
 * Adjacent single literals become one literal, and an empty literal
 * disappears. A set of literals stays its own piece, since merging two
 * sets multiplies them.
 */
export function normalizePieces(pieces: readonly Piece[]): readonly Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind === "text" && piece.options.length > SET_CAP) {
      out.push(holePiece("value"));
      continue;
    }
    if (piece.kind === "text" && piece.options.length === 1) {
      const only = piece.options[0] ?? "";
      if (only === "") {
        continue;
      }
      const last = out[out.length - 1];
      if (last?.kind === "text" && last.options.length === 1) {
        out[out.length - 1] = textPiece([`${last.options[0] ?? ""}${only}`]);
        continue;
      }
    }
    out.push(piece);
  }
  return out;
}

/** The pieces a value contributes when it is concatenated into a string. */
export function piecesOf(value: Value): readonly Piece[] {
  const forced = force(value);
  if (forced.kind === "string") {
    return forced.pieces;
  }
  if (forced.kind === "constant") {
    return [textPiece(forced.options.map((option) => String(option)))];
  }
  if (forced.kind === "hole") {
    return [holePiece(forced.name)];
  }
  return [holePiece("value")];
}

export function concat(values: readonly Value[]): Value {
  return string(values.flatMap((value) => piecesOf(value)));
}

/** The one literal a value is, when it is exactly one. */
export function literalOf(value: Value): string | null {
  const forced = force(value);
  if (forced.kind !== "string") {
    return null;
  }
  if (forced.pieces.length === 0) {
    return "";
  }
  const only = forced.pieces[0];
  if (
    forced.pieces.length !== 1 ||
    only === undefined ||
    only.kind !== "text" ||
    only.options.length !== 1
  ) {
    return null;
  }
  return only.options[0] ?? null;
}

export function constantOf(value: Value): Constant | undefined {
  const forced = force(value);
  if (forced.kind !== "constant" || forced.options.length !== 1) {
    return undefined;
  }
  return forced.options[0];
}

/** Whether a condition is settled, and which way, or null when it is not. */
export function truthOf(value: Value): boolean | null {
  const forced = force(value);
  if (forced.kind === "constant" && forced.options.length === 1) {
    return Boolean(forced.options[0]);
  }
  if (forced.kind === "string") {
    const literal = literalOf(forced);
    return literal === null ? null : literal !== "";
  }
  return null;
}
