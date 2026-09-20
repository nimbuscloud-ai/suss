/**
 * How often discovery puts a question to the resolution rules.
 *
 * The rules run over the whole project's facts, so what a question costs
 * does not depend on how many keys it asks about. A file with three client
 * calls on three receivers has to settle all three in one question; one
 * question per call site is what made a large project slow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "@suss/datalog";

import { discoverUnits } from "./discovery.js";
import { emitValueFacts } from "./facts/values.js";
import { emitModuleImportFacts } from "./facts.js";
import { parsePython } from "./parser.js";
import { bindModule } from "./scope.js";
import { bindEvaluator } from "./values/evaluator.js";

import type { PyClientCall, PythonPack } from "./pack.js";

const asked: string[][] = [];

vi.mock("@suss/resolution", async (importOriginal) => {
  const original = await importOriginal<typeof import("@suss/resolution")>();
  return {
    ...original,
    askResolution: (
      db: Parameters<typeof original.askResolution>[0],
      keys: Iterable<string>,
      ...rest: unknown[]
    ) => {
      const listed = [...keys];
      asked.push(listed);
      return (
        original.askResolution as (
          ...args: [typeof db, string[], ...unknown[]]
        ) => void
      )(db, listed, ...rest);
    },
  };
});

const REQUEST_CALLS: PyClientCall = {
  type: "clientCall",
  importModule: ["httpclient"],
  verbAttributeNames: { get: "GET" },
  url: { position: 0, keyword: "url" },
  receiverConstructors: ["Session"],
};

const PACK: PythonPack = {
  name: "httpclient",
  protocol: "http",
  discovery: [],
  clients: [REQUEST_CALLS],
};

const FILE = "app/orders.py";

const SOURCE = [
  "import httpclient",
  "",
  "",
  "def load_orders():",
  "    orders = httpclient.Session()",
  '    return orders.get("/orders")',
  "",
  "",
  "def load_carts():",
  "    carts = httpclient.Session()",
  '    return carts.get("/carts")',
  "",
  "",
  "def load_tags():",
  "    tags = httpclient.Session()",
  '    return tags.get("/tags")',
  "",
].join("\n");

async function discover() {
  const tree = await parsePython(SOURCE);
  const binding = bindModule(tree.rootNode);
  const db = new Database();
  emitModuleImportFacts(db, FILE, binding, { roots: [] });
  emitValueFacts(db, FILE, tree.rootNode);
  bindEvaluator(db, {
    files: [{ file: FILE, root: tree.rootNode, module: binding }],
    definitions: new Map(),
  });
  return discoverUnits(tree.rootNode, binding, {
    packs: [PACK],
    filePath: FILE,
    facts: db,
  });
}

describe("discovery over a file with three client calls", () => {
  beforeEach(() => {
    asked.length = 0;
  });

  it("asks about all three receivers in one question", async () => {
    const units = await discover();
    expect(units.map((unit) => unit.identity.name)).toEqual([
      "load_orders",
      "load_carts",
      "load_tags",
    ]);

    const first = asked[0] ?? [];
    expect(
      ["orders", "carts", "tags"].filter((name) =>
        first.some((key) => key.endsWith(`#${name}`)),
      ),
    ).toEqual(["orders", "carts", "tags"]);
  });

  it("asks nothing per call site that the one question did not settle", async () => {
    await discover();
    const [first = [], ...rest] = asked;
    const settled = new Set(first);
    const perSite = rest
      .flat()
      .filter((key) => !settled.has(key) && /#(orders|carts|tags)$/.test(key));
    expect(perSite).toEqual([]);
  });
});
