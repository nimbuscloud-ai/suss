// entryClosure.ts: which files a runtime's handler entry reaches
// through imports.

import { readModuleImports } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

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

  const entryFile = [...files].find((file) => stripExtension(file) === entry);
  if (entryFile === undefined) {
    return null;
  }

  const reached = new Set<string>([entryFile]);
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined) {
      break;
    }

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
  return file.replace(/\.[cm]?[jt]sx?$/, "");
}
