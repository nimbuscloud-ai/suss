import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { literalOf, pathOf } from "@suss/values";

import { bodyStatements, field } from "../ast.js";
import {
  collectFileConstants,
  emitConstantBindings,
} from "../facts/constants.js";
import { emitValueFacts } from "../facts/values.js";
import { emitRequireFacts } from "../facts.js";
import { parseRuby } from "../parser.js";
import { findRubyFiles } from "../project.js";
import {
  bindEvaluator,
  evaluatedValue,
  methodDefinitionsIn,
  stringValueOf,
} from "./evaluator.js";

import type { Value } from "@suss/values";
import type { RbNode } from "../parser.js";
import type { EvaluatedFile } from "./evaluator.js";

/** The right side of the top-level `subject = ...` line. */
function subjectNodeIn(root: RbNode): RbNode {
  for (const statement of bodyStatements(root)) {
    if (
      statement.type === "assignment" &&
      field(statement, "left")?.text === "subject"
    ) {
      const right = field(statement, "right");
      if (right !== null) {
        return right;
      }
    }
  }
  throw new Error("no subject assignment");
}

/** The subject of a single file, followed through the engine's own scope walk. */
async function subjectOf(source: string): Promise<Value> {
  const tree = await parseRuby(source);
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
  const definitions = new Map<string, RbNode>();
  const constants = [];
  for (const file of findRubyFiles(dir)) {
    const tree = await parseRuby(fs.readFileSync(file, "utf8"));
    emitValueFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode));
    for (const [key, method] of methodDefinitionsIn(file, tree.rootNode)) {
      definitions.set(key, method);
    }
    parsed.push({ file, root: tree.rootNode });
  }
  emitConstantBindings(db, constants);
  const known = new Set(parsed.map(({ file }) => file));
  for (const { file, root } of parsed) {
    emitRequireFacts(db, file, root, known);
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

describe("literals and names", () => {
  it("reads a string literal", async () => {
    expect(await literal('subject = "/v1"')).toBe("/v1");
    expect(await literal("subject = '/v1'")).toBe("/v1");
  });

  it("follows a constant and a local", async () => {
    expect(await literal('PREFIX = "/api"\nsubject = PREFIX')).toBe("/api");
    expect(await literal('prefix = "/api"\nsubject = prefix')).toBe("/api");
  });

  it("concatenates strings with +", async () => {
    expect(await literal('BASE = "/api"\nsubject = BASE + "/v1" + "/x"')).toBe(
      "/api/v1/x",
    );
  });

  it("reads an interpolation over a known name", async () => {
    expect(await literal('v = "v2"\nsubject = "/api/#{v}/x"')).toBe(
      "/api/v2/x",
    );
  });

  it("leaves a hole in an interpolation over an unknown name", async () => {
    expect(await route('subject = "/api/#{version}/x"')).toBe(
      "/api/{version}/x",
    );
  });

  it("reads adjacent string literals as one", async () => {
    expect(await literal('subject = "/api" "/v1"')).toBe("/api/v1");
  });

  it("reads a symbol as its name", async () => {
    expect(await literal("subject = :users")).toBe("users");
  });

  it("takes the last write to a name", async () => {
    expect(await literal('p = "/a"\np = "/b"\nsubject = p')).toBe("/b");
  });

  it("appends with += and <<", async () => {
    expect(await literal('p = "/a"\np += "/b"\nsubject = p')).toBe("/a/b");
    expect(await literal('p = "/a"\np << "/b"\nsubject = p')).toBe("/a/b");
    expect(await literal('p = "/a"\np <<= "/b"\nsubject = p')).toBe("/a/b");
  });

  it("reads a frozen and a duplicated string", async () => {
    expect(await literal('P = "/a".freeze\nsubject = P.dup')).toBe("/a");
  });

  it("reads a number, a boolean and nil", async () => {
    expect(await subjectOf("subject = 3")).toEqual({
      kind: "constant",
      options: [3],
    });
    expect(await subjectOf("subject = true")).toEqual({
      kind: "constant",
      options: [true],
    });
    expect(await subjectOf("subject = nil")).toEqual({
      kind: "constant",
      options: [null],
    });
  });
});

describe("formatting", () => {
  it("fills a percent placeholder", async () => {
    expect(await literal('v = "v3"\nsubject = "/api/%s/x" % v')).toBe(
      "/api/v3/x",
    );
  });

  it("fills percent placeholders from an array", async () => {
    expect(await literal('subject = "/%s/%s" % ["a", "b"]')).toBe("/a/b");
  });

  it("fills format and sprintf placeholders", async () => {
    expect(await literal('subject = format("/%s/x", "a")')).toBe("/a/x");
    expect(await literal('subject = sprintf("/%s/%s", "a", "b")')).toBe("/a/b");
  });

  it("joins an array of strings", async () => {
    expect(await literal('subject = ["", "api", "v1"].join("/")')).toBe(
      "/api/v1",
    );
  });

  it("sees a push, an append and a << before the join", async () => {
    expect(
      await literal(
        'parts = ["", "api"]\nparts.push("v1")\nparts << "x"\nparts.append("y")\nsubject = parts.join("/")',
      ),
    ).toBe("/api/v1/x/y");
  });

  it("sees a concat and a splat before the join", async () => {
    expect(
      await literal(
        'more = ["v1", "x"]\nparts = ["", "api", *more]\nparts.concat(["y"])\nsubject = parts.join("/")',
      ),
    ).toBe("/api/v1/x/y");
  });

  it("reads a %w array", async () => {
    expect(await literal('subject = %w[api v1].join("/")')).toBe("api/v1");
  });

  it("strips whitespace off a literal", async () => {
    expect(await literal('subject = "  /a ".strip')).toBe("/a");
    expect(await literal('subject = "/a\\n".chomp')).toBe("/a");
    expect(await literal('subject = " /a".lstrip')).toBe("/a");
    expect(await literal('subject = "/a ".rstrip')).toBe("/a");
  });

  it("leaves a strip with an argument, or of an unknown string, as a hole", async () => {
    expect(await literal('subject = "/a/".strip("/")')).toBeNull();
    expect(await literal("subject = unknown.strip")).toBeNull();
  });

  it("leaves a percent over an unknown template as a hole", async () => {
    expect(await literal('subject = unknown % "a"')).toBeNull();
  });

  it("converts through to_s and String()", async () => {
    expect(await literal("subject = 3.to_s")).toBe("3");
    expect(await literal("subject = String(3)")).toBe("3");
  });

  it("concatenates onto a string", async () => {
    expect(await literal('subject = "/a".concat("/b")')).toBe("/a/b");
  });
});

describe("branches and choices", () => {
  it("takes the arm a settled condition picks", async () => {
    expect(
      await literal(
        'flag = true\nif flag\n  p = "/on"\nelse\n  p = "/off"\nend\nsubject = p',
      ),
    ).toBe("/on");
    expect(
      await literal(
        'flag = true\nunless flag\n  p = "/on"\nelse\n  p = "/off"\nend\nsubject = p',
      ),
    ).toBe("/off");
  });

  it("joins both arms when the condition is unknown", async () => {
    expect(
      await route('if flag\n  p = "/on"\nelse\n  p = "/off"\nend\nsubject = p'),
    ).toBe("(/off|/on)");
  });

  it("follows an elsif chain", async () => {
    expect(
      await literal(
        'n = 2\nif n == 1\n  p = "/one"\nelsif n == 2\n  p = "/two"\nelse\n  p = "/other"\nend\nsubject = p',
      ),
    ).toBe("/two");
  });

  it("reads a modifier form", async () => {
    expect(
      await literal(
        'p = "/a"\np = "/b" if false\np = "/c" unless false\nsubject = p',
      ),
    ).toBe("/c");
  });

  it("joins the arms of a case", async () => {
    expect(
      await route(
        'case mode\nwhen :a\n  p = "/a"\nwhen :b\n  p = "/b"\nelse\n  p = "/c"\nend\nsubject = p',
      ),
    ).toBe("(/a|/b|/c)");
  });

  it("reads a ternary", async () => {
    expect(await literal('subject = false ? "/a" : "/b"')).toBe("/b");
  });

  it("reads || as the other side when one side is unknown", async () => {
    expect(await literal('subject = unknown || "/d"')).toBe("/d");
    expect(await literal('subject = nil || "/d"')).toBe("/d");
    expect(await literal('p = nil\np ||= "/d"\nsubject = p')).toBe("/d");
  });

  it("reads && as the right side when the left is truthy", async () => {
    expect(await literal('subject = "/a" && "/b"')).toBe("/b");
    expect(await literal('subject = ("/a" and "/b")')).toBe("/b");
  });

  it("decides ==, !=, ! and not over settled values", async () => {
    expect(await literal('subject = ("a" == "a") ? "/y" : "/n"')).toBe("/y");
    expect(await literal('subject = ("a" != "a") ? "/y" : "/n"')).toBe("/n");
    expect(await literal('subject = !true ? "/y" : "/n"')).toBe("/n");
    expect(await literal('subject = (not true) ? "/y" : "/n"')).toBe("/n");
  });

  it("gives up on a loop body it cannot bound", async () => {
    expect(
      await literal('p = "/a"\nwhile more\n  p += "/x"\nend\nsubject = p'),
    ).toBeNull();
  });

  it("reads an environment default", async () => {
    expect(await literal('subject = ENV.fetch("PREFIX", "/api")')).toBe("/api");
  });

  it("names an environment read with no default after the variable", async () => {
    expect(await route('subject = ENV["PREFIX"] + "/x"')).toBe("{PREFIX}/x");
    expect(await route('subject = ENV.fetch("PREFIX") + "/x"')).toBe(
      "{PREFIX}/x",
    );
  });

  it("joins path segments through File.join", async () => {
    expect(await literal('subject = File.join("/api", "v1", "x")')).toBe(
      "/api/v1/x",
    );
    expect(await route('subject = File.join("/api", version)')).toBe(
      "/api/{version}",
    );
  });

  it("runs a begin body and its ensure", async () => {
    expect(
      await literal(
        'begin\n  p = "/a"\nrescue StandardError\n  p = "/err"\nensure\n  p += "/z"\nend\nsubject = p',
      ),
    ).toBe("/a/z");
  });
});

describe("records and sequences", () => {
  it("reads a field off a hash", async () => {
    expect(
      await literal(
        'cfg = { prefix: "/api", "v" => "1" }\nsubject = cfg[:prefix]',
      ),
    ).toBe("/api");
    expect(
      await literal('cfg = { prefix: "/api", "v" => "1" }\nsubject = cfg["v"]'),
    ).toBe("1");
  });

  it("reads an element off an array", async () => {
    expect(await literal('xs = ["/a", "/b"]\nsubject = xs[1]')).toBe("/b");
  });

  it("reads through a spread hash", async () => {
    expect(
      await literal(
        'base = { prefix: "/api" }\ncfg = { **base, other: 1 }\nsubject = cfg[:prefix]',
      ),
    ).toBe("/api");
  });

  it("declares unpacked names with nothing readable behind them", async () => {
    expect(await literal('a, b = "/x", "/y"\nsubject = a')).toBeNull();
  });

  it("skips a comment inside a hash and a body", async () => {
    expect(
      await literal(
        '# lead\ncfg = {\n  # inside\n  prefix: "/api",\n}\nsubject = cfg[:prefix] # trailing',
      ),
    ).toBe("/api");
  });
});

describe("functions", () => {
  it("reads a method's implicit return through the engine", async () => {
    expect(
      await literal('def prefix\n  "/api"\nend\nsubject = prefix() + "/x"'),
    ).toBe("/api/x");
  });

  it("evaluates a call site's argument inside the method body", async () => {
    expect(
      await literal(
        'def versioned(v)\n  "/api/" + v\nend\nsubject = versioned("v2")',
      ),
    ).toBe("/api/v2");
  });

  it("reads a branch in tail position as the return", async () => {
    expect(
      await literal(
        'def pick(flag)\n  if flag\n    "/on"\n  else\n    "/off"\n  end\nend\nsubject = pick(true)',
      ),
    ).toBe("/on");
  });

  it("reads an endless method and an explicit return", async () => {
    expect(await literal('def p = "/e"\nsubject = p()')).toBe("/e");
    expect(
      await literal('def p\n  return "/r"\n  "/never"\nend\nsubject = p()'),
    ).toBe("/r");
  });

  it("inlines a lambda through call", async () => {
    expect(
      await literal('f = ->(v) { "/api/" + v }\nsubject = f.call("v1")'),
    ).toBe("/api/v1");
    expect(
      await literal('f = lambda { |v| "/api/" + v }\nsubject = f.call("v1")'),
    ).toBe("/api/v1");
  });

  it("reads an outer name from inside a block", async () => {
    expect(
      await literal(
        'prefix = "/api"\nwrap do\n  inner = prefix + "/v1"\n  subject = inner\nend\nsubject = prefix',
      ),
    ).toBe("/api");
  });

  it("widens a name a block assigns", async () => {
    expect(
      await literal('p = "/a"\nitems.each { |i| p = i }\nsubject = p'),
    ).toBeNull();
  });

  it("widens a name a nested block calls an unmodelled method on", async () => {
    expect(
      await literal(
        'parts = ["", "api"]\nitems.each { |i| parts.unshift(i) }\nsubject = parts.join("/")',
      ),
    ).toBeNull();
  });

  it("leaves a call it cannot place as a hole", async () => {
    expect(await route('subject = "/api" + unknown_call("x")')).toBe(
      "/api{unknown_call}",
    );
  });

  it("binds a keyword argument and takes a keyword default", async () => {
    expect(await literal('def p(v:)\n  v\nend\nsubject = p(v: "/x")')).toBe(
      "/x",
    );
    expect(
      await literal(
        'def p(base, v: "/v1", x: "/z")\n  base + v + x\nend\nsubject = p("/api", x: "/y")',
      ),
    ).toBe("/api/v1/y");
  });

  it("takes an optional parameter default when the call leaves it out", async () => {
    expect(
      await literal(
        'def p(v = "v1")\n  "/api/" + v\nend\nsubject = p() + "/x"',
      ),
    ).toBe("/api/v1/x");
    expect(
      await literal(
        'VERSION = "v2"\ndef p(a, v = VERSION, w = v)\n  a + v + w\nend\nsubject = p("/")',
      ),
    ).toBe("/v2v2");
  });

  it("leaves a call with a hash splat or a block as a hole", async () => {
    expect(
      await literal(
        'def p(v: "/x")\n  v\nend\nopts = { v: "/y" }\nsubject = p(**opts)',
      ),
    ).toBeNull();
    expect(
      await literal('def p\n  yield\nend\nsubject = p { "/x" }'),
    ).toBeNull();
  });

  it("reads a parameter as a hole named after it", async () => {
    const tree = await parseRuby(
      'def p(version)\n  subject = "/api/" + version\nend',
    );
    const method = bodyStatements(tree.rootNode)[0] as RbNode;
    const body = field(method, "body") as RbNode;
    const assignment = bodyStatements(body)[0] as RbNode;
    const right = field(assignment, "right") as RbNode;
    expect(pathOf(evaluatedValue(right))).toBe("/api/{version}");
  });

  it("follows a constant from another file", async () => {
    const { subject } = await projectValues({
      "config.rb": 'module Config\n  PREFIX = "/api"\nend',
      "routes.rb": 'require "config"\nsubject = Config::PREFIX + "/x"',
    });
    expect(literalOf(subject("routes.rb"))).toBe("/api/x");
  });

  it("follows a method the facts resolve", async () => {
    const { subject } = await projectValues({
      "a.rb": 'def prefix\n  "/api"\nend\nsubject = prefix() + "/x"',
    });
    expect(literalOf(subject("a.rb"))).toBe("/api/x");
  });

  it("reads a file the project did not bind without the facts", async () => {
    const { db } = await projectValues({ "a.rb": 'subject = "/a"' });
    const tree = await parseRuby('P = "/b"\nsubject = P');
    expect(literalOf(evaluatedValue(subjectNodeIn(tree.rootNode), db))).toBe(
      "/b",
    );
    const unbound = await parseRuby('subject = "/b" + other + more()');
    expect(pathOf(evaluatedValue(subjectNodeIn(unbound.rootNode), db))).toBe(
      "/b{other}{more}",
    );
  });

  it("keys a parameter read under its method", async () => {
    const { db, parsed } = await projectValues({
      "a.rb": 'def p(v)\n  subject = "/api/" + v\nend',
    });
    const root = (parsed[0] as EvaluatedFile).root;
    const method = bodyStatements(root)[0] as RbNode;
    const body = field(method, "body") as RbNode;
    const right = field(bodyStatements(body)[0] as RbNode, "right") as RbNode;
    expect(pathOf(evaluatedValue(right, db))).toBe("/api/{v}");
  });

  it("loses an array a lambda handed to an unknown call can reach", async () => {
    expect(
      await literal(
        'parts = ["", "api"]\nregister(->(x) { parts << x })\nsubject = parts.join("/")',
      ),
    ).toBeNull();
    expect(
      await literal(
        'parts = ["", "api"]\nregister(lambda { |x| parts.push(x) })\nsubject = parts.join("/")',
      ),
    ).toBeNull();
  });

  it("reads a method defined on self and an optional parameter given a value", async () => {
    expect(
      await literal(
        'def self.prefix(v)\n  "/api/" + v\nend\nsubject = self.prefix("v1") + "/x"',
      ),
    ).toBe("/api/v1/x");
    expect(
      await literal('def p(v = "v1")\n  "/api/" + v\nend\nsubject = p("v2")'),
    ).toBe("/api/v2");
  });

  it("reads the tail of a modifier, a begin, parentheses and an elsif", async () => {
    expect(await literal('def p(f)\n  "/a" if f\nend\nsubject = p(true)')).toBe(
      "/a",
    );
    expect(
      await literal(
        'def p\n  begin\n    "/a"\n  ensure\n    cleanup\n  end\nend\nsubject = p()',
      ),
    ).toBe("/a");
    expect(await literal('def p\n  ("/a")\nend\nsubject = p()')).toBe("/a");
    expect(
      await literal(
        'def p(f)\n  if f == 1\n    "/a"\n  elsif f == 2\n    "/b"\n  else\n    "/c"\n  end\nend\nsubject = p(2)',
      ),
    ).toBe("/b");
  });

  it("joins the arms of a case in tail position", async () => {
    expect(
      await route(
        'def p(f)\n  case f\n  when 1\n    "/a"\n  when 2\n    "/b"\n  else\n    "/c"\n  end\nend\nsubject = p(2)',
      ),
    ).toBe("(/a|/b|/c)");
  });

  it("has no value for a method with no body or with two return values", async () => {
    expect(await literal("def p; end\nsubject = p()")).toBeNull();
    expect(
      await literal('def p\n  return "/a", "/b"\nend\nsubject = p()'),
    ).toBeNull();
  });

  it("has no value for call on something other than a lambda", async () => {
    expect(await literal('f = "x"\nsubject = f.call("a")')).toBeNull();
    expect(await literal('subject = a.b.call("a")')).toBeNull();
  });

  it("leaves a call on an unknown receiver or a constant path as a hole", async () => {
    expect(await route('subject = "/a" + thing.join("/")')).toBe("/a{join}");
    expect(await route('subject = "/a" + Paths::Api.join("/")')).toBe(
      "/a{join}",
    );
    expect(await literal('subject = ::File.join("/a", "b")')).toBe("/a/b");
  });

  it("widens a name a loop or a block with parameters writes", async () => {
    expect(
      await literal('p = "/a"\nfor i in items\n  p = i\nend\nsubject = p'),
    ).toBeNull();
    expect(
      await literal('p = "/a"\nuntil done\n  p = "/b"\nend\nsubject = p'),
    ).toBeNull();
    expect(
      await literal('p = "/a"\nitems.each do |i|\n  p = i\nend\nsubject = p'),
    ).toBeNull();
  });

  it("leaves an unless body out when the condition holds", async () => {
    expect(
      await literal('p = "/a"\nunless true\n  p = "/b"\nend\nsubject = p'),
    ).toBe("/a");
    expect(await literal('p = "/a"\np = "/b" unless true\nsubject = p')).toBe(
      "/a",
    );
  });

  it("reads a float, a %i array and a two-index element as written", async () => {
    expect(await subjectOf("subject = 1.5")).toEqual({
      kind: "constant",
      options: [1.5],
    });
    expect(await literal('subject = %i[api v1].join("/")')).toBe("api/v1");
    expect(await literal("subject = parts[1, 2]")).toBeNull();
  });

  it("writes through an attribute on an unknown object", async () => {
    expect(await literal('cfg.prefix = "/a"\nsubject = cfg.prefix')).toBeNull();
  });
});

describe("stringValueOf", () => {
  it("gives the string a node comes down to, or null", async () => {
    const tree = await parseRuby('P = "/a"\nsubject = P\nother = x');
    expect(stringValueOf(subjectNodeIn(tree.rootNode))).toBe("/a");
    const statements = bodyStatements(tree.rootNode);
    const other = field(statements[2] as RbNode, "right") as RbNode;
    expect(stringValueOf(other)).toBeNull();
  });
});
