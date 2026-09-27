/**
 * The closure's scan records across two runs, with the extraction cache
 * deciding which records survive an edit. Each run builds its own
 * project from disk, the way two CLI runs do, and the second run's
 * output is compared with a run that had no records at all.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Project } from "ts-morph";
import { afterAll, describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";
import { createCacheLayer } from "@suss/extractor";

import { createTypeScriptAdapter } from "../adapter.js";
import { createReferenceIndex } from "../referencedFiles.js";
import {
  closureUnitRecords,
  fromScanRecord,
  type RecordedScan,
  recordValidFrom,
  type ScanRecord,
  toScanRecord,
} from "./closureRecords.js";
import {
  type ClosureFacts,
  expandReachableClosure,
} from "./reachableClosure.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack, UnitRecord } from "@suss/extractor";

const entryPack: PatternPack = {
  name: "test-entry",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [
    { kind: "handler", match: { type: "namedExport", names: ["run"] } },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  ],
  inputMapping: { type: "positionalParams", params: [] },
};

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

interface Workspace {
  dir: string;
  write(rel: string, text: string): Promise<void>;
  remove(rel: string): Promise<void>;
  files(): Promise<string[]>;
}

async function workspace(files: Record<string, string>): Promise<Workspace> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "suss-closure-records-")),
  );
  dirs.push(dir);
  const write = async (rel: string, text: string): Promise<void> => {
    await fs.writeFile(path.join(dir, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) {
    await write(rel, text);
  }
  return {
    dir,
    write,
    remove: async (rel) => fs.rm(path.join(dir, rel)),
    files: async () =>
      (await fs.readdir(dir))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => path.join(dir, name))
        .sort(),
  };
}

interface ClosureRun {
  summaries: BehavioralSummary[];
  scans: Map<string, RecordedScan>;
  units: UnitRecord<ScanRecord>[];
}

/** One run over the files on disk: discovery, then the closure. */
async function runClosure(
  ws: Workspace,
  previousScans?: ReadonlyMap<string, UnitRecord<ScanRecord>>,
): Promise<ClosureRun> {
  const project = new Project({ compilerOptions: { strict: true } });
  for (const file of await ws.files()) {
    project.addSourceFileAtPath(file);
  }
  const seeds = await createTypeScriptAdapter({
    project,
    frameworks: [entryPack],
    includeReachable: false,
  }).extractAll();
  const scans = new Map<string, RecordedScan>();
  const facts: ClosureFacts = {
    db: new Database(),
    unitKeyBySummary: new Map(),
    filesByKey: new Map(),
    scans,
    ...(previousScans === undefined ? {} : { previousScans }),
  };
  const summaries = expandReachableClosure(
    seeds,
    project,
    undefined,
    undefined,
    facts,
    {
      invocation: [],
      access: [],
    },
  );
  const units = closureUnitRecords(
    scans,
    previousScans ?? new Map(),
    createReferenceIndex(project.getSourceFiles()),
  );
  return { summaries, scans, units };
}

/** Store a run's records, and read back the ones still valid for the tree on disk. */
async function keptAcrossEdit(
  ws: Workspace,
  first: ClosureRun,
  edit: () => Promise<void>,
): Promise<ReadonlyMap<string, UnitRecord<ScanRecord>>> {
  const cacheDir = path.join(ws.dir, ".cache");
  const cache = createCacheLayer<undefined, ScanRecord>(cacheDir);
  const before = { files: await ws.files(), adapterPacksDigest: "test" };
  await cache.write(before, first.summaries, {
    roots: [],
    owners: first.summaries.map(() => []),
    units: first.units,
  });
  await edit();
  const plan = await cache.plan({
    files: await ws.files(),
    adapterPacksDigest: "test",
  });
  return plan?.validUnits ?? new Map();
}

function kinds(run: ClosureRun): Record<string, string> {
  return Object.fromEntries(
    [...run.scans].map(([key, scan]) => [path.basename(key), scan.kind]),
  );
}

function names(run: ClosureRun): string[] {
  return run.summaries.map((summary) => summary.identity.name).sort();
}

const ENTRY = [
  'import { load } from "./orders";',
  "export function run() {",
  "  return load();",
  "}",
  "",
].join("\n");

const ORDERS = "export function load() {\n  return 1;\n}\n";

