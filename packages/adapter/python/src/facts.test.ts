import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitEntryFact, emitModuleImportFacts, unitKey } from "./facts.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";

describe("unitKey", () => {
  it("joins the file path, the lines, and the name", () => {
    expect(
      unitKey("myapp/routes/todos.py", { start: 10, end: 42 }, "list_todos"),
    ).toBe("myapp/routes/todos.py:10-42#list_todos");
  });

  it("tells two units on one line apart", () => {
    // The range is lines, so two units that share a line share it.
    // Without the name in the key they are one key, and `entry` is a
    // set, so the second one disappears from it.
    const range = { start: 4, end: 4 };
    expect(unitKey("routes.py", range, "get")).not.toBe(
      unitKey("routes.py", range, "post"),
    );
  });
});

describe("emitEntryFact", () => {
  it("adds one entry tuple keyed by file, lines, and name", () => {
    const db = new Database();
    emitEntryFact(db, "myapp/routes/todos.py", { start: 1, end: 10 }, "todos");
    expect(db.facts("entry")).toEqual([["myapp/routes/todos.py:1-10#todos"]]);
  });

  it("keeps both units when two share a line", () => {
    const db = new Database();
    const range = { start: 4, end: 4 };
    emitEntryFact(db, "routes.py", range, "get");
    emitEntryFact(db, "routes.py", range, "post");
    expect(db.facts("entry")).toHaveLength(2);
  });
});

describe("emitModuleImportFacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-facts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, content = ""): string {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  it("records a resolved absolute import with its resolved file", async () => {
    write("root/myapp/wrappers/restx.py");
    const importingFile = write(
      "root/myapp/routes/todos.py",
      "from myapp.wrappers.restx import route\n",
    );
    const tree = await parsePython(fs.readFileSync(importingFile, "utf8"));
    const module = bindModule(tree.rootNode);

    const db = new Database();
    emitModuleImportFacts(db, importingFile, module, {
      roots: [path.join(tmpDir, "root")],
    });

    expect(db.facts("pyImport")).toEqual([
      [importingFile, "myapp.wrappers.restx", "resolved"],
    ]);
    expect(db.facts("pyImportResolved")).toEqual([
      [
        importingFile,
        "myapp.wrappers.restx",
        path.join(tmpDir, "root/myapp/wrappers/restx.py"),
      ],
    ]);
  });

  it("records an external import with no resolved-file fact", async () => {
    const importingFile = write(
      "root/myapp/routes/todos.py",
      "from flask_restx import Namespace\n",
    );
    const tree = await parsePython(fs.readFileSync(importingFile, "utf8"));
    const module = bindModule(tree.rootNode);

    const db = new Database();
    emitModuleImportFacts(db, importingFile, module, {
      roots: [path.join(tmpDir, "root")],
    });

    expect(db.facts("pyImport")).toEqual([
      [importingFile, "flask_restx", "external"],
    ]);
    expect(db.facts("pyImportResolved")).toEqual([]);
  });

  it("records an ambiguous import when more than one root names it", async () => {
    write("src/myapp/models.py");
    write("vendor/myapp/models.py");
    const importingFile = write(
      "app/main.py",
      "from myapp.models import Thing\n",
    );
    const tree = await parsePython(fs.readFileSync(importingFile, "utf8"));
    const module = bindModule(tree.rootNode);

    const db = new Database();
    emitModuleImportFacts(db, importingFile, module, {
      roots: [path.join(tmpDir, "src"), path.join(tmpDir, "vendor")],
    });

    expect(db.facts("pyImport")).toEqual([
      [importingFile, "myapp.models", "ambiguous"],
    ]);
  });

  it("records a relative import with its dots preserved in the fact", async () => {
    write("myapp/routes/wrapper.py");
    const importingFile = write(
      "myapp/routes/todos.py",
      "from .wrapper import route\n",
    );
    const tree = await parsePython(fs.readFileSync(importingFile, "utf8"));
    const module = bindModule(tree.rootNode);

    const db = new Database();
    emitModuleImportFacts(db, importingFile, module, { roots: [tmpDir] });

    expect(db.facts("pyImport")).toEqual([
      [importingFile, ".wrapper", "resolved"],
    ]);
  });

  it("records a relative import as outsideRoots when no configured root reaches it", async () => {
    write("myapp/routes/wrapper.py");
    const importingFile = write(
      "myapp/routes/todos.py",
      "from .wrapper import route\n",
    );
    const tree = await parsePython(fs.readFileSync(importingFile, "utf8"));
    const module = bindModule(tree.rootNode);

    const db = new Database();
    // No configured root covers the importing file at all, so even a
    // one-dot relative import (which never walks past its own
    // directory) has nothing to be judged inside of.
    emitModuleImportFacts(db, importingFile, module, {
      roots: [path.join(tmpDir, "unrelated")],
    });

    expect(db.facts("pyImport")).toEqual([
      [importingFile, ".wrapper", "outsideRoots"],
    ]);
    expect(db.facts("pyImportResolved")).toEqual([]);
  });

  it("records an open import from a wildcard from-import", async () => {
    const importingFile = write("app/main.py", "from myapp.legacy import *\n");
    const tree = await parsePython(fs.readFileSync(importingFile, "utf8"));
    const module = bindModule(tree.rootNode);

    const db = new Database();
    emitModuleImportFacts(db, importingFile, module, { roots: [] });

    expect(db.facts("pyOpenImport")).toEqual([[importingFile, "myapp.legacy"]]);
  });
});
