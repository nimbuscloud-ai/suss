/**
 * A route renamed on the server, with its client left calling the old
 * path, in a Next.js app, an Express app, and a Rails app a Worker calls
 * through a base URL its deployment sets. Each reports the one call
 * once. The Next.js app reports nothing once a rewrite covers the path,
 * a catch-all route could serve it, the client builds a segment from a
 * value and text, or its base URL is one nothing in the run sets.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { Finding } from "@suss/behavioral-ir";

const repoRoot = path.resolve(__dirname, "../../..");

let root: string;

async function run(argv: string[]): Promise<number> {
  const swallow = (() => true) as typeof process.stdout.write;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = swallow;
  process.stderr.write = swallow;
  try {
    return await runCli(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** A fresh copy of a fixture, which a test may edit. */
function copyOf(fixture: string, label: string): string {
  const at = path.join(root, label);
  fs.cpSync(path.join(repoRoot, "fixtures", fixture), at, { recursive: true });
  return at;
}

/** Runs each command into one summaries folder and returns the missing-route findings. */
async function missingRoutes(
  app: string,
  commands: Array<{ cwd?: string; argv: (out: string) => string[] }>,
): Promise<Finding[]> {
  const summaries = path.join(app, ".summaries");
  fs.mkdirSync(summaries, { recursive: true });
  const before = process.cwd();
  try {
    for (const [at, command] of commands.entries()) {
      process.chdir(command.cwd ?? app);
      expect(await run(command.argv(path.join(summaries, `${at}.json`)))).toBe(
        0,
      );
    }
  } finally {
    process.chdir(before);
  }
  const written = path.join(app, "check.json");
  await run([
    "check",
    "--dir",
    summaries,
    "--json",
    "--fail-on",
    "none",
    "--allow-empty",
    "-o",
    written,
  ]);
  const report = JSON.parse(fs.readFileSync(written, "utf-8")) as {
    findings: Finding[];
  };
  return report.findings.filter((f) => f.kind === "restMethodOnUnknownPath");
}

function typescript(...packs: string[]) {
  return (out: string) => [
    "extract",
    "-p",
    "tsconfig.json",
    ...packs.flatMap((pack) => ["-f", pack]),
    "--no-cache",
    "-o",
    out,
  ];
}

async function nextjsFindings(app: string): Promise<Finding[]> {
  return missingRoutes(app, [{ argv: typescript("nextjs", "fetch") }]);
}

