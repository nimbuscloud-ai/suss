// resolverMap.ts — discover GraphQL code-first resolvers (Apollo
// Server, GraphQL Yoga, …). Walks `new ApolloServer({ resolvers })`
// constructions and emits one unit per `Type.field` resolver function.

import {
  type ArrowFunction,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
} from "ts-morph";

import { resolveImportedLocalName } from "./resolveImport.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { DiscoveredUnit } from "./shared.js";

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

export function discoverResolverMaps(
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
