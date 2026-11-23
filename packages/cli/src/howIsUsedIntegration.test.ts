/**
 * `how is <unit> used` on one app per language, each with the same three
 * made-up constructs: an HTTP helper that two routes and a job call, a
 * key-value store whose callers pass different keys, and a filter or
 * dependency that can send the response itself for the routes it wraps.
 * Each app is read
 * the way a user reads it, with `extract` and the packs `init` picks, and
 * every answer comes from the summaries written to disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { answerQuestion } from "./ask.js";
import { extract } from "./extract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { AnswerJson } from "./ask.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "suss-how-is-used-"));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A pack's config file, written where the run can read it. */
function config(name: string, value: unknown): string {
  const file = path.join(scratch, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** The summaries written to their own folder, which is what `ask --dir` reads. */
function written(name: string, summaries: BehavioralSummary[]): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "code.json"), JSON.stringify(summaries));
  return dir;
}

function asked(
  question: string,
  dir: string,
): { json: AnswerJson; text: string } {
  const out = path.join(scratch, "answer.txt");
  const { answer } = answerQuestion({ question, dir, output: out });
  const text = fs.readFileSync(out, "utf8");
  expect(answer?.found, `${question}: ${answer?.headline}`).toBe(true);
  return { json: answer as AnswerJson, text };
}

type Item = Record<string, unknown>;

function itemsOf(answer: AnswerJson, kind: string): Item[] {
  return (answer.items as Item[]).filter((item) => item.kind === kind);
}

/** Each group as "member: value (calls)". */
function groups(answer: AnswerJson): string[] {
  return itemsOf(answer, "group").map((group) => {
    const values = group.values as Array<{ value: string | null }>;
    const shown = values.map((value) => value.value ?? "left out").join(", ");
    return `${group.through}: ${shown} (${group.calls})`;
  });
}

/** Every entry point the answer lists, certain ones without a mark and possible ones with a `?`. */
function entryPoints(answer: AnswerJson): string[] {
  const construct = answer.construct as {
    entryPoints: Array<{ boundary: string; possible?: true }>;
  };
  return construct.entryPoints
    .map((entry) => `${entry.boundary}${entry.possible === true ? "?" : ""}`)
    .sort();
}

/**
 * Each group as "member METHOD: values", with "could be A or B" when a
 * call may make one of several requests.
 */
function requestGroups(answer: AnswerJson): string[] {
  return itemsOf(answer, "group")
    .map((group) => {
      const requests = group.requests as Array<{
        method: string | null;
        possible?: true;
      }>;
      const certain = requests.filter((one) => one.possible !== true);
      const methods = (list: typeof requests) =>
        [...new Set(list.map((one) => one.method ?? "?"))].join(" or ");
      const sends =
        certain.length > 0 ? methods(certain) : `could be ${methods(requests)}`;
      const spellings = (group.spellings as Array<{ spelled: string }>).map(
        (one) => one.spelled,
      );
      return `${group.through} ${sends}: ${spellings.join(" | ")}`;
    })
    .sort();
}

function conditions(answer: AnswerJson): string[] {
  return itemsOf(answer, "call").flatMap((call) => call.conditions as string[]);
}

function fileOf(summaries: BehavioralSummary[], ending: string): string {
  const found = summaries.find((summary) =>
    summary.location.file.endsWith(ending),
  );
  expect(found, ending).toBeDefined();
  return (found as BehavioralSummary).location.file;
}

describe("how is a construct used, in a Rails app", () => {
  let dir: string;

  beforeAll(async () => {
    const app = path.join(fixtures, "how-is-used-ruby");
    const summaries = await extract({
      dir: app,
      lang: "ruby",
      frameworks: [
        "activejob",
        `rails=${config("rails", { root: path.join(app, "app"), routesFile: path.join(app, "config/routes.rb") })}`,
        "net-http",
        `activerecord=${config("activerecord", { storageSystem: "postgresql" })}`,
      ],
      noCache: true,
      quiet: true,
    });
    dir = written("ruby", summaries);
  }, 120_000);

  it("lists an HTTP helper's callers with the routes and the job that reach them", () => {
    const { json, text } = asked("how is Outbound.fetch used", dir);
    expect(json.headline).toContain("makes service calls (net-http)");
    expect(json.headline).toContain("3 calls from 3 files");
    expect(text).toContain("It raises Refused.");
    expect(entryPoints(json)).toEqual([
      "PATCH /account",
      "POST /orders",
      "PUT /account",
      "bus:activejob SyncJob",
    ]);
    expect(conditions(json)).toContain("order.total > 100");
  });

  it("groups a store's calls by the key each one passes", () => {
    const { json } = asked("how is Setting used", dir);
    expect(groups(json)).toEqual([
      'enabled?: "sync:orders" (1)',
      'lookup: "user:#{_}:theme" (2)',
      'lookup: "site:banner" (1)',
    ]);
    expect(json.headline).toContain("reads or writes storage");
  });

  it("reads a filter as a wrapper and lists every route it wraps", () => {
    const { json, text } = asked(
      "how is LoginRequired.require_login used",
      dir,
    );
    expect(json.headline).toContain("adds outcomes to the units it wraps");
    expect(text).toContain("It responds 302 when !(@user).");
    expect(entryPoints(json)).toEqual([
      "GET /account",
      "GET /orders",
      "GET /orders/{id}",
      "PATCH /account",
      "POST /orders",
      "PUT /account",
    ]);
  });
});