function edit(file: string, from: string, to: string): void {
  const text = fs.readFileSync(file, "utf-8");
  expect(text).toContain(from);
  fs.writeFileSync(file, text.replace(from, to));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-missing-route-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const RENAMED =
  "loadSummary calls GET /api/orders/{id}/summary, and shop, the service it calls, does not serve that path. Every call gets a 404. Routes nearby: GET /api/orders/{id}/totals.";

describe("a Next.js app whose client calls a renamed route", () => {
  it("reports the call once, and none of the calls a page, a public file or a rewrite serves", async () => {
    const findings = await nextjsFindings(
      copyOf("missing-route-nextjs", "next"),
    );

    expect(findings.map((f) => f.description)).toEqual([RENAMED]);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.consumer.summary).toBe("lib/panel.ts::loadSummary");
  }, 120_000);

  it("reports nothing once a rewrite covers the path", async () => {
    const app = copyOf("missing-route-nextjs", "next-rewrite");
    edit(
      path.join(app, "next.config.ts"),
      'source: "/legacy/:path*",',
      'source: "/api/orders/:id/summary",',
    );

    expect(await nextjsFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing when a catch-all route could serve the path", async () => {
    const app = copyOf("missing-route-nextjs", "next-catch-all");
    const catchAll = path.join(app, "app", "[...rest]");
    fs.mkdirSync(catchAll, { recursive: true });
    fs.writeFileSync(
      path.join(catchAll, "route.ts"),
      "export async function POST() {\n  return Response.json({ moved: true }, { status: 410 });\n}\n",
    );

    expect(await nextjsFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing when the client builds a segment from a value and text", async () => {
    const app = copyOf("missing-route-nextjs", "next-mixed");
    edit(
      path.join(app, "lib", "panel.ts"),
      "`/api/orders/${id}/summary`",
      "`/api/orders/${id}.summary`",
    );

    expect(await nextjsFindings(app)).toEqual([]);
  }, 120_000);

  it("reports nothing when the client's base URL is one nothing in the run sets", async () => {
    const app = copyOf("missing-route-nextjs", "next-base");
    edit(
      path.join(app, "lib", "panel.ts"),
      "`/api/orders/${id}/summary`",
      "`${process.env.SHOP_API_URL}/api/orders/${id}/summary`",
    );

    expect(await nextjsFindings(app)).toEqual([]);
  }, 120_000);

  it("reports only the renamed route when other calls go under a base URL the deployment sets", async () => {
    const app = copyOf("missing-route-nextjs", "next-env-base");
    fs.writeFileSync(path.join(app, "lib", "env.ts"), SHOP_BASE_FILE);
    fs.writeFileSync(path.join(app, "lib", "remote.ts"), REMOTE_CALLS);

    const findings = await missingRoutes(app, [
      { argv: typescript("nextjs", "fetch", "axios") },
    ]);

    expect(findings.map((f) => f.description)).toEqual([RENAMED]);
  }, 120_000);
});

const SHOP_BASE_FILE = `export const SHOP_BASE = process.env.SHOP_API_URL ?? "";
`;

// None of these paths is served by the shop, and each call goes to
// whatever host the deployment sets.
const REMOTE_CALLS = `import axios from "axios";

import { SHOP_BASE } from "./env";

const BASE = process.env.SHOP_API_URL || "";

const api = axios.create({ baseURL: process.env.SHOP_API_URL });
const fallbackApi = axios.create({ baseURL: BASE });

export async function listAccounts() {
  return (await api.get("/api/accounts")).data;
}

export async function listInvoices() {
  return (await fallbackApi.get("/api/invoices")).data;
}

export async function listTeams() {
  const res = await fetch(\`\${BASE}/api/teams\`);
  return res.json();
}

export async function listShared() {
  const res = await fetch(\`\${SHOP_BASE}/api/shared\`);
  return res.json();
}

class Links {
  private base = process.env.LINK_API_URL || "";

  async create() {
    const res = await fetch(\`\${this.base}/api/links\`, { method: "POST" });
    return res.json();
  }
}

export const links = new Links();

async function shopGet(path: string) {
  const res = await fetch(\`\${BASE}\${path}\`);
  return res.json();
}

export async function listWrapped() {
  return shopGet("/api/wrapped");
}
`;

describe("an Express app whose client calls a renamed route", () => {
  it("reports the call once, and not the one its static mount serves", async () => {
    const app = copyOf("missing-route-express", "express");
    const findings = await missingRoutes(app, [
      { argv: typescript("express", "fetch") },
    ]);

    expect(findings.map((f) => f.description)).toEqual([
      "loadSummary calls GET /api/orders/{id}/summary, and orders-api, the service it calls, does not serve that path. Every call gets a 404. Routes nearby: GET /api/orders/{id}/totals.",
    ]);
  }, 120_000);
});

describe("a Rails app a Worker calls through the base URL its deployment sets", () => {
  it("reports the call once, and not one under a mounted engine or a Ruby call under a base the deployment sets", async () => {
    const app = copyOf("missing-route-rails", "rails");
    const config = path.join(app, "suss.rails.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        root: path.join(app, "app"),
        routesFile: path.join(app, "config", "routes.rb"),
      }),
    );
    const web = path.join(app, "web");
    const findings = await missingRoutes(app, [
      {
        argv: (out) => [
          "extract",
          "--lang",
          "ruby",
          "--dir",
          app,
          "-f",
          `rails=${config}`,
          "-f",
          "faraday",
          "--no-cache",
          "-o",
          out,
        ],
      },
      { cwd: web, argv: typescript("fetch") },
      {
        cwd: web,
        argv: (out) => [
          "contract",
          "--from",
          "wrangler",
          "wrangler.toml",
          "-o",
          out,
        ],
      },
    ]);

    expect(findings.map((f) => f.description)).toEqual([
      "loadSummary calls GET /orders/{id}/summary, and the service it calls does not serve that path. Every call gets a 404. Routes nearby: GET /orders/{id}/totals.",
    ]);
  }, 120_000);
});