describe("the closure's scan records", () => {
  it("scans a caller again when an edit to its callee's file moves the callee", async () => {
    const ws = await workspace({
      "entry.ts": ENTRY,
      "orders.ts": ORDERS,
      "audit.ts": "export function audit() {\n  return 2;\n}\n",
    });
    const first = await runClosure(ws);
    expect(names(first)).toEqual(["load", "run"]);

    const kept = await keptAcrossEdit(ws, first, () =>
      ws.write(
        "orders.ts",
        [
          'import { audit } from "./audit";',
          "export function load() {",
          "  audit();",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
      ),
    );
    const second = await runClosure(ws, kept);
    const fresh = await runClosure(ws);

    expect(names(second)).toEqual(["audit", "load", "run"]);
    expect(second.summaries).toEqual(fresh.summaries);
    expect(Object.values(kinds(second))).toEqual(["fresh", "fresh", "fresh"]);
  });

  it("uses every record after an edit to a file nothing reached", async () => {
    const ws = await workspace({
      "entry.ts": ENTRY,
      "orders.ts": ORDERS,
      "totals.ts": "export function total() {\n  return 3;\n}\n",
    });
    const first = await runClosure(ws);

    const kept = await keptAcrossEdit(ws, first, () =>
      ws.write("totals.ts", "export function total() {\n  return 30;\n}\n"),
    );
    const second = await runClosure(ws, kept);
    const fresh = await runClosure(ws);

    expect(Object.values(kinds(second))).toEqual(["reused", "reused"]);
    expect(second.summaries).toEqual(fresh.summaries);
  });

  it("drops the records of a deleted file", async () => {
    const ws = await workspace({
      "entry.ts": [
        'import { load } from "./orders";',
        'import { audit } from "./audit";',
        "export function run() {",
        "  audit();",
        "  return load();",
        "}",
        "",
      ].join("\n"),
      "orders.ts": ORDERS,
      "audit.ts": "export function audit() {\n  return 2;\n}\n",
    });
    const first = await runClosure(ws);
    expect(first.units.map((unit) => path.basename(unit.file)).sort()).toEqual([
      "audit.ts",
      "entry.ts",
      "orders.ts",
    ]);

    const kept = await keptAcrossEdit(ws, first, async () => {
      await ws.remove("audit.ts");
      await ws.write("entry.ts", ENTRY);
    });
    const second = await runClosure(ws, kept);

    expect(kinds(second)).toEqual({
      "entry.ts:33-75": "fresh",
      "orders.ts:0-38": "reused",
    });
    expect(second.units.map((unit) => path.basename(unit.file)).sort()).toEqual(
      ["entry.ts", "orders.ts"],
    );
  });
});

describe("a scan record", () => {
  it("keeps what the scan found through the manifest's JSON", () => {
    const target = { file: "/orders.ts", span: { start: 0, end: 38 } };
    const record = toScanRecord(
      {
        calls: [{ key: "/orders.ts:0-38", name: "load" }],
        stops: [{ callee: "this.rows.remove", reason: "noDeclaration" }],
        targets: new Map([["load", target]]),
        argTargets: new Map([["retry", new Map([[0, target]])]]),
        parameterCalls: [{ callee: "onDone", parameterIndex: 1 }],
        passedPositions: new Set(["/orders.ts:0-38#0"]),
      },
      "/entry.ts",
    );

    const found = fromScanRecord(JSON.parse(JSON.stringify(record)));
    expect(found.calls).toEqual([{ key: "/orders.ts:0-38", name: "load" }]);
    expect(found.stops).toEqual([
      { callee: "this.rows.remove", reason: "noDeclaration" },
    ]);
    expect(found.targets.get("load")).toEqual(target);
    expect(found.argTargets.get("retry")?.get(0)).toEqual(target);
    expect(found.parameterCalls).toEqual([
      { callee: "onDone", parameterIndex: 1 },
    ]);
    expect([...found.passedPositions]).toEqual(["/orders.ts:0-38#0"]);
  });

  it("applies wherever the walk came from unless the scan asked where", () => {
    const anywhere: ScanRecord = { calls: [] };
    const fromEntry: ScanRecord = { from: "/entry.ts", calls: [] };
    const fromNowhere: ScanRecord = { from: null, calls: [] };

    expect(recordValidFrom(anywhere, "/other.ts")).toBe(true);
    expect(recordValidFrom(fromEntry, "/entry.ts")).toBe(true);
    expect(recordValidFrom(fromEntry, "/other.ts")).toBe(false);
    expect(recordValidFrom(fromNowhere, undefined)).toBe(true);
    expect(recordValidFrom(fromNowhere, "/entry.ts")).toBe(false);
  });
});
