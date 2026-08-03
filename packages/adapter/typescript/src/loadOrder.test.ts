// The same source has to produce the same summaries however the files
// reached the project. Order is the one input a caller does not think
// they are giving us: a glob walks a directory in whatever order the
// file system hands back, and two machines can disagree about that.

import { describe, expect, it } from "vitest";

import { httpRouteDiscovery } from "@suss/extractor";
import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

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

// Two modules each declare a type called Account, and the routes reach
// them through a shared re-export. Whichever of the two the walk sees
// first used to be the one a later reader got.
const FILES: Array<[string, string]> = [
  [
    "src/billing/account.ts",
    "export interface Account { plan: string; child: Account }\n",
  ],
  [
    "src/auth/account.ts",
    "export interface Account { token: string; child: Account }\n",
  ],
  [
    "src/billing/routes.ts",
    [
      'import express from "express";',
      'import type { Account } from "./account.js";',
      "const app = express();",
      'app.get("/billing", (req, res) => {',
      "  const found: Account = req as unknown as Account;",
      "  res.status(200).json(found);",
      "});",
    ].join("\n"),
  ],
  [
    "src/auth/routes.ts",
    [
      'import express from "express";',
      'import type { Account } from "./account.js";',
      "const app = express();",
      'app.get("/auth", (req, res) => {',
      "  const found: Account = req as unknown as Account;",
      "  res.status(200).json(found);",
      "});",
    ].join("\n"),
  ],
];

async function summariesFrom(
  order: ReadonlyArray<[string, string]>,
): Promise<string> {
  const project = createTestProject();
  for (const [file, source] of order) {
    project.createSourceFile(file, source);
  }
  const summaries = await createTypeScriptAdapter({
    project,
    frameworks: [routePack],
  }).extractAll();

  return JSON.stringify(
    [...summaries].sort(comparingName).map(withoutAbsolutePaths),
    null,
    1,
  );
}

const comparingName = (a: BehavioralSummary, b: BehavioralSummary): number =>
  a.identity.name.localeCompare(b.identity.name);

/**
 * The same summary read on two machines differs in one way that says
 * nothing: where the checkout sits. Everything else has to match.
 */
function withoutAbsolutePaths(summary: BehavioralSummary): unknown {
  return JSON.parse(
    JSON.stringify(summary).replaceAll(/"[^"]*\/src\//g, '"src/'),
  );
}

describe("summaries", () => {
  it("do not depend on the order the files arrived in", async () => {
    const forwards = await summariesFrom(FILES);
    const backwards = await summariesFrom([...FILES].reverse());

    expect(backwards).toBe(forwards);
  });

  it("do not depend on which module was read first", async () => {
    const forwards = await summariesFrom(FILES);
    const interleaved = await summariesFrom([
      FILES[2] as [string, string],
      FILES[1] as [string, string],
      FILES[3] as [string, string],
      FILES[0] as [string, string],
    ]);

    expect(interleaved).toBe(forwards);
  });
});
