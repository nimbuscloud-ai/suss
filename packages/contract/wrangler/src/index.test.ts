import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";

import { wranglerFileToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-wrangler-"));

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  write(
    "greeting/wrangler.toml",
    `name = "greeting-router"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[vars]
GREETING_TABLE = "prod-greetings-v2"
RETRY_LIMIT = 3

[[kv_namespaces]]
binding = "SESSIONS"
id = "prod-sessions"

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "prod-archive"

[[d1_databases]]
binding = "LEDGER"
database_name = "prod-ledger"

[[queues.producers]]
binding = "OUTBOUND"
queue = "greeting-events"

[[queues.consumers]]
queue = "greeting-retries"

[env.staging]
[env.staging.vars]
GREETING_TABLE = "staging-greetings-v2"
`,
  );
  write(
    "inherited/wrangler.toml",
    `name = "inherit-router"

[vars]
SHARED_ORIGIN = "https://example.invalid"

[env.staging]
`,
  );
  write(
    "jsonc/wrangler.jsonc",
    `{
       // The name the script deploys under.
       "name": "jsonc-router",
       "main": "src/index.ts",
       "vars": { "GREETING_TABLE": "prod-greetings-v2" },
     }`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function read(rel: string): BehavioralSummary[] {
  return wranglerFileToSummaries(path.join(root, rel));
}

function runtimeFor(
  summaries: BehavioralSummary[],
  instanceName: string,
): BehavioralSummary | undefined {
  return summaries.find(
    (s) =>
      s.identity.boundaryBinding?.semantics.name === "runtime-config" &&
      s.identity.deployableUnit?.instanceName === instanceName,
  );
}

describe("wranglerFileToSummaries", () => {
  it("takes a directory and finds the document in it", () => {
    expect(read("greeting").length).toBeGreaterThan(0);
  });

  it("declares the Worker as a runtime-config provider on its own deployable", () => {
    const runtime = runtimeFor(read("greeting"), "greeting-router");
    expect(runtime?.identity.deployableUnit).toEqual({
      deploymentTarget: "worker",
      instanceName: "greeting-router",
    });
    expect(runtime?.identity.boundaryBinding?.recognition).toBe("wrangler");
  });

  it("records what each variable is set to, and skips one that is not text", () => {
    const runtime = runtimeFor(read("greeting"), "greeting-router");
    const contract = readRuntimeContractMetadata(runtime as BehavioralSummary);
    expect(contract?.envVars).toEqual(["GREETING_TABLE", "RETRY_LIMIT"]);
    expect(contract?.envVarValues).toEqual({
      GREETING_TABLE: "prod-greetings-v2",
    });
  });

  it("puts the Worker's code scope on the summary", () => {
    const runtime = runtimeFor(read("greeting"), "greeting-router");
    const scope = runtime?.metadata?.codeScope as {
      path: string;
      entry: string;
    };
    expect(scope.path.endsWith("greeting")).toBe(true);
    expect(scope.entry.endsWith("greeting/src/index")).toBe(true);
  });

  it("emits one store per binding block", () => {
    const stores = read("greeting").filter(
      (s) => s.identity.boundaryBinding?.semantics.name === "storage",
    );
    expect(
      stores.map((s) => {
        const semantics = s.identity.boundaryBinding
          ?.semantics as unknown as Record<string, string>;
        return [semantics.storageSystem, semantics.container];
      }),
    ).toEqual([
      ["cloudflare-kv", "prod-sessions"],
      ["r2", "prod-archive"],
      ["d1", "prod-ledger"],
    ]);
  });

  it("emits the producer channel once and one consumer per deployment", () => {
    const queues = read("greeting").filter(
      (s) => s.identity.boundaryBinding?.semantics.name === "message-bus",
    );
    expect(
      queues.map((s) => [
        s.kind,
        (
          s.identity.boundaryBinding?.semantics as unknown as Record<
            string,
            string
          >
        ).channel,
      ]),
    ).toEqual([
      ["library", "greeting-events"],
      ["consumer", "greeting-retries"],
      ["consumer", "greeting-retries"],
    ]);
  });

  it("deploys each environment as its own Worker", () => {
    const summaries = read("greeting");
    const staging = runtimeFor(summaries, "greeting-router-staging");
    const contract = readRuntimeContractMetadata(staging as BehavioralSummary);
    expect(contract?.envVarValues).toEqual({
      GREETING_TABLE: "staging-greetings-v2",
    });
    expect(contract?.envVarSources?.GREETING_TABLE).toBe("template");
  });

  it("marks a variable an environment inherits as a document-level default", () => {
    const staging = runtimeFor(read("inherited"), "inherit-router-staging");
    const contract = readRuntimeContractMetadata(staging as BehavioralSummary);
    expect(contract?.envVarSources?.SHARED_ORIGIN).toBe("globals");
  });

  it("reads the JSONC spelling, comments and trailing commas included", () => {
    const runtime = runtimeFor(read("jsonc"), "jsonc-router");
    const contract = readRuntimeContractMetadata(runtime as BehavioralSummary);
    expect(contract?.envVarValues).toEqual({
      GREETING_TABLE: "prod-greetings-v2",
    });
  });

  it("says so when the path holds no configuration", () => {
    expect(() => read("nowhere")).toThrow(/not found/);
  });
});
