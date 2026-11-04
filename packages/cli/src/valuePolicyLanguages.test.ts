/**
 * The value policy of the ops over the facts, on the same cases written
 * in TypeScript, Python and Ruby. One declared pack reads every entry
 * and item of a payload at any depth, and each case says which paths it
 * has to find. A case that reads nothing says so, so a change that
 * starts to read one shows up here. recognize's DESIGN.md, under "The
 * value policy", says why each case reads the way it does.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Node } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPythonProject } from "@suss/adapter-python";
import { extractRubyProject } from "@suss/adapter-ruby";
import {
  invocationContextFor,
  ResolutionStore,
} from "@suss/adapter-typescript";
import { constructedFrom, pack, storageCalls } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { ValueOps } from "@suss/extractor";
import type { InputRule } from "@suss/recognize";

/** Every key at any depth, an item as `[n]`, and `<?>` for a key nothing settles. */
const PATHS: InputRule = ({ input }) => {
  const found: string[] = [];
  const walk = (value: ValueOps, prefix: string): void => {
    value.items().forEach((item, at) => {
      walk(item, `${prefix}[${at}]`);
    });
    for (const entry of value.entries("nothing")) {
      const name = entry.key ?? "<?>";
      const at = prefix === "" ? name : `${prefix}.${name}`;
      found.push(at);
      walk(entry.value, at);
    }
  };
  walk(input, "");
  return found;
};

// The case number goes in as the container, so each effect says which
// case it read.
const PUTS = storageCalls({
  system: "records",
  client: constructedFrom("kvcache", "Kvcache"),
})
  .methods({ put: { kind: "write", fields: { of: { at: 0 }, by: PATHS } } })
  .container({ at: 1 })
  .example('records.put({ a: 1 }, "1")');

const PACKS = [
  pack("value-policy", [PUTS], {
    languages: ["typescript", "python", "ruby"],
    recognizedAs: "@suss/value-policy-test",
  }),
];
const INVOCATION = PACKS.flatMap((one) => one.invocationRecognizers ?? []);

const DEEP = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].map(
  (_, at, all) => all.slice(0, at + 1).join("."),
);

/** What every language reads for each case, by its number. */
const READS: Record<string, readonly string[]> = {
  "1": ["a"],
  "2": ["shared", "other"],
  "3": ["honey", "bears", "b"],
  "4": ["pots", "c"],
  "5": ["fromCall", "d"],
  "6": ["computed", "e"],
  "7": ["sharedKey", "f"],
  "8": ["computed_x"],
  "9": ["[0].name"],
  "10": ["[0].named"],
  "11": ["[0].named"],
  "12": ["[0].imp"],
  "13": DEEP,
  "14": ["made"],
  "15": ["made"],
  "16": [],
  "17": [],
  "18": ["data", "data.where", "data.where.id"],
  "19": ["[0].i", "[1].j"],
  "20": ["[0].k"],
  "21": ["[0].viaName"],
  "22": ["[0].<?>"],
  "23": [],
};

const TYPESCRIPT = `
import { Records } from "kvcache";
import { SHARED, SHARED_KEY, rows as importedRows } from "./shared";

const records = new Records();
const base = { honey: 1, bears: 0 };
const config = { base: { pots: 3 } };
const key = "computed";
const defaults = () => ({ fromCall: true });
const makeRow = () => ({ made: 1 });
const toRow = (x: string) => ({ named: x });
const xs = ["a", "b"];

class Row {
  constructor(readonly data: unknown) {}
}

export function cases(flag: boolean, param: { p: number }) {
  const local = { a: 1 };
  records.put(local, "1");
  records.put(SHARED, "2");
  records.put({ ...base, b: 2 }, "3");
  records.put({ ...config.base, c: 3 }, "4");
  records.put({ ...defaults(), d: 4 }, "5");
  records.put({ [key]: 1, e: 5 }, "6");
  records.put({ [SHARED_KEY]: 1, f: 6 }, "7");
  records.put({ [\`\${key}_x\`]: 1 }, "8");
  records.put(xs.map((x) => ({ name: x })), "9");
  records.put(xs.map(toRow), "10");
  records.put(
    xs.map((x) => {
      const row = toRow(x);
      return row;
    }),
    "11",
  );
  records.put(importedRows.map((x) => ({ imp: x })), "12");
  records.put({ l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: "deep" } } } } } } } } } }, "13");
  const made = makeRow();
  records.put(made, "14");
  records.put(makeRow(), "15");
  let either = { g: 7 };
  if (flag) {
    either = { h: 8 };
  }
  records.put(either, "16");
  records.put(param, "17");
  const where = { id: 1 };
  records.put({ data: { where } }, "18");
  records.put([{ i: 1 }, { j: 2 }], "19");
  records.put([...importedRows, { k: 3 }], "20");
  const mapped = xs.map((x) => ({ viaName: x }));
  records.put(mapped, "21");
  records.put(Object.keys(base).map((k) => ({ [k]: 1 })), "22");
  records.put(new Row({ x: 1 }), "23");
}
`;

