/**
 * A route renamed on the server, with its client left calling the old
 * path, in a Next.js app, an Express app, and a Rails app a Worker calls
 * through a base URL its deployment sets. Each reports the one call
 * once. The Next.js app reports nothing once a rewrite covers the path,
 * a catch-all route could serve it, the client builds a segment from a
 * value and text, or its base URL is one nothing in the run sets.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  contract,
  edit,
  fixtureCopier,
  missingRoutes,
  typescript,
} from "./__fixtures__/missingRoute.js";

import type { Finding } from "@suss/behavioral-ir";

const copyOf = fixtureCopier("suss-missing-route-");

async function nextjsFindings(app: string): Promise<Finding[]> {
  return missingRoutes(app, [{ argv: typescript("nextjs", "fetch") }]);
}

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

  it("reports only the renamed route beside a route file it does not read and a write to axios's default base", async () => {
    const app = copyOf("missing-route-nextjs", "next-unread");
    const auth = path.join(app, "pages", "api", "auth");
    fs.mkdirSync(auth, { recursive: true });
    fs.writeFileSync(
      path.join(auth, "confirm-email.ts"),
      'export { default } from "../../../lib/confirmEmail";\n',
    );
    fs.writeFileSync(path.join(app, "lib", "confirmEmail.ts"), CONFIRM_EMAIL);
    fs.writeFileSync(path.join(app, "lib", "setup.ts"), DEFAULT_BASE);
    fs.writeFileSync(path.join(app, "lib", "account.ts"), ACCOUNT_CALLS);

    const findings = await missingRoutes(app, [
      { argv: typescript("nextjs", "fetch", "axios") },
    ]);

    expect(findings.map((f) => f.description)).toEqual([RENAMED]);
  }, 120_000);

  it("reads a config the program leaves out, past a spread in webpack, with a redirect a host decides", async () => {
    const app = copyOf("missing-route-nextjs", "next-config-js");
    fs.rmSync(path.join(app, "next.config.ts"));
    fs.writeFileSync(path.join(app, "next.config.mjs"), CONFIG_MODULE);
    fs.appendFileSync(path.join(app, "lib", "panel.ts"), DOCS_CALL);

    const findings = await nextjsFindings(app);

    expect(findings.map((f) => f.description)).toEqual([RENAMED]);
  }, 120_000);
});

const CONFIRM_EMAIL = `export default async function confirmEmail(
  _req: unknown,
  res: { json: (body: unknown) => void },
) {
  res.json({ confirmed: true });
}
`;

const DEFAULT_BASE = `import axios from "axios";

export function configureApi() {
  axios.defaults.baseURL = process.env.SHOP_API_URL;
}
`;

// The shop serves neither path itself: the first goes to a route file
// suss does not read, and the second to the host the deployment sets.
const ACCOUNT_CALLS = `import axios from "axios";

export async function confirmEmail(token: string) {
  const res = await fetch("/api/auth/confirm-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return res.ok;
}

export async function listMembers() {
  return (await axios.get("/api/members")).data;
}
`;

// A config in JavaScript, which the fixture's tsconfig leaves out.
const CONFIG_MODULE = `const nextConfig = {
  webpack(config) {
    return { ...config, resolve: { ...config.resolve } };
  },
  async rewrites() {
    return [
      { source: "/legacy/:path*", destination: "https://old.example.com/:path*" },
    ];
  },
  async redirects() {
    return [
      {
        source: "/docs/:path*",
        has: [{ type: "host", value: "docs.example.com" }],
        destination: "https://example.com/docs/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
`;

const DOCS_CALL = `
export async function openDocs() {
  const res = await fetch("/docs/intro");
  return res.ok;
}
`;

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
  it("reports the call once, and not one under a mounted engine, one to a controller suss does not read, or a Ruby call under a base the deployment sets", async () => {
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
      { cwd: web, argv: contract("wrangler", "wrangler.toml") },
    ]);

    expect(findings.map((f) => f.description)).toEqual([
      "loadSummary calls GET /orders/{id}/summary, and the service it calls does not serve that path. Every call gets a 404. Routes nearby: GET /orders/{id}/totals.",
    ]);
  }, 120_000);
});
