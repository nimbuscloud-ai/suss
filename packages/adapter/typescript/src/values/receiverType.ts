/**
 * The named types behind a node's type, for a pack that recognizes a
 * call by what its receiver is rather than by what it is called.
 *
 * A library rarely hands back its type bare. A client factory can return
 * the library's class joined with an extra field (`Db & { $client: Pool }`),
 * and a project can declare the client as optional (`Db | undefined`), alias
 * it, subclass it, or pass it through a type parameter. A union or an
 * intersection has no symbol of its own, so this looks through each of
 * those to the named types underneath, and the pack tests each one.
 *
 * When the checker cannot resolve the type because the library is not
 * installed, the names come from the written type, with no declaring file.
 */

import { Node } from "ts-morph";

import { GLOBAL_MODULE } from "@suss/resolution";

import { matchingImportDeclarations } from "../discovery/importScan.js";
import { compareText } from "../shapes/typeText.js";
import { peelSyntax } from "../walk/unwrap.js";

import type { Typed } from "@suss/extractor";
import type { ImportDeclaration, Symbol as TsSymbol, Type } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/** One named type a receiver is, and the files that declare it. */
export interface ReceiverType {
  name: string;
  declaredIn: readonly string[];
  /**
   * The base each declaring class is written as extending. When the
   * library is not installed the checker cannot see past a project's
   * `class Db extends Client`, and a pack asks where the base came from.
   */
  extendsWritten: readonly Node[];
}

/**
 * Whether the node is one of the origin's named types, as one of its
 * modules exports that type. The export is read through the file's own
 * import of the module, so a sub-path, a re-export from another package
 * and a module the project declares all count. A type the checker could
 * not resolve has no declaring file, and then the file importing that
 * name from the module is what says.
 */
export function typedAsExported(
  node: Node,
  origin: Typed,
  resolution: ResolutionStore | undefined,
): boolean {
  if (typedAsGlobal(node, origin, resolution)) {
    return true;
  }
  const types = receiverTypesOf(node).filter((type) =>
    origin.named.includes(type.name),
  );
  if (types.length === 0) {
    return false;
  }
  const file = node.getSourceFile();
  return origin.importedFrom.some((module) =>
    matchingImportDeclarations(file, module, resolution, true).some(
      (declaration) => types.some((type) => exportsType(declaration, type)),
    ),
  );
}

/**
 * Whether the node is a parameter annotated as one of the origin's types,
 * for a type the runtime declares, such as `NodeJS.WriteStream`. No file
 * imports one, so the annotation as written is what says.
 */
function typedAsGlobal(
  node: Node,
  origin: Typed,
  resolution: ResolutionStore | undefined,
): boolean {
  return (
    resolution !== undefined &&
    origin.importedFrom.includes(GLOBAL_MODULE) &&
    resolution.parameterAnnotatedAs(node, origin.named)
  );
}

/** Whether the module an import declaration reaches exports this type under its name. */
function exportsType(
  declaration: ImportDeclaration,
  type: ReceiverType,
): boolean {
  const target = declaration.getModuleSpecifierSourceFile();
  if (target === undefined) {
    return type.declaredIn.length === 0 && importsName(declaration, type.name);
  }
  return (target.getExportedDeclarations().get(type.name) ?? []).some(
    (exported) =>
      type.declaredIn.includes(exported.getSourceFile().getFilePath()),
  );
}

/** Whether an import declaration brings in `name`: by name, as its default, or with the whole module. */
function importsName(declaration: ImportDeclaration, name: string): boolean {
  return (
    declaration.getNamespaceImport() !== undefined ||
    declaration.getDefaultImport()?.getText() === name ||
    declaration.getNamedImports().some((one) => one.getName() === name)
  );
}

/** Every named type the node's type is, nearest first. */
export function receiverTypesOf(node: Node): ReceiverType[] {
  const type = node.getType();
  if (type.isAny()) {
    return writtenTypesOf(node);
  }
  const found: ReceiverType[] = [];
  collectCheckedTypes(type, found, new Set());
  return found;
}

