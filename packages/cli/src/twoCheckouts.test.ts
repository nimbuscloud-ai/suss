// One npm workspace checked out at two absolute paths, read from its own
// root in one and from outside in the other, by every reader that once
// wrote a path from the machine it ran on. Both have to write the same bytes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

const REPO = path.resolve(__dirname, "../../..");

interface Read {
  name: string;
  /** Paths in it are relative to the checkout, and `abs` turns one absolute. */
  args: (abs: (relative: string) => string) => string[];
}

const READS: Read[] = [
  {
    name: "a package that mounts a sibling package's routes",
    args: (abs) => [
      "extract",
      "--no-cache",
      "-f",
      "express",
      "-p",
      abs("packages/api/tsconfig.json"),
    ],
  },
  {
    name: "an Apollo server's schema document",
    args: (abs) => [
      "extract",
      "--no-cache",
      "-f",
      "apollo",
      "--dir",
      abs("apollo"),
    ],
  },
  {
    name: "a client generated around a wrapper",
    args: (abs) => [
      "extract",
      "--no-cache",
      "-f",
      "axios",
      "--dir",
      abs("axios"),
    ],
  },
  {
    name: "a Rails app whose pack config gives absolute paths",
    args: (abs) => [
      "extract",
      "--no-cache",
      "--lang",
      "ruby",
      "-f",
      `rails=${abs("rails/suss.rails.json")}`,
      "--dir",
      abs("rails"),
    ],
  },
  {
    name: "a FastAPI app",
    args: (abs) => [
      "extract",
      "--no-cache",
      "--lang",
      "python",
      "-f",
      "fastapi",
      "--dir",
      abs("py"),
    ],
  },
  ...(
    [
      ["graphql", "schema/schema.graphql"],
      ["graphql-documents", "graphql-documents"],
      ["prisma", "prisma/schema.prisma"],
      ["appsync", "appsync/template.yaml"],
      ["cloudformation", "sam/template.yaml"],
      ["serverless", "serverless/serverless.yml"],
      ["terraform", "terraform"],
      ["wrangler", "worker/wrangler.toml"],
      ["storybook", "stories"],
      ["openapi", "openapi/openapi.json"],
    ] as const
  ).map(
    ([from, spec]): Read => ({
      name: `what the ${from} reader reads`,
      args: (abs) => ["contract", "--from", from, abs(spec)],
    }),
  ),
];

interface Checkout {
  cwd: string;
  abs: (relative: string) => string;
}

let base: string;
let checkouts: Checkout[];
let startedIn: string;

function write(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function copyFixture(root: string, fixture: string, to: string): void {
  fs.cpSync(path.join(REPO, "fixtures", fixture), path.join(root, to), {
    recursive: true,
  });
}

function copyFile(root: string, from: string, to: string): void {
  write(root, to, fs.readFileSync(path.join(REPO, from), "utf8"));
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
  },
  include: ["src"],
});

function writeWorkspace(root: string): void {
  write(
    root,
    "package.json",
    JSON.stringify({ name: "shop", private: true, workspaces: ["packages/*"] }),
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
      'import express from "express";',
      'import { orderRoutes } from "@shop/shared";',
      "",
      "const app = express();",
      "const router = express.Router();",
      "orderRoutes(router);",
      "app.use(router);",
      'app.get("/health", (_req, res) => {',
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
      "    res.json({ id: req.params.id });",
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

function makeCheckout(root: string): void {
  write(root, "suss.json", JSON.stringify({ version: 1, read: [] }));
  writeWorkspace(root);
  copyFixture(root, "apollo", "apollo");
  copyFixture(root, "axios", "axios");
  copyFixture(root, "ruby-rails", "rails");
  write(
    root,
    "rails/suss.rails.json",
    JSON.stringify({
      root: path.join(root, "rails", "app"),
      routesFile: path.join(root, "rails", "config", "routes.rb"),
    }),
  );
  copyFixture(root, "python-fastapi", "py");
  copyFile(
    root,
    "fixtures/supervisor-listings/schema.graphql",
    "schema/schema.graphql",
  );
  copyFixture(root, "graphql-documents", "graphql-documents");
  copyFixture(root, "prisma", "prisma");
  copyFixture(root, "appsync/serverless", "appsync");
  copyFixture(root, "aws-lambda", "sam");
  copyFixture(root, "serverless", "serverless");
  copyFixture(root, "terraform-stores", "terraform");
  copyFixture(root, "cloudflare-worker-stores", "worker");
  copyFixture(root, "storybook", "stories");
  copyFile(
    root,
    "examples/petstore-axios-openapi/openapi.json",
    "openapi/openapi.json",
  );
}

async function quietly(cwd: string, args: string[]): Promise<number> {
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    process.chdir(cwd);
    return await runCli(args);
  } finally {
    process.stderr.write = writeErr;
  }
}

async function readInto(
  checkout: Checkout,
  read: Read,
  out: string,
): Promise<string> {
  const exit = await quietly(checkout.cwd, [
    ...read.args(checkout.abs),
    "-o",
    out,
  ]);
  expect(exit).toBe(0);
  const written = fs.readFileSync(out, "utf8");
  fs.rmSync(out);
  return written;
}

beforeAll(() => {
  startedIn = process.cwd();
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-two-checkouts-")),
  );
  // Both checkouts find express's types the way a fixture in this
  // repository does, through a node_modules folder above them.
  fs.symlinkSync(
    path.join(REPO, "node_modules"),
    path.join(base, "node_modules"),
  );
  const one = path.join(base, "one", "shop");
  const two = path.join(base, "two", "deeper", "shop");
  makeCheckout(one);
  makeCheckout(two);
  checkouts = [
    { cwd: one, abs: (relative) => relative },
    { cwd: base, abs: (relative) => path.join(two, relative) },
  ];
});

afterAll(() => {
  process.chdir(startedIn);
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the same project read from two checkouts", () => {
  it.each(READS)("writes the same summaries for $name", async (read) => {
    const out = path.join(base, "summaries.json");
    const [one, two] = checkouts as [Checkout, Checkout];
    const first = await readInto(one, read, out);
    const second = await readInto(two, read, out);

    expect(JSON.parse(first)).not.toEqual([]);
    expect(second).toBe(first);
    expect(first).not.toContain(base);
  });

  it("gives code in a sibling package its package's name and its path inside it", async () => {
    const [one] = checkouts as [Checkout];
    const summaries = JSON.parse(
      await readInto(one, READS[0] as Read, path.join(base, "sibling.json")),
    ) as Array<{
      identity: { id: string };
      location: { file: string; workspace?: string };
      metadata?: { moduleImports?: string[] };
    }>;

    const route = summaries.find((one) =>
      one.identity.id.startsWith("@shop/shared::"),
    );
    expect(route?.location).toMatchObject({
      file: "src/index.ts",
      workspace: "@shop/shared",
    });
    expect(
      summaries.flatMap((summary) => summary.metadata?.moduleImports ?? []),
    ).toContain("@shop/shared::src/index.ts");
  });
});
