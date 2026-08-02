// A recognizer's first question about a call is whether the name it
// matched came from the library it cares about, or from something local
// that happens to share the name. Each test lays out one import shape.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { isImportedFrom } from "./invocationEffects.js";

import type { Node } from "ts-morph";

function identifierNamed(files: Record<string, string>, name: string): Node {
  const project = createTestProject();
  for (const [path, contents] of Object.entries(files)) {
    project.createSourceFile(path, contents);
  }
  // The last match is the use site; earlier ones are the import itself.
  const matches = project
    .getSourceFileOrThrow("/use.ts")
    .getDescendants()
    .filter(
      (node: Node) =>
        node.getKindName() === "Identifier" && node.getText() === name,
    );
  const target = matches[matches.length - 1];
  if (target === undefined) {
    throw new Error(`No identifier ${name} in /use.ts`);
  }
  return target;
}

describe("isImportedFrom", () => {
  it("matches a named import", () => {
    const identifier = identifierNamed(
      {
        "/use.ts": `
          import { SendMessageCommand } from "@aws-sdk/client-sqs";
          const c = new SendMessageCommand({});
        `,
      },
      "SendMessageCommand",
    );

    expect(isImportedFrom(identifier, "@aws-sdk/client-sqs")).toBe(true);
    expect(isImportedFrom(identifier, "@aws-sdk/client-sns")).toBe(false);
  });

  it("matches a default import", () => {
    const identifier = identifierNamed(
      {
        "/use.ts": `
          import Command from "@aws-sdk/client-sqs";
          const c = new Command({});
        `,
      },
      "Command",
    );

    expect(isImportedFrom(identifier, "@aws-sdk/client-sqs")).toBe(true);
  });

  it("matches a namespace import", () => {
    const identifier = identifierNamed(
      {
        "/use.ts": `
          import * as sqs from "@aws-sdk/client-sqs";
          const c = new sqs.SendMessageCommand({});
        `,
      },
      "sqs",
    );

    expect(isImportedFrom(identifier, "@aws-sdk/client-sqs")).toBe(true);
  });

  it("says no for a local class that shares the name", () => {
    const identifier = identifierNamed(
      {
        "/use.ts": `
          class SendMessageCommand {}
          const c = new SendMessageCommand();
        `,
      },
      "SendMessageCommand",
    );

    expect(isImportedFrom(identifier, "@aws-sdk/client-sqs")).toBe(false);
  });

  it("says no for a name imported from somewhere else", () => {
    const identifier = identifierNamed(
      {
        "/local.ts": "export class SendMessageCommand {}",
        "/use.ts": `
          import { SendMessageCommand } from "./local";
          const c = new SendMessageCommand();
        `,
      },
      "SendMessageCommand",
    );

    expect(isImportedFrom(identifier, "@aws-sdk/client-sqs")).toBe(false);
  });

  it("says no for something that is not an identifier", () => {
    const identifier = identifierNamed(
      { "/use.ts": "const c = { a: 1 }; const b = c.a;" },
      "c",
    );

    expect(isImportedFrom(identifier.getParent() as Node, "anything")).toBe(
      false,
    );
  });

  it("says no when the identifier resolves to nothing", () => {
    const identifier = identifierNamed(
      { "/use.ts": "const c = whoKnows;" },
      "whoKnows",
    );

    expect(isImportedFrom(identifier, "@aws-sdk/client-sqs")).toBe(false);
  });
});
