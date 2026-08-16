// What the reader says about the DNS hop in front of a load balancer.
// An alias record pointing at a balancer becomes the first routesTo
// edge of the flow, and the record's own name goes on that edge as
// the host. A record pointing outside the template does not produce
// an edge, and neither does a record type without an address in it.

import { describe, expect, it } from "vitest";

import { readRoutingMetadata } from "@suss/behavioral-ir";

import { cloudFormationToSummaries } from "./index.js";

import type { BehavioralSummary, RoutingMetadata } from "@suss/behavioral-ir";

function dnsEdges(summaries: BehavioralSummary[]): RoutingMetadata[] {
  return summaries
    .map((s) => readRoutingMetadata(s))
    .filter((r): r is RoutingMetadata => r?.matchLanguage === "dns");
}

const balancer = {
  Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
  Properties: { Name: "shop-alb" },
};

describe("a Route 53 alias record", () => {
  it("routes its hostname to the balancer the alias points at", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        ShopAlb: balancer,
        ShopRecord: {
          Type: "AWS::Route53::RecordSet",
          Properties: {
            Name: "shop.example.com",
            Type: "A",
            AliasTarget: { DNSName: { "Fn::GetAtt": ["ShopAlb", "DNSName"] } },
          },
        },
      },
    });

    const edges = dnsEdges(summaries);
    expect(edges).toHaveLength(1);
    expect(edges[0].edge).toBe("routesTo");
    expect(edges[0].target).toBe("ShopAlb");
    expect(edges[0].conditions).toEqual([
      { field: "host-header", values: ["shop.example.com"], evaluated: true },
    ]);
  });

  it("reads each record a record-set group states inline", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        ShopAlb: balancer,
        Records: {
          Type: "AWS::Route53::RecordSetGroup",
          Properties: {
            RecordSets: [
              {
                Name: "shop.example.com",
                Type: "A",
                AliasTarget: {
                  DNSName: { "Fn::GetAtt": ["ShopAlb", "DNSName"] },
                },
              },
              {
                Name: "www.example.com",
                Type: "AAAA",
                AliasTarget: {
                  DNSName: { "Fn::GetAtt": ["ShopAlb", "DNSName"] },
                },
              },
            ],
          },
        },
      },
    });

    const hosts = dnsEdges(summaries).flatMap((e) =>
      (e.conditions ?? []).flatMap((c) => c.values),
    );
    expect(hosts).toEqual(["shop.example.com", "www.example.com"]);
  });

  it("does not add an edge for an alias pointing outside the template", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        ShopRecord: {
          Type: "AWS::Route53::RecordSet",
          Properties: {
            Name: "shop.example.com",
            Type: "A",
            AliasTarget: { DNSName: "d111111abcdef8.cloudfront.net" },
          },
        },
      },
    });
    expect(dnsEdges(summaries)).toEqual([]);
  });

  it("does not add an edge for a record type without an address", () => {
    const summaries = cloudFormationToSummaries({
      Resources: {
        ShopAlb: balancer,
        Txt: {
          Type: "AWS::Route53::RecordSet",
          Properties: {
            Name: "example.com",
            Type: "TXT",
            AliasTarget: { DNSName: { "Fn::GetAtt": ["ShopAlb", "DNSName"] } },
          },
        },
      },
    });
    expect(dnsEdges(summaries)).toEqual([]);
  });
});