const TYPESCRIPT_SHARED = `
export const SHARED = { shared: 1, other: 2 };
export const SHARED_KEY = "sharedKey";
export const rows = ["r1", "r2"];
`;

const PYTHON = `from kvcache import Records
from .shared import SHARED, SHARED_KEY, rows as imported_rows

records = Records()
base = {"honey": 1, "bears": 0}
config = {"base": {"pots": 3}}
key = "computed"
xs = ["a", "b"]


def defaults():
    return {"fromCall": True}


def make_row():
    return {"made": 1}


def to_row(x):
    return {"named": x}


class Row:
    def __init__(self, data):
        self.data = data


def cases(flag, param):
    local = {"a": 1}
    records.put(local, "1")
    records.put(SHARED, "2")
    records.put({**base, "b": 2}, "3")
    records.put({**config["base"], "c": 3}, "4")
    records.put({**defaults(), "d": 4}, "5")
    records.put({key: 1, "e": 5}, "6")
    records.put({SHARED_KEY: 1, "f": 6}, "7")
    records.put({f"{key}_x": 1}, "8")
    records.put([{"name": x} for x in xs], "9")
    records.put(map(to_row, xs), "10")
    records.put([to_row(x) for x in xs], "11")
    records.put([{"imp": x} for x in imported_rows], "12")
    records.put({"l1": {"l2": {"l3": {"l4": {"l5": {"l6": {"l7": {"l8": {"l9": {"l10": "deep"}}}}}}}}}}, "13")
    made = make_row()
    records.put(made, "14")
    records.put(make_row(), "15")
    either = {"g": 7}
    if flag:
        either = {"h": 8}
    records.put(either, "16")
    records.put(param, "17")
    where = {"id": 1}
    records.put({"data": {"where": where}}, "18")
    records.put([{"i": 1}, {"j": 2}], "19")
    records.put([*imported_rows, {"k": 3}], "20")
    mapped = [{"viaName": x} for x in xs]
    records.put(mapped, "21")
    records.put([{k: 1} for k in base], "22")
    records.put(Row({"x": 1}), "23")
    records.put(list(map(to_row, xs)), "24")
`;

const PYTHON_SHARED = `SHARED = {"shared": 1, "other": 2}
SHARED_KEY = "sharedKey"
rows = ["r1", "r2"]
`;

const RUBY = `module Store
  BASE = { honey: 1, bears: 0 }
  CONFIG = { base: { pots: 3 } }
  KEY = "computed"
  XS = ["a", "b"]

  class Row
    def initialize(data)
      @data = data
    end
  end

  def self.defaults
    { fromCall: true }
  end

  def self.make_row
    { made: 1 }
  end

  def self.to_row(x)
    { named: x }
  end

  def self.cases(flag, param)
    records = Kvcache::Records.new
    local = { a: 1 }
    records.put(local, "1")
    records.put(SHARED, "2")
    records.put({ **BASE, b: 2 }, "3")
    records.put({ **CONFIG[:base], c: 3 }, "4")
    records.put({ **defaults, d: 4 }, "5")
    records.put({ KEY => 1, e: 5 }, "6")
    records.put({ SHARED_KEY => 1, f: 6 }, "7")
    records.put({ "#{KEY}_x" => 1 }, "8")
    records.put(XS.map { |x| { name: x } }, "9")
    records.put(XS.map(&method(:to_row)), "10")
    records.put(XS.map { |x| row = to_row(x); row }, "11")
    records.put(ROWS.map { |x| { imp: x } }, "12")
    records.put({ l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: "deep" } } } } } } } } } }, "13")
    made = make_row
    records.put(made, "14")
    records.put(make_row, "15")
    either = { g: 7 }
    either = { h: 8 } if flag
    records.put(either, "16")
    records.put(param, "17")
    where = { id: 1 }
    records.put({ data: { where: where } }, "18")
    records.put([{ i: 1 }, { j: 2 }], "19")
    records.put([*ROWS, { k: 3 }], "20")
    mapped = XS.map { |x| { viaName: x } }
    records.put(mapped, "21")
    records.put(BASE.keys.map { |k| { k => 1 } }, "22")
    records.put(Row.new({ x: 1 }), "23")
  end
end
`;

