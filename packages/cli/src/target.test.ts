import { describe, expect, it } from "vitest";

import { functionCallBinding } from "@suss/behavioral-ir";

import {
  allSummaries,
  dao,
  indexContract,
  route,
} from "./__fixtures__/oneThing.js";
import {
  boundarySpelling,
  namesBoundary,
  spellingTokens,
} from "./boundaryReach.js";
import { resolveTarget } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function resolved(spec: string): ReturnType<typeof resolveTarget> {
  return resolveTarget(spec, allSummaries);
}

describe("boundarySpelling", () => {
  it("spells a store the way the report that compares it does", () => {
    expect(
      boundarySpelling(indexContract.identity.boundaryBinding as never),
    ).toBe("aws.dynamodb:editions#by-publication");
  });

  it("spells a route the way the registry does", () => {
    expect(boundarySpelling(route.identity.boundaryBinding as never)).toBe(
      "GET /editions",
    );
  });
});

describe("spellingTokens", () => {
  it("cuts the separators between parts of a name and leaves the parts alone", () => {
    expect(spellingTokens("aws.dynamodb:editions#by-publication")).toEqual([
      "aws.dynamodb",
      "editions",
      "by-publication",
    ]);
    expect(spellingTokens("GET /users/{id}")).toEqual(["get", "users", "id"]);
    expect(spellingTokens("GET /users/:id")).toEqual(["get", "users", "id"]);
  });
});

describe("namesBoundary", () => {
  const index = indexContract.identity.boundaryBinding as never;

  it("takes a shorter spelling as covering the longer one", () => {
    expect(namesBoundary("aws.dynamodb:editions", index)).toBe(true);
    expect(namesBoundary("editions", index)).toBe(true);
    expect(namesBoundary("dynamodb:editions", index)).toBe(true);
    expect(namesBoundary("aws.dynamodb:editions#by-publication", index)).toBe(
      true,
    );
  });

  it("refuses a spelling with a word the boundary does not have", () => {
    expect(namesBoundary("aws.dynamodb:editions#by-author", index)).toBe(false);
    expect(namesBoundary("postgres:editions", index)).toBe(false);
    expect(namesBoundary("", index)).toBe(false);
  });
});

describe("resolveTarget", () => {
  it("takes anything with :: as a summary id", () => {
    const result = resolved("src/editions/dao.ts::byPublication");

    expect(result.matched).toBe(true);
    if (!result.matched) {
      return;
    }
    expect(result.target.kind).toBe("summary");
    expect(result.target.summaries).toEqual([dao]);
  });

  it("takes a tail of a summary id, so a workspace prefix is optional", () => {
    const result = resolveTarget("src/editions/dao.ts::byPublication", [
      {
        ...dao,
        identity: {
          ...dao.identity,
          id: "app::src/editions/dao.ts::byPublication",
        },
      },
    ]);

    expect(result.matched).toBe(true);
  });

  it("takes a package export boundary, which has :: in it too", () => {
    const caller: BehavioralSummary = {
      ...dao,
      kind: "caller",
      identity: {
        ...dao.identity,
        boundaryBinding: functionCallBinding({
          transport: "in-process",
          recognition: "packageImport",
          package: "@suss/checker",
          exportPath: ["checkAll"],
        }),
      },
    };
    const result = resolveTarget("fn:@suss/checker::checkAll", [caller]);

    expect(result.matched).toBe(true);
    if (!result.matched) {
      return;
    }
    expect(result.target.kind).toBe("boundary");
  });

  it("takes a file and a line, and picks the unit that covers the line", () => {
    const result = resolved("src/editions/dao.ts:45");

    expect(result.matched).toBe(true);
    if (!result.matched) {
      return;
    }
    expect(result.target.kind).toBe("line");
    expect(result.target.summaries).toEqual([dao]);
    expect(result.target.transitionIds).toEqual(["byPublication:query"]);
  });

  it("takes a file on its own, matching on whole path segments", () => {
    const result = resolved("dao.ts");

    expect(result.matched).toBe(true);
    if (!result.matched) {
      return;
    }
    expect(result.target.kind).toBe("file");
    expect(result.target.summaries).toHaveLength(2);

    expect(resolved("ao.ts").matched).toBe(false);
  });

  it("takes a boundary when the words are not a file here", () => {
    const result = resolved("aws.dynamodb:editions#by-publication");

    expect(result.matched).toBe(true);
    if (!result.matched) {
      return;
    }
    expect(result.target.kind).toBe("boundary");
    expect(result.target.touches.map((t) => t.touched.relation).sort()).toEqual(
      ["provides", "reads", "reads"],
    );
  });

  it("says what a file does cover when the line falls outside every unit", () => {
    const result = resolved("src/editions/dao.ts:5");

    expect(result.matched).toBe(false);
    if (result.matched) {
      return;
    }
    expect(result.message).toContain("Nothing here covers line 5");
    expect(result.message).toContain("30-60, 70-90");
  });

  it("says what things here are spelled like when nothing matches", () => {
    const result = resolved("kafka:orders");

    expect(result.matched).toBe(false);
    if (result.matched) {
      return;
    }
    expect(result.message).toContain("Nothing here is at kafka:orders");
    expect(result.message).toContain("aws.dynamodb:editions#by-publication");
  });

  it("asks for something to point at when given nothing", () => {
    const result = resolved("   ");

    expect(result.matched).toBe(false);
    if (result.matched) {
      return;
    }
    expect(result.message).toContain("needs something to point at");
  });
});
