import { describe, expect, it } from "vitest";

import { codeScopePath, fileInCodeScope } from "./codeScope.js";

describe("codeScopePath", () => {
  it("drops a leading ./ so a scope reads like a summary's file path", () => {
    expect(codeScopePath("./src/orders")).toBe("src/orders");
  });

  it("drops surrounding whitespace", () => {
    expect(codeScopePath("  src/orders  ")).toBe("src/orders");
  });

  it("gives one answer for the three trailing-slash spellings", () => {
    expect(codeScopePath("src/orders")).toBe("src/orders");
    expect(codeScopePath("src/orders/")).toBe("src/orders");
    expect(codeScopePath("src/orders///")).toBe("src/orders");
  });

  it("reads the project root as the empty scope", () => {
    expect(codeScopePath("")).toBe("");
    expect(codeScopePath("./")).toBe("");
    expect(codeScopePath("/")).toBe("");
  });
});

describe("fileInCodeScope", () => {
  it("covers files under the directory", () => {
    expect(fileInCodeScope("src/orders/handler.ts", "src/orders")).toBe(true);
    expect(fileInCodeScope("src/orders/lib/db.ts", "src/orders")).toBe(true);
  });

  it("stops at the segment boundary", () => {
    expect(fileInCodeScope("src/foobar/handler.ts", "src/foo")).toBe(false);
    expect(fileInCodeScope("src/orders-legacy/a.ts", "src/orders")).toBe(false);
  });

  it("does not match a directory that merely appears inside the path", () => {
    expect(fileInCodeScope("vendor/src/orders/a.ts", "src/orders")).toBe(false);
  });

  it("covers the directory named as a file", () => {
    expect(fileInCodeScope("src/orders", "src/orders")).toBe(true);
  });

  it("reads a scope the same however its trailing slash was written", () => {
    const spellings = ["src/orders", "src/orders/", "./src/orders/"];
    for (const scope of spellings) {
      expect(fileInCodeScope("src/orders/handler.ts", scope)).toBe(true);
      expect(fileInCodeScope("src/foobar/handler.ts", scope)).toBe(false);
    }
  });

  it("lets a scope naming the project root cover every file", () => {
    for (const scope of ["", ".", "./", "/"]) {
      expect(fileInCodeScope("src/orders/handler.ts", scope)).toBe(true);
    }
  });
});
