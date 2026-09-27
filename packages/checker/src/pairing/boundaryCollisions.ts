/**
 * Boundaries that two different summary files both claim to provide.
 *
 * suss keys an HTTP boundary by method and path, without the service
 * that serves it, so two services that both expose `GET /users` share one
 * key. A caller of either one is then compared with both, and gets
 * findings from an API it never calls. Projects usually write one file
 * per service, so two files providing one key most likely means this
 * happened. A spec read with `suss contract` describes a route without
 * serving it, and a route a deployment template declares is served by
 * the handler the template points at, so neither is a second claim.
 */

import { BOUNDARY_ROLE, readHttpMetadata } from "@suss/behavioral-ir";
import { boundaryKey } from "@suss/ir-core";

import { readDeclaredContract } from "../contract/declaredContract.js";
import { readGraphqlDeclaredContract } from "../contract/graphqlContract.js";

import type { BehavioralSummary, HttpMetadata } from "@suss/behavioral-ir";

/** A summary, and the summaries file it was read from. */
export interface SummaryClaim {
  summary: BehavioralSummary;
  file: string;
}

/** A boundary whose providers came from more than one summaries file. */
export interface BoundaryCollision {
  key: string;
  files: string[];
}

/** Every boundary more than one file provides, sorted by key, each with its files sorted. */
export function boundaryCollisions(
  claims: readonly SummaryClaim[],
): BoundaryCollision[] {
  const claimsByKey = new Map<string, SummaryClaim[]>();
  for (const claim of claims) {
    const key = providedKey(claim.summary);
    if (key === null) {
      continue;
    }
    claimsByKey.set(key, [...(claimsByKey.get(key) ?? []), claim]);
  }

  const collisions: BoundaryCollision[] = [];
  for (const [key, onKey] of claimsByKey) {
    const files = new Set(
      onKey
        .filter((claim) => !implementedIn(claim, onKey))
        .map((claim) => claim.file),
    );
    if (files.size > 1) {
      collisions.push({ key, files: [...files].sort() });
    }
  }
  return collisions.sort((a, b) => a.key.localeCompare(b.key));
}

/** The key a summary serves, or null when it serves none or only describes one. */
function providedKey(summary: BehavioralSummary): string | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || BOUNDARY_ROLE[summary.kind] !== "provider") {
    return null;
  }
  if (
    readDeclaredContract(summary)?.provenance === "derived" ||
    readGraphqlDeclaredContract(summary)?.provenance === "derived"
  ) {
    return null;
  }
  return boundaryKey(binding);
}

type HandlerPointer = NonNullable<HttpMetadata["implementingHandler"]>;

/**
 * Whether a route a deployment template declares is served by code read
 * from another file. The template says which handler implements the
 * route, as SAM does for a Lambda behind API Gateway.
 */
function implementedIn(
  claim: SummaryClaim,
  claims: readonly SummaryClaim[],
): boolean {
  const pointer = readHttpMetadata(claim.summary)?.implementingHandler;
  return (
    pointer !== undefined &&
    claims.some(
      (other) => other.file !== claim.file && deploys(pointer, other.summary),
    )
  );
}

/** Whether the handler the template points at is this code: the same deployable, or the same module and export. */
function deploys(pointer: HandlerPointer, code: BehavioralSummary): boolean {
  const unit = code.identity.deployableUnit;
  if (
    pointer.functionLogicalId !== undefined &&
    unit?.instanceName === pointer.functionLogicalId
  ) {
    return true;
  }
  const module = joinedPath(pointer.codeUri ?? "", pointer.modulePath);
  return (
    code.location.exportName === pointer.exportName &&
    code.location.file.replace(/\.[^./]+$/, "") === module
  );
}

/** Joins two forward-slash paths the way a template's `CodeUri` and handler path combine, dropping `.` and empty segments. */
function joinedPath(base: string, rest: string): string {
  const segments: string[] = [];
  for (const segment of `${base}/${rest}`.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === ".." && segments.length > 0) {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
