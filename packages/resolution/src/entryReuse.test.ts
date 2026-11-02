import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  type Changes,
  DependencyLedger,
  FactLog,
  hashString,
  mergeStoredDependencies,
  noDependencies,
  packHashes,
  type StoredDependencies,
  type StoredFacts,
  stillValid,
} from "./dependencyLedger.js";
import {
  EntryReuse,
  factsKeptFrom,
  fileOfKey,
  recordsToReplay,
  replayChanges,
  type StoredFileRecord,
  type StoredWalkRecord,
  walkRecordsByFile,
} from "./entryReuse.js";
import { noteFileMissing, observeDemand } from "./program.js";

const ORDERS = "/project/orders.rb";
const BILLING = "/project/billing.rb";

type Record_ = StoredFileRecord<string, string> & { seeds: string[] };

const dependsOn = (...values: string[]): StoredDependencies => ({
  files: "",
  values: packHashes(values.map(hashString)),
  checks: [],
});

const walk = (
  key: string,
  ...values: string[]
): StoredWalkRecord<string, string> => ({
  key,
  dependencies: dependsOn(...values),
  scan: `scan of ${key}`,
  summary: `summary of ${key}`,
});

const record = (
  seeds: string[],
  walked: StoredWalkRecord<string, string>[],
  ...values: string[]
): Record_ => ({
  discovery: dependsOn(...values),
  walked,
  facts: { own: "", joined: "" },
  seeds,
});

function reuseOver(
  records: Map<string, Record_>,
  changedFiles: string[],
  changedValues: string[],
): EntryReuse<string, string, Record_> {
  const changes: Changes = {
    files: new Set(changedFiles.map(hashString)),
    values: new Set(changedValues.map(hashString)),
    lookAgain: () => null,
  };
  return new EntryReuse(
    records,
    new Set(changedFiles),
    changes,
    (one) => one.seeds,
  );
}

describe("EntryReuse", () => {
  const records = new Map<string, Record_>([
    [
      ORDERS,
      record(
        [`${ORDERS}:1-9`],
        [walk(`${ORDERS}:1-9`, `${BILLING}:10-40`)],
        `${ORDERS}#Invoice`,
      ),
    ],
    [BILLING, record([], [walk(`${BILLING}:10-40`)])],
  ]);

  it("replays a file and a function when nothing they depended on changed", () => {
    const reuse = reuseOver(records, [], []);

    expect(reuse.discoveryOf(ORDERS)).toBe(records.get(ORDERS));
    expect(reuse.walkOf(`${ORDERS}:1-9`)?.summary).toBe(
      `summary of ${ORDERS}:1-9`,
    );
    expect(reuse.walkOf(`${ORDERS}:99-100`)).toBeUndefined();
  });

  it("drops a file's discovery when the walk of a function its units start from is no longer valid", () => {
    const reuse = reuseOver(records, [], [`${BILLING}:10-40`]);

    expect(reuse.walkOf(`${ORDERS}:1-9`)).toBeUndefined();
    expect(reuse.discoveryOf(ORDERS)).toBeUndefined();
  });

  it("drops a changed file's records, and its own discovery on a changed value", () => {
    expect(reuseOver(records, [BILLING], []).walkOf(`${BILLING}:10-40`)).toBe(
      undefined,
    );
    expect(reuseOver(records, [BILLING], []).discoveryOf(BILLING)).toBe(
      undefined,
    );
    expect(
      reuseOver(records, [], [`${ORDERS}#Invoice`]).discoveryOf(ORDERS),
    ).toBeUndefined();
    expect(reuseOver(records, [], []).discoveryOf("/project/none.rb")).toBe(
      undefined,
    );
  });
});

describe("walkRecordsByFile", () => {
  it("keeps a replayed scan's stored dependencies, merges what the run added, and stores a fresh scan's own", () => {
    const ledger = new DependencyLedger([ORDERS, BILLING]);
    const replayed = walk(`${ORDERS}:1-9`, `${BILLING}:10-40`);
    const alsoReplayed = walk(`${ORDERS}:20-30`);
    const added = noDependencies();
    added.values.add(`${ORDERS}#Invoice`);
    const fresh = noDependencies();
    fresh.files.add(BILLING);

    const byFile = walkRecordsByFile({
      scans: new Map([
        [replayed.key, replayed.scan],
        [alsoReplayed.key, alsoReplayed.scan],
        [`${BILLING}:10-40`, "a new scan"],
        [`${BILLING}:50-60`, "a scan nobody charged"],
      ]),
      charges: new Map([
        [alsoReplayed.key, added],
        [`${BILLING}:10-40`, fresh],
      ]),
      beforeGaps: new Map([[replayed.key, "summary"]]),
      replayed: (key) =>
        key === replayed.key
          ? replayed
          : key === alsoReplayed.key
            ? alsoReplayed
            : undefined,
      store: (dependencies) => ledger.store(dependencies),
      merge: mergeStoredDependencies,
    });

    const orders = byFile.get(ORDERS) ?? [];
    expect(orders[0]?.dependencies).toBe(replayed.dependencies);
    expect(orders[0]?.summary).toBe("summary");
    expect(orders[1]?.dependencies.values).toContain(
      hashString(`${ORDERS}#Invoice`).toString(16).padStart(8, "0"),
    );
    expect(byFile.get(BILLING)?.map((one) => one.scan)).toEqual([
      "a new scan",
      "a scan nobody charged",
    ]);
    expect(fileOfKey(`${BILLING}:10-40`)).toBe(BILLING);
  });
});

