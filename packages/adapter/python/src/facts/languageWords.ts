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

/** The builtin that builds each element of a new collection by calling a function on one element of another. */
export const MAPPING_BUILTIN = "map";

/** The decorator that passes a method the class it was called on in place of an instance. */
export const CLASS_METHOD_DECORATOR = "classmethod";

/** The decorator that passes a method no receiver at all. */
export const STATIC_METHOD_DECORATOR = "staticmethod";

/** A standard library function, called as `module.name(...)`, that encodes one of its arguments. */
export interface ModuleEncoder {
  readonly module: string;
  readonly name: string;
  /** Which positional argument is the value encoded. */
  readonly argument: number;
  readonly codec: string;
}

/** The standard library's encoders. `json.dumps(x)` encodes `x` as JSON. */
export const ENCODERS: readonly ModuleEncoder[] = [
  { module: "json", name: "dumps", argument: 0, codec: "json" },
];

/** The encoder `module.name(...)` calls, given whether the object is that module. */
export function encoderCalled(
  name: string,
  isModule: (module: string) => boolean,
): ModuleEncoder | null {
  return (
    ENCODERS.find((one) => one.name === name && isModule(one.module)) ?? null
  );
}
