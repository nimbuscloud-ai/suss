import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Project } from "./project.js";
import {
  askTool,
  attempt,
  checkTool,
  inspectTool,
  statusTool,
} from "./tools.js";

/** The text a tool wrote, out of the several shapes a result allows. */
function textOf(result: { content: Array<{ type: string }> }): string {
  return result.content
    .map((part) => ("text" in part ? String(part.text) : ""))
    .join("");
}

/** A project with more boundaries than one answer shows. */
function manyRoutes(root: string, count: number): void {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src"],
    }),
  );
  fs.writeFileSync(
    path.join(root, "src/app.ts"),
    [
      'import express from "express";',
      "const app = express();",
      ...Array.from({ length: count }, (_unused, index) =>
        [
          `app.get("/thing${index}", (req, res) => {`,
          `  res.status(200).json({ index: ${index} });`,
          "});",
        ].join("\n"),
      ),
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "suss.json"),
    JSON.stringify({
      version: 1,
      read: [
        {
          kind: "extract",
          language: "typescript",
          project: "tsconfig.json",
          packs: ["express"],
        },
      ],
    }),
  );
}

async function projectWith(count: number): Promise<Project> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-tools-"));
  manyRoutes(root, count);
  const project = new Project({ root, watch: false });
  await project.start();
  return project;
}

describe("the tools, on a project bigger than one answer", () => {
  it("cuts the boundary listing and says how to ask about one thing", async () => {
    const project = await projectWith(150);
    const result = await inspectTool(project);
    const text = textOf(result);

    expect(text).toContain("more lines are not shown");
    expect(text).toContain("what does <file> reach");

    project.close();
  }, 60_000);

  it("says nothing was omitted when everything fits", async () => {
    const project = await projectWith(2);
    const result = await inspectTool(project);

    expect(textOf(result)).not.toContain("not shown");

    project.close();
  }, 60_000);

  it("counts findings by kind alongside the ones it shows", async () => {
    const project = await projectWith(2);
    const result = await checkTool(project, {});
    const payload = result.structuredContent as {
      findingCounts: Record<string, number>;
      total: number;
    };

    expect(payload.findingCounts).toBeDefined();
    expect(typeof payload.total).toBe("number");

    project.close();
  }, 60_000);

  it("reports on one boundary when given one", async () => {
    const project = await projectWith(2);
    const result = await checkTool(project, { boundary: "GET /thing0" });
    const payload = result.structuredContent as { matched: boolean };

    expect(payload.matched).toBe(true);

    project.close();
  }, 60_000);

  it("answers about a boundary the project has", async () => {
    const project = await projectWith(2);
    const result = await askTool(project, {
      question: "what can I project from GET /thing0",
    });
    const answer = result.structuredContent as { found: boolean };

    expect(answer.found).toBe(true);

    project.close();
  }, 60_000);

  it("says a project with nothing set up will answer nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-tools-bare-"));
    const project = new Project({ root, watch: false });
    await project.start();

    const text = textOf(statusTool(project));
    expect(text).toContain("no suss.json");
    expect(text).toContain("suss init");

    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("attempt", () => {
  it("hands back what a tool returned", async () => {
    const result = await attempt("suss_ask", () => ({
      content: [{ type: "text" as const, text: "fine" }],
    }));

    expect(result.isError).toBeUndefined();
  });

  it("says what to do next when something throws a value that is not an error", async () => {
    const result = await attempt("suss_check", () => {
      throw "the directory went away";
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("the directory went away");
  });
});
