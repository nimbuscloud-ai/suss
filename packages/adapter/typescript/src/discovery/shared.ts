// shared.ts — types + helpers shared by every discovery handler.
//
// The dispatch and the public discoverUnits orchestrator live in
// ./index.ts; this file holds only what the per-handler files need
// in common (the DiscoveredUnit type, the FunctionRoot adapter, and
// the simple "walk-to-enclosing-function" helper that two unrelated
// handlers — clientCall and packageImport — both need).

import { type CallExpression, Node } from "ts-morph";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

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
  /**
   * Populated by `decoratedRoute` discovery (NestJS-style REST
   * controllers). The adapter uses it to build a `rest` binding
   * with `(method, path)` directly, bypassing the
   * `bindingExtraction` config used by Express / Fastify (which
   * extract from `app.get(...)` registration calls — the wrong
   * shape for decorator-driven controllers).
   */
  routeInfo?: {
    method: string;
    path: string;
  };
}

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

/** Walk to the nearest enclosing function-shaped node, or null if none. */
export function findEnclosingFunction(node: Node): FunctionRoot | null {
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
