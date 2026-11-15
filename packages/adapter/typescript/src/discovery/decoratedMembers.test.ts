import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { decoratedCallablesOf } from "./decoratedMembers.js";

describe("decoratedCallablesOf", () => {
  it("names a quoted method and a quoted property by the key, without its quotes", () => {
    const file = createTestProject().createSourceFile(
      "/controller.ts",
      `
      declare function Get(): MethodDecorator & PropertyDecorator;
      class Users {
        @Get() "get-user"() {}
        @Get() "list-users" = () => [];
      }
      `,
    );
    const callables = decoratedCallablesOf(file.getClassOrThrow("Users"), [
      "Get",
    ]);

    expect(callables.map((callable) => callable.name)).toEqual([
      "get-user",
      "list-users",
    ]);
  });
});
