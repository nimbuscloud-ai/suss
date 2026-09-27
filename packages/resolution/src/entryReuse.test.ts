import { describe, expect, it } from "vitest";

import {
  type Changes,
  DependencyLedger,
  hashString,
  mergeStoredDependencies,
  noDependencies,
  packHashes,
  type StoredDependencies,
} from "./dependencyLedger.js";
import {
  EntryReuse,
  fileOfKey,
  recordsToReplay,
  type StoredFileRecord,
  type StoredWalkRecord,
  walkRecordsByFile,
} from "./entryReuse.js";

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

  it("gives every root's record when no file was added or removed", () => {
    expect(recordsToReplay(roots, new Set([ORDERS]), new Set())?.size).toBe(2);
  });

  it("gives nothing when a file was removed, added, or written without records", () => {
    expect(recordsToReplay(roots, new Set(), new Set([ORDERS]))).toBeNull();
    expect(
      recordsToReplay(roots, new Set(["/project/new.rb"]), new Set()),
    ).toBeNull();
    expect(
      recordsToReplay(new Map([[ORDERS, { meta: {} }]]), new Set(), new Set()),
    ).toBeNull();
    expect(recordsToReplay(new Map(), new Set(), new Set())).toBeNull();
  });
});
