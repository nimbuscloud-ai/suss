/**
 * What a call anywhere in the run is placed against: every class the
 * run defines with its method-lookup order worked out, every method a
 * file writes outside a class, and the value facts the rules read a
 * receiver through.
 *
 * It is built once, before anything reads a body, because the effect
 * lowering asks the same question the reach walk does: a Ruby call
 * written with no arguments is a method call when the rules settle its
 * receiver, and a property read otherwise.
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
import type { RbNode } from "../parser.js";
import type { ReachContext, ReachedFunction } from "./resolveCallee.js";

const METHOD_TYPES = new Set(["method", "singleton_method"]);

/** Every class the run defines, and every method written outside one, so a call anywhere can be placed without re-reading a file per call. */
export async function buildReachContext(
  files: readonly { file: string; root: RbNode }[],
  facts: Database,
  bodyBlocks: BodyBlocks = NO_BODY_BLOCKS,
  dynamicNames: DynamicNames = new Map(),
): Promise<ReachContext> {
  const blocksByQualifiedName = new Map<string, ReachedBody[]>();
  const classes: { file: string; info: ReachedBody["info"] }[] = [];
  // Both keyed the way the value facts key the node, so a class or a
  // method the rules settle on can be named.
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
    // Every class the run defines is already in `blocksByQualifiedName`
    // above, so a name that misses there is outside the run and this
    // never has a file on disk to read.
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
  };
}

/** tree-sitter types a named child as nullable, and a class with no body has no children at all. */
function namedChildren(node: RbNode | null): RbNode[] {
  if (node === null) {
    return [];
  }
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/** A `def` written outside any class, module, or other method, which Ruby calls a private method on every object. */
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
