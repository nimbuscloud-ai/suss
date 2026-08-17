import { describe, expect, it } from "vitest";

import {
  namePatternFromSub,
  namePatternKey,
  namesAgree,
  namesNothing,
} from "./namePattern.js";

describe("reading a name a template builds", () => {
  it("turns each substitution into a hole", () => {
    expect(namePatternFromSub("${StageName}-orders-v1")).toBe(
      "{StageName}-orders-v1",
    );
  });

  it("takes the template out of the form that also states variables", () => {
    expect(
      namePatternFromSub(["${Env}-orders-v1", { Env: { Ref: "StageName" } }]),
    ).toBe("{Env}-orders-v1");
  });

  it("reads a name with an escaped substitution as nothing, since braces mean a hole here", () => {
    expect(namePatternFromSub("${!Literal}-orders")).toBeNull();
  });

  it("reads a name with nothing to fill in as itself", () => {
    expect(namePatternFromSub("orders-v1")).toBe("orders-v1");
  });

  it("reads anything that is not a template as nothing", () => {
    expect(namePatternFromSub({ Ref: "OrdersTable" })).toBeNull();
    expect(namePatternFromSub([{ Ref: "OrdersTable" }])).toBeNull();
  });
});

describe("comparing two names", () => {
  it("agrees when both sides parameterize the same fixed text", () => {
    expect(namesAgree("{stage}-orders-v1", "{StageName}-orders-v1")).toBe(true);
  });

  it("disagrees when the fixed text differs", () => {
    expect(namesAgree("{stage}-orders-v1", "{stage}-orders-v2")).toBe(false);
    expect(namesAgree("{stage}-orders-v1", "{stage}-invoices-v1")).toBe(false);
  });

  it("disagrees when a hole is in a different place", () => {
    expect(namesAgree("{stage}-orders", "orders-{stage}")).toBe(false);
  });

  it("agrees when one side hardcodes what the other parameterizes", () => {
    expect(namesAgree("{StageName}-orders-v1", "prod-orders-v1")).toBe(true);
    expect(namesAgree("prod-orders-v1", "{StageName}-orders-v1")).toBe(true);
  });

  it("refuses a concrete name the pattern's fixed text does not fit", () => {
    expect(namesAgree("{StageName}-orders-v1", "prod-invoices-v1")).toBe(false);
    expect(namesAgree("{StageName}-orders-v1", "orders-v1")).toBe(false);
  });

  it("compares two concrete names as themselves", () => {
    expect(namesAgree("orders-v1", "orders-v1")).toBe(true);
    expect(namesAgree("orders-v1", "orders-v2")).toBe(false);
  });

  it("reads a name whose fixed text has regex punctuation in it as text", () => {
    expect(namesAgree("{stage}.orders+v1", "prod.orders+v1")).toBe(true);
    expect(namesAgree("{stage}.orders+v1", "prodXordersYv1")).toBe(false);
  });

  it("keys two spellings of the same pattern the same way", () => {
    expect(namePatternKey("{stage}-orders-v1")).toBe(
      namePatternKey("{StageName}-orders-v1"),
    );
    expect(namePatternKey("orders-v1")).toBe("orders-v1");
  });
});

describe("a name that says only where to look", () => {
  it("agrees with nothing, since it would otherwise agree with everything", () => {
    expect(namesAgree("{location.bucket}", "reports-prod")).toBe(false);
    expect(namesAgree("reports-prod", "{location.bucket}")).toBe(false);
    expect(namesAgree("{location.bucket}", "{stage}-reports")).toBe(false);
  });

  it("is one hole and nothing else", () => {
    expect(namesNothing("{bucket}")).toBe(true);
    expect(namesNothing("{stage}-orders")).toBe(false);
    expect(namesNothing("orders")).toBe(false);
  });

  it("still agrees when both sides state the same fixed text", () => {
    expect(namesAgree("{stage}-orders", "staging-orders")).toBe(true);
  });
});
