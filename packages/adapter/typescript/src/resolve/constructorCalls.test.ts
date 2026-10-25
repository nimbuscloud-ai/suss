/**
 * `new Client()` as a call: the closure walks into the constructor it
 * runs, the constructor gets a summary of its own, and a parameter
 * default is read at the call that leaves its argument out.
 */

import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const CLIENTS = `
export function makeRegion(): string {
  return "eu-west-1";
}

export function connect(): void {}

export class Client {
  private readonly region = makeRegion();
  private readonly label = process.env.CLIENT_LABEL;
  private readonly onError = () => connect();
  static shared = connect();

  constructor(private readonly table: string | undefined = process.env.TABLE) {}

  describe(): string {
    return \`\${this.table}@\${this.region}\${this.label}\`;
  }
}

export class Audited extends Client {}

export class Logged extends Client {
  constructor() {
    super();
  }
}

export class Plain {}

export class Factory {
  static make() {
    return new this();
  }
}

export const shared = new Client("shared");
`;

const MODELS = `
export declare class Model {
  save(): void;
}
export declare function model(name: string): typeof Model;
`;

const CALLERS = `
import { model } from "models";

import { Audited, Client, Factory, Logged, Plain } from "./clients";

const kinds: Record<string, typeof Client> = { client: Client };
const Post = model("Post");

export function fromModel() {
  return new Post();
}

export function fromThis() {
  return Factory.make();
}

export function withDefault() {
  return new Client().describe();
}

export function withTable() {
  return new Client("orders").describe();
}

export function inherited() {
  return new Audited();
}

export function throughSuper() {
  return new Logged();
}

export function plain() {
  return new Plain();
}

export function fromDependency() {
  return new Map<string, string>();
}

export function chosen(kind: string) {
  const Chosen = kinds[kind];
  return new Chosen();
}
`;

const ENTRIES = [
  "withDefault",
  "withTable",
  "inherited",
  "throughSuper",
  "plain",
  "fromDependency",
  "chosen",
  "fromModel",
  "fromThis",
];

/** Reads `process.env.NAME` as a config read, the way the node pack does. */
const envPack: PatternPack = {
  name: "env",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [
    {
      kind: "library",
      match: { type: "namedExport", names: ENTRIES },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "allPositional" },
  accessRecognizers: [
    (access) => {
      const node = access as Node;
      if (
        !Node.isPropertyAccessExpression(node) ||
        node.getExpression().getText() !== "process.env"
      ) {
        return null;
      }
      return [
        {
          type: "interaction",
          binding: runtimeConfigBinding({ recognition: "env" }),
          callee: node.getText(),
          interaction: {
            class: "config-read",
            name: node.getName(),
            defaulted: false,
          },
        },
      ];
    },
  ],
};

async function extract(): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  project.createSourceFile("/node_modules/models/index.d.ts", MODELS);
  project.createSourceFile("/src/clients.ts", CLIENTS);
  project.createSourceFile("/src/callers.ts", CALLERS);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [envPack],
    cacheDir: null,
  });
  return await adapter.extractAll();
}

function named(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find((summary) => summary.identity.name === name);
}

function effectsOf(summary: BehavioralSummary | undefined) {
  return (summary?.transitions ?? []).flatMap((t) => t.effects);
}

/** The variables a summary reads. */
function readsOf(summary: BehavioralSummary | undefined): Array<string | null> {
  return [
    ...new Set(
      effectsOf(summary).flatMap((e) =>
        e.type === "interaction" && e.interaction.class === "config-read"
          ? [e.interaction.name]
          : [],
      ),
    ),
  ];
}

/** Each call a summary records, with the summary it links to. */
function callsOf(summary: BehavioralSummary | undefined): string[] {
  return [
    ...new Set(
      effectsOf(summary).flatMap((e) =>
        e.type === "invocation"
          ? [`${e.callee} -> ${e.summary ?? "unlinked"}`]
          : [],
      ),
    ),
  ];
}

describe("a constructor in the TypeScript call graph", () => {
  it("links `new Client()` to the constructor's own summary", async () => {
    const summaries = await extract();
    expect(callsOf(named(summaries, "withDefault"))).toContain(
      "new Client -> src::clients.ts::Client.constructor",
    );
    expect(named(summaries, "Client.constructor")?.kind).toBe("library");
  });

  it("reads a parameter default at the call that leaves the argument out", async () => {
    const summaries = await extract();
    expect(readsOf(named(summaries, "withDefault"))).toEqual(["TABLE"]);
    expect(readsOf(named(summaries, "withTable"))).toEqual([]);
  });

  it("runs the instance fields with the constructor, and leaves out a field set to a function and a static one", async () => {
    const summaries = await extract();
    const built = named(summaries, "Client.constructor");
    expect(readsOf(built)).toEqual(["CLIENT_LABEL"]);
    expect(callsOf(built)).toEqual([
      "makeRegion -> src::clients.ts::makeRegion",
    ]);
  });

  it("runs the base class's constructor for a class that writes none, and for `super()`", async () => {
    const summaries = await extract();
    expect(callsOf(named(summaries, "inherited"))).toContain(
      "new Audited -> src::clients.ts::Client.constructor",
    );
    const logged = named(summaries, "Logged.constructor");
    expect(callsOf(logged)).toContain(
      "super -> src::clients.ts::Client.constructor",
    );
    expect(readsOf(logged)).toEqual(["TABLE"]);
  });

  it("records nothing for a class with no constructor anywhere, or a dependency's class", async () => {
    const summaries = await extract();
    expect(callsOf(named(summaries, "plain"))).toEqual([]);
    expect(callsOf(named(summaries, "fromDependency"))).toEqual([]);
    expect(named(summaries, "fromDependency")?.gaps).toEqual([]);
  });

  it("records no stop for a `new` of a value whose type is a dependency's class", async () => {
    const summaries = await extract();
    const fromModel = named(summaries, "fromModel");
    expect(fromModel?.kind).toBe("library");
    expect(fromModel?.gaps).toEqual([]);
  });

  it("leaves `new this()` to the walk that reads the receiver, so it is no call of its own", async () => {
    const summaries = await extract();
    const make = named(summaries, "make");
    expect(make?.kind).toBe("library");
    expect(callsOf(make)).toEqual([]);
  });

  it("stops at a `new` whose class nothing settles", async () => {
    const summaries = await extract();
    const gaps = named(summaries, "chosen")?.gaps ?? [];
    expect(gaps.map((gap) => gap.description)).toEqual([
      expect.stringContaining("new Chosen"),
    ]);
  });

  it("gives a file whose top level builds a project class a module-init unit that calls the constructor", async () => {
    const summaries = await extract();
    const init = summaries.find(
      (summary) =>
        summary.kind === "module-init" &&
        summary.location.file.endsWith("clients.ts"),
    );
    expect(callsOf(init)).toContain(
      "new Client -> src::clients.ts::Client.constructor",
    );
  });
});
