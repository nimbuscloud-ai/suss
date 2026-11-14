/**
 * A test calls production code with stand-ins, so a call written in test
 * code never fills a parameter of a function written outside it. The
 * same project is written in TypeScript, Python and Ruby: a production
 * function takes a callback, a production caller passes one, and a test
 * passes a stub. Each language asks what the callback comes to, through
 * its own facts and the shared rules, and has to give the same answer.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node, SyntaxKind } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";

import {
  bindModule,
  emitModuleImportFacts,
  emitValueFacts as emitPythonFacts,
  parsePython,
  pythonFactSource,
} from "@suss/adapter-python";
import {
  collectFileConstants,
  emitConstantBindings,
  emitValueFacts as emitRubyFacts,
  parseRuby,
  rubyFactSource,
} from "@suss/adapter-ruby";
import {
  factSourceFor,
  ResolutionStore,
  statedFactKey,
} from "@suss/adapter-typescript";
import { Database } from "@suss/datalog";
import { spanOfKey } from "@suss/resolution";
import { createTestProject } from "@suss/test-project";

import type { FileConstants } from "@suss/adapter-ruby";
import type { FactSource } from "@suss/extractor";

/** Which callers a project has: the production one, the test one, both or neither. */
type Callers = "both" | "production" | "test" | "none";

/** What the callback comes to, as the text of each function, and the same for a helper the test calls. */
interface Reading {
  callback: string[];
  helper: string[];
}

/** A project's three files, each under what it is for: the source it contains, or its path. */
interface ProjectFiles {
  /** The production function, which calls its parameter. */
  function: string;
  production: string;
  test: string;
}

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A project on disk with these files, gone when the tests are. */
function onDisk(files: Record<string, string>): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-callers-")),
  );
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  return root;
}

/** The source of each file a project with these callers has, by its path. */
function filesFor(
  sources: ProjectFiles,
  names: ProjectFiles,
  callers: Callers,
): Record<string, string> {
  const files: Record<string, string> = { [names.function]: sources.function };
  if (callers === "both" || callers === "production") {
    files[names.production] = sources.production;
  }
  if (callers === "both" || callers === "test") {
    files[names.test] = sources.test;
  }
  return files;
}

/** The text of each key's node, sorted, so a reading compares across languages. */
function textsOf(
  keys: readonly string[],
  textOf: (key: string) => string,
): string[] {
  return keys.map((key) => textOf(key).replace(/\s+/g, " ")).sort();
}

/** The source a node key spans, read off the file on disk. */
function spannedText(key: string): string {
  const span = spanOfKey(key);
  return span === null
    ? key
    : fs.readFileSync(span.file, "utf8").slice(span.start, span.end);
}

const TYPESCRIPT: ProjectFiles = {
  function: `
    export function notify(onDone: () => void) {
      onDone();
    }
  `,
  production: `
    import { notify } from "./alerts";

    function deliver() {}

    notify(deliver);
  `,
  test: `
    import { notify } from "./alerts";

    function check(run: () => void) {
      run();
    }

    notify(() => {});
    check(() => {});
  `,
};

const PYTHON: ProjectFiles = {
  function: ["def notify(on_done):", "    on_done()", ""].join("\n"),
  production: [
    "from alerts import notify",
    "",
    "def deliver():",
    "    pass",
    "",
    "notify(deliver)",
    "",
  ].join("\n"),
  test: [
    "from alerts import notify",
    "",
    "def check(run):",
    "    run()",
    "",
    "notify(lambda: None)",
    "check(lambda: None)",
    "",
  ].join("\n"),
};

const RUBY: ProjectFiles = {
  function: [
    "module Alerts",
    "  def self.notify(on_done)",
    "    on_done.call",
    "  end",
    "end",
    "",
  ].join("\n"),
  production: ["DELIVER = -> { nil }", "", "Alerts.notify(DELIVER)", ""].join(
    "\n",
  ),
  test: [
    "def check(run)",
    "  run.call",
    "end",
    "",
    "Alerts.notify(-> { 1 })",
    "check(-> { 2 })",
    "",
  ].join("\n"),
};

