/**
 * The index every call in the run is resolved against: each class the
 * run defines with its method lookup order worked out, each method a
 * file defines outside a class, and the value facts the rules follow a
 * receiver through.
 *
 * It is built once, before any body is read, because the effect
 * lowering needs the same answer the reach walk does. A Ruby call with
 * no arguments is a method call when the rules settle its receiver, and
 * a property read otherwise.
 */

import { ancestryOf } from "../ancestry.js";
import {
  bodyStatements,
  field,
  NO_BODY_BLOCKS,
  OWN_BODY_TYPES,
} from "../ast.js";
import { nodeId } from "../facts/values.js";
import { walkDefinitions } from "../scope.js";
import { methodDefinitionsIn } from "../values/evaluator.js";

import type { Database } from "@suss/datalog";
import type { AncestorLookup, Ancestry, ReachedBody } from "../ancestry.js";
import type { BodyBlocks } from "../ast.js";
import type { DynamicNames } from "../defineMethod.js";
import type { RbLoaderPattern } from "../pack.js";
import type { RbNode } from "../parser.js";
import type { ReachContext, ReachedFunction } from "./resolveCallee.js";

const METHOD_TYPES = new Set(["method", "singleton_method"]);

/** Reads every file once up front, so resolving a call never re-reads a file. */
export async function buildReachContext(
  files: readonly { file: string; root: RbNode }[],
  facts: Database,
  bodyBlocks: BodyBlocks = NO_BODY_BLOCKS,
  dynamicNames: DynamicNames = new Map(),
  loaders: readonly RbLoaderPattern[] = [],
): Promise<ReachContext> {
  const blocksByQualifiedName = new Map<string, ReachedBody[]>();
  const classes: { file: string; info: ReachedBody["info"] }[] = [];
  // Both use the value facts' node keys, so a class or method the rules
  // settle on maps back to its qualified name.
  const classNames = new Map<string, string>();
  const classOfMethod = new Map<string, string>();
  for (const { file, root } of files) {
    walkDefinitions(root, (info) => {
      classes.push({ file, info });
      classNames.set(nodeId(file, info.node), info.qualifiedName);
      for (const statement of namedChildren(info.bodyNode)) {
        if (METHOD_TYPES.has(statement.type)) {
          classOfMethod.set(nodeId(file, statement), info.qualifiedName);
        }
      }
    });
  }
  const knownClasses = new Set(classes.map(({ info }) => info.qualifiedName));
  for (const { file, info } of classes) {
    const list = blocksByQualifiedName.get(info.qualifiedName) ?? [];
    list.push({ info, knownClasses, file });
    blocksByQualifiedName.set(info.qualifiedName, list);
  }

  const definitions = new Map<string, ReachedFunction>();
  for (const { file, root } of files) {
    for (const [key, method] of methodDefinitionsIn(file, root)) {
      const name = field(method, "name")?.text;
      if (name === undefined) {
        continue;
      }
      const owner = classOfMethod.get(key) ?? null;
      definitions.set(key, {
        file,
        node: method,
        name,
        exportPath: owner === null ? [name] : [owner, name],
        enclosingQualifiedName: owner,
      });
    }
  }

  const topLevelMethods = new Map<string, ReachedFunction[]>();
  for (const { file, root } of files) {
    for (const method of topLevelMethodNodes(root)) {
      const found = definitions.get(nodeId(file, method));
      if (found === undefined) {
        continue;
      }
      const list = topLevelMethods.get(found.name) ?? [];
      list.push(found);
      topLevelMethods.set(found.name, list);
    }
  }

  const lookup: AncestorLookup = {
    root: "",
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: [],
    // Every class the run defines is already in `blocksByQualifiedName`.
    // A name missing from it is outside the run, so there is no file to read.
    parsedFile: async () => null,
    localDefinition: (name) => blocksByQualifiedName.get(name) ?? null,
  };

  const ancestries = new Map<string, Ancestry>(
    await Promise.all(
      [...blocksByQualifiedName].map(
        async ([name, blocks]) =>
          [name, await ancestryOf(name, blocks, lookup)] as [string, Ancestry],
      ),
    ),
  );

  return {
    lookup,
    ancestries,
    topLevelMethods,
    facts,
    classNames,
    definitions,
    bodyBlocks,
    dynamicNames,
    loaders,
  };
}

/** tree-sitter types a named child as nullable, and a class with no body has no children at all. */
function namedChildren(node: RbNode | null): RbNode[] {
  if (node === null) {
    return [];
  }
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/** Every `def` written outside any class, module or other method. Ruby makes each one a private method of every object. */
function topLevelMethodNodes(root: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of bodyStatements(root)) {
    if (child.type === "method") {
      found.push(child);
      continue;
    }
    if (OWN_BODY_TYPES.has(child.type)) {
      continue;
    }
    topLevelMethodNodes(child, found);
  }
  return found;
}
