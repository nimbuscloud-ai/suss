/**
 * The argument a call passes for one parameter of the function it
 * calls, read the same way by every check that joins a call to the
 * callee's parameters.
 *
 * The adapters record a call's positional arguments in the order it
 * writes them. Python and Ruby record the keyword arguments after them,
 * in one `keywords` entry keyed by the name the call writes before each
 * one, since a keyword says which parameter it fills and its place in
 * the call does not. A parameter takes the keyword argument written with
 * its name, and otherwise the positional argument at its place. A
 * parameter past the last positional argument with no keyword argument
 * for it was left out.
 */

/** What a summary records for one argument, as the adapters write it. */
export type RecordedArgument =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "undefined" }
  | { kind: "object"; fields: Record<string, RecordedArgument> }
  | { kind: "keywords"; fields: Record<string, RecordedArgument> }
  | { kind: "array"; items: RecordedArgument[] }
  | { kind: "template"; sourceText: string }
  | { kind: "identifier"; name: string }
  | { kind: "call"; callee: string; args: RecordedArgument[] }
  | null;

/** A parameter as a call fills it: by name for a keyword, by place otherwise. */
export interface ParameterPlace {
  name: string;
  position: number;
}

/**
 * The argument the call passes for the parameter, or undefined when it
 * passes none. A splat, `*args`, can fill any parameter from its place
 * on, so each of those gets the splat, a value suss cannot read.
 */
export function argumentForParameter(
  args: readonly RecordedArgument[],
  parameter: ParameterPlace,
): RecordedArgument | undefined {
  const last = args.at(-1);
  const keywords = last?.kind === "keywords" ? last.fields : undefined;
  if (keywords !== undefined && Object.hasOwn(keywords, parameter.name)) {
    return keywords[parameter.name];
  }
  const positional = keywords === undefined ? args : args.slice(0, -1);
  const splat = positional.findIndex(
    (arg) => arg?.kind === "identifier" && arg.name.startsWith("*"),
  );
  if (splat !== -1 && parameter.position >= splat) {
    return positional[splat];
  }
  return positional[parameter.position];
}
