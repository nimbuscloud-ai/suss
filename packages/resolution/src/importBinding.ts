/**
 * importBinding.ts: whether an import binds a name, read from the facts
 * every adapter states.
 *
 * An adapter states an import as `imports` on the name it binds, or on
 * the declaration a reference `binds` to. Asking what a name was imported
 * as follows the value through the resolution rules, and for a parameter
 * that means every caller in the project. A name that no import binds
 * was not imported under another name, so a caller asks this first and
 * skips the costly question for a parameter, a method, or a function the
 * project declares.
 */

/** The rows of a fact database, which is all this reads. */
interface FactRows {
  lookup(
    relation: string,
    column: number,
    value: string,
  ): readonly (readonly unknown[])[];
}

/**
 * Whether the facts state an import for the name at `key`, or for the
 * declaration it binds to. A global counts, since an adapter states one
 * as imported from the global module.
 */
export function boundByImport(db: FactRows, key: string): boolean {
  return (
    db.lookup("imports", 0, key).length > 0 ||
    db
      .lookup("binds", 0, key)
      .some((row) => db.lookup("imports", 0, String(row[1])).length > 0)
  );
}
