// discovery.ts — Code unit discovery for ts-morph SourceFiles (Task 2.4)

import fs from "node:fs";
import path from "node:path";

import {
  Kind as GraphqlKind,
  type OperationDefinitionNode as GraphqlOperationDefinitionNode,
  type TypeNode as GraphqlTypeNode,
  parse as graphqlParse,
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract FunctionRoot from something that might be a function or wrap one. */
function toFunctionRoot(node: Node): FunctionRoot | null {
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
    const docText = resolveGqlTemplateText(args[0]);
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
    const docText = resolveGqlTemplateText(docValue);
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

  // Deduplicate: same node + same kind → keep first occurrence
  const seen = new Set<string>();
  const deduped: DiscoveredUnit[] = [];

  for (const unit of allResults) {
    const key = `${unit.func.getStart()}-${unit.func.getEnd()}-${unit.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(unit);
    }
  }

  return deduped;
}
