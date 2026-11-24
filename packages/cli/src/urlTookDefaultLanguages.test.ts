/**
 * A request whose URL starts with a fallback over an environment read,
 * written the same way in TypeScript, Python and Ruby. The value reader
 * takes the default, so the path reads as relative, and each adapter
 * marks the client so a check knows the deployment may send the call
 * somewhere else. A URL with every part read gets no mark.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readHttpMetadata } from "@suss/behavioral-ir";
import { httpRequests, imported, requestRecognizersOf } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// Ruby has no imports, so the library is its own constant, which the
// origin lists beside the module.
const RELAY = ["relayhttp", "Relayhttp"];

const REQUESTS = httpRequests({
  client: imported({ from: RELAY, named: ["*"] }),
})
  .methods({ get: { sends: "GET", url: { at: 0 } } })
  .example('relayhttp.get("/orders")');

const PACK = {
  name: "relay",
  protocol: "http",
  discovery: [],
  requestRecognizers: requestRecognizersOf([REQUESTS]),
};

const TYPESCRIPT = `
  import * as relayhttp from "relayhttp";

  export function teams() {
    return relayhttp.get(\`\${process.env.RELAY_BASE || ""}/teams\`);
  }

  export function members() {
    return relayhttp.get(\`\${process.env.RELAY_BASE ?? ""}/members\`);
  }

  export function orders() {
    return relayhttp.get("/orders");
  }
`;

const PYTHON = `
import os

import relayhttp


def teams():
    return relayhttp.get(f"{os.environ.get('RELAY_BASE') or ''}/teams")


def members():
    return relayhttp.get(f"{os.environ.get('RELAY_BASE', '')}/members")


def orders():
    return relayhttp.get("/orders")
`;

const RUBY = `
module Store
  def self.teams
    Relayhttp.get("#{ENV['RELAY_BASE'] || ''}/teams")
  end

  def self.members
    Relayhttp.get("#{ENV.fetch('RELAY_BASE', '')}/members")
  end

  def self.orders
    Relayhttp.get("/orders")
  end
end
`;

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-url-default-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Each client's path, and whether its URL took a default, sorted by path. */
function marksOf(summaries: readonly BehavioralSummary[]): string[] {
  return summaries
    .filter((summary) => summary.kind === "client")
    .map((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      const path = semantics?.name === "rest" ? semantics.path : null;
      const took = readHttpMetadata(summary)?.urlTookDefault === true;
      return `${path} ${took ? "took a default" : "read in full"}`;
    })
    .sort();
}

async function typescriptMarks(): Promise<string[]> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/relayhttp/package.json",
    JSON.stringify({ name: "relayhttp", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/relayhttp/index.d.ts",
    "export declare function get(url: string): unknown;",
  );
  project.createSourceFile("/store.ts", TYPESCRIPT);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [
      {
        ...PACK,
        languages: ["typescript"],
        terminals: [
          {
            kind: "return",
            match: { type: "returnStatement" },
            extraction: {},
          },
        ],
        inputMapping: { type: "positionalParams", params: [] },
      },
    ],
  });
  return marksOf(await adapter.extractAll());
}

async function pythonMarks(): Promise<string[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [PACK],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return marksOf(summaries);
}

async function rubyMarks(): Promise<string[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs: [PACK],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return marksOf(summaries);
}

describe("a URL that took a fallback's default over an environment read", () => {
  it("is marked in TypeScript, Python and Ruby, and a URL read in full is not", async () => {
    const fromTypeScript = await typescriptMarks();

    expect(fromTypeScript).toEqual([
      "/members took a default",
      "/orders read in full",
      "/teams took a default",
    ]);
    expect(await pythonMarks()).toEqual(fromTypeScript);
    expect(await rubyMarks()).toEqual(fromTypeScript);
  });
});