function collectCheckedTypes(
  type: Type,
  found: ReceiverType[],
  seen: Set<Type>,
): void {
  if (seen.has(type)) {
    return;
  }
  seen.add(type);
  for (const symbol of [type.getAliasSymbol(), type.getSymbol()]) {
    if (symbol !== undefined) {
      found.push(receiverTypeOf(symbol));
    }
  }
  for (const inner of typesBehind(type)) {
    collectCheckedTypes(inner, found, seen);
  }
}

function receiverTypeOf(symbol: TsSymbol): ReceiverType {
  const declarations = symbol.getDeclarations();
  return {
    name: symbol.getName(),
    declaredIn: declarations.map((declaration) =>
      declaration.getSourceFile().getFilePath(),
    ),
    extendsWritten: declarations.flatMap((declaration) => {
      const heritage = Node.isClassDeclaration(declaration)
        ? declaration.getExtends()
        : undefined;
      return heritage === undefined ? [] : [heritage.getExpression()];
    }),
  };
}

/** The types a value of this type is also one of. */
function typesBehind(type: Type): Type[] {
  // The checker orders a union by numbers that change between runs, and a
  // pack that takes the first match would then pick differently.
  if (type.isUnion()) {
    return type
      .getUnionTypes()
      .filter((member) => !member.isUndefined() && !member.isNull())
      .sort((a, b) => compareText(memberName(a), memberName(b)));
  }

  if (type.isIntersection()) {
    return type.getIntersectionTypes();
  }

  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    return constraint === undefined ? [] : [constraint];
  }

  // A generic class instance only reaches its base classes through the
  // class it instantiates.
  const target = type.getTargetType();
  return [
    ...(target !== undefined && target !== type ? [target] : []),
    ...type.getBaseTypes(),
    ...awaitedTypes(type),
  ];
}

function memberName(type: Type): string {
  return (type.getAliasSymbol() ?? type.getSymbol())?.getName() ?? "";
}

/** What a promise of a client resolves to. */
function awaitedTypes(type: Type): Type[] {
  return type.getSymbol()?.getName() === "Promise"
    ? type.getTypeArguments()
    : [];
}

function writtenTypesOf(node: Node): ReceiverType[] {
  return writtenTypeNodesOf(node)
    .flatMap((typeNode) => namesWritten(typeNode, new Set()))
    .map((name) => ({ name, declaredIn: [], extendsWritten: [] }));
}

function writtenTypeNodesOf(node: Node): Node[] {
  const peeled = peelSyntax(node);
  const name = Node.isPropertyAccessExpression(peeled)
    ? peeled.getNameNode()
    : peeled;
  const typeNodes: Node[] = [];
  for (const declaration of name.getSymbol()?.getDeclarations() ?? []) {
    const typeNode = Node.isTyped(declaration)
      ? declaration.getTypeNode()
      : undefined;
    if (typeNode !== undefined) {
      typeNodes.push(typeNode);
    }
  }
  return typeNodes;
}

/** The type names a written type is made of, through local aliases. */
function namesWritten(typeNode: Node, seen: Set<Node>): string[] {
  if (seen.has(typeNode)) {
    return [];
  }
  seen.add(typeNode);
  if (Node.isUnionTypeNode(typeNode) || Node.isIntersectionTypeNode(typeNode)) {
    return typeNode.getTypeNodes().flatMap((part) => namesWritten(part, seen));
  }

  if (Node.isParenthesizedTypeNode(typeNode)) {
    return namesWritten(typeNode.getTypeNode(), seen);
  }

  if (!Node.isTypeReference(typeNode)) {
    return [];
  }
  const typeName = typeNode.getTypeName();
  const written = Node.isQualifiedName(typeName)
    ? typeName.getRight().getText()
    : typeName.getText();
  const aliased = (typeName.getSymbol()?.getDeclarations() ?? []).flatMap(
    (declaration) =>
      Node.isTypeAliasDeclaration(declaration)
        ? namesWritten(declaration.getTypeNodeOrThrow(), seen)
        : [],
  );
  return [written, ...aliased];
}
