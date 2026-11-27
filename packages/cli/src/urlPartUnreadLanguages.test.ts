/**
 * Requests whose URL starts with a base the deployment sets, written the
 * same ways in TypeScript, Python and Ruby: a fallback over an
 * environment read in place, in a local, in a module constant, in a name
 * another file exports, in an instance's field, in a value a wrapper is
 * built with, and as the base URL a client instance is built on. Each
 * adapter marks the client, since suss read only part of where the call
 * goes, and a check then does not report the call as one to a route its
 * service lacks. A relative URL with no base gets no mark.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { readHttpMetadata } from "@suss/behavioral-ir";
import aiohttpClient from "@suss/packs/aiohttp";
import axiosPack from "@suss/packs/axios";
import faradayClient from "@suss/packs/faraday";
import httpxClient from "@suss/packs/httpx";
import netHttpClient from "@suss/packs/net-http";
import requestsClient from "@suss/packs/requests";
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

const TYPESCRIPT_CONFIG = `
  export const SHARED_BASE = process.env.RELAY_BASE ?? "";
`;

const TYPESCRIPT = `
  import axios from "axios";
  import { settings } from "relayconf";
  import * as relayhttp from "relayhttp";

  import { SHARED_BASE } from "./config";

  const MODULE_BASE = process.env.RELAY_BASE || "";
  const CONF_BASE = settings.relayBase || "";

  const accounts = axios.create({ baseURL: process.env.RELAY_BASE });
  const invoices = axios.create({ baseURL: process.env.RELAY_BASE ?? "" });
  const payouts = axios.create({ baseURL: MODULE_BASE });

  export function teams() {
    return relayhttp.get(\`\${process.env.RELAY_BASE || ""}/teams\`);
  }

  export function members() {
    const base = process.env.RELAY_BASE ?? "";
    return relayhttp.get(\`\${base}/members\`);
  }

  export function modules() {
    return relayhttp.get(\`\${MODULE_BASE}/modules\`);
  }

  export function shared() {
    return relayhttp.get(\`\${SHARED_BASE}/shared\`);
  }

  export function confs() {
    return relayhttp.get(\`\${CONF_BASE}/confs\`);
  }

  export function listAccounts() {
    return accounts.get("/accounts");
  }

  export function listInvoices() {
    return invoices.get("/invoices");
  }

  export function listPayouts() {
    return payouts.get("/payouts");
  }

  class Ledger {
    private readonly base = process.env.LEDGER_BASE || "";

    entries() {
      return relayhttp.get(\`\${this.base}/entries\`);
    }
  }

  export const ledger = new Ledger();

  class Drafts {
    declare configured?: string;
    private readonly base = this.configured || "";

    list() {
      return relayhttp.get(\`\${this.base}/drafts\`);
    }
  }

  export const drafts = new Drafts();

  class Directory {
    constructor(private readonly base: string) {}

    people() {
      return relayhttp.get(\`\${this.base}/people\`);
    }
  }

  export const directory = new Directory(process.env.DIRECTORY_BASE || "");

  export function orders() {
    return relayhttp.get("/orders");
  }
`;

const PYTHON_CONFIG = `
import os

SHARED_BASE = os.environ.get("RELAY_BASE", "")
`;

const PYTHON = `
import os

import aiohttp
import httpx
import relayhttp
import requests
from relayconf import settings

from store.config import SHARED_BASE

MODULE_BASE = os.environ.get("RELAY_BASE", "")
CONF_BASE = settings.RELAY_BASE or ""

ACCOUNTS = httpx.Client(base_url=os.environ["RELAY_BASE"])
INVOICES = httpx.Client(base_url=os.environ.get("RELAY_BASE", ""))
PAYOUTS = httpx.Client(base_url=MODULE_BASE)
SESSION = requests.Session()


def teams():
    return relayhttp.get(f"{os.environ.get('RELAY_BASE') or ''}/teams")


def members():
    base = os.environ.get("RELAY_BASE", "")
    return relayhttp.get(f"{base}/members")


def modules():
    return relayhttp.get(f"{MODULE_BASE}/modules")


def shared():
    return relayhttp.get(f"{SHARED_BASE}/shared")


def confs():
    return relayhttp.get(f"{CONF_BASE}/confs")


def list_accounts():
    return ACCOUNTS.get("/accounts")


def list_invoices():
    return INVOICES.get("/invoices")


def list_payouts():
    return PAYOUTS.get("/payouts")


def sessions():
    return SESSION.get(f"{MODULE_BASE}/sessions")


async def streams():
    async with aiohttp.ClientSession(base_url=os.environ["RELAY_BASE"]) as session:
        return await session.get("/streams")


class Ledger:
    def __init__(self):
        self.base = os.environ.get("LEDGER_BASE") or ""

    def entries(self):
        return relayhttp.get(f"{self.base}/entries")


LEDGER = Ledger()


class Drafts:
    def __init__(self):
        self.base = self.configured or ""

    def list(self):
        return relayhttp.get(f"{self.base}/drafts")


DRAFTS = Drafts()


class Directory:
    def __init__(self, base):
        self.base = base

    def people(self):
        return relayhttp.get(f"{self.base}/people")


DIRECTORY = Directory(os.environ.get("DIRECTORY_BASE", ""))


def orders():
    return relayhttp.get("/orders")
`;

const RUBY_CONFIG = `
module Config
  SHARED_BASE = ENV.fetch("RELAY_BASE", "")
end
`;

const RUBY = `
module Store
  MODULE_BASE = ENV.fetch("RELAY_BASE", "")
  CONF_BASE = Relayconf::RELAY_BASE || ""

  def self.teams
    Relayhttp.get("#{ENV['RELAY_BASE'] || ''}/teams")
  end

  def self.members
    base = ENV.fetch("RELAY_BASE", "")
    Relayhttp.get("#{base}/members")
  end

  def self.modules
    Relayhttp.get("#{MODULE_BASE}/modules")
  end

  def self.shared
    Relayhttp.get("#{Config::SHARED_BASE}/shared")
  end

  def self.confs
    Relayhttp.get("#{CONF_BASE}/confs")
  end

  def self.list_accounts
    Faraday.new(url: ENV["RELAY_BASE"]).get("/accounts")
  end

  def self.list_invoices
    Faraday.new(url: ENV.fetch("RELAY_BASE", "")).get("/invoices")
  end

  def self.list_hosts
    Net::HTTP.new(ENV.fetch("RELAY_HOST", "localhost"), 443).get("/hosts")
  end

  def self.list_payouts
    Faraday.new(url: MODULE_BASE).get("/payouts")
  end

  def self.orders
    Relayhttp.get("/orders")
  end
end

class Ledger
  def initialize
    @base = ENV["LEDGER_BASE"] || ""
  end

  def entries
    Relayhttp.get("#{@base}/entries")
  end
end

class Drafts
  def initialize
    @base = @configured || ""
  end

  def list
    Relayhttp.get("#{@base}/drafts")
  end
end

class Directory
  def initialize(base)
    @base = base
  end

  def people
    Relayhttp.get("#{@base}/people")
  end
end

DIRECTORY = Directory.new(ENV.fetch("DIRECTORY_BASE", ""))
`;

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-url-part-unread-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.writeFileSync(path.join(root, "store/config.py"), PYTHON_CONFIG);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
  fs.writeFileSync(path.join(root, "lib/config.rb"), RUBY_CONFIG);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Each client's path, and whether suss read its URL in full, sorted by path. */
