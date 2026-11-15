/**
 * Binds each Ruby constant reference to the definition behind it. Ruby
 * has no imports, so a reference is bound directly to its definition. A
 * constant no file in the run defines, such as `Aws::SQS::Client`, comes
 * from a library, and is stated as imported from `GLOBAL_MODULE` under
 * its path, the way TypeScript states a global only library declarations
 * declare. A project that reopens a library's module to add a member of
 * its own, `module ActiveRecord` with a concern inside, still leaves the
 * library's other members to the library.
 */

import { GLOBAL_MODULE } from "@suss/resolution";

import { children, field, NESTING_TYPES } from "../ast.js";
import { nodeId } from "./values.js";

import type { Database } from "@suss/datalog";
import type { DeclaredAssociation } from "../classBodies.js";
import type { RbNode } from "../parser.js";

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
  /** The nesting each class or module body is written inside, by the class's key, its own name last. */
  readonly nestings: ReadonlyMap<string, readonly string[]>;
}

/** A reference read from the nesting it is written in, unless `::Status` pins it to the top level. */
function targetReference(
  key: string,
  written: string,
  nesting: readonly string[],
): ConstantReference {
  if (written.startsWith("::")) {
    return { key, written: written.slice(2), nesting: [] };
  }
  return { key, written, nesting };
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
    return field(parent, "name")?.id === node.id;
  }
  if (parent.type === "assignment") {
    return field(parent, "left")?.id === node.id;
  }
  // The outer `scope_resolution` is the reference; its parts are not.
  return parent.type === "scope_resolution";
}

/** Every constant this file defines and every one it reads, tracking the nesting as it goes. */
export function collectFileConstants(
  filePath: string,
  root: RbNode,
): FileConstants {
  const definitions: ConstantDefinition[] = [];
  const references: ConstantReference[] = [];
  const nestings = new Map<string, readonly string[]>();

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
        // `module ::Boards` defines the top-level `Boards`, whatever it is written inside.
        const qualifiedName = written.startsWith("::")
          ? written.slice(2)
          : qualify(nesting, written);
        definitions.push({
          qualifiedName,
          key: classKey,
          kind: "declaration",
        });
        const inside = qualifiedName.split("::");
        nestings.set(classKey, inside);
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
  return { filePath, definitions, references, nestings };
}

/** Whether a reference reads a library's top-level constant: no file in the run defines its full path, and no module it is written inside has its first segment, which Ruby looks in first. */
function readsLibraryConstant(
  byName: ReadonlyMap<string, readonly ConstantDefinition[]>,
  reference: ConstantReference,
): boolean {
  return (
    !byName.has(reference.written) && !startsInsideNesting(byName, reference)
  );
}

function startsInsideNesting(
  byName: ReadonlyMap<string, readonly ConstantDefinition[]>,
  reference: ConstantReference,
): boolean {
  const [root = reference.written] = reference.written.split("::");
  for (let depth = reference.nesting.length; depth > 0; depth--) {
    if (byName.has(qualify(reference.nesting.slice(0, depth), root))) {
      return true;
    }
  }
  return false;
}

/**
 * Binds every constant read in the run to its definition, looking outwards
 * from its nesting as Ruby does, and a file's reading of one to the file.
 */
export function emitConstantBindings(
  db: Database,
  perFile: Iterable<FileConstants>,
): AssociationBinder {
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

  const bind = (filePath: string, reference: ConstantReference): void => {
    for (let depth = reference.nesting.length; depth >= 0; depth--) {
      const candidate = qualify(
        reference.nesting.slice(0, depth),
        reference.written,
      );
      const key = settles(candidate);
      if (key !== null) {
        db.add("binds", [reference.key, key]);
        const definedIn = fileOfDefinition.get(key);
        if (definedIn !== undefined && definedIn !== filePath) {
          db.add("importsFile", [filePath, definedIn]);
        }
        return;
      }
    }
  };

  for (const file of files) {
    for (const reference of file.references) {
      if (readsLibraryConstant(byName, reference)) {
        db.add("imports", [reference.key, GLOBAL_MODULE, reference.written]);
      }
      bind(file.filePath, reference);
    }
  }

  const nestingsByFile = new Map(
    files.map((file) => [file.filePath, file.nestings]),
  );
  return {
    bindAssociations: (filePath, declared) => {
      const nestings = nestingsByFile.get(filePath);
      for (const [classKey, associations] of declared) {
        const nesting = nestings?.get(classKey);
        if (nesting === undefined) {
          continue;
        }
        for (const { name, written } of associations) {
          const target = targetReference(
            `${classKey}#association:${name}`,
            written,
            nesting,
          );
          db.add("declaresAssociation", [classKey, name, target.key]);
          bind(filePath, target);
        }
      }
    },
  };
}

/**
 * Binds an association's target as one more constant the class reads.
 * The target is a name inflected from a symbol, which the source never
 * writes, so it is never read as a library's constant.
 */
export interface AssociationBinder {
  bindAssociations(
    filePath: string,
    declared: ReadonlyMap<string, readonly DeclaredAssociation[]>,
  ): void;
}
