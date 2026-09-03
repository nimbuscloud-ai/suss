import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./index.js";

/**
 * A project with both sides of one boundary, where the two disagree.
 * The handler returns `total` and the caller reads `currency`.
 */
function writeProject(root: string): void {
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
      'app.get("/orders/:id", (req, res) => {',
      "  res.status(200).json({ id: req.params.id, total: 42 });",
      "});",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src/native.ts"),
    [
      'import { publishEntry } from "@acme/ledger-native";',
      "export function push(entry: object): Promise<void> {",
      '  return publishEntry("ledger-queue", entry);',
      "}",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src/client.ts"),
    [
      "export async function loadOrder(id: string): Promise<unknown> {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is TypeScript source for the fixture, and the template is the point. A concatenated path spells the boundary differently and the two sides stop pairing.
      "  const res = await fetch(`/orders/${id}`);",
      "  const order = (await res.json()) as { id: string; currency: string };",
      "  return order.currency;",
      "}",
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
          packs: ["express", "fetch"],
        },
      ],
    }),
  );
}

/** A client talking to the server over a linked pair of transports. */
async function connect(root: string): Promise<{ client: Client }> {
  const { server } = await createServer({ root, watch: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client };
}

let root: string;
let client: Client;

describe("the suss MCP server", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-mcp-test-"));
    writeProject(root);
    ({ client } = await connect(root));
  }, 60_000);

  it("reports the version it was published at", async () => {
    // npm_package_version is set when npm runs a script and not when a
    // host starts the binary, so every client that asked used to be
    // told 0.0.0-dev.
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    const info = client.getServerVersion();
    expect(info?.version).toBe(manifest.version);
    expect(info?.version).not.toBe("0.0.0-dev");
  });

  it("offers the five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "suss_ask",
      "suss_boundaries",
      "suss_check",
      "suss_status",
      "suss_stub_draft",
    ]);
  });

  it("says how to ask in the description, since a model reads it before calling", async () => {
    const { tools } = await client.listTools();
    const ask = tools.find((t) => t.name === "suss_ask");
    expect(ask?.description).toContain("what reads <boundary>");
    expect(ask?.description).toContain("why does <unit> reach <boundary>");
  });

  it("says what a finding means in the check description", async () => {
    const { tools } = await client.listTools();
    const check = tools.find((t) => t.name === "suss_check");
    // The half our field tester said he could not write himself.
    expect(check?.description).toContain("unhandledProviderCase");
    expect(check?.description).toContain("nothingPaired");
  });

  it("answers a question about a boundary in the project", async () => {
    const result = await client.callTool({
      name: "suss_ask",
      arguments: { question: "what does src/client.ts reach" },
    });
    const answer = result.structuredContent as {
      found: boolean;
      shape: string;
    };
    expect(answer.found).toBe(true);
    expect(answer.shape).toBe("reaches");
  });

  it("says the question was not one of the ten, rather than answering nothing", async () => {
    const result = await client.callTool({
      name: "suss_ask",
      arguments: { question: "what is the meaning of this codebase" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("ten questions");
  });

  it("drafts a stub skeleton from the project's calls into a package", async () => {
    const result = await client.callTool({
      name: "suss_stub_draft",
      arguments: { package: "@acme/ledger-native" },
    });
    expect(result.isError).toBeUndefined();
    const text = JSON.stringify(result.content);
    expect(text).toContain("Save this to");
    expect(text).toContain("publishEntry");
    expect(text).toContain("performs-call");
  });

  it("says there is nothing to draft for a package the project never calls", async () => {
    const result = await client.callTool({
      name: "suss_stub_draft",
      arguments: { package: "@acme/never-imported" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("nothing to draft");
  });

  it("compares the two sides and says so, rather than reporting an empty run", async () => {
    const result = await client.callTool({
      name: "suss_check",
      arguments: {},
    });
    const payload = result.structuredContent as {
      findings: unknown[];
      run?: Array<{ kind: string }>;
    };
    expect(Array.isArray(payload.findings)).toBe(true);
    // The handler and the caller are both here and they pair, so no
    // nothingPaired. An empty findings list with one of those present
    // would mean the run compared nothing, which is a different answer.
    expect(payload.run).toBeUndefined();
  });

  it("says nothing is at a boundary this project does not have", async () => {
    const result = await client.callTool({
      name: "suss_check",
      arguments: { boundary: "GET /nowhere" },
    });
    const payload = result.structuredContent as {
      matched: boolean;
      note?: string;
    };
    expect(payload.matched).toBe(false);
    expect(payload.note).toContain("shorter spelling");
  });

  it("lists the boundaries and how they pair", async () => {
    const result = await client.callTool({
      name: "suss_boundaries",
      arguments: {},
    });
    const payload = result.structuredContent as {
      counts: { paired: number };
    };
    expect(payload.counts.paired).toBe(1);
  });

  it("marks every tool read-only, so a host never has to ask before calling one", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
    }
  });

  it("keeps an answer small enough to leave room to act on it", async () => {
    // Everything a tool spends in the context window is unavailable to
    // the work the model was doing.
    const result = await client.callTool({
      name: "suss_check",
      arguments: {},
    });
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
  });

  it("turns a failure into something to do next, not a stack trace", async () => {
    const { attempt } = await import("./tools.js");
    const result = await attempt("suss_check", () => {
      throw new Error("the summaries could not be read");
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("the summaries could not be read");
    expect(text).toContain("suss_status");
  });

  it("says what it is answering from", async () => {
    const result = await client.callTool({
      name: "suss_status",
      arguments: {},
    });
    const report = result.structuredContent as {
      configured: boolean;
      ran: string[];
      failed: string[];
    };
    expect(report.configured).toBe(true);
    expect(report.ran).toHaveLength(1);
    expect(report.failed).toHaveLength(0);
  });

  it("says a project with no suss.json will answer nothing, rather than failing to start", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "suss-mcp-bare-"));
    const { project: bareProject } = await createServer({
      root: bare,
      watch: false,
    });
    expect(bareProject.lastBuild().configured).toBe(false);
    bareProject.close();
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
