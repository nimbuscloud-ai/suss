// discovery.ts — Code unit discovery for ts-morph SourceFiles (Task 2.4)

import fs from "node:fs";
import path from "node:path";

import {
  type DocumentNode as GraphqlDocumentNode,
  Kind as GraphqlKind,
  type OperationDefinitionNode as GraphqlOperationDefinitionNode,
  type TypeNode as GraphqlTypeNode,
  parse as graphqlParse,
  print as graphqlPrint,
} from "graphql";
import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
} from "ts-morph";

import {
  type ResolvedPackageExport,
  resolvePackageExports,
} from "./package-exports.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Public output type
// ---------------------------------------------------------------------------

export interface ClientCallSite {
  callExpression: CallExpression;
  /** Method name on the client object (e.g. "getUser"), null for bare calls like fetch() */
  methodName: string | null;
}

export interface DiscoveredUnit {
  func: FunctionRoot;
  kind: string;
  name: string;
  callSite?: ClientCallSite;
  /** The discovery pattern that produced this unit. Set by discoverUnits. */
  pattern?: DiscoveryPattern;
  /**
   * Populated by `resolverMap`-style discovery (GraphQL code-first).
   * The adapter uses it to build a `graphql-resolver` binding directly,
   * without running this through the REST-shaped bindingExtraction
   * path.
   *
   * `schemaSdl` is the typeDefs string captured from the same
   * ApolloServer config object the resolver map came from, when
   * we can statically resolve it (string literal or gql-tagged
   * template, inline or const-bound). Surfaced on the summary so
   * the checker's nested-selection pairing can look up return-type
   * fields without needing a separate schema provenance.
   */
  resolverInfo?: {
    typeName: string;
    fieldName: string;
    schemaSdl?: string;
  };
  /**
   * Populated by `graphqlHookCall` discovery (GraphQL consumer side).
   * Carries the operation shape the adapter uses to build a
   * `graphql-operation` binding. `operationName` is absent for
   * anonymous operations (`gql\`query { ... }\``, no identifier).
   *
   * `document` is the raw GraphQL document source (the inner text of
   * the gql-tagged template literal, backticks stripped). Kept
   * alongside the parsed shape so downstream tools can re-parse if
   * they need additional detail beyond what we surface here.
   *
   * `variables` list the `$name: Type` declarations at the operation
   * header. Each becomes an `Input` on the resulting summary so
   * pairing layers can match against resolver args.
   *
   * `rootFields` is the list of root-level selection names — the
   * fields the operation actually selects under Query / Mutation /
   * Subscription. Used by the checker's pairing pass.
   */
  operationInfo?: {
    operationType: "query" | "mutation" | "subscription";
    operationName?: string;
    document: string;
    variables: Array<{ name: string; type: string; required: boolean }>;
    rootFields: string[];
  };
  /**
   * Populated by `packageExports` discovery. Carries the package
   * identity the adapter uses to build a `function-call` binding
   * with `package` + `exportPath` fields — i.e. a provider summary
   * for a publicly-exported library function.
   */
  packageExportInfo?: {
    packageName: string;
    exportPath: string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract FunctionRoot from something that might be a function or wrap one. */
export function toFunctionRoot(node: Node): FunctionRoot | null {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  ) {
    return node as FunctionRoot;
  }

  return null;
}

/**
 * Name a code unit discovered via `export default`. Prefers the
 * function's own identifier (`export default function UserCard() {}`
 * → `"UserCard"`) so component / handler identity survives. Falls
 * back to `"default"` for genuinely anonymous defaults
 * (`export default () => ...` or `export default function() {}`).
 */
function resolveDefaultExportName(decl: Node, fn: FunctionRoot): string {
  // FunctionDeclaration and named FunctionExpression both expose
  // getName(); ArrowFunction does not. Prefer the explicit name when
  // present.
  if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) {
    const n = fn.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }

  // `export default UserCard` — the declaration seen by the default-
  // export symbol resolver is the VariableDeclaration or the
  // referenced function. If we landed on a named VariableDeclaration,
  // use that name.
  if (Node.isVariableDeclaration(decl)) {
    const name = decl.getName();
    if (name.length > 0) {
      return name;
    }
  }

  return "default";
}

// ---------------------------------------------------------------------------
// namedExport discovery
// ---------------------------------------------------------------------------

