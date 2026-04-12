import { describe, expect, it } from "vitest";

import {
  collectAncestorBranches,
  collectEarlyReturns,
  createTypeScriptAdapter,
  discoverUnits,
  extractCodeStructure,
  extractRawBranches,
  findTerminals,
  parseConditionExpression,
  readContract,
  resolveSubject,
} from "./index.js";

describe("@suss/adapter-typescript barrel", () => {
  it("re-exports all public functions", () => {
    expect(typeof createTypeScriptAdapter).toBe("function");
    expect(typeof extractCodeStructure).toBe("function");
    expect(typeof extractRawBranches).toBe("function");
    expect(typeof collectAncestorBranches).toBe("function");
    expect(typeof collectEarlyReturns).toBe("function");
    expect(typeof discoverUnits).toBe("function");
    expect(typeof parseConditionExpression).toBe("function");
    expect(typeof resolveSubject).toBe("function");
    expect(typeof findTerminals).toBe("function");
    expect(typeof readContract).toBe("function");
  });
});
