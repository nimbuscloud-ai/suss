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
  stillValid,
  unpackHashes,
  WatchedMap,
} from "./dependencyLedger.js";
import { RESOLUTION_QUESTIONS, RESOLUTION_RULES } from "./index.js";
import {
  askResolution,
  askResolutionUnder,
  isObserved,
  noteKeyRead,
  noteLookup,
  observeDemand,
} from "./program.js";

const ORDERS = "/project/orders.rb";
const BILLING = "/project/billing.rb";
const REPORTS = "/project/reports.rb";

/** A project where `load` in the orders file is bound to a function the billing file defines. */
function boundProject(): Database {
  const db = new Database();
  db.add("func", [`${BILLING}:10-40`]);
  db.add("binds", [`${ORDERS}#load`, `${BILLING}:10-40`]);
  return db;
}

describe("DependencyLedger", () => {
  it("finds the file a key starts with, or is", () => {
    const ledger = new DependencyLedger([ORDERS, BILLING]);

    expect(ledger.fileOf(`${ORDERS}:1-9`)).toBe(ORDERS);
    expect(ledger.fileOf(`${ORDERS}#load`)).toBe(ORDERS);
    expect(ledger.fileOf(BILLING)).toBe(BILLING);
    expect(ledger.fileOf("load")).toBeNull();
    expect(ledger.fileOf(`${REPORTS}:1-9`)).toBeNull();
  });

  it("charges a question's keys to the work that asked it, and drops names", () => {
    const db = boundProject();
    const ledger = new DependencyLedger([ORDERS, BILLING]);
    observeDemand(db, ledger);
    const charge = noDependencies();

    ledger.charging(charge, () => askResolution(db, [`${ORDERS}#load`]));

    expect(charge.values).toContain(`${ORDERS}#load`);
    expect(charge.values).toContain(`${BILLING}:10-40`);
    expect([...charge.values].every((value) => ledger.fileOf(value))).toBe(
      true,
    );
  });

  it("charges a question asked a second time with what it touched the first time", () => {
    const db = boundProject();
    const ledger = new DependencyLedger([ORDERS, BILLING]);
    observeDemand(db, ledger);
    const first = noDependencies();
    const second = noDependencies();

    ledger.charging(first, () => askResolution(db, [`${ORDERS}#load`]));
    ledger.charging(second, () => askResolution(db, [`${ORDERS}#load`]));

    expect([...second.values].sort()).toEqual([...first.values].sort());
  });

  it("charges nothing for a question asked while no work is being charged", () => {
    const db = boundProject();
    const ledger = new DependencyLedger([ORDERS, BILLING]);
    observeDemand(db, ledger);
    askResolution(db, [`${ORDERS}#load`]);
    askResolution(db, [`${ORDERS}#load`]);
    const later = noDependencies();

    ledger.charging(later, () => askResolution(db, [`${ORDERS}#load`]));

    expect(later.values).toContain(`${BILLING}:10-40`);
  });

  it("reads what a question touched from its answers when nothing is derived on demand", () => {
    const db = boundProject();
    const ledger = new DependencyLedger([ORDERS, BILLING]);
    observeDemand(db, ledger);
    const everything = {
      rules: [...RESOLUTION_RULES, ...RESOLUTION_QUESTIONS],
      demandDriven: [],
      demands: [],
    };
    const charge = noDependencies();

    ledger.charging(charge, () =>
      askResolution(db, [`${ORDERS}#load`], "wanted", everything),
    );

    expect(charge.values).toContain(`${ORDERS}#load`);
    expect(charge.values).toContain(`${BILLING}:10-40`);
  });

  it("charges every piece of work that is running, the outer one included", async () => {
    const db = boundProject();
    const ledger = new DependencyLedger([ORDERS, BILLING]);
    observeDemand(db, ledger);
    const outer = noDependencies();
    const inner = noDependencies();

    await ledger.chargingAsync(outer, async () => {
      ledger.charging(inner, () => askResolution(db, [`${ORDERS}#load`]));
    });

    expect(outer.values).toContain(`${BILLING}:10-40`);
    expect(inner.values).toContain(`${BILLING}:10-40`);
  });

  it("charges syntax reads by file, keys placed on a summary by key, and lookups by what came back", () => {
    const db = new Database();
    const ledger = new DependencyLedger([ORDERS, BILLING]);
    observeDemand(db, ledger);
    const charge = noDependencies();

    ledger.charging(charge, () => {
      noteKeyRead(db, `${BILLING}:10-40`);
      noteKeyRead(db, "load");
      ledger.touchKey(`${ORDERS}:5-9`);
      noteLookup(db, "topLevel load", "one");
    });
    noteLookup(db, "topLevel save", "none");

    expect([...charge.files]).toEqual([BILLING]);
    expect([...charge.values]).toEqual([`${ORDERS}:5-9`]);
    expect([...charge.checks]).toEqual([["topLevel load", hashString("one")]]);
  });

  it("stops telling a database's observer once it is let go", () => {
    const db = new Database();
    const release = observeDemand(db, new DependencyLedger([]));

    expect(isObserved(db)).toBe(true);
    release();
    expect(isObserved(db)).toBe(false);
  });

  it("hears about a question under an allocation site, answered or given up", () => {
    const db = boundProject();
    const heard: string[] = [];
    class Listening extends DependencyLedger {
      override evaluated(
        asking: string,
        keys: readonly string[],
        values: ReadonlySet<string>,
      ): void {
        heard.push(`${asking} ${keys.length}`);
        super.evaluated(asking, keys, values);
      }

      override reasked(asking: string, keys: readonly string[]): void {
        heard.push(`again ${asking} ${keys.length}`);
        super.reasked(asking, keys);
      }
    }
    observeDemand(db, new Listening([ORDERS]));

    askResolutionUnder(db, [[`${ORDERS}#load`, `${ORDERS}:1-2`]]);
    askResolutionUnder(db, [[`${ORDERS}#load`, `${ORDERS}:1-2`]]);
    askResolutionUnder(db, [[`${ORDERS}#load`, `${ORDERS}:3-4`]], undefined, 1);
    askResolutionUnder(
      db,
      [[`${ORDERS}#load`, `${ORDERS}:5-6`]],
      undefined,
      undefined,
      0,
    );

    expect(heard).toEqual([
      "wantedUnder 1",
      "again wantedUnder 1",
      "wantedUnder 1",
      "wantedUnder 1",
    ]);
  });

  it("stores dependencies by hash, hashing each value once", () => {
    const ledger = new DependencyLedger([ORDERS]);
    const charge = noDependencies();
    charge.files.add(ORDERS);
    charge.values.add(`${ORDERS}:1-9`);
    charge.checks.set("blocks Order", 7);

    const stored = ledger.store(charge);

    expect(unpackHashes(stored.files)).toEqual([hashString(ORDERS)]);
    expect(unpackHashes(stored.values)).toEqual([hashString(`${ORDERS}:1-9`)]);
    expect(stored.checks).toEqual([["blocks Order", 7]]);
  });
});

