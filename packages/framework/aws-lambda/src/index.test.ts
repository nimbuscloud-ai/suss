import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { testCompilerOptions } from "@suss/test-project";

import { awsLambdaFramework, clearTemplateCache } from "./index.js";
import { HTTP_TERMINALS, NON_HTTP_TERMINALS } from "./terminals.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";
import type { AwsLambdaPackOptions } from "./index.js";

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/aws-lambda");

// The fixture handlers are built by a factory the fixture project owns.
// Nothing names it: the adapter reads whatever call built the export,
// and the project says only which property carries the subject.
const FIXTURE_SUBJECT_FACTORIES = [{ property: "subject" }];

async function runAdapter(
  options: AwsLambdaPackOptions = {
    subjectFactories: FIXTURE_SUBJECT_FACTORIES,
  },
): Promise<BehavioralSummary[]> {
  clearTemplateCache();
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { ...testCompilerOptions },
  });
  // The whole src tree: handlers plus the lib/ factory a handler
  // export resolves through.
  project.addSourceFilesAtPaths(path.join(fixturesDir, "src/**/*.ts"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [awsLambdaFramework(options)],
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

function byEventType(
  summaries: BehavioralSummary[],
  eventType: string,
): BehavioralSummary | undefined {
  return summaries.find((s) => {
    const meta = s.metadata?.awsLambda as
      | { recognition?: string; eventTypes?: string[] }
      | undefined;
    return (
      meta?.recognition === "recognized-not-http" &&
      (meta.eventTypes ?? []).includes(eventType)
    );
  });
}

function byFunction(
  summaries: BehavioralSummary[],
  logicalId: string,
): BehavioralSummary | undefined {
  return summaries.find(
    (s) => s.identity.deployableUnit?.instanceName === logicalId,
  );
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
    // No import gate on purpose. Only a TypeScript handler imports the
    // handler types, to annotate its export, so gating on that import
    // hid every JavaScript service. The template names the handlers, so
    // it decides which files are candidates.
    expect(pack.requiresImport).toBeUndefined();
  });

  it("declares the envelope shape and names no helper", () => {
    const pack = awsLambdaFramework();

    // A service names its own response helper, so this pack must not.
    // The adapter follows a returned call into the project and applies
    // the envelope declaration below to whatever it finds, which works
    // for `json`, `respond`, and any argument order.
    const named = pack.terminals.filter((t) => t.match.type === "functionCall");
    expect(named).toEqual([]);

    const envelope = pack.terminals.find((t) => t.match.type === "returnShape");
    expect(envelope?.extraction.body).toEqual({
      from: "property",
      name: "body",
      unwrapJsonStringify: true,
    });
  });

  it("lets a non-HTTP handler fall off the end, and holds a route to the envelope", () => {
    // A queue consumer acks by not throwing, so falling through is a
    // terminal there. An HTTP route that answers nothing is a bug, so
    // the route list must not gain the same terminal.
    const fallthroughOf = (terminals: typeof HTTP_TERMINALS) =>
      terminals.filter((t) => t.match.type === "functionFallthrough");
    expect(fallthroughOf(NON_HTTP_TERMINALS)).toHaveLength(1);
    expect(fallthroughOf(HTTP_TERMINALS)).toEqual([]);
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
    const responses = (list as BehavioralSummary).transitions.filter(
      (t) => t.output.type === "response",
    );
    // The handler casts its envelope, and a cast around the returned
    // object used to produce a second, identical response.
    expect(responses).toHaveLength(1);
    const ok = responses[0];
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
    const sqs = byFunction(summaries, "QueueWorkerFunction");
    expect(sqs).toBeDefined();
    const meta = (sqs as BehavioralSummary).metadata?.awsLambda as {
      recognition: string;
      eventTypes: string[];
    };
    expect(meta.eventTypes).toContain("SQS");
    // Not bound as an HTTP route.
    expect(restBindingOf(sqs as BehavioralSummary)).toBeNull();
  });

  it("reads the summary object a scheduled job returns", () => {
    const scheduled = byEventType(summaries, "Schedule");
    expect(scheduled).toBeDefined();
    const returns = (scheduled as BehavioralSummary).transitions.filter(
      (t) => t.output.type === "return",
    );
    // The job writes `satisfies` on the object it returns, and that
    // wrapper used to make the same return count twice.
    expect(returns).toHaveLength(1);
    const body = JSON.stringify(returns[0].output);
    expect(body).toContain("requestId");
    expect(body).toContain("success");
    // The return was read, so no unread-return gap and no low confidence.
    expect((scheduled as BehavioralSummary).gaps).toEqual([]);
    expect((scheduled as BehavioralSummary).confidence.level).not.toBe("low");
  });

  it("keeps the SQS consumer's batch-failure return under the wider list", () => {
    const sqs = byFunction(
      summaries,
      "QueueWorkerFunction",
    ) as BehavioralSummary;
    const returns = sqs.transitions.filter((t) => t.output.type === "return");
    // The named batchItemFailures shape matches first; the unqualified
    // return terminal adds nothing on top of it.
    expect(returns).toHaveLength(1);
    expect(sqs.gaps).toEqual([]);
  });

  // Pinned: an earlier pack-wide catch-all return terminal fired on the
  // return statement wrapping a ternary as well as on each envelope
  // inside it, so an HTTP handler picked up a phantom third transition.
  // The wider list is per non-HTTP unit now; route units must not see it.
  it("gives a ternary envelope return exactly two response transitions", () => {
    const toggle = byRoute(summaries, "POST", "/flags/toggle");
    expect(toggle).toBeDefined();
    const responses = (toggle as BehavioralSummary).transitions.filter(
      (t) => t.output.type === "response",
    );
    expect(responses).toHaveLength(2);
    expect(statusCodesOf(toggle as BehavioralSummary)).toEqual([200, 400]);
    const returns = (toggle as BehavioralSummary).transitions.filter(
      (t) => t.output.type === "return",
    );
    expect(returns).toHaveLength(0);
  });

  // Pinned: the same catch-all also swallowed the unread-return signal,
  // replacing the gap with a return transition nothing reads. An HTTP
  // handler whose return the pack cannot read has to keep saying so.
  it("keeps the unread-return gap on an HTTP handler returning a variable", () => {
    const mirror = byRoute(summaries, "GET", "/mirror");
    expect(mirror).toBeDefined();
    const gaps = (mirror as BehavioralSummary).gaps.filter(
      (g) => g.type === "unreadOutcome",
    );
    expect(gaps).toHaveLength(1);
    expect((mirror as BehavioralSummary).confidence.level).toBe("low");
    const returns = (mirror as BehavioralSummary).transitions.filter(
      (t) => t.output.type === "return",
    );
    expect(returns).toHaveLength(0);
  });

  it("carries the SAM function + event provenance on route units", () => {
    const confirm = byRoute(
      summaries,
      "POST",
      "/tokens/{tokenId}/confirm",
    ) as BehavioralSummary;
    expect(confirm.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "ConfirmTokenFunction",
    });
    const meta = confirm.metadata?.awsLambda as {
      handler: string;
      apiEventType: string;
    };
    expect(meta.handler).toBe("src/handlers/confirmToken.handler");
    expect(meta.apiEventType).toBe("HttpApi");
  });

  it("binds a factory-built SQS consumer to the subject its config names", () => {
    const worker = byFunction(summaries, "SubjectWorkerFunction");
    expect(worker).toBeDefined();
    const binding = (worker as BehavioralSummary).identity
      .boundaryBinding as BoundaryBinding;
    expect(binding.semantics.name).toBe("message-bus");
    if (binding.semantics.name === "message-bus") {
      expect(binding.semantics.messageBus).toBe("sqs");
      expect(binding.semantics.channel).toBe("billing.invoicePaid");
    }
    expect(binding.transport).toBe("sqs");
    expect(binding.recognition).toBe("aws-lambda");
    // Still a recognized-not-http accounting unit underneath.
    const meta = (worker as BehavioralSummary).metadata?.awsLambda as {
      recognition: string;
      eventTypes: string[];
    };
    expect(meta.recognition).toBe("recognized-not-http");
    expect(meta.eventTypes).toContain("SQS");
  });

  it("attaches no channel when the factory subject is computed", () => {
    const computed = byFunction(summaries, "ComputedSubjectFunction");
    expect(computed).toBeDefined();
    const binding = (computed as BehavioralSummary).identity.boundaryBinding;
    expect(binding?.semantics.name).not.toBe("message-bus");
  });

  it("attaches no channel until the project names its factory", async () => {
    const defaults = await runAdapter({});
    const worker = byFunction(defaults, "SubjectWorkerFunction");
    expect(worker).toBeDefined();
    const binding = (worker as BehavioralSummary).identity.boundaryBinding;
    expect(binding?.semantics.name).toBe("function-call");
  });
});
