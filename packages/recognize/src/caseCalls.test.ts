import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { callCaseRuns, caseAt, sharedGroupsWritten } from "./caseCalls.js";
import { factCallOps, factModuleOps, factValueOps } from "./factOps.js";
import { discoverTestCases } from "./testCases.js";

import type { CallOps, ModuleOps, TestCasesMatch } from "@suss/extractor";
import type { FactSource } from "./factOps.js";
import type { SharedGroups } from "./testCases.js";

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
    body: "function",
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

  it("reads a case's run from its function up, through the call the function is passed to", () => {
    const source = facts();
    const read = {
      module: factModuleOps(FILE, source, {
        calls: () =>
          CALLS.flatMap((span) => factCallOps(at(span), source) ?? []),
        importedNames: () => IMPORTED,
      }),
    };
    const run = caseAt(MATCH, factValueOps(at("90-100"), source), read);
    expect(run?.groups?.map((one) => one.site?.())).toEqual([at("40-400")]);
    expect(run?.before).toEqual([]);
    expect(caseAt(MATCH, factValueOps(at("60-400"), source), read)).toBeNull();
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

const SPEC = "/t/spec/order_spec.rb";
const SUPPORT = "/t/spec/support/refunds.rb";
const inSpec = (span: string): string => `${SPEC}:${span}`;
const inSupport = (span: string): string => `${SUPPORT}:${span}`;

const RSPEC: TestCasesMatch = {
  type: "testCases",
  files: { matching: ["*_spec.rb"] },
  calls: {
    from: { origin: "global", paths: ["RSpec"] },
    body: "block",
    groups: { names: ["describe", "context"] },
    cases: { names: ["it"] },
    topLevelCases: false,
    shared: {
      names: ["shared_examples"],
      includes: [
        { method: "it_behaves_like", nestedTitle: "behaves like" },
        { method: "include_examples" },
      ],
    },
  },
  before: { calls: ["before", "let!"] },
  skips: { statements: ["pending"], metadata: ["skip"] },
};

/**
 * The facts for a spec and a support file, each call keyed by its span:
 *
 *   it("outside") {}; RSpec.describe Order do              10-30; 40-600
 *     let!(:x) {}; it "cancels", :skip do it "inner" end    70-90; 100-140, 125-135
 *     it {}; context "later" do                             150-160; 170-260
 *       before { pending }; it "waits" do end               190-210; 220-250
 *     end; it_behaves_like "refundable" do end              270-300
 *     include_examples "local"; shared_examples "local" do  310-330; 340-420
 *       before {}; it "is local" do end; include_examples "local"   360-380; 390-410; 412-418
 *     end; it_behaves_like "missing" do it "through" end end      430-470, 445-465
 *   shared_examples "refundable" do                         support 0-100
 *     it "refunds", skip: false do end end                  support 30-60
 */
function specFacts(): FactSource {
  const db = new Database();
  const text: Record<string, string> = {};
  const evaluated: Record<string, string> = {};
  const call = (
    key: string,
    method: string,
    title?: string,
    block?: string,
  ): void => {
    db.add("call", [key, `#${method}`]);
    text[`#${method}`] = method;
    if (title !== undefined) {
      db.add("callArg", [key, "0", `${key}#title`]);
      text[`${key}#title`] = `"${title}"`;
      evaluated[`${key}#title`] = title;
    }
    if (block !== undefined) {
      db.add("callBlock", [key, block]);
      text[block] = "{}";
    }
  };
  const statements = (body: string, ...calls: string[]): void => {
    calls.forEach((one, at) => {
      db.add("bodyCallAt", [body, String(at), one]);
      db.add("makesCall", [body, one]);
    });
  };

  call(inSpec("10-30"), "it", "outside", inSpec("20-30"));
  db.add("call", [inSpec("40-600"), "RSpec.describe"]);
  db.add("readsProperty", ["RSpec.describe", "RSpec", "describe"]);
  text["RSpec.describe"] = "RSpec.describe";
  db.add("callArg", [inSpec("40-600"), "0", "Order"]);
  db.add("callBlock", [inSpec("40-600"), inSpec("60-600")]);
  call(inSpec("70-90"), "let!", undefined, inSpec("80-90"));
  call(inSpec("100-140"), "it", "cancels", inSpec("120-140"));
  db.add("callArg", [inSpec("100-140"), "1", "skip"]);
  evaluated.skip = "skip";
  call(inSpec("125-135"), "it", "inner", inSpec("130-135"));
  call(inSpec("150-160"), "it", undefined, inSpec("152-160"));
  call(inSpec("170-260"), "context", "later", inSpec("180-260"));
  call(inSpec("190-210"), "before", undefined, inSpec("195-210"));
  call(inSpec("200-207"), "pending");
  call(inSpec("220-250"), "it", "waits", inSpec("230-250"));
  call(inSpec("270-300"), "it_behaves_like", "refundable", inSpec("290-300"));
  call(inSpec("310-330"), "include_examples", "local");
  call(inSpec("340-420"), "shared_examples", "local", inSpec("350-420"));
  call(inSpec("360-380"), "before", undefined, inSpec("370-380"));
  call(inSpec("390-410"), "it", "is local", inSpec("400-410"));
  call(inSpec("412-418"), "include_examples", "local");
  call(inSpec("430-470"), "it_behaves_like", "missing", inSpec("440-470"));
  call(inSpec("445-465"), "it", "through", inSpec("450-465"));
  // A second include of the support group, which only one test's table reads.
  call(inSpec("480-500"), "it_behaves_like", "refundable");
  statements(SPEC, inSpec("10-30"), inSpec("40-600"));
  statements(
    inSpec("60-600"),
    inSpec("70-90"),
    inSpec("100-140"),
    inSpec("150-160"),
    inSpec("170-260"),
    inSpec("270-300"),
    inSpec("310-330"),
    inSpec("340-420"),
    inSpec("430-470"),
    inSpec("480-500"),
  );
  statements(inSpec("120-140"), inSpec("125-135"));
  statements(inSpec("180-260"), inSpec("190-210"), inSpec("220-250"));
  statements(inSpec("195-210"), inSpec("200-207"));
  statements(
    inSpec("350-420"),
    inSpec("360-380"),
    inSpec("390-410"),
    inSpec("412-418"),
  );
  statements(inSpec("440-470"), inSpec("445-465"));

  call(
    inSupport("0-100"),
    "shared_examples",
    "refundable",
    inSupport("20-100"),
  );
  call(inSupport("30-60"), "it", "refunds", inSupport("50-60"));
  db.add("callKeywordArg", [inSupport("30-60"), "skip", "false"]);
  statements(inSupport("20-100"), inSupport("30-60"));

  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    textOf: (key) => text[key] ?? key,
    shapeOf: () => null,
    literalOf: (key) => (key === "false" ? false : null),
    nameOf: () => null,
    argOf: () => null,
    formOf: (key) => (key === "skip" || key === "Order" ? "name" : "other"),
    evaluatedOf: (key) => evaluated[key] ?? null,
    constantPathOf: (key) => (key === "Order" ? "Order" : null),
  };
}

const SPEC_CALLS = [
  "10-30",
  "40-600",
  "70-90",
  "100-140",
  "125-135",
  "150-160",
  "170-260",
  "190-210",
  "200-207",
  "220-250",
  "270-300",
  "310-330",
  "340-420",
  "360-380",
  "390-410",
  "412-418",
  "430-470",
  "445-465",
  "480-500",
];

/** The run's table: each include reads the shared group of its title, and "missing" is no shared group the run defines. */
function sharedGroups(
  source: FactSource,
  more: Record<string, string> = {},
): SharedGroups {
  const included: Record<string, string> = {
    [inSpec("270-300")]: inSupport("0-100"),
    [inSpec("310-330")]: inSpec("340-420"),
    [inSpec("412-418")]: inSpec("340-420"),
    ...more,
  };
  const ops = (key: string): CallOps => factCallOps(key, source) as CallOps;
  return {
    includedAt: (site) => {
      const definition = included[site];
      return definition === undefined ? null : ops(definition);
    },
    defines: (site) => Object.values(included).includes(site),
    includersOf: (definition) =>
      Object.entries(included)
        .filter(([, defined]) => defined === definition)
        .map(([include]) => ({
          call: ops(include),
          groups: [ops(inSpec("40-600"))],
        })),
  };
}

function specReading() {
  const source = specFacts();
  const module = factModuleOps(SPEC, source, {
    calls: () =>
      SPEC_CALLS.flatMap((span) => factCallOps(inSpec(span), source) ?? []),
    importedNames: () => new Map(),
  });
  return { source, module, shared: sharedGroups(source) };
}

describe("the cases RSpec writes as calls with blocks", () => {
  it("reads each case inside a group, a shared group through each include, and nothing inside a case", () => {
    const { module, shared } = specReading();
    const found = callCaseRuns(RSPEC, { module, shared }).map(
      (run) => run.found,
    );
    expect(found.map((one) => one.titles.map((title) => title.text))).toEqual([
      ["Order", "cancels"],
      ["Order", "{}"],
      ["Order", "later", "waits"],
      ["Order", "behaves like refundable", "refunds"],
      ["Order", "is local"],
      ["Order", "through"],
    ]);
    expect(found.map((one) => one.at)).toEqual([
      inSpec("100-140"),
      inSpec("150-160"),
      inSpec("220-250"),
      inSpec("270-300"),
      inSpec("390-410"),
      inSpec("445-465"),
    ]);
    expect(found.map((one) => one.runs?.site?.())).toEqual([
      inSpec("120-140"),
      inSpec("152-160"),
      inSpec("230-250"),
      inSupport("50-60"),
      inSpec("400-410"),
      inSpec("450-465"),
    ]);
  });

  it("reads nothing from a match with no calls form, and no shared groups from one that writes none", () => {
    const { module } = specReading();
    const { calls: _calls, ...withoutCalls } = RSPEC;
    expect(callCaseRuns(withoutCalls, { module })).toEqual([]);
    expect(sharedGroupsWritten(MATCH, module)).toEqual({
      definitions: [],
      includes: [],
    });
  });

  it("skips a case by its metadata or a statement in a hook around it, and keeps one whose skip is false", () => {
    const { module, shared } = specReading();
    const found = callCaseRuns(RSPEC, { module, shared }).map(
      (run) => run.found,
    );
    expect(found.map((one) => one.skipped)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(found[1]?.titles[1]?.unresolved).toBe(true);
  });

  it("runs a case through its groups and the shared groups they include in place, with their hooks first", () => {
    const { module, shared } = specReading();
    const [cancels] = callCaseRuns(RSPEC, { module, shared });
    expect(cancels?.groups?.map((one) => one.site?.())).toEqual([
      inSpec("40-600"),
      inSpec("340-420"),
    ]);
    expect(cancels?.before.map((one) => one.site?.())).toEqual([
      inSpec("80-90"),
      inSpec("370-380"),
    ]);
  });

  it("reads the same run from a case's block up, a shared case's through its one include, and one with two includes through its own groups", () => {
    const { source, module, shared } = specReading();
    const groupsAt = (block: string) =>
      caseAt(RSPEC, factValueOps(block, source), { module, shared })?.groups;
    expect(
      caseAt(RSPEC, factValueOps(inSpec("120-140"), source), {
        module,
        shared,
      })?.before.map((one) => one.site?.()),
    ).toEqual([inSpec("80-90"), inSpec("370-380")]);
    expect(groupsAt(inSupport("50-60"))?.map((one) => one.site?.())).toEqual([
      inSpec("40-600"),
      inSpec("340-420"),
      inSpec("270-300"),
      inSupport("0-100"),
    ]);
    expect(groupsAt(inSpec("400-410"))?.map((one) => one.site?.())).toEqual([
      inSpec("340-420"),
      inSpec("340-420"),
    ]);
    expect(groupsAt(inSpec("450-465"))?.map((one) => one.site?.())).toEqual([
      inSpec("40-600"),
      inSpec("340-420"),
    ]);
    expect(groupsAt(inSpec("20-30"))).toBeUndefined();
    expect(groupsAt(inSpec("80-90"))).toBeUndefined();
    expect(groupsAt(inSpec("70-90"))).toBeUndefined();
    expect(
      caseAt(RSPEC, factValueOps(inSupport("50-60"), source), { module }),
    ).toBeNull();
  });

  it("says which shared groups a file writes and where it includes one", () => {
    const { module } = specReading();
    const written = sharedGroupsWritten(RSPEC, module);
    expect(
      written.definitions.map(({ call, title }) => [call.site?.(), title]),
    ).toEqual([[inSpec("340-420"), "local"]]);
    expect(
      written.includes.map(({ call, title, groups, nests }) => [
        call.site?.(),
        title,
        groups.map((one) => one.site?.()),
        nests,
      ]),
    ).toEqual([
      [inSpec("270-300"), "refundable", [inSpec("40-600")], true],
      [inSpec("310-330"), "local", [inSpec("40-600")], false],
      [
        inSpec("412-418"),
        "local",
        [inSpec("40-600"), inSpec("340-420")],
        false,
      ],
      [inSpec("430-470"), "missing", [inSpec("40-600")], true],
      [inSpec("480-500"), "refundable", [inSpec("40-600")], true],
    ]);
  });

  it("reads a shared group in another file once for each include of it", () => {
    const { source, module } = specReading();
    const shared = sharedGroups(source, {
      [inSpec("480-500")]: inSupport("0-100"),
    });
    const refunds = callCaseRuns(RSPEC, { module, shared }).filter(
      (run) => run.found.runs?.site?.() === inSupport("50-60"),
    );
    expect(refunds.map((run) => run.found.at)).toEqual([
      inSpec("270-300"),
      inSpec("480-500"),
    ]);
  });
});
