import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { isDefaultedAt } from "./defaulted.js";

/** Whether each read written as `env.X` or `env["X"]` in the fixture has a fallback, in source order. */
function defaultedReads(source: string): boolean[] {
  const file = createTestProject().createSourceFile(
    "/probe.ts",
    `declare const env: Record<string, string | undefined>;\ndeclare function other(): string;\ndeclare function use(value: unknown): void;\n${source}\n`,
  );
  const reads = file
    .getDescendants()
    .filter(
      (node) =>
        (node.getKind() === SyntaxKind.PropertyAccessExpression ||
          node.getKind() === SyntaxKind.ElementAccessExpression) &&
        (node.getText() === "env.X" || node.getText() === 'env["X"]'),
    );
  if (reads.length === 0) {
    throw new Error("the fixture writes no `env.X` read");
  }
  return reads.map(isDefaultedAt);
}

/** Whether the first read written as `env.X` in the fixture has a fallback. */
function defaulted(source: string): boolean {
  return defaultedReads(source)[0] as boolean;
}

/** Whether `const { X } = env` in the fixture has a fallback. */
function destructuredDefaulted(source: string): boolean {
  const file = createTestProject().createSourceFile(
    "/probe.ts",
    `declare const env: Record<string, string | undefined>;\ndeclare function use(value: unknown): void;\n${source}\n`,
  );
  const element = file.getDescendantsOfKind(SyntaxKind.BindingElement)[0];
  if (element === undefined) {
    throw new Error("the fixture destructures nothing");
  }
  return isDefaultedAt(element);
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

describe("isDefaultedAt with a presence test", () => {
  it("says yes to a local used only inside the branch its test passes", () => {
    const source = `
      let resolved: string | undefined;
      function init() {
        const version = env.X;
        if (version) {
          resolved = version;
          return;
        }
        other();
      }`;
    expect(defaulted(source)).toBe(true);
  });

  it("says yes to a read that is only tested", () => {
    expect(defaulted("if (env.X) { other(); }")).toBe(true);
    expect(defaulted("while (!env.X) { other(); }")).toBe(true);
    expect(defaulted("const on = env.X === undefined;")).toBe(true);
    expect(defaulted('const on = typeof env.X !== "undefined";')).toBe(true);
    expect(defaulted("env.X && other();")).toBe(true);
  });

  it("says yes to both reads of a ternary that tests the read against undefined", () => {
    expect(
      defaultedReads('const region = env.X !== undefined ? env.X : "d";'),
    ).toEqual([true, true]);
    expect(
      defaultedReads("const region = env.X != null ? env.X : other();"),
    ).toEqual([true, true]);
  });

  it("says yes to a read after an if that returns when the value is missing", () => {
    const source = `
      function cache() {
        if (!env.X) {
          return other();
        }
        use(env.X);
      }`;
    expect(defaultedReads(source)).toEqual([true, true]);
  });

  it("says yes to a read the right side of an && guards", () => {
    expect(defaultedReads("const a = env.X && use(env.X);")).toEqual([
      false,
      true,
    ]);
  });

  it("says yes to a read an in test guards", () => {
    expect(defaulted('if ("X" in env) { use(env.X); }')).toBe(true);
  });

  it("says yes to a local whose missing branch leaves early", () => {
    const source = `
      function region() {
        const value = env.X;
        if (value === undefined) {
          return "d";
        }
        return value.trim();
      }`;
    expect(defaulted(source)).toBe(true);
  });

  it("says yes to a local that falls back where it is used", () => {
    expect(
      defaulted('function f() { const value = env.X; use(value ?? "d"); }'),
    ).toBe(true);
  });

  it("says yes to a destructured local used only inside its test", () => {
    expect(
      destructuredDefaulted(
        "function f() { const { X } = env; if (X) { use(X); } }",
      ),
    ).toBe(true);
    expect(
      destructuredDefaulted("function f() { const { X } = env; use(X); }"),
    ).toBe(false);
  });

  it("says no to a local used both inside and outside the test", () => {
    const source = `
      function f() {
        const value = env.X;
        if (value) {
          use(value);
        }
        use(value);
      }`;
    expect(defaulted(source)).toBe(false);
  });

  it("says no to a local used in the branch a missing value takes", () => {
    expect(
      defaulted(
        "function f() { const value = env.X; if (value) { other(); } else { use(value); } }",
      ),
    ).toBe(false);
  });

  it("says no when the test is on a different variable", () => {
    const source = `
      function f(flag: string | undefined) {
        const value = env.X;
        if (flag) {
          use(value);
        }
      }`;
    expect(defaulted(source)).toBe(false);
    expect(defaulted("if (env.Y) { use(env.X); }")).toBe(false);
  });

  it("says no when the missing branch falls through into a use", () => {
    const source = `
      function f() {
        if (!env.X) {
          other();
        }
        use(env.X);
      }`;
    expect(defaultedReads(source)).toEqual([true, false]);
  });

  it("says no when the missing branch throws", () => {
    const source = `
      function f() {
        const value = env.X;
        if (!value) {
          throw new Error("X is required");
        }
        use(value);
      }`;
    expect(defaulted(source)).toBe(false);
  });

  it("says no when the present branch leaves and the code after the test throws", () => {
    const arrow = `
      const url = (): string => {
        const value = env.X;
        if (value) return value;
        throw new Error("X is not set");
      };`;
    expect(defaulted(arrow)).toBe(false);
    const direct = `
      function f() {
        if (env.X) {
          return env.X;
        }
        throw new Error("X is not set");
      }`;
    expect(defaultedReads(direct)).toEqual([false, false]);
  });

  it("says no when the branch a missing value takes throws, however the test is written", () => {
    expect(
      defaulted('function f() { if (!env.X) { throw new Error("X"); } }'),
    ).toBe(false);
    expect(
      defaulted(
        'function f() { if (env.X === undefined) throw new Error("X"); }',
      ),
    ).toBe(false);
    expect(
      defaultedReads(
        'function f() { if (env.X) { use(env.X); } else { throw new Error("X"); } }',
      ),
    ).toEqual([false, false]);
    expect(
      defaulted(
        'function f(a: boolean) { if (env.X) { use(env.X); } else if (a) { return; } else { throw new Error("X"); } }',
      ),
    ).toBe(false);
  });

  it("says yes when the code after the test leaves without throwing", () => {
    const source = `
      function f(): string {
        if (env.X) {
          return env.X;
        }
        if (other()) {
          throw new Error("unrelated");
        }
        return "d";
      }`;
    expect(defaultedReads(source)).toEqual([true, true]);
    expect(
      defaulted(
        "function f() { const v = { ...(env.X ? { x: env.X } : {}) }; use(v); }",
      ),
    ).toBe(true);
  });

  it("says no to a strict comparison with null, which lets undefined through", () => {
    expect(
      defaultedReads("const a = env.X !== null ? env.X : other();"),
    ).toEqual([false, false]);
  });

  it("follows a test through &&, ||, a while loop and a bracket read", () => {
    const source = `
      declare const ready: boolean;
      function f() {
        if (env.X && ready) {
          use(env.X);
        }
        while (env.X) {
          use(env.X);
        }
        if ("X" in env) {
          use(env["X"]);
        }
        if (!env.X || !ready) {
          return;
        }
        use(env.X);
      }`;
    expect(defaultedReads(source)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("finds nothing about the read in a test on anything else", () => {
    const source = `
      declare const count: number;
      declare const settings: Record<string, string>;
      function f() {
        if (count > 3) {
          use(env.X);
        }
        if (typeof env.X === "string") {
          use(env.X);
        }
        const value = env.X;
        if ("X" in settings) {
          use(value);
        }
      }`;
    expect(defaultedReads(source)).toEqual([false, true, false, false]);
  });

  it("says no to a local at module level, whose uses can be in another file", () => {
    expect(
      defaulted("export const value = env.X; if (value) { use(value); }"),
    ).toBe(false);
  });
});
