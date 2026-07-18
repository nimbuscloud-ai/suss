// refs.ts — CloudFormation scalar / reference readers shared by the raw
// AWS::AppSync::* walk (cfn.ts) and the SAM AWS::Serverless::GraphQLApi
// normalizer (sam.ts).

/**
 * Resolve a CFN "reference-to-another-resource" field to its logical
 * ID when possible. Accepts:
 *   - `{ Ref: "LogicalId" }` — the canonical form
 *   - `{ "Fn::GetAtt": ["LogicalId", "..."] }` — e.g. a resolver using
 *     `!GetAtt Api.ApiId`, or a Lambda data source using
 *     `!GetAtt Fn.Arn` (the logical-ID head is what we keep)
 *   - bare string — when a template author uses raw logical IDs
 *
 * Dynamic references (`!Sub`, `!Join`, `!ImportValue`) return null — a
 * static reader can't resolve across deployment-time values.
 */
export function resolveLogicalRef(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const ref = obj.Ref;
  if (typeof ref === "string") {
    return ref;
  }
  const getAtt = obj["Fn::GetAtt"];
  if (
    Array.isArray(getAtt) &&
    getAtt.length > 0 &&
    typeof getAtt[0] === "string"
  ) {
    return getAtt[0];
  }
  return null;
}

export function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Narrow an unknown to a plain (non-array) object record. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
