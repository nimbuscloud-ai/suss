import {
  type CallExpression,
  Node,
  Project,
  ScriptTarget,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";

import { readConfiguredCall } from "./configuredCall.js";

import type { EffectArg } from "@suss/extractor";
import type { ConfiguredCallSpec } from "./configuredCall.js";

const DISPATCH: ConfiguredCallSpec = {
  module: "@acme/async",
  receiver: "CommandDispatcher",
  method: "dispatch",
  subjectArg: 0,
  bodyArg: 1,
};

/**
 * A project holding a wrapper package the user file imports, so the
 * checker can name the receiver's type the way it does on a service.
 */
function makeProject(userSource: string): SourceFile {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      strict: true,
      moduleResolution: 100, // ts.ModuleResolutionKind.Bundler
    },
    useInMemoryFileSystem: true,
  });

  project.createSourceFile(
    "node_modules/@acme/async/package.json",
    JSON.stringify({ name: "@acme/async", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "node_modules/@acme/async/index.d.ts",
    `
export declare class CommandDispatcher {
  dispatch(subject: string, data: unknown, opts: unknown): Promise<void>;
  dispatchBatch(subject: string, entries: unknown[]): Promise<void>;
}
export declare class EventPublisher {
  emit(subject: string, data: unknown, opts: unknown): Promise<void>;
}
`,
  );
  // A sub-path entry point, the way a package publishes one.
  project.createSourceFile(
    "node_modules/@acme/async/commands.d.ts",
    `export { CommandDispatcher } from "./index.js";`,
  );

  return project.createSourceFile("user.ts", userSource);
}

/** Read every call in the file with the given spec. */
function readAll(
  sourceFile: SourceFile,
  spec: ConfiguredCallSpec = DISPATCH,
): Array<{ subject: string; body: EffectArg | null; callee: string }> {
  const out: Array<{
    subject: string;
    body: EffectArg | null;
    callee: string;
  }> = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const read = readConfiguredCall(
      node,
      { sourceFile, extractArgs: () => extractArgsForTest(node) },
      spec,
    );
    if (read !== null) {
      out.push(read);
    }
  });
  return out;
}

/** The shapes this helper reads: strings, objects, everything else opaque. */
function extractArgsForTest(call: CallExpression): EffectArg[] {
  return call.getArguments().map((arg) => extractArgForTest(arg));
}

function extractArgForTest(node: Node): EffectArg {
  if (Node.isAsExpression(node)) {
    return extractArgForTest(node.getExpression());
  }
  if (Node.isStringLiteral(node)) {
    return { kind: "string", value: node.getLiteralValue() };
  }
  if (Node.isObjectLiteralExpression(node)) {
    const fields: Record<string, EffectArg> = {};
    for (const prop of node.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        continue;
      }
      const initializer = prop.getInitializer();
      if (initializer === undefined) {
        continue;
      }
      fields[prop.getName()] = extractArgForTest(initializer);
    }
    return { kind: "object", fields };
  }
  if (Node.isIdentifier(node)) {
    return { kind: "identifier", name: node.getText() };
  }
  return null;
}

describe("readConfiguredCall", () => {
  it("reads the subject and body off a call on the configured receiver", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch("order.placed", { id: "1", total: 2 }, { queueUrl: "u" });
      }
    `);

    expect(readAll(sf)).toEqual([
      {
        subject: "order.placed",
        body: {
          kind: "object",
          fields: {
            id: { kind: "string", value: "1" },
            total: null,
          },
        },
        callee: "dispatcher.dispatch",
      },
    ]);
  });

  it("reads a receiver held in a field", () => {
    const sf = makeProject(`
      import type { CommandDispatcher } from "@acme/async";
      export class Sender {
        constructor(private readonly dispatcher: CommandDispatcher) {}
        async send() {
          await this.dispatcher.dispatch("push.send", { userId: "u" }, {});
        }
      }
    `);

    expect(readAll(sf).map((r) => r.subject)).toEqual(["push.send"]);
  });

  it("peels an as-const subject", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch("order.placed" as const, {}, {});
      }
    `);

    expect(readAll(sf).map((r) => r.subject)).toEqual(["order.placed"]);
  });

  it("reads nothing when the subject is computed", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher, kind: string) {
        await dispatcher.dispatch(kind, { id: "1" }, {});
      }
    `);

    expect(readAll(sf)).toEqual([]);
  });

  it("carries no body when the spec names no body argument", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher) {
        await dispatcher.dispatchBatch("email.send", []);
      }
    `);

    const read = readAll(sf, {
      module: "@acme/async",
      receiver: "CommandDispatcher",
      method: "dispatchBatch",
      subjectArg: 0,
    });
    expect(read).toEqual([
      { subject: "email.send", body: null, callee: "dispatcher.dispatchBatch" },
    ]);
  });

  it("reads nothing when another type has the same method name", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      class EmailDispatcher {
        async dispatch(subject: string, data: unknown, opts: unknown) {}
      }
      export async function send(emails: EmailDispatcher) {
        await emails.dispatch("order.placed", { id: "1" }, {});
      }
    `);

    expect(readAll(sf)).toEqual([]);
  });

  it("reads nothing when the file does not import the configured module", () => {
    const sf = makeProject(`
      class CommandDispatcher {
        async dispatch(subject: string, data: unknown, opts: unknown) {}
      }
      export async function send(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch("order.placed", { id: "1" }, {});
      }
    `);

    expect(readAll(sf)).toEqual([]);
  });

  it("reads nothing when the method name differs", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher) {
        await dispatcher.dispatchBatch("order.placed", []);
      }
    `);

    expect(readAll(sf)).toEqual([]);
  });

  it("reads nothing off a bare function call", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      declare function dispatch(subject: string, data: unknown): void;
      export function send() {
        dispatch("order.placed", { id: "1" });
      }
    `);

    expect(readAll(sf)).toEqual([]);
  });

  it("reads nothing when the receiver has no nameable type", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: unknown) {
        await (dispatcher as { dispatch: (s: string, d: unknown, o: unknown) => void })
          .dispatch("order.placed", {}, {});
      }
    `);

    expect(readAll(sf)).toEqual([]);
  });

  it("reads nothing when the subject argument is missing", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher) {
        await (dispatcher as any).dispatch();
      }
    `);

    expect(readAll(sf)).toEqual([]);
  });

  it("matches a sub-path import of the configured module", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async/commands";
      export async function send(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch("order.placed", {}, {});
      }
    `);

    expect(readAll(sf).map((r) => r.subject)).toEqual(["order.placed"]);
  });
});
