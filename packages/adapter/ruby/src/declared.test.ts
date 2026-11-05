import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  constructedFrom,
  declaredBy,
  imported,
  pack,
  sqlStatements,
  storageCalls,
  typed,
} from "@suss/recognize";

import { extractRubyProject } from "./project.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { CallOps, ExtractionReport } from "@suss/extractor";
import type { RubyPack } from "./pack.js";

const SOURCE = `module Store
  TABLE = "orders"

  def self.load(user)
    cache = Kvcache::Cache.new
    db = ::Sqldb::Pool.new
    cache.get("user_online:42")
    db.query("SELECT id, email FROM users")
    db.query("SELECT id FROM #{TABLE}")
    Clients::Http.get(user)
    cache.post({ strict: true, tags: ["a"] }, false)
  end
end
`;

const CACHE_CALLS = storageCalls({
  system: "redis",
  client: constructedFrom("Kvcache"),
}).methods({ get: { kind: "read", selector: { at: 0 } } });

const QUERIES = sqlStatements({
  system: "postgresql",
  dialect: "postgresql",
  client: constructedFrom("Sqldb"),
}).methods({ query: { statement: { at: 0 } } });

/** A hook a pack writes by hand, which keeps the ops each call is handed. */
function probe(seen: CallOps[]) {
  return (_call: unknown, ctx: unknown): Effect[] | null => {
    const ops = (ctx as { ops?: CallOps }).ops;
    if (ops !== undefined) {
      seen.push(ops);
    }
    return null;
  };
}

function packOf(seen: CallOps[] = []): RubyPack {
  const declared = [
    pack("cache", [CACHE_CALLS], {
      languages: ["ruby"],
      recognizedAs: "@suss/declared",
    }),
    pack("sql", [QUERIES], {
      languages: ["ruby"],
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
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-declared-")),
  );
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), SOURCE);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function summariesWith(
  packs: RubyPack[],
  onExtractionReport?: (report: ExtractionReport) => void,
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: [path.join(root, "lib/store.rb")],
    packs,
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
    ...(onExtractionReport === undefined ? {} : { onExtractionReport }),
  });
  return summaries;
}

type Interaction = Extract<Effect, { type: "interaction" }>;

function declaredEffects(
  summaries: readonly BehavioralSummary[],
): Interaction[] {
  return summaries
    .flatMap((summary) =>
      summary.transitions.flatMap((transition) => transition.effects),
    )
    .filter(
      (effect): effect is Interaction =>
        effect.type === "interaction" &&
        effect.binding?.recognition === "@suss/declared",
    );
}

describe("a pack declared with @suss/recognize, run over Ruby", () => {
  it("records a storage call and two statements, each where it is written", async () => {
    const effects = declaredEffects(await summariesWith([packOf()]));

    expect(effects.map((effect) => effect.callee)).toEqual([
      "cache.get",
      "db.query",
      "db.query",
    ]);
    expect(effects.every((effect) => effect.location !== undefined)).toBe(true);
  });

  it("hands each call ops over the facts the adapter states", async () => {
    const seen: CallOps[] = [];
    await summariesWith([packOf(seen)]);
    const byCallee = new Map(seen.map((ops) => [ops.calleeText(), ops]));
    const get = byCallee.get("Clients::Http.get");
    const posted = byCallee.get("cache.post");
    const options = posted?.valueAt(0);

    expect(byCallee.get("cache.get")?.method()).toBe("get");
    expect(get?.method()).toBe("get");
    expect(get?.nameAt(0, "reference")).toBe("{user}");
    expect(get?.valueAt(0)?.asArg()).toEqual({
      kind: "identifier",
      name: "user",
    });
    expect(get?.valueAt(0)?.text()).toBeNull();
    expect(get?.isFrom(constructedFrom("Clients"))).toBe(true);
    expect(get?.isFrom(constructedFrom("Client"))).toBe(false);
    expect(
      get?.receiverIsFrom(imported({ from: ["Clients"], named: ["Http"] })),
    ).toBe(true);
    expect(
      get?.receiverIsFrom(imported({ from: ["Clients::Http"], named: ["*"] })),
    ).toBe(true);
    expect(get?.receiverIsFrom(imported({ from: ["Http"] }))).toBe(false);
    expect(get?.namedCallee?.()).toBe(false);
    expect(
      byCallee
        .get("cache.get")
        ?.receiverIsFrom(typed({ from: ["Kvcache"], named: ["Cache"] })),
    ).toBe(true);
    expect(
      byCallee
        .get("cache.get")
        ?.receiverIsFrom(imported({ from: ["Kvcache"] })),
    ).toBe(false);
    expect(
      byCallee.get("cache.get")?.receiverIsFrom(declaredBy("Kvcache")),
    ).toBe(true);
    expect(
      byCallee.get("db.query")?.receiverIsFrom(constructedFrom("Sqldb")),
    ).toBe(true);
    expect(options?.entries("nothing").map((entry) => entry.key)).toEqual([
      "strict",
      "tags",
    ]);
    expect(options?.property("strict")?.flag()).toBe(true);
    expect(posted?.valueAt(1)?.flag()).toBe(false);
    expect(
      options
        ?.property("tags")
        ?.items()
        .map((item) => item.text()),
    ).toEqual(["a"]);
  });
});

describe("a declared pack whose recognizer throws", () => {
  it("goes on the pack's tally, and the other packs' effects are still there", async () => {
    const breaks: RubyPack = {
      name: "breaks",
      protocol: "in-process",
      discovery: [],
      invocationRecognizers: [
        () => {
          throw new Error("cannot read what I was handed");
        },
      ],
    };
    const reports: ExtractionReport[] = [];
    const noise = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let summaries: BehavioralSummary[];
    try {
      summaries = await summariesWith([breaks, packOf()], (report) =>
        reports.push(report),
      );
    } finally {
      noise.mockRestore();
    }

    expect(declaredEffects(summaries).map((effect) => effect.callee)).toEqual([
      "cache.get",
      "db.query",
      "db.query",
    ]);
    const failures =
      reports[0]?.packs.find((funnel) => funnel.pack === "breaks")?.failures ??
      [];
    expect(failures).toContainEqual({
      hook: "invocationRecognizers",
      file: path.join(root, "lib/store.rb"),
      line: 7,
      message: "cannot read what I was handed",
    });
    expect(
      reports[0]?.packs.find((funnel) => funnel.pack === "declared")?.failures,
    ).toEqual([]);
  });
});
