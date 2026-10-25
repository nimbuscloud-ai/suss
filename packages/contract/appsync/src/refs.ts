// CloudFormation value readers shared by the raw AWS::AppSync walk and
// the SAM AWS::Serverless::GraphQLApi reader.

import {
  documentRef,
  qualifiedLogicalId,
  refTarget,
  type TemplateDocument,
} from "@suss/manifest-aws";

/**
 * How one document's ids are written in the model: `own` for a resource
 * the document declares, `ref` for a value that refers to one. A nested
 * document's ids carry its stack path, and a `!Ref` to a parameter its
 * parent set to a resource reads as that resource.
 */
export interface DocumentRefs {
  own(logicalId: string): string;
  /** Null for a value only known at deploy time, such as `!Sub` or `!ImportValue`. */
  ref(value: unknown): string | null;
}

/** A template read on its own, where every id is the one it writes. */
export const OWN_DOCUMENT: DocumentRefs = {
  own: (logicalId) => logicalId,
  ref: (value) => refTarget(value),
};

export function documentRefsOf(
  document: Pick<TemplateDocument, "stackPath" | "parameterTargets">,
): DocumentRefs {
  return {
    own: (logicalId) => qualifiedLogicalId(document.stackPath, logicalId),
    ref: (value) => documentRef(document, value),
  };
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
