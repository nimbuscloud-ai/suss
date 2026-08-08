// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every `${...}` here is the Serverless Framework's variable syntax under test, in a plain string on purpose.

import { describe, expect, it } from "vitest";

import { createVariableResolver } from "./variables.js";

const document = {
  service: "order-desk",
  provider: { stage: "dev" },
  custom: {
    ordersTable: "order-desk-orders",
    basePath: "api",
    nested: { depth: 2 },
    viaSelf: "${self:custom.basePath}",
    loop: "${self:custom.loop}",
  },
};

const resolver = createVariableResolver(document);

describe("self references", () => {
  it("resolves a whole-value reference to what the document states", () => {
    expect(resolver.resolveString("${self:service}")).toEqual({
      kind: "resolved",
      value: "order-desk",
    });
  });

  it("resolves a dotted path", () => {
    expect(resolver.resolveString("${self:custom.ordersTable}")).toEqual({
      kind: "resolved",
      value: "order-desk-orders",
    });
  });

  it("substitutes a reference embedded in a longer string", () => {
    expect(resolver.resolveString("/${self:custom.basePath}/orders")).toEqual({
      kind: "resolved",
      value: "/api/orders",
    });
  });

  it("follows a reference whose target is itself a reference", () => {
    expect(resolver.resolveString("${self:custom.viaSelf}")).toEqual({
      kind: "resolved",
      value: "api",
    });
  });

  it("stringifies a number the way a substitution would", () => {
    expect(resolver.resolveString("${self:custom.nested.depth}")).toEqual({
      kind: "resolved",
      value: "2",
    });
  });

  it("keeps a whole-value reference to a subtree as data", () => {
    expect(resolver.resolveValue("${self:custom.nested}")).toEqual({
      kind: "resolved",
      value: { depth: 2 },
    });
  });

  it("is symbolic when the same reference points at a subtree in a string position", () => {
    expect(resolver.resolveString("${self:custom.nested}")).toEqual({
      kind: "symbolic",
      token: "${self:custom.nested}",
    });
  });

  it("is symbolic for a path the document does not declare", () => {
    expect(resolver.resolveString("${self:custom.missing}")).toEqual({
      kind: "symbolic",
      token: "self:custom.missing",
    });
  });

  it("takes a literal fallback when the path is missing", () => {
    expect(resolver.resolveString("${self:custom.missing, 'plain'}")).toEqual({
      kind: "resolved",
      value: "plain",
    });
  });

  it("takes a numeric fallback", () => {
    expect(resolver.resolveString("${self:custom.missing, 10}")).toEqual({
      kind: "resolved",
      value: "10",
    });
  });

  it("stays symbolic when the fallback is itself a reference", () => {
    expect(resolver.resolveString("${self:custom.missing, env:OTHER}")).toEqual(
      { kind: "symbolic", token: "self:custom.missing" },
    );
  });

  it("stays symbolic when a reference is nested inside another, so only the inner one matches", () => {
    expect(
      resolver.resolveString("${self:custom.${self:custom.basePath}}"),
    ).toEqual({ kind: "symbolic", token: "${self:custom.api}" });
  });

  it("stops at a reference cycle rather than recurring", () => {
    expect(resolver.resolveString("${self:custom.loop}")).toEqual({
      kind: "symbolic",
      token: "self:custom.loop",
    });
  });
});

describe("deploy-time references", () => {
  it("keeps an env reference as its token", () => {
    expect(resolver.resolveString("${env:AUDIT_QUEUE_ARN}")).toEqual({
      kind: "symbolic",
      token: "env:AUDIT_QUEUE_ARN",
    });
  });

  it("keeps an opt reference as its token, fallback and all", () => {
    expect(resolver.resolveString("${opt:region, 'us-east-1'}")).toEqual({
      kind: "symbolic",
      token: "opt:region",
    });
  });

  it("keeps a cf reference as its token", () => {
    expect(resolver.resolveString("${cf:core-stack.QueueArn}")).toEqual({
      kind: "symbolic",
      token: "cf:core-stack.QueueArn",
    });
  });

  it("keeps what it could substitute visible in a mixed string", () => {
    expect(
      resolver.resolveString("${self:service}-${env:STAGE}-queue"),
    ).toEqual({ kind: "symbolic", token: "order-desk-${env:STAGE}-queue" });
  });
});

describe("a CloudFormation subtree", () => {
  it("resolves a property the document answers", () => {
    expect(
      resolver.resolveTemplateTree({
        Properties: { TableName: "${self:custom.ordersTable}" },
      }),
    ).toEqual({ Properties: { TableName: "order-desk-orders" } });
  });

  it("keeps a deploy-time reference visible beside what did resolve", () => {
    expect(
      resolver.resolveTemplateTree({
        QueueName: "${self:service}-${opt:stage}",
      }),
    ).toEqual({ QueueName: "order-desk-${opt:stage}" });
  });

  it("records a whole-value deploy-time reference as its token", () => {
    expect(resolver.resolveTemplateTree({ Name: "${env:TABLE}" })).toEqual({
      Name: "env:TABLE",
    });
  });

  it("leaves a reference belonging to Fn::Sub exactly as written", () => {
    const subtree = {
      "Fn::Sub": "arn:aws:kms:${AWS::Region}:${AWS::AccountId}:alias/orders",
    };

    expect(resolver.resolveTemplateTree(subtree)).toEqual(subtree);
  });

  it("walks lists and leaves non-strings alone", () => {
    expect(
      resolver.resolveTemplateTree({
        Values: ["${self:service}", 3, true, null],
      }),
    ).toEqual({ Values: ["order-desk", 3, true, null] });
  });
});

describe("values with no references", () => {
  it("passes a plain string through", () => {
    expect(resolver.resolveString("plain")).toEqual({
      kind: "resolved",
      value: "plain",
    });
  });

  it("passes a non-string value through", () => {
    expect(resolver.resolveValue({ "Fn::GetAtt": ["Q", "Arn"] })).toEqual({
      kind: "resolved",
      value: { "Fn::GetAtt": ["Q", "Arn"] },
    });
  });
});
