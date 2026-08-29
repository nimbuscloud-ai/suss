// extract.ts - turn one source file into facts.
//
// No resolution happens here. This pass records what the file
// syntactically contains: functions, what variables are declared as,
// what is imported and exported, which calls wrap which arguments.
// The resolution store has the rules that connect them.
//
// Node identity is `absolutePath:start-end`. Start alone collides a
// call with its callee. The extractor fills a side table from id back
// to ts-morph Node, so a resolved value comes back as a Node the rest
// of the adapter can use.

import {
  type BindingElement,
  type Expression,
  ModuleDeclarationKind,
  Node,
  type ObjectBindingPattern,
  type SourceFile,
  SyntaxKind,
  type Symbol as TsSymbol,
  ts,
} from "ts-morph";

import { NAMESPACE_IMPORT_NAME } from "@suss/resolution";

import {
  declarationCarryingTheBody,
  isFunctionRoot,
} from "../discovery/shared.js";
import { resolveAliasedSymbol } from "../moduleExports.js";
import {
  isWrittenAgain,
  writesToBinding,
  writesToField,
} from "./assignments.js";

import type { Database } from "@suss/datalog";
import type {
  BinaryExpression,
  ClassDeclaration,
  ParameterDeclaration,
  PropertyDeclaration,
  VariableDeclaration,
} from "ts-morph";

/** Arity sugar over `Database.add`, which takes a tuple array. */
function fact(db: Database, relation: string, ...tuple: string[]): void {
  db.add(relation, tuple);
}

export interface NodeTable {
  byId: Map<string, Node>;
  /** Functions whose facts are already emitted, per store. */
  seenFunctions: Set<Node>;
  /** Binding elements whose facts are already emitted, per store. */
  seenBindings: Set<Node>;
  /** Expressions whose facts are already emitted, per store. */
  seenValues: Set<Node>;
  /** Classes whose facts are already emitted, per store. */
  seenClasses: Set<Node>;
}

export function createNodeTable(): NodeTable {
  return {
    byId: new Map(),
    seenFunctions: new Set(),
    seenBindings: new Set(),
    seenValues: new Set(),
    seenClasses: new Set(),
  };
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
 * is correct: a package has no facts, and reaching a package key is
 * what the gate query is looking for.
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

  const specifier = declaration.getModuleSpecifierValue();
  if (specifier === undefined) {
    return null;
  }
  // ts-morph only sees files already in the project, but the compiler
  // can resolve a dependency's declaration file that nothing loaded
  // yet, and the export-table frontier adds it by this path.
  return compilerResolvedPathOf(declaration, specifier) ?? specifier;
}

function compilerResolvedPathOf(
  declaration: Node,
  specifier: string,
): string | null {
  const project = declaration.getProject();
  const result = ts.resolveModuleName(
    specifier,
    declaration.getSourceFile().getFilePath(),
    project.getCompilerOptions(),
    project.getModuleResolutionHost(),
  );
  return result.resolvedModule?.resolvedFileName ?? null;
}

/**
 * Every module name a callee's package goes by, or an empty list when
 * it was not imported. `Sentry.wrapHandler` reports the package behind
 * `Sentry`.
 *
 * A pack that declares a wrapper transparent says which library it comes
 * from, and this is what checks that claim. Matching the import
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
    // A relative specifier points at a file rather than a package, so only the
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
  // else the barrel re-exports out of the result.
  const named = Node.isPropertyAccessExpression(callee)
    ? callee.getNameNode().getSymbol()
    : undefined;
  for (const candidate of [named ?? symbol, symbol]) {
    const aliased = resolveAliasedSymbol(candidate) ?? candidate;
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

/**
 * One import, recorded under every key a question can ask by: the
 * resolved file path (what `moduleExport` joins on) and, when the
 * specifier is a package rather than a relative path, the specifier as
 * written (what origin matching asks with). A workspace dependency
 * resolves through a symlink to a path with no node_modules in it, so
 * the resolved key alone cannot say which package it was.
 */
