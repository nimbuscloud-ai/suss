// graphqlContract.ts — sibling of declaredContract.ts for the GraphQL
// response model. Where REST contracts are `{ responses: [{ statusCode,
// body }, ...] }`, GraphQL contracts are per-resolver: a single return
// type, a list of typed arguments, and an optional set of error-type
// references (the GraphQL `errors[]` path is out-of-band so it doesn't
// have a status code to key on).
//
// Lives under `metadata.graphql.declaredContract` so the namespace is
// explicit. GraphQL is HTTP-transported but its response model is
// resolver-typed, not status+body — the namespacing reflects the
// response model, not the wire transport.

import type { BehavioralSummary, TypeShape } from "@suss/behavioral-ir";

export type GraphqlContractProvenance = "derived" | "independent";

export interface GraphqlDeclaredContract {
  /** Declared return shape for this resolver field. */
  returnType: TypeShape;
  /**
   * Declared arguments. Order matters when contract sources disagree
   * — argument order is part of the resolver's identity in some
   * frameworks (NestJS positional decorators) even though GraphQL
   * itself names args.
   */
  args: Array<{
    name: string;
    type: TypeShape;
    required: boolean;
  }>;
  /**
   * Optional error variants the resolver may throw. Most contracts
   * don't enumerate these; left empty when the source doesn't say.
   * Compared as a set for agreement; absent set is "unknown," not
   * "no errors."
   */
  errorTypes?: string[];
  /**
   * Same provenance semantics as REST `DeclaredContract`. "derived"
   * = contract and transitions came from the same source; self-
   * comparison is tautological. "independent" = separate statements;
   * comparison is meaningful. Defaults to "independent" when the
   * source doesn't say (favour investigating spurious findings over
   * silently dropping real ones).
   */
  provenance: GraphqlContractProvenance;
  /** Framework / source tag the producing pack records. */
  framework?: string;
}

function graphqlMetadata(
  summary: BehavioralSummary,
): Record<string, unknown> | undefined {
  const gql = summary.metadata?.graphql;
  return gql && typeof gql === "object"
    ? (gql as Record<string, unknown>)
    : undefined;
}

export function readGraphqlDeclaredContract(
  summary: BehavioralSummary,
): GraphqlDeclaredContract | null {
  const raw = graphqlMetadata(summary)?.declaredContract;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const returnTypeRaw = (raw as { returnType?: unknown }).returnType;
  if (!returnTypeRaw || typeof returnTypeRaw !== "object") {
    return null;
  }
  const argsRaw = (raw as { args?: unknown }).args;
  const args: GraphqlDeclaredContract["args"] = [];
  if (Array.isArray(argsRaw)) {
    for (const a of argsRaw) {
      if (a && typeof a === "object") {
        const name = (a as { name?: unknown }).name;
        const type = (a as { type?: unknown }).type;
        const required = (a as { required?: unknown }).required;
        if (
          typeof name === "string" &&
          type &&
          typeof type === "object" &&
          typeof required === "boolean"
        ) {
          args.push({ name, type: type as TypeShape, required });
        }
      }
    }
  }
  const errorTypesRaw = (raw as { errorTypes?: unknown }).errorTypes;
  const errorTypes = Array.isArray(errorTypesRaw)
    ? errorTypesRaw.filter((v): v is string => typeof v === "string")
    : undefined;
  const provRaw = (raw as { provenance?: unknown }).provenance;
  const provenance: GraphqlContractProvenance =
    provRaw === "derived" ? "derived" : "independent";
  const framework =
    typeof (raw as { framework?: unknown }).framework === "string"
      ? (raw as { framework: string }).framework
      : undefined;
  return {
    returnType: returnTypeRaw as TypeShape,
    args,
    ...(errorTypes !== undefined ? { errorTypes } : {}),
    provenance,
    ...(framework !== undefined ? { framework } : {}),
  };
}
