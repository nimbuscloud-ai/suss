import { describe, expect, it } from "vitest";

import { operationLines } from "./operationLines.js";

describe("operationLines", () => {
  it("keys each operation by its path and method, lower-cased", () => {
    const text = ["paths:", "  /pets:", "    GET:", "      responses: {}"].join(
      "\n",
    );

    expect(operationLines(text)).toEqual(new Map([["/pets get", 3]]));
  });

  it("gives nothing for a document with no paths", () => {
    expect(operationLines("openapi: 3.0.0\ninfo: {}\n")).toEqual(new Map());
  });

  it("skips an operation whose key is not a plain name", () => {
    const text = [
      "paths:",
      "  /pets:",
      "    ? [get]",
      "    : {}",
      "    post: {}",
    ].join("\n");

    expect(operationLines(text)).toEqual(new Map([["/pets post", 5]]));
  });

  it("skips a path whose item is not written out here", () => {
    const text = ["paths:", "  /pets: null", "  /owners:", "    get: {}"].join(
      "\n",
    );

    expect(operationLines(text)).toEqual(new Map([["/owners get", 4]]));
  });
});
