import { SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { resolveDecl } from "./functionBehind.js";

describe("resolveDecl", () => {
  it("names a quoted method by the key, without its quotes", () => {
    const file = createTestProject().createSourceFile(
      "/probe.ts",
      `export const handlers = { "do-it"() { return 1; } };`,
    );
    const method = file.getFirstDescendantByKindOrThrow(
      SyntaxKind.MethodDeclaration,
    );

    expect(resolveDecl(method, "doIt")?.name).toBe("do-it");
  });
});
