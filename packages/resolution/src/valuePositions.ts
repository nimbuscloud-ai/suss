/**
 * Where each piece of a value written out in source goes: the entries of
 * a list or an object, and the parts and holes of a template string.
 *
 * Every adapter states these rows from its own syntax, and a reader puts
 * the value back together from them in any language. So the numbering
 * is written once, here, and a list, an f-string and a Ruby interpolated
 * symbol all count their pieces the same way.
 */

/** The last column of `writtenEntryAt` for an entry written in place. */
export const VALUE_ENTRY = "value";

/** The last column of `writtenEntryAt` for a spread, which puts every entry of its collection at that one position. */
export const SPREAD_ENTRY = "spread";

/** One entry of a list or an object: the key of its value, or of the collection a spread unpacks. */
export interface WrittenEntry {
  readonly key: string;
  readonly form: typeof VALUE_ENTRY | typeof SPREAD_ENTRY;
}

/** One piece of a template string: text it writes, or the key of a value it puts there. */
export type TemplatePiece =
  | { readonly text: string }
  | { readonly hole: string };

/** Adds one row to a relation, through whatever buffer the adapter keeps. */
export type AddRow = (relation: string, row: string[]) => void;

/** `writtenEntryAt` for each entry of a list or an object, numbered in the order they are written. */
export function addEntryRows(
  add: AddRow,
  container: string,
  entries: readonly WrittenEntry[],
): void {
  entries.forEach((entry, position) => {
    add("writtenEntryAt", [container, String(position), entry.key, entry.form]);
  });
}

/**
 * `partAt` and `holeAt` for a template's pieces, numbered together in
 * source order. Text that writes nothing gets no row, so `${a}${b}` has
 * two holes, at 0 and 1, and no parts.
 */
export function addTemplateRows(
  add: AddRow,
  template: string,
  pieces: readonly TemplatePiece[],
): void {
  let position = 0;
  for (const piece of pieces) {
    if ("hole" in piece) {
      add("holeAt", [template, String(position), piece.hole]);
      position += 1;
      continue;
    }
    if (piece.text !== "") {
      add("partAt", [template, String(position), piece.text]);
      position += 1;
    }
  }
}
