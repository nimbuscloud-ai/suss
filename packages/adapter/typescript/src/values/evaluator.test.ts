// Each test is one way production code writes a value, evaluated
// through the TypeScript lowering and rows. The fixture assigns the
// expression under test to `subject`.
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";
import { constantOf, literalOf, piecesOf, type Value } from "@suss/values";

import { ResolutionStore } from "../facts/store.js";
import { evaluatedValue } from "./evaluator.js";

interface Fixture {
  readonly files?: Record<string, string>;
  readonly store?: boolean;
}

function subjectOf(source: string, fixture: Fixture = {}): Value {
  const project = createTestProject();
  for (const [path, text] of Object.entries(fixture.files ?? {})) {
    project.createSourceFile(path, text);
  }
  const file = project.createSourceFile("/repo.ts", source);
  const initializer = file
    .getVariableDeclarationOrThrow("subject")
    .getInitializerOrThrow();
  const store = fixture.store === false ? undefined : new ResolutionStore();
  return evaluatedValue(initializer, store);
}

function literal(source: string, fixture?: Fixture): string | null {
  return literalOf(subjectOf(source, fixture));
}

function constant(source: string, fixture?: Fixture) {
  return constantOf(subjectOf(source, fixture));
}

describe("literals and names", () => {
  it("reads every literal kind", () => {
    expect(literal(`export const subject = "/a";`)).toBe("/a");
    expect(constant("export const subject = 3;")).toBe(3);
    expect(constant("export const subject = true;")).toBe(true);
    expect(constant("export const subject = false;")).toBe(false);
    expect(constant("export const subject = null;")).toBe(null);
    expect(constant("export const subject = undefined;")).toBe(undefined);
  });

  it("reads a local name without a store", () => {
    expect(
      literal(`const base = "/v1"; export const subject = base + "/x";`, {
        store: false,
      }),
    ).toBe("/v1/x");
  });

  it("reads a template around a number", () => {
    expect(literal("const n = 2; export const subject = `/v${n}/x`;")).toBe(
      "/v2/x",
    );
  });

  it("names the hole after a parameter it cannot read", () => {
    const value = subjectOf(
      "declare const cfg: { stage: string }; export const subject = `/${cfg.stage}/x`;",
    );
    expect(piecesOf(value)).toEqual([
      { kind: "text", options: ["/"] },
      { kind: "hole", name: "stage", range: "one" },
      { kind: "text", options: ["/x"] },
    ]);
  });
});

describe("records and arrays", () => {
  it("reads a field through every way of spelling a key", () => {
    const source = `
      const key = "d";
      const extra = { e: "/e" };
      const c = "/c";
      const paths = { a: "/a", "b": "/b", c, [key]: "/d", 1: "/one", ...extra };
      export const subject = paths.a + paths.b + paths.c + paths.d + paths[1] + paths.e;
    `;
    expect(literal(source)).toBe("/a/b/c/d/one/e");
  });

  it("reads an element by index and a spread", () => {
    expect(
      literal(`
        const rest = ["/c"];
        const parts = ["/a", "/b", ...rest];
        export const subject = parts[0] + parts[2];
      `),
    ).toBe("/a/c");
  });

  it("leaves a property without an initializer out of the record", () => {
    expect(
      literal(`
        const paths = { get a() { return "/x"; }, b: "/b" };
        export const subject = paths.b;
      `),
    ).toBe("/b");
  });
});

describe("operators", () => {
  it("compares constants", () => {
    expect(constant("export const subject = 1 === 1;")).toBe(true);
    expect(constant("export const subject = 1 == 2;")).toBe(false);
    expect(constant("export const subject = 1 !== 1;")).toBe(false);
    expect(constant("export const subject = 1 != 2;")).toBe(true);
    expect(constant("export const subject = !true;")).toBe(false);
  });

  it("takes the resolvable side of a fallback", () => {
    expect(
      literal(`declare const x: string; export const subject = x ?? "/b";`),
    ).toBe("/b");
    expect(
      literal(`declare const x: string; export const subject = "/a" ?? x;`),
    ).toBe("/a");
    expect(
      literal(`declare const x: string; export const subject = x || "/b";`),
    ).toBe("/b");
  });

  it("folds a fallback whose both sides are known", () => {
    expect(literal(`export const subject = null ?? "/b";`)).toBe("/b");
    expect(literal(`export const subject = "/a" ?? "/b";`)).toBe("/a");
    expect(literal(`export const subject = "" || "/b";`)).toBe("/b");
    expect(literal(`export const subject = "/a" || "/b";`)).toBe("/a");
    expect(literal(`export const subject = true && "/b";`)).toBe("/b");
    expect(constant(`export const subject = false && "/b";`)).toBe(false);
  });

  it("reads a conditional as both arms", () => {
    const value = subjectOf(
      `declare const flag: boolean; export const subject = flag ? "/a" : "/b";`,
    );
    expect(piecesOf(value)).toEqual([{ kind: "text", options: ["/a", "/b"] }]);
  });

  it("does not read an arithmetic prefix or an assignment expression", () => {
    expect(subjectOf("export const subject = -1;").kind).toBe("hole");
    expect(subjectOf("let x = 1; export const subject = (x = 2);").kind).toBe(
      "hole",
    );
  });
});

