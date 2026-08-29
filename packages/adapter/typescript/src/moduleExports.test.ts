import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { ResolutionStore } from "./facts/store.js";
import {
  exportedDeclarationsOf,
  resolveAliasedSymbol,
} from "./moduleExports.js";

// Deep enough that resolving the chain in one recursive descent
// overflows the call stack.
const OVERFLOW_DEPTH = 2000;

/**
 * `m0.ts` declares `handler`, every `m<i>.ts` re-exports it from
 * `m<i-1>.ts`, and `top.ts` re-exports it from the deepest link.
 */
function reExportChain(project: Project, depth: number): void {
  project.createSourceFile(
    "src/m0.ts",
    "export function handler(): number {\n  return 0;\n}\n",
  );
  for (let i = 1; i <= depth; i += 1) {
    project.createSourceFile(
      `src/m${i}.ts`,
      `export { handler } from "./m${i - 1}.js";\n`,
    );
  }
  project.createSourceFile(
    "src/top.ts",
    `export { handler } from "./m${depth}.js";\n`,
  );
}

describe("exportedDeclarationsOf", () => {
  it("names what a module exports, following a re-export", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("src/inner.ts", "export function deep() {}\n");
    const sf = project.createSourceFile(
      "src/outer.ts",
      "export { deep } from './inner.js';\nexport const shallow = 1;\n",
    );
    const exported = exportedDeclarationsOf(sf, new ResolutionStore());
    expect([...exported.keys()].sort()).toEqual(["deep", "shallow"]);
    expect(exported.get("deep")?.[0].getSourceFile().getBaseName()).toBe(
      "inner.ts",
    );
  });

  it("answers a repeated ask with the map it already built", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("src/a.ts", "export const x = 1;\n");
    const store = new ResolutionStore();
    expect(exportedDeclarationsOf(sf, store)).toBe(
      exportedDeclarationsOf(sf, store),
    );
  });

  it("answers a file whose text was replaced from the new parse", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const first = project.createSourceFile(
      "src/b.ts",
      "export const before = 1;\n",
      { overwrite: true },
    );
    exportedDeclarationsOf(first, new ResolutionStore());
    // ts-morph reuses the same wrapper and forgets every node the first
    // parse produced. A store lives for one run, so the rewritten file
    // is a new run's ask.
    const second = project.createSourceFile(
      "src/b.ts",
      "export const after = 2;\n",
      { overwrite: true },
    );
    const exported = exportedDeclarationsOf(second, new ResolutionStore());
    expect([...exported.keys()]).toEqual(["after"]);
    expect(exported.get("after")?.[0].getText()).toContain("after = 2");
  });

  it("follows a re-export chain deeper than the call stack", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    reExportChain(project, OVERFLOW_DEPTH);
    // Asking for the top of the chain first is the order that used to
    // overflow the stack.
    const top = project.getSourceFileOrThrow("src/top.ts");
    const exported = exportedDeclarationsOf(top, new ResolutionStore());
    const handler = exported.get("handler")?.[0];
    expect(handler !== undefined && Node.isFunctionDeclaration(handler)).toBe(
      true,
    );
    expect(handler?.getSourceFile().getBaseName()).toBe("m0.ts");
  });

  it("follows a chain of import-then-export pairs at the same depth", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "src/m0.ts",
      "export function handler(): number {\n  return 0;\n}\n",
    );
    for (let i = 1; i <= OVERFLOW_DEPTH; i += 1) {
      project.createSourceFile(
        `src/m${i}.ts`,
        `import { handler } from "./m${i - 1}.js";\nexport { handler };\n`,
      );
    }
    const top = project.createSourceFile(
      "src/top.ts",
      `export { handler } from "./m${OVERFLOW_DEPTH}.js";\n`,
    );
    const handler = exportedDeclarationsOf(top, new ResolutionStore()).get(
      "handler",
    )?.[0];
    expect(handler !== undefined && Node.isFunctionDeclaration(handler)).toBe(
      true,
    );
    expect(handler?.getSourceFile().getBaseName()).toBe("m0.ts");
  });

  it("answers both arms of a re-export diamond with the one origin", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "src/origin.ts",
      "export function handler(): number {\n  return 0;\n}\n",
    );
    for (const arm of ["a", "b"]) {
      project.createSourceFile(
        `src/${arm}0.ts`,
        'export { handler } from "./origin.js";\n',
      );
      for (let i = 1; i <= 3; i += 1) {
        project.createSourceFile(
          `src/${arm}${i}.ts`,
          `export { handler } from "./${arm}${i - 1}.js";\n`,
        );
      }
    }
    const top = project.createSourceFile(
      "src/top.ts",
      'export { handler as handlerA } from "./a3.js";\nexport { handler as handlerB } from "./b3.js";\n',
    );
    const exported = exportedDeclarationsOf(top, new ResolutionStore());
    for (const name of ["handlerA", "handlerB"]) {
      expect(exported.get(name)?.[0]?.getSourceFile().getBaseName()).toBe(
        "origin.ts",
      );
    }
  });

  it("answers a re-export cycle with nothing instead of not returning", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("src/a.ts", 'export { x } from "./b.js";\n');
    project.createSourceFile("src/b.ts", 'export { x } from "./a.js";\n');
    const top = project.createSourceFile(
      "src/top.ts",
      'export { x } from "./a.js";\n',
    );
    const exported = exportedDeclarationsOf(top, new ResolutionStore());
    expect(exported.get("x") ?? []).toEqual([]);
  });
});

describe("resolveAliasedSymbol", () => {
  it("resolves an import of a chain deeper than the call stack", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    reExportChain(project, OVERFLOW_DEPTH);
    const consumer = project.createSourceFile(
      "src/zconsumer.ts",
      `import { handler } from "./m${OVERFLOW_DEPTH}.js";\nexport const use = handler;\n`,
    );
    const imported = consumer
      .getImportDeclarations()[0]
      ?.getNamedImports()[0]
      ?.getNameNode()
      .getSymbol();
    expect(imported).toBeDefined();
    if (imported === undefined) {
      return;
    }

    const resolved = resolveAliasedSymbol(imported);
    expect(resolved?.getDeclarations()[0]?.getSourceFile().getBaseName()).toBe(
      "m0.ts",
    );
  });

  it("answers undefined for a symbol that aliases nothing", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("src/c.ts", "export const y = 1;\n");
    const symbol = sf.getVariableDeclarationOrThrow("y").getSymbolOrThrow();
    expect(resolveAliasedSymbol(symbol)).toBeUndefined();
  });
});
