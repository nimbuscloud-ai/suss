// graphqlHookCall.ts — discover GraphQL hook calls (Apollo Client's
// useQuery / useMutation / useSubscription, urql equivalents). Each
// matched call becomes a unit identified by its enclosing function
// + the operation name.

import { Node, type SourceFile } from "ts-morph";

import {
  enclosingFunctionRoot,
  functionNameOrAnon,
  parseGraphqlOperation,
  resolveGqlTemplateText,
  resolveTypedDocumentSource,
} from "./graphqlShared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { DiscoveredUnit } from "./shared.js";

export function discoverGraphqlHookCalls(
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
