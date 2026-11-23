import { describe, expect, it } from "vitest";

import { calledMethod, methodName } from "./calledName.js";

describe("calledMethod", () => {
  it("is the last name before the arguments or the block", () => {
    expect(calledMethod("store.readRow(id)")).toBe("readRow");
    expect(calledMethod("items.each { |item| item }")).toBe("each");
    expect(calledMethod("lookup")).toBe("lookup");
  });
});

describe("methodName", () => {
  it("is the last part of a dotted name", () => {
    expect(methodName("Settings.lookup")).toBe("lookup");
    expect(methodName("fetch")).toBe("fetch");
  });
});
