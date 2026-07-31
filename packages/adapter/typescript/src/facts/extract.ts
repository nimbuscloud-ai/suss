// extract.ts - turn one source file into facts.
//
// No resolution happens here. This pass records what the file
// syntactically contains: functions, what variables are declared as,
// what is imported and exported, which calls wrap which arguments.
// The resolution store holds the rules that connect them.
//
// Node identity is `absolutePath:start-end`. Start alone collides a
// call with its callee. The extractor fills a side table from id back
// to ts-morph Node so a resolved answer comes back as a Node the rest
// of the adapter can use.

import { type Expression, Node, type SourceFile, SyntaxKind } from "ts-morph";

import { isFunctionRoot } from "../discovery/shared.js";

import type { Database } from "@suss/datalog";

/** Arity sugar over `Database.add`, which takes a tuple array. */
function fact(db: Database, relation: string, ...tuple: string[]): void {
  db.add(relation, tuple);
}

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

/**
 * Every module name a callee's package answers to, or an empty list
 * when it was not imported. `Sentry.wrapHandler` reports the package
 * behind `Sentry`.
 *
 * A pack that declares a wrapper transparent names the library it comes
 * from, and this is what checks the claim. Matching the import
 * specifier verbatim is not enough: the same package arrives as a
 * subpath (`pkg/esm`), through a barrel in the project that re-exports
 * it, or through `import x = require(...)`. So the specifier, the
 * package part of it, and the package the symbol turns out to live in
 * all count.
 */
function importOriginsOf(callee: Node): string[] {
  let root: Node = callee;
  while (Node.isPropertyAccessExpression(root)) {
    root = root.getExpression();
  }
  if (!Node.isIdentifier(root)) {
    return [];
  }
  const symbol = root.getSymbol();
  if (symbol === undefined) {
    return [];
  }

  const origins = new Set<string>();
  for (const declaration of symbol.getDeclarations()) {
    const specifier = importSpecifierOf(declaration);
    // A relative specifier names a file, not a package, so only the
    // package the callee turns out to live in can speak for it.
    if (specifier !== null && !specifier.startsWith(".")) {
      origins.add(specifier);
      origins.add(packagePartOf(specifier));
    }
  }

  // Where the callee turns out to live, which is what a barrel or a
  // subpath hides. For `Sentry.wrapHandler` the question is about
  // wrapHandler, not about Sentry: a namespace import of a barrel
  // resolves to the barrel, while the member resolves into the package
  // that declared it. Asking about the member is what keeps everything
  // else the barrel re-exports out of the answer.
  const named = Node.isPropertyAccessExpression(callee)
    ? callee.getNameNode().getSymbol()
    : undefined;
  for (const candidate of [named ?? symbol, symbol]) {
    const aliased = candidate.getAliasedSymbol() ?? candidate;
    for (const declaration of aliased.getDeclarations()) {
      if (!declaresAValue(declaration)) {
        continue;
      }
      for (const owner of packagesDeclaring(
        declaration.getSourceFile().getFilePath(),
      )) {
        origins.add(owner);
      }
    }
  }
  return [...origins];
}

/** The module specifier an import-shaped declaration names. */
function importSpecifierOf(declaration: Node): string | null {
  if (Node.isImportSpecifier(declaration)) {
    return declaration.getImportDeclaration().getModuleSpecifierValue();
  }
  if (Node.isImportEqualsDeclaration(declaration)) {
    const reference = declaration.getModuleReference();
    return Node.isExternalModuleReference(reference)
      ? (reference.getExpression()?.getText().slice(1, -1) ?? null)
      : null;
  }
  const owner = Node.isNamespaceImport(declaration)
    ? declaration.getParent()
    : declaration;
  if (Node.isImportClause(owner)) {
    const importDecl = owner.getParent();
    if (Node.isImportDeclaration(importDecl)) {
      return importDecl.getModuleSpecifierValue();
    }
  }
  return null;
}

