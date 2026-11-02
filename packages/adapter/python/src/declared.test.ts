import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  constructedFrom,
  declaredBy,
  pack,
  sqlStatements,
  storageCalls,
} from "@suss/recognize";

import { extractPythonProject } from "./project.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { CallOps } from "@suss/extractor";
import type { PythonPack } from "./pack.js";

const SOURCE = `from kvcache import Cache
from sqldb import Pool
from clients import client

cache = Cache()
db = Pool()
TABLE = "orders"


def load(user):
    cache.get("user_online:42")
    db.query("SELECT id, email FROM users")
    db.query(f"SELECT id FROM {TABLE}")
    client.get(user)
    client.post({"strict": True, "tags": ["a"]}, False)
    unknown_call()
`;

const CACHE_CALLS = storageCalls({
  system: "redis",
  client: constructedFrom("kvcache"),
}).methods({ get: { kind: "read", selector: { at: 0 } } });

const QUERIES = sqlStatements({
  system: "postgresql",
  dialect: "postgresql",
  client: constructedFrom("sqldb"),
}).methods({ query: { statement: { at: 0 } } });

/** A hook a pack writes by hand, which reads the ops for what it records. */
function probe(seen: CallOps[]) {
  return (_call: unknown, ctx: unknown): Effect[] | null => {
    const ops = (ctx as { ops?: CallOps }).ops;
    if (ops !== undefined) {
      seen.push(ops);
    }
    return null;
  };
}

function packOf(seen: CallOps[] = []): PythonPack {
  const declared = [
    pack("cache", [CACHE_CALLS], {
      languages: ["python"],
      recognizedAs: "@suss/declared",
    }),
    pack("sql", [QUERIES], {
      languages: ["python"],
      recognizedAs: "@suss/declared",
    }),
  ];
  return {
    name: "declared",
    protocol: "in-process",
    discovery: [],
    invocationRecognizers: [
      ...declared.flatMap((one) => one.invocationRecognizers ?? []),
      probe(seen),
    ],
    accessRecognizers: declared.flatMap((one) => one.accessRecognizers ?? []),
  };
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-declared-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), SOURCE);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function summariesWith(
  packs: PythonPack[],
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: [path.join(root, "store/__init__.py")],
    roots: [root],
    packs,
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

function declaredEffects(summaries: readonly BehavioralSummary[]) {
  return summaries
    .filter((summary) => summary.identity.name === "load")
    .flatMap((summary) =>
      summary.transitions.flatMap((transition) => transition.effects),
    )
    .filter(
      (effect) =>
        effect.type === "interaction" &&
        effect.binding?.recognition === "@suss/declared",
    );
}

describe("a pack declared with @suss/recognize, run over Python", () => {
  it("records a storage call and a statement, each where it is written", async () => {
    const effects = declaredEffects(await summariesWith([packOf()]));

    expect(effects.map((effect) => effect.callee)).toEqual([
      "cache.get",
      "db.query",
      "db.query",
    ]);
    expect(effects.every((effect) => effect.location !== undefined)).toBe(true);
  });

  it("records nothing when no pack declares hooks", async () => {
    const effects = declaredEffects(await summariesWith([]));

    expect(effects).toEqual([]);
  });

  it("hands each call ops over the facts the adapter states", async () => {
    const seen: CallOps[] = [];
    await summariesWith([packOf(seen)]);
    const byCallee = new Map(seen.map((ops) => [ops.calleeText(), ops]));
    const get = byCallee.get("client.get");
    const query = [...seen].find(
      (ops) =>
        ops.calleeText() === "db.query" &&
        ops.valueAt(0)?.parts()?.[0] === "SELECT id FROM ",
    );

    expect(byCallee.get("cache.get")?.nameAt(0, "nothing")).toBe(
      "user_online:42",
    );
    expect(get?.nameAt(0, "reference")).toBe("{user}");
    expect(get?.nameAt(0, "nothing")).toBeNull();
    expect(get?.valueAt(0)?.text()).toBeNull();
    expect(get?.valueAt(0)?.asArg()).toEqual({
      kind: "identifier",
      name: "user",
    });
    // A client imported as it is counts as made by its module.
    expect(get?.receiverIsFrom(constructedFrom("clients"))).toBe(true);
    expect(get?.receiverIsFrom(constructedFrom("kvcache"))).toBe(false);
    expect(byCallee.get("unknown_call")?.method()).toBeNull();
    // Python cannot read who declared a method, so what made the receiver says.
    expect(
      byCallee.get("cache.get")?.receiverIsFrom(declaredBy("kvcache")),
    ).toBe(true);
    expect(byCallee.get("cache.get")?.receiverIsFrom(declaredBy("sqldb"))).toBe(
      false,
    );
    expect(
      byCallee
        .get("cache.get")
        ?.anchorCall?.(constructedFrom("kvcache"))
        ?.calleeText(),
    ).toBe("Cache");
    const options = byCallee.get("client.post")?.valueAt(0);
    expect(options?.entries("nothing").map((entry) => entry.key)).toEqual([
      "strict",
      "tags",
    ]);
    expect(options?.property("strict")?.flag()).toBe(true);
    expect(byCallee.get("client.post")?.valueAt(1)?.flag()).toBe(false);
    expect(
      options
        ?.property("tags")
        ?.items()
        .map((item) => item.text()),
    ).toEqual(["a"]);
    expect(options?.items()).toEqual([]);
    expect(query?.valueAt(0)?.interpolated?.()[0]?.name("nothing")).toBe(
      "orders",
    );
  });
});
