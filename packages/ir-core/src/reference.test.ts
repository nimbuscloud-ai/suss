import { describe, expect, it } from "vitest";

import { namesNothing } from "./namePattern.js";
import { referenceFromName, referenceName } from "./reference.js";

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
