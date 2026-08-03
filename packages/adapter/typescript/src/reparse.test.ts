// What the adapter says about a file has to depend on the file, not on
// what the file used to say. A cache that outlives a parse breaks that,
// and the failure is quiet: ts-morph keeps the source-file wrapper and
// forgets the nodes under it, so a stale entry hands back nodes that
// answer for text nobody has.

import { describe, expect, it } from "vitest";

import { httpRouteDiscovery } from "@suss/extractor";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { Project } from "ts-morph";

const routePack: PatternPack = {
  name: "express",
  protocol: "http",
  languages: ["typescript"],
  discovery: httpRouteDiscovery({
    importModule: "express",
    importNames: ["express"],
    methods: [".get", ".post"],
  }),
  terminals: [
    {
      kind: "response",
      match: {
        type: "parameterMethodCall",
        parameterPosition: 1,
        methodChain: ["status", "json"],
      },
      extraction: {
        statusCode: { from: "argument", position: 0 },
        body: { from: "argument", position: 0 },
      },
    },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [
      { position: 0, role: "request" },
      { position: 1, role: "response" },
    ],
  },
};

const FIRST = `
import express from "express";
const app = express();
app.get("/users", (req, res) => {
  res.status(200).json({ ok: true });
});
`;

const SECOND = `
import express from "express";
const app = express();
app.post("/orders", (req, res) => {
  res.status(201).json({ id: 1 });
});
`;

// A handler reached through another module, so the second read goes back
// through import resolution and the fact store rather than answering off
// one file's syntax.
const handlersHolding = (status: number): string => `
export const list = (req: unknown, res: {
  status: (n: number) => { json: (b: unknown) => void };
}) => {
  res.status(${status}).json({ ok: true });
};
`;

const ROUTER = `
import express from "express";
import { list } from "./handlers.js";
const app = express();
app.get("/things", list);
`;

function adapterFor(project: Project) {
  return createTypeScriptAdapter({ project, frameworks: [routePack] });
}

async function readOneFile(
  project: Project,
  source: string,
): Promise<BehavioralSummary[]> {
  project.createSourceFile("src/routes.ts", source, { overwrite: true });
  return await adapterFor(project).extractAll();
}

async function readAcrossModules(
  project: Project,
  handlers: string,
): Promise<BehavioralSummary[]> {
  project.createSourceFile("src/handlers.ts", handlers, { overwrite: true });
  project.createSourceFile("src/router.ts", ROUTER, { overwrite: true });
  return await adapterFor(project).extractAll();
}

function routesOf(summaries: BehavioralSummary[]): string[] {
  return summaries
    .map((summary) => {
      const semantics = summary.identity.boundaryBinding?.semantics;
      return semantics?.name === "rest"
        ? `${semantics.method} ${semantics.path}`
        : "no route";
    })
    .sort();
}

function statusesOf(summaries: BehavioralSummary[]): string[] {
  return summaries
    .flatMap((summary) =>
      summary.transitions.flatMap((transition) =>
        transition.output.type === "response" &&
        transition.output.statusCode !== null
          ? [JSON.stringify(transition.output.statusCode)]
          : [],
      ),
    )
    .sort();
}

describe("a file read twice", () => {
  it("says what the second read holds, not the first", async () => {
    const reused = createTestProject();
    await readOneFile(reused, FIRST);
    const second = await readOneFile(reused, SECOND);

    expect(routesOf(second)).toEqual(["POST /orders"]);
    expect(routesOf(second)).toEqual(
      routesOf(await readOneFile(createTestProject(), SECOND)),
    );
  });

  it("goes back to what the first read held", async () => {
    const reused = createTestProject();
    const first = await readOneFile(reused, FIRST);
    await readOneFile(reused, SECOND);
    const again = await readOneFile(reused, FIRST);

    expect(routesOf(again)).toEqual(["GET /users"]);
    expect(routesOf(again)).toEqual(routesOf(first));
  });

  it("reads the handler a changed module now exports", async () => {
    const reused = createTestProject();
    await readAcrossModules(reused, handlersHolding(200));
    const second = await readAcrossModules(reused, handlersHolding(503));

    expect(statusesOf(second).join()).toContain("503");
    expect(statusesOf(second)).toEqual(
      statusesOf(
        await readAcrossModules(createTestProject(), handlersHolding(503)),
      ),
    );
  });
});
