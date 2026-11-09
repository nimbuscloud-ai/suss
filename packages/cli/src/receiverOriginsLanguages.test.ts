/**
 * The member step and the receiver origins it asks about, on the same
 * cases written in TypeScript, Python and Ruby. Each origin has a pack
 * of its own, so a case reaches its model only through the origin it is
 * there for. Every pack reads the model off the member the call is made
 * on, `db.user.get(...)` as `User`, as an ORM's delegate is read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import {
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import {
  constructedFrom,
  handedBy,
  inherits,
  pack,
  storageCalls,
  typed,
} from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type {
  CallStep,
  ReceiverOrigin,
  RelatedAccess,
  StatedInputs,
} from "@suss/recognize";

const KVCACHE = ["kvcache", "Kvcache"];

const CLIENT = constructedFrom({ from: KVCACHE, named: ["Client"] });

const DELEGATE: CallStep = { to: "member" };

/** Each relation `include` asks for, read whole. */
function included({ input }: StatedInputs): RelatedAccess[] {
  const include = input.property("include");
  return (include?.entries("nothing") ?? []).flatMap((entry) =>
    entry.key === null
      ? []
      : [{ path: [entry.key], kind: "read", fields: ["*"] }],
  );
}

/** A pack that reads `<client>.<model>.get(...)` on a client the origin accepts. */
function modelReads(name: string, client: ReceiverOrigin) {
  return pack(
    name,
    [
      storageCalls({ system: "records", client, clientAt: [DELEGATE] })
        .methods({ get: { kind: "read", fields: ["*"] } })
        .container({ of: [DELEGATE], naming: "upperFirst" })
        .relations({ of: { at: 0 }, by: included })
        .example("db.user.get({ id: 1 })"),
    ],
    {
      languages: ["typescript", "python", "ruby"],
      recognizedAs: `@suss/${name}`,
    },
  );
}

const PACKS = [
  modelReads("member", CLIENT),
  modelReads("typed", typed({ from: ["ledger", "Ledger"] })),
  modelReads("inherits", inherits({ from: KVCACHE, named: ["Client"] })),
  modelReads("handedBy", handedBy("run", CLIENT, { parameter: 0 })),
];
const INVOCATION = PACKS.flatMap((one) => one.invocationRecognizers ?? []);

/** The models each origin's pack read, and what every language reads. */
const READS: Record<string, readonly string[]> = {
  "@suss/member": ["User", "Account"],
  "@suss/typed": ["Entry"],
  "@suss/inherits": ["Post"],
  "@suss/handedBy": ["Order"],
};

const TYPESCRIPT = `
import { Client } from "kvcache";
import { Book } from "ledger";

class Db extends Client {}

const db = new Client();
const sub = new Db();

export function cases(book: Book) {
  db.user.get({ id: 1 });
  sub.post.get({ id: 2 });
  db.run((tx) => tx.order.get({ id: 3 }));
  book.entry.get({ id: 4 });
  db.account.get({ include: { owner: true } });
}
`;

const PYTHON = `from kvcache import Client
from ledger import Book


class Db(Client):
    pass


db = Client()
sub = Db()


def cases(book: Book):
    db.user.get({"id": 1})
    sub.post.get({"id": 2})
    db.run(lambda tx: tx.order.get({"id": 3}))
    book.entry.get({"id": 4})
    db.account.get({"include": {"owner": True}})
`;

const RUBY = `module Store
  class Db < Kvcache::Client
  end

  def self.cases
    db = Kvcache::Client.new
    sub = Db.new
    book = Ledger::Book.new
    db.user.get({ id: 1 })
    sub.post.get({ id: 2 })
    db.run { |tx| tx.order.get({ id: 3 }) }
    book.entry.get({ id: 4 })
    db.account.get({ include: { owner: true } })
  end
end
`;

type Storage = Extract<Effect, { type: "interaction" }>;

function storageIn(effects: readonly Effect[]): Storage[] {
  return effects.filter(
    (effect): effect is Storage =>
      effect.type === "interaction" &&
      effect.interaction.class === "storage-access",
  );
}

