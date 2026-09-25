/**
 * Whether a node's type is a library's type, for a pack that recognizes
 * a call by what its receiver is rather than by what it is called.
 *
 * A library rarely hands back its type bare. A client factory can return
 * the library's class joined with an extra field (`Db & { $client: Pool }`),
 * and a project can declare the client as optional (`Db | undefined`), alias
 * it, subclass it, or pass it through a type parameter. A union or an
 * intersection has no symbol of its own, so this looks through each of
 * those to the named types underneath.
 *
 * When the library's declarations are not installed and the checker
 * cannot resolve the type, a query by name reads the written type.
 */

import { Node } from "ts-morph";

import { peelSyntax } from "../walk/unwrap.js";

import type { Symbol as TsSymbol, Type } from "ts-morph";

/** What the library's type looks like. A type must pass every test given. */
export interface ReceiverTypeQuery {
  /** Accepts the path of a file that declares the type. */
  declaredIn?: (filePath: string) => boolean;
  /** The names the type may have. */
  named?: readonly string[];
}

/**
 * The name of the first type behind the node's type that the query
 * accepts, or null when none does.
 */
export function receiverTypeMatching(
  node: Node,
  query: ReceiverTypeQuery,
): string | null {
  const type = node.getType();
  if (type.isAny()) {
    return writtenTypeMatching(node, query);
  }
  return checkedTypeMatching(type, query, new Set());
}

function checkedTypeMatching(
  type: Type,
  query: ReceiverTypeQuery,
  seen: Set<Type>,
): string | null {
  if (seen.has(type)) {
    return null;
  }
  seen.add(type);
  for (const symbol of [type.getAliasSymbol(), type.getSymbol()]) {
    if (symbol !== undefined && symbolMatches(symbol, query)) {
      return symbol.getName();
    }
  }
  for (const inner of typesBehind(type)) {
    const found = checkedTypeMatching(inner, query, seen);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function symbolMatches(symbol: TsSymbol, query: ReceiverTypeQuery): boolean {
  if (query.named !== undefined && !query.named.includes(symbol.getName())) {
    return false;
  }
  const { declaredIn } = query;
  if (declaredIn === undefined) {
    return true;
  }
  return symbol
    .getDeclarations()
    .some((declaration) =>
      declaredIn(declaration.getSourceFile().getFilePath()),
    );
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

/**
 * A declaration's written type can only be tested by name, so a query
 * that also asks where the type is declared gets no answer here.
 */
function writtenTypeMatching(
  node: Node,
  query: ReceiverTypeQuery,
): string | null {
  const { named } = query;
  if (named === undefined || query.declaredIn !== undefined) {
    return null;
  }
  for (const typeNode of writtenTypeNodesOf(node)) {
    const found = namesWritten(typeNode, new Set()).find((name) =>
      named.includes(name),
    );
    if (found !== undefined) {
      return found;
    }
  }
  return null;
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