function emitImportFacts(
  db: Database,
  referenceId: string,
  declarationId: string,
  importDecl: Node & {
    getModuleSpecifierSourceFile(): SourceFile | undefined;
    getModuleSpecifierValue(): string | undefined;
  },
  name: string,
): void {
  const moduleKey = moduleKeyOf(importDecl);
  if (moduleKey === null) {
    return;
  }
  fact(db, "binds", referenceId, declarationId);
  fact(db, "imports", declarationId, moduleKey, name);

  const specifier = importDecl.getModuleSpecifierValue();
  if (
    specifier !== undefined &&
    specifier !== moduleKey &&
    !specifier.startsWith(".")
  ) {
    fact(db, "imports", declarationId, specifier, name);
  }
}

/** The name the source module exports this import-shaped declaration under. */
function importedNameOf(declaration: Node): string {
  if (Node.isImportSpecifier(declaration)) {
    return declaration.getName();
  }

  if (Node.isNamespaceImport(declaration)) {
    return NAMESPACE_IMPORT_NAME;
  }

  return "default";
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
 * `@types/foo` is how `foo` describes itself, and a pack refers to the
 * package people import, so both have to be listed.
 */
export function packagesDeclaring(filePath: string): string[] {
  const marker = "/node_modules/";
  const at = filePath.lastIndexOf(marker);
  if (at === -1) {
    return [];
  }
  const rest = filePath.slice(at + marker.length);
  // TypeScript ships its own lib files, which declare every global
  // there is, and a call to one of those says nothing about anybody's
  // dependency. The compiler API is in that same directory, so match on
  // the lib files rather than on the directory they are in.
  if (rest.startsWith("typescript/lib/lib.") && rest.endsWith(".d.ts")) {
    return [];
  }
  const owner = packagePartOf(rest);
  return [owner, ...packagesDescribedByTypes(owner)];
}

/**
 * "@types/foo" describes "foo", and "@types/scope__name" describes
 * "@scope/name". A double underscore is how a scope is spelled here and
 * also a legal character in a plain name, so both spellings are listed
 * and whichever a pack asked for will match.
 */
function packagesDescribedByTypes(owner: string): string[] {
  if (!owner.startsWith("@types/")) {
    return [];
  }
  const name = owner.slice("@types/".length);
  const scoped = name.split("__");
  return scoped.length === 2 ? [name, `@${scoped[0]}/${scoped[1]}`] : [name];
}

/**
 * The node a value's facts are keyed under. `emitValue` records the
 * value inside the wrappers, so anything asking the rules about
 * `local as H` has to ask about `local`, or it looks up an id nothing
 * ever emitted a fact for.
 */
export function factKeyOf(value: Node): Node {
  return Node.isExpression(value) ? unwrapExpression(value) : value;
}

/** The name an index expression states, when it states one at all. */
function literalIndexOf(index: Expression | undefined): string | null {
  if (index === undefined) {
    return null;
  }
  if (Node.isNumericLiteral(index)) {
    return String(index.getLiteralValue());
  }
  if (
    Node.isStringLiteral(index) ||
    Node.isNoSubstitutionTemplateLiteral(index)
  ) {
    return index.getLiteralValue();
  }
  return null;
}

/** `a || b` or `a ?? b`: an expression that is one of its branches. */
function asFallbackExpression(expression: Expression): BinaryExpression | null {
  if (!Node.isBinaryExpression(expression)) {
    return null;
  }
  const operator = expression.getOperatorToken().getKind();
  return operator === SyntaxKind.BarBarToken ||
    operator === SyntaxKind.QuestionQuestionToken
    ? expression
    : null;
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
 *
 * Exported for the store: file extraction only reaches values that
 * hang off exports, so a query rooted anywhere else (a registration
 * call's argument, say) seeds its own value through this.
 */
export function emitValue(
  db: Database,
  table: NodeTable,
  value: Expression,
): string {
  const expression = unwrapExpression(value);
  const id = nodeId(expression);
  table.byId.set(id, expression);

  // A value can contain itself: `const routes = [{ handler: routes }]`
  // goes array to object to the name and back to the array. The facts
  // for this expression are already being written, so the name refers
  // back to it and no further, which is what the code says. Nothing
  // resolves through such a name, and the caller is told so.
  if (table.seenValues.has(expression)) {
    return id;
  }
  table.seenValues.add(expression);

  if (isFunctionRoot(expression)) {
    fact(db, "func", id);
    emitFunctionFacts(db, table, expression);
    return id;
  }

  if (Node.isPropertyAccessExpression(expression)) {
    // Both readings are emitted and whichever finds facts wins. The
    // symbol route works when the property resolves to a declaration,
    // and the structural route works when the object is a literal with a
    // value under that property.
    fact(
      db,
      "readsProperty",
      id,
      emitValue(db, table, expression.getExpression()),
      expression.getName(),
    );
    emitReferenceFacts(db, table, expression);
    return id;
  }

  if (Node.isIdentifier(expression)) {
    emitReferenceFacts(db, table, expression);
    return id;
  }

  if (Node.isElementAccessExpression(expression)) {
    // `routes[0]` and `routes["list"]` say the same thing as
    // `routes.list`: the value the container has under a name. A
    // computed index gives the rules nothing to join on, so it is left
    // as an expression that refers no further.
    const index = literalIndexOf(expression.getArgumentExpression());
    if (index !== null) {
      fact(
        db,
        "readsProperty",
        id,
        emitValue(db, table, expression.getExpression()),
        index,
      );
      return id;
    }
    fact(db, "writtenValue", id);
    return id;
  }

  if (Node.isArrayLiteralExpression(expression)) {
    // An array has its elements under their positions, which is what
    // lets the property rule cover `routes[0]` unchanged.
    fact(db, "objectValue", id);
    const elements = expression.getElements();
    for (let position = 0; position < elements.length; position++) {
      const element = elements[position];
      if (element === undefined) {
        continue;
      }
      fact(
        db,
        "holdsProperty",
        id,
        String(position),
        emitValue(db, table, element),
      );
    }
    return id;
  }

  if (Node.isObjectLiteralExpression(expression)) {
    fact(db, "objectValue", id);
    for (const property of expression.getProperties()) {
      if (Node.isPropertyAssignment(property)) {
        const held = property.getInitializer();
        if (held !== undefined) {
          fact(
            db,
            "holdsProperty",
            id,
            property.getName(),
            emitValue(db, table, held),
          );
        }
      } else if (Node.isShorthandPropertyAssignment(property)) {
        // `{ handler }` is whatever the name refers to.
        fact(
          db,
          "holdsProperty",
          id,
          property.getName(),
          emitValue(db, table, property.getNameNode()),
        );
      } else if (Node.isMethodDeclaration(property)) {
        const methodId = nodeId(property);
        table.byId.set(methodId, property);
        fact(db, "func", methodId);
        emitFunctionFacts(db, table, property);
        fact(db, "holdsProperty", id, property.getName(), methodId);
      }
    }
    return id;
  }

  // `a || b` and `a ?? b` say the value is one of the branches, so each
  // branch is written down and the rules take whichever one resolves.
  const fallback = asFallbackExpression(expression);
  if (fallback !== null) {
    fact(db, "fallbackBranch", id, emitValue(db, table, fallback.getLeft()));
    fact(db, "fallbackBranch", id, emitValue(db, table, fallback.getRight()));
    return id;
  }

  // Making one of a class is calling it: the rules read `Foo()` as
  // arriving at an instance, and `new Foo(dao)` puts its argument in
  // the constructor's parameter the way any call does.
  if (Node.isCallExpression(expression) || Node.isNewExpression(expression)) {
    emitCallFacts(db, table, expression);
    fact(db, "writtenValue", id);
    return id;
  }

  // Everything left is written out here and refers to nothing further:
  // a template literal, a tag call's result, a ternary. A name for one
  // of these ends its chain here, and the caller decides whether what
  // it found is the thing it was looking for.
  fact(db, "writtenValue", id);
  return id;
}

/**
 * What a declaration's name comes down to. A name written once is its
 * initializer, and `binds` says so. A name written again is whatever
 * the last write left there, and saying `binds` about the initializer
 * would give every reader the value the name had before the module
 * finished.
 *
 * Which write that is comes from `writesToBinding`, which only decides
 * where control flow cannot change it. Where it cannot decide, nothing
 * is written down and a reader asking about the name gets nothing.
 */
function emitBindingValues(
  db: Database,
  table: NodeTable,
  declaration: VariableDeclaration,
): void {
  const declarationId = nodeId(declaration);

  if (!isWrittenAgain(declaration)) {
    const initializer = declaration.getInitializer();
    if (initializer !== undefined) {
      fact(db, "binds", declarationId, emitValue(db, table, initializer));
    }
    return;
  }

  const { values, inOrder } = writesToBinding(declaration);
  const last = values[values.length - 1];
  if (!inOrder || last === undefined) {
    reassignedUnstated.add(declarationId);
    return;
  }
  fact(db, "endsHolding", declarationId, emitValue(db, table, last));
}

const reassignedUnstated = new Set<string>();

/**
 * How many reassigned names this run stated nothing for, because
 * control flow decides which write a reader sees. The number says
 * whether scoped reaching definitions is worth writing; the design's
 * order ends on measuring it.
 */
export function reassignedNamesUnstated(): number {
  return reassignedUnstated.size;
}

export function forgetReassignedNamesUnstated(): void {
  reassignedUnstated.clear();
}

/**
 * What a class field comes down to. `writesToField` says whether the
 * field takes one value every reader sees, which is the case a
 * constructor assignment makes, and a field it cannot settle is
 * written down as nothing rather than as its first value.
 */
function emitFieldValues(
  db: Database,
  table: NodeTable,
  declaration: PropertyDeclaration,
): void {
  const { values, inOrder } = writesToField(declaration);
  const last = values[values.length - 1];
  if (!inOrder || last === undefined || !Node.isExpression(last)) {
    return;
  }
  fact(db, "binds", nodeId(declaration), emitValue(db, table, last));
}

/**
 * What reading `this.dao` off a parameter property comes down to. The
 * field and the parameter are one declaration, so the read binds to
 * what the field ends up holding, which is the parameter itself unless
 * the constructor writes over it.
 */
function emitParameterPropertyRead(
  db: Database,
  table: NodeTable,
  referenceId: string,
  declaration: ParameterDeclaration,
): void {
  const { values, inOrder } = writesToField(declaration);
  const last = values[values.length - 1];
  if (!inOrder || last === undefined) {
    return;
  }
  if (!Node.isExpression(last)) {
    table.byId.set(nodeId(last), last);
    fact(db, "binds", referenceId, nodeId(last));
    return;
  }
  fact(db, "binds", referenceId, emitValue(db, table, last));
}

/**
 * What a name taken off a container by destructuring comes down to.
 *
 * `const { handler } = holder` reads a property off a container, which
 * is what `holder.handler` says, so it is written down the same way and
 * the property rule covers both unchanged.
 *
 * A default (`const { handler = fallback } = holder`) is a second value
 * the name could be, and the code says nothing about which one it will
 * be, so both are written down. When the container does have the
 * property and it is a different function, two candidates reach the
 * name and the store returns neither, which is correct.
 *
 * Only an object pattern is written down. An array pattern binds by
 * position, and no recognizer asks about one yet.
 */
function emitBindingElementFacts(
  db: Database,
  table: NodeTable,
  element: BindingElement,
): string {
  const id = nodeId(element);
  table.byId.set(id, element);
  // One pattern is read from every name it binds, and the container
  // behind it would be walked whole each time it is asked about.
  if (table.seenBindings.has(element)) {
    return id;
  }
  table.seenBindings.add(element);

  const pattern = element.getParent();
  const container = Node.isObjectBindingPattern(pattern)
    ? containerOfBindingPattern(pattern)
    : undefined;
  if (container !== undefined) {
    const property = element.getPropertyNameNode() ?? element.getNameNode();
    fact(
      db,
      "readsProperty",
      id,
      emitValue(db, table, container),
      property.getText(),
    );
  }

  const fallback = element.getInitializer();
  if (fallback !== undefined) {
    fact(db, "binds", id, emitValue(db, table, fallback));
  }
  return id;
}

/** The expression an object pattern takes its properties apart from. */
function containerOfBindingPattern(
  pattern: ObjectBindingPattern,
): Expression | undefined {
  const declaration = pattern.getParent();
  return Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : undefined;
}

/**
 * What a name refers to. `{ Panel }` writes one identifier where two
 * things meet: the property on the object, and the local the value
 * comes from. Asking the name for its symbol gives the property, and
 * following that arrives back where it started, so for a shorthand ask
 * for the local instead.
 */
function referencedSymbol(nameNode: Node): TsSymbol | undefined {
  const parent = nameNode.getParent();
  if (
    parent !== undefined &&
    Node.isShorthandPropertyAssignment(parent) &&
    parent.getNameNode() === nameNode
  ) {
    return parent.getValueSymbol();
  }
  return nameNode.getSymbol();
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

  const symbol = referencedSymbol(nameNode);
  if (symbol === undefined) {
    return;
  }

  for (const spelling of symbol.getDeclarations()) {
    const declaration = declarationCarryingTheBody(spelling);
    const declarationId = nodeId(declaration);
    table.byId.set(declarationId, declaration);

    if (Node.isImportSpecifier(declaration)) {
      const importDecl = declaration.getImportDeclaration();
      emitImportFacts(
        db,
        referenceId,
        declarationId,
        importDecl,
        declaration.getName(),
      );
      continue;
    }

    if (Node.isImportClause(declaration)) {
      // Default import: `import handler from "./mod"`.
      const importDecl = declaration.getParentIfKind(
        SyntaxKind.ImportDeclaration,
      );
      if (importDecl !== undefined) {
        emitImportFacts(db, referenceId, declarationId, importDecl, "default");
      }
      continue;
    }

    if (Node.isNamespaceImport(declaration)) {
      // `import * as ns`: recorded under "*", so a member read off the
      // namespace resolves to the module's export of that name.
      const importDecl = declaration.getFirstAncestorByKind(
        SyntaxKind.ImportDeclaration,
      );
      if (importDecl !== undefined) {
        emitImportFacts(
          db,
          referenceId,
          declarationId,
          importDecl,
          NAMESPACE_IMPORT_NAME,
        );
      }
      continue;
    }

    if (Node.isVariableDeclaration(declaration)) {
      fact(db, "binds", referenceId, declarationId);
      emitBindingValues(db, table, declaration);
      continue;
    }

    if (Node.isPropertyDeclaration(declaration)) {
      fact(db, "binds", referenceId, declarationId);
      emitFieldValues(db, table, declaration);
      continue;
    }

    if (Node.isParameterDeclaration(declaration)) {
      // `this.dao` where dao is a parameter property reads the field,
      // which the constructor can write again; a bare `dao` reads the
      // parameter, which nothing else can.
      if (
        declaration.isParameterProperty() &&
        Node.isPropertyAccessExpression(reference)
      ) {
        emitParameterPropertyRead(db, table, referenceId, declaration);
      } else {
        fact(db, "binds", referenceId, declarationId);
      }
      continue;
    }

    if (Node.isClassDeclaration(declaration)) {
      fact(db, "binds", referenceId, declarationId);
      emitClassFacts(db, table, declaration);
      continue;
    }

    if (Node.isBindingElement(declaration)) {
      fact(db, "binds", referenceId, declarationId);
      emitBindingElementFacts(db, table, declaration);
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
 * A class is an object containing its methods, which is the treatment an
 * object literal already gets. That is what lets a method read off an
 * instance resolve to the method the class declares.
 *
 * Its parameters are its constructor's, so `new Service(dao)` puts the
 * argument in the parameter the same way a call puts one in a
 * function's, and a field the constructor was handed reaches it.
 */
function emitClassFacts(
  db: Database,
  table: NodeTable,
  declaration: ClassDeclaration,
): void {
  if (table.seenClasses.has(declaration)) {
    return;
  }
  table.seenClasses.add(declaration);

  const id = nodeId(declaration);
  table.byId.set(id, declaration);
  fact(db, "objectValue", id);

  emitConstructorParameters(db, table, declaration, id);

  for (const method of declaration.getMethods()) {
    const methodId = nodeId(method);
    table.byId.set(methodId, method);
    fact(db, "func", methodId);
    emitFunctionFacts(db, table, method);
    fact(db, "holdsProperty", id, method.getName(), methodId);
  }

  for (const property of declaration.getProperties()) {
    const initializer = property.getInitializer();
    if (initializer !== undefined) {
      fact(
        db,
        "holdsProperty",
        id,
        property.getName(),
        emitValue(db, table, initializer),
      );
    }
  }
}

/**
 * The parameters a construction fills in. A class written with no
 * constructor has none, and an overload signature has no body, so the
 * parameters the arguments land in are the implementation's.
 */
function emitConstructorParameters(
  db: Database,
  table: NodeTable,
  declaration: ClassDeclaration,
  classId: string,
): void {
  const implementation = declaration
    .getConstructors()
    .find((candidate) => candidate.getBody() !== undefined);
  if (implementation === undefined) {
    return;
  }
  emitParameters(db, table, classId, implementation.getParameters());
}

/** paramOf and paramNamed for everything a call fills in. */
function emitParameters(
  db: Database,
  table: NodeTable,
  ownerId: string,
  parameters: ParameterDeclaration[],
): void {
  for (let position = 0; position < parameters.length; position++) {
    const parameter = parameters[position];
    if (parameter === undefined) {
      continue;
    }
    const parameterId = nodeId(parameter);
    table.byId.set(parameterId, parameter);
    fact(db, "paramOf", ownerId, String(position), parameterId);
    fact(db, "paramNamed", ownerId, parameter.getName(), parameterId);
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
    emitParameters(db, table, fnId, fn.getParameters());

    const body = fn.getBody?.();
    if (body !== undefined) {
      // An arrow written without braces returns its body, and the body
      // is a node the descendant walk never visits, so drive the same
      // handling from it first. Writing that case out separately is
      // what hid `containsFn` for a function nested in a shorthand
      // body, which is how a factory delegating to another factory
      // resolved to nothing.
      if (Node.isExpression(body)) {
        fact(db, "returnsValue", fnId, emitValue(db, table, body));
        recordBodyNode(db, table, fnId, body);
      }
      body.forEachDescendant((descendant, traversal) => {
        if (recordBodyNode(db, table, fnId, descendant)) {
          traversal.skip();
        }
      });
    }
  }
}

/**
 * What one node inside a function body says about that function.
 * Returns whether the walk should stop descending, which it does at a
 * nested function: that function is walked in its own right, and
 * `containsFn` is what brings its calls back up.
 *
 * A closure declared here runs as part of this function, so a wrapper
 * delegating to its parameter inside one still delegates.
 */
function recordBodyNode(
  db: Database,
  table: NodeTable,
  fnId: string,
  node: Node,
): boolean {
  if (isFunctionRoot(node)) {
    if (descendantIsReturned(node)) {
      fact(db, "returnsValue", fnId, emitValue(db, table, node as Expression));
    } else {
      emitValue(db, table, node as Expression);
    }
    fact(db, "containsFn", fnId, nodeId(node));
    return true;
  }

  if (Node.isReturnStatement(node)) {
    const returned = node.getExpression();
    if (returned !== undefined) {
      fact(db, "returnsValue", fnId, emitValue(db, table, returned));
    }
    return false;
  }

  if (!Node.isExpression(node)) {
    return false;
  }
  const call = unwrapExpression(node);
  if (Node.isCallExpression(call)) {
    const callee = unwrapExpression(call.getExpression());
    // A name or a property read: `body(e)` and `opts.body(e)` both say
    // this function runs its argument, and the property rule needs the
    // second to see which property it was.
    if (Node.isIdentifier(callee) || Node.isPropertyAccessExpression(callee)) {
      fact(db, "bodyCalls", fnId, emitValue(db, table, callee));
    }
  }
  return false;
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

  for (const [name, spelling] of directExportsOf(sourceFile)) {
    emitExportedValue(db, table, filePath, name, spelling);
  }

  emitLocalExportLists(db, table, sourceFile, filePath);
}

/**
 * The exports this file states in its own syntax, with no chain
 * following: the `moduleExport` rules flatten re-exports, so the
 * emitter's whole job is one file's own statements.
 */
function directExportsOf(sourceFile: SourceFile): Array<[string, Node]> {
  const found: Array<[string, Node]> = [];
  collectDirectExports(sourceFile.getStatements(), found);
  return found;
}

function collectDirectExports(
  statements: Node[],
  found: Array<[string, Node]>,
): void {
  for (const statement of statements) {
    // A `declare module "name"` block wraps a package's whole surface,
    // so its exported statements are the file's exports.
    if (
      Node.isModuleDeclaration(statement) &&
      statement.getDeclarationKind() === ModuleDeclarationKind.Module &&
      statement.getBody() !== undefined
    ) {
      collectDirectExports(statement.getStatements(), found);
      continue;
    }

    if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement)
    ) {
      if (!statement.hasExportKeyword()) {
        continue;
      }
      if (statement.hasDefaultKeyword()) {
        found.push(["default", statement]);
        continue;
      }
      const name = statement.getName();
      if (name !== undefined && name.length > 0) {
        found.push([name, statement]);
      }
      continue;
    }

    if (Node.isVariableStatement(statement) && statement.hasExportKeyword()) {
      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          found.push([declaration.getName(), declaration]);
          continue;
        }
        for (const element of nameNode.getDescendantsOfKind(
          SyntaxKind.BindingElement,
        )) {
          const bound = element.getNameNode();
          if (Node.isIdentifier(bound)) {
            found.push([bound.getText(), element]);
          }
        }
      }
      continue;
    }

    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      const expression = statement.getExpression();
      // A bare name goes through the local-declaration path with the
      // export lists; anything else is the exported value itself.
      if (!Node.isIdentifier(expression)) {
        found.push(["default", expression]);
      }
    }
  }
}

/**
 * `export { a, b as c }` with no module specifier: each name points at
 * a declaration in this file, or at an import, which makes the export
 * a re-export the rules flatten.
 */
function emitLocalExportLists(
  db: Database,
  table: NodeTable,
  sourceFile: SourceFile,
  filePath: string,
): void {
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    if (exportDecl.getModuleSpecifier() !== undefined) {
      continue;
    }
    for (const named of exportDecl.getNamedExports()) {
      const alias = named.getAliasNode()?.getText() ?? named.getName();
      for (const declaration of named.getLocalTargetDeclarations()) {
        emitExportedDeclaration(db, table, filePath, alias, declaration);
      }
    }
  }

  // `export default x` takes the value x has where the statement
  // runs, not the live binding an export list gives, so a reassigned
  // name is left unstated; the README beside this file says why.
  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) {
      continue;
    }
    const expression = assignment.getExpression();
    if (!Node.isIdentifier(expression)) {
      continue;
    }
    const declarations = expression.getSymbol()?.getDeclarations() ?? [];
    for (const declaration of declarations) {
      if (Node.isVariableDeclaration(declaration)) {
        if (!isWrittenAgain(declaration)) {
          emitExportedDeclaration(db, table, filePath, "default", declaration);
        }

        continue;
      }
      emitExportedDeclaration(db, table, filePath, "default", declaration);
    }
  }
}

