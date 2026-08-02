import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { endLineOf, lineRangeOf, startLineOf } from "./lines.js";

function firstFunction(text: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("a.ts", text);
  return sf.getFunctions()[0];
}

describe("line numbers", () => {
  it("counts the first line as one", () => {
    const func = firstFunction("function a() {}\n");
    expect(startLineOf(func)).toBe(1);
    expect(endLineOf(func)).toBe(1);
  });

  it("reports where a multi-line function opens and closes", () => {
    const func = firstFunction("\n\nfunction a() {\n  return 1;\n}\n");
    expect(lineRangeOf(func)).toEqual({ start: 3, end: 5 });
  });

  it("starts at the declaration rather than its doc comment", () => {
    const func = firstFunction("/** doc */\nfunction a() {}\n");
    expect(startLineOf(func)).toBe(2);
  });

  it("agrees with ts-morph's own accessors", () => {
    const func = firstFunction(
      "// leading\n\nexport function a(\n  x: number,\n) {\n  return x;\n}\n",
    );
    expect(startLineOf(func)).toBe(func.getStartLineNumber());
    expect(endLineOf(func)).toBe(func.getEndLineNumber());
  });
});
