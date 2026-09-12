import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { isDefaultedAt } from "./defaulted.js";

/** Whether the read written as `env.X` in the fixture has a fallback. */
function defaulted(source: string): boolean {
  const file = createTestProject().createSourceFile(
    "/probe.ts",
    `declare const env: Record<string, string>;\ndeclare function other(): string;\n${source}\n`,
  );
  const read = file
    .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    .find((access) => access.getText() === "env.X");
  if (read === undefined) {
    throw new Error("the fixture writes no `env.X` read");
  }
  return isDefaultedAt(read);
}

describe("isDefaultedAt", () => {
  it("says yes to `??` and `||`", () => {
    expect(defaulted('const a = env.X ?? "d";')).toBe(true);
    expect(defaulted("const a = env.X || other();")).toBe(true);
  });

  it("says yes in the middle of a chain", () => {
    expect(defaulted("const a = env.X || env.Y || other();")).toBe(true);
  });

  it("says no when the read is the last operand", () => {
    expect(defaulted("const a = other() ?? env.X;")).toBe(false);
  });

  it("says no to a read nothing falls back from", () => {
    expect(defaulted("const a = env.X;")).toBe(false);
    expect(defaulted("const a = env.X + other();")).toBe(false);
  });

  it("reads through parentheses and a cast", () => {
    expect(defaulted('const a = (env.X) ?? "d";')).toBe(true);
    expect(defaulted('const a = (env.X as string) ?? "d";')).toBe(true);
  });
});
