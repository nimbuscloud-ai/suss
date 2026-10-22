import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

/**
 * Edit one route in a workspace whose api package mounts a sibling
 * package's routes through the link npm puts in node_modules, beside a
 * GraphQL schema and a Prisma schema that suss.json reads as contracts.
 * Write the summaries with the commands a person runs from the project
 * root, then ask what the change did against the commit before it.
 *
 * `check --base` reads the base in a temporary copy through suss.json.
 * A summary whose id spells a path from the machine, or a path the
 * command was given, reads as removed in one place and added in another,
 * so the answer is right only when it lists what the edited file touches.
 */

const EDITED = "packages/api/src/health.ts";

const COMMANDS = [
  [
    "extract",
    "--no-cache",
    "--dir",
    "packages/api",
    "-p",
    "packages/api/tsconfig.json",
    "-f",
    "express",
    "-o",
    ".suss/api.json",
  ],
  [
    "contract",
    "--from",
    "graphql",
    "schema.graphql",
    "-o",
    ".suss/schema.json",
  ],
  [
    "contract",
    "--from",
    "prisma",
    "prisma/schema.prisma",
    "-o",
    ".suss/prisma.json",
  ],
];

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

const TSCONFIG = JSON.stringify({
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

  write(
    root,
    "packages/api/package.json",
    JSON.stringify({ name: "@shop/api", private: true }),
  );
  write(root, "packages/api/tsconfig.json", TSCONFIG);
  write(
    root,
    "packages/api/src/server.ts",
    [
      'import { Router } from "express";',
      'import { orderRoutes } from "@shop/shared";',
      'import { healthRouter } from "./health";',
      "",
      "export const app = Router();",
      "orderRoutes(app);",
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
  write(root, "packages/shared/tsconfig.json", TSCONFIG);
  write(
    root,
    "packages/shared/src/index.ts",
    [
      'import type { Router } from "express";',
      "",
      "export function orderRoutes(router: Router) {",
      '  router.get("/orders/:id", async (req, res) => {',
      "    if (!req.params.id) {",
      '      res.status(404).json({ error: "missing" });',
      "      return;",
      "    }",
      "    res.status(200).json({ id: req.params.id });",
      "  });",
      "}",
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

describe("check --base after one file changed, in a workspace with a linked sibling package", () => {
  const project = path.join(workspace("base-through-links"), "shop");
  let report: { changedFiles: string[]; changedBoundaries: ChangedBoundary[] };

  beforeAll(() => {
    writeProject(project);
    git(project, "init", "--quiet");
    git(project, "add", "-A");
    git(project, "commit", "--quiet", "-m", "base");
    write(
      project,
      EDITED,
      fs
        .readFileSync(path.join(project, EDITED), "utf8")
        .replace(
          "  res.status(200)",
          '  if (process.env.DRAINING === "1") {\n    res.status(503).json({ ok: false });\n    return;\n  }\n  res.status(200)',
        ),
    );

    for (const command of COMMANDS) {
      const run = runSuss(command, { cwd: project });
      expect(run.status, run.stderr).toBe(0);
    }
    const check = runSuss(
      ["check", "--dir", ".suss", "--base", "HEAD", "--json"],
      { cwd: project },
    );
    expect(check.stdout, check.stderr).toMatch(/^\{/);
    report = JSON.parse(check.stdout);
  });

  it("lists the edited file as the only change", () => {
    expect(report.changedFiles).toEqual([EDITED]);
  });

  it("reports the route the edit changed", () => {
    expect(report.changedBoundaries.map((one) => one.key)).toContain(
      "GET /health",
    );
  });

  it("reports nothing the edited file does not touch", () => {
    const units = report.changedBoundaries.flatMap((one) => one.units);
    expect(units.filter((unit) => !unit.startsWith("src/health.ts::"))).toEqual(
      [],
    );
  });
});
