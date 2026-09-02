// entryClosure.ts: which files a runtime's handler entry reaches
// through imports.

import { readModuleImports } from "../metadata.js";

import type { BehavioralSummary } from "../index.js";

/** Edges from each summary file to the files it imports. */
export type ModuleGraph = ReadonlyMap<string, readonly string[]>;

export function buildModuleGraph(
  summaries: readonly BehavioralSummary[],
): ModuleGraph {
  const graph = new Map<string, readonly string[]>();
  for (const summary of summaries) {
    const imports = readModuleImports(summary);
    if (imports !== undefined && !graph.has(summary.location.file)) {
      graph.set(summary.location.file, imports);
    }
  }
  return graph;
}

/**
 * Every file the entry reaches through the graph, the entry's own file
 * included. The entry comes from a template's `Handler`, written
 * without an extension ("src/handlers/confirm"), so it matches a graph
 * file by comparing with the extension stripped. Null when no file
 * matches the entry, which means the graph cannot say what the runtime
 * loads and the caller falls back to the directory.
 */
export function entryClosure(
  entry: string,
  graph: ModuleGraph,
): ReadonlySet<string> | null {
  const files = new Set<string>();
  for (const file of graph.keys()) {
    files.add(file);
  }

  const entryFile =
    [...files].find((file) => stripExtension(file) === entry) ??
    [...files].find(
      (file) => stripExtension(file) === asModuleDirectory(entry),
    );
  if (entryFile === undefined) {
    return null;
  }

  const reached = new Set<string>([entryFile]);
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    // The loop condition guarantees one; this keeps the narrowing.
    /* v8 ignore start */
    if (file === undefined) {
      break;
    }
    /* v8 ignore stop */

    for (const imported of graph.get(file) ?? []) {
      if (!reached.has(imported)) {
        reached.add(imported);
        queue.push(imported);
      }
    }
  }
  return reached;
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
