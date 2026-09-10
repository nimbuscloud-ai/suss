// Each test evaluates the argument written as `subject` the way a
// binding extraction reads a path off a call site.
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { pathFromArgument, pathFromProperty } from "./routePath.js";

function subjectOf(source: string) {
  const project = createTestProject();
  const file = project.createSourceFile("/repo.ts", source);
  return file.getVariableDeclarationOrThrow("subject").getInitializerOrThrow();
}

describe("pathFromArgument", () => {
  it("reads a literal and a template with a parameter hole", () => {
    expect(pathFromArgument(subjectOf(`const subject = "/users";`))).toBe(
      "/users",
    );
    expect(
      pathFromArgument(
        subjectOf(
          "declare const id: string; const subject = \`/users/\${id}\`;",
        ),
      ),
    ).toBe("/users/{id}");
  });
});

describe("pathFromProperty", () => {
  it("reads the named field of an object written in place", () => {
    const arg = subjectOf(`const subject = { url: "/users", method: "post" };`);
    expect(pathFromProperty(arg, "url", new ResolutionStore())).toBe("/users");
  });

  it("reads the field through a spread from a module-level object", () => {
    const arg = subjectOf(
      `const base = { url: "/users/1" }; const subject = { ...base, method: "get" };`,
    );
    expect(pathFromProperty(arg, "url", new ResolutionStore())).toBe(
      "/users/1",
    );
  });

  it("is undefined when the field is missing or the argument is not an object", () => {
    expect(
      pathFromProperty(subjectOf(`const subject = { method: "get" };`), "url"),
    ).toBeUndefined();
    expect(
      pathFromProperty(subjectOf(`const subject = "/users";`), "url"),
    ).toBeUndefined();
  });
});
