import { describe, expect, it } from "vitest";

import { envReadEffects } from "./envReads.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";

import type { Effect } from "@suss/behavioral-ir";
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

  it("ignores writes and membership tests", async () => {
    expect(
      await moduleReads(
        'import os\nos.environ["A"] = "1"\nif "B" in os.environ:\n    pass\n',
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
