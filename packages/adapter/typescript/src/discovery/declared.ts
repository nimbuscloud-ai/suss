// declared.ts: the patterns every adapter reads the same way, run over
// this adapter's facts. The reader is in @suss/recognize; this file hands
// it the module ops for one file and widens what it finds.

import { Node, type SourceFile } from "ts-morph";

import { discoverDeclared } from "@suss/recognize";
import { factModuleOps } from "@suss/recognize/ops";

import { nodeId } from "../facts/extract.js";
import { factSourceFor } from "../resolve/factSource.js";
import { opsOverFacts } from "../resolve/opsOverFacts.js";
import { discoveredUnitOf } from "./shared.js";

import type { DeclaredDiscoveryMatch, ModuleOps } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

export function discoverDeclaredIn(
  sourceFile: SourceFile,
  match: DeclaredDiscoveryMatch,
  kind: string,
  store: ResolutionStore,
): DiscoveredUnit[] {
  return discoverDeclared(match, kind, moduleOpsFor(sourceFile, store)).map(
    discoveredUnitOf,
  );
}

/**
 * The file as the module ops ask about it. The export table follows a
 * re-export to the declaration, which `exportsAs` alone does not, and is
 * the same table the adapter's other export readers ask.
 */
export function moduleOpsFor(
  sourceFile: SourceFile,
  store: ResolutionStore,
): ModuleOps {
  const originatesFrom = (value: Node, module: string): boolean =>
    store.originatesFrom(value, module);
  const access = store.factAccess();
  return factModuleOps(
    sourceFile.getFilePath(),
    factSourceFor(store, originatesFrom),
    {
      state: () => access.state(sourceFile),
      exports: () =>
        [...store.exportsOf(sourceFile)].flatMap(([name, declarations]) => {
          const [first] = declarations;
          return first === undefined ? [] : [{ name, key: nodeId(first) }];
        }),
      calls: () =>
        callsOutsideFunctions(sourceFile).map((call) =>
          opsOverFacts(call, { resolution: store, originatesFrom }),
        ),
      functions: () =>
        functionsIn(sourceFile).map((fn) => {
          access.state(fn);
          return { key: nodeId(fn), assignedName: assignedNameOf(fn) };
        }),
      mentions: (word) => sourceFile.getFullText().includes(word),
    },
  );
}

type Called = Parameters<typeof opsOverFacts>[0];

/** The calls the module body runs, outside every function, a call before the calls inside it. */
function callsOutsideFunctions(sourceFile: SourceFile): Called[] {
  const calls: Called[] = [];
  sourceFile.forEachDescendant((node, traversal) => {
    if (Node.isFunctionLikeDeclaration(node)) {
      traversal.skip();
      return;
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      calls.push(node);
    }
  });
  return calls;
}

/** Every function the file writes, declared, assigned or written in place, in source order. */
function functionsIn(sourceFile: SourceFile): Node[] {
  const found: Node[] = [];
  sourceFile.forEachDescendant((node) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      found.push(node);
    }
  });
  return found;
}

/** A declaration's own name, or the variable or property a function written in place is assigned to. */
function assignedNameOf(fn: Node): string | null {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? null;
  }
  const parent = fn.getParent();
  if (
    parent !== undefined &&
    (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent))
  ) {
    return parent.getName();
  }
  return null;
}