async function typescriptReading(callers: Callers): Promise<Reading> {
  const project = createTestProject();
  const files = filesFor(
    TYPESCRIPT,
    {
      function: "/src/alerts.ts",
      production: "/src/main.ts",
      test: "/src/alerts.test.ts",
    },
    callers,
  );
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const store = new ResolutionStore();
  const source = factSourceFor(store);
  const calledIn = (file: string, callee: string): readonly string[] => {
    const call = project
      .getSourceFile(file)
      ?.getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((one) => one.getExpression().getText() === callee);
    if (call === undefined) {
      return [];
    }
    const read = call.getExpression();
    return Node.isIdentifier(read)
      ? (source.comesTo?.(statedFactKey(read, store)) ?? [])
      : [];
  };
  const textOf = (key: string): string => source.textOf(key);
  return {
    callback: textsOf(calledIn("/src/alerts.ts", "onDone"), textOf),
    helper: textsOf(calledIn("/src/alerts.test.ts", "run"), textOf),
  };
}

async function pythonReading(callers: Callers): Promise<Reading> {
  const root = onDisk(
    filesFor(
      PYTHON,
      {
        function: "alerts.py",
        production: "main.py",
        test: "test_alerts.py",
      },
      callers,
    ),
  );
  const db = new Database();
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const tree = await parsePython(fs.readFileSync(file, "utf8"));
    emitModuleImportFacts(db, file, bindModule(tree.rootNode), {
      roots: [root],
    });
    emitPythonFacts(db, file, tree.rootNode);
  }
  return readingOf(db, pythonFactSource(db));
}

async function rubyReading(callers: Callers): Promise<Reading> {
  const root = onDisk(
    filesFor(
      RUBY,
      {
        function: "lib/alerts.rb",
        production: "lib/main.rb",
        test: "spec/alerts_spec.rb",
      },
      callers,
    ),
  );
  const db = new Database();
  const constants: FileConstants[] = [];
  for (const name of ["lib/alerts.rb", "lib/main.rb", "spec/alerts_spec.rb"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) {
      continue;
    }
    const tree = await parseRuby(fs.readFileSync(file, "utf8"));
    emitRubyFacts(db, file, tree.rootNode);
    constants.push(collectFileConstants(file, tree.rootNode));
  }
  emitConstantBindings(db, constants);
  return readingOf(db, rubyFactSource(db));
}

/** What the value each named parameter's call runs comes to, read off the `call` facts. */
function readingOf(db: Database, source: FactSource): Reading {
  const calledThrough = (parameter: string): string[] => {
    const call = db
      .facts("call")
      .find((row) => String(row[1]).endsWith(`#${parameter}`));
    return call === undefined
      ? []
      : textsOf(source.comesTo?.(String(call[1])) ?? [], spannedText);
  };
  return { callback: calledThrough("on_done"), helper: calledThrough("run") };
}

const LANGUAGES: Record<string, (callers: Callers) => Promise<Reading>> = {
  typescript: typescriptReading,
  python: pythonReading,
  ruby: rubyReading,
};

/** The production caller's callback, as each language writes it. */
const DELIVERED: Record<string, string> = {
  typescript: "function deliver() {}",
  python: "def deliver(): pass",
  ruby: "-> { nil }",
};

/** The stub the test hands its own helper. */
const HELPER_STUB: Record<string, string> = {
  typescript: "() => {}",
  python: "lambda: None",
  ruby: "-> { 2 }",
};

describe.each(Object.keys(LANGUAGES))("a test's call in %s", (language) => {
  const read = LANGUAGES[language] as (callers: Callers) => Promise<Reading>;

  it("leaves the production caller's callback as the only one", async () => {
    const reading = await read("both");

    expect(reading.callback).toEqual([DELIVERED[language]]);
  });

  it("fills nothing when a test is the only caller, the same as no caller", async () => {
    expect((await read("test")).callback).toEqual([]);
    expect((await read("none")).callback).toEqual([]);
  });

  it("still fills the parameter of a helper the test writes", async () => {
    const reading = await read("test");

    expect(reading.helper).toEqual([HELPER_STUB[language]]);
  });

  it("fills the parameter from production code alone", async () => {
    const reading = await read("production");

    expect(reading.callback).toEqual([DELIVERED[language]]);
  });
});