describe("stillValid", () => {
  const stored: StoredDependencies = {
    files: packHashes([hashString(ORDERS)]),
    values: packHashes([hashString(`${BILLING}:10-40`)]),
    checks: [["topLevel load", hashString("one")]],
  };
  const changes = (overrides: Partial<Changes>): Changes => ({
    files: new Set(),
    values: new Set(),
    lookAgain: () => "one",
    ...overrides,
  });

  it("holds while nothing it depended on changed", () => {
    expect(stillValid(stored, changes({}))).toBe(true);
  });

  it("fails on a changed file, a changed value, or a lookup that comes back different", () => {
    expect(
      stillValid(stored, changes({ files: new Set([hashString(ORDERS)]) })),
    ).toBe(false);
    expect(
      stillValid(
        stored,
        changes({ values: new Set([hashString(`${BILLING}:10-40`)]) }),
      ),
    ).toBe(false);
    expect(stillValid(stored, changes({ lookAgain: () => "two" }))).toBe(false);
    expect(stillValid(stored, changes({ lookAgain: () => null }))).toBe(false);
  });

  it("merges two stored records into one that depends on both", () => {
    const other: StoredDependencies = {
      files: packHashes([hashString(BILLING)]),
      values: "",
      checks: [["topLevel save", 3]],
    };

    const merged = mergeStoredDependencies(stored, other);

    expect(unpackHashes(merged.files).sort()).toEqual(
      [hashString(ORDERS), hashString(BILLING)].sort(),
    );
    expect(merged.checks).toHaveLength(2);
  });
});

describe("WatchedMap", () => {
  it("reports every lookup, found or not", () => {
    const seen: string[] = [];
    const map = new WatchedMap([["Order", 1]], (key, value) =>
      seen.push(`${key}=${value ?? "-"}`),
    );

    expect(map.get("Order")).toBe(1);
    expect(map.has("Invoice")).toBe(false);
    expect(seen).toEqual(["Order=1", "Invoice=-"]);
  });
});