function discoverNamedExports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "namedExport" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const names = new Set(match.names);

  // 1. export function loader() {}
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) {
      continue;
    }
    const name = fn.getName();
    if (name === undefined) {
      continue;
    }
    if (!names.has(name)) {
      continue;
    }
    results.push({ func: fn as FunctionDeclaration, kind, name });
  }

  // 2. export const loader = () => {} / export const loader = function() {}
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (!names.has(name)) {
      continue;
    }

    // Check if the variable statement is exported
    const varStatement = varDecl.getVariableStatement();
    if (varStatement === undefined) {
      continue;
    }
    if (!varStatement.isExported()) {
      continue;
    }

    const init = varDecl.getInitializer();
    if (init === undefined) {
      continue;
    }

    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      results.push({
        func: init as ArrowFunction | FunctionExpression,
        kind,
        name,
      });
    }
  }

  // 3. export default function UserCard() {} — name "UserCard"
  //    export default function() {}          — name "default"
  //    export default UserCard               — name from the referenced binding
  //    export default () => ...              — name "default"
  //
  // Prefer the function's own name when it has one. For components
  // especially, the function name is the component identity; losing
  // it to "default" would collapse every file's default export into
  // the same name across the workspace.
  if (names.has("default")) {
    const defaultExport = sourceFile.getDefaultExportSymbol();
    if (defaultExport !== undefined) {
      const decls = defaultExport.getDeclarations();
      for (const decl of decls) {
        const fn = toFunctionRoot(decl);
        if (fn !== null) {
          const resolvedName = resolveDefaultExportName(decl, fn);
          results.push({ func: fn, kind, name: resolvedName });
        }
      }
    }
  }

  // 4. export { loader } re-export or any other form
  // Use getExportedDeclarations for names we haven't already found
  const alreadyFound = new Set(results.map((r) => r.name));
  for (const targetName of names) {
    if (alreadyFound.has(targetName)) {
      continue;
    }

    const exported = sourceFile.getExportedDeclarations().get(targetName);
    if (exported === undefined) {
      continue;
    }

    for (const decl of exported) {
      const fn = toFunctionRoot(decl);
      if (fn !== null) {
        results.push({ func: fn, kind, name: targetName });
        break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// registrationCall discovery
// ---------------------------------------------------------------------------

function discoverRegistrationCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];

  // Step 1: Find the import declaration
  let importedLocalName: string | null = null;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== match.importModule) {
      continue;
    }

    // Named import
    for (const namedImport of importDecl.getNamedImports()) {
      if (
        namedImport.getName() === match.importName ||
        namedImport.getAliasNode()?.getText() === match.importName
      ) {
        importedLocalName =
          namedImport.getAliasNode()?.getText() ?? namedImport.getName();
        break;
      }
    }

    if (importedLocalName !== null) {
      break;
    }

    // Default import
    const defaultImport = importDecl.getDefaultImport();
    if (
      defaultImport !== undefined &&
      defaultImport.getText() === match.importName
    ) {
      importedLocalName = defaultImport.getText();
      break;
    }

    // Namespace import
    const namespaceImport = importDecl.getNamespaceImport();
    if (
      namespaceImport !== undefined &&
      namespaceImport.getText() === match.importName
    ) {
      importedLocalName = namespaceImport.getText();
      break;
    }
  }

  if (importedLocalName === null) {
    return results;
  }

  // Step 2: Find what variable holds the result of calling the imported function
  // e.g. const s = initServer(); or const router = Router();
  const registrationVarNames = new Set<string>();

  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const init = varDecl.getInitializer();
    if (init === undefined) {
      continue;
    }

    // Might be: initServer() or new Router() etc.
    let calleeText: string | null = null;
    if (Node.isCallExpression(init)) {
      calleeText = init.getExpression().getText();
    } else if (Node.isNewExpression(init)) {
      calleeText = init.getExpression().getText();
    }

    if (calleeText === importedLocalName) {
      registrationVarNames.add(varDecl.getName());
    }
  }

  // Step 3: Walk all call expressions and match registration chains
  const registrationMethods = match.registrationChain.map((c) =>
    c.startsWith(".") ? c.slice(1) : c,
  );

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      return;
    }

    const methodName = callee.getName();
    if (!registrationMethods.includes(methodName)) {
      return;
    }

    // The subject of the call must resolve to our registration variable
    const subject = callee.getExpression();
    let subjectName: string | null = null;

    if (Node.isIdentifier(subject)) {
      subjectName = subject.getText();
    }

    if (subjectName === null || !registrationVarNames.has(subjectName)) {
      return;
    }

    // Step 4: Extract handlers from the call
    const args = node.getArguments();

    // ts-rest style: second arg is object literal with handler methods
    let foundObjectArg = false;
    for (const arg of args) {
      if (!Node.isObjectLiteralExpression(arg)) {
        continue;
      }

      foundObjectArg = true;
      for (const prop of arg.getProperties()) {
        // Method shorthand: { async getUser() { ... } }
        if (Node.isMethodDeclaration(prop)) {
          results.push({
            func: prop as MethodDeclaration,
            kind,
            name: prop.getName(),
          });
          continue;
        }

        if (!Node.isPropertyAssignment(prop)) {
          continue;
        }

        const propInit = prop.getInitializer();
        if (propInit === undefined) {
          continue;
        }

        if (
          Node.isArrowFunction(propInit) ||
          Node.isFunctionExpression(propInit)
        ) {
          results.push({
            func: propInit as ArrowFunction | FunctionExpression,
            kind,
            name: prop.getName(),
          });
        }
      }
    }

    if (!foundObjectArg) {
      // Express style: last arg is a function
      const lastArg = args[args.length - 1] as Node | undefined;
      if (lastArg !== undefined) {
        if (
          Node.isArrowFunction(lastArg) ||
          Node.isFunctionExpression(lastArg)
        ) {
          results.push({
            func: lastArg as ArrowFunction | FunctionExpression,
            kind,
            name: methodName,
          });
        }
      }
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// clientCall discovery
// ---------------------------------------------------------------------------

function findEnclosingFunction(node: Node): FunctionRoot | null {
  let current = node.getParent();
  while (current !== undefined) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return current as FunctionRoot;
    }
    current = current.getParent();
  }
  return null;
}

function discoverClientCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "clientCall" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const isGlobal = match.importModule === "global";

  // Step 1: Resolve the local name of the imported identifier.
  // For globals (fetch, etc.), match directly on the importName.
  let importedLocalName: string | null = isGlobal ? match.importName : null;

  if (!isGlobal) {
    for (const importDecl of sourceFile.getImportDeclarations()) {
      if (importDecl.getModuleSpecifierValue() !== match.importModule) {
        continue;
      }
      for (const namedImport of importDecl.getNamedImports()) {
        if (
          namedImport.getName() === match.importName ||
          namedImport.getAliasNode()?.getText() === match.importName
        ) {
          importedLocalName =
            namedImport.getAliasNode()?.getText() ?? namedImport.getName();
          break;
        }
      }
      if (importedLocalName !== null) {
        break;
      }
      const defaultImport = importDecl.getDefaultImport();
      if (
        defaultImport !== undefined &&
        defaultImport.getText() === match.importName
      ) {
        importedLocalName = defaultImport.getText();
        break;
      }
    }
  }

  if (importedLocalName === null) {
    return results;
  }

  // Step 2: For non-global imports, find variables holding the result of
  // calling the imported function (`const client = initClient(...)`) OR
  // calling one of its declared factory methods (`const api = axios.create(...)`).
  const clientVarNames = new Set<string>();
  const factoryCallTexts =
    match.factoryMethods !== undefined
      ? new Set(match.factoryMethods.map((m) => `${importedLocalName}.${m}`))
      : null;

  if (!isGlobal) {
    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (init === undefined || !Node.isCallExpression(init)) {
        continue;
      }
      const calleeText = init.getExpression().getText();
      if (
        calleeText === importedLocalName ||
        factoryCallTexts?.has(calleeText)
      ) {
        clientVarNames.add(varDecl.getName());
      }
    }
  }

  // Step 3: Walk all call expressions looking for matching client calls
  const methodFilter =
    match.methodFilter !== undefined ? new Set(match.methodFilter) : null;

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    let methodName: string | null = null;
    let matched = false;

    if (isGlobal && Node.isIdentifier(callee)) {
      // Bare call: fetch(...)
      if (callee.getText() === importedLocalName) {
        matched = true;
      }
    } else if (Node.isPropertyAccessExpression(callee)) {
      // Method call. Two shapes:
      //   1. client.getUser(...)        — `client` is a variable holding the
      //                                    result of calling the import (e.g.
      //                                    `const client = initClient(...)`).
      //   2. axios.get("/users")        — the import itself is the client and
      //                                    methods are called on it directly.
      const subject = callee.getExpression();
      if (
        Node.isIdentifier(subject) &&
        (clientVarNames.has(subject.getText()) ||
          subject.getText() === importedLocalName)
      ) {
        methodName = callee.getName();
        if (methodFilter === null || methodFilter.has(methodName)) {
          matched = true;
        }
      }
    }

    if (!matched) {
      return;
    }

    // Step 4: Walk up to the enclosing function
    const enclosingFunc = findEnclosingFunction(node);
    if (enclosingFunc === null) {
      return;
    }

    results.push({
      func: enclosingFunc,
      kind,
      name: clientUnitName(enclosingFunc, methodName),
      callSite: {
        callExpression: node,
        methodName,
      },
    });
  });

  return results;
}

/**
 * Pick a stable name for a clientCall-discovered unit by walking the
 * enclosing function's shape. Prefers the function's own identifier,
 * then the variable or property it's bound to, then finally the
 * method name of the call site. "anonymous" is the last-resort
 * label when no other identifier is available.
 */
function clientUnitName(
  enclosingFunc: FunctionRoot,
  methodName: string | null,
): string {
  if (Node.isFunctionDeclaration(enclosingFunc)) {
    return enclosingFunc.getName() ?? methodName ?? "anonymous";
  }
  if (Node.isMethodDeclaration(enclosingFunc)) {
    return enclosingFunc.getName();
  }
  const parent = enclosingFunc.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent !== undefined && Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return methodName ?? "anonymous";
}

// ---------------------------------------------------------------------------
// resolverMap discovery (GraphQL code-first)
// ---------------------------------------------------------------------------

/**
 * Locate local identifiers that hold the imported symbol (named,
 * default, or namespace import). Same resolution as `registrationCall`
 * / `clientCall` discovery, extracted to a small helper so the
 * resolver-map walker stays readable.
 */
function resolveImportedLocalName(
  sourceFile: SourceFile,
  importModule: string,
  importName: string,
): string | null {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== importModule) {
      continue;
    }
    for (const named of importDecl.getNamedImports()) {
      if (
        named.getName() === importName ||
        named.getAliasNode()?.getText() === importName
      ) {
        return named.getAliasNode()?.getText() ?? named.getName();
      }
    }
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport !== undefined && defaultImport.getText() === importName) {
      return defaultImport.getText();
    }
    const namespaceImport = importDecl.getNamespaceImport();
    if (
      namespaceImport !== undefined &&
      namespaceImport.getText() === importName
    ) {
      return namespaceImport.getText();
    }
  }
  return null;
}

/**
 * Peel `as const` / `satisfies` wrappers around an object literal so
 * that `const resolvers = { ... } satisfies Resolvers;` is still
 * recognizable as an object literal for the resolver-map walker.
 */
function peelToObjectLiteral(node: Node | undefined): Node | null {
  if (node === undefined) {
    return null;
  }
  if (Node.isObjectLiteralExpression(node)) {
    return node;
  }
  if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
    return peelToObjectLiteral(node.getExpression());
  }
  return null;
}

/**
 * Follow an identifier to the object literal it's initialized from.
 * Supports only the common code-first shapes:
 *   const resolvers = { Query: {...}, ... };
 *   new ApolloServer({ resolvers });            // shorthand
 *   new ApolloServer({ resolvers: { ... } });   // inline
 * Returns null for anything else (merged via library calls, spread,
 * re-exports) — v0 deliberately doesn't chase dynamically-composed
 * resolver maps.
 */
function resolveObjectLiteral(node: Node): Node | null {
  if (Node.isObjectLiteralExpression(node)) {
    return node;
  }
  if (!Node.isIdentifier(node)) {
    return null;
  }
  const symbol = node.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    if (Node.isVariableDeclaration(decl)) {
      const peeled = peelToObjectLiteral(decl.getInitializer());
      if (peeled !== null) {
        return peeled;
      }
    }
  }
  return null;
}

