import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { awsLambdaFramework, clearTemplateCache } from "./index.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/aws-lambda");

async function runAdapter(): Promise<BehavioralSummary[]> {
  clearTemplateCache();
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
    },
  });
  project.addSourceFilesAtPaths(path.join(fixturesDir, "src/handlers/*.ts"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [awsLambdaFramework()],
  });

  return await adapter.extractAll();
}

function restBindingOf(
  summary: BehavioralSummary,
): { method: string; path: string } | null {
  const binding = summary.identity.boundaryBinding;
  if (binding === null || binding.semantics.name !== "rest") {
    return null;
  }
  return { method: binding.semantics.method, path: binding.semantics.path };
}

function byRoute(
  summaries: BehavioralSummary[],
  method: string,
  routePath: string,
): BehavioralSummary | undefined {
  return summaries.find((s) => {
    const rest = restBindingOf(s);
    return rest !== null && rest.method === method && rest.path === routePath;
  });
}

function statusCodesOf(summary: BehavioralSummary): number[] {
  const codes: number[] = [];
  for (const t of summary.transitions) {
    if (
      t.output.type === "response" &&
      t.output.statusCode?.type === "literal"
    ) {
      codes.push(t.output.statusCode.value as number);
    }
  }
  return codes.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Pack-shape structural checks
// ---------------------------------------------------------------------------

describe("awsLambdaFramework — pack shape", () => {
  it("declares an HTTP pack with a template-driven discovery callback", () => {
    const pack = awsLambdaFramework();
    expect(pack.name).toBe("aws-lambda");
    expect(pack.protocol).toBe("http");
    expect(pack.discovery).toEqual([]);
    expect(pack.discoverUnits).toBeDefined();
    expect(pack.requiresImport).toEqual(["aws-lambda"]);
  });

  it("declares envelope + helper response terminals", () => {
    const pack = awsLambdaFramework();
    const functionCalls = pack.terminals
      .filter((t) => t.match.type === "functionCall")
      .map((t) =>
        t.match.type === "functionCall" ? t.match.functionName : "",
      );
    expect(functionCalls).toContain("json");
    expect(functionCalls).toContain("redirect");
    const envelope = pack.terminals.find((t) => t.match.type === "returnShape");
    expect(envelope?.extraction.body).toEqual({
      from: "property",
      name: "body",
      unwrapJsonStringify: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the fixture service
// ---------------------------------------------------------------------------

describe("awsLambdaFramework — extraction", () => {
  let summaries: BehavioralSummary[];

  beforeAll(async () => {
    summaries = await runAdapter();
  });

  it("binds each declared route to a handler summary", () => {
    expect(
      byRoute(summaries, "POST", "/tokens/{tokenId}/confirm"),
    ).toBeDefined();
    expect(byRoute(summaries, "GET", "/widgets")).toBeDefined();
    expect(byRoute(summaries, "GET", "/widgets/{widgetId}")).toBeDefined();
    expect(byRoute(summaries, "DELETE", "/widgets/{widgetId}")).toBeDefined();
  });

  it("stamps the recognition label on discovered handlers", () => {
    const list = byRoute(summaries, "GET", "/widgets");
    const binding = list?.identity.boundaryBinding as BoundaryBinding;
    expect(binding.recognition).toBe("aws-lambda");
    expect(binding.transport).toBe("http");
  });

  it("extracts a helper-mediated JSON envelope (json(...) → payload shape)", () => {
    const confirm = byRoute(summaries, "POST", "/tokens/{tokenId}/confirm");
    expect(confirm).toBeDefined();
    // json({...}) defaults to 200; json({error}, 400) carries the status.
    expect(statusCodesOf(confirm as BehavioralSummary)).toEqual([200, 400]);
    const ok = (confirm as BehavioralSummary).transitions.find(
      (t) =>
        t.output.type === "response" &&
        t.output.statusCode?.type === "literal" &&
        t.output.statusCode.value === 200,
    );
    // Body is the json() payload, not the envelope wrapper.
    expect(ok?.output.type).toBe("response");
    if (ok?.output.type === "response") {
      expect(JSON.stringify(ok.output.body)).toContain("confirmed");
    }
  });

  it("unwraps JSON.stringify in a direct envelope body", () => {
    const list = byRoute(summaries, "GET", "/widgets");
    const ok = (list as BehavioralSummary).transitions.find(
      (t) => t.output.type === "response",
    );
    expect(ok?.output.type).toBe("response");
    if (ok?.output.type === "response") {
      // Shape of `{ widgets }`, not the `JSON.stringify(...)` call text.
      expect(JSON.stringify(ok.output.body)).toContain("widgets");
      expect(JSON.stringify(ok.output.body)).not.toContain("JSON.stringify");
    }
  });

  it("emits one summary per route Event for a multi-route handler", () => {
    const get = byRoute(summaries, "GET", "/widgets/{widgetId}");
    const del = byRoute(summaries, "DELETE", "/widgets/{widgetId}");
    expect(get).toBeDefined();
    expect(del).toBeDefined();
    // Both share the same body → same status set (400 / 204 / 200).
    expect(statusCodesOf(get as BehavioralSummary)).toEqual([200, 204, 400]);
    expect(statusCodesOf(del as BehavioralSummary)).toEqual([200, 204, 400]);
  });

  it("accounts for the SQS handler as recognized-not-http", () => {
    const sqs = summaries.find((s) => {
      const meta = s.metadata?.awsLambda as
        | { recognition?: string; eventTypes?: string[] }
        | undefined;
      return meta?.recognition === "recognized-not-http";
    });
    expect(sqs).toBeDefined();
    const meta = (sqs as BehavioralSummary).metadata?.awsLambda as {
      recognition: string;
      eventTypes: string[];
    };
    expect(meta.eventTypes).toContain("SQS");
    // Not bound as an HTTP route.
    expect(restBindingOf(sqs as BehavioralSummary)).toBeNull();
  });

  it("carries the SAM function + event provenance on route units", () => {
    const confirm = byRoute(summaries, "POST", "/tokens/{tokenId}/confirm");
    const meta = (confirm as BehavioralSummary).metadata?.awsLambda as {
      functionLogicalId: string;
      handler: string;
      apiEventType: string;
    };
    expect(meta.functionLogicalId).toBe("ConfirmTokenFunction");
    expect(meta.handler).toBe("src/handlers/confirmToken.handler");
    expect(meta.apiEventType).toBe("HttpApi");
  });
});
