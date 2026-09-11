import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { askResolution } from "@suss/resolution";

import { emitModuleImportFacts } from "../facts.js";
import { findPythonFiles } from "../index.js";
import { parsePython } from "../parser.js";
import { bindModule } from "../scope.js";
import { emitValueFacts } from "./values.js";

/** A project on disk, since which library a constructor comes from is what settles a match. */
async function factsFor(files: Record<string, string>): Promise<Database> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "associations-"));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  const db = new Database();
  for (const file of findPythonFiles(dir)) {
    const tree = await parsePython(fs.readFileSync(file, "utf8"));
    emitModuleImportFacts(db, file, bindModule(tree.rootNode), {
      roots: [dir],
    });
    emitValueFacts(db, file, tree.rootNode);
  }
  db.add("associationConstructor", ["sqlmodel", "Relationship"]);
  db.add("associationConstructor", ["sqlalchemy.orm", "relationship"]);
  return db;
}

/** The class a target reference binds to, by the name that class is declared under. */
function targetNames(db: Database): Record<string, string> {
  const declared = new Map<string, string>();
  for (const row of db.facts("binds")) {
    const name = String(row[0]);
    if (name.includes("#")) {
      declared.set(String(row[1]), name.slice(name.lastIndexOf("#") + 1));
    }
  }
  const bound = new Map(
    db.facts("binds").map((row) => [String(row[0]), String(row[1])]),
  );
  const found: Record<string, string> = {};
  for (const row of db.facts("fieldCall")) {
    const target = bound.get(String(row[3]));
    found[String(row[1])] =
      target === undefined ? "" : (declared.get(target) ?? "");
  }
  return found;
}

/** What a read of an expression settles on, which is what the shared rules decide. */
function objectsBehind(db: Database, key: string): string[] {
  askResolution(db, [key]);
  return db
    .facts("wantedObjectOf")
    .filter((row) => String(row[0]) === key)
    .map((row) => String(row[1]));
}

/** The `self.<name>` read one of the methods below writes. */
function readOf(db: Database, name: string): string {
  return String(
    db.facts("readsProperty").find((row) => String(row[2]) === name)?.[0],
  );
}

/** The class a name in the run is declared as. */
function classNamed(db: Database, name: string): string {
  return String(
    db.facts("binds").find((row) => String(row[0]).endsWith(`#${name}`))?.[1],
  );
}

const SQLMODEL_MODELS = [
  "from typing import List, Optional",
  "from sqlmodel import Relationship, SQLModel",
  "",
  "class Item(SQLModel, table=True):",
  "    pass",
  "",
  "class User(SQLModel, table=True):",
  '    quoted: list["Item"] = Relationship(back_populates="owner")',
  "    listed: List[Item] = Relationship()",
  "    optional: Optional[Item] = Relationship()",
  "    unioned: Item | None = Relationship()",
  "    mapped: Mapped[list[Item]] = Relationship()",
  "    bare: Item = Relationship()",
  "",
  "    def each(self):",
  "        return self.quoted",
  "",
].join("\n");

describe("the class a model's field is about", () => {
  it("is read out of every annotation an ORM relationship is written with", async () => {
    const db = await factsFor({ "models.py": SQLMODEL_MODELS });

    expect(targetNames(db)).toEqual({
      quoted: "Item",
      listed: "Item",
      optional: "Item",
      unioned: "Item",
      mapped: "Item",
      bare: "Item",
    });
  });

  it("is read out of the string SQLAlchemy's own constructor is given", async () => {
    const db = await factsFor({
      "models.py": [
        "from sqlalchemy.orm import relationship",
        "from base import Base",
        "",
        "class Participant(Base):",
        "    pass",
        "",
        "class Case(Base):",
        '    participants = relationship("Participant")',
        "    reporter = relationship(Participant)",
        "",
        "    def each(self):",
        "        return self.participants",
        "",
      ].join("\n"),
      "base.py": "class Base:\n    pass\n",
    });

    expect(targetNames(db)).toEqual({
      participants: "Participant",
      reporter: "Participant",
    });
  });

  it("is read from either side of a union with None", async () => {
    const db = await factsFor({
      "models.py": [
        "from sqlmodel import Relationship, SQLModel",
        "",
        "class Item(SQLModel, table=True):",
        "    pass",
        "",
        "class User(SQLModel, table=True):",
        "    leading: None | Item = Relationship()",
        "    trailing: Item | None = Relationship()",
        "",
      ].join("\n"),
    });

    expect(targetNames(db)).toEqual({ leading: "Item", trailing: "Item" });
  });

  it("is left unstated for a union of two classes, which names no one of them", async () => {
    const db = await factsFor({
      "models.py": [
        "from sqlmodel import Relationship, SQLModel",
        "",
        "class User(SQLModel, table=True):",
        "    either: Item | Draft = Relationship()",
        "",
      ].join("\n"),
    });

    expect(db.size("fieldCall")).toBe(0);
  });

  it("is left unstated for an annotation written with interpolation", async () => {
    const db = await factsFor({
      "models.py": [
        "from sqlmodel import Relationship, SQLModel",
        "",
        "class User(SQLModel, table=True):",
        '    items: list[f"{prefix}Item"] = Relationship()',
        "",
      ].join("\n"),
    });

    expect(db.size("fieldCall")).toBe(0);
  });

  it("is left unstated when the call is given only keywords and no annotation", async () => {
    const db = await factsFor({
      "models.py": [
        "from sqlalchemy.orm import relationship",
        "from base import Base",
        "",
        "class Case(Base):",
        '    participants = relationship(back_populates="case")',
        "",
      ].join("\n"),
      "base.py": "class Base:\n    pass\n",
    });

    expect(db.size("fieldCall")).toBe(0);
  });

  it("is left unstated when the call is given neither an annotation nor a class", async () => {
    const db = await factsFor({
      "models.py": [
        "from sqlalchemy import Column, Integer",
        "from base import Base",
        "",
        "class Case(Base):",
        "    id = Column(Integer, primary_key=True)",
        "    at = Column()",
        "",
      ].join("\n"),
      "base.py": "class Base:\n    pass\n",
    });

    expect(Object.keys(targetNames(db))).toEqual(["id"]);
  });
});

describe("a read of a relationship field", () => {
  it("settles on the class the relationship reaches", async () => {
    const db = await factsFor({ "models.py": SQLMODEL_MODELS });

    expect(objectsBehind(db, readOf(db, "quoted"))).toEqual([
      classNamed(db, "Item"),
    ]);
  });

  it("says nothing when the constructor is a project function of the same name", async () => {
    const db = await factsFor({
      "models.py": [
        "from sqlmodel import SQLModel",
        "from helpers import Relationship",
        "",
        "class Item(SQLModel, table=True):",
        "    pass",
        "",
        "class User(SQLModel, table=True):",
        "    items: list[Item] = Relationship()",
        "",
        "    def each(self):",
        "        return self.items",
        "",
      ].join("\n"),
      "helpers.py": "def Relationship():\n    return None\n",
    });

    expect(objectsBehind(db, readOf(db, "items"))).toEqual([]);
  });
});