/**
 * An exported name backed by an import becomes a `reExports` fact for
 * the rules to flatten; one backed by a local declaration is stated as
 * the exported value.
 */
function emitExportedDeclaration(
  db: Database,
  table: NodeTable,
  filePath: string,
  alias: string,
  declaration: Node,
): void {
  const specifier = importSpecifierOf(declaration);
  if (specifier !== null) {
    const importDecl = declaration.getFirstAncestorByKind(
      SyntaxKind.ImportDeclaration,
    );
    const moduleKey = importDecl === undefined ? null : moduleKeyOf(importDecl);
    if (moduleKey !== null) {
      fact(
        db,
        "reExports",
        filePath,
        alias,
        moduleKey,
        importedNameOf(declaration),
      );
    }

    return;
  }

  emitExportedValue(db, table, filePath, alias, declaration);
}

function emitExportedValue(
  db: Database,
  table: NodeTable,
  filePath: string,
  name: string,
  spelling: Node,
): void {
  const declaration = declarationCarryingTheBody(spelling);
  if (isFunctionRoot(declaration)) {
    const id = nodeId(declaration);
    table.byId.set(id, declaration);
    fact(db, "func", id);
    emitFunctionFacts(db, table, declaration);
    fact(db, "exportsAs", filePath, name, id);
    return;
  }

  if (Node.isClassDeclaration(declaration)) {
    emitClassFacts(db, table, declaration);
    fact(db, "exportsAs", filePath, name, nodeId(declaration));
    return;
  }

  if (Node.isVariableDeclaration(declaration)) {
    const declarationId = nodeId(declaration);
    table.byId.set(declarationId, declaration);
    fact(db, "exportsAs", filePath, name, declarationId);
    emitBindingValues(db, table, declaration);
    return;
  }

  if (Node.isBindingElement(declaration)) {
    fact(
      db,
      "exportsAs",
      filePath,
      name,
      emitBindingElementFacts(db, table, declaration),
    );
    return;
  }

  if (Node.isExpression(declaration)) {
    // `export default <expression>`.
    fact(db, "exportsAs", filePath, name, emitValue(db, table, declaration));
  }
}