function discoverResolverMaps(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "resolverMap" }>,
  kind: string,
): DiscoveredUnit[] {
  const localName = resolveImportedLocalName(
    sourceFile,
    match.importModule,
    match.importName,
  );
  if (localName === null) {
    return [];
  }

  const mapProperty = match.mapProperty ?? "resolvers";
  const excludeTypes = new Set(match.excludeTypes ?? []);
  const results: DiscoveredUnit[] = [];

  sourceFile.forEachDescendant((node) => {
    // Match both `new ApolloServer({...})` and `apolloServer({...})`.
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== localName) {
      return;
    }
    const args = node.getArguments();
    if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) {
      return;
    }
    const config = args[0];

    // Find the resolvers property on the config object.
    const resolversProp = config.getProperty(mapProperty);
    if (resolversProp === undefined) {
      return;
    }

    const resolversObj = resolverMapObject(resolversProp);
    if (
      resolversObj === null ||
      !Node.isObjectLiteralExpression(resolversObj)
    ) {
      return;
    }

    // typeDefs lives alongside `resolvers` on the same config
    // object. Capture it once per ApolloServer construction; all
    // resolvers discovered below share the same SDL.
    const schemaSdl = extractTypeDefsSdl(config);

    // Walk type → field → function.
    for (const typeProp of resolversObj.getProperties()) {
      const typeName = resolverPropertyName(typeProp);
      if (typeName === null || excludeTypes.has(typeName)) {
        continue;
      }
      const typeObj = resolverMapObject(typeProp);
      if (typeObj === null || !Node.isObjectLiteralExpression(typeObj)) {
        continue;
      }
      for (const fieldProp of typeObj.getProperties()) {
        const fieldName = resolverPropertyName(fieldProp);
        if (fieldName === null) {
          continue;
        }
        const fn = resolverPropertyFunction(fieldProp);
        if (fn === null) {
          continue;
        }
        results.push({
          func: fn,
          kind,
          name: `${typeName}.${fieldName}`,
          resolverInfo: {
            typeName,
            fieldName,
            ...(schemaSdl !== null ? { schemaSdl } : {}),
          },
        });
      }
    }
  });

  return results;
}

/**
 * Given the property node that names the resolver map on the config
 * object, resolve it to the object literal that holds `Type.field`
 * functions. Handles three shapes:
 *   - inline:           `resolvers: { Query: {...} }`
 *   - shorthand:        `resolvers` (name refers to outer binding)
 *   - indirected const: `const resolvers = { ... } satisfies X;
 *                        ...  resolvers: resolvers`
 *
 * Shorthand needs `getValueSymbol()` (not `getSymbol()`) — ts-morph
 * exposes the TypeScript checker's
 * `getShorthandAssignmentValueSymbol` behind that name, which follows
 * the identifier to the outer binding rather than stopping at the
 * shorthand-property's own symbol.
 */
function resolverMapObject(prop: Node): Node | null {
  if (Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    if (init === undefined) {
      return null;
    }
    const peeled = peelToObjectLiteral(init);
    if (peeled !== null) {
      return peeled;
    }
    return resolveObjectLiteral(init);
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    const valueSymbol = prop.getValueSymbol();
    if (valueSymbol === undefined) {
      return null;
    }
    for (const decl of valueSymbol.getDeclarations()) {
      if (Node.isVariableDeclaration(decl)) {
        const peeled = peelToObjectLiteral(decl.getInitializer());
        if (peeled !== null) {
          return peeled;
        }
      }
    }
    return null;
  }
  return null;
}

/**
 * Read the `typeDefs` property off an ApolloServer config object and
 * reduce it to an SDL string when statically resolvable. Handles:
 *   - string literal:                  `typeDefs: "type Query { ... }"`
 *   - gql-tagged template (inline):    `typeDefs: gql\`type Query { ... }\``
 *   - const-bound gql template:        `typeDefs: TYPE_DEFS`
 *                                      with `const TYPE_DEFS = gql\`...\``
 *
 * Returns null when typeDefs is absent, composed via function call
 * (`mergeTypeDefs([...])`), an array of sources, or otherwise
 * non-static. Those forms become a follow-up once a concrete
 * multi-module schema motivates them.
 */
function extractTypeDefsSdl(config: Node): string | null {
  if (!Node.isObjectLiteralExpression(config)) {
    return null;
  }
  const prop = config.getProperty("typeDefs");
  if (prop === undefined) {
    return null;
  }
  const expr = typeDefsInitializer(prop);
  return expr === null ? null : resolveSchemaSdl(expr);
}

function typeDefsInitializer(prop: Node): Node | null {
  if (Node.isPropertyAssignment(prop)) {
    return prop.getInitializer() ?? null;
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    return prop.getNameNode();
  }
  return null;
}

function resolveSchemaSdl(expr: Node): string | null {
  if (
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr)
  ) {
    const value = expr.getLiteralValue();
    // Treat the empty string as "no typeDefs" — it has no schema
    // content to validate selections against, and downstream code
    // already special-cases a missing SDL.
    return value === "" ? null : value;
  }
  if (Node.isTaggedTemplateExpression(expr)) {
    const tag = expr.getTag();
    if (Node.isIdentifier(tag) && tag.getText() === "gql") {
      const template = expr.getTemplate();
      // Same inner-text extraction as the hook-call path — strip
      // backticks and return the GraphQL source. Substitutions
      // inside typeDefs aren't legal SDL, so we deliberately only
      // support no-substitution templates.
      if (Node.isNoSubstitutionTemplateLiteral(template)) {
        return template.getLiteralValue();
      }
    }
    return null;
  }
  if (Node.isIdentifier(expr)) {
    const symbol = expr.getSymbol();
    if (symbol === undefined) {
      return null;
    }
    for (const decl of symbol.getDeclarations()) {
      if (!Node.isVariableDeclaration(decl)) {
        continue;
      }
      const init = decl.getInitializer();
      if (init !== undefined) {
        const resolved = resolveSchemaSdl(init);
        if (resolved !== null) {
          return resolved;
        }
      }
    }
  }
  return null;
}

function resolverPropertyName(prop: Node): string | null {
  if (Node.isPropertyAssignment(prop) || Node.isMethodDeclaration(prop)) {
    return prop.getName();
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    return prop.getName();
  }
  return null;
}

