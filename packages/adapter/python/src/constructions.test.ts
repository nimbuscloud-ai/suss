/**
 * A repository method every model shares, `select(self.model)`, read by
 * this adapter alone. The read lists the table each construction gives,
 * and the calls into it say which constructions their receiver was made
 * at. The first project is the one the CLI's integration test also
 * reads. The second covers the ways a constructor can store the model.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fastapiTestPack } from "./__fixtures__/fastapiPattern.js";
import { extractPythonProject, findPythonFiles } from "./project.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";

const fixture = path.resolve(
  __dirname,
  "../../../../fixtures/per-construction-python",
);

const sqlalchemyLike: PythonPack = {
  name: "sqlalchemy",
  protocol: "http",
  discovery: [],
  storage: [
    {
      module: "sqlalchemy",
      queryTypes: ["Select"],
      writes: ["update", "delete"],
      queryFunctions: ["select"],
      storageSystem: "postgresql",
    },
  ],
};

async function extract(root: string): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(root),
    packs: [fastapiTestPack(), sqlalchemyLike],
    roots: [root],
    workspaceRoot: root,
  });
  return summaries;
}

function unit(
  summaries: BehavioralSummary[],
  name: string,
): BehavioralSummary | undefined {
  return summaries.find((summary) => summary.identity.name === name);
}

function effectsOf(summary: BehavioralSummary | undefined): Effect[] {
  return (summary?.transitions ?? []).flatMap((t) => t.effects);
}

/** The call written as `callee` in a unit. */
function callIn(
  summary: BehavioralSummary | undefined,
  callee: string,
): Extract<Effect, { type: "invocation" }> | undefined {
  return effectsOf(summary).find(
    (effect): effect is Extract<Effect, { type: "invocation" }> =>
      effect.type === "invocation" && effect.callee === callee,
  );
}

/** A construction written `file:line:column`, with the file relative to the fixture. */
function relative(ref: string): string {
  return path.relative(fixture, ref);
}

/** The read in `get_one`, and its table for each construction, with the files relative to `root`. */
function readIn(
  summaries: BehavioralSummary[],
  root: string,
): { semantics: unknown; byConstruction: Record<string, string> } {
  const read = effectsOf(unit(summaries, "get_one")).find(
    (effect) => effect.type === "interaction",
  );
  const byConstruction =
    read?.type === "interaction" ? read.containerByConstruction : undefined;
  return {
    semantics: read?.type === "interaction" ? read.binding.semantics : null,
    byConstruction: Object.fromEntries(
      Object.entries(byConstruction ?? {}).map(([ref, table]) => [
        path.relative(root, ref),
        table,
      ]),
    ),
  };
}

describe("a method every repository shares, read once per construction", () => {
  it("lists the table each construction passes, a subclass's own included", async () => {
    const { semantics, byConstruction } = readIn(
      await extract(fixture),
      fixture,
    );

    expect(semantics).toMatchObject({ name: "storage", container: null });
    expect(byConstruction).toEqual({
      "app/main.py:12:12": "Tool",
      "app/main.py:17:12": "Tool",
      "app/main.py:37:29": "Tool",
      "app/main.py:38:25": "Tag",
      "app/main.py:43:25": "Tool",
      "app/repos.py:31:16": "Tool",
      "app/repos.py:35:16": "Tag",
    });
  });

  it("records the construction a call's receiver was made at", async () => {
    const summaries = await extract(fixture);

    expect(
      callIn(
        unit(summaries, "get_tool"),
        "Repository(session, Tool).get_one",
      )?.receiverConstructions?.map(relative),
    ).toEqual(["app/main.py:12:12"]);
    expect(
      callIn(
        unit(summaries, "get_tag"),
        "AllRepositories(session).tags.get_one",
      )?.receiverConstructions?.map(relative),
    ).toEqual(["app/repos.py:35:16"]);
  });

  it("marks a call on the method's own receiver", async () => {
    const call = callIn(unit(await extract(fixture), "first"), "self.get_one");

    expect(call?.onOwnReceiver).toBe(true);
    expect(call?.receiverConstructions).toBeUndefined();
  });

  it("records nothing for a receiver each caller passes in", async () => {
    const call = callIn(
      unit(await extract(fixture), "read_through"),
      "repo.get_one",
    );

    expect(call).toBeDefined();
    expect(call?.receiverConstructions).toBeUndefined();
  });
});

