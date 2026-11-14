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

/** A standard library function, called as `module.name(...)`, that encodes or decodes one of its arguments. */
export interface ModuleCodec {
  readonly module: string;
  readonly name: string;
  /** Which positional argument is the value encoded or decoded. */
  readonly argument: number;
  readonly codec: string;
}

/** The standard library's encoders. `json.dumps(x)` encodes `x` as JSON. */
export const ENCODERS: readonly ModuleCodec[] = [
  { module: "json", name: "dumps", argument: 0, codec: "json" },
];

/**
 * The standard library's decoders, each the inverse of an encoder:
 * `json.loads(x)` decodes `x`. `json.load` reads a file, not a message,
 * so it is left out.
 */
export const DECODERS: readonly ModuleCodec[] = [
  { module: "json", name: "loads", argument: 0, codec: "json" },
];

/** The encoder `module.name(...)` calls, given whether the object is that module. */
export function encoderCalled(
  name: string,
  isModule: (module: string) => boolean,
): ModuleCodec | null {
  return codecCalled(ENCODERS, name, isModule);
}

/** The decoder `module.name(...)` calls, given whether the object is that module. */
export function decoderCalled(
  name: string,
  isModule: (module: string) => boolean,
): ModuleCodec | null {
  return codecCalled(DECODERS, name, isModule);
}

function codecCalled(
  table: readonly ModuleCodec[],
  name: string,
  isModule: (module: string) => boolean,
): ModuleCodec | null {
  return table.find((one) => one.name === name && isModule(one.module)) ?? null;
}
