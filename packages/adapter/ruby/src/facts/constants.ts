/**
 * Binds each Ruby constant reference to the definition behind it. Ruby
 * has no imports, so there is no `imports` fact to follow, and a
 * reference is bound directly to its definition.
 */

import { field, NESTING_TYPES } from "../ast.js";
import { associationsDeclaredIn } from "./associations.js";
import { nodeId } from "./values.js";

import type { Database } from "@suss/datalog";
import type { RbAssociationCalls, RbInflections } from "../pack.js";
import type { RbNode } from "../parser.js";
import type { AssociationDeclaration } from "./associations.js";

/** A constant definition, which every file in the run can see, under its qualified name. */
export interface ConstantDefinition {
  readonly qualifiedName: string;
  readonly key: string;
  /** A `class` or `module` declaration, which any file may reopen, or an `X = ...` assignment. */
  readonly kind: "declaration" | "assignment";
}

/** A constant read somewhere, with the nesting it was read inside. */
export interface ConstantReference {
  readonly key: string;
  /** The name as written, `Order` or `Types::Order`. */
  readonly written: string;
  /** The enclosing module and class names, outermost first. */
  readonly nesting: readonly string[];
}

export interface FileConstants {
  readonly filePath: string;
  readonly definitions: readonly ConstantDefinition[];
  readonly references: readonly ConstantReference[];
  /** Empty unless a pack in the run declares association calls. */
  readonly associations: readonly AssociationDeclaration[];
}

function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

/** The name a constant or a `scope_resolution` is written as, `Types::Order` included. */
function writtenName(node: RbNode): string | null {
  if (node.type === "constant") {
    return node.text;
  }
  if (node.type !== "scope_resolution") {
    return null;
  }
  const scope = field(node, "scope");
  const name = field(node, "name");
  if (name === null) {
    return null;
  }
  // `::Order` has no scope, and is already the name in full.
  const prefix = scope === null ? "" : writtenName(scope);
  return prefix === null ? null : `${prefix}::${name.text}`;
}

/** The qualified name of a definition written inside `nesting`. */
function qualify(nesting: readonly string[], name: string): string {
  return [...nesting, name].join("::");
}

/** Whether a constant declares a name instead of reading one. */
function isDeclaration(node: RbNode, parent: RbNode | null): boolean {
  if (parent === null) {
    return false;
  }
  if (NESTING_TYPES.has(parent.type)) {
    return field(parent, "name") === node;
  }
  if (parent.type === "assignment") {
    return field(parent, "left") === node;
  }
  // The outer `scope_resolution` is the reference; its parts are not.
  return parent.type === "scope_resolution";
}

/**
 * Every constant this file defines and every one it reads, in one walk
 * that tracks the nesting as it goes. An association's target is
 * collected here too, because the inflected name has no node in the
 * source and only the nesting says which class it means.
 */
export function collectFileConstants(
  filePath: string,
  root: RbNode,
  associationCalls: readonly RbAssociationCalls[] = [],
  inflections?: RbInflections,
): FileConstants {
  const definitions: ConstantDefinition[] = [];
  const references: ConstantReference[] = [];
  const associations: AssociationDeclaration[] = [];

  const walk = (
    node: RbNode,
    parent: RbNode | null,
    nesting: string[],
  ): void => {
    if (NESTING_TYPES.has(node.type)) {
      const name = field(node, "name");
      const written = name === null ? null : writtenName(name);
      if (written !== null) {
        const classKey = nodeId(filePath, node);
        definitions.push({
          qualifiedName: qualify(nesting, written),
          key: classKey,
          kind: "declaration",
        });
        const inside = [...nesting, ...written.split("::")];
        for (const declared of associationsDeclaredIn(
          node,
          classKey,
          inside,
          associationCalls,
          inflections,
        )) {
          associations.push(declared);
          references.push(declared.target);
        }
        for (const child of children(node)) {
          walk(child, node, inside);
        }
        return;
      }
    }

    if (node.type === "assignment") {
      const left = field(node, "left");
      const right = field(node, "right");
      if (left !== null && left.type === "constant" && right !== null) {
        definitions.push({
          qualifiedName: qualify(nesting, left.text),
          key: nodeId(filePath, right),
          kind: "assignment",
        });
      }
    }

    if (
      (node.type === "constant" || node.type === "scope_resolution") &&
      !isDeclaration(node, parent)
    ) {
      const written = writtenName(node);
      if (written !== null) {
        const key =
          node.type === "constant"
            ? `${filePath}#${node.text}`
            : nodeId(filePath, node);
        // `::Order` is looked up from the top level, whatever it is written inside.
        references.push(
          written.startsWith("::")
            ? { key, written: written.slice(2), nesting: [] }
            : { key, written, nesting },
        );
      }
    }

    for (const child of children(node)) {
      walk(child, node, nesting);
    }
  };

  walk(root, null, []);
  return { filePath, definitions, references, associations };
}

/**
 * Binds every constant read anywhere in the run to its definition,
 * looking outwards from the nesting it was read inside, the way Ruby
 * does.
 *
 * `binds(refKey, defKey)` records the binding. `rbConstantFrom(from, to)`
 * records the same link between the two files, and it is the nearest
 * thing Ruby has to an import graph.
 *
 * `declaresAssociation` is emitted here too, because an association's
 * target is one of these references and the shared rules join the two.
 */
export function emitConstantBindings(
  db: Database,
  perFile: Iterable<FileConstants>,
): void {
  const byName = new Map<string, ConstantDefinition[]>();
  const fileOfDefinition = new Map<string, string>();
  const files = [...perFile];
  for (const file of files) {
    for (const definition of file.definitions) {
      const found = byName.get(definition.qualifiedName) ?? [];
      found.push(definition);
      byName.set(definition.qualifiedName, found);
      fileOfDefinition.set(definition.key, file.filePath);
      // A caller that settled a value on a class through the rules has
      // only the key, and needs this fact to get the class's name.
      db.add("rbConstantName", [definition.key, definition.qualifiedName]);
    }
  }

  /**
   * Which definition a candidate name refers to. Two files that open one
   * class or module reopen the same constant, so the reference binds to
   * the first body and a lookup by name finds the rest. Two assignments
   * would make the choice a guess, so neither is bound. An assignment
   * next to a declaration is taken as a script that reuses the name.
   */
  const settles = (candidate: string): string | null => {
    const found = byName.get(candidate) ?? [];
    const declared = found.filter((one) => one.kind === "declaration");
    if (declared.length > 0) {
      return (declared[0] as ConstantDefinition).key;
    }
    return found.length === 1 ? (found[0] as ConstantDefinition).key : null;
  };

  for (const file of files) {
    for (const declared of file.associations) {
      db.add("declaresAssociation", [
        declared.classKey,
        declared.name,
        declared.target.key,
      ]);
    }
    for (const reference of file.references) {
      for (let depth = reference.nesting.length; depth >= 0; depth--) {
        const candidate = qualify(
          reference.nesting.slice(0, depth),
          reference.written,
        );
        const key = settles(candidate);
        if (key !== null) {
          db.add("binds", [reference.key, key]);
          const definedIn = fileOfDefinition.get(key);
          if (definedIn !== undefined && definedIn !== file.filePath) {
            db.add("rbConstantFrom", [file.filePath, definedIn]);
          }
          break;
        }
      }
    }
  }
}