/** "@scope/pkg/sub" and "pkg/sub" both name their package. */
function packagePartOf(specifier: string): string {
  const parts = specifier.split("/");
  const take = specifier.startsWith("@") ? 2 : 1;
  return parts.slice(0, take).join("/");
}

/**
 * A member reached through a type annotation is not evidence of where
 * the value came from. An object written locally and annotated with a
 * library's interface resolves its members to that interface, and
 * taking those at face value hands a local function the library's name.
 * So only a declaration that introduces a value counts.
 */
function declaresAValue(declaration: Node): boolean {
  return (
    !Node.isPropertySignature(declaration) &&
    !Node.isMethodSignature(declaration)
  );
}

/**
 * The packages a file inside node_modules speaks for. Usually one.
 * Types published separately are the exception: a declaration in
 * `@types/foo` is how `foo` describes itself, and a pack names the
 * package people import, so both answer.
 */
function packagesDeclaring(filePath: string): string[] {
  const marker = "/node_modules/";
  const at = filePath.lastIndexOf(marker);
  if (at === -1) {
    return [];
  }
  const rest = filePath.slice(at + marker.length);
  // TypeScript's own lib files declare every global there is, and a
  // call to one of those says nothing about anybody's dependency.
  if (rest.startsWith("typescript/lib/")) {
    return [];
  }
  const owner = packagePartOf(rest);
  const described = packageDescribedByTypes(owner);
  return described === null ? [owner] : [owner, described];
}

/** "@types/foo" describes "foo"; "@types/scope__name" describes "@scope/name". */
function packageDescribedByTypes(owner: string): string | null {
  if (!owner.startsWith("@types/")) {
    return null;
  }
  const name = owner.slice("@types/".length);
  const scoped = name.split("__");
  return scoped.length === 2 ? `@${scoped[0]}/${scoped[1]}` : name;
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

/**
 * Record that `value` is a value of interest and emit the facts that
 * let the rules resolve it: its own identity, and a binds edge when it
 * is an identifier or property access referencing a declaration.
 */
function emitValue(db: Database, table: NodeTable, value: Expression): string {
  const expression = unwrapExpression(value);
  const id = nodeId(expression);
  table.byId.set(id, expression);

  if (isFunctionRoot(expression)) {
    fact(db, "func", id);
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
  db: Database,
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
        fact(db, "binds", referenceId, declarationId);
        fact(db, "imports", declarationId, moduleKey, declaration.getName());
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
          fact(db, "binds", referenceId, declarationId);
          fact(db, "imports", declarationId, moduleKey, "default");
        }
      }
      continue;
    }

    if (Node.isVariableDeclaration(declaration)) {
      fact(db, "binds", referenceId, declarationId);
      const initializer = declaration.getInitializer();
      if (initializer !== undefined) {
        fact(db, "binds", declarationId, emitValue(db, table, initializer));
      }
      continue;
    }

    if (Node.isParameterDeclaration(declaration)) {
      fact(db, "binds", referenceId, declarationId);
      continue;
    }

    if (isFunctionRoot(declaration)) {
      fact(db, "binds", referenceId, declarationId);
      fact(db, "func", declarationId);
      emitFunctionFacts(db, table, declaration);
    }
  }
}

function emitCallFacts(
  db: Database,
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
    fact(db, "bindCall", callId, emitValue(db, table, target));
    return;
  }

  fact(db, "call", callId, emitValue(db, table, callee));
  fact(db, "calleeName", callId, callee.getText());

  for (const origin of importOriginsOf(callee)) {
    fact(db, "calleeOrigin", callId, origin);
  }

  const args = call.getArguments();
  for (let position = 0; position < args.length; position++) {
    const argument = args[position] as Node;
    if (!Node.isExpression(argument)) {
      continue;
    }
    fact(
      db,
      "callArg",
      callId,
      String(position),
      emitValue(db, table, argument),
    );
  }
}

