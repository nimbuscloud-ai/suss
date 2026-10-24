/**
 * `suss map` end to end, the way a user runs it: one project per
 * language, read from `suss.json` or from what `suss init` would pick,
 * and one folder holding summaries from two git repositories.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../run.js";

import type { PageData } from "./mapPageData.js";

const FIXTURES = path.resolve(__dirname, "../../../../fixtures");

let work: string;

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "suss-map-")));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

async function quietly(
  args: string[],
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runCli(args);
    return { exit, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readsIn(project: string, reads: unknown[]): void {
  write(
    path.join(project, "suss.json"),
    JSON.stringify({ version: 1, read: reads }),
  );
}

/** The page's inline data, as its script reads it. */
function dataOf(page: string): PageData {
  const html = fs.readFileSync(page, "utf8");
  const match =
    /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    );
  expect(match, "the page has its data inline").not.toBeNull();
  return JSON.parse((match as RegExpExecArray)[1] as string) as PageData;
}

function routesOf(data: PageData): string[] {
  return data.e.map((e) => `${data.s[e.m]} ${data.s[e.p]}`).sort();
}

/** The page asks the network for nothing: no script, stylesheet or font from a URL. */
function expectOffline(page: string): void {
  const html = fs.readFileSync(page, "utf8");
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toMatch(/<link[^>]+href=/);
  expect(html).not.toMatch(/@import|url\(\s*["']?https?:/);
}

describe("suss map", () => {
  it("maps a TypeScript project, pairs its own fetch call, and keeps the summaries for ask", async () => {
    const project = path.join(work, "shop");
    fs.cpSync(path.join(FIXTURES, "express"), project, { recursive: true });
    write(
      path.join(project, "client.ts"),
      [
        "export async function loadUser(id: string) {",
        "  const res = await fetch(`/users/${id}`);",
        "  return res.json();",
        "}",
        "",
      ].join("\n"),
    );
    readsIn(project, [
      { kind: "extract", language: "typescript", packs: ["express", "fetch"] },
    ]);

    const run = await quietly(["map", project]);

    expect(run.exit).toBe(0);
    const page = path.join(project, ".suss", "map.html");
    expect(run.stdout).toContain("suss map wrote");
    expect(run.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(5);
    expect(run.stdout.trim().split("\n").length).toBeLessThanOrEqual(7);
    expectOffline(page);
    const data = dataOf(page);
    expect(routesOf(data)).toContain("GET /users/:id");
    expect(data.chk.pairs).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(project, ".suss", "summaries"))).toContain(
      "0-extract.json",
    );
  });

  it("maps a Python project and exits 0 when nothing paired", async () => {
    const project = path.join(work, "api");
    write(path.join(project, "pyproject.toml"), "[project]\n");
    write(
      path.join(project, "app", "main.py"),
      'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/orders/{order_id}")\ndef get_order(order_id: str):\n    return {"id": order_id}\n',
    );
    readsIn(project, [
      { kind: "extract", language: "python", packs: ["fastapi"] },
    ]);
    const out = path.join(work, "pages", "api.html");

    const run = await quietly(["map", project, "-o", out]);

    expect(run.exit).toBe(0);
    expect(run.stdout).toContain("0 pairs");
    expect(routesOf(dataOf(out))).toEqual(["GET /orders/{order_id}"]);
    expectOffline(out);
  });

  it("maps a Rails app with GraphQL after init writes its setup, and writes under --cache-dir", async () => {
    const project = path.join(work, "orders");
    fs.cpSync(path.join(FIXTURES, "rails-graphql-app"), project, {
      recursive: true,
    });
    expect((await quietly(["init", project, "--write"])).exit).toBe(0);
    const cache = path.join(work, "cache");

    const run = await quietly(["map", project, "--cache-dir", cache]);

    expect(run.exit).toBe(0);
    expect(fs.existsSync(path.join(project, ".suss", "map.html"))).toBe(false);
    const [folder] = fs.readdirSync(path.join(cache, "map"));
    const data = dataOf(path.join(cache, "map", folder as string, "map.html"));
    expect(routesOf(data)).toEqual([
      "GET /orders",
      "GET /orders/:id",
      "Query order",
    ]);
    expect(data.t.map(([b]) => data.s[data.b[b]?.[2] as number])).toEqual([
      "Order",
    ]);
  });

  it("refuses a --links it does not know, and a second project", async () => {
    const links = await quietly(["map", work, "--links", "intellij"]);
    const two = await quietly(["map", work, work]);

    expect(links.exit).toBe(1);
    expect(links.stderr).toContain('--links takes "editor" or "github"');
    expect(two.exit).toBe(1);
    expect(two.stderr).toContain("map reads one project");
  });

  it("says no pack matched, and exits 1, for a folder with nothing to read", async () => {
    const project = path.join(work, "notes");
    write(path.join(project, "README.md"), "# notes\n");

    const run = await quietly(["map", project]);

    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("nothing to map");
  });

  it("keeps two repositories apart in one folder, and links each to its own commit", async () => {
    const combined = path.join(work, "combined");
    fs.mkdirSync(combined);
    const commits: string[] = [];
    for (const name of ["billing", "orders"]) {
      const repo = path.join(work, name);
      write(
        path.join(repo, "src", "index.ts"),
        `import { Router } from "express";\nconst router = Router();\nrouter.get("/health", (req, res) => {\n  res.status(200).json({ ok: true });\n});\nexport default router;\n`,
      );
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
      git(
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "start",
      );
      git("remote", "add", "origin", `https://github.com/acme/${name}.git`);
      commits.push(git("rev-parse", "HEAD"));
      const extracted = await quietly([
        "extract",
        "--dir",
        repo,
        "--lang",
        "typescript",
        "-f",
        "express",
        "-o",
        path.join(combined, `${name}.json`),
      ]);
      expect(extracted.exit).toBe(0);
    }
    const out = path.join(work, "both.html");

    const run = await quietly([
      "map",
      "--dir",
      combined,
      "-o",
      out,
      "--links",
      "github",
    ]);

    expect(run.exit).toBe(0);
    const data = dataOf(out);
    expect(data.roots.every((root) => root === null)).toBe(true);
    expect(fs.readFileSync(out, "utf8")).not.toContain(work);
    expect(routesOf(data)).toEqual(["GET /health", "GET /health"]);
    expect(
      data.repos.map(([name, github]) => [data.s[name], github]).sort(),
    ).toEqual([
      ["billing", `https://github.com/acme/billing/blob/${commits[0]}/`],
      ["orders", `https://github.com/acme/orders/blob/${commits[1]}/`],
    ]);
    const repoOfEntry = data.e.map((e) => data.u[e.u[0] as number]?.[7]);
    expect(new Set(repoOfEntry).size).toBe(2);
  });
});
