// graphqlImperativeCall.ts — discover imperative GraphQL calls
// (`apolloClient.query({ query: gql\`...\` })`,
// `apolloClient.mutate({ mutation: ... })`). Method-driven operation
// type wins when the gql header is anonymous.

import { Node, type SourceFile } from "ts-morph";

import {
  enclosingFunctionRoot,
  functionNameOrAnon,
  type GraphqlOperationType,
  operationInfoFromResolution,
  resolveGraphqlDocument,
} from "./graphqlShared.js";
import { resolveImportedLocalName } from "./resolveImport.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

export function discoverGraphqlImperativeCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "graphqlImperativeCall" }>,
  kind: string,
  resolution?: ResolutionStore,
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
      operationType: GraphqlOperationType;
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
    const document = resolveGraphqlDocument(docValue, resolution);
    if (document === null) {
      return;
    }
    // Method-driven operation type wins when the gql header is
    // anonymous — `client.mutate({ mutation: gql\`...\` })` is a
    // mutation regardless of whether the doc says `mutation` or just
    // `{ ... }` — and supplies the type when the document body isn't
    // statically readable at all.
    const operationInfo = operationInfoFromResolution(
      document,
      spec.operationType,
    );
    if (operationInfo === null) {
      return;
    }
    const enclosing = enclosingFunctionRoot(node);
    if (enclosing === null) {
      return;
    }
    const nameToken =
      operationInfo.operationName ??
      operationInfo.unresolved?.reference ??
      `<anon-${operationInfo.operationType}>`;
    results.push({
      func: enclosing,
      kind,
      name: `${functionNameOrAnon(enclosing)}.${nameToken}`,
      callSite: { callExpression: node, methodName },
      operationInfo,
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
