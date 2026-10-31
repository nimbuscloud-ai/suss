/**
 * A repository method every model shares, through the extract a user
 * runs and the question they ask. `Repository.get_one` reads
 * `select(self.model)`, and each route reaches the table of the
 * repository it called, made directly, by a factory, or by a subclass
 * that passes its own model up. A route whose repository came in as a
 * parameter, from callers that pass different ones, reaches no table by
 * name.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { answerQuestion } from "./ask.js";
import { extract } from "./extract.js";

const dir = path.resolve(
  __dirname,
  "../../../fixtures/per-construction-python",
);

let out: string;
let summaries: string;

beforeAll(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "suss-per-construction-"));
  summaries = path.join(out, "summaries");
  await extract({
    dir,
    lang: "python",
    frameworks: [
      "fastapi",
      `sqlalchemy=${path.join(dir, "suss.sqlalchemy.json")}`,
    ],
    output: path.join(summaries, "summaries.json"),
    noCache: true,
    quiet: true,
  });
});

afterAll(() => {
  fs.rmSync(out, { recursive: true, force: true });
});

/** The items `suss ask` lists for a question. */
function itemsFor<Item>(question: string): Item[] {
  const { answer } = answerQuestion({
    question,
    dir: summaries,
    json: true,
    output: path.join(out, "answer.json"),
  });
  return (answer?.items ?? []) as Item[];
}

/** The tables `what does <route> reach` lists. */
function tablesReachedFrom(route: string): string[] {
  return itemsFor<{ boundary?: string }>(`what does ${route} reach`)
    .flatMap((item) => item.boundary ?? [])
    .filter((boundary) => boundary.startsWith("postgresql:"))
    .sort();
}

describe("a shared repository method, read per construction", () => {
  it("reaches the table of a repository the route makes itself", () => {
    expect(tablesReachedFrom("GET /tools/{key}")).toEqual(["postgresql:Tool"]);
  });

  it("follows a call on the method's own receiver to the same repository", () => {
    expect(tablesReachedFrom("GET /tools-first")).toEqual(["postgresql:Tool"]);
  });

  it("reaches the table a factory property's repository gives", () => {
    expect(tablesReachedFrom("GET /factory-tools/{key}")).toEqual([
      "postgresql:Tool",
    ]);
  });

  it("reaches the model a subclass passes to its base constructor", () => {
    expect(tablesReachedFrom("GET /tags/{key}")).toEqual(["postgresql:Tag"]);
  });

  it("names no table for a repository each caller passes in", () => {
    expect(tablesReachedFrom("GET /only-tools/{key}")).toEqual([
      "postgresql:<unnamed container>",
    ]);
    expect(tablesReachedFrom("GET /either/{key}")).toEqual([
      "postgresql:<unnamed container>",
    ]);
  });

  it("lists only the copy for the construction that passes a table", () => {
    const units = itemsFor<{ unit?: string }>("what reads postgresql:Tag").map(
      (item) => item.unit,
    );

    expect(units).toEqual([
      "app/repos.py::Repository.get_one on app/repos.py:35:16",
    ]);
  });
});