function resolverPropertyFunction(prop: Node): FunctionRoot | null {
  if (Node.isMethodDeclaration(prop)) {
    return prop as MethodDeclaration;
  }
  if (Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    if (
      init !== undefined &&
      (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
    ) {
      return init as ArrowFunction | FunctionExpression;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// graphqlHookCall discovery (consumer side — Apollo client, urql, …)
// ---------------------------------------------------------------------------

/**
 * Parse a gql document source via graphql-js. Extracts everything
 * downstream layers need: operation type (query / mutation /
 * subscription), optional operation name, variable declarations
 * (including type-string and required flag), and root-level selection
 * field names. We run the full parser rather than a regex because
 * once you want variables you're re-implementing a recursive-descent
 * parser anyway, and graphql-js is already a transitive dep of the
 * checker and stub-appsync.
 *
 * Returns null for any parse failure — the adapter keeps moving
 * rather than halting on a malformed query literal.
 */
function parseGraphqlOperation(source: string): {
  operationType: "query" | "mutation" | "subscription";
  operationName?: string;
  variables: Array<{ name: string; type: string; required: boolean }>;
  rootFields: string[];
} | null {
  const op = parseFirstOperationDefinition(source);
  if (op === null) {
    return null;
  }
  const operationType =
    op.operation === "mutation"
      ? "mutation"
      : op.operation === "subscription"
        ? "subscription"
        : "query";
  const variables = (op.variableDefinitions ?? []).map((def) => ({
    name: def.variable.name.value,
    type: printGraphqlType(def.type),
    required: def.type.kind === GraphqlKind.NON_NULL_TYPE,
  }));
  const rootFields: string[] = [];
  for (const selection of op.selectionSet.selections) {
    if (selection.kind === GraphqlKind.FIELD) {
      rootFields.push(selection.name.value);
    }
  }
  const name = op.name?.value;
  return {
    operationType,
    ...(name !== undefined ? { operationName: name } : {}),
    variables,
    rootFields,
  };
}

function parseFirstOperationDefinition(
  source: string,
): GraphqlOperationDefinitionNode | null {
  try {
    const doc = graphqlParse(source);
    for (const def of doc.definitions) {
      if (def.kind === GraphqlKind.OPERATION_DEFINITION) {
        return def;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Reconstruct `User!`, `[ID!]!`, `[[Int]]` etc. as a single readable
 * type string from a parsed GraphQL type node. Matches the shape
 * stub-appsync uses for consistency — both packages feed
 * `ref:<printed-type>` into TypeShape, and keeping the printing rule
 * identical means a consumer's `$id: ID!` variable and a resolver's
 * `id: ID!` arg read as the same ref.
 */
function printGraphqlType(node: GraphqlTypeNode): string {
  if (node.kind === GraphqlKind.NON_NULL_TYPE) {
    return `${printGraphqlType(node.type)}!`;
  }
  if (node.kind === GraphqlKind.LIST_TYPE) {
    return `[${printGraphqlType(node.type)}]`;
  }
  return node.name.value;
}

/**
 * Peel the surrounding backticks off a template-literal source so the
 * operation-header regex matches the GraphQL content (the regex
 * starts with `\s*` for leading whitespace inside the literal, not
 * for the backtick character itself).
 */
function innerTemplateText(template: Node): string {
  const raw = template.getText();
  // Template literals are always wrapped in backticks; substring
  // between them is the GraphQL document. For TemplateExpression
  // with `${...}` substitutions we only need the head — interpolation
  // can't live inside the operation-header, so the leading portion
  // suffices for name extraction.
  if (raw.length >= 2 && raw.startsWith("`") && raw.endsWith("`")) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Resolve a hook-call argument to the inner source text of its
 * gql-tagged template literal. Handles:
 *   `useQuery(gql\`query ...\`)`             — inline gql tag
 *   `useQuery(GET_USER)`                      — const-bound gql tag
 *   `import GET_USER from "./q.graphql"`      — .graphql file import
 *
 * The `.graphql` / `.gql` file path resolves relative to the source
 * file. Files that don't exist on disk (common under
 * `useInMemoryFileSystem` test projects) fall back to null rather
 * than throwing — discovery stays advisory, not punitive.
 */
function resolveGqlTemplateText(arg: Node): string | null {
  if (Node.isTaggedTemplateExpression(arg)) {
    const tag = arg.getTag();
    if (!Node.isIdentifier(tag) || tag.getText() !== "gql") {
      return null;
    }
    return innerTemplateText(arg.getTemplate());
  }
  if (Node.isIdentifier(arg)) {
    const symbol = arg.getSymbol();
    if (symbol === undefined) {
      return null;
    }
    for (const decl of symbol.getDeclarations()) {
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (init !== undefined && Node.isTaggedTemplateExpression(init)) {
          return resolveGqlTemplateText(init);
        }
      }
      // Default-import form: `import GET_USER from "./q.graphql"`.
      // The declaration on the symbol chain is an ImportClause whose
      // parent import declaration points at the module specifier.
      if (Node.isImportClause(decl) || Node.isImportSpecifier(decl)) {
        const fromGraphqlFile = resolveGraphqlFileImport(decl);
        if (fromGraphqlFile !== null) {
          return fromGraphqlFile;
        }
      }
    }
  }
  return null;
}

/**
 * Resolve a hook-call argument that's a TypedDocumentNode reference —
 * the dominant production shape produced by GraphQL Code Generator. The
 * declaration looks like:
 *
 *   export const FooDocument = {
 *     kind: "Document",
 *     definitions: [{
 *       kind: "OperationDefinition",
 *       operation: "query",
 *       name: { kind: "Name", value: "Foo" },
 *       ...
 *     }],
 *   } as unknown as DocumentNode<FooQuery, FooQueryVariables>;
 *
 * Strategy: walk the identifier to its initializer, evaluate the
 * object-literal AST as a plain JS value (the JSON-shaped structure
 * mirrors a graphql-js DocumentNode), then re-serialize via
 * `graphqlPrint` so the rest of the pipeline (which expects a GraphQL
 * source string) works unchanged.
 */
function resolveTypedDocumentSource(arg: Node): string | null {
  if (!Node.isIdentifier(arg)) {
    return null;
  }
  const symbol = arg.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  // Follow `import { FooDocument } from "..."` to the source-file
  // declaration. Without aliasing the symbol's declarations land on
  // the ImportSpecifier in the consumer file, which carries no
  // initializer to read. `getAliasedSymbol` resolves to the original
  // VariableDeclaration; falls back to the local symbol when the
  // identifier wasn't imported.
  const resolved = symbol.getAliasedSymbol() ?? symbol;
  for (const decl of resolved.getDeclarations()) {
    if (!Node.isVariableDeclaration(decl)) {
      continue;
    }
    const init = decl.getInitializer();
    if (init === undefined) {
      continue;
    }
    const inner = stripDocumentNodeCasts(init);
    if (!Node.isObjectLiteralExpression(inner)) {
      continue;
    }
    const evaluated = evaluateObjectLiteralAsJson(inner);
    if (evaluated === null || typeof evaluated !== "object") {
      continue;
    }
    const doc = evaluated as Record<string, unknown>;
    if (doc.kind !== "Document" || !Array.isArray(doc.definitions)) {
      continue;
    }
    try {
      return graphqlPrint(evaluated as unknown as GraphqlDocumentNode);
    } catch {
      // Malformed AST — skip rather than throw.
      return null;
    }
  }
  return null;
}

/**
 * Strip the `as unknown as DocumentNode<...>` cast that codegen emits.
 * Walks AsExpression chains so a multi-step `expr as unknown as
 * DocumentNode<X, Y>` peels to the inner object literal.
 */
function stripDocumentNodeCasts(node: Node): Node {
  let current: Node = node;
  while (
    Node.isAsExpression(current) ||
    Node.isParenthesizedExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * Evaluate an object-literal / array-literal / primitive-literal AST
 * subtree to the corresponding plain JS value. Returns null on the
 * first node that can't be statically evaluated (computed property
 * names, function references, spread elements, identifier values).
 * The caller decides how to handle a partial parse — this helper is
 * strict so a single unresolvable corner doesn't silently produce
 * a structurally-incomplete document.
 */
function evaluateObjectLiteralAsJson(node: Node): unknown {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralValue();
  }
  if (Node.isNumericLiteral(node)) {
    return Number(node.getText());
  }
  const kind = node.getText();
  if (kind === "true") {
    return true;
  }
  if (kind === "false") {
    return false;
  }
  if (kind === "null") {
    return null;
  }
  if (Node.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        return null;
      }
      const nameNode = prop.getNameNode();
      let name: string;
      if (Node.isIdentifier(nameNode)) {
        name = nameNode.getText();
      } else if (
        Node.isStringLiteral(nameNode) ||
        Node.isNoSubstitutionTemplateLiteral(nameNode)
      ) {
        name = nameNode.getLiteralValue();
      } else {
        return null;
      }
      const init = prop.getInitializer();
      if (init === undefined) {
        return null;
      }
      const value = evaluateObjectLiteralAsJson(init);
      if (value === undefined) {
        return null;
      }
      out[name] = value;
    }
    return out;
  }
  if (Node.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const el of node.getElements()) {
      const value = evaluateObjectLiteralAsJson(el);
      if (value === undefined) {
        return null;
      }
      out.push(value);
    }
    return out;
  }
  return undefined;
}

function resolveGraphqlFileImport(decl: Node): string | null {
  const importDecl = Node.isImportSpecifier(decl)
    ? decl.getImportDeclaration()
    : Node.isImportClause(decl)
      ? decl.getParent()
      : null;
  if (
    importDecl === null ||
    importDecl === undefined ||
    !Node.isImportDeclaration(importDecl)
  ) {
    return null;
  }
  const specifier = importDecl.getModuleSpecifierValue();
  if (!/\.graphql$|\.gql$/.test(specifier)) {
    return null;
  }
  const sourceFile = importDecl.getSourceFile();
  const baseDir = path.dirname(sourceFile.getFilePath());
  const absolute = path.resolve(baseDir, specifier);
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function enclosingFunctionRoot(node: Node): FunctionRoot | null {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return current as FunctionRoot;
    }
    current = current.getParent();
  }
  return null;
}

function discoverGraphqlHookCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "graphqlHookCall" }>,
  kind: string,
): DiscoveredUnit[] {
  // Resolve each hook's local name by walking named imports on the
  // target module. A hook imported under an alias is honored:
  // `import { useQuery as useFoo } from "@apollo/client"`.
  const hookLocalNames = new Map<string, string>();
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== match.importModule) {
      continue;
    }
    for (const named of importDecl.getNamedImports()) {
      const canonical = named.getName();
      if (!match.hookNames.includes(canonical)) {
        continue;
      }
      const local = named.getAliasNode()?.getText() ?? canonical;
      hookLocalNames.set(local, canonical);
    }
  }
  if (hookLocalNames.size === 0) {
    return [];
  }

  const results: DiscoveredUnit[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee)) {
      return;
    }
    const local = callee.getText();
    if (!hookLocalNames.has(local)) {
      return;
    }
    const args = node.getArguments();
    if (args.length === 0) {
      return;
    }
    // gql-tagged source first; fall back to TypedDocumentNode for
    // codegen-shaped call sites (`useQuery(FooDocument)` where
    // `FooDocument` is a generated DocumentNode object literal).
    const docText =
      resolveGqlTemplateText(args[0]) ?? resolveTypedDocumentSource(args[0]);
    if (docText === null) {
      return;
    }
    const operation = parseGraphqlOperation(docText);
    if (operation === null) {
      return;
    }
    const enclosing = enclosingFunctionRoot(node);
    if (enclosing === null) {
      return;
    }
    results.push({
      func: enclosing,
      kind,
      // Name the unit after the enclosing function + operation so
      // multiple hook calls inside one component produce distinct
      // summary identities. Falls back to `<anon>` when the enclosing
      // function has no declared name (e.g. arrow passed to `forwardRef`).
      name: `${functionNameOrAnon(enclosing)}.${operation.operationName ?? `<anon-${operation.operationType}>`}`,
      callSite: {
        callExpression: node,
        methodName: hookLocalNames.get(local) ?? null,
      },
      operationInfo: { ...operation, document: docText },
    });
  });
  return results;
}

