/**
 * One class-body declaration, read by the reader in @suss/recognize from
 * the same model written in TypeScript, Python and Ruby. The library is
 * made up: its base is `Model`, `links` declares an association, `runs`
 * registers a callback and `defines` makes a class method from a lambda.
 * Ruby writes all three as calls in the body. Python assigns `links(...)`
 * to a field and calls `runs`. TypeScript initializes a static field with
 * `links(...)` and calls `runs` in a static block.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bindModule,
  parsePython,
  factsForFile as pythonFactsForFile,
  pythonModuleOps,
} from "@suss/adapter-python";
import {
  moduleOpsForFile,
  parseRuby,
  preloadRubyGrammar,
  factsForFile as rubyFactsForFile,
} from "@suss/adapter-ruby";
import { moduleOpsFor, ResolutionStore } from "@suss/adapter-typescript";
import {
  association,
  callback,
  classBody,
  declareClassBodies,
  definesMethod,
  imported,
} from "@suss/recognize";
import { classMemberName } from "@suss/resolution";
import { createTestProject } from "@suss/test-project";

import type { ModuleOps } from "@suss/extractor";
import type { ClassDeclaration } from "@suss/recognize";

const LIBRARY = classBody({
  calls: {
    links: association({
      name: { at: 0 },
      target: { keyword: "class_name" },
      plural: true,
    }),
    runs: callback({
      methods: { from: 0 },
      events: ["save", "destroy"],
      narrowedBy: { keyword: "on" },
    }),
    defines: definesMethod({ name: { at: 0 }, body: { at: 1 } }),
  },
  fields: {
    association: {
      madeBy: imported({ from: ["lib"], named: ["links"] }),
    },
  },
});

const TYPESCRIPT = `
import { Model, links, runs } from "lib";

export class Account extends Model {
  static items = links("Item");
  static {
    runs("sync");
  }
}
`;

const PYTHON = `
from lib import Model, links, runs

class Account(Model):
    items = links("Item")
    runs("sync", on="save")
`;

const RUBY = `
class Account < Model
  links :items
  links :owner, class_name: "Person"
  runs :sync, on: :save
  defines :recent, -> { where(active: true) }
end
`;

let root: string;

beforeAll(async () => {
  await preloadRubyGrammar();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-class-body-")),
  );
  fs.writeFileSync(path.join(root, "account.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function typescriptModule(): ModuleOps {
  const project = createTestProject();
  const file = project.createSourceFile("/account.ts", TYPESCRIPT);
  return moduleOpsFor(file, ResolutionStore.forPacks([]));
}

async function pythonModule(): Promise<ModuleOps> {
  const file = path.join(root, "account.py");
  const tree = await parsePython(PYTHON);
  const module = bindModule(tree.rootNode);
  const db = pythonFactsForFile({
    file,
    root: tree.rootNode,
    module,
    packs: [],
  });
  return pythonModuleOps(
    { file, displayPath: "account.py", root: tree.rootNode, module },
    db,
  );
}

/** What each declaration says, without the class it was read off. */
function said(declarations: readonly ClassDeclaration[]) {
  return declarations.map((declared) => {
    if (declared.kind === "method") {
      return {
        kind: "method",
        name: declared.name,
        body: declared.body.form?.(),
      };
    }
    const { cls: _cls, ...rest } = declared;
    return rest;
  });
}

describe("a class-body declaration, read from three languages", () => {
  it("reads a field assigned from the library's call, and a callback a static block registers, in TypeScript", () => {
    expect(said(declareClassBodies(LIBRARY, typescriptModule()))).toEqual([
      {
        kind: "callback",
        events: ["save", "destroy"],
        methods: ["sync"],
      },
      { kind: "association", name: "items", target: { written: "Item" } },
    ]);
  });

  it("reads a field assigned from the library's call, and a callback the body registers, in Python", async () => {
    expect(said(declareClassBodies(LIBRARY, await pythonModule()))).toEqual([
      { kind: "callback", events: ["save"], methods: ["sync"] },
      { kind: "association", name: "items", target: { written: "Item" } },
    ]);
  });

  it("reads each call the body writes, in Ruby", () => {
    const module = moduleOpsForFile(path.join(root, "account.rb"));
    expect(said(declareClassBodies(LIBRARY, module))).toEqual([
      {
        kind: "association",
        name: "items",
        target: { inflect: "items", plural: true },
      },
      { kind: "association", name: "owner", target: { written: "Person" } },
      { kind: "callback", events: ["save"], methods: ["sync"] },
      { kind: "method", name: "recent", body: "function" },
    ]);
  });
});

describe("the facts Ruby states from a class-body declaration", () => {
  it("states each association, each callback and the scope's lambda", async () => {
    const file = path.join(root, "account.rb");
    const db = rubyFactsForFile({
      file,
      root: (await parseRuby(RUBY)).rootNode,
      packs: [
        {
          name: "lib",
          protocol: "postgresql",
          discovery: [],
          classBodies: [LIBRARY],
        },
      ],
    });
    const names = (relation: string, column: number) =>
      db.facts(relation).map((row) => String(row[column]));
    expect(names("declaresAssociation", 1)).toEqual(["items", "owner"]);
    expect(
      db.facts("classCallback").map((row) => [row[1], row[2]].map(String)),
    ).toEqual([["save", "sync"]]);
    expect(names("holdsProperty", 1)).toContain(classMemberName("recent"));
  });
});
