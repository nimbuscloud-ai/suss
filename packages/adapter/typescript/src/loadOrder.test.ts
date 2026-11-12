/**
 * The same source has to produce the same summaries however the files
 * got into the project. File order is one input a caller does not
 * realise they are giving us: a glob walks a directory in whatever order
 * the file system returns, and two machines can disagree about that.
 * The other packs in the run are another, since every pack's questions
 * leave facts in the store the next pack's questions read.
 */

import { describe, expect, it } from "vitest";

import { httpRouteDiscovery } from "@suss/extractor";
import { global } from "@suss/recognize";
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
// them through a shared re-export. Whichever one the walk saw first used
// to be the one every later reader ended up with.
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
 * The same summary read on two machines differs in exactly one way that
 * does not matter: where the checkout is. Everything else has to match.
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

// The menu's only caller is a function nothing exports, run from a block
// at the top of its file. The comment is what sends the listener pack
// through the module's calls, though it does not find a listener there.
const MENU_FILES: Array<[string, string]> = [
  [
    "src/menu.ts",
    [
      "export interface MenuActions { openApp: () => void }",
      "export function buildMenu(actions: MenuActions) {",
      '  return [{ label: "Open", click: () => actions.openApp() }];',
      "}",
    ].join("\n"),
  ],
  [
    "src/main.ts",
    [
      'import { buildMenu } from "./menu";',
      'const showApp = () => { console.log("shown"); };',
      "const refreshMenu = () => buildMenu({ openApp: showApp });",
      "if (process.argv.length > 2) {",
      "  setTimeout(() => refreshMenu(), 0);",
      "}",
      "// The tray is rebuilt by refreshMenu, not by an addEventListener call.",
    ].join("\n"),
  ],
];

const menuPack: PatternPack = {
  name: "menu",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: { type: "namedExport", names: ["buildMenu"] },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const listenerPack: PatternPack = {
  name: "listener",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    {
      kind: "handler",
      match: {
        type: "registeredFunction",
        start: global("addEventListener"),
        handler: { at: 1 },
      },
    },
  ],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
};

async function menuSummaries(
  frameworks: PatternPack[],
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [file, source] of MENU_FILES) {
    project.createSourceFile(file, source);
  }
  const summaries = await createTypeScriptAdapter({
    project,
    frameworks,
  }).extractAll();
  return [...summaries].sort(comparingName);
}

describe("a value a caller passed", () => {
  it("is the same whether or not another pack read the caller's file first", async () => {
    const alone = await menuSummaries([menuPack]);
    const besideAReader = await menuSummaries([menuPack, listenerPack]);

    expect(JSON.stringify(besideAReader.map(withoutAbsolutePaths))).toBe(
      JSON.stringify(alone.map(withoutAbsolutePaths)),
    );
  });

  it("is followed to the function the caller passed", async () => {
    const summaries = await menuSummaries([menuPack]);
    const showApp = summaries.find(
      (summary) => summary.identity.name === "showApp",
    );
    const openApp = summaries
      .find((summary) => summary.identity.name === "buildMenu")
      ?.transitions.flatMap((transition) => transition.effects)
      .find(
        (effect) =>
          effect.type === "invocation" && effect.callee === "actions.openApp",
      );

    expect(showApp?.kind).toBe("library");
    expect(openApp?.type === "invocation" ? openApp.summary : null).toBe(
      showApp?.identity.id,
    );
  });
});
