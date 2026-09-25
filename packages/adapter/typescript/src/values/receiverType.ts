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

import { peelSyntax } from "../walk/unwrap.js";

import type { Symbol as TsSymbol, Type } from "ts-morph";

/** One named type a receiver is, and the files that declare it. */
export interface ReceiverType {
  name: string;
  declaredIn: readonly string[];
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
  return {
    name: symbol.getName(),
    declaredIn: symbol
      .getDeclarations()
      .map((declaration) => declaration.getSourceFile().getFilePath()),
  };
}

/** The types a value of this type is also one of. */
function typesBehind(type: Type): Type[] {
  if (type.isUnion()) {
    return type
      .getUnionTypes()
      .filter((member) => !member.isUndefined() && !member.isNull());
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

/** What a promise of a client resolves to. */
function awaitedTypes(type: Type): Type[] {
  return type.getSymbol()?.getName() === "Promise"
    ? type.getTypeArguments()
    : [];
}

function writtenTypesOf(node: Node): ReceiverType[] {
  return writtenTypeNodesOf(node)
    .flatMap((typeNode) => namesWritten(typeNode, new Set()))
    .map((name) => ({ name, declaredIn: [] }));
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
