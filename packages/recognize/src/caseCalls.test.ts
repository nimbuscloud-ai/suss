import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { factCallOps, factModuleOps } from "./factOps.js";
import { discoverTestCases } from "./testCases.js";

import type { CallOps, ModuleOps, TestCasesMatch } from "@suss/extractor";
import type { FactSource } from "./factOps.js";

const FILE = "/t/src/orders.test.ts";
const at = (span: string): string => `${FILE}:${span}`;

const VI = {
  origin: "imported",
  importedFrom: ["vitest"],
  named: ["vi"],
} as const;

const MATCH: TestCasesMatch = {
  type: "testCases",
  files: { matching: ["*.test.ts"] },
  calls: {
    from: { origin: "imported", importedFrom: ["vitest"] },
    globalsIn: { matching: ["*.spec.ts"] },
    groups: { names: ["describe"], skipped: ["xdescribe"] },
    cases: { names: ["it"] },
    modifiers: {
      skip: ["skip"],
      takingArguments: ["skipIf"],
      perRow: ["each"],
    },
  },
  mocks: [
    {
      replacesModule: {
        by: { from: [{ origin: "returnedBy", method: "mock", on: VI }] },
        path: { at: 0 },
      },
    },
    {
      replacesMember: {
        by: { from: [{ origin: "returnedBy", method: "spyOn", on: VI }] },
        member: { at: 1 },
        of: { at: 0 },
      },
    },
    {
      replacesModule: {
        by: { handed: [{ parameter: "stub", methods: ["module"] }] },
        path: { at: 0 },
      },
    },
  ],
};

/**
 * The facts for this file, each call keyed by its span:
 *
 *   vi.mock("./orders");
 *   describe("orders", () => {
 *     it.skip("cancels", () => {}); rows.forEach((row) => it(row, () => {}));
 *     it.each(table)("adds %i", () => {}); it.each(table);
 *     it.skipIf(ci)("later"); vi.spyOn(orders, "cancel"); it.skip.only("deep");
 *     xdescribe("refunds", () => { it("x", () => {}) });
 *   });
 *   it(TITLE, () => {}); foo.it("not the runner"); make(1).it("nor this");
 *   make()("nor this"); it(); stub.module("./refunds");
 */
function facts(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  const text: Record<string, string> = {};
  const evaluated: Record<string, string> = {};
  const call = (span: string, callee: string, args: string[] = []) => {
    add("call", at(span), callee);
    args.forEach((arg, position) => {
      add("callArg", at(span), String(position), arg);
    });
  };
  const member = (key: string, object: string, name: string) => {
    add("readsProperty", key, object, name);
    text[key] = `${object}.${name}`;
  };
  const fn = (span: string, body?: string) => {
    add("func", at(span));
    if (body !== undefined) {
      add("containsFn", at(body), at(span));
    }
  };
  const title = (key: string, value: string | null, written: string) => {
    text[key] = written;
    if (value !== null) {
      evaluated[key] = value;
    }
  };
  const inBody = (body: string, span: string) => {
    add("makesCall", at(body), at(span));
  };

  member("vi.mock", "vi", "mock");
  call("10-30", "vi.mock", ["s1"]);
  title("s1", "./orders", '"./orders"');

  call("40-400", "describe", ["t2", at("60-400")]);
  title("t2", "orders", '"orders"');
  fn("60-400");

  member("it.skip#1", "it", "skip");
  call("70-100", "it.skip#1", ["t3", at("90-100")]);
  title("t3", "cancels", '"cancels"');
  fn("90-100", "60-400");
  inBody("60-400", "70-100");

  member("rows.forEach", "rows", "forEach");
  call("110-180", "rows.forEach", [at("120-180")]);
  fn("120-180", "60-400");
  inBody("60-400", "110-180");
  call("130-170", "it", ["row", at("150-170")]);
  title("row", null, "row");
  fn("150-170", "120-180");
  inBody("120-180", "130-170");

  member("it.each#1", "it", "each");
  call("190-205", "it.each#1", ["table"]);
  call("190-240", at("190-205"), ["t6", at("220-240")]);
  title("t6", "adds %i", '"adds %i"');
  fn("220-240", "60-400");
  inBody("60-400", "190-240");
  inBody("60-400", "190-205");

  member("it.each#2", "it", "each");
  call("250-265", "it.each#2", ["table"]);
  inBody("60-400", "250-265");

  member("it.skipIf", "it", "skipIf");
  call("270-285", "it.skipIf", ["ci"]);
  call("270-300", at("270-285"), ["t8"]);
  title("t8", "later", '"later"');
  inBody("60-400", "270-300");

  member("vi.spyOn", "vi", "spyOn");
  call("310-340", "vi.spyOn", ["orders", "s9"]);
  title("s9", "cancel", '"cancel"');
  inBody("60-400", "310-340");

  call("350-395", "xdescribe", ["t10", at("365-395")]);
  title("t10", "refunds", '"refunds"');
  fn("365-395", "60-400");
  inBody("60-400", "350-395");
  call("370-390", "it", ["t11", at("380-390")]);
  title("t11", "x", '"x"');
  fn("380-390", "365-395");
  inBody("365-395", "370-390");

  call("410-440", "it", ["TITLE", at("430-440")]);
  title("TITLE", null, "TITLE");
  fn("430-440");

  member("foo.it", "foo", "it");
  call("450-470", "foo.it", ["t13"]);
  title("t13", "not the runner", '"not the runner"');

  member("it.skip#2", "it", "skip");
  member("skip.only", "it.skip#2", "only");
  call("342-348", "skip.only", ["t14"]);
  title("t14", "deep", '"deep"');
  inBody("60-400", "342-348");

  call("480-487", "make", ["one"]);
  member("make.it", at("480-487"), "it");
  call("480-495", "make.it", ["t15"]);
  title("t15", "nor this", '"nor this"');

  call("500-505", "make");
  call("500-515", at("500-505"), ["t16"]);
  title("t16", "nor this", '"nor this"');

  call("520-525", "it");

  member("stub.module", "stub", "module");
  call("530-545", "stub.module", ["s17"]);
  title("s17", "./refunds", '"./refunds"');

  const names = new Set([
    "vi",
    "it",
    "describe",
    "xdescribe",
    "rows",
    "foo",
    "make",
    "stub",
  ]);
  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: (key, module) =>
      module === "vitest" && key === "vi" ? ["vi"] : [],
    textOf: (key) => text[key] ?? key,
    shapeOf: () => null,
    literalOf: () => null,
    nameOf: () => null,
    argOf: () => null,
    formOf: (key) => (names.has(key) ? "name" : "other"),
    evaluatedOf: (key) => evaluated[key] ?? null,
  };
}

