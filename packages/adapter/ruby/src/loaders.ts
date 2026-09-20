/**
 * loaders.ts: reading a call written through a batching loader.
 *
 * A loader takes the read off the caller and runs it later, in a source
 * class of the project's own. Two readers ask the same question of such
 * a call: the storage recognizer wants the model it was given, and the
 * reach walk wants the source method that runs. Both start by finding
 * the call that picked the source, which is what this settles.
 */

import { field } from "./ast.js";

import type { RbLoaderPattern } from "./pack.js";
import type { RbNode } from "./parser.js";

function receiverOf(node: RbNode): RbNode | null {
  return node.type === "call" ? field(node, "receiver") : null;
}

function methodOf(node: RbNode): string {
  return field(node, "method")?.text ?? "";
}

/** Whether a node is the loader itself, the receiverless `dataloader`. */
function isLoader(node: RbNode | null, loader: RbLoaderPattern): boolean {
  if (node === null) {
    return false;
  }
  if (node.type === "identifier") {
    return node.text === loader.loader;
  }
  return (
    node.type === "call" &&
    receiverOf(node) === null &&
    methodOf(node) === loader.loader
  );
}

/**
 * The call that was given the model, for a read through a loader: the
 * `with` behind `dataloader.with(Source, ::User).load(id)`, or the
 * shortcut itself for `dataload_record(::User, id)`. Null otherwise.
 */
export function loaderPick(
  call: RbNode,
  loader: RbLoaderPattern,
): RbNode | null {
  const method = methodOf(call);
  const receiver = receiverOf(call);
  if (receiver === null) {
    return loader.shortcuts.includes(method) ? call : null;
  }
  if (!loader.reads.includes(method) || receiver.type !== "call") {
    return null;
  }
  const picks =
    methodOf(receiver) === loader.pick &&
    isLoader(receiverOf(receiver), loader);
  return picks ? receiver : null;
}

/** The source class a `pick` call was given, for a loader whose pack says where it takes one. Null for a shortcut, which picks no source. */
export function pickedSource(
  call: RbNode,
  loader: RbLoaderPattern,
): RbNode | null {
  const source = loader.source;
  const pick = source === undefined ? null : loaderPick(call, loader);
  if (source === undefined || pick === null || methodOf(pick) !== loader.pick) {
    return null;
  }

  const args = field(pick, "arguments");
  const given = args === null ? undefined : args.namedChildren[source.at];
  return given?.type === "constant" || given?.type === "scope_resolution"
    ? given
    : null;
}
