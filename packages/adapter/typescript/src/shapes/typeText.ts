/**
 * Printing a type, and naming a type's properties, the same way in every run.
 *
 * The checker numbers types in the order it creates them and keeps a union's
 * members sorted by that number. A run that reads the program in a different
 * order, such as one that re-reads only the files that changed since the
 * cache was written, numbers them differently, so the checker's own printer
 * writes `"b" | "a"` where the first run wrote `"a" | "b"`. A property keyed
 * by a symbol has the same problem: its name ends in the symbol's number.
 *
 * Anything written into a summary goes through here instead. The text is
 * what the checker would print, with each union's members in a fixed order.
 */

import { ts } from "ts-morph";

import type { Node, Symbol as TsSymbol, Type } from "ts-morph";

const PRINTER = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});

/** Printed against when there is no enclosing node, as the checker does. */
const NO_FILE = ts.createSourceFile("", "", ts.ScriptTarget.Latest);

/** The flags ts-morph passes when `getText` is given none. */
function defaultFlags(enclosing: Node | undefined): ts.TypeFormatFlags {
  const flags =
    ts.TypeFormatFlags.UseTypeOfFunction |
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.UseFullyQualifiedType |
    ts.TypeFormatFlags.WriteTypeArgumentsOfSignature;
  if (enclosing?.getKind() === ts.SyntaxKind.TypeAliasDeclaration) {
    return flags | ts.TypeFormatFlags.InTypeAlias;
  }
  return flags;
}

/**
 * The text of `type`, as `type.getText(enclosing, flags)` prints it but
 * with every union's members in an order that does not depend on the run,
 * and with no absolute module paths. `reader` is any node of the same
 * program, for its checker.
 */
export function stableTypeText(
  type: Type,
  reader: Node,
  enclosing?: Node,
  flags?: ts.TypeFormatFlags,
): string {
  const checker = reader.getProject().getTypeChecker().compilerObject;
  const format = flags ?? defaultFlags(enclosing);
  const enclosingNode = enclosing?.compilerNode;
  const typeNode = checker.typeToTypeNode(
    type.compilerType,
    enclosingNode,
    (format & ts.TypeFormatFlags.NodeBuilderFlagsMask) |
      ts.NodeBuilderFlags.IgnoreErrors,
  );
  if (typeNode === undefined) {
    return withoutImportQualifiers(
      checker.typeToString(type.compilerType, enclosingNode, format),
    );
  }

  const file = enclosing?.getSourceFile().compilerNode ?? NO_FILE;
  const ordered = containsUnion(typeNode)
    ? withUnionMembersOrdered(typeNode, file)
    : typeNode;
  return withoutImportQualifiers(printed(ordered, file));
}

/**
 * When the enclosing file has no import for a type, the checker qualifies
 * it with the absolute path of its module, which differs between checkouts.
 */
const IMPORT_QUALIFIER = /import\("[^"]*"\)\./g;

const withoutImportQualifiers = (text: string): string =>
  text.replace(IMPORT_QUALIFIER, "");

/**
 * The checker writes an empty string where a multi-line construct would
 * break the line, so the line feeds come back out.
 */
function printed(node: ts.Node, file: ts.SourceFile): string {
  return PRINTER.printNode(ts.EmitHint.Unspecified, node, file).replace(
    /\n/g,
    "",
  );
}

function containsUnion(node: ts.Node): boolean {
  if (ts.isUnionTypeNode(node)) {
    return true;
  }
  return (
    ts.forEachChild(node, (child) => containsUnion(child) || undefined) === true
  );
}

function withUnionMembersOrdered(
  root: ts.TypeNode,
  file: ts.SourceFile,
): ts.TypeNode {
  const result = ts.transform(root, [
    (context) => {
      const visit = (node: ts.Node): ts.Node => {
        const visited = ts.visitEachChild(node, visit, context);
        if (!ts.isUnionTypeNode(visited)) {
          return visited;
        }
        return context.factory.updateUnionTypeNode(
          visited,
          context.factory.createNodeArray(inStableOrder(visited.types, file)),
        );
      };
      return (node) => visit(node) as ts.TypeNode;
    },
  ]);
  const [ordered] = result.transformed;
  result.dispose();
  return ordered;
}

function inStableOrder(
  members: ts.NodeArray<ts.TypeNode>,
  file: ts.SourceFile,
): ts.TypeNode[] {
  return members
    .map((member) => ({
      member,
      text: withoutImportQualifiers(printed(member, file)),
    }))
    .sort((a, b) => compareMembers(a.text, b.text))
    .map(({ member }) => member);
}

/**
 * The order union members are written in. `null` and `undefined` go last,
 * so `User | null` and `string | undefined` read the way people write them.
 */
export function compareMembers(a: string, b: string): number {
  return nullishRank(a) - nullishRank(b) || compareText(a, b);
}

function nullishRank(text: string): number {
  if (text === "null") {
    return 1;
  }

  if (text === "undefined") {
    return 2;
  }

  return 0;
}

/** Code-unit order, which unlike `localeCompare` is the same on every machine. */
export function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}

/**
 * A property's name as the source writes it. The checker's own name for a
 * property keyed by a symbol, such as `__@toStringTag@61189`, ends in the
 * symbol's number, so that one is printed the way it is declared instead,
 * as `[Symbol.toStringTag]`.
 */
export function stablePropertyName(symbol: TsSymbol, reader: Node): string {
  const name = symbol.getName();
  if (!name.startsWith("__@")) {
    return name;
  }
  const checker = reader.getProject().getTypeChecker().compilerObject;
  return checker.symbolToString(symbol.compilerSymbol);
}
