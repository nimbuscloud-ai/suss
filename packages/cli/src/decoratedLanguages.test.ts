/**
 * The decorators a function or class is written under, read through the
 * module ops' `decorated()` from the `decoratedWith` rows each adapter
 * states. TypeScript decorates a class and its methods, and Python a
 * function and a class. Ruby writes no decorators, so it states no rows
 * and the module ops list nothing.
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
import { constructedFrom, discoverDeclared } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type {
  DecoratedDefinition,
  DecoratedMatch,
  Decorator,
  ModuleOps,
} from "@suss/extractor";

const TYPESCRIPT = `
import { Audited, Controller, Get, Post } from "lib";

@Controller("orders")
export class Orders {
  @Get("/")
  list() {
    return [];
  }

  @Post("/")
  @Audited
  create() {
    return {};
  }

  plain() {
    return null;
  }
}

export class Undecorated {
  run() {
    return null;
  }
}

class Hidden {
  @Get("/hidden")
  read() {
    return null;
  }
}
`;

const PYTHON = `
from lib import app, cached, ns

@app.middleware("http")
async def stamp(request, call_next):
    return await call_next(request)

@ns.route("/orders")
class Orders:
    @ns.response(200)
    @cached
    def get(self):
        return []

    @staticmethod
    def plain():
        return None

def undecorated():
    return None
`;

const RUBY = `
class Orders
  def list
    []
  end

  def self.create
    {}
  end
end
`;

let root: string;

beforeAll(async () => {
  await preloadRubyGrammar();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-decorated-")),
  );
  fs.writeFileSync(path.join(root, "orders.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function typescriptModule(source = TYPESCRIPT): ModuleOps {
  const project = createTestProject();
  const file = project.createSourceFile("/orders.ts", source);
  return moduleOpsFor(file, ResolutionStore.forPacks([]));
}

async function pythonModule(source = PYTHON): Promise<ModuleOps> {
  const file = path.join(root, "orders.py");
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const db = pythonFactsForFile({
    file,
    root: tree.rootNode,
    module,
    packs: [],
  });
  return pythonModuleOps(
    { file, displayPath: "orders.py", root: tree.rootNode, module },
    db,
  );
}

/** A decorator as the source writes it: a call by its callee, anything else by its text. */
function written(decorator: Decorator): string {
  return decorator.form === "call"
    ? `call ${decorator.call.calleeText()}`
    : `value ${decorator.value.source?.() ?? ""}`;
}

/** Each definition by the line it starts with, and its decorators. */
function said(decorated: readonly DecoratedDefinition[]) {
  return decorated.map(({ definition, decorators }) => ({
    definition: (definition.source?.() ?? "").split("\n")[0]?.trim(),
    decorators: decorators.map(written),
  }));
}

describe("the decorators a definition is written under, read in three languages", () => {
  it("lists a decorated class and its decorated methods, an unexported class's too, top decorator first, in TypeScript", () => {
    expect(said(typescriptModule().decorated())).toEqual([
      {
        definition: '@Controller("orders")',
        decorators: ["call Controller"],
      },
      { definition: '@Get("/")', decorators: ["call Get"] },
      { definition: '@Post("/")', decorators: ["call Post", "value Audited"] },
      { definition: '@Get("/hidden")', decorators: ["call Get"] },
    ]);
  });

  it("lists a decorated function, a decorated class and a stacked method, top decorator first, in Python", async () => {
    expect(said((await pythonModule()).decorated())).toEqual([
      {
        definition: "async def stamp(request, call_next):",
        decorators: ["call app.middleware"],
      },
      { definition: "class Orders:", decorators: ["call ns.route"] },
      {
        definition: "def get(self):",
        decorators: ["call ns.response", "value cached"],
      },
      { definition: "def plain():", decorators: ["value staticmethod"] },
    ]);
  });

  it("lists nothing in Ruby, which writes no decorators", () => {
    expect(moduleOpsForFile(path.join(root, "orders.rb")).decorated()).toEqual(
      [],
    );
  });

  it("states no decoratedWith rows in Ruby", async () => {
    const file = path.join(root, "orders.rb");
    const db = rubyFactsForFile({
      file,
      root: (await parseRuby(RUBY)).rootNode,
      packs: [],
    });
    expect(db.facts("decoratedWith")).toEqual([]);
  });
});

const TYPESCRIPT_HOOKS = `
import { App } from "lib";
import { Other } from "elsewhere";

const app = new App();
const other = new Other();

export class Hooks {
  @app.middleware("http")
  stamp() {
    return null;
  }

  @app.prepare
  check() {
    return null;
  }

  @other.middleware("http")
  foreign() {
    return null;
  }

  @app.unlisted("x")
  plain() {
    return null;
  }
}

@app.middleware("http")
export class Wrapped {}
`;

const PYTHON_HOOKS = `
from lib import App
from elsewhere import Other

app = App()
other = Other()

@app.middleware("http")
async def stamp(request, call_next):
    return await call_next(request)

@app.prepare
def check():
    return None

@other.middleware("http")
def foreign():
    return None

@app.unlisted("x")
def plain():
    return None

@app.middleware("http")
class Wrapped:
    pass

def setup():
    @app.middleware("http")
    async def nested(request, call_next):
        return await call_next(request)
`;

const HOOKS: DecoratedMatch = {
  type: "decorated",
  on: constructedFrom({ from: ["lib"], named: ["App"] }),
  named: { middleware: { kind: "middleware" }, prepare: { kind: "hook" } },
};

/** Each unit the match finds, with the decorator and the call its receiver was written as. */
function decoratedUnits(module: ModuleOps): string[] {
  return discoverDeclared(HOOKS, "handler", module).map(
    (unit) =>
      `${unit.kind} ${unit.name} @${unit.decoratedBy?.method} on ${unit.decoratedBy?.on.calleeText()}`,
  );
}

describe("a function found by the library decorator it is written under, in two languages", () => {
  const BOTH = [
    "middleware stamp @middleware on App",
    "hook check @prepare on App",
  ];

  it("finds a method under a decorator called on, or read off, a value the library made, in TypeScript", () => {
    expect(decoratedUnits(typescriptModule(TYPESCRIPT_HOOKS))).toEqual(BOTH);
  });

  it("finds the same functions, and one written inside another function, in Python", async () => {
    expect(decoratedUnits(await pythonModule(PYTHON_HOOKS))).toEqual([
      ...BOTH,
      "middleware nested @middleware on App",
    ]);
  });

  it("reads no file whose text writes none of the methods", async () => {
    expect(decoratedUnits(await pythonModule(PYTHON))).toEqual([]);
  });
});
