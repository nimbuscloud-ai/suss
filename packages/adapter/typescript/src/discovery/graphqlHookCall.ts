// graphqlHookCall.ts: discover GraphQL hook calls (Apollo Client's
// useQuery / useMutation / useSubscription, urql equivalents). Each
// matched call becomes a unit identified by its enclosing function
// + the operation name.

import { Node, type SourceFile } from "ts-morph";

import {
  enclosingFunctionRoot,
  functionNameOrAnon,
  type GraphqlOperationType,
  operationInfoFromResolution,
  resolveGraphqlDocument,
  unreadableDocument,
} from "./graphqlShared.js";
import { namedImportsOf } from "./importScan.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

interface HookSpec {
  canonical: string;
  operationType: GraphqlOperationType;
}

export function discoverGraphqlHookCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "graphqlHookCall" }>,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  // Resolve each hook's local name by walking named imports on the
  // target module. A hook imported under an alias is honored:
  // `import { useQuery as useFoo } from "@apollo/client"`.
  const hookByLocal = new Map<string, HookSpec>();
  const operationTypeByHook = new Map<string, GraphqlOperationType>(
    match.hooks.map((h) => [h.hookName, h.operationType]),
  );
  for (const one of namedImportsOf(sourceFile, [match.importModule])) {
    const operationType = operationTypeByHook.get(one.canonical);
    if (operationType !== undefined) {
      hookByLocal.set(one.local, { canonical: one.canonical, operationType });
    }
  }
  if (hookByLocal.size === 0) {
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
    const spec = hookByLocal.get(callee.getText());
    if (spec === undefined) {
      return;
    }
    const args = node.getArguments();
    if (args.length === 0) {
      return;
    }
    const document =
      resolveGraphqlDocument(args[0], resolution) ??
      unreadableDocument(args[0]);
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
    // Name the unit after the enclosing function + operation so
    // multiple hook calls inside one component produce distinct
    // summary identities. Falls back to the document reference (for an
    // unresolvable codegen import) then `<anon-...>` when the enclosing
    // function has no declared name.
    const nameToken =
      operationInfo.operationName ??
      operationInfo.unresolved?.reference ??
      `<anon-${operationInfo.operationType}>`;
    results.push({
      func: enclosing,
      kind,
      name: `${functionNameOrAnon(enclosing)}.${nameToken}`,
      callSite: { callExpression: node, methodName: spec.canonical },
      operationInfo,
    });
  });
  return results;
}
