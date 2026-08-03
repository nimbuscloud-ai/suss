// A status written as a choice answers with both of its arms, and it
// answers the same way whether the choice sits in the call or in a
// binding the call reads.

import { describe, expect, it } from "vitest";

import { httpRouteDiscovery } from "@suss/extractor";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "../adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

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

/** Each transition as `<status> when <how many conditions>`. */
async function outcomesOf(handlerBody: string): Promise<string[]> {
  const project = createTestProject();
  project.createSourceFile(
    "src/routes.ts",
    [
      'import express from "express";',
      "const app = express();",
      'app.get("/things", (req, res) => {',
      handlerBody,
      "});",
    ].join("\n"),
  );

  const summaries = await createTypeScriptAdapter({
    project,
    frameworks: [routePack],
  }).extractAll();

  return summaries.flatMap((summary: BehavioralSummary) =>
    summary.transitions.map((transition) => {
      const status =
        transition.output.type === "response" &&
        transition.output.statusCode?.type === "literal"
          ? String(transition.output.statusCode.value)
          : "unresolved";
      return `${status} under ${transition.conditions.length}`;
    }),
  );
}

const INLINE = [
  "  const created = Boolean(req);",
  "  res.status(created ? 202 : 200).json({ ok: true });",
].join("\n");

const THROUGH_A_BINDING = [
  "  const created = Boolean(req);",
  "  const code = created ? 202 : 200;",
  "  res.status(code).json({ ok: true });",
].join("\n");

describe("a status written as a choice", () => {
  it("answers with an outcome per arm", async () => {
    expect(await outcomesOf(INLINE)).toEqual(["202 under 1", "200 under 1"]);
  });

  it("says the same thing through a binding as it does inline", async () => {
    expect(await outcomesOf(THROUGH_A_BINDING)).toEqual(
      await outcomesOf(INLINE),
    );
  });

  it("leaves a status nobody wrote as a choice alone", async () => {
    expect(await outcomesOf("  res.status(200).json({ ok: true });")).toEqual([
      "200 under 0",
    ]);
  });

  it("does not read a choice whose arms are not both numbers", async () => {
    const outcomes = await outcomesOf(
      [
        "  const created = Boolean(req);",
        "  res.status(created ? 202 : Number(req)).json({ ok: true });",
      ].join("\n"),
    );

    // Half an answer would put one status on a boundary that has two.
    expect(outcomes).toEqual(["unresolved under 0"]);
  });

  it("keeps the guards the path already carried", async () => {
    const outcomes = await outcomesOf(
      [
        "  if (!req) {",
        "    res.status(400).json({ error: 1 });",
        "    return;",
        "  }",
        "  const created = Boolean(req);",
        "  res.status(created ? 202 : 200).json({ ok: true });",
      ].join("\n"),
    );

    // Each arm carries the guard it got past as well as its own test.
    expect(outcomes).toEqual(["400 under 1", "202 under 2", "200 under 2"]);
  });
});
