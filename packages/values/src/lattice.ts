/**
 * Join and widen over abstract values.
 *
 * `join` is what a value is after two branches, and it keeps whatever
 * the two sides agree on: pieces line up from both ends of a string,
 * elements line up by position in a sequence, and fields line up by
 * name. `widen` is what a value is after a loop ran some number of
 * times, and it gives up on anything the loop body changed.
 */

import {
  type Constant,
  force,
  hole,
  holePiece,
  type Item,
  type Piece,
  type Range,
  string,
  textPiece,
  unbounded,
  type Value,
} from "./value.js";

const CONSTANT_CAP = 8;

export function join(left: Value, right: Value): Value {
  const a = force(left);
  const b = force(right);
  if (sameValue(a, b)) {
    return a;
  }
  if (a.kind === "hole") {
    return a;
  }
  if (b.kind === "hole") {
    return b;
  }
  if (a.kind === "string" && b.kind === "string") {
    return joinStrings(a.pieces, b.pieces);
  }
  if (a.kind === "constant" && b.kind === "constant") {
    return joinConstants(a.options, b.options);
  }
  if (a.kind === "sequence" && b.kind === "sequence") {
    return { kind: "sequence", items: joinItems(a.items, b.items) };
  }
  if (isSequenceLike(a) && isSequenceLike(b)) {
    return unbounded(joinAll([...elementsOf(a), ...elementsOf(b)]));
  }
  if (a.kind === "record" && b.kind === "record") {
    return joinRecords(a, b);
  }
  return hole("value");
}

export function joinAll(values: readonly Value[]): Value {
  const [first, ...rest] = values;
  if (first === undefined) {
    return hole("value");
  }
  return rest.reduce((acc, value) => join(acc, value), first);
}

function joinConstants(a: readonly Constant[], b: readonly Constant[]): Value {
  const options = [...new Set([...a, ...b])];
  return options.length > CONSTANT_CAP
    ? hole("value")
    : { kind: "constant", options };
}

function isSequenceLike(
  value: Value,
): value is Extract<Value, { kind: "sequence" | "unbounded" }> {
  return value.kind === "sequence" || value.kind === "unbounded";
}

function elementsOf(
  value: Extract<Value, { kind: "sequence" | "unbounded" }>,
): readonly Value[] {
  return value.kind === "unbounded"
    ? [value.element]
    : value.items.map((item) => item.value);
}

function joinItems(a: readonly Item[], b: readonly Item[]): Item[] {
  const items: Item[] = [];
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      break;
    }
    items.push({
      value: join(left.value, right.value),
      presence:
        left.presence === "optional" || right.presence === "optional"
          ? "optional"
          : "one",
    });
  }
  for (const extra of (a.length > b.length ? a : b).slice(shared)) {
    items.push({ value: extra.value, presence: "optional" });
  }
  return items;
}

function joinRecords(
  a: Extract<Value, { kind: "record" }>,
  b: Extract<Value, { kind: "record" }>,
): Value {
  const fields = new Map<string, Item>();
  for (const name of new Set([...a.fields.keys(), ...b.fields.keys()])) {
    const left = a.fields.get(name);
    const right = b.fields.get(name);
    if (left === undefined || right === undefined) {
      const only = left ?? right;
      if (only !== undefined) {
        fields.set(name, { value: only.value, presence: "optional" });
      }
      continue;
    }
    fields.set(name, {
      value: join(left.value, right.value),
      presence:
        left.presence === "optional" || right.presence === "optional"
          ? "optional"
          : "one",
    });
  }
  return { kind: "record", fields, open: a.open || b.open };
}

function joinStrings(a: readonly Piece[], b: readonly Piece[]): Value {
  let prefix = 0;
  while (
    prefix < a.length &&
    prefix < b.length &&
    samePiece(a[prefix], b[prefix])
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    samePiece(a[a.length - 1 - suffix], b[b.length - 1 - suffix])
  ) {
    suffix++;
  }
  const middle = joinMiddle(
    a.slice(prefix, a.length - suffix),
    b.slice(prefix, b.length - suffix),
  );
  return string([...a.slice(0, prefix), middle, ...a.slice(a.length - suffix)]);
}

/** The one piece that covers what two strings differ by. */
function joinMiddle(a: readonly Piece[], b: readonly Piece[]): Piece {
  if (a.length === 0 || b.length === 0) {
    return optionalPiece(a.length === 0 ? b : a);
  }
  const left = a[0];
  const right = b[0];
  if (
    a.length === 1 &&
    b.length === 1 &&
    left !== undefined &&
    right !== undefined
  ) {
    if (left.kind === "text" && right.kind === "text") {
      return textPiece([...left.options, ...right.options]);
    }
    if (left.kind === "hole" && right.kind === "hole") {
      return holePiece(left.name, joinRange(left.range, right.range));
    }
  }
  return holePiece("value", "any");
}