/**
 * Parameters, returned values, and body calls of a function. Body
 * calls are what the unwraps rule needs: an inner function that calls
 * a parameter of its enclosing factory.
 */
function emitFunctionFacts(db: Database, table: NodeTable, fn: Node): void {
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
      fact(db, "paramOf", fnId, String(position), parameterId);
    }

    // Arrow shorthand body is itself the returned value, and when it
    // is a call, that call is also a body call for the unwraps rule.
    if (Node.isArrowFunction(fn)) {
      const body = fn.getBody();
      if (Node.isExpression(body)) {
        fact(db, "returnsValue", fnId, emitValue(db, table, body));
        const unwrapped = unwrapExpression(body);
        if (Node.isCallExpression(unwrapped)) {
          const callee = unwrapExpression(unwrapped.getExpression());
          if (Node.isIdentifier(callee)) {
            fact(db, "bodyCalls", fnId, emitValue(db, table, callee));
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
        if (isFunctionRoot(descendant)) {
          if (descendantIsReturned(descendant)) {
            fact(
              db,
              "returnsValue",
              fnId,
              emitValue(db, table, descendant as Expression),
            );
          } else {
            emitValue(db, table, descendant as Expression);
          }
          fact(db, "containsFn", fnId, nodeId(descendant));
          traversal.skip();
          return;
        }

        if (Node.isReturnStatement(descendant)) {
          const returned = descendant.getExpression();
          if (returned !== undefined) {
            fact(db, "returnsValue", fnId, emitValue(db, table, returned));
          }
          return;
        }

        if (Node.isCallExpression(descendant)) {
          const callee = unwrapExpression(descendant.getExpression());
          if (Node.isIdentifier(callee)) {
            const calleeId = emitValue(db, table, callee);
            fact(db, "bodyCalls", fnId, calleeId);
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
export function extractModuleFacts(db: Database, sourceFile: SourceFile): void {
  const filePath = sourceFile.getFilePath();

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleKey = moduleKeyOf(importDecl);
    if (moduleKey === null) {
      continue;
    }
    fact(db, "importsModule", filePath, moduleKey);
  }

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const moduleKey = moduleKeyOf(exportDecl);
    if (moduleKey === null) {
      // `export { local }` without a specifier: handled by the full
      // tier through exported declarations.
      continue;
    }
    fact(db, "importsModule", filePath, moduleKey);

    if (exportDecl.isNamespaceExport()) {
      fact(db, "reExportsAll", filePath, moduleKey);
      continue;
    }
    for (const named of exportDecl.getNamedExports()) {
      const exportedName = named.getAliasNode()?.getText() ?? named.getName();
      fact(db, "reExports", filePath, exportedName, moduleKey, named.getName());
    }
  }
}

/**
 * Full facts for a file: module facts plus every exported value,
 * so resolution can start from any export.
 */
export function extractFileFacts(
  db: Database,
  table: NodeTable,
  sourceFile: SourceFile,
): void {
  extractModuleFacts(db, sourceFile);
  const filePath = sourceFile.getFilePath();

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const declaration of declarations) {
      if (isFunctionRoot(declaration)) {
        const id = nodeId(declaration);
        table.byId.set(id, declaration);
        fact(db, "func", id);
        emitFunctionFacts(db, table, declaration);
        fact(db, "exportsAs", filePath, name, id);
        continue;
      }

      if (Node.isVariableDeclaration(declaration)) {
        const declarationId = nodeId(declaration);
        table.byId.set(declarationId, declaration);
        fact(db, "exportsAs", filePath, name, declarationId);
        const initializer = declaration.getInitializer();
        if (initializer !== undefined) {
          fact(db, "binds", declarationId, emitValue(db, table, initializer));
        }
        continue;
      }

      if (Node.isExpression(declaration)) {
        // `export default <expression>`.
        fact(
          db,
          "exportsAs",
          filePath,
          name,
          emitValue(db, table, declaration),
        );
      }
    }
  }
}