describe("how is a construct used, in a FastAPI app", () => {
  let dir: string;
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    summaries = await extract({
      dir: path.join(fixtures, "how-is-used-python"),
      lang: "python",
      frameworks: [
        "fastapi",
        "celery",
        "httpx",
        `sqlalchemy=${config("sqlalchemy", { storageSystem: "postgresql" })}`,
      ],
      noCache: true,
      quiet: true,
    });
    dir = written("python", summaries);
  }, 120_000);

  it("lists an HTTP helper's callers with the routes and the task that reach them", () => {
    const { json, text } = asked("how is fetch used", dir);
    expect(json.headline).toContain("makes service calls (httpx)");
    expect(text).toContain("It raises Refused.");
    expect(entryPoints(json)).toEqual([
      "POST /orders",
      "PUT /account",
      "bus:celery orders.sync",
    ]);
  });

  it("groups a store module's calls by the key each one passes", () => {
    const store = fileOf(summaries, "app/settings_store.py");
    const { json } = asked(`how is ${store} used`, dir);
    expect(groups(json)).toEqual([
      'enabled: "site:accounts" (1)',
      'enabled: "sync:orders" (1)',
      'lookup: f"user:{_}:theme" (2)',
      'lookup: "site:banner" (1)',
    ]);
  });

  it("reads a dependency as a wrapper and lists every route that takes it", () => {
    const { json, text } = asked("how is require_user used", dir);
    expect(text).toContain("It responds 401 when !authorization.");
    expect(entryPoints(json)).toEqual([
      "GET /orders",
      "GET /orders/{order_id}",
      "POST /orders",
      "PUT /account",
    ]);
  });
});

describe("how is a construct used, in an Express app", () => {
  let dir: string;
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    summaries = await extract({
      tsconfig: path.join(fixtures, "how-is-used-typescript/tsconfig.json"),
      frameworks: ["express", "axios", "bullmq", "prisma", "node"],
      noCache: true,
      quiet: true,
    });
    dir = written("typescript", summaries);
  }, 120_000);

  it("lists an HTTP helper's callers with the routes and the worker that reach them", () => {
    const { json, text } = asked("how is send used", dir);
    expect(json.headline).toContain("makes service calls (axios)");
    expect(text).toContain("It raises Refused.");
    expect(entryPoints(json)).toEqual([
      "POST /orders",
      "PUT /account",
      "bus:bullmq sync",
    ]);
    expect(conditions(json)).toEqual(["req.body.total > 100"]);
  });

  it("groups a store module's calls by the key each one passes", () => {
    const store = fileOf(summaries, "src/settings.ts");
    const { json } = asked(`how is ${store} used`, dir);
    expect(groups(json)).toEqual([
      'enabled: "site:accounts" (1)',
      'enabled: "sync:orders" (1)',
      "lookup: `user:${_}:theme` (2)",
      'lookup: "site:banner" (1)',
    ]);
  });

  it("reads a middleware as a wrapper and lists every route it wraps", () => {
    const { json, text } = asked("how is requireUser used", dir);
    expect(text).toContain("It responds 401 when !req.headers.authorization.");
    expect(entryPoints(json)).toEqual([
      "GET /orders",
      "GET /orders/{id}",
      "POST /orders",
      "PUT /account",
    ]);
  });
});

/**
 * HTTP helpers that take the method from their caller, by position or by
 * keyword, with a default when the caller leaves it out. Each call is in
 * the group of the request it makes, and a call that passes on a value
 * suss cannot settle says which requests it could make.
 */