const RUBY_SHARED = `module Store
  SHARED = { shared: 1, other: 2 }
  SHARED_KEY = "sharedKey"
  ROWS = ["r1", "r2"]
end
`;

/** The fields each case read, by its number. */
type CaseReads = Map<string, readonly string[]>;

function readsOf(effects: readonly Effect[]): CaseReads {
  const reads = new Map<string, readonly string[]>();
  for (const effect of effects) {
    if (effect.type !== "interaction" || effect.binding === undefined) {
      continue;
    }
    const semantics = effect.binding.semantics as { container?: string };
    const interaction = effect.interaction as { fields?: readonly string[] };
    if (semantics.container !== undefined) {
      reads.set(semantics.container, interaction.fields ?? []);
    }
  }
  return reads;
}

function typescriptReads(): CaseReads {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/kvcache/package.json",
    JSON.stringify({ name: "kvcache", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/kvcache/index.d.ts",
    "export declare class Records { put(record: unknown, table: string): unknown; }",
  );
  project.createSourceFile("/shared.ts", TYPESCRIPT_SHARED);
  const file = project.createSourceFile("/store.ts", TYPESCRIPT);
  const store = ResolutionStore.forPacks(PACKS);
  const originatesFrom = (value: Node, module: string): boolean =>
    store.importOriginsOf(value, [module]).length > 0;
  const effects: Effect[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const anchors = (value: Node, matches: (call: Node) => boolean) =>
      store.anchorCallsOf(value, matches);
    const context = invocationContextFor(node, store, originatesFrom, anchors);
    for (const hook of INVOCATION) {
      effects.push(...(hook(node, context) ?? []));
    }
  });
  return readsOf(effects);
}

let root: string;

beforeAll(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-value-policy-")),
  );
  fs.mkdirSync(path.join(root, "store"));
  fs.writeFileSync(path.join(root, "store/__init__.py"), PYTHON);
  fs.writeFileSync(path.join(root, "store/shared.py"), PYTHON_SHARED);
  fs.mkdirSync(path.join(root, "lib/store"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib/store.rb"), RUBY);
  fs.writeFileSync(path.join(root, "lib/store/shared.rb"), RUBY_SHARED);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DECLARED = {
  name: "value-policy",
  protocol: "in-process",
  discovery: [],
  invocationRecognizers: INVOCATION,
  accessRecognizers: [],
};

function effectsIn(summaries: readonly BehavioralSummary[]): Effect[] {
  return summaries.flatMap((summary) =>
    summary.transitions.flatMap((transition) => transition.effects),
  );
}

async function pythonReads(): Promise<CaseReads> {
  const { summaries } = await extractPythonProject({
    files: [
      path.join(root, "store/__init__.py"),
      path.join(root, "store/shared.py"),
    ],
    roots: [root],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return readsOf(effectsIn(summaries));
}

async function rubyReads(): Promise<CaseReads> {
  const { summaries } = await extractRubyProject({
    files: [
      path.join(root, "lib/store.rb"),
      path.join(root, "lib/store/shared.rb"),
    ],
    packs: [DECLARED],
    modules: [{ name: "store", root: path.join(root, "lib/store") }],
    workspaceRoot: root,
    cacheDir: null,
  });
  return readsOf(effectsIn(summaries));
}

// Python and Ruby do not follow an entry read such as config["base"] yet.
const ENTRY_READ_UNFOLLOWED = { "4": ["c"] };

describe("the value policy, the same in every language", () => {
  it("reads each case in TypeScript the way the policy says", () => {
    expect(Object.fromEntries(typescriptReads())).toEqual(READS);
  });

  it("reads each case in Python the way the policy says", async () => {
    // A library call is not looked through, and Python's list() is one,
    // so list(map(f, xs)) reads nothing where map(f, xs) reads f's row.
    expect(Object.fromEntries(await pythonReads())).toEqual({
      ...READS,
      ...ENTRY_READ_UNFOLLOWED,
      "24": [],
    });
  });

  it("reads each case in Ruby the way the policy says", async () => {
    expect(Object.fromEntries(await rubyReads())).toEqual({
      ...READS,
      ...ENTRY_READ_UNFOLLOWED,
    });
  });
});
