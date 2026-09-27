/**
 * What a body prints. `print(x)`, `print(x, file=sys.stderr)`,
 * `sys.stdout.write(x)` and `sys.stderr.write(x)` become the same
 * `stream-write` effect the Node pack records for `console.log` and
 * `process.stdout.write`, on an `io` binding that says which stream.
 *
 * `print` and `sys` are the standard library, so the adapter reads them
 * without a pack, the way it reads `os.environ`. A `print` whose `file`
 * is anything but one of the two streams writes to a file, and is left
 * alone.
 */

import { ioBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import { field } from "./ast.js";
import { callArguments } from "./facts/values.js";
import { shapeOfReturned } from "./paths/returnedShape.js";
import { resolveName } from "./scope.js";

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type { PyNode } from "./parser.js";
import type { ModuleBinding, Scope } from "./scope.js";

export const PYTHON_STREAM_RECOGNITION = "python-stdlib";

const STREAMS = new Set(["stdout", "stderr"]);

/** A nested function prints when it is called, so its body waits for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["function_definition", "lambda"]);

/** The write effects for every print under `root`, in source order. */
export function streamWriteEffects(
  root: PyNode,
  module: ModuleBinding,
): Effect[] {
  const found: Effect[] = [];
  const startScope = module.scopeFor.get(root.id) ?? module.moduleScope;
  walkDescendants<PyNode, Scope>(root, startScope, {
    at: (node, scope) => {
      if (node.type !== "call") {
        return;
      }
      const write = streamWriteAt(node, scope);
      if (write !== null) {
        found.push(write);
      }
    },
    into: (node, scope) => {
      if (DEFERRED_BODY_TYPES.has(node.type)) {
        return SKIP_CHILDREN;
      }
      return module.scopeFor.get(node.id) ?? scope;
    },
  });
  return found;
}

function streamWriteAt(call: PyNode, scope: Scope): Effect | null {
  const callee = field(call, "function");
  if (callee === null) {
    return null;
  }
  const written = callArguments(call);
  const positional = written
    .filter((argument) => argument.kind === "positional")
    .map((argument) => argument.node);

  if (callee.type === "identifier" && isBuiltin(callee, scope, "print")) {
    const file = written.find(
      (argument) => argument.kind === "keyword" && argument.name === "file",
    );
    const target =
      file === undefined ? "stdout" : standardStream(file.node, scope);
    return target === null
      ? null
      : writeEffect({ call, callee: callee.text, target, positional, scope });
  }

  if (
    callee.type !== "attribute" ||
    field(callee, "attribute")?.text !== "write"
  ) {
    return null;
  }
  const receiver = field(callee, "object");
  const target = receiver === null ? null : standardStream(receiver, scope);
  return target === null
    ? null
    : writeEffect({ call, callee: callee.text, target, positional, scope });
}

/** `sys.stdout`, or `stdout` after `from sys import stdout`, as the stream's name. */
function standardStream(node: PyNode, scope: Scope): string | null {
  if (node.type === "attribute") {
    const object = field(node, "object");
    const name = field(node, "attribute")?.text ?? "";
    return object !== null &&
      STREAMS.has(name) &&
      isStdlibModule(object, scope, "sys")
      ? name
      : null;
  }
  if (node.type !== "identifier" || !STREAMS.has(node.text)) {
    return null;
  }
  const binding = resolveName(scope, node.text);
  return binding?.kind === "importFrom" &&
    binding.module === "sys" &&
    binding.relativeLevel === 0
    ? node.text
    : null;
}

/** A name the file bound with `import <module>`. */
export function isStdlibModule(
  node: PyNode,
  scope: Scope,
  module: string,
): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  const binding = resolveName(scope, node.text);
  return (
    binding?.kind === "import" &&
    binding.module === module &&
    binding.relativeLevel === 0
  );
}

/** A name nothing in scope rebinds, so it is the builtin of that name. */
function isBuiltin(node: PyNode, scope: Scope, name: string): boolean {
  return node.text === name && resolveName(scope, name) === null;
}

interface WriteSite {
  call: PyNode;
  callee: string;
  target: string;
  positional: readonly PyNode[];
  scope: Scope;
}

function writeEffect(site: WriteSite): Effect {
  const { call, callee, target } = site;
  return {
    type: "interaction",
    binding: ioBinding({ recognition: PYTHON_STREAM_RECOGNITION, target }),
    callee,
    groupId: `${call.startPosition.row + 1}:${call.startPosition.column + 1}`,
    interaction: {
      class: "stream-write",
      ...payloadOf(site.positional, site.scope),
    },
  };
}

/**
 * `json.dumps(report)` writes the report as JSON. Several arguments are
 * printed one after another, so their shapes come back keyed by position.
 */
function payloadOf(
  args: readonly PyNode[],
  scope: Scope,
): {
  payload: TypeShape | null;
  serialized: "json" | "text";
} {
  const only = args[0];
  if (args.length !== 1 || only === undefined) {
    const properties: Record<string, TypeShape> = {};
    for (const [at, arg] of args.entries()) {
      properties[String(at)] = shapeOfReturned(arg);
    }
    return { payload: { type: "record", properties }, serialized: "text" };
  }
  const dumped = jsonDumped(only, scope);
  return dumped === null
    ? { payload: shapeOfReturned(only), serialized: "text" }
    : { payload: shapeOfReturned(dumped), serialized: "json" };
}

/** The value `json.dumps(value)` serializes, or null for any other expression. */
function jsonDumped(node: PyNode, scope: Scope): PyNode | null {
  if (node.type !== "call") {
    return null;
  }
  const callee = field(node, "function");
  const object = callee === null ? null : field(callee, "object");
  if (
    callee?.type !== "attribute" ||
    field(callee, "attribute")?.text !== "dumps" ||
    object === null ||
    !isStdlibModule(object, scope, "json")
  ) {
    return null;
  }
  const first = callArguments(node).find(
    (argument) => argument.kind === "positional" && argument.position === 0,
  );
  return first?.node ?? null;
}
