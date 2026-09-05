import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { literalOf, pathOf } from "@suss/values";

import { children, field, isFunction } from "../ast.js";
import { emitValueFacts, nodeId } from "../facts/values.js";
import { emitModuleImportFacts } from "../facts.js";
import { findPythonFiles } from "../index.js";
import { parsePython } from "../parser.js";
import { bindModule } from "../scope.js";
import { bindEvaluator, evaluatedValue, stringValueOf } from "./evaluator.js";

import type { Value } from "@suss/values";
import type { PyNode } from "../parser.js";
import type { EvaluatedFile } from "./evaluator.js";

/** The right side of the module-level `subject = ...` line. */
function subjectNodeIn(root: PyNode): PyNode {
  for (const statement of children(root)) {
    const inner = children(statement)[0];
    if (
      statement.type !== "expression_statement" ||
      inner?.type !== "assignment"
    ) {
      continue;
    }
    if (field(inner, "left")?.text === "subject") {
      const right = field(inner, "right");
      if (right !== null) {
        return right;
      }
    }
  }
  throw new Error("no subject assignment");
}

/** The subject of a single file, followed through the engine's own scope walk. */
async function subjectOf(source: string): Promise<Value> {
  const tree = await parsePython(source);
  return evaluatedValue(subjectNodeIn(tree.rootNode));
}

async function literal(source: string): Promise<string | null> {
  return literalOf(await subjectOf(source));
}

async function route(source: string): Promise<string | undefined> {
  return pathOf(await subjectOf(source));
}

/** A project on disk with its facts built, the way the adapter builds them. */
async function projectValues(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "values-"));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  const db = new Database();
  const parsed: EvaluatedFile[] = [];
  const definitions = new Map<string, PyNode>();
  for (const file of findPythonFiles(dir)) {
    const tree = await parsePython(fs.readFileSync(file, "utf8"));
    const module = bindModule(tree.rootNode);
    emitModuleImportFacts(db, file, module, { roots: [dir] });
    emitValueFacts(db, file, tree.rootNode);
    for (const fn of functionsIn(tree.rootNode)) {
      definitions.set(nodeId(file, fn), fn);
    }
    parsed.push({ file, root: tree.rootNode, module });
  }
  bindEvaluator(db, { files: parsed, definitions });
  const subject = (name: string): Value => {
    const entry = parsed.find((candidate) => candidate.file.endsWith(name));
    if (entry === undefined) {
      throw new Error(`no file ${name}`);
    }
    return evaluatedValue(subjectNodeIn(entry.root), db);
  };
  return { db, subject, parsed };
}

function functionsIn(node: PyNode): PyNode[] {
  const found = isFunction(node) ? [node] : [];
  return [...found, ...children(node).flatMap(functionsIn)];
}

describe("literals and names", () => {
  it("reads a string literal", async () => {
    expect(await literal('subject = "/v1"')).toBe("/v1");
  });

  it("follows a module-level name", async () => {
    expect(await literal('PREFIX = "/api"\nsubject = PREFIX')).toBe("/api");
  });

  it("concatenates strings with +", async () => {
    expect(await literal('BASE = "/api"\nsubject = BASE + "/v1" + "/x"')).toBe(
      "/api/v1/x",
    );
  });

  it("reads an f-string over a known name", async () => {
    expect(await literal('v = "v2"\nsubject = f"/api/{v}/x"')).toBe(
      "/api/v2/x",
    );
  });

  it("leaves a hole in an f-string over an unknown name", async () => {
    expect(await route('subject = f"/api/{version}/x"')).toBe(
      "/api/{version}/x",
    );
  });

  it("reads adjacent string literals as one", async () => {
    expect(await literal('subject = "/api" "/v1"')).toBe("/api/v1");
  });

  it("takes the last write to a name", async () => {
    expect(await literal('p = "/a"\np = "/b"\nsubject = p')).toBe("/b");
  });

  it("appends with +=", async () => {
    expect(await literal('p = "/a"\np += "/b"\nsubject = p')).toBe("/a/b");
  });

  it("reads a number and a boolean", async () => {
    const value = await subjectOf("subject = 200");
    expect(value.kind === "constant" && value.options).toEqual([200]);
    const flag = await subjectOf("subject = True");
    expect(flag.kind === "constant" && flag.options).toEqual([true]);
  });
});

