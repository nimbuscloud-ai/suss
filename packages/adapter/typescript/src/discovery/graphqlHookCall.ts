// graphqlHookCall.ts: discover GraphQL hook calls (Apollo Client's
// useQuery / useMutation / useSubscription, urql equivalents). Each
// matched call becomes a unit identified by its enclosing function
// + the operation name.

import { Node, type SourceFile } from "ts-morph";

import { ResolutionStore } from "../facts/store.js";
import {
  enclosingFunctionRoot,
  functionNameOrAnon,
  type GraphqlOperationType,
  operationInfoFromResolution,
} from "./graphqlShared.js";
import {
  documentBehindWrapper,
  expandDocumentParameterCallers,
} from "./graphqlWrapper.js";
import { callsByOriginName } from "./importedCalls.js";

import type { DiscoveryPattern } from "@suss/extractor";
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
  // The store follows each hook call's callee to the module's export,
  // so an alias and a project barrel both match:
  // `import { useQuery as useFoo } from "@apollo/client"`.
  const store = resolution ?? new ResolutionStore();
  const operationTypeByHook = new Map<string, GraphqlOperationType>(
    match.hooks.map((h) => [h.hookName, h.operationType]),
  );
  const hookCalls = callsByOriginName(
    sourceFile,
    store,
    match.importModule,
    new Set(operationTypeByHook.keys()),
  );

  const results: DiscoveredUnit[] = [];
  for (const [node, canonical] of hookCalls) {
    if (!Node.isCallExpression(node)) {
      continue;
    }
    const operationType = operationTypeByHook.get(canonical);
    if (operationType === undefined) {
      continue;
    }
    const spec: HookSpec = { canonical, operationType };
    const args = node.getArguments();
    const documentArgument = args[0];
    if (documentArgument === undefined) {
      continue;
    }
    // A project hook that passes its own parameter here is one
    // operation per component calling it, not one operation called
    // `useAppQuery.query`.
    const expansion = expandDocumentParameterCallers(documentArgument, node, {
      kind,
      operationType: spec.operationType,
      methodName: spec.canonical,
      store,
    });
    if (expansion !== null) {
      results.push(...expansion.units);
      if (expansion.unfollowedReason === null) {
        continue;
      }
    }
    const document = documentBehindWrapper(
      documentArgument,
      store,
      expansion?.unfollowedReason ?? undefined,
    );
    const operationInfo = operationInfoFromResolution(
      document,
      spec.operationType,
    );
    if (operationInfo === null) {
      continue;
    }
    const enclosing = enclosingFunctionRoot(node);
    if (enclosing === null) {
      continue;
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
  }
  return results;
}