function marksOf(summaries: readonly BehavioralSummary[]): string[] {
  return summaries
    .filter((summary) => summary.kind === "client")
    .map((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      const path = semantics?.name === "rest" ? semantics.path : null;
      const unread = readHttpMetadata(summary)?.urlPartUnread === true;
      return `${path} ${unread ? "part unread" : "read in full"}`;
    })
    .sort();
}

/** What every language reads, apart from the forms one language lacks. */
const SHARED_MARKS = [
  "/accounts part unread",
  "/confs part unread",
  "/drafts part unread",
  "/entries part unread",
  "/invoices part unread",
  "/members part unread",
  "/modules part unread",
  "/orders read in full",
  "/payouts part unread",
  "/people part unread",
  "/shared part unread",
  "/teams part unread",
];

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
  project.createSourceFile("/config.ts", TYPESCRIPT_CONFIG);
  project.createSourceFile("/store.ts", TYPESCRIPT);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [
      axiosPack(),
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
    files: [
      path.join(root, "store/__init__.py"),
      path.join(root, "store/config.py"),
    ],
    roots: [root],
    packs: [PACK, httpxClient(), requestsClient(), aiohttpClient()],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return marksOf(summaries);
}

async function rubyMarks(): Promise<string[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb"), path.join(root, "lib/config.rb")],
    packs: [PACK, faradayClient(), netHttpClient()],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return marksOf(summaries);
}

const DEFAULTS_SETUP = `
  import axios from "axios";

  export function configure() {
    axios.defaults.baseURL = process.env.RELAY_BASE;
  }
`;

const DEFAULTS_CALLS = `
  import axios from "axios";

  const own = axios.create({ baseURL: "/api" });
  const bare = axios.create({ timeout: 5000 });

  export function teams() {
    return axios.get("/teams");
  }

  export function members() {
    return bare.get("/members");
  }

  export function invites() {
    return axios.get("https://hooks.example.com/invites");
  }

  export function projects() {
    return own.get("/projects");
  }
`;

/** The marks on the calls in DEFAULTS_CALLS, with the file that writes axios's default base or without it. */
async function defaultsMarks(written: boolean): Promise<string[]> {
  const project = createTestProject();
  if (written) {
    project.createSourceFile("/setup.ts", DEFAULTS_SETUP);
  }
  project.createSourceFile("/calls.ts", DEFAULTS_CALLS);
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [axiosPack()],
  });
  return marksOf(await adapter.extractAll());
}

describe("a base the program writes to a library's defaults", () => {
  it("marks each relative call on a client with no base of its own, in every file", async () => {
    expect(await defaultsMarks(true)).toEqual([
      "/api/projects read in full",
      "/invites read in full",
      "/members part unread",
      "/teams part unread",
    ]);
  });

  it("marks nothing when the program does not write it", async () => {
    expect(await defaultsMarks(false)).toEqual([
      "/api/projects read in full",
      "/invites read in full",
      "/members read in full",
      "/teams read in full",
    ]);
  });
});

describe("a URL whose base the deployment sets", () => {
  it("is marked in TypeScript through every way the base reaches the call, and a relative URL is not", async () => {
    expect(await typescriptMarks()).toEqual(SHARED_MARKS);
  });

  it("is marked in Python the same ways, with a session's call and a base aiohttp refuses", async () => {
    expect(await pythonMarks()).toEqual(
      [...SHARED_MARKS, "/sessions part unread", "/streams part unread"].sort(),
    );
  });

  it("is marked in Ruby the same ways, with a Net::HTTP host that took a default", async () => {
    expect(await rubyMarks()).toEqual(
      [...SHARED_MARKS, "/hosts part unread"].sort(),
    );
  });
});
