import { describe, expect, it } from "vitest";

import {
  boundaryNameString,
  fixedTextLength,
  hasNameHole,
  namePatternFromSub,
  namePatternKey,
  namesAgree,
  namesNothing,
  parseBoundaryName,
  patternHole,
  referenceFromName,
  referenceName,
  referenceOf,
} from "./boundaryName.js";

describe("what a name string means", () => {
  it("reads a name with no holes as the name itself", () => {
    expect(parseBoundaryName("orders-v1")).toEqual({
      type: "literal",
      value: "orders-v1",
    });
    expect(parseBoundaryName("")).toEqual({ type: "literal", value: "" });
  });

  it("reads fixed text with holes as a pattern", () => {
    expect(parseBoundaryName("{stage}-orders-v1")).toEqual({
      type: "pattern",
      parts: [
        { type: "hole", label: "stage" },
        { type: "text", text: "-orders-v1" },
      ],
    });
  });

  it("reads two holes with nothing between them as a pattern", () => {
    expect(parseBoundaryName("{env}{name}")).toEqual({
      type: "pattern",
      parts: [
        { type: "hole", label: "env" },
        { type: "hole", label: "name" },
      ],
    });
  });

  it("reads one hole and nothing else as a reference", () => {
    expect(parseBoundaryName("{location.bucket}")).toEqual({
      type: "reference",
      path: ["location", "bucket"],
    });
    expect(parseBoundaryName("{ORDER_TABLE}")).toEqual({
      type: "reference",
      path: ["ORDER_TABLE"],
    });
  });

  it("reads a brace nothing closes as text", () => {
    expect(parseBoundaryName("orders-{v1")).toEqual({
      type: "literal",
      value: "orders-{v1",
    });
  });

  it("keeps a malformed reference a reference, so it still pairs with nothing", () => {
    expect(parseBoundaryName("{}")).toEqual({ type: "reference", path: [""] });
    expect(namesAgree("{}", "orders")).toBe(false);
  });
});

describe("printing a name back", () => {
  it("returns every string it parsed, byte for byte", () => {
    const names = [
      "orders-v1",
      "{stage}-orders-v1",
      "orders-{region}",
      "{env}{name}",
      "{location.bucket}",
      "{ORDER_TABLE}",
      "{}",
      "",
      "orders-{v1",
      "a-{x}-b-{y}-c",
    ];
    for (const name of names) {
      expect(boundaryNameString(parseBoundaryName(name))).toBe(name);
    }
  });

  it("spells a hole the way the parser reads one", () => {
    expect(patternHole("stage")).toBe("{stage}");
    expect(parseBoundaryName(`x-${patternHole("stage")}`)).toEqual({
      type: "pattern",
      parts: [
        { type: "text", text: "x-" },
        { type: "hole", label: "stage" },
      ],
    });
  });
});

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

describe("how far a hole reaches", () => {
  it("lets a hole at the end cover a value with a separator inside it", () => {
    expect(namesAgree("orders-{region}", "orders-us-east-1")).toBe(true);
  });

  it("lets a hole cover anything when a letter comes next, since nothing separates them", () => {
    expect(namesAgree("{env}publications", "prodpublications")).toBe(true);
    expect(namesAgree("{env}publications", "prod-creator-publications")).toBe(
      true,
    );
  });

  it("compares two patterns on their fixed text, whatever a hole could cover", () => {
    expect(namesAgree("{env}-publications-v1", "{stage}-publications-v1")).toBe(
      true,
    );
    expect(
      namesAgree("{env}-publications-v1", "{stage}-creator-publications-v1"),
    ).toBe(false);
  });

  it("still refuses a name with no room for the value", () => {
    expect(namesAgree("{env}-orders", "-orders")).toBe(false);
  });
});

describe("how much of a name its writer stated", () => {
  it("counts the fixed text and not the holes", () => {
    expect(fixedTextLength("prod-orders-v1")).toBe(14);
    expect(fixedTextLength("{env}-orders-v1")).toBe(10);
    expect(fixedTextLength("{env}-creator-orders-v1")).toBe(18);
    expect(fixedTextLength("{env}")).toBe(0);
  });

  it("ranks the pattern that states more of the name above the one that states less", () => {
    expect(fixedTextLength("orders-blue-{suffix}")).toBeGreaterThan(
      fixedTextLength("orders-{suffix}"),
    );
  });
});

describe("whether a name is finished", () => {
  it("is not, when any part waits for deploy time or for grounding", () => {
    expect(hasNameHole("orders-v1")).toBe(false);
    expect(hasNameHole("{stage}-orders-v1")).toBe(true);
    expect(hasNameHole("{ORDER_TABLE}")).toBe(true);
  });
});

describe("a reference to a field of an argument", () => {
  it("writes the whole path from the parameter", () => {
    expect(referenceName({ root: "location", fields: ["bucket"] })).toBe(
      "{location.bucket}",
    );
  });

  it("reads back the parameter and the fields inside it", () => {
    expect(referenceFromName("{location.bucket}")).toEqual({
      root: "location",
      fields: ["bucket"],
    });
  });

  it("survives a round trip through a name, however deep", () => {
    const reference = { root: "input", fields: ["location", "bucket"] };
    const name = referenceName(reference) as string;

    expect(referenceFromName(name)).toEqual(reference);
  });
});

describe("a reference to a variable the deployment sets", () => {
  it("writes the variable and no fields", () => {
    expect(referenceName({ root: "ORDER_TABLE", fields: [] })).toBe(
      "{ORDER_TABLE}",
    );
  });

  it("reads back the variable and no fields", () => {
    expect(referenceFromName("{ORDER_TABLE}")).toEqual({
      root: "ORDER_TABLE",
      fields: [],
    });
  });
});

describe("a name that is not a reference", () => {
  it("states a name of its own", () => {
    expect(referenceFromName("orders-v1")).toBeNull();
  });

  it("has fixed text around the hole", () => {
    expect(referenceFromName("{stage}-orders")).toBeNull();
  });

  it("points at nothing", () => {
    expect(referenceFromName("{}")).toBeNull();
    expect(referenceFromName("{location.}")).toBeNull();
  });
});

describe("a reference with a part missing", () => {
  it("is written as no name at all", () => {
    expect(referenceName({ root: "", fields: [] })).toBeNull();
    expect(referenceName({ root: "location", fields: [""] })).toBeNull();
  });

  it("is read back as a place nobody can answer for", () => {
    expect(referenceOf(parseBoundaryName("{location..bucket}"))).toBeNull();
    expect(referenceOf(parseBoundaryName("{stage}-orders"))).toBeNull();
  });
});

describe("every reference", () => {
  it("pairs with nothing until something settles it", () => {
    const name = referenceName({
      root: "location",
      fields: ["bucket"],
    }) as string;

    expect(namesNothing(name)).toBe(true);
  });
});
