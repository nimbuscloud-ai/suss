import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envReadEffects } from "./envReads.js";
import { parsePython } from "./parser.js";
import { extractPythonProject, factsForFile } from "./project.js";
import { bindModule } from "./scope.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PyNode } from "./parser.js";

interface Read {
  name: string;
  defaulted: boolean;
}

function readsOf(effects: Effect[]): Read[] {
  return effects.map((effect) => {
    if (
      effect.type !== "interaction" ||
      effect.interaction.class !== "config-read"
    ) {
      throw new Error(`not a config read: ${JSON.stringify(effect)}`);
    }
    return {
      name: effect.interaction.name,
      defaulted: effect.interaction.defaulted,
    };
  });
}

async function moduleReads(source: string): Promise<Read[]> {
  const tree = await parsePython(source);
  return readsOf(envReadEffects(tree.rootNode, bindModule(tree.rootNode)));
}

async function functionReads(source: string, name: string): Promise<Read[]> {
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const definition = findFunction(tree.rootNode, name);
  return readsOf(envReadEffects(definition, module));
}

/** One file with the facts a project run would emit over it, so a call can ask the rules about its callee. */
async function withFacts(source: string): Promise<{
  root: PyNode;
  module: ReturnType<typeof bindModule>;
  db: ReturnType<typeof factsForFile>;
}> {
  const file = path.join(os.tmpdir(), "suss-env-reads", "settings.py");
  const tree = await parsePython(source);
  const module = bindModule(tree.rootNode);
  const db = factsForFile({ file, root: tree.rootNode, module, packs: [] });
  return { root: tree.rootNode, module, db };
}

async function moduleReadsWithFacts(source: string): Promise<Read[]> {
  const { root, module, db } = await withFacts(source);
  return readsOf(envReadEffects(root, module, db));
}

async function functionReadsWithFacts(
  source: string,
  name: string,
): Promise<Read[]> {
  const { root, module, db } = await withFacts(source);
  return readsOf(envReadEffects(findFunction(root, name), module, db));
}

function findFunction(node: PyNode, name: string): PyNode {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (
      child.type === "function_definition" &&
      child.childForFieldName("name")?.text === name
    ) {
      return child;
    }
    const inner = findFunctionOrNull(child, name);
    if (inner !== null) {
      return inner;
    }
  }
  throw new Error(`no function ${name}`);
}

function findFunctionOrNull(node: PyNode, name: string): PyNode | null {
  try {
    return findFunction(node, name);
  } catch {
    return null;
  }
}

describe("os.environ spellings", () => {
  it('reads os.environ["X"] as a read with no fallback', async () => {
    expect(await moduleReads('import os\nA = os.environ["A"]\n')).toEqual([
      { name: "A", defaulted: false },
    ]);
  });

  it('reads os.environ.get("X") as undefaulted and .get("X", d) as defaulted', async () => {
    expect(
      await moduleReads(
        'import os\nA = os.environ.get("A")\nB = os.environ.get("B", "d")\n',
      ),
    ).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: true },
    ]);
  });

  it('reads os.getenv("X") and os.getenv("X", d)', async () => {
    expect(
      await moduleReads(
        'import os\nA = os.getenv("A")\nB = os.getenv("B", "d")\nC = os.getenv("C", default="d")\n',
      ),
    ).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: true },
      { name: "C", defaulted: true },
    ]);
  });

  it("counts an `or` fallback as a default, anywhere but the chain's tail", async () => {
    expect(
      await moduleReads(
        'import os\nA = os.environ["A"] or "d"\nB = (os.environ.get("B")) or "d"\nC = other or os.environ["C"] or "d"\nD = other or os.environ["D"]\n',
      ),
    ).toEqual([
      { name: "A", defaulted: true },
      { name: "B", defaulted: true },
      { name: "C", defaulted: true },
      { name: "D", defaulted: false },
    ]);
  });

  it("follows the names the file imported os under", async () => {
    expect(
      await moduleReads(
        'import os as _os\nfrom os import environ, getenv\nA = _os.environ["A"]\nB = environ.get("B")\nC = getenv("C")\nD = environ["D"]\n',
      ),
    ).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: false },
      { name: "C", defaulted: false },
      { name: "D", defaulted: false },
    ]);
  });

  it("skips a read whose name is not a string literal", async () => {
    expect(
      await moduleReads(
        'import os\nA = os.environ[name]\nB = os.environ.get(f"{prefix}_B")\nC = os.getenv(name)\n',
      ),
    ).toEqual([]);
  });

  it("ignores an environ or getenv that did not come from os", async () => {
    expect(
      await moduleReads(
        'from myconfig import environ, getenv\nimport myos as os\nA = environ["A"]\nB = getenv("B")\nC = os.environ["C"]\n',
      ),
    ).toEqual([]);
  });

  it("ignores writes, deletions and membership tests", async () => {
    expect(
      await moduleReads(
        'import os\nos.environ["A"] = "1"\ndel os.environ["D"]\nos.environ["E"] += "1"\nif "B" in os.environ:\n    pass\n',
      ),
    ).toEqual([]);
  });

  it("ignores a subscript or a .get on something that is not os.environ", async () => {
    expect(
      await moduleReads(
        'import os\nA = settings()["A"]\nB = os.path["B"]\nC = load().get("C")\nD = os.environ.copy().get("D")\nE = load().getenv("E")\n',
      ),
    ).toEqual([]);
  });
});