describe("formatting", () => {
  it("fills str.format placeholders in order", async () => {
    expect(await literal('v = "v1"\nsubject = "/api/{}/x".format(v)')).toBe(
      "/api/v1/x",
    );
  });

  it("leaves a named format placeholder as a hole", async () => {
    expect(await route('subject = "/api/{version}/x".format(version=v)')).toBe(
      "/api/{version}/x",
    );
  });

  it("fills a percent placeholder", async () => {
    expect(await literal('v = "v1"\nsubject = "/api/%s/x" % v')).toBe(
      "/api/v1/x",
    );
  });

  it("fills percent placeholders from a tuple", async () => {
    expect(await literal('subject = "/%s/%s" % ("a", "b")')).toBe("/a/b");
  });

  it("joins a list of strings", async () => {
    expect(
      await literal('parts = ["api", "v1"]\nsubject = "/" + "/".join(parts)'),
    ).toBe("/api/v1");
  });

  it("sees an append before the join", async () => {
    expect(
      await literal(
        'parts = ["api"]\nparts.append("v1")\nsubject = "/".join(parts)',
      ),
    ).toBe("api/v1");
  });

  it("strips whitespace off a literal", async () => {
    expect(await literal('subject = "  /x ".strip()')).toBe("/x");
    expect(await literal('subject = "  /x ".lstrip()')).toBe("/x ");
    expect(await literal('subject = "  /x ".rstrip()')).toBe("  /x");
  });

  it("leaves a strip with an argument, or of an unknown string, as a hole", async () => {
    expect(await literal('subject = "/x/".rstrip("/")')).toBeNull();
    expect(await literal('subject = ("/x" + p).strip()')).toBeNull();
  });

  it("leaves a format or percent over an unknown template as a hole", async () => {
    expect((await subjectOf('subject = template.format("a")')).kind).toBe(
      "hole",
    );
    expect((await subjectOf('subject = template % "a"')).kind).toBe("hole");
  });

  it("sees an extend and a splat before the join", async () => {
    expect(
      await literal(
        'parts = ["a"]\nparts.extend(["b"])\nsubject = "/".join(parts)',
      ),
    ).toBe("a/b");
    expect(
      await literal(
        'base = ["a"]\nparts = [*base, "b"]\nsubject = "/".join(parts)',
      ),
    ).toBe("a/b");
  });

  it("converts through str()", async () => {
    expect(await literal('subject = "/v" + str(2)')).toBe("/v2");
    expect(await literal('subject = "/v" + str(1.5)')).toBe("/v1.5");
  });
});

describe("branches and choices", () => {
  it("takes the arm a settled condition picks", async () => {
    expect(
      await literal(
        'flag = True\nif flag:\n    p = "/a"\nelse:\n    p = "/b"\nsubject = p',
      ),
    ).toBe("/a");
  });

  it("joins both arms when the condition is unknown", async () => {
    expect(
      await route('if flag:\n    p = "/a"\nelse:\n    p = "/b"\nsubject = p'),
    ).toBe("(/a|/b)");
  });

  it("follows an elif chain", async () => {
    expect(
      await literal(
        'n = 2\nif n == 1:\n    p = "/a"\nelif n == 2:\n    p = "/b"\nelse:\n    p = "/c"\nsubject = p',
      ),
    ).toBe("/b");
  });

  it("keeps the earlier write when no arm of an elif chain is taken", async () => {
    expect(
      await literal(
        'p = "/c"\nn = 3\nif n == 1:\n    p = "/a"\nelif n == 2:\n    p = "/b"\nsubject = p',
      ),
    ).toBe("/c");
  });

  it("runs a try body and its finally", async () => {
    expect(
      await literal(
        'try:\n    p = "/a"\nfinally:\n    p = p + "/b"\nsubject = p',
      ),
    ).toBe("/a/b");
  });

  it("runs the body of a with", async () => {
    expect(
      await literal('with open("f") as fh:\n    p = "/a"\nsubject = p + "/b"'),
    ).toBe("/a/b");
  });

  it("reads a conditional expression", async () => {
    expect(
      await literal('debug = False\nsubject = "/dev" if debug else "/prod"'),
    ).toBe("/prod");
  });

  it("reads `or` as the other side when one side is unknown", async () => {
    expect(await literal('subject = unknown or "/v1"')).toBe("/v1");
  });

  it("reads `and` as the right side when the left is truthy", async () => {
    expect(await literal('subject = "/a" and "/b"')).toBe("/b");
    expect(await literal('subject = "" and "/b"')).toBe("");
  });

  it("decides `!=`, `is`, `is not` and `not` over settled values", async () => {
    const arm = (condition: string) =>
      literal(
        `flag = None\nn = 1\nif ${condition}:\n    p = "/a"\nelse:\n    p = "/b"\nsubject = p`,
      );
    expect(await arm("n != 1")).toBe("/b");
    expect(await arm("flag is None")).toBe("/a");
    expect(await arm("flag is not None")).toBe("/b");
    expect(await arm("not flag")).toBe("/a");
  });

  it("gives up on a loop body it cannot bound", async () => {
    const value = await subjectOf(
      'items = []\nwhile more():\n    items.append("/x")\nsubject = "".join(items)',
    );
    expect(literalOf(value)).toBeNull();
  });

  it("reads an environment default", async () => {
    expect(
      await literal('import os\nsubject = os.environ.get("PREFIX", "/v1")'),
    ).toBe("/v1");
    expect(
      await literal('import os\nsubject = os.getenv("PREFIX", "/v2")'),
    ).toBe("/v2");
  });

  it("names an environment read with no default after the variable", async () => {
    expect(await route('import os\nsubject = os.getenv("PREFIX") + "/x"')).toBe(
      "{PREFIX}/x",
    );
  });

  it("joins path segments through os.path.join", async () => {
    expect(
      await literal('import os\nsubject = os.path.join("/api", "v1", "x")'),
    ).toBe("/api/v1/x");
    expect(
      await literal('from os.path import join\nsubject = join("/api", "v1")'),
    ).toBe("/api/v1");
    expect(
      await literal('import os.path\nsubject = os.path.join("/api", "v1")'),
    ).toBe("/api/v1");
  });
});