/** One run's facts: each file's own rows, then the rows that join files. */
function loggedRun(
  own: Record<string, [string, string[]][]>,
  joined: [string, string[]][],
): FactLog {
  const db = new Database();
  const log = new FactLog(db, new DependencyLedger([ORDERS, BILLING, REPORTS]));
  for (const [file, rows] of Object.entries(own)) {
    log.startFile();
    for (const [relation, row] of rows) {
      db.add(relation, row);
    }
    log.endFile(file);
  }
  log.startJoined();
  for (const [relation, row] of joined) {
    db.add(relation, row);
  }
  log.endJoined();
  return log;
}

describe("FactLog", () => {
  const files = [ORDERS, BILLING, REPORTS];
  const before = {
    [ORDERS]: [["readsName", [`${ORDERS}:5-9`, `${ORDERS}#Invoice`]]],
    [BILLING]: [
      ["func", [`${BILLING}:10-40`]],
      ["func", [`${BILLING}:50-80`]],
    ],
    [REPORTS]: [["func", [`${REPORTS}:1-9`]]],
  } as Record<string, [string, string[]][]>;
  const bindings: [string, string[]][] = [
    ["binds", [`${ORDERS}#Invoice`, `${BILLING}:10-40`]],
  ];

  it("says which keys' rows changed in an edited file, and leaves the rest", () => {
    const stored = loggedRun(before, bindings).stored(
      files,
      new Map(),
      new Set(),
    );
    const after = loggedRun(
      {
        ...before,
        [BILLING]: [
          ["func", [`${BILLING}:10-40`]],
          ["func", [`${BILLING}:62-92`]],
        ],
      },
      bindings,
    );

    const changed = after.changedValues(new Set([BILLING]), stored);

    expect(changed.has(hashString(`${BILLING}:50-80`))).toBe(true);
    expect(changed.has(hashString(`${BILLING}:62-92`))).toBe(true);
    expect(changed.has(hashString(`${BILLING}:10-40`))).toBe(false);
    expect(changed.has(hashString(`${ORDERS}#Invoice`))).toBe(false);
  });

  it("leaves a key alone when a key beside it in a joining row only moved", () => {
    const stored = loggedRun(before, bindings).stored(
      files,
      new Map(),
      new Set(),
    );
    const after = loggedRun(
      { ...before, [BILLING]: [["func", [`${BILLING}:12-42`]]] },
      [["binds", [`${ORDERS}#Invoice`, `${BILLING}:12-42`]]],
    );

    const changed = after.changedValues(new Set([BILLING]), stored);

    expect(changed.has(hashString(`${ORDERS}#Invoice`))).toBe(false);
  });

  it("marks a key in an unedited file when its binding moves to a definition in another file", () => {
    const stored = loggedRun(before, bindings).stored(
      files,
      new Map(),
      new Set(),
    );
    const after = loggedRun(
      { ...before, [REPORTS]: [["func", [`${REPORTS}:1-9`]]] },
      [["binds", [`${ORDERS}#Invoice`, `${REPORTS}:1-9`]]],
    );

    const changed = after.changedValues(new Set([REPORTS]), stored);

    expect(changed.has(hashString(`${ORDERS}#Invoice`))).toBe(true);
  });

  it("leaves out answers a question added, names, and a key said twice in one row", () => {
    const stored = loggedRun(before, bindings).stored(
      files,
      new Map(),
      new Set(),
    );
    const after = loggedRun(
      {
        ...before,
        [ORDERS]: [
          ...(before[ORDERS] ?? []),
          ["callsNamed", [`${ORDERS}:5-9`, "render"]],
          ["sameAs", [`${ORDERS}:5-9`, `${ORDERS}:5-9`]],
        ],
      },
      [
        ...bindings,
        ["wantedResolves", [`${ORDERS}#Invoice`, `${REPORTS}:1-9`]],
      ],
    );

    const changed = after.changedValues(
      new Set([ORDERS, "/project/unlogged.rb"]),
      stored,
    );

    expect(changed.has(hashString(`${ORDERS}:5-9`))).toBe(true);
    expect(changed.has(hashString("render"))).toBe(false);
    expect(changed.has(hashString(`${ORDERS}#Invoice`))).toBe(false);
  });

  it("marks a key whose joining rows are gone", () => {
    const stored = loggedRun(before, bindings).stored(
      files,
      new Map(),
      new Set(),
    );

    const changed = loggedRun(before, []).changedValues(new Set(), stored);

    expect(changed.has(hashString(`${ORDERS}#Invoice`))).toBe(true);
  });

  it("keeps an unchanged file's own digests from the stored run instead of reading them again", () => {
    const first = loggedRun(before, bindings).stored(
      files,
      new Map(),
      new Set(),
    );

    const again = loggedRun({}, bindings).stored(
      files,
      first,
      new Set([ORDERS, BILLING, REPORTS]),
    );

    expect(again.get(BILLING)?.own).toBe(first.get(BILLING)?.own);
  });
});
