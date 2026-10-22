// Which files a runtime's handler entry reaches through imports.

import { readModuleImports } from "../metadata.js";
import {
  referencedFile,
  referencedFileKey,
  summaryFileKey,
} from "../summaryId.js";

import type { BehavioralSummary } from "../index.js";

/**
 * Edges from each summary file to the files it imports, keyed the way
 * `summaryFileKey` keys a file, so two projects' `src/index.ts` stay
 * two nodes.
 */
export type ModuleGraph = ReadonlyMap<string, readonly string[]>;

export function buildModuleGraph(
  summaries: readonly BehavioralSummary[],
): ModuleGraph {
  const graph = new Map<string, readonly string[]>();
  for (const summary of summaries) {
    const imports = readModuleImports(summary);
    const key = summaryFileKey(summary);
    if (imports !== undefined && !graph.has(key)) {
      const owner = summary.location.workspace;
      graph.set(
        key,
        imports.map((file) => referencedFileKey(owner, file)),
      );
    }
  }
  return graph;
}

/**
 * Every file the entry reaches through the graph, the entry's own file
 * included, keyed as the graph keys them. The entry comes from a
 * template's `Handler`, written without an extension
 * ("src/handlers/confirm"), so it is compared with each graph file's
 * path with the extension stripped. Null when no file matches the
 * entry. The graph then does not show what the runtime loads, and the
 * caller falls back to the directory.
 */
export function entryClosure(
  entry: string,
  graph: ModuleGraph,
): ReadonlySet<string> | null {
  const keyByFile = new Map<string, string>();
  for (const key of graph.keys()) {
    const { file } = referencedFile(undefined, key);
    if (!keyByFile.has(file)) {
      keyByFile.set(file, key);
    }
  }
  const entryFile = entryFileAmong(entry, keyByFile.keys());
  const entryKey =
    entryFile === undefined ? undefined : keyByFile.get(entryFile);
  if (entryKey === undefined) {
    return null;
  }

  const reached = new Set<string>([entryKey]);
  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.pop();
    // The loop condition guarantees a key. The check only narrows the type.
    /* v8 ignore start */
    if (key === undefined) {
      break;
    }
    /* v8 ignore stop */

    for (const imported of graph.get(key) ?? []) {
      if (!reached.has(imported)) {
        reached.add(imported);
        queue.push(imported);
      }
    }
  }
  return reached;
}

/**
 * The file among these that a template's entry, written without an
 * extension, refers to: `src/confirm` or the Python-style
 * `src/handlers.confirm`. Undefined when none does.
 */
export function entryFileAmong(
  entry: string,
  candidates: Iterable<string>,
): string | undefined {
  const files = [...candidates];
  return (
    files.find((file) => stripExtension(file) === entry) ??
    files.find((file) => stripExtension(file) === asModuleDirectory(entry))
  );
}

function stripExtension(file: string): string {
  return file.replace(/\.([cm]?[jt]sx?|py|rb)$/, "");
}

/** A Python handler writes its module with dots (`shop.app.handler`), so the last segment of the entry is also tried as a directory path. */
function asModuleDirectory(entry: string): string {
  const slash = entry.lastIndexOf("/");
  const directory = entry.slice(0, slash + 1);
  return directory + entry.slice(slash + 1).replace(/\./g, "/");
}
