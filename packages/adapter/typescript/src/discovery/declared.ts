// declared.ts: the patterns every adapter reads the same way, run over
// this adapter's facts. The reader is in @suss/recognize; this file hands
// it the module ops for one file and widens what it finds.

import {
  type ClassDeclaration,
  type MethodDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

import { discoverDeclared } from "@suss/recognize";
import { factModuleOps } from "@suss/recognize/ops";

import { nodeId } from "../facts/extract.js";
import { fileMentions } from "../fileMentions.js";
import { factSourceFor } from "../resolve/factSource.js";
import { opsOverFacts } from "../resolve/opsOverFacts.js";
import { functionNameOf, memberNameOf } from "../walk/propertyName.js";
import { bindsAtTopLevel, importedNamesOf } from "./importScan.js";
import { discoveredUnitOf } from "./shared.js";

import type {
  CallScope,
  DeclaredDiscoveryMatch,
  ModuleOps,
} from "@suss/extractor";
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
      calls: (scope) =>
        callsWritten(sourceFile, scope).map((call) =>
          opsOverFacts(call, { resolution: store, originatesFrom }),
        ),
      classes: () =>
        classesIn(sourceFile).map((cls) => {
          access.state(cls);
          return nodeId(cls);
        }),
      elements: () => store.elementsWrittenIn(sourceFile),
      importedNames: (modules) => importedNamesOf(sourceFile, modules),
      bindsAtTopLevel: (name) => bindsAtTopLevel(sourceFile, name),
      functions: () =>
        functionsIn(sourceFile).map((fn) => {
          access.state(fn);
          return { key: nodeId(fn), assignedName: assignedNameOf(fn) };
        }),
      decorated: () =>
        decoratedIn(sourceFile).map((node) => {
          const declaration = Node.isClassDeclaration(node)
            ? node
            : node.getParentIfKind(SyntaxKind.ClassDeclaration);
          if (declaration !== undefined) {
            access.stateClass(declaration);
          }
          return { key: nodeId(node), name: node.getName() ?? null };
        }),
      mentions: (word) => fileMentions(sourceFile, word),
    },
  );
}

/** Every declared class and method the file writes under a decorator, in source order. */
function decoratedIn(
  sourceFile: SourceFile,
): (ClassDeclaration | MethodDeclaration)[] {
  const found: (ClassDeclaration | MethodDeclaration)[] = [];
  sourceFile.forEachDescendant((node) => {
    if (
      (Node.isClassDeclaration(node) || Node.isMethodDeclaration(node)) &&
      node.getDecorators().length > 0
    ) {
      found.push(node);
    }
  });
  return found;
}

type Called = Parameters<typeof opsOverFacts>[0];

/**
 * The calls the file writes, a call before the calls inside it: the
 * module body's, outside every function, or every one for `file`.
 */
function callsWritten(sourceFile: SourceFile, scope: CallScope): Called[] {
  const calls: Called[] = [];
  sourceFile.forEachDescendant((node, traversal) => {
    if (scope === "moduleBody" && Node.isFunctionLikeDeclaration(node)) {
      traversal.skip();
      return;
    }
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      calls.push(node);
    }
  });
  return calls;
}

/** Every class the file writes, declared or assigned to a name, in source order. */
function classesIn(sourceFile: SourceFile): Node[] {
  const found: Node[] = [];
  sourceFile.forEachDescendant((node) => {
    if (
      Node.isClassDeclaration(node) ||
      (Node.isClassExpression(node) &&
        Node.isVariableDeclaration(node.getParent()))
    ) {
      found.push(node);
    }
  });
  return found;
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
    return functionNameOf(fn) ?? null;
  }
  const parent = fn.getParent();
  if (parent !== undefined && Node.isPropertyAssignment(parent)) {
    return memberNameOf(parent);
  }
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return null;
}
