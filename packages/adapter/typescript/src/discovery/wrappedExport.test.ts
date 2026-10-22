/**
 * A route export written as a call: which function becomes the handler,
 * and which layers the summary records around it.
 */

import { describe, expect, it } from "vitest";

import { readWrapperMetadata } from "@suss/behavioral-ir";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

const routePack: PatternPack = {
  name: "route-test",
  protocol: "http",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: {
        type: "fileConvention",
        filePattern: "**/app/**/route.ts",
        exportNames: ["GET", "POST"],
      },
      bindingExtraction: {
        method: { type: "fromExportName" },
        path: { type: "fromFilename", root: "app", dropBasenames: ["route"] },
      },
    },
  ],
  terminals: [
    {
      kind: "response",
      match: { type: "functionCall", functionName: "Response" },
      extraction: {
        statusCode: { from: "argumentProperty", position: 1, name: "status" },
        defaultStatusCode: 200,
      },
    },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

async function summariesOf(
  files: Record<string, string>,
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  const adapter = createTypeScriptAdapter({ project, frameworks: [routePack] });
  return adapter.extractAll();
}

function routeAt(
  summaries: readonly BehavioralSummary[],
  method: string,
  path: string,
): BehavioralSummary {
  const found = summaries.find((summary) => {
    const semantics = summary.identity.boundaryBinding?.semantics;
    return (
      semantics?.name === "rest" &&
      semantics.method === method &&
      semantics.path === path
    );
  });
  expect(found, `${method} ${path}`).toBeDefined();
  return found as BehavioralSummary;
}

function statusesOf(summary: BehavioralSummary): number[] {
  return summary.transitions.flatMap((transition) =>
    transition.output.type === "response" &&
    transition.output.statusCode?.type === "literal" &&
    typeof transition.output.statusCode.value === "number"
      ? [transition.output.statusCode.value]
      : [],
  );
}

function wrapperNamesOf(summary: BehavioralSummary): string[] {
  return (readWrapperMetadata(summary)?.applied ?? []).map(
    (reference) => reference.name,
  );
}

const AXIOM = `
import { createAxiomRouteHandler } from "@axiomhq/nextjs";
declare const logger: unknown;
export const withAxiom = createAxiomRouteHandler(logger);
`;

describe("a route export written as a call", () => {
  it("reads the function a library-made wrapper is given as the handler", async () => {
    const summaries = await summariesOf({
      "/src/lib/axiom.ts": AXIOM,
      "/src/app/health/route.ts": `
import { withAxiom } from "../../lib/axiom";
export const GET = withAxiom(async (req: Request) => {
  if (req.url === "") {
    return new Response("missing", { status: 400 });
  }
  return new Response("ok", { status: 200 });
});`,
    });

    const route = routeAt(summaries, "GET", "/health");
    expect(statusesOf(route)).toEqual([400, 200]);
    expect(readWrapperMetadata(route)?.applied).toEqual([
      { file: "/src/lib/axiom.ts", name: "withAxiom" },
    ]);
  });

  it("reads a wrapped handler an export list gives under two names", async () => {
    const summaries = await summariesOf({
      "/src/lib/axiom.ts": AXIOM,
      "/src/app/queue/route.ts": `
import { withAxiom } from "../../lib/axiom";
const handler = withAxiom(async () => new Response("queued", { status: 202 }));
export { handler as GET, handler as POST };`,
    });

    for (const method of ["GET", "POST"]) {
      const route = routeAt(summaries, method, "/queue");
      expect(statusesOf(route)).toEqual([202]);
      expect(wrapperNamesOf(route)).toEqual(["withAxiom"]);
    }
  });

  it("names a wrapper from a package the run has no source for by its module", async () => {
    const summaries = await summariesOf({
      "/src/app/health/route.ts": `
import { withSentry } from "@sentry/nextjs";
export const GET = withSentry(async () => new Response("ok", { status: 200 }));`,
    });

    expect(
      readWrapperMetadata(routeAt(summaries, "GET", "/health"))?.applied,
    ).toEqual([{ file: "@sentry/nextjs", name: "withSentry" }]);
  });

  it("folds a project factory's own checks into the route, inside the library wrapper it hands back", async () => {
    const summaries = await summariesOf({
      "/src/lib/axiom.ts": AXIOM,
      "/src/lib/workspace.ts": `
import { withAxiom } from "./axiom";
declare function getSession(): Promise<{ id: string } | null>;
type Handler = (ctx: { req: Request; userId: string }) => Promise<Response>;
export const withWorkspace = (handler: Handler) => {
  return withAxiom(async (req: Request) => {
    const session = await getSession();
    if (session === null) {
      return new Response("unauthorized", { status: 401 });
    }
    return handler({ req, userId: session.id });
  });
};`,
      "/src/app/links/route.ts": `
import { withWorkspace } from "../../lib/workspace";
export const GET = withWorkspace(async ({ userId }) => {
  if (userId === "") {
    return new Response("gone", { status: 404 });
  }
  return new Response("links", { status: 200 });
});
export const POST = withWorkspace(async () => new Response("made", { status: 201 }));`,
    });

    expect(wrapperNamesOf(routeAt(summaries, "GET", "/links"))).toEqual([
      "withAxiom",
      "withWorkspace(handler)",
    ]);
    expect(statusesOf(routeAt(summaries, "GET", "/links"))).toEqual([
      401, 404, 200,
    ]);
    expect(statusesOf(routeAt(summaries, "POST", "/links"))).toEqual([
      401, 201,
    ]);
    expect(
      summaries.filter((s) => s.identity.name === "withWorkspace(handler)"),
    ).toHaveLength(1);
  });

  it("records a closure that keeps going after the handler returns as a layer it did not read", async () => {
    const summaries = await summariesOf({
      "/src/lib/logged.ts": `
declare function log(res: Response): void;
export const withLogging =
  (handler: (req: Request) => Promise<Response>) =>
  async (req: Request) => {
    const res = await handler(req);
    log(res);
    if (res.status >= 500) {
      return new Response("hidden", { status: 502 });
    }
    return res;
  };`,
      "/src/app/stats/route.ts": `
import { withLogging } from "../../lib/logged";
export const GET = withLogging(async () => new Response("stats", { status: 200 }));`,
    });

    const route = routeAt(summaries, "GET", "/stats");
    expect(readWrapperMetadata(route)?.applied).toEqual([
      { file: "/src/lib/logged.ts", name: "withLogging(handler)" },
    ]);
    expect(statusesOf(route)).toEqual([200]);
    expect(
      summaries.some((s) => s.identity.name === "withLogging(handler)"),
    ).toBe(false);
  });

  it("records a closure that reads the factory's options as a layer it did not read", async () => {
    const summaries = await summariesOf({
      "/src/lib/admin.ts": `
declare function role(): Promise<string>;
export const withAdmin =
  (
    handler: (req: Request) => Promise<Response>,
    { requiredRoles = [] }: { requiredRoles?: string[] } = {},
  ) =>
  async (req: Request) => {
    if (requiredRoles.length > 0 && !requiredRoles.includes(await role())) {
      return new Response("forbidden", { status: 403 });
    }
    return handler(req);
  };`,
      "/src/app/stats/route.ts": `
import { withAdmin } from "../../lib/admin";
export const GET = withAdmin(async () => new Response("stats", { status: 200 }));`,
    });

    const route = routeAt(summaries, "GET", "/stats");
    expect(wrapperNamesOf(route)).toEqual(["withAdmin(handler)"]);
    expect(statusesOf(route)).toEqual([200]);
  });

  it("folds the closure a project factory returns into the route", async () => {
    const summaries = await summariesOf({
      "/src/lib/admin.ts": `
declare function isAdmin(): Promise<boolean>;
export const withAdmin =
  (handler: (req: Request) => Promise<Response>) =>
  async (req: Request) => {
    if (!(await isAdmin())) {
      return new Response("forbidden", { status: 403 });
    }
    return handler(req);
  };`,
      "/src/app/stats/route.ts": `
import { withAdmin } from "../../lib/admin";
export const GET = withAdmin(async () => new Response("stats", { status: 200 }));`,
    });

    const route = routeAt(summaries, "GET", "/stats");
    expect(wrapperNamesOf(route)).toEqual(["withAdmin(handler)"]);
    expect(statusesOf(route)).toEqual([403, 200]);
  });
});