describe("string and array methods", () => {
  it("reads toString and concat on a string", () => {
    expect(literal(`export const subject = "/a".toString();`)).toBe("/a");
    expect(literal(`export const subject = "/a".concat("/b", "/c");`)).toBe(
      "/a/b/c",
    );
  });

  it("reads toString on a number", () => {
    expect(literal("const n = 3; export const subject = n.toString();")).toBe(
      "3",
    );
  });

  it("reads String() as text", () => {
    expect(literal("export const subject = String(3);")).toBe("3");
    expect(literal("export const subject = String(3);", { store: false })).toBe(
      "3",
    );
  });

  it("sees a push through the name that joins", () => {
    expect(
      literal(`
        const parts = ["a"];
        parts.push("b");
        export const subject = parts.join("/");
      `),
    ).toBe("a/b");
  });

  it("reads concat on an array", () => {
    expect(
      literal(`
        const parts = ["a"].concat(["b"], ["c"]);
        export const subject = parts.join("/");
      `),
    ).toBe("a/b/c");
  });

  it("widens an array a loop pushes to", () => {
    const value = subjectOf(`
      declare const names: string[];
      const parts: string[] = ["a"];
      for (const name of names) {
        parts.push(name);
      }
      export const subject = parts.join("/");
    `);
    expect(value.kind).toBe("string");
    expect(piecesOf(value).some((piece) => piece.kind === "hole")).toBe(true);
  });
});

describe("path.join", () => {
  it("folds literal segments the way the library does", () => {
    expect(
      literal(`
        import { join } from "node:path";
        export const subject = join("/a/", "b", "../c");
      `),
    ).toBe("/a/c");
  });

  it("joins around a hole with a slash", () => {
    const value = subjectOf(`
      import path from "path";
      declare const dir: string;
      export const subject = path.join("/a", dir);
    `);
    expect(piecesOf(value)).toEqual([
      { kind: "text", options: ["/a/"] },
      { kind: "hole", name: "dir", range: "one" },
    ]);
  });

  it("does not read a join that is the project's own function", () => {
    expect(
      subjectOf(`
        function join(a: string, b: string): string { return a; }
        declare const x: string;
        export const subject = join(x, "b");
      `).kind,
    ).toBe("hole");
  });

  it("does not read a callee that is not a name", () => {
    expect(
      subjectOf(`
        declare const make: () => (a: string) => string;
        export const subject = make()("a");
      `).kind,
    ).toBe("hole");
    expect(
      subjectOf(`
        declare const make: () => { path: { join(a: string): string } };
        export const subject = make().path.join("a");
      `).kind,
    ).toBe("hole");
  });
});

describe("statements", () => {
  it("applies a compound assignment", () => {
    expect(literal(`let p = "/a"; p += "/b"; export const subject = p;`)).toBe(
      "/a/b",
    );
  });

  it("reads through if, else and switch", () => {
    const value = subjectOf(`
      declare const flag: boolean;
      declare const n: number;
      let p = "/a";
      if (flag) { p = "/b"; } else p = "/c";
      switch (n) {
        case 1: p += "/1"; break;
        default: p += "/d";
      }
      export const subject = p;
    `);
    expect(piecesOf(value)).toEqual([
      { kind: "text", options: ["/b", "/c"] },
      { kind: "text", options: ["/1", "/d"] },
    ]);
  });

  it("reads through a standalone block and a try", () => {
    expect(
      literal(`
        let p = "/a";
        { p = "/b"; }
        try { p += "/c"; } finally { p += "/d"; }
        export const subject = p;
      `),
    ).toBe("/b/c/d");
  });

  it("reads destructured names as unknown", () => {
    const value = subjectOf(`
      declare const pair: { a: string; b: string[] };
      const { a } = pair;
      const [b] = pair.b;
      export const subject = a + b;
    `);
    expect(piecesOf(value)).toEqual([
      { kind: "hole", name: "a", range: "one" },
      { kind: "hole", name: "b", range: "one" },
    ]);
  });

  it("widens a name a nested function writes", () => {
    expect(
      subjectOf(`
        let p = "/a";
        function later() { p = "/b"; }
        export const subject = p;
      `).kind,
    ).toBe("hole");
    expect(
      subjectOf(`
        let n = 1;
        const bump = () => { n++; };
        export const subject = n;
      `).kind,
    ).toBe("hole");
    expect(
      piecesOf(
        subjectOf(`
          const parts = ["a"];
          const add = () => { parts.push("b"); };
          export const subject = parts.join("/");
        `),
      ),
    ).toEqual([{ kind: "hole", name: "value", range: "any" }]);
  });
});

describe("functions", () => {
  it("inlines a function with a block body", () => {
    expect(
      literal(`
        function route(p: string): string {
          const base = "/v1";
          return base + p;
        }
        export const subject = route("/x");
      `),
    ).toBe("/v1/x");
  });

  it("inlines an arrow with an expression body", () => {
    expect(
      literal(`
        const route = (p: string) => "/v1" + p;
        export const subject = route("/x");
      `),
    ).toBe("/v1/x");
  });

  it("reads a function from another file", () => {
    expect(
      literal(
        `
          import { route } from "./routes";
          export const subject = route("/x");
        `,
        {
          files: {
            "/routes.ts": `export function route(p: string) { return "/v1" + p; }`,
          },
        },
      ),
    ).toBe("/v1/x");
  });

  it("skips a destructured parameter", () => {
    expect(
      subjectOf(`
        function route({ p }: { p: string }): string { return p; }
        export const subject = route({ p: "/x" });
      `).kind,
    ).toBe("hole");
  });

  it("reads a constructed value as unknown", () => {
    expect(subjectOf(`export const subject = new URL("/a");`).kind).toBe(
      "hole",
    );
  });
});
