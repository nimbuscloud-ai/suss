/**
 * The ops that read a body's statements, a loop over a list and a file's
 * classes, asked of the same code written in TypeScript, Python and Ruby.
 * Each adapter states the facts its own way, so the answers have to agree.
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
import { moduleOpsForFile, preloadRubyGrammar } from "@suss/adapter-ruby";
import { moduleOpsFor, ResolutionStore } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import type { CallOps, ModuleOps } from "@suss/extractor";

const TYPESCRIPT = `
export class Engine extends Base {}
export function routes(kind: string) {
  get("a");
  if (kind) {
    post("b");
  }
  ["x", "y"].forEach((name, i) => {
    get(name);
  });
}
setup();
`;

const PYTHON = `
class Engine(Base):
    pass

def routes(kind):
    get("a")
    if kind:
        post("b")

setup()
`;

const RUBY = `
module Shop
  class Engine < Base
    isolate_namespace Shop
    mount Sidekiq::Web => "/sidekiq"
  end
end

def routes(kind)
  get "a"
  if kind
    post "b"
  end
  %w[x y].each_with_index do |name, i|
    get "#{name}/#{i}"
  end
end

setup()
`;

let root: string;

beforeAll(async () => {
  await preloadRubyGrammar();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-body-call-ops-")),
  );
  fs.writeFileSync(path.join(root, "app.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function typescriptModule(): ModuleOps {
  const project = createTestProject();
  const file = project.createSourceFile("/app.ts", TYPESCRIPT);
  return moduleOpsFor(file, ResolutionStore.forPacks([]));
}

async function pythonModule(): Promise<ModuleOps> {
  const file = path.join(root, "app.py");
  const tree = await parsePython(PYTHON);
  const module = bindModule(tree.rootNode);
  const db = pythonFactsForFile({
    file,
    root: tree.rootNode,
    module,
    packs: [],
  });
  return pythonModuleOps(
    { file, displayPath: "app.py", root: tree.rootNode, module },
    db,
  );
}

function rubyModule(): ModuleOps {
  return moduleOpsForFile(path.join(root, "app.rb"));
}

/** What each call reaches for: its method, or the name it calls bare. */
const calleesOf = (calls: readonly CallOps[]) =>
  calls.map((call) => call.method() ?? call.calleeText());

function routesCalls(module: ModuleOps): readonly CallOps[] {
  return module.export(["routes"])?.bodyCalls?.() ?? [];
}

describe("the ops over a body's statements, asked of three languages", () => {
  it("list a file's own statements and a function's, through a conditional", async () => {
    for (const module of [
      typescriptModule(),
      await pythonModule(),
      rubyModule(),
    ]) {
      expect(calleesOf(module.bodyCalls())).toEqual(["setup"]);
      expect(calleesOf(routesCalls(module)).slice(0, 2)).toEqual([
        "get",
        "post",
      ]);
    }
  });

  it("read the list a loop runs over and the variables it gives each element, in TypeScript and Ruby", () => {
    for (const [module, method] of [
      [typescriptModule(), "forEach"],
      [rubyModule(), "each_with_index"],
    ] as const) {
      const loop = routesCalls(module)[2];
      expect(loop?.method()).toBe(method);
      const over = loop?.loopsOver?.();
      expect(over?.element).toBe("name");
      expect(over?.position).toBe("i");
      // A `%w[x y]` word shares its span with its content, which the
      // facts never key, so the word is what the value reads.
      expect(over?.over.items().map((item) => item.name("nothing"))).toEqual([
        "x",
        "y",
      ]);
    }
  });

  it("list the classes a file writes, nested ones included, by the name each is declared under", async () => {
    const names = (module: ModuleOps) =>
      module.classes().map((cls) => cls.name());
    expect(names(typescriptModule())).toEqual(["Engine"]);
    expect(names(await pythonModule())).toEqual(["Engine"]);
    expect(names(rubyModule())).toEqual(["Shop", "Shop::Engine"]);
  });
});

describe("the ops only Ruby writes the code for", () => {
  it("list a class body's calls, and read a pair whose key is a constant", () => {
    const engine = rubyModule().classes()[1];
    const [isolate, mount] = engine?.bodyCalls() ?? [];
    expect(isolate?.calleeText()).toBe("isolate_namespace");
    expect(isolate?.valueAt(0)?.source?.()).toBe("Shop");
    const [pair] = mount?.pairArgs?.() ?? [];
    expect(pair?.key.source?.()).toBe("Sidekiq::Web");
    expect(pair?.value.text()).toBe("/sidekiq");
  });

  it("evaluate a string with a loop's variables bound", () => {
    const loop = routesCalls(rubyModule())[2];
    const [get] = loop?.block?.()?.bodyCalls?.() ?? [];
    const path = get?.valueAt(0);
    expect(path?.evaluated?.()).toBeNull();
    expect(
      path?.evaluatedWith?.(
        new Map([
          ["name", "x"],
          ["i", "0"],
        ]),
      ),
    ).toBe("x/0");
  });
});
