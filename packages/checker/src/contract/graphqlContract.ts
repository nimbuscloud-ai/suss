/**
 * A GraphQL contract is declared per resolver: one return type, typed
 * arguments, and optionally the error types it can produce. A REST
 * contract lists responses by status code, but GraphQL errors travel in
 * `errors[]` beside the data, so there is no status to key on.
 *
 * The contract is stored under `metadata.graphql.declaredContract`.
 * GraphQL goes over HTTP, but its responses are typed by resolver, so
 * it gets its own namespace instead of sharing the HTTP one.
 */

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