/** The models each pack read, its own accesses only, by the pack's name. */
function readsOf(effects: readonly Effect[]): Record<string, string[]> {
  const reads: Record<string, string[]> = {};
  for (const effect of storageIn(effects)) {
    const semantics = effect.binding.semantics as { container?: string };
    if ("relationPath" in effect.interaction) {
      continue;
    }
    const recognition = effect.binding.recognition ?? "";
    reads[recognition] = [
      ...(reads[recognition] ?? []),
      semantics.container ?? "",
    ];
  }
  return reads;
}

/** The access the member pack recorded through a relation, as each effect's keys and values. */
function relatedOf(effects: readonly Effect[]): unknown[] {
  return storageIn(effects)
    .filter(
      (effect) =>
        effect.binding.recognition === "@suss/member" &&
        (effect.binding.semantics as { container?: string }).container ===
          "Account",
    )
    .map((effect) => ({
      container: (effect.binding.semantics as { container?: string }).container,
      keys: Object.keys(effect.interaction),
      interaction: effect.interaction,
    }));
}

function typescriptEffects(): Effect[] {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/kvcache/package.json",
    JSON.stringify({ name: "kvcache", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/kvcache/index.d.ts",
    `export declare class Client {
      user: any;
      post: any;
      order: any;
      account: any;
      run(callback: (tx: any) => unknown): unknown;
    }`,
  );
  project.createSourceFile(
    "/node_modules/ledger/package.json",
    JSON.stringify({ name: "ledger", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/ledger/index.d.ts",
    "export declare class Book { entry: any; }",
  );
  const file = project.createSourceFile("/store.ts", TYPESCRIPT);
  const store = ResolutionStore.forPacks(PACKS);
  const originatesFrom = (value: Node, module: string): boolean =>
    store.importOriginsOf(value, [module]).length > 0;
  const effects: Effect[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const anchors = (value: Node, matches: (call: Node) => boolean) =>
      store.anchorCallsOf(value, matches);
    const context = invocationContextFor(node, store, originatesFrom, anchors);
    for (const hook of INVOCATION) {
      effects.push(...(hook(node, context) ?? []));
    }
  });
  return effects;
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-receiver-origins-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DECLARED = {
  name: "receiver-origins",
  protocol: "in-process",
  discovery: [],
  invocationRecognizers: INVOCATION,
  accessRecognizers: [],
};

function effectsIn(summaries: readonly BehavioralSummary[]): Effect[] {
  return summaries.flatMap((summary) =>
    summary.transitions.flatMap((transition) => transition.effects),
  );
}

async function pythonEffects(): Promise<Effect[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsIn(summaries);
}

async function rubyEffects(): Promise<Effect[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return effectsIn(summaries);
}

/** What every language records for the access through `include: { owner: true }`. */
const RELATED = [
  {
    container: "Account",
    keys: ["class", "kind", "fields", "operation"],
    interaction: { kind: "read", fields: ["*"], operation: "get" },
  },
  {
    container: "Account",
    keys: ["class", "kind", "fields", "operation", "relationPath"],
    interaction: {
      kind: "read",
      fields: ["*"],
      operation: "get",
      relationPath: ["owner"],
    },
  },
];

describe("the member step and the receiver origins, the same in every language", () => {
  it("reads each model through the origin its case is there for, in TypeScript", () => {
    expect(readsOf(typescriptEffects())).toEqual(READS);
  });

  it("reads each model through the origin its case is there for, in Python", async () => {
    expect(readsOf(await pythonEffects())).toEqual(READS);
  });

  it("reads each model through the origin its case is there for, in Ruby", async () => {
    expect(readsOf(await rubyEffects())).toEqual(READS);
  });
});

describe("an access through a relation, the same in every language", () => {
  it("follows the container's own access, on its binding, in TypeScript", () => {
    expect(relatedOf(typescriptEffects())).toMatchObject(RELATED);
  });

  it("follows the container's own access, on its binding, in Python", async () => {
    expect(relatedOf(await pythonEffects())).toMatchObject(RELATED);
  });

  it("follows the container's own access, on its binding, in Ruby", async () => {
    expect(relatedOf(await rubyEffects())).toMatchObject(RELATED);
  });
});
