// extract.ts - turn one source file into facts.
//
// No resolution happens here. This pass records what the file
// syntactically contains: functions, what variables are declared as,
// what is imported and exported, which calls wrap which arguments.
// The rules in rules.ts do the connecting.
//
// Node identity is `absolutePath:startOffset`. The extractor fills a
// side table from id back to ts-morph Node so a resolved answer comes
// back as a Node the rest of the adapter can use.

import { type Expression, Node, type SourceFile, SyntaxKind } from "ts-morph";

import type { FactDb } from "./engine.js";

export interface NodeTable {
  byId: Map<string, Node>;
  /** Functions whose facts are already emitted, per store. */
  seenFunctions: Set<Node>;
}

export function createNodeTable(): NodeTable {
  return { byId: new Map(), seenFunctions: new Set() };
}

export function nodeId(node: Node): string {
  // Start alone is ambiguous: a call and its callee, or a declaration
  // and its name, begin at the same offset. The end disambiguates.
  return `${node.getSourceFile().getFilePath()}:${node.getStart()}-${node.getEnd()}`;
}

/**
 * Module key for an import or re-export target: the resolved file path
 * when the specifier points inside the project, otherwise the raw
 * specifier (a package name). Package keys join against nothing, which
 * is correct: a package has no facts, and the gate query treats
 * reaching a package key as its answer.
 */
function moduleKeyOf(
  declaration: Node & {
    getModuleSpecifierSourceFile(): SourceFile | undefined;
    getModuleSpecifierValue(): string | undefined;
  },
): string | null {
  const resolved = declaration.getModuleSpecifierSourceFile();
  if (resolved !== undefined) {
    return resolved.getFilePath();
  }
  return declaration.getModuleSpecifierValue() ?? null;
}

/** Peel await, parentheses, satisfies, and as-casts. */
function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  for (;;) {
    if (Node.isAwaitExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isAsExpression(current) || Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return current;
  }
}

function isFunctionNode(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  );
}

/**
 * Record that `value` is a value of interest and emit the facts that
 * let the rules resolve it: its own identity, and a binds edge when it
 * is an identifier or property access referencing a declaration.
 */
function emitValue(db: FactDb, table: NodeTable, value: Expression): string {
  const expression = unwrapExpression(value);
  const id = nodeId(expression);
  table.byId.set(id, expression);

  if (isFunctionNode(expression)) {
    db.add("func", id);
    emitFunctionFacts(db, table, expression);
    return id;
  }

  if (
    Node.isIdentifier(expression) ||
    Node.isPropertyAccessExpression(expression)
  ) {
    emitReferenceFacts(db, table, expression);
    return id;
  }

  if (Node.isCallExpression(expression)) {
    emitCallFacts(db, table, expression);
    return id;
  }

  return id;
}

/**
 * binds(reference, declaration) for an identifier or property access.
 * The declaration may be an import specifier (rules follow it through
 * the imports relation), a variable declaration, or a function.
 */
function emitReferenceFacts(
  db: FactDb,
  table: NodeTable,
  reference: Expression,
): void {
  const referenceId = nodeId(reference);
  table.byId.set(referenceId, reference);

  const nameNode = Node.isPropertyAccessExpression(reference)
    ? reference.getNameNode()
    : reference;

  const symbol = nameNode.getSymbol();
  if (symbol === undefined) {
    return;
  }

  for (const declaration of symbol.getDeclarations()) {
    const declarationId = nodeId(declaration);
    table.byId.set(declarationId, declaration);

    if (Node.isImportSpecifier(declaration)) {
      const importDecl = declaration.getImportDeclaration();
      const moduleKey = moduleKeyOf(importDecl);
      if (moduleKey !== null) {
        db.add("binds", referenceId, declarationId);
        db.add("imports", declarationId, moduleKey, declaration.getName());
      }
      continue;
    }

    if (Node.isImportClause(declaration)) {
      // Default import: `import handler from "./mod"`.
      const importDecl = declaration.getParentIfKind(
        SyntaxKind.ImportDeclaration,
      );
      if (importDecl !== undefined) {
        const moduleKey = moduleKeyOf(importDecl);
        if (moduleKey !== null) {
          db.add("binds", referenceId, declarationId);
          db.add("imports", declarationId, moduleKey, "default");
        }
      }
      continue;
    }

    if (Node.isVariableDeclaration(declaration)) {
      db.add("binds", referenceId, declarationId);
      const initializer = declaration.getInitializer();
      if (initializer !== undefined) {
        db.add("binds", declarationId, emitValue(db, table, initializer));
      }
      continue;
    }

    if (Node.isParameterDeclaration(declaration)) {
      db.add("binds", referenceId, declarationId);
      continue;
    }

    if (isFunctionNode(declaration)) {
      db.add("binds", referenceId, declarationId);
      db.add("func", declarationId);
      emitFunctionFacts(db, table, declaration);
    }
  }
}

function emitCallFacts(
  db: FactDb,
  table: NodeTable,
  call: Node & {
    getExpression(): Expression;
    getArguments(): Node[];
  },
): void {
  const callId = nodeId(call as unknown as Node);
  table.byId.set(callId, call as unknown as Node);

  const callee = unwrapExpression(call.getExpression());

  // f.bind(receiver): the call resolves to whatever f resolves to.
  if (Node.isPropertyAccessExpression(callee) && callee.getName() === "bind") {
    const target = unwrapExpression(callee.getExpression());
    db.add("bindCall", callId, emitValue(db, table, target));
    return;
  }

  db.add("call", callId, emitValue(db, table, callee));
  db.add("calleeName", callId, callee.getText());

  const args = call.getArguments();
  for (let position = 0; position < args.length; position++) {
    const argument = args[position] as Node;
    if (!Node.isExpression(argument)) {
      continue;
    }
    db.add("callArg", callId, String(position), emitValue(db, table, argument));
  }
}

