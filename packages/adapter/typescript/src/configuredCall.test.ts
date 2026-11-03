import { Node, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { readConfiguredCall } from "./configuredCall.js";
import { ResolutionStore } from "./facts/store.js";
import { invocationContextFor } from "./resolve/invocationEffects.js";

import type {
  ConfiguredCallRead,
  ConfiguredCallSpec,
} from "./configuredCall.js";

const DISPATCH: ConfiguredCallSpec = {
  module: "@acme/async",
  receiver: "CommandDispatcher",
  method: "dispatch",
  subjectArg: 0,
  bodyArg: 1,
};

/**
 * A project with a wrapper package the user file imports, so the checker
 * can name the receiver's type the way it does in a service.
 */
function makeProject(userSource: string): SourceFile {
  const project = createTestProject();

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

/**
 * Read every call in the file with the given spec, through the run's
 * store when one is given, as extraction hands a recognizer.
 */
function readAll(
  sourceFile: SourceFile,
  spec: ConfiguredCallSpec = DISPATCH,
  resolution?: ResolutionStore,
): ConfiguredCallRead[] {
  const out: ConfiguredCallRead[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const read = readConfiguredCall(
      node,
      invocationContextFor(node, resolution),
      spec,
    );
    if (read !== null) {
      out.push(read);
    }
  });
  return out;
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
            total: { kind: "number", value: 2 },
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

  it("reads the send with no subject when the subject is a parameter", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher, kind: string) {
        await dispatcher.dispatch(kind, { id: "1" }, {});
      }
    `);

    expect(readAll(sf, DISPATCH, new ResolutionStore())).toEqual([
      {
        subject: null,
        body: {
          kind: "object",
          fields: { id: { kind: "string", value: "1" } },
        },
        callee: "dispatcher.dispatch",
      },
    ]);
  });

  it("reads a subject and a body the source settles through a constant", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      const AUDIT = "order.audited";
      const config = { queue: process.env.ORDERS_QUEUE ?? "orders" };
      export async function send(dispatcher: CommandDispatcher) {
        const body = { id: "1" };
        await dispatcher.dispatch(AUDIT, body, {});
        await dispatcher.dispatch(config.queue, body, {});
      }
    `);

    const read = readAll(sf, DISPATCH, new ResolutionStore());
    expect(read.map((one) => [one.subject, one.body])).toEqual([
      [
        "order.audited",
        { kind: "object", fields: { id: { kind: "string", value: "1" } } },
      ],
      [
        "orders",
        { kind: "object", fields: { id: { kind: "string", value: "1" } } },
      ],
    ]);
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

  it("reads the send with no subject when the call passes no arguments", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      export async function send(dispatcher: CommandDispatcher) {
        await (dispatcher as any).dispatch();
      }
    `);

    expect(readAll(sf)).toEqual([
      { subject: null, body: null, callee: "(dispatcher as any).dispatch" },
    ]);
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

  it("matches a project-relative module the file spells from its own directory", () => {
    const project = createTestProject();
    project.createSourceFile(
      "messaging/dispatcher.ts",
      `
      export class CommandDispatcher {
        async dispatch(subject: string, data: unknown, opts: unknown) {}
      }
    `,
    );
    const sf = project.createSourceFile(
      "orders/send.ts",
      `
      import { CommandDispatcher } from "../messaging/dispatcher";
      export async function send(dispatcher: CommandDispatcher) {
        await dispatcher.dispatch("order.placed", {}, {});
      }
    `,
    );

    const spec: ConfiguredCallSpec = {
      ...DISPATCH,
      module: "./messaging/dispatcher",
    };
    expect(readAll(sf, spec).map((r) => r.subject)).toEqual(["order.placed"]);
  });
});

/** The stub the teach-a-dependency guide shows, as the CLI hands it to the pack. */
const PUBLISH_ENTRY: ConfiguredCallSpec = {
  module: "@acme/ledger-native",
  export: "publishEntry",
  subject: { at: 0 },
  payload: { at: 1 },
};

/**
 * A project whose native package ships only declarations, the way a
 * napi-rs crate does. `installed: false` leaves the package off disk.
 */
function ledgerProject(
  userSource: string,
  installed = true,
): { sourceFile: SourceFile; store: ResolutionStore } {
  const project = createTestProject();
  if (installed) {
    project.createSourceFile(
      "node_modules/@acme/ledger-native/package.json",
      JSON.stringify({ name: "@acme/ledger-native", types: "index.d.ts" }),
    );
    project.createSourceFile(
      "node_modules/@acme/ledger-native/index.d.ts",
      `
export declare function publishEntry(queue: string, body: unknown): Promise<void>;
export declare function closeLedger(): Promise<void>;
export declare class Ledger {
  append(queue: string, body: unknown): Promise<void>;
}
`,
    );
  }

  return {
    sourceFile: project.createSourceFile("user.ts", userSource),
    store: new ResolutionStore(),
  };
}

function readExports(
  { sourceFile, store }: { sourceFile: SourceFile; store: ResolutionStore },
  spec: ConfiguredCallSpec = PUBLISH_ENTRY,
): ConfiguredCallRead[] {
  return readAll(sourceFile, spec, store);
}

describe("readConfiguredCall on an export", () => {
  it("reads a bare call of a named import, with the subject and payload where the spec says", () => {
    const project = ledgerProject(`
      import { publishEntry } from "@acme/ledger-native";
      export async function record(entry: object) {
        await publishEntry("ledger-queue", { amount: "9" });
      }
    `);

    expect(readExports(project)).toEqual([
      {
        subject: "ledger-queue",
        body: {
          kind: "object",
          fields: { amount: { kind: "string", value: "9" } },
        },
        callee: "publishEntry",
      },
    ]);
  });

  it("reads the call when the package is not installed at all", () => {
    const project = ledgerProject(
      `
      import { publishEntry } from "@acme/ledger-native";
      export async function record(entry: object) {
        await publishEntry("ledger-queue", entry);
      }
    `,
      false,
    );

    expect(readExports(project).map((read) => read.subject)).toEqual([
      "ledger-queue",
    ]);
  });

  it("reads a call through an alias and through a namespace import", () => {
    const project = ledgerProject(`
      import { publishEntry as publish } from "@acme/ledger-native";
      import * as ledger from "@acme/ledger-native";
      export async function record(entry: object) {
        await publish("ledger-queue", entry);
        await ledger.publishEntry("ledger-audit", entry);
      }
    `);

    expect(readExports(project).map((read) => read.callee)).toEqual([
      "publish",
      "ledger.publishEntry",
    ]);
  });

  it("reads a method on an instance the package's class made, for an export written Class.method", () => {
    const project = ledgerProject(`
      import { Ledger } from "@acme/ledger-native";
      const ledger = new Ledger();
      export async function record(entry: object) {
        await ledger.append("ledger-queue", entry);
      }
    `);

    const spec: ConfiguredCallSpec = {
      module: "@acme/ledger-native",
      export: "Ledger.append",
      subject: { at: 0 },
    };
    expect(readExports(project, spec)).toEqual([
      { subject: "ledger-queue", body: null, callee: "ledger.append" },
    ]);
  });

  it("reads nothing for another export of the same package, or a local function of the same name", () => {
    const project = ledgerProject(`
      import { closeLedger } from "@acme/ledger-native";
      function publishEntry(queue: string, body: unknown) {}
      export async function record(entry: object) {
        await closeLedger();
        publishEntry("ledger-queue", entry);
      }
    `);

    expect(readExports(project)).toEqual([]);
  });

  it("reads the call with no subject when nothing settles the subject", () => {
    const project = ledgerProject(`
      import { publishEntry } from "@acme/ledger-native";
      export async function record(queue: string, entry: object) {
        await publishEntry(queue, entry);
      }
    `);

    expect(readExports(project)).toEqual([
      {
        subject: null,
        body: { kind: "identifier", name: "entry" },
        callee: "publishEntry",
      },
    ]);
  });

  it("asks a store of its own when the context brings none", () => {
    const sf = makeProject(`
      import { CommandDispatcher } from "@acme/async";
      const made = new CommandDispatcher();
      export async function send(given: CommandDispatcher) {
        await made.dispatch("order.placed", {}, {});
        await given.dispatch("order.given", {}, {});
      }
    `);

    const spec: ConfiguredCallSpec = {
      module: "@acme/async",
      export: "CommandDispatcher.dispatch",
      subject: { at: 0 },
    };
    // Nothing ties a parameter to the constructor, so the call on it is
    // not attributed to the export, and only the receiver form reads it.
    expect(readAll(sf, spec).map((read) => read.subject)).toEqual([
      "order.placed",
    ]);
  });
});
