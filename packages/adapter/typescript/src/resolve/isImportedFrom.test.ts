// A recognizer's first question about a call is whether the name it
// matched came from the library it cares about, or from something local
// that happens to share the name. Each test lays out one import shape.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { isImportedFrom, methodDeclaredIn } from "./invocationEffects.js";

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

// A client a service builds somewhere else says nothing at the call
// site about which library it came from. What the method resolves to
// does.
const IOREDIS_TYPES = `
  export default class Redis {
    get(key: string): Promise<string | null>;
  }
`;

function calleeOf(source: string) {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/ioredis/package.json",
    JSON.stringify({ name: "ioredis", types: "built/index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/ioredis/built/index.d.ts",
    IOREDIS_TYPES,
  );
  const use = project.createSourceFile("/use.ts", source);
  const call = use
    .getDescendants()
    .find((node: Node) => node.getKindName() === "CallExpression");
  if (call === undefined) {
    throw new Error("No call in /use.ts");
  }
  return (call as unknown as { getExpression(): Node }).getExpression();
}

describe("methodDeclaredIn", () => {
  it("matches a method the library declares, whatever the receiver was called", () => {
    const callee = calleeOf(`
      import Redis from "ioredis";
      declare const anything: Redis;
      export const read = () => anything.get("k");
    `);

    expect(methodDeclaredIn(callee, "ioredis")).toBe(true);
    expect(methodDeclaredIn(callee, "redis")).toBe(false);
  });

  it("reads the receiver's written form when the method has no symbol", () => {
    // The client singleton cached on an untyped global types as any,
    // so the method resolves to nothing and the store's answer is what
    // says which library it is.
    const callee = calleeOf(`
      import Redis from "ioredis";
      const client = (globalThis as any).cached || new Redis();
      export const read = () => client.get("k");
    `);
    const receiver = (
      callee as unknown as { getExpression(): Node }
    ).getExpression();
    const construction = receiver
      .getSourceFile()
      .getDescendants()
      .find((node: Node) => node.getKindName() === "NewExpression");

    expect(methodDeclaredIn(callee, "ioredis")).toBe(false);
    expect(
      methodDeclaredIn(callee, "ioredis", () => construction ?? null),
    ).toBe(true);
    expect(methodDeclaredIn(callee, "ioredis", () => null)).toBe(false);
    expect(methodDeclaredIn(callee, "ioredis", () => receiver)).toBe(false);
  });

  it("leaves a same-named method on something else alone", () => {
    const callee = calleeOf(`
      declare const cache: { get(key: string): Promise<string> };
      export const read = () => cache.get("k");
    `);

    expect(methodDeclaredIn(callee, "ioredis")).toBe(false);
  });

  it("says no for a call that goes to a plain name", () => {
    const callee = calleeOf(`
      declare function get(key: string): string;
      export const read = () => get("k");
    `);

    expect(methodDeclaredIn(callee, "ioredis")).toBe(false);
  });
});

describe("isImportedFrom with the store's origin question", () => {
  it("follows a project barrel the syntactic paths cannot", () => {
    const project = createTestProject();
    project.createSourceFile(
      "/node_modules/@probe/queue/package.json",
      JSON.stringify({ name: "@probe/queue", types: "index.d.ts" }),
    );
    project.createSourceFile(
      "/node_modules/@probe/queue/index.d.ts",
      "export declare class SendCommand { constructor(input: unknown); }\n",
    );
    project.createSourceFile(
      "/barrel.ts",
      'export { SendCommand } from "@probe/queue";\n',
    );
    const use = project.createSourceFile(
      "/use.ts",
      'import { SendCommand } from "./barrel.js";\nconst c = new SendCommand({});\n',
    );
    const identifier = use
      .getDescendants()
      .filter((node) => node.getText() === "SendCommand")
      .at(-1);
    if (identifier === undefined) {
      throw new Error("no use site");
    }

    const store = new ResolutionStore();
    const originatesFrom = (value: Node, module: string) =>
      store.importOriginsOf(value, [module]).length > 0;
    expect(isImportedFrom(identifier, "@probe/queue", originatesFrom)).toBe(
      true,
    );
    expect(isImportedFrom(identifier, "@probe/other", originatesFrom)).toBe(
      false,
    );
  });
});