/**
 * Parameters, returned values, and body calls of a function. Body
 * calls are what the unwraps rule needs: an inner function that calls
 * a parameter of its enclosing factory.
 */
function emitFunctionFacts(db: FactDb, table: NodeTable, fn: Node): void {
  if (table.seenFunctions.has(fn)) {
    return;
  }
  table.seenFunctions.add(fn);

  const fnId = nodeId(fn);
  table.byId.set(fnId, fn);

  if (
    Node.isFunctionDeclaration(fn) ||
    Node.isFunctionExpression(fn) ||
    Node.isArrowFunction(fn) ||
    Node.isMethodDeclaration(fn)
  ) {
    const parameters = fn.getParameters();
    for (let position = 0; position < parameters.length; position++) {
      const parameter = parameters[position];
      if (parameter === undefined) {
        continue;
      }
      const parameterId = nodeId(parameter);
      table.byId.set(parameterId, parameter);
      db.add("paramOf", fnId, String(position), parameterId);
    }

    // Arrow shorthand body is itself the returned value, and when it
    // is a call, that call is also a body call for the unwraps rule.
    if (Node.isArrowFunction(fn)) {
      const body = fn.getBody();
      if (Node.isExpression(body)) {
        db.add("returnsValue", fnId, emitValue(db, table, body));
        const unwrapped = unwrapExpression(body);
        if (Node.isCallExpression(unwrapped)) {
          const callee = unwrapExpression(unwrapped.getExpression());
          if (Node.isIdentifier(callee)) {
            db.add("bodyCalls", fnId, emitValue(db, table, callee));
          }
        }
      }
    }

    const body = fn.getBody?.();
    if (body !== undefined && !Node.isExpression(body)) {
      body.forEachDescendant((descendant, traversal) => {
        // Nested functions are walked separately, but their calls
        // still belong to this function for the unwraps judgment: a
        // closure declared here runs as part of this function, so a
        // wrapper that delegates to its parameter inside one still
        // delegates. containsFn is what makes bodyCalls transitive.
        if (isFunctionNode(descendant)) {
          if (descendantIsReturned(descendant)) {
            db.add(
              "returnsValue",
              fnId,
              emitValue(db, table, descendant as Expression),
            );
          } else {
            emitValue(db, table, descendant as Expression);
          }
          db.add("containsFn", fnId, nodeId(descendant));
          traversal.skip();
          return;
        }

        if (Node.isReturnStatement(descendant)) {
          const returned = descendant.getExpression();
          if (returned !== undefined) {
            db.add("returnsValue", fnId, emitValue(db, table, returned));
          }
          return;
        }

        if (Node.isCallExpression(descendant)) {
          const callee = unwrapExpression(descendant.getExpression());
          if (Node.isIdentifier(callee)) {
            const calleeId = emitValue(db, table, callee);
            db.add("bodyCalls", fnId, calleeId);
          }
        }
      });
    }
  }
}

/** Whether a nested function expression sits directly under a return. */
function descendantIsReturned(fn: Node): boolean {
  let current: Node | undefined = fn.getParent();
  while (current !== undefined) {
    if (Node.isReturnStatement(current)) {
      return true;
    }
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current)
    ) {
      current = current.getParent();
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Import and export facts for a file: what it imports, what it
 * exports under which name, and what it re-exports from elsewhere.
 * This is the light tier; the gate query needs nothing else.
 */
export function extractModuleFacts(db: FactDb, sourceFile: SourceFile): void {
  const filePath = sourceFile.getFilePath();

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleKey = moduleKeyOf(importDecl);
    if (moduleKey === null) {
      continue;
    }
    db.add("importsModule", filePath, moduleKey);
  }

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const moduleKey = moduleKeyOf(exportDecl);
    if (moduleKey === null) {
      // `export { local }` without a specifier: handled by the full
      // tier through exported declarations.
      continue;
    }
    db.add("importsModule", filePath, moduleKey);

    if (exportDecl.isNamespaceExport()) {
      db.add("reExportsAll", filePath, moduleKey);
      continue;
    }
    for (const named of exportDecl.getNamedExports()) {
      const exportedName = named.getAliasNode()?.getText() ?? named.getName();
      db.add("reExports", filePath, exportedName, moduleKey, named.getName());
    }
  }
}

/**
 * Full facts for a file: module facts plus every exported value,
 * so resolution can start from any export.
 */
export function extractFileFacts(
  db: FactDb,
  table: NodeTable,
  sourceFile: SourceFile,
): void {
  extractModuleFacts(db, sourceFile);
  const filePath = sourceFile.getFilePath();

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const declaration of declarations) {
      if (isFunctionNode(declaration)) {
        const id = nodeId(declaration);
        table.byId.set(id, declaration);
        db.add("func", id);
        emitFunctionFacts(db, table, declaration);
        db.add("exportsAs", filePath, name, id);
        continue;
      }

      if (Node.isVariableDeclaration(declaration)) {
        const declarationId = nodeId(declaration);
        table.byId.set(declarationId, declaration);
        db.add("exportsAs", filePath, name, declarationId);
        const initializer = declaration.getInitializer();
        if (initializer !== undefined) {
          db.add("binds", declarationId, emitValue(db, table, initializer));
        }
        continue;
      }

      if (Node.isExpression(declaration)) {
        // `export default <expression>`.
        db.add("exportsAs", filePath, name, emitValue(db, table, declaration));
      }
    }
  }
}
