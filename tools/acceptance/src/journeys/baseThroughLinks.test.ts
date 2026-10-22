import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

/**
 * Edit one route in a workspace whose api package mounts a sibling
 * package's routes through the link npm puts in node_modules, beside a
 * GraphQL schema and a Prisma schema that suss.json reads as contracts.
 * Then ask what the change did, from a path that reaches the checkout
 * through a symlink, the way a macOS temp folder does.
 *
 * `check --base` reads the base in a temporary copy. Every summary whose
 * id spells a path from the machine reads as removed in one place and
 * added in another, so the answer is only right when the boundaries it
 * lists are the ones the edited file touches.
 */

const EDITED = "packages/api/src/health.ts";

function write(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=suss@example.com",
      "-c",
      "user.name=suss",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
}

function writeProject(root: string): void {
  write(
    root,
    "package.json",
    JSON.stringify({ name: "shop", private: true, workspaces: ["packages/*"] }),
  );
  write(root, ".gitignore", "node_modules\n.suss\n");
  write(
    root,
    "suss.json",
    JSON.stringify({
      version: 1,
      read: [
        {
          kind: "extract",
          language: "typescript",
          dir: "packages/api",
          project: "packages/api/tsconfig.json",
          packs: ["express"],
        },
        { kind: "contract", from: "graphql", file: "schema.graphql" },
        { kind: "contract", from: "prisma", file: "prisma/schema.prisma" },
      ],
    }),
  );
  write(
    root,
    "schema.graphql",
    fs.readFileSync(
      path.join(fixture("supervisor-listings"), "schema.graphql"),
      "utf8",
    ),
  );
  write(
    root,
    "prisma/schema.prisma",
    fs.readFileSync(path.join(fixture("prisma"), "schema.prisma"), "utf8"),
  );

  const tsconfig = JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  });
  write(
    root,
    "packages/api/package.json",
    JSON.stringify({ name: "@shop/api", private: true }),
  );
  write(root, "packages/api/tsconfig.json", tsconfig);
  write(
    root,
    "packages/api/src/server.ts",
    [
      'import { Router } from "express";',
      'import { ordersRouter } from "@shop/shared";',
      'import { healthRouter } from "./health";',
      "",
      "export const app = Router();",
      "app.use(ordersRouter);",
      "app.use(healthRouter);",
      "",
    ].join("\n"),
  );
  write(
    root,
    EDITED,
    [
      'import { Router } from "express";',
      "",
      "export const healthRouter = Router();",
      "",
      'healthRouter.get("/health", async (_req, res) => {',
      "  res.status(200).json({ ok: true });",
      "});",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/shared/package.json",
    JSON.stringify({
      name: "@shop/shared",
      private: true,
      main: "src/index.ts",
      types: "src/index.ts",
    }),
  );
  write(root, "packages/shared/tsconfig.json", tsconfig);
  write(
    root,
    "packages/shared/src/index.ts",
    [
      'import { Router } from "express";',
      "",
      "export const ordersRouter = Router();",
      "",
      'ordersRouter.get("/orders/:id", async (req, res) => {',
      "  if (!req.params.id) {",
      '    res.status(404).json({ error: "missing" });',
      "    return;",
      "  }",
      "  res.status(200).json({ id: req.params.id });",
      "});",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(root, "node_modules", "@shop"), { recursive: true });
  fs.symlinkSync(
    "../../packages/shared",
    path.join(root, "node_modules", "@shop", "shared"),
  );
}

interface ChangedBoundary {
  key: string;
  units: string[];
}

describe("check --base after one file changed, in a workspace read through links", () => {
  const dir = workspace("base-through-links");
  const real = path.join(dir, "real", "shop");
  const linked = path.join(dir, "linked");
  let report: { changedFiles: string[]; changedBoundaries: ChangedBoundary[] };

  beforeAll(() => {
    writeProject(real);
    fs.symlinkSync(real, linked);
    git(real, "init", "--quiet");
    git(real, "add", "-A");
    git(real, "commit", "--quiet", "-m", "base");
    write(
      real,
      EDITED,
      fs
        .readFileSync(path.join(real, EDITED), "utf8")
        .replace(
          "  res.status(200)",
          '  if (process.env.DRAINING === "1") {\n    res.status(503).json({ ok: false });\n    return;\n  }\n  res.status(200)',
        ),
    );

    const run = runSuss(["check", "--base", "HEAD", "--json"], {
      cwd: linked,
    });
    expect(run.stdout, run.stderr).toMatch(/^\{/);
    report = JSON.parse(run.stdout);
  });

  it("lists the edited file as the only change", () => {
    expect(report.changedFiles).toEqual([EDITED]);
  });

  it("reports the route the edit changed", () => {
    const units = report.changedBoundaries.flatMap((one) => one.units);
    expect(units.length).toBeGreaterThan(0);
  });

  it("reports nothing the edited file does not touch", () => {
    const units = report.changedBoundaries.flatMap((one) => one.units);
    expect(units.filter((unit) => !unit.startsWith("src/health.ts::"))).toEqual(
      [],
    );
  });
});
