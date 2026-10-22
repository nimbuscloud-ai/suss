/**
 * What Python's own builtins do, said the way a pack says what its
 * library does. `int(tenant_id)` is a different value from `tenant_id`,
 * converted from it, and no file suss reads says so, because `int` is
 * part of the language.
 */

/** The builtins that convert their first argument to another type. */
export const CONVERTING_BUILTINS: ReadonlySet<string> = new Set([
  "int",
  "str",
  "float",
]);

/** The builtin that reads an attribute by a name it is given. */
export const ATTRIBUTE_GETTER = "getattr";

/** The builtin that pairs each element of a collection with its position, counting from 0. */
export const POSITION_COUNTER = "enumerate";