describe("recordsToReplay", () => {
  const roots = new Map([
    [ORDERS, { meta: { discovery: dependsOn() } }],
    [BILLING, { meta: { discovery: dependsOn() } }],
  ]);

  it("gives every root's record, a removed file's too", () => {
    expect(recordsToReplay(roots)?.size).toBe(2);
  });

  it("gives nothing when a root was written without a record", () => {
    expect(recordsToReplay(new Map([[ORDERS, { meta: {} }]]))).toBeNull();
    expect(recordsToReplay(new Map())).toBeNull();
  });
});

const ADDED = "/project/billing/__init__.rb";

/** One run's facts, each file's own rows emitted in turn, as an adapter logs them. */
function factsOf(own: Record<string, [string, string[]][]>): {
  ledger: DependencyLedger;
  log: FactLog;
} {
  const db = new Database();
  const ledger = new DependencyLedger(Object.keys(own));
  const log = new FactLog(db, ledger);
  for (const [file, rows] of Object.entries(own)) {
    log.startFile();
    for (const [relation, row] of rows) {
      db.add(relation, row);
    }
    log.endFile(file);
  }
  log.startJoined();
  log.endJoined();
  return { ledger, log };
}

function storedRecords(
  own: Record<string, [string, string[]][]>,
): Map<string, { facts: StoredFacts }> {
  const files = Object.keys(own);
  const stored = factsOf(own).log.stored(files, new Map(), new Set());
  return new Map(
    [...stored].map(([file, facts]) => [file, { facts }] as const),
  );
}

describe("replayChanges", () => {
  const importOf = (target: string): [string, string[]] => [
    "importsFile",
    [`${ORDERS}:1-9`, target],
  ];

  it("compares a file nobody edited once another file joins, since its import can resolve to the new one", () => {
    const records = storedRecords({
      [ORDERS]: [importOf(BILLING)],
      [BILLING]: [["func", [`${BILLING}:10-40`]]],
    });
    const after = factsOf({
      [ORDERS]: [importOf(ADDED)],
      [BILLING]: [["func", [`${BILLING}:10-40`]]],
      [ADDED]: [],
    });
    const changes = replayChanges({
      files: [ORDERS, BILLING, ADDED],
      plan: {
        changed: new Set([ADDED]),
        added: new Set([ADDED]),
        removed: new Set(),
      },
      records,
      ...after,
      lookAgain: () => null,
    });
    expect(changes.values.has(hashString(`${ORDERS}:1-9`))).toBe(true);
    expect(changes.values.has(hashString(`${BILLING}:10-40`))).toBe(false);
    expect(changes.files.has(hashString(ADDED))).toBe(true);
    // Work that read the orders file's syntax read an import that moved.
    expect(changes.files.has(hashString(ORDERS))).toBe(true);
    expect(changes.files.has(hashString(BILLING))).toBe(false);
  });

  it("looks a path up again among this run's files", () => {
    const changes = replayChanges({
      files: [ORDERS, ADDED],
      plan: { changed: new Set(), added: new Set(), removed: new Set() },
      records: new Map(),
      ...factsOf({ [ORDERS]: [], [ADDED]: [] }),
      lookAgain: (id) => `asked ${id}`,
    });
    expect(changes.lookAgain(`file ${ADDED}`)).toBe("present");
    expect(changes.lookAgain(`file ${BILLING}`)).toBe("");
    expect(changes.lookAgain("router x")).toBe("asked router x");
  });

  it("does work again that looked for a file a later run has", () => {
    const before = new Database();
    const ledger = new DependencyLedger([ORDERS]);
    observeDemand(before, ledger);
    const charge = noDependencies();
    ledger.charging(charge, () => noteFileMissing(before, ADDED));
    const stored = ledger.store(charge);
    const changesWith = (files: string[]) =>
      replayChanges({
        files,
        plan: {
          changed: new Set(files.filter((file) => file === ADDED)),
          added: new Set(files.filter((file) => file === ADDED)),
          removed: new Set(),
        },
        records: new Map(),
        ...factsOf(Object.fromEntries(files.map((file) => [file, []]))),
        lookAgain: () => null,
      });

    expect(stillValid(stored, changesWith([ORDERS]))).toBe(true);
    expect(stillValid(stored, changesWith([ORDERS, ADDED]))).toBe(false);
  });

  it("counts a removed file and every key in it as changed", () => {
    const records = storedRecords({
      [ORDERS]: [importOf(BILLING)],
      [BILLING]: [["func", [`${BILLING}:10-40`]]],
    });
    const changes = replayChanges({
      files: [ORDERS],
      plan: {
        changed: new Set(),
        added: new Set(),
        removed: new Set([BILLING]),
      },
      records,
      ...factsOf({ [ORDERS]: [importOf(BILLING)] }),
      lookAgain: () => null,
    });
    expect(changes.values.has(hashString(`${BILLING}:10-40`))).toBe(true);
    expect(changes.values.has(hashString(`${ORDERS}:1-9`))).toBe(false);
    expect(changes.files.has(hashString(BILLING))).toBe(true);
  });
});

describe("factsKeptFrom", () => {
  const files = [ORDERS, BILLING];

  it("keeps the stored facts of every file whose content is the same, while the set of files is too", () => {
    const plan = {
      changed: new Set([ORDERS]),
      added: new Set<string>(),
      removed: new Set<string>(),
    };
    expect([...factsKeptFrom(files, plan)]).toEqual([BILLING]);
  });

  it("keeps none once a file joined or left the set, or without a stored entry", () => {
    const joined = {
      changed: new Set([ADDED]),
      added: new Set([ADDED]),
      removed: new Set<string>(),
    };
    const left = {
      changed: new Set<string>(),
      added: new Set<string>(),
      removed: new Set([ADDED]),
    };
    expect(factsKeptFrom(files, joined).size).toBe(0);
    expect(factsKeptFrom(files, left).size).toBe(0);
    expect(factsKeptFrom(files, null).size).toBe(0);
  });
});
