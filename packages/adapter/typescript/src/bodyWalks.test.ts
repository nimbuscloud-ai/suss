import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { extractRawBranches } from "./assembly.js";
import { withDefinitions } from "./shapes/definitions.js";

import type { TerminalPattern } from "@suss/extractor";

const returnShape: TerminalPattern[] = [
  {
    kind: "response",
    match: { type: "returnShape", requiredProperties: ["status", "body"] },
    extraction: {
      statusCode: { from: "property", name: "status" },
      body: { from: "property", name: "body" },
    },
  },
];

function handlerReturningUser() {
  const project = createTestProject();
  const file = project.createSourceFile(
    "handler.ts",
    `
    interface User { id: string; name: string }
    declare function load(): User;
    export async function handler() {
      const user: User = load();
      return { status: 200, body: user };
    }
    `,
  );
  return file.getFunctionOrThrow("handler");
}

describe("walking one body twice", () => {
  it("writes the named types the first walk defined into the second unit's table", () => {
    const handler = handlerReturningUser();
    const first = withDefinitions(() =>
      extractRawBranches(handler, returnShape),
    );
    const second = withDefinitions(() =>
      extractRawBranches(handler, returnShape),
    );

    expect(first.definitions).not.toBeNull();
    expect(second.definitions).toEqual(first.definitions);
    expect(second.value.branches).toEqual(first.value.branches);
  });

  it("hands each unit its own copy, so one unit's edits never reach another", () => {
    const handler = handlerReturningUser();
    const first = withDefinitions(() =>
      extractRawBranches(handler, returnShape),
    );
    const expected = structuredClone(first.value.branches[0]?.terminal);
    const terminal = first.value.branches[0]?.terminal;
    if (terminal !== undefined) {
      terminal.statusCode = null;
    }
    const second = withDefinitions(() =>
      extractRawBranches(handler, returnShape),
    );

    expect(second.value.branches[0]?.terminal).toEqual(expected);
  });
});