const CALLS = [
  "10-30",
  "40-400",
  "70-100",
  "110-180",
  "130-170",
  "190-240",
  "190-205",
  "250-265",
  "270-300",
  "270-285",
  "310-340",
  "342-348",
  "350-395",
  "370-390",
  "410-440",
  "450-470",
  "480-495",
  "480-487",
  "500-515",
  "500-505",
  "520-525",
  "530-545",
];

const IMPORTED = new Map([
  ["describe", "describe"],
  ["it", "it"],
  ["xdescribe", "xdescribe"],
  ["vi", "vi"],
]);

function module(
  file = FILE,
  imported: ReadonlyMap<string, string> = IMPORTED,
  binds: (name: string) => boolean = () => false,
): ModuleOps {
  const source = facts();
  return factModuleOps(file, source, {
    calls: () =>
      CALLS.flatMap((span) => {
        const ops: CallOps | null = factCallOps(at(span), source);
        return ops === null ? [] : [ops];
      }),
    importedNames: () => imported,
    bindsAtTopLevel: binds,
  });
}

describe("the cases a runner writes as calls", () => {
  it("titles each case by the runner calls it is written inside, through a callback, in source order", () => {
    const found = discoverTestCases(MATCH, module());
    expect(found.map((one) => one.titles.map((title) => title.text))).toEqual([
      ["orders", "cancels"],
      ["orders", "row"],
      ["orders", "adds %i"],
      ["orders", "later"],
      ["orders", "deep"],
      ["orders", "refunds", "x"],
      ["TITLE"],
      [""],
    ]);
    expect(found.map((one) => one.at)).toEqual(
      [
        "70-100",
        "130-170",
        "190-240",
        "270-300",
        "342-348",
        "370-390",
        "410-440",
        "520-525",
      ].map(at),
    );
  });

  it("reads the function passed after the title, and none for a case that passes no function", () => {
    const found = discoverTestCases(MATCH, module());
    expect(found.map((one) => one.runs?.site?.() ?? null)).toEqual([
      at("90-100"),
      at("150-170"),
      at("220-240"),
      null,
      null,
      at("380-390"),
      at("430-440"),
      null,
    ]);
  });

  it("marks a case skipped by its own modifier, a group's, or a skipping name, and a per-row title unresolved", () => {
    const found = discoverTestCases(MATCH, module());
    expect(found.map((one) => one.skipped)).toEqual([
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(
      found.map((one) =>
        one.titles
          .filter((title) => title.unresolved)
          .map((title) => title.text),
      ),
    ).toEqual([[], ["row"], ["adds %i"], [], [], [], ["TITLE"], [""]]);
  });

  it("applies a mock at the top of the file to every case, and one inside a group to the cases in it, and no patcher a fixture would hand", () => {
    const found = discoverTestCases(MATCH, module());
    expect(
      found.map((one) =>
        one.mocks.map(({ read }) =>
          read.replaces === "path" ? read.path : read.member,
        ),
      ),
    ).toEqual([
      ...Array.from({ length: 6 }, () => ["./orders", "cancel"]),
      ["./orders"],
      ["./orders"],
    ]);
  });

  it("reads the runner's functions as globals only in a file the globals cover, and not one the file binds", () => {
    const none = new Map<string, string>();
    expect(discoverTestCases(MATCH, module(FILE, none))).toEqual([]);
    const spec = "/t/src/orders.spec.ts";
    const globals = { ...MATCH, files: { matching: ["*.spec.ts"] } };
    expect(discoverTestCases(globals, module(spec, none))).toHaveLength(8);
    expect(
      discoverTestCases(
        globals,
        module(spec, none, (name) => name === "it"),
      ),
    ).toEqual([]);
  });

  it("reads an import under the name the runner exports, and nothing without a calls form", () => {
    const aliased = new Map([
      ["describe", "describe"],
      ["it", "test"],
    ]);
    expect(discoverTestCases(MATCH, module(FILE, aliased))).toEqual([]);
    const { calls: _calls, ...withoutCalls } = MATCH;
    expect(discoverTestCases(withoutCalls, module())).toEqual([]);
  });
});
