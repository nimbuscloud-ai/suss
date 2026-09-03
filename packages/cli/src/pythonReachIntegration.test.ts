/**
 * A Python route reaching the database two calls away, through the
 * pipeline a user runs: extract with a FastAPI-shaped pack that also
 * knows SQLAlchemy, write the summaries out, then ask what the route
 * reaches. The answer has to come from the summaries alone, so the
 * helpers the route calls need summaries of their own and each call
 * has to say which summary it lands on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import { answerQuestion } from "./ask.js";
import { functionOf, readCallFacts } from "./callFacts.js";
import { relativizeSummaryPaths } from "./extract.js";
import { touchesOfUnits } from "./target.js";

import type { PythonPack } from "@suss/adapter-python";
import type { BehavioralSummary } from "@suss/behavioral-ir";

const fastapiWithSqlalchemy: PythonPack = {
  name: "fastapi",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { get: "GET", post: "POST" },
      pathParamSyntax: "braces",
      defaultStatusCode: 200,
    },
  ],
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

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-reach-cli-"));
  write("app/store.py", [
    "from sqlalchemy import select",
    "",
    "def read_orders():",
    "    return select(Orders.id).all()",
  ]);
  write("app/service.py", [
    "from app.store import read_orders",
    "",
    "def orders_for(user):",
    "    return read_orders()",
  ]);
  write("app/main.py", [
    "from fastapi import FastAPI",
    "from app.service import orders_for",
    "",
    "app = FastAPI()",
    "",
    '@app.get("/orders")',
    "def list_orders():",
    "    return orders_for(1)",
  ]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

async function extracted(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(dir),
    packs: [fastapiWithSqlalchemy],
    roots: [dir],
    projectRoot: dir,
  });
  for (const summary of summaries) {
    relativizeSummaryPaths(summary, dir);
  }
  return summaries;
}

describe("what a Python route reaches", () => {
  it("finds the database two calls below the route through the call facts", async () => {
    const summaries = await extracted();
    const route = summaries.find((summary) => summary.kind === "handler");
    expect(route).toBeDefined();

    const facts = readCallFacts(summaries);
    const reached = facts.reachedFrom([functionOf(route as BehavioralSummary)]);
    const paths = [...reached.values()].map((hops) =>
      hops.map((hop) => hop.callee),
    );
    expect(paths).toContainEqual(["orders_for", "read_orders"]);

    const touched = [...reached.keys()].flatMap((fn) =>
      touchesOfUnits(facts.units.get(fn) ?? []),
    );
    const store = summaries.find(
      (summary) => summary.identity.name === "read_orders",
    );
    expect(store?.kind).toBe("library");
    expect(
      touched
        .filter((touch) => touch.summary === store)
        .map((touch) => touch.touched.label),
    ).toEqual(["function-call:reachable", "postgresql:sqlalchemy/select"]);
  });

  it("answers the question the way a user asks it", async () => {
    const summaries = await extracted();
    const out = path.join(dir, "summaries");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "code.json"), JSON.stringify(summaries));

    const { exitCode, answer } = answerQuestion({
      question: "what does GET /orders reach",
      dir: out,
      output: path.join(dir, "answer.txt"),
    });

    expect(exitCode).toBe(0);
    const text = fs.readFileSync(path.join(dir, "answer.txt"), "utf8");
    expect(answer?.headline).toContain("reaches 1 boundary");
    expect(text).toContain("reads postgresql:sqlalchemy/select");
  });
});