describe("how is an HTTP helper used, by the request each call makes", () => {
  async function extracted(
    fixture: string,
    lang: "ruby" | "python" | "typescript",
    frameworks: string[],
  ): Promise<string> {
    const summaries = await extract({
      dir: path.join(fixtures, fixture),
      ...(lang === "typescript" ? {} : { lang }),
      frameworks,
      noCache: true,
      quiet: true,
    });
    return written(fixture, summaries);
  }

  it("groups a Ruby helper's calls by the verb each passes or the default", async () => {
    const dir = await extracted("request-method-parameter-ruby", "ruby", [
      "net-http",
      "faraday",
    ]);
    const { json, text } = asked("how is HttpClient.fetch used", dir);
    expect(requestGroups(json)).toEqual([
      'fetch DELETE: "delete"',
      'fetch GET: "get" by default',
      'fetch POST: "post"',
    ]);
    expect(text).toMatch(/fetch\s+GET\s+1\s+"get" by default/);
    expect(
      requestGroups(asked("how is HttpClient.send_request used", dir).json),
    ).toEqual([
      'send_request GET: "https://api.example.com/audit", "get" by default',
      'send_request PUT: "https://api.example.com/grants/#{id}", "put"',
    ]);
    expect(
      requestGroups(asked("how is HttpClient.send_raw used", dir).json),
    ).toEqual(['send_raw DELETE: "DELETE"']);
  }, 120_000);

  it("reads a Ruby verb passed as a keyword by its name", async () => {
    const dir = await extracted("request-method-keyword-ruby", "ruby", [
      "net-http",
      "faraday",
    ]);
    expect(
      requestGroups(asked("how is HttpClient.fetch used", dir).json),
    ).toEqual([
      'fetch DELETE: "delete"',
      'fetch GET: "get" by default',
      'fetch POST: "post"',
      "fetch could be GET or DELETE or POST: verb",
    ]);
    expect(
      requestGroups(asked("how is HttpClient.send_request used", dir).json),
    ).toEqual([
      'send_request GET: "https://api.example.com/audit", "get" by default',
      'send_request PUT: "https://api.example.com/grants/#{id}", "put"',
    ]);
  }, 120_000);

  it("groups a Python helper's calls, with keywords in any order", async () => {
    const positional = await extracted(
      "request-method-parameter-python",
      "python",
      ["requests", "httpx", "aiohttp"],
    );
    expect(requestGroups(asked("how is fetch used", positional).json)).toEqual([
      'fetch DELETE: "https://api.example.com/grants/g1", "delete"',
      'fetch GET: "https://api.example.com/grants", "get" by default',
      'fetch POST: "https://api.example.com/grants", "post"',
    ]);
    expect(
      requestGroups(asked("how is send_httpx used", positional).json),
    ).toEqual([
      'send_httpx DELETE: "https://api.example.com/grants/g1", "DELETE"',
    ]);

    const keyword = await extracted("request-method-keyword-python", "python", [
      "requests",
    ]);
    expect(requestGroups(asked("how is fetch used", keyword).json)).toEqual([
      'fetch DELETE: "https://api.example.com/grants/g1", "delete"',
      'fetch GET: "https://api.example.com/grants", "get" by default',
      'fetch POST: "https://api.example.com/grants", "post"',
      'fetch could be GET or DELETE or POST: "https://api.example.com/grants/g1", method',
    ]);
    expect(requestGroups(asked("how is send used", keyword).json)).toEqual([
      'send GET: "https://api.example.com/audit", "GET" by default',
      'send PUT: "https://api.example.com/grants/g1", "PUT"',
    ]);
  }, 120_000);

  it("groups a TypeScript helper's calls by the method each passes or the default", async () => {
    const dir = await extracted("request-method-parameter", "typescript", [
      "express",
      "fetch",
      "axios",
    ]);
    expect(requestGroups(asked("how is call used", dir).json)).toEqual([
      'call GET: "https://api.example.com/audit", "get" by default',
      'call PUT: `https://api.example.com/grants/${req.params.id}`, "put"',
    ]);
    expect(requestGroups(asked("how is send used", dir).json)).toEqual([
      'send DELETE: `https://api.example.com/grants/${req.params.id}`, "DELETE"',
      'send GET: "https://api.example.com/grants", "GET" by default',
      'send POST: "https://api.example.com/grants", "POST"',
    ]);
  }, 120_000);
});
