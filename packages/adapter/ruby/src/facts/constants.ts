// constants.ts: linking a Ruby constant to the definition behind it. Ruby has
// no imports, so `imports` has no counterpart here and this binds a reference
// straight to its definition. The README says how the lookup works.

import { field, NESTING_TYPES } from "../ast.js";
import { associationsDeclaredIn } from "./associations.js";
import { nodeId } from "./values.js";

import type { Database } from "@suss/datalog";
import type { RbAssociationCalls, RbInflections } from "../pack.js";
import type { RbNode } from "../parser.js";
import type { AssociationDeclaration } from "./associations.js";

/** A definition every file in the run can see, under the name it is written as. */
export interface ConstantDefinition {
  readonly qualifiedName: string;
  readonly key: string;
  /** `class`/`module` opens a constant every file may open again; `X = ...` sets one. */
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
  /** Empty unless a pack in the run said what an association declaration looks like. */
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

/** The whole name a definition goes by, given what it is written inside. */
function qualify(nesting: readonly string[], name: string): string {
  return [...nesting, name].join("::");
}

/** A constant that says what something is called rather than reading it. */
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
 * Every constant this file defines and every one it reads. One walk, because
 * the nesting a reference is written inside is what the walk already knows.
 * An association's target is read here too: the name it inflects to has no
 * node in the source, and the nesting is what settles which class it means.
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
 * Link every constant read anywhere in the run to the definition behind it,
 * looking outwards from the nesting it was read inside the way Ruby does.
 *
 * `binds(refKey, defKey)` is the link itself. `rbConstantFrom(from, to)`
 * is the same link at file level, which is the closest thing to an
 * import graph a language without imports has.
 *
 * `declaresAssociation` is emitted here as well, because an association's
 * target is one of those references and the shared rules read the pair
 * together.
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
      // the key and no reference to read a name off.
      db.add("rbConstantName", [definition.key, definition.qualifiedName]);
    }
  }

  /**
   * Which definition a reference means. Two files opening one class or
   * module are the same constant reopened, so the first body is the one
   * to bind to and a lookup by name reaches the rest. Two assignments
   * are a guess, and one alongside a declaration is a script that
   * happens to spell the name the same way.
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
