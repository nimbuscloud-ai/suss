// CloudFormation value readers shared by the raw AWS::AppSync walk and
// the SAM AWS::Serverless::GraphQLApi reader.

import { refTarget } from "@suss/manifest-aws";

/**
 * The logical id a CloudFormation reference points at, or null for a
 * value only known at deploy time, such as `!Sub`, `!Join` or
 * `!ImportValue`. The template loader recognizes every way a reference
 * can be written, so this delegates to it.
 */
export function resolveLogicalRef(value: unknown): string | null {
  return refTarget(value);
}

export function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