/**
 * Imperative Apollo-Client-style discovery. Finds method calls of
 * the form `<client>.<method>({ <documentKey>: gql\`...\` })` where
 * `<client>` is any expression (we don't trace it to a specific
 * ApolloClient instance — matching the import is the gate) and the
 * config-object property specified by the pack holds a gql document.
 */
function discoverGraphqlImperativeCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "graphqlImperativeCall" }>,
  kind: string,
): DiscoveredUnit[] {
  // Gate on the client identifier being imported — reduces false
  // positives against any object with a `.query()` / `.mutate()`
  // method (common in query-builder libraries).
  const localName = resolveImportedLocalName(
    sourceFile,
    match.importModule,
    match.importName,
  );
  if (localName === null) {
    return [];
  }

  const methodSpec = new Map<
    string,
    {
      documentKey: string;
      operationType: "query" | "mutation" | "subscription";
    }
  >();
  for (const method of match.methods) {
    methodSpec.set(method.methodName, {
      documentKey: method.documentKey,
      operationType: method.operationType,
    });
  }

  const results: DiscoveredUnit[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      return;
    }
    const methodName = callee.getName();
    const spec = methodSpec.get(methodName);
    if (spec === undefined) {
      return;
    }
    const args = node.getArguments();
    if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) {
      return;
    }
    const config = args[0];
    const docProp = config.getProperty(spec.documentKey);
    if (docProp === undefined) {
      return;
    }
    const docValue = imperativeConfigValue(docProp);
    if (docValue === null) {
      return;
    }
    const docText =
      resolveGqlTemplateText(docValue) ?? resolveTypedDocumentSource(docValue);
    if (docText === null) {
      return;
    }
    const operation = parseGraphqlOperation(docText);
    if (operation === null) {
      return;
    }
    const enclosing = enclosingFunctionRoot(node);
    if (enclosing === null) {
      return;
    }
    // Method-driven operation type wins when the gql header is
    // anonymous — `client.mutate({ mutation: gql\`...\` })` is a
    // mutation regardless of whether the doc says `mutation` or
    // just `{ ... }`.
    const operationType =
      operation.operationName !== undefined
        ? operation.operationType
        : spec.operationType;
    results.push({
      func: enclosing,
      kind,
      name: `${functionNameOrAnon(enclosing)}.${operation.operationName ?? `<anon-${operationType}>`}`,
      callSite: { callExpression: node, methodName },
      operationInfo: {
        ...operation,
        operationType,
        document: docText,
      },
    });
  });
  return results;
}

