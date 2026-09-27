/**
 * The flags a Ruby command takes, read off the OptionParser it hands its
 * arguments to. In `OptionParser.new { |opts| opts.on("--dir DIR") }`
 * followed by `.parse!(argv)`, the `on` call is the only place the flag
 * is written. Each one becomes an input read of the flag off the
 * parameter the parser is handed, the way the Node pack reads
 * `parseArgs`. OptionParser is Ruby's standard library, so the adapter
 * reads it without a pack.
 */

import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field, readCallArgs, stringLiteralValue } from "./ast.js";

import type { InputRead } from "@suss/extractor";
import type { RbNode } from "./parser.js";

const PARSE_METHODS = new Set(["parse", "parse!", "permute", "permute!"]);

/** A nested method parses its own arguments when it runs. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

export function optionParserFlagReads(
  method: RbNode,
  parameterNames: readonly string[],
): InputRead[] {
  const body = field(method, "body");
  if (body === null) {
    return [];
  }
  // A parse call chained on the construction is its parent, and so is an
  // assignment naming it, so every parser is collected before either is read.
  const flagsByParser = new Map<number, string[]>();
  const parserNamed = new Map<string, number>();
  walkBody(body, (node) => {
    if (node.type === "call" && isNewOptionParser(node)) {
      flagsByParser.set(node.id, flagsDeclaredIn(node));
    }
  });
  const reads: InputRead[] = [];
  walkBody(body, (node) => {
    if (node.type === "assignment") {
      noteParserName(node, flagsByParser, parserNamed);
    }
    if (node.type === "call") {
      reads.push(
        ...readsOfParse(node, flagsByParser, parserNamed, parameterNames),
      );
    }
  });
  return reads;
}

function walkBody(body: RbNode, at: (node: RbNode) => void): void {
  walkDescendants<RbNode, null>(body, null, {
    at,
    into: (node) => (DEFERRED_BODY_TYPES.has(node.type) ? SKIP_CHILDREN : null),
  });
}

const OPTION_PARSER_SPELLINGS = new Set(["OptionParser", "::OptionParser"]);

function isNewOptionParser(call: RbNode): boolean {
  const receiver = field(call, "receiver");
  return (
    field(call, "method")?.text === "new" &&
    receiver !== null &&
    OPTION_PARSER_SPELLINGS.has(receiver.text)
  );
}

/** Every flag an `on` call in the parser's block declares, long form first. */
function flagsDeclaredIn(construction: RbNode): string[] {
  const block = field(construction, "block");
  if (block === null) {
    return [];
  }
  const flags: string[] = [];
  walkDescendants<RbNode, null>(block, null, {
    at: (node) => {
      if (node.type !== "call" || field(node, "method")?.text !== "on") {
        return;
      }
      const flag = flagOf(readCallArgs(field(node, "arguments")).positional);
      if (flag !== null) {
        flags.push(flag);
      }
    },
    into: () => null,
  });
  return flags;
}

/** `"--dir DIR"` declares `--dir`, and `"--[no-]json"` declares `--json`. */
function flagOf(args: readonly RbNode[]): string | null {
  const written = args
    .map((arg) => stringLiteralValue(arg))
    .filter((text): text is string => text !== null && text.startsWith("-"));
  const chosen =
    written.find((text) => text.startsWith("--")) ?? written[0] ?? null;
  if (chosen === null) {
    return null;
  }
  const name = chosen.split(/[ =]/)[0] ?? chosen;
  return name.replace("[no-]", "");
}

/** `parser = OptionParser.new { ... }` gives the parser a name the parse call can use. */
function noteParserName(
  assignment: RbNode,
  flagsByParser: ReadonlyMap<number, string[]>,
  parserNamed: Map<string, number>,
): void {
  const target = field(assignment, "left");
  const value = field(assignment, "right");
  if (
    target?.type === "identifier" &&
    value !== null &&
    flagsByParser.has(value.id)
  ) {
    parserNamed.set(target.text, value.id);
  }
}

function readsOfParse(
  call: RbNode,
  flagsByParser: ReadonlyMap<number, string[]>,
  parserNamed: ReadonlyMap<string, number>,
  parameterNames: readonly string[],
): InputRead[] {
  if (!PARSE_METHODS.has(field(call, "method")?.text ?? "")) {
    return [];
  }
  const parser = parserCalledOn(field(call, "receiver"), parserNamed);
  const flags = parser === undefined ? undefined : flagsByParser.get(parser);
  const argv = readCallArgs(field(call, "arguments")).positional[0];
  if (
    flags === undefined ||
    argv?.type !== "identifier" ||
    !parameterNames.includes(argv.text)
  ) {
    return [];
  }
  return flags.map((flag) => ({ input: argv.text, path: [flag] }));
}

/** The construction a parse call is made on: written right there, or named first. */
function parserCalledOn(
  receiver: RbNode | null,
  parserNamed: ReadonlyMap<string, number>,
): number | undefined {
  if (receiver === null) {
    return undefined;
  }
  if (receiver.type === "identifier") {
    return parserNamed.get(receiver.text);
  }
  return receiver.id;
}
