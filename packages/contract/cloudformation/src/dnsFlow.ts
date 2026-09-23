/**
 * Route 53 records as the first hop of a flow.
 *
 * A client reaches a load balancer by name, and the alias record maps
 * that name to the balancer. Without the record, a walk starts at the
 * listener, and the listener's host-header rules have no host to match
 * against (#174).
 *
 * Each record becomes a routesTo edge from the record to the aliased
 * resource, with the record's name as a host-header condition in the
 * "dns" match language. No selector handles that language yet, so a
 * reachability pass reports these hops as unknown.
 */

import { withRoutingMetadata } from "@suss/behavioral-ir";

import type { BehavioralSummary, RoutingMetadata } from "@suss/behavioral-ir";
import type { CloudFormationResource } from "./index.js";

// Record types that resolve to an address a client can connect to.
const ADDRESS_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);

export function buildDnsFlowSummaries(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type === "AWS::Route53::RecordSet") {
      const summary = recordSummary(
        logicalId,
        resource.Properties ?? {},
        resources,
        sourceFile,
      );
      if (summary !== null) {
        summaries.push(summary);
      }
      continue;
    }

    if (resource.Type !== "AWS::Route53::RecordSetGroup") {
      continue;
    }
    // Each record inside a group is its own hop.
    const inner = resource.Properties?.RecordSets;
    if (!Array.isArray(inner)) {
      continue;
    }
    inner.forEach((record, index) => {
      if (typeof record !== "object" || record === null) {
        return;
      }
      const summary = recordSummary(
        `${logicalId}#${index}`,
        record as Record<string, unknown>,
        resources,
        sourceFile,
      );
      if (summary !== null) {
        summaries.push(summary);
      }
    });
  }
  return summaries;
}

function recordSummary(
  identityName: string,
  props: Record<string, unknown>,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary | null {
  const type = props.Type;
  if (typeof type !== "string" || !ADDRESS_RECORD_TYPES.has(type)) {
    return null;
  }

  const alias = props.AliasTarget;
  const dnsName =
    typeof alias === "object" && alias !== null
      ? (alias as { DNSName?: unknown }).DNSName
      : undefined;
  const target = aliasedResource(dnsName, resources);
  if (target === null) {
    return null;
  }

  const name = typeof props.Name === "string" ? props.Name : null;
  const routing: RoutingMetadata = {
    edge: "routesTo",
    router: identityName,
    target,
    matchId: identityName,
    matchLanguage: "dns",
    conditions:
      name === null
        ? []
        : [{ field: "host-header", values: [name], evaluated: true }],
  };
  return {
    kind: "library",
    location: {
      file: sourceFile,
      range: { start: 1, end: 1 },
      exportName: null,
    },
    identity: { name: identityName, exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: withRoutingMetadata(undefined, routing),
  };
}

/**
 * The logical id in an alias's `Fn::GetAtt` on a DNSName. A literal
 * domain points outside the template, so it gets no edge.
 */
function aliasedResource(
  dnsName: unknown,
  resources: Record<string, CloudFormationResource>,
): string | null {
  if (typeof dnsName !== "object" || dnsName === null) {
    return null;
  }
  const getAtt = (dnsName as { "Fn::GetAtt"?: unknown })["Fn::GetAtt"];
  const parts = Array.isArray(getAtt)
    ? getAtt
    : typeof getAtt === "string"
      ? getAtt.split(".")
      : null;
  if (parts === null || typeof parts[0] !== "string") {
    return null;
  }
  const logicalId = parts[0];
  return resources[logicalId] === undefined ? null : logicalId;
}