describe("where a construction's model comes from", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-models-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, lines: string[]): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${lines.join("\n")}\n`);
  }

  it("follows the constructor a subclass inherits or hands its parameter to, and a keyword", async () => {
    write("app/__init__.py", []);
    write("app/models.py", [
      "from sqlalchemy.orm import DeclarativeBase",
      "",
      "class Base(DeclarativeBase):",
      "    pass",
      "",
      "class Tool(Base):",
      '    __tablename__ = "tools"',
      "",
      "class Tag(Base):",
      '    __tablename__ = "tags"',
    ]);
    write("app/repos.py", [
      "from sqlalchemy import select",
      "",
      "from app.models import Tag",
      "",
      "class Repository:",
      "    def __init__(self, session, sql_model):",
      "        self.session = session",
      "        self.model = sql_model",
      "",
      "    def get_one(self, key):",
      "        return self.session.execute(select(self.model)).scalar_one()",
      "",
      "class Plain(Repository):",
      "    pass",
      "",
      "class PassesOn(Repository):",
      "    def __init__(self, session, model):",
      "        super().__init__(session, model)",
      "",
      "class NoSuper(Repository):",
      "    def __init__(self, session):",
      "        self.session = session",
      "",
      "class TagRepository(Repository):",
      "    def __init__(self, session):",
      "        def reset():",
      "            self.model = session",
      "        super().__init__(session, Tag)",
      "",
      "class SpecialTags(TagRepository):",
      "    def __init__(self, session):",
      "        super().__init__(session)",
    ]);
    write("app/main.py", [
      "from fastapi import FastAPI",
      "",
      "from app.models import Tag, Tool",
      "from app.repos import NoSuper, PassesOn, Plain, Repository, SpecialTags",
      "",
      "app = FastAPI()",
      "session = None",
      "args = (session, Tool)",
      "",
      '@app.get("/plain")',
      "def plain():",
      "    return Plain(session, Tool).get_one(1)",
      "",
      '@app.get("/keyword")',
      "def keyword():",
      "    return Repository(session, sql_model=Tag).get_one(1)",
      "",
      '@app.get("/passes-on")',
      "def passes_on():",
      "    return PassesOn(session, Tool).get_one(1)",
      "",
      '@app.get("/no-super")',
      "def no_super():",
      "    return NoSuper(session).get_one(1)",
      "",
      '@app.get("/splat")',
      "def splat():",
      "    return Repository(*args).get_one(1)",
      "",
      '@app.get("/special")',
      "def special():",
      "    return SpecialTags(session).get_one(1)",
    ]);

    const { byConstruction } = readIn(await extract(tmpDir), tmpDir);

    expect(byConstruction).toEqual({
      "app/main.py:12:12": "Tool",
      "app/main.py:16:12": "Tag",
      "app/main.py:20:12": "Tool",
      "app/main.py:32:12": "Tag",
    });
  });

  it("follows a model its package brings in with a wildcard import", async () => {
    write("app/__init__.py", []);
    write("app/models/__init__.py", ["from .tool import *"]);
    write("app/models/tool.py", [
      "from sqlalchemy.orm import DeclarativeBase",
      "",
      "class Base(DeclarativeBase):",
      "    pass",
      "",
      "class Tool(Base):",
      '    __tablename__ = "tools"',
    ]);
    write("app/repos.py", [
      "from sqlalchemy import select",
      "",
      "class Repository:",
      "    def __init__(self, session, sql_model):",
      "        self.session = session",
      "        self.model = sql_model",
      "",
      "    def get_one(self, key):",
      "        return self.session.execute(select(self.model)).scalar_one()",
    ]);
    write("app/main.py", [
      "from fastapi import FastAPI",
      "",
      "from app.models import Tool",
      "from app.repos import Repository",
      "",
      "app = FastAPI()",
      "session = None",
      "",
      '@app.get("/tools")',
      "def tools():",
      "    return Repository(session, Tool).get_one(1)",
    ]);

    const { byConstruction } = readIn(await extract(tmpDir), tmpDir);

    expect(byConstruction).toEqual({ "app/main.py:11:12": "Tool" });
  });
});