describe("what runs at import time", () => {
  it("reads the module body and class bodies, and leaves function bodies to their own units", async () => {
    expect(
      await moduleReads(
        'import os\nA = os.environ["A"]\nclass Settings:\n    B = os.environ["B"]\ndef handler():\n    return os.environ["C"]\nf = lambda: os.environ["D"]\n',
      ),
    ).toEqual([
      { name: "A", defaulted: false },
      { name: "B", defaulted: false },
    ]);
  });

  it("reads a decorator's arguments, which run when the module loads", async () => {
    expect(
      await moduleReads(
        'import os\n@app.route(os.environ["PREFIX"])\ndef handler():\n    return 1\n',
      ),
    ).toEqual([{ name: "PREFIX", defaulted: false }]);
  });
});

describe("what a function body reads", () => {
  it("reads the body and stops at a nested function", async () => {
    expect(
      await functionReads(
        'import os\ndef handler():\n    a = os.environ["A"]\n    def inner():\n        return os.environ["B"]\n    return a\n',
        "handler",
      ),
    ).toEqual([{ name: "A", defaulted: false }]);
  });

  it("resolves os through an import inside the function", async () => {
    expect(
      await functionReads(
        'def handler():\n    import os\n    return os.environ.get("A", "d")\n',
        "handler",
      ),
    ).toEqual([{ name: "A", defaulted: true }]);
  });

  it("spells every read as os.environ[...] so the checker names one channel", async () => {
    const tree = await parsePython('import os\nA = os.getenv("A")\n');
    const [effect] = envReadEffects(tree.rootNode, bindModule(tree.rootNode));
    expect(effect).toMatchObject({
      type: "interaction",
      callee: 'os.environ["A"]',
      binding: {
        transport: "os",
        semantics: { name: "runtime-config", deploymentTarget: "lambda" },
        recognition: "python-env",
      },
    });
  });
});

const SUBSCRIPT_HELPER = [
  "import os",
  "",
  "",
  "def env(key):",
  "    return os.environ[key]",
  "",
  "",
].join("\n");

