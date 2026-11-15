/**
 * A file in a `test`, `tests` or `spec` folder at the top of a project is
 * test code whatever its name, and a deeper folder with that name is not.
 * The same project is written in TypeScript, Python and Ruby, and each
 * adapter reads it from disk the way an extract does. A production
 * function takes a callback. A caller in `app/api/test/` passes the
 * production one, and a helper in the top test folder passes a stub. The
 * project is at the run's root, or in a package under it with its own
 * manifest, and in both the helper's stub never fills the parameter.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node, SyntaxKind } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";

import {
  extractPythonProject,
  findPythonFiles,
  pythonFactSource,
} from "@suss/adapter-python";
import {
  extractRubyProject,
  findRubyFiles,
  rubyFactSource,
} from "@suss/adapter-ruby";
import {
  createTypeScriptAdapter,
  factSourceFor,
  ResolutionStore,
  statedFactKey,
} from "@suss/adapter-typescript";
import { spanOfKey } from "@suss/resolution";

import type { PythonPack } from "@suss/adapter-python";
import type { Database } from "@suss/datalog";
import type { FactSource } from "@suss/extractor";

/** Where the project is: at the run's root, or in a package under it. */
type Layout = "root" | "package";

/** A project's files by their path in the project, and the manifest a package under the run's root has. */
interface LanguageProject {
  files: Record<string, string>;
  manifest: string;
  /** The production function's file, and the parameter its call runs. */
  calling: { file: string; parameter: string };
}

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PACKAGE = "packages/alerts";

function projectDir(layout: Layout): string {
  return layout === "root" ? "" : PACKAGE;
}

/** The run's root on disk, with the project's files where the layout puts them. */
function onDisk(project: LanguageProject, layout: Layout): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-folders-")),
  );
  roots.push(root);
  const files: Record<string, string> = {
    ...(layout === "package" ? { [project.manifest]: "" } : {}),
    ...project.files,
  };
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(root, projectDir(layout), name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  return root;
}

/** The text of each value, sorted, so a reading compares across languages. */
function textsOf(
  keys: readonly string[],
  textOf: (key: string) => string,
): string[] {
  return keys.map((key) => textOf(key).replace(/\s+/g, " ")).sort();
}

function spannedText(key: string): string {
  const span = spanOfKey(key);
  return span === null
    ? key
    : fs.readFileSync(span.file, "utf8").slice(span.start, span.end);
}

const TYPESCRIPT: LanguageProject = {
  manifest: "package.json",
  calling: { file: "src/alerts.ts", parameter: "onDone" },
  files: {
    "src/alerts.ts": `
      export function notify(onDone: () => void) {
        onDone();
      }
    `,
    "app/api/test/route.ts": `
      import { notify } from "../../../src/alerts";

      function deliver() {}

      notify(deliver);
    `,
    "test/helpers.ts": `
      import { notify } from "../src/alerts";

      notify(() => {});
    `,
  },
};

const PYTHON: LanguageProject = {
  manifest: "pyproject.toml",
  calling: { file: "alerts.py", parameter: "on_done" },
  files: {
    "alerts.py": ["def notify(on_done):", "    on_done()", ""].join("\n"),
    "app/api/test/routes.py": [
      "from alerts import notify",
      "",
      "def deliver():",
      "    pass",
      "",
      "notify(deliver)",
      "",
    ].join("\n"),
    "tests/helpers.py": [
      "from alerts import notify",
      "",
      "notify(lambda: None)",
      "",
    ].join("\n"),
  },
};

const RUBY: LanguageProject = {
  manifest: "alerts.gemspec",
  calling: { file: "lib/alerts.rb", parameter: "on_done" },
  files: {
    "lib/alerts.rb": [
      "module Alerts",
      "  def self.notify(on_done)",
      "    on_done.call",
      "  end",
      "end",
      "",
    ].join("\n"),
    "app/api/test/routes.rb": [
      "DELIVER = -> { nil }",
      "",
      "Alerts.notify(DELIVER)",
      "",
    ].join("\n"),
    "spec/support/alerts_helper.rb": ["Alerts.notify(-> { 1 })", ""].join("\n"),
  },
};

// Python reads value facts only for a run whose packs discover something.
const DISCOVERING: PythonPack = {
  name: "fastapi",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET" },
      pathParamSyntax: "braces",
      defaultStatusCode: 200,
    },
  ],
};

async function typescriptReading(layout: Layout): Promise<string[]> {
  const root = onDisk(TYPESCRIPT, layout);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["**/*.ts"] }),
  );
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    projectRoot: root,
    frameworks: [],
    cacheDir: null,
  });
  const project = adapter.tsProject;
  for (const name of Object.keys(TYPESCRIPT.files)) {
    project.addSourceFileAtPath(path.join(root, projectDir(layout), name));
  }
  const store = new ResolutionStore();
  const source = factSourceFor(store);
  const call = project
    .getSourceFileOrThrow(
      path.join(root, projectDir(layout), TYPESCRIPT.calling.file),
    )
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find(
      (one) => one.getExpression().getText() === TYPESCRIPT.calling.parameter,
    );
  const read = call?.getExpression();
  if (read === undefined || !Node.isIdentifier(read)) {
    return [];
  }
  return textsOf(source.comesTo?.(statedFactKey(read, store)) ?? [], (key) =>
    source.textOf(key),
  );
}

async function pythonReading(layout: Layout): Promise<string[]> {
  const root = onDisk(PYTHON, layout);
  const { facts } = await extractPythonProject({
    files: findPythonFiles(root),
    packs: [DISCOVERING],
    roots: [path.join(root, projectDir(layout))],
    projectRoot: root,
    cacheDir: null,
  });
  return readingOf(facts, pythonFactSource(facts), PYTHON);
}

async function rubyReading(layout: Layout): Promise<string[]> {
  const root = onDisk(RUBY, layout);
  const { facts } = await extractRubyProject({
    files: findRubyFiles(root),
    packs: [],
    projectRoot: root,
    cacheDir: null,
  });
  return readingOf(facts, rubyFactSource(facts), RUBY);
}

/** What the value the production function's call runs comes to, read off the `call` facts. */
function readingOf(
  db: Database,
  source: FactSource,
  project: LanguageProject,
): string[] {
  const call = db
    .facts("call")
    .find((row) => String(row[1]).endsWith(`#${project.calling.parameter}`));
  return call === undefined
    ? []
    : textsOf(source.comesTo?.(String(call[1])) ?? [], spannedText);
}

const LANGUAGES: Record<string, (layout: Layout) => Promise<string[]>> = {
  typescript: typescriptReading,
  python: pythonReading,
  ruby: rubyReading,
};

/** The callback the caller under `app/api/test/` passes, as each language writes it. */
const DELIVERED: Record<string, string> = {
  typescript: "function deliver() {}",
  python: "def deliver(): pass",
  ruby: "-> { nil }",
};

describe.each(Object.keys(LANGUAGES))("a top test folder in %s", (language) => {
  const read = LANGUAGES[language] as (layout: Layout) => Promise<string[]>;

  it.each<Layout>(["root", "package"])(
    "keeps the helper's stub out of the callback, with the project at its %s",
    async (layout) => {
      expect(await read(layout)).toEqual([DELIVERED[language]]);
    },
  );
});