function imperativeConfigValue(prop: Node): Node | null {
  if (Node.isPropertyAssignment(prop)) {
    return prop.getInitializer() ?? null;
  }
  if (Node.isShorthandPropertyAssignment(prop)) {
    // Walk to the outer binding via getValueSymbol — same fix as
    // in resolverMapObject, needed because ShorthandPropertyAssignment's
    // `getSymbol()` returns the shorthand-property's own symbol,
    // not the referenced value.
    const valueSymbol = prop.getValueSymbol();
    if (valueSymbol === undefined) {
      return null;
    }
    for (const decl of valueSymbol.getDeclarations()) {
      if (Node.isVariableDeclaration(decl)) {
        const init = decl.getInitializer();
        if (init !== undefined) {
          return init;
        }
      }
    }
    return null;
  }
  return null;
}

function functionNameOrAnon(func: FunctionRoot): string {
  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    return func.getName() ?? "<anon>";
  }
  const parent = func.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return "<anon>";
}

// ---------------------------------------------------------------------------
// packageExports discovery
// ---------------------------------------------------------------------------

// Resolution is stable for the lifetime of the adapter run, and the
// handler fires once per (sourceFile × pattern) pair. Cache the
// resolver output keyed by packageJsonPath so we read each
// package.json once.
const packageExportsCache = new Map<
  string,
  ReturnType<typeof resolvePackageExports>
>();

function resolvePackageExportsCached(
  packageJsonPath: string,
): ReturnType<typeof resolvePackageExports> {
  const cached = packageExportsCache.get(packageJsonPath);
  if (cached !== undefined) {
    return cached;
  }
  const fresh = resolvePackageExports(packageJsonPath);
  packageExportsCache.set(packageJsonPath, fresh);
  return fresh;
}

/**
 * Clear the package-exports resolver cache. Tests call this between
 * runs to pick up fixture-package.json changes; production callers
 * don't need it.
 */
export function clearPackageExportsCache(): void {
  packageExportsCache.clear();
}