describe("records and sequences", () => {
  it("reads a field off a dictionary", async () => {
    expect(
      await literal('cfg = {"prefix": "/api"}\nsubject = cfg["prefix"]'),
    ).toBe("/api");
  });

  it("reads an element off a list", async () => {
    expect(await literal('items = ["/a", "/b"]\nsubject = items[1]')).toBe(
      "/b",
    );
  });

  it("reads through a spread dictionary", async () => {
    expect(
      await literal(
        'base = {"prefix": "/api"}\ncfg = {**base, "x": 1}\nsubject = cfg["prefix"]',
      ),
    ).toBe("/api");
  });

  it("reads a field whose key is a name", async () => {
    expect(
      await literal('k = "prefix"\ncfg = {k: "/api"}\nsubject = cfg["prefix"]'),
    ).toBe("/api");
  });

  it("declares unpacked names with nothing readable behind them", async () => {
    expect((await subjectOf("a, b = pair()\nsubject = a")).kind).toBe("hole");
  });

  it("leaves an annotation without a value, a slice and a chained comparison alone", async () => {
    expect((await subjectOf("p: str\nsubject = p")).kind).toBe("hole");
    expect((await subjectOf('items = ["/a"]\nsubject = items[1:]')).kind).toBe(
      "hole",
    );
    expect(
      await literal('n = 2\nsubject = "/a" if 1 < n < 3 else "/b"'),
    ).toBeNull();
  });

  it("skips a comment inside a dictionary", async () => {
    expect(
      await literal(
        'cfg = {\n    "prefix": "/api",  # the mount point\n}\nsubject = cfg["prefix"]',
      ),
    ).toBe("/api");
  });
});

