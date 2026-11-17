/**
 * What the run's packs declare about class bodies, read through the
 * module ops and stated as the facts the rules read.
 *
 * The reader in @suss/recognize says what each class body declares: an
 * association, a callback, a class method defined from a lambda. This
 * states each the way Ruby does. An association becomes a constant
 * reference the bindings settle from the class's nesting, since the
 * inflected name has no node in the source. A callback becomes one
 * `classCallback` row per event and method. A scope's lambda is held on
 * the class under the class method's name, and the reach walk enters it
 * as that method.
 */

import { declareClassBody } from "@suss/recognize";
import { classBodyCalls } from "@suss/resolution";

import { classesIn, rubyModuleOps } from "./declaredDiscovery.js";
import { RUBY_PROGRAM } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";
import { associationTargetName } from "./inflect.js";

import type { Database } from "@suss/datalog";
import type {
  AstCapableValueOps,
  ClassBodyDeclaration,
  FactSource,
} from "@suss/extractor";
import type { ClassDeclaration } from "@suss/recognize";
import type { RbInflections } from "./pack.js";
import type { RbNode } from "./parser.js";

/** What each class body in one file declares, by the class's key, in source order. */
export type ClassBodiesOfFile = ReadonlyMap<
  string,
  readonly ClassDeclaration[]
>;

/** An association, with the class it reaches written out as the source writes or inflects it. */
export interface DeclaredAssociation {
  readonly name: string;
  readonly written: string;
}

/** A method a class body call defines, and the lambda or block that runs as it. */
export interface DefinedMethod {
  readonly name: string;
  readonly lambda: RbNode;
  /** Whether the method is the class's own, as a scope is, or its instances', as a Minitest `test` is. */
  readonly defines: "singleton" | "instance";
}

/**
 * What every class and module the file writes declares in its body, read
 * through `source`. The module ops list the classes in the order
 * `classesIn` gives their keys, so the two are read side by side.
 */
export function classBodiesIn(
  db: Database,
  file: string,
  root: RbNode,
  declarations: readonly ClassBodyDeclaration[],
  source: FactSource,
): ClassBodiesOfFile {
  const found = new Map<string, ClassDeclaration[]>();
  if (declarations.every(readsNothing)) {
    return found;
  }
  const keys = classesIn(root, file);
  // One question for the file, so the rules run once and not once a class.
  classBodyCalls(db, keys, RUBY_PROGRAM);
  rubyModuleOps(root, file, db, source)
    .classes()
    .forEach((cls, at) => {
      found.set(
        keys[at] as string,
        declarations.flatMap((declaration) =>
          declareClassBody(declaration, cls),
        ),
      );
    });
  return found;
}

function readsNothing(declaration: ClassBodyDeclaration): boolean {
  return (
    Object.keys(declaration.calls).length === 0 &&
    declaration.fields.association === undefined
  );
}

/** Asks for the body calls of every class in the run at once, so the rules run once and not once a file. */
export function askClassBodies(
  db: Database,
  files: readonly { readonly file: string; readonly root: RbNode }[],
): void {
  classBodyCalls(
    db,
    files.flatMap(({ file, root }) => classesIn(root, file)),
    RUBY_PROGRAM,
  );
}

type Declared<K extends ClassDeclaration["kind"]> = Extract<
  ClassDeclaration,
  { kind: K }
>;

function ofKind<K extends ClassDeclaration["kind"]>(
  declared: readonly ClassDeclaration[],
  kind: K,
): Declared<K>[] {
  return declared.filter((one): one is Declared<K> => one.kind === kind);
}

/**
 * Each class's associations, with the target a `class_name:` writes or
 * else the name put through the project's inflections. One whose
 * `class_name:` is not a plain string is left out.
 */
export function associationsOf(
  bodies: ClassBodiesOfFile,
  inflections: RbInflections,
): Map<string, DeclaredAssociation[]> {
  const found = new Map<string, DeclaredAssociation[]>();
  for (const [classKey, declared] of bodies) {
    found.set(
      classKey,
      ofKind(declared, "association").flatMap(({ name, target }) => {
        if (target === null) {
          return [];
        }
        const written =
          "written" in target
            ? target.written
            : associationTargetName(target.inflect, target.plural, inflections);
        return [{ name, written }];
      }),
    );
  }
  return found;
}

/** Each class's methods defined from a lambda or a block, with its node. */
export function definedMethodsOf(
  bodies: ClassBodiesOfFile,
): Map<string, DefinedMethod[]> {
  const found = new Map<string, DefinedMethod[]>();
  for (const [classKey, declared] of bodies) {
    found.set(
      classKey,
      ofKind(declared, "method").flatMap(({ name, body, defines }) => {
        const lambda = (body as AstCapableValueOps).ast() as RbNode | null;
        return lambda === null ? [] : [{ name, lambda, defines }];
      }),
    );
  }
  return found;
}

/**
 * One `classCallback(class, event, method)` for each event a registration
 * covers and each method it registers, the way the library registers each.
 */
export function emitClassCallbacks(
  db: Database,
  bodies: ClassBodiesOfFile,
): void {
  for (const [classKey, declared] of bodies) {
    for (const { events, methods } of ofKind(declared, "callback")) {
      for (const event of events) {
        for (const method of methods) {
          db.add("classCallback", [classKey, event, method]);
        }
      }
    }
  }
}

/** The key the facts give a lambda a class body call defines a method from. */
export function lambdaKey(file: string, method: DefinedMethod): string {
  return nodeId(file, method.lambda);
}