function discoverPackageExports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "packageExports" }>,
  kind: string,
): DiscoveredUnit[] {
  const { entries } = resolvePackageExportsCached(match.packageJsonPath);
  const filePath = sourceFile.getFilePath();

  // Match this source file against resolved entries. A single
  // source file can back multiple sub-paths (rare, but possible
  // when a barrel is re-exported under two keys), so we collect
  // every matching entry rather than stopping at the first.
  const matching: ResolvedPackageExport[] = [];
  for (const entry of entries) {
    if (entry.sourceFile === filePath) {
      if (
        match.subPaths !== undefined &&
        !match.subPaths.includes(entry.subPath)
      ) {
        continue;
      }
      matching.push(entry);
    }
  }
  if (matching.length === 0) {
    return [];
  }

  const exclude = new Set(match.excludeNames ?? []);
  const results: DiscoveredUnit[] = [];
  const seenNames = new Set<string>();

  for (const entry of matching) {
    const exported = sourceFile.getExportedDeclarations();
    for (const [exportName, decls] of exported) {
      if (exclude.has(exportName)) {
        continue;
      }
      const key = `${entry.subPath}::${exportName}`;
      if (seenNames.has(key)) {
        continue;
      }

      for (const decl of decls) {
        // Variable initialisers (export const foo = () => ...).
        if (Node.isVariableDeclaration(decl)) {
          const init = decl.getInitializer();
          if (
            init !== undefined &&
            (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
          ) {
            results.push(buildUnit(init, kind, exportName, entry));
            seenNames.add(key);
            break;
          }
          continue;
        }
        const fn = toFunctionRoot(decl);
        if (fn !== null) {
          results.push(buildUnit(fn, kind, exportName, entry));
          seenNames.add(key);
          break;
        }
      }
    }
  }

  return results;
}

function buildUnit(
  func: FunctionRoot,
  kind: string,
  exportName: string,
  entry: ResolvedPackageExport,
): DiscoveredUnit {
  return {
    func,
    kind,
    name: exportName,
    packageExportInfo: {
      packageName: entry.packageName,
      exportPath: [...entry.exportPathPrefix, exportName],
    },
  };
}

// ---------------------------------------------------------------------------
// packageImport discovery (consumer side)
// ---------------------------------------------------------------------------

function splitPackageSpec(spec: string): {
  packageName: string;
  subPath: string[];
} {
  // Scoped packages keep the first two segments together (`@scope/pkg`).
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) {
      return { packageName: spec, subPath: [] };
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const subPath = parts.slice(2);
    return { packageName, subPath };
  }
  const parts = spec.split("/");
  return {
    packageName: parts[0],
    subPath: parts.slice(1),
  };
}

function enclosingFunctionName(func: FunctionRoot): string {
  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    const n = func.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  if (Node.isFunctionExpression(func)) {
    const n = func.getName();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  // Arrow / anonymous: climb to the containing variable or property.
  const parent = func.getParent();
  if (parent !== undefined) {
    if (Node.isVariableDeclaration(parent)) {
      return parent.getName();
    }
    if (Node.isPropertyAssignment(parent)) {
      return parent.getName();
    }
  }
  return "<anon>";
}

function discoverPackageImports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "packageImport" }>,
  kind: string,
): DiscoveredUnit[] {
  const targetPackages = new Set(match.packages);

  // Map local-binding-name → { packageName, exportPath } for every
  // import from a targeted package.
  const localToExport = new Map<
    string,
    { packageName: string; exportPath: string[] }
  >();

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpec = importDecl.getModuleSpecifierValue();
    if (!targetPackages.has(moduleSpec)) {
      continue;
    }
    const { packageName, subPath } = splitPackageSpec(moduleSpec);
    for (const namedImport of importDecl.getNamedImports()) {
      const imported = namedImport.getName();
      const local = namedImport.getAliasNode()?.getText() ?? imported;
      localToExport.set(local, {
        packageName,
        exportPath: [...subPath, imported],
      });
    }
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport !== undefined) {
      localToExport.set(defaultImport.getText(), {
        packageName,
        exportPath: [...subPath, "default"],
      });
    }
  }

  if (localToExport.size === 0) {
    return [];
  }

  const results: DiscoveredUnit[] = [];
  const seen = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee)) {
      return;
    }
    const localName = callee.getText();
    const info = localToExport.get(localName);
    if (info === undefined) {
      return;
    }

    const enclosing = findEnclosingFunction(node);
    if (enclosing === null) {
      return;
    }

    // One unit per (enclosing function × consumed binding). Multiple
    // call sites inside the same function to the same imported binding
    // collapse to one unit — the consumer summary describes the
    // function's behaviour around that boundary, not individual calls.
    const key = `${enclosing.getStart()}-${enclosing.getEnd()}-${info.packageName}::${info.exportPath.join(".")}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    results.push({
      func: enclosing,
      kind,
      name: enclosingFunctionName(enclosing),
      packageExportInfo: info,
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

function runPattern(
  sourceFile: SourceFile,
  pattern: DiscoveryPattern,
): DiscoveredUnit[] {
  if (pattern.match.type === "namedExport") {
    return discoverNamedExports(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "registrationCall") {
    return discoverRegistrationCalls(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "clientCall") {
    return discoverClientCalls(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "graphqlHookCall") {
    return discoverGraphqlHookCalls(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "graphqlImperativeCall") {
    return discoverGraphqlImperativeCalls(
      sourceFile,
      pattern.match,
      pattern.kind,
    );
  }
  if (pattern.match.type === "resolverMap") {
    return discoverResolverMaps(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "packageExports") {
    return discoverPackageExports(sourceFile, pattern.match, pattern.kind);
  }
  if (pattern.match.type === "packageImport") {
    return discoverPackageImports(sourceFile, pattern.match, pattern.kind);
  }
  // decorator / fileConvention: stubs; discovery returns empty until
  // a concrete pack motivates implementing them.
  return [];
}

/**
 * Discover code units in `sourceFile` by running all patterns.
 * Deduplicates entries with the same function node and kind.
 */
export function discoverUnits(
  sourceFile: SourceFile,
  patterns: DiscoveryPattern[],
): DiscoveredUnit[] {
  const allResults: DiscoveredUnit[] = [];

  for (const pattern of patterns) {
    const found = runPattern(sourceFile, pattern);
    for (const unit of found) {
      unit.pattern = pattern;
    }
    allResults.push(...found);
  }

  // Deduplicate: same node + same kind → keep first occurrence. Units
  // tagged with `packageExportInfo` additionally distinguish on the
  // consumed binding — one enclosing function can legitimately emit
  // multiple caller units, one per imported library function it calls.
  const seen = new Set<string>();
  const deduped: DiscoveredUnit[] = [];

  for (const unit of allResults) {
    const bindingSuffix =
      unit.packageExportInfo !== undefined
        ? `-${unit.packageExportInfo.packageName}::${unit.packageExportInfo.exportPath.join(".")}`
        : "";
    const key = `${unit.func.getStart()}-${unit.func.getEnd()}-${unit.kind}${bindingSuffix}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(unit);
    }
  }

  return deduped;
}
