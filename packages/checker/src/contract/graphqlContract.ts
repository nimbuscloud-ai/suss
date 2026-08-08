// graphqlContract.ts: sibling of declaredContract.ts for the GraphQL
// response model. Where REST contracts are `{ responses: [{ statusCode,
// body }, ...] }`, GraphQL contracts are per-resolver: a single return
// type, a list of typed arguments, and an optional set of error-type
// references (the GraphQL `errors[]` path is out-of-band so it doesn't
// have a status code to key on).
//
// Lives under `metadata.graphql.declaredContract` so the namespace is
// explicit. GraphQL is HTTP-transported but its response model is
// resolver-typed, not status+body: the namespacing reflects the
// response model, not the wire transport.

import { readGraphqlMetadata } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  GraphqlDeclaredContract,
} from "@suss/behavioral-ir";

export type {
  GraphqlContractProvenance,
  GraphqlDeclaredContract,
} from "@suss/behavioral-ir";

export function readGraphqlDeclaredContract(
  summary: BehavioralSummary,
): GraphqlDeclaredContract | null {
  return readGraphqlMetadata(summary)?.declaredContract ?? null;
}
