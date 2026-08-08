// refs.ts: CloudFormation scalar / reference readers shared by the raw
// AWS::AppSync::* walk (cfn.ts) and the SAM AWS::Serverless::GraphQLApi
// normalizer (sam.ts).

import { refTarget } from "@suss/manifest-aws";

/**
 * The logical id a CloudFormation reference field names, or null when
 * a static reader cannot say. `!Sub`, `!Join` and `!ImportValue` are
 * deployment-time values, so they answer null.
 *
 * The shapes a reference is written in belong to the template loader,
 * which every AWS reader parses through, so this asks it rather than
 * matching the shapes again here.
 */
export function resolveLogicalRef(value: unknown): string | null {
  return refTarget(value);
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
