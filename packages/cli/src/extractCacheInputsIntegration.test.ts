// A warm extract after a change to a file a pack reads outside the walked
// sources re-reads the project instead of serving the old summaries. It
// runs the built binary, which keeps its cache on disk as a user's does.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = path.resolve(__dirname, "../dist/bin.js");
const FIXTURES = path.resolve(__dirname, "../../../fixtures");

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-cache-inputs-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

interface Run {
  written: string;
  cacheLine: string;
}

function extract(project: string, args: string[], name: string): Run {
  const out = path.join(work, `${name}.json`);
  const result = spawnSync(
    process.execPath,
    [BIN, "extract", ...args, "--timing", "--allow-empty", "-o", out],
    { cwd: project, encoding: "utf8", timeout: 120_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return {
    written: fs.readFileSync(out, "utf8"),
    cacheLine:
      result.stderr.split("\n").find((line) => line.includes("cache:")) ?? "",
  };
}

/** Extracts, applies `change`, then extracts with the cache and without it. */
function afterChange(
  project: string,
  args: string[],
  change: () => void,
): { before: Run; warm: Run; fresh: Run } {
  const before = extract(project, args, "before");
  change();
  const warm = extract(project, args, "warm");
  const fresh = extract(project, [...args, "--no-cache"], "fresh");
  return { before, warm, fresh };
}

function copyFixture(name: string): string {
  const project = path.join(work, name);
  fs.cpSync(path.join(FIXTURES, name), project, { recursive: true });
  return project;
}

describe("a warm extract after a pack's outside input changed", () => {
  it("re-reads TypeScript after `prisma generate` writes the client", () => {
    // The client is not checked in. Prisma writes it beside the fixture's
    // schema, and only inside the repo can it find its own package.
    const generate = spawnSync(
      "npx",
      [
        "prisma",
        "generate",
        `--schema=${path.join(FIXTURES, "prisma-generated-client/schema.prisma")}`,
        "--no-hints",
      ],
      { cwd: path.dirname(FIXTURES), encoding: "utf8" },
    );
    expect(generate.status, generate.stderr).toBe(0);
    const project = copyFixture("prisma-generated-client");
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "users-api" }),
    );
    const generated = path.join(project, "generated");
    const aside = path.join(work, "generated-aside");
    fs.renameSync(generated, aside);

    const { before, warm, fresh } = afterChange(
      project,
      ["-p", "tsconfig.json", "-f", "hono", "-f", "prisma"],
      () => fs.renameSync(aside, generated),
    );

    // Unchanged output would mean the client was not an input at all.
    expect(fresh.written).not.toBe(before.written);
    expect(warm.cacheLine).toContain("cache: miss");
    expect(warm.written).toBe(fresh.written);
  });

  it("re-reads TypeScript after an install changes a library a pack reads", () => {
    const project = path.join(work, "api");
    write(project, "package.json", JSON.stringify({ name: "api" }));
    write(
      project,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    );
    write(
      project,
      "src/app.ts",
      'import { Hono } from "hono";\nconst app = new Hono();\napp.get("/health", (c) => c.json({ ok: true }));\nexport default app;\n',
    );
    const manifest = path.join(project, "node_modules/hono/package.json");
    write(
      project,
      "node_modules/hono/package.json",
      JSON.stringify({ name: "hono", version: "4.0.0" }),
    );

    const { warm, fresh } = afterChange(
      project,
      ["-p", "tsconfig.json", "-f", "hono"],
      () =>
        fs.writeFileSync(
          manifest,
          JSON.stringify({ name: "hono", version: "4.1.0" }),
        ),
    );

    expect(warm.cacheLine).toContain("cache: miss");
    expect(warm.written).toBe(fresh.written);
  });

  it.each([
    [
      "python",
      "app.py",
      "def handler(event, context):\n    return {'statusCode': 200}\n",
      "python3.12",
      "app.handler",
      "aws-lambda-python",
    ],
    [
      "ruby",
      "app.rb",
      "def handler(event:, context:)\n  { statusCode: 200 }\nend\n",
      "ruby3.3",
      "app.handler",
      "aws-lambda-ruby",
    ],
  ])(
    "re-reads %s after the SAM template its pack reads changes",
    (language, file, source, runtime, handler, pack) => {
      const project = path.join(work, language);
      write(project, file, source);
      const template = (functionName: string): string =>
        [
          'AWSTemplateFormatVersion: "2010-09-09"',
          "Transform: AWS::Serverless-2016-10-31",
          "Resources:",
          "  Api:",
          "    Type: AWS::Serverless::HttpApi",
          `  ${functionName}:`,
          "    Type: AWS::Serverless::Function",
          "    Properties:",
          `      Runtime: ${runtime}`,
          `      Handler: ${handler}`,
          "      CodeUri: .",
          "      Events:",
          "        Health:",
          "          Type: HttpApi",
          "          Properties:",
          "            Method: GET",
          "            Path: /health",
          "",
        ].join("\n");
      write(project, "template.yaml", template("HealthFunction"));

      const { before, warm, fresh } = afterChange(
        project,
        ["--lang", language, "-f", pack],
        () => write(project, "template.yaml", template("StatusFunction")),
      );

      expect(before.written).toContain('"instanceName":"HealthFunction"');
      expect(fresh.written).toContain('"instanceName":"StatusFunction"');
      expect(warm.cacheLine).toContain("cache: miss");
      expect(warm.written).toBe(fresh.written);
    },
  );
});

function write(project: string, relative: string, text: string): void {
  const file = path.join(project, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