/** What a run of pieces is when one branch wrote it and the other did not. */
function optionalPiece(pieces: readonly Piece[]): Piece {
  const only = pieces[0];
  if (pieces.length !== 1 || only === undefined) {
    return holePiece("value", "any");
  }
  if (only.kind === "text") {
    return textPiece([...only.options, ""]);
  }
  return holePiece(only.name, joinRange(only.range, "optional"));
}

const RANGE_ORDER: Record<Range, number> = {
  one: 0,
  optional: 1,
  many: 2,
  any: 3,
};

export function joinRange(a: Range, b: Range): Range {
  if (a === b) {
    return a;
  }
  const wider = RANGE_ORDER[a] > RANGE_ORDER[b] ? a : b;
  const narrower = wider === a ? b : a;
  if (wider === "many" && narrower === "optional") {
    return "any";
  }
  return wider;
}

/**
 * The value after a loop, given the value before it and the value after
 * the body ran once. Anything the body left unchanged keeps its shape.
 */
export function widen(before: Value, after: Value): Value {
  const a = force(before);
  const b = force(after);
  if (sameValue(a, b)) {
    return a;
  }
  if (isSequenceLike(a) && isSequenceLike(b)) {
    return unbounded(joinAll([...elementsOf(a), ...elementsOf(b)]));
  }
  if (a.kind === "record" && b.kind === "record") {
    const joined = joinRecords(a, b);
    return joined.kind === "record" ? { ...joined, open: true } : joined;
  }
  if (a.kind === "string" && b.kind === "string") {
    return string([
      ...sharedPrefix(a.pieces, b.pieces),
      holePiece("value", "any"),
    ]);
  }
  return hole("value");
}

/** The pieces two strings start with, down to the characters of the first literal they differ in. */
function sharedPrefix(a: readonly Piece[], b: readonly Piece[]): Piece[] {
  let prefix = 0;
  while (
    prefix < a.length &&
    prefix < b.length &&
    samePiece(a[prefix], b[prefix])
  ) {
    prefix++;
  }
  const shared = [...a.slice(0, prefix)];
  const left = a[prefix];
  const right = b[prefix];
  if (
    left?.kind === "text" &&
    right?.kind === "text" &&
    left.options.length === 1 &&
    right.options.length === 1
  ) {
    const common = commonPrefix(left.options[0] ?? "", right.options[0] ?? "");
    if (common !== "") {
      shared.push(textPiece([common]));
    }
  }
  return shared;
}

function commonPrefix(a: string, b: string): string {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length++;
  }
  return a.slice(0, length);
}

export function samePiece(a: Piece | undefined, b: Piece | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a.kind === "text" && b.kind === "text") {
    return (
      a.options.length === b.options.length &&
      a.options.every((option, i) => option === b.options[i])
    );
  }
  return (
    a.kind === "hole" &&
    b.kind === "hole" &&
    a.name === b.name &&
    a.range === b.range
  );
}

export function sameValue(left: Value, right: Value): boolean {
  const a = force(left);
  const b = force(right);
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "string" && b.kind === "string") {
    return (
      a.pieces.length === b.pieces.length &&
      a.pieces.every((piece, i) => samePiece(piece, b.pieces[i]))
    );
  }
  if (a.kind === "constant" && b.kind === "constant") {
    return (
      a.options.length === b.options.length &&
      a.options.every((option) => b.options.includes(option))
    );
  }
  if (a.kind === "sequence" && b.kind === "sequence") {
    return (
      a.items.length === b.items.length &&
      a.items.every((item, i) => sameItem(item, b.items[i]))
    );
  }
  if (a.kind === "unbounded" && b.kind === "unbounded") {
    return sameValue(a.element, b.element);
  }
  if (a.kind === "record" && b.kind === "record") {
    return (
      a.open === b.open &&
      a.fields.size === b.fields.size &&
      [...a.fields].every(([name, item]) => sameItem(item, b.fields.get(name)))
    );
  }
  if (a.kind === "hole" && b.kind === "hole") {
    return a.name === b.name;
  }
  if (a.kind === "ref" && b.kind === "ref") {
    return a.id === b.id;
  }
  return false;
}

function sameItem(a: Item, b: Item | undefined): boolean {
  return (
    b !== undefined && a.presence === b.presence && sameValue(a.value, b.value)
  );
}
