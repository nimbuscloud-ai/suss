/**
 * The flags a Python command takes, read off the argparse parser it hands
 * its arguments to. In `parser.add_argument("--dir")` followed by
 * `parser.parse_args(argv)`, the `add_argument` call is the only place
 * the flag is written. Each one becomes an input read of the flag off the
 * parameter `parse_args` is handed, and a positional argument a read of
 * its position, the way the Node pack reads `parseArgs`.
 */

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field, stringLiteralValue } from "./ast.js";
import { callArguments } from "./facts/values.js";
import { isStdlibMember } from "./stdlibNames.js";

import type { InputRead } from "@suss/extractor";
import type { PyNode } from "./parser.js";
import type { ModuleBinding, Scope } from "./scope.js";

const PARSE_METHODS = new Set(["parse_args", "parse_known_args"]);

/** A nested function parses its own arguments when it runs. */
const DEFERRED_BODY_TYPES = new Set(["function_definition", "lambda"]);

export function argparseFlagReads(
  definition: PyNode,
  module: ModuleBinding,
  parameterNames: readonly string[],
): InputRead[] {
  const parsers = new Map<string, string[]>();
  const handedTo = new Map<string, string>();
  const startScope = module.scopeFor.get(definition.id) ?? module.moduleScope;
  walkDescendants<PyNode, Scope>(definition, startScope, {
    at: (node, scope) => {
      noteParser(node, scope, parsers);
      noteArgument(node, parsers);
      noteParse(node, parsers, parameterNames, handedTo);
    },
    into: (node, scope) => {
      if (DEFERRED_BODY_TYPES.has(node.type)) {
        return SKIP_CHILDREN;
      }
      return module.scopeFor.get(node.id) ?? scope;
    },
  });

  return [...handedTo].flatMap(([parser, input]) =>
    (parsers.get(parser) ?? []).map((flag) => ({ input, path: [flag] })),
  );
}

/** `parser = argparse.ArgumentParser(...)` starts a parser under that name. */
function noteParser(
  node: PyNode,
  scope: Scope,
  parsers: Map<string, string[]>,
): void {
  if (node.type !== "assignment") {
    return;
  }
  const target = field(node, "left");
  const value = field(node, "right");
  const callee = value?.type === "call" ? field(value, "function") : null;
  if (
    target?.type === "identifier" &&
    callee !== null &&
    isStdlibMember(callee, scope, "argparse", "ArgumentParser")
  ) {
    parsers.set(target.text, []);
  }
}

/** `parser.add_argument("--dir")` adds `--dir`, and `parser.add_argument("target")` the next position. */
function noteArgument(node: PyNode, parsers: Map<string, string[]>): void {
  const flags = receiverCalled(node, "add_argument", parsers);
  if (flags === null) {
    return;
  }
  const names = callArguments(node)
    .filter((argument) => argument.kind === "positional")
    .map((argument) => stringLiteralValue(argument.node))
    .filter((name): name is string => name !== null);
  const flag =
    names.find((name) => name.startsWith("--")) ??
    names.find((name) => name.startsWith("-"));
  if (flag !== undefined) {
    flags.push(flag);
    return;
  }
  if (names.length > 0) {
    flags.push(String(flags.filter((one) => !one.startsWith("-")).length));
  }
}

/** `parser.parse_args(argv)` hands the parser the parameter `argv`. */
function noteParse(
  node: PyNode,
  parsers: Map<string, string[]>,
  parameterNames: readonly string[],
  handedTo: Map<string, string>,
): void {
  const method = node.type === "call" ? methodCalledOn(node) : null;
  if (method === null || !PARSE_METHODS.has(method.name)) {
    return;
  }
  const argv = callArguments(node).find(
    (argument) => argument.kind === "positional" && argument.position === 0,
  )?.node;
  if (
    parsers.has(method.receiver) &&
    argv?.type === "identifier" &&
    parameterNames.includes(argv.text)
  ) {
    handedTo.set(method.receiver, argv.text);
  }
}

function receiverCalled(
  node: PyNode,
  name: string,
  parsers: Map<string, string[]>,
): string[] | null {
  const method = node.type === "call" ? methodCalledOn(node) : null;
  if (method === null || method.name !== name) {
    return null;
  }
  return parsers.get(method.receiver) ?? null;
}

/** The name a method is called on and the method's name, for `name.method(...)`. */
function methodCalledOn(
  call: PyNode,
): { receiver: string; name: string } | null {
  const callee = field(call, "function");
  const object = callee === null ? null : field(callee, "object");
  const name = callee === null ? null : field(callee, "attribute");
  if (
    callee?.type !== "attribute" ||
    object?.type !== "identifier" ||
    name === null
  ) {
    return null;
  }
  return { receiver: object.text, name: name.text };
}