describe("a call to a helper that reads the environment", () => {
  it("reads the caller's literal as the variable the helper looks up", async () => {
    expect(
      await moduleReadsWithFacts(
        `${SUBSCRIPT_HELPER}DATABASE_URL = env("DATABASE_URL")\n`,
      ),
    ).toEqual([{ name: "DATABASE_URL", defaulted: false }]);
  });

  it("takes the fallback from the helper's own read rather than from the call", async () => {
    expect(
      await moduleReadsWithFacts(
        [
          "import os",
          "",
          "",
          "def env(key, default=None):",
          "    return os.environ.get(key, default)",
          "",
          "",
          'DATABASE_URL = env("DATABASE_URL")',
          'POOL_SIZE = env("POOL_SIZE", 5)',
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { name: "DATABASE_URL", defaulted: true },
      { name: "POOL_SIZE", defaulted: true },
    ]);
  });

  it("reads a name the caller passes by keyword", async () => {
    expect(
      await moduleReadsWithFacts(
        `${SUBSCRIPT_HELPER}REDIS_URL = env(key="REDIS_URL")\n`,
      ),
    ).toEqual([{ name: "REDIS_URL", defaulted: false }]);
  });

  it("reads a name the caller wrote as a constant somewhere else", async () => {
    expect(
      await moduleReadsWithFacts(
        `${SUBSCRIPT_HELPER}NAME = "CACHE_URL"\nCACHE_URL = env(NAME)\n`,
      ),
    ).toEqual([{ name: "CACHE_URL", defaulted: false }]);
  });

  it("says nothing at a call whose parameter never reaches a read", async () => {
    expect(
      await moduleReadsWithFacts(
        [
          SUBSCRIPT_HELPER,
          "def log(message):",
          "    return message",
          "",
          "",
          'A = env("A")',
          'log("B")',
          "",
        ].join("\n"),
      ),
    ).toEqual([{ name: "A", defaulted: false }]);
  });

  it("says nothing when the caller writes no argument at the parameter", async () => {
    expect(
      await moduleReadsWithFacts(`${SUBSCRIPT_HELPER}A = env()\n`),
    ).toEqual([]);
  });

  it("says nothing when the caller's argument does not settle on one string", async () => {
    expect(
      await functionReadsWithFacts(
        `${SUBSCRIPT_HELPER}def handler(name):\n    return env(name)\n`,
        "handler",
      ),
    ).toEqual([]);
  });

  it("reads a call in a function body, on that body's own unit", async () => {
    expect(
      await functionReadsWithFacts(
        `${SUBSCRIPT_HELPER}def handler():\n    return env("TABLE_NAME")\n`,
        "handler",
      ),
    ).toEqual([{ name: "TABLE_NAME", defaulted: false }]);
  });

  it("says nothing on the helper's own body, where no caller has named anything", async () => {
    expect(
      await functionReadsWithFacts(`${SUBSCRIPT_HELPER}A = env("A")\n`, "env"),
    ).toEqual([]);
  });
});

describe("a project whose environment reads go through a helper", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-env-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, lines: string[]): string {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${lines.join("\n")}\n`);
    return full;
  }

  function configReadsOf(summaries: BehavioralSummary[]): Read[] {
    return summaries.flatMap((summary) =>
      summary.transitions.flatMap((transition) =>
        transition.effects.flatMap((effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "config-read"
            ? [
                {
                  name: effect.interaction.name,
                  defaulted: effect.interaction.defaulted,
                },
              ]
            : [],
        ),
      ),
    );
  }

  it("follows the name through a helper that hands it to another helper in another file", async () => {
    const reader = write("myapp/env.py", [
      "import os",
      "",
      "",
      "def read(key, default=None):",
      "    return os.environ.get(key, default)",
    ]);
    const settings = write("myapp/settings.py", [
      "from myapp.env import read",
      "",
      "",
      "def setting(name):",
      "    return read(name)",
    ]);
    const db = write("myapp/db.py", [
      "from myapp.settings import setting",
      "",
      'DATABASE_URL = setting("DATABASE_URL")',
    ]);

    const { summaries } = await extractPythonProject({
      files: [reader, settings, db],
      packs: [],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    const loadTime = summaries.filter((s) => s.kind === "module-init");
    expect(loadTime.map((s) => s.location.file)).toEqual(["myapp/db.py"]);
    expect(configReadsOf(loadTime)).toEqual([
      { name: "DATABASE_URL", defaulted: true },
    ]);
  });

  it("states no read site for a project whose reads all write their own name", async () => {
    const only = write("myapp/settings.py", [
      "import os",
      "",
      'TABLE = os.environ["TABLE_NAME"]',
    ]);

    const { summaries, facts } = await extractPythonProject({
      files: [only],
      packs: [],
      roots: [tmpDir],
      workspaceRoot: tmpDir,
    });

    expect(facts.facts("readsEnvNamed")).toEqual([]);
    expect(configReadsOf(summaries)).toEqual([
      { name: "TABLE_NAME", defaulted: false },
    ]);
  });
});
