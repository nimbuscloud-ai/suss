/**
 * One HTTP client library declared once with `@suss/recognize`, called
 * the same way from TypeScript, Python and Ruby. Each adapter hands the
 * request hook the ops over its own facts and builds a client unit from
 * every request the hook reads, so the three languages have to give the
 * same requests.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import {
  anyOf,
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
} from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// Ruby has no imports, so the library is its own constant, which each
// origin lists beside the module. A client is built with a base URL.
const RELAY = ["relayhttp", "Relayhttp"];

const REQUESTS = httpRequests({
  client: anyOf(
    imported({ from: RELAY, named: ["*"] }),
    constructedFrom({ from: RELAY, named: ["Session", "Relayhttp"] }),
  ),
})
  .methods({
    get: { sends: "GET", url: { at: 0 } },
    request: { sends: { from: { at: 0 } }, url: { at: 1 } },
  })
  .baseUrl({ at: 0, joins: "appended" })
  .example('relayhttp.get("/orders")');

const HOOKS = requestRecognizersOf([REQUESTS]);

const TYPESCRIPT = `
  import * as relayhttp from "relayhttp";
  import { Session } from "relayhttp";

  export function list() {
    return relayhttp.get("/orders");
  }

  export function remove() {
    return relayhttp.request("DELETE", "/orders/1");
  }

  export function based() {
    const session = new Session("https://api.example.com/v1");
    return session.get("users");
  }

  export function unread(url: string) {
    return relayhttp.get(url);
  }

  export class Resource {
    constructor(private base: string) {}

    fetchAll() {
      return relayhttp.get(\`/v2\${this.base}\`);
    }
  }

  export const users = new Resource("/users");
  export const orders = new Resource("/orders");
`;

const LIBRARY = `
  export declare function get(url: string): unknown;
  export declare function request(method: string, url: string): unknown;
  export declare class Session {
    constructor(base: string);
    get(url: string): unknown;
  }
`;

const PYTHON = `
import relayhttp
from relayhttp import Session


def list_orders():
    return relayhttp.get("/orders")


def remove():
    return relayhttp.request("DELETE", "/orders/1")


def based():
    session = Session("https://api.example.com/v1")
    return session.get("users")


def unread(url):
    return relayhttp.get(url)


class Resource:
    def __init__(self, base):
        self.base = base

    def fetch_all(self):
        return relayhttp.get(f"/v2{self.base}")


users = Resource("/users")
orders = Resource("/orders")
`;

const RUBY = `
module Store
  def self.list
    Relayhttp.get("/orders")
  end

  def self.remove
    Relayhttp.request("DELETE", "/orders/1")
  end

  def self.based
    session = Relayhttp.new("https://api.example.com/v1")
    session.get("users")
  end

  def self.unread(url)
    Relayhttp.get(url)
  end

  class Resource
    def initialize(base)
      @base = base
    end

    def fetch_all
      Relayhttp.get("/v2#{@base}")
    end
  end

  USERS = Resource.new("/users")
  ORDERS = Resource.new("/orders")
end
`;

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-declared-requests-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Each client unit's request as method, path and host, in one order for every language. */
function requestsOf(summaries: readonly BehavioralSummary[]): string[] {
  return summaries
    .filter((summary) => summary.kind === "client")
    .map((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest"
        ? `${semantics.method} ${semantics.path ?? "-"} ${semantics.host ?? "-"}`
        : "not a request";
    })
    .sort();
}

const PACK = {
  name: "relay",
  protocol: "http",
  discovery: [],
  requestRecognizers: HOOKS,
};

async function typescriptRequests(): Promise<string[]> {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/relayhttp/package.json",
    JSON.stringify({ name: "relayhttp", types: "index.d.ts" }),
  );
  project.createSourceFile("/node_modules/relayhttp/index.d.ts", LIBRARY);
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
  return requestsOf(await adapter.extractAll());
}

async function pythonRequests(): Promise<string[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs: [PACK],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return requestsOf(summaries);
}

async function rubyRequests(): Promise<string[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs: [PACK],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return requestsOf(summaries);
}

describe("a request chain declared once", () => {
  it("reads the same requests in TypeScript, Python and Ruby", async () => {
    const fromTypeScript = await typescriptRequests();

    expect(fromTypeScript).toEqual([
      "DELETE /orders/1 -",
      "GET - -",
      "GET /orders -",
      "GET /v1/users api.example.com",
      "GET /v2/orders -",
      "GET /v2/users -",
    ]);
    expect(await pythonRequests()).toEqual(fromTypeScript);
    expect(await rubyRequests()).toEqual(fromTypeScript);
  });
});