describe("functions", () => {
  it("loses a list a callback handed to an unknown call can reach", async () => {
    const value = await subjectOf(
      'parts = ["a"]\nregister(lambda: parts.append("b"))\nsubject = "/".join(parts)',
    );
    expect(literalOf(value)).toBeNull();
    const withParameter = await subjectOf(
      'parts = ["a"]\nregister(lambda x: parts.append(x, sep=""))\nsubject = "/".join(parts)',
    );
    expect(literalOf(withParameter)).toBeNull();
  });

  it("widens a name a nested function calls an unmodelled method on", async () => {
    expect(
      await literal(
        'cfg = {"prefix": "/a"}\ndef setup():\n    cfg.update(prefix="/b")\nsubject = cfg["prefix"]',
      ),
    ).toBeNull();
    expect(
      await literal(
        'BASE = "/api"\ndef setup():\n    return BASE.rstrip("/")\nsubject = BASE + "/x"',
      ),
    ).toBe("/api/x");
  });

  it("leaves a call it cannot place as a hole", async () => {
    for (const source of [
      'subject = handlers["x"]("/y")',
      'subject = unknown.thing("/x")',
      'f = make()\nsubject = f("/x")',
      'from .lib import join\nsubject = join("/a", "b")',
      'import os\nsubject = os("/x")',
      'import join\nsubject = join("/a", "b")',
      'def join(a, b):\n    return a\n\nsubject = join("/a", "b")',
      'subject = handlers["x"].getenv("K")',
    ]) {
      expect((await subjectOf(source)).kind).toBe("hole");
    }
  });
  it("evaluates a call site's argument inside the function body", async () => {
    const { subject } = await projectValues({
      "app.py": [
        "def prefixed(p):",
        '    return "/v1" + p',
        "",
        'subject = prefixed("/x")',
        "",
      ].join("\n"),
    });
    expect(literalOf(subject("app.py"))).toBe("/v1/x");
  });

  it("reads a module constant from inside a function", async () => {
    const { subject } = await projectValues({
      "app.py": [
        'BASE = "/api"',
        "",
        "def make():",
        '    return BASE + "/x"',
        "",
        "subject = make()",
        "",
      ].join("\n"),
    });
    expect(literalOf(subject("app.py"))).toBe("/api/x");
  });

  it("follows a name imported from another file", async () => {
    const { subject } = await projectValues({
      "settings.py": 'PREFIX = "/api/v1"\n',
      "app.py": 'from settings import PREFIX\n\nsubject = PREFIX + "/x"\n',
    });
    expect(literalOf(subject("app.py"))).toBe("/api/v1/x");
  });

  it("inlines a lambda", async () => {
    const { subject } = await projectValues({
      "app.py": 'prefixed = lambda p: "/v1" + p\n\nsubject = prefixed("/x")\n',
    });
    expect(literalOf(subject("app.py"))).toBe("/v1/x");
  });

  it("leaves a name imported from a module it cannot find as a hole", async () => {
    const { subject } = await projectValues({
      "app.py":
        'from vendor.settings import PREFIX\n\nsubject = PREFIX + "/x"\n',
    });
    expect(pathOf(subject("app.py"))).toBe("{PREFIX}/x");
  });

  it("reads a file the project did not bind without the facts", async () => {
    const { db } = await projectValues({
      "settings.py": 'PREFIX = "/api/v1"\n',
    });
    const tree = await parsePython(
      'from settings import PREFIX\n\nsubject = PREFIX + make("/x")\n',
    );
    const value = evaluatedValue(subjectNodeIn(tree.rootNode), db);
    expect(literalOf(value)).toBeNull();
    expect(pathOf(value)).toBe("{PREFIX}{param}");
  });

  it("binds a keyword argument and takes a default for the rest", async () => {
    const { subject } = await projectValues({
      "app.py": [
        'def prefixed(p, base="/v1"):',
        "    return base + p",
        "",
        'subject = prefixed(p="/x")',
        "",
      ].join("\n"),
    });
    expect(literalOf(subject("app.py"))).toBe("/v1/x");
  });

  it("reads a default from a module constant and a typed parameter", async () => {
    const { subject } = await projectValues({
      "app.py": [
        'VERSION = "/v2"',
        "",
        'def prefixed(p: str, base: str = VERSION, extra: str = ""):',
        "    return base + p + extra",
        "",
        'subject = prefixed("/x", extra="/y")',
        "",
      ].join("\n"),
    });
    expect(literalOf(subject("app.py"))).toBe("/v2/x/y");
  });

  it("leaves a call with a dictionary splat as a hole", async () => {
    const { subject } = await projectValues({
      "app.py": [
        'def prefixed(p, base="/v1"):',
        "    return base + p",
        "",
        'options = {"p": "/x"}',
        "subject = prefixed(**options)",
        "",
      ].join("\n"),
    });
    expect(subject("app.py").kind).toBe("hole");
  });

  it("reads a parameter as a hole named after it", async () => {
    const tree = await parsePython(
      ["def handler(p):", '    subject = "/v1" + p', ""].join("\n"),
    );
    const fn = children(tree.rootNode)[0] as PyNode;
    const body = field(fn, "body") as PyNode;
    const node = subjectNodeIn(body);
    expect(pathOf(evaluatedValue(node))).toBe("/v1{p}");
  });

  it("leaves a method's receiver as a hole and binds the argument", async () => {
    const { subject } = await projectValues({
      "app.py": [
        "class Api:",
        "    def path(self, p):",
        "        return self.base + p",
        "",
        'subject = Api().path("/x")',
        "",
      ].join("\n"),
    });
    const value = subject("app.py");
    expect(literalOf(value)).toBeNull();
    expect(pathOf(value)).toBe("{base}/x");
  });
});

describe("stringValueOf", () => {
  it("gives the string a node comes down to, or null", async () => {
    const tree = await parsePython('P = "/a"\nsubject = P\nother = unknown\n');
    const statements = children(tree.rootNode);
    const second = field(
      children(statements[1] as PyNode)[0] as PyNode,
      "right",
    ) as PyNode;
    const third = field(
      children(statements[2] as PyNode)[0] as PyNode,
      "right",
    ) as PyNode;
    expect(stringValueOf(second)).toBe("/a");
    expect(stringValueOf(third)).toBeNull();
  });
});
