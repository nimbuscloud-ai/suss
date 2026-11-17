import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { factModuleOps } from "./factOps.js";
import { caseRuns, collectsFile, discoverTestCases } from "./testCases.js";

import type { ModuleOps, TestCasesMatch } from "@suss/extractor";
import type { FactSource } from "./factOps.js";

const FILE = "/t/tests/test_orders.py";
const at = (span: string): string => `${FILE}:${span}`;

/**
 * The facts for a test module that writes, in source order: `test_one`
 * and `setup_module` as functions, beside a test function it imports;
 * `TestOrders` with `test_cancel`, `helper`, `setup_method`, a nested
 * `TestNested` with `test_inner`, and a nested `Other` with
 * `test_ignored`; `Cases`, whose project base `Base` reaches
 * `unittest.TestCase` and writes `setUp`, with `test_works`; and
 * `TestLocal`, declared inside a function.
 */
function source(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  const fn = (key: string) => add("func", key);
  const cls = (key: string) => add("objectValue", key);

  fn(at("0-20"));
  add("exportsAs", FILE, "test_one", at("0-20"));
  add("exportsAs", FILE, "test_imported", `${FILE}#test_imported`);
  fn("/t/tests/helpers.py:0-10");
  fn(at("40-60"));
  add("exportsAs", FILE, "setup_module", at("40-60"));

  cls(at("100-400"));
  add("exportsAs", FILE, "TestOrders", at("100-400"));
  for (const [name, span] of [
    ["test_cancel", "110-150"],
    ["helper", "160-170"],
    ["setup_method", "180-200"],
  ] as const) {
    fn(at(span));
    add("holdsProperty", at("100-400"), name, at(span));
  }
  cls(at("210-300"));
  add("holdsProperty", at("100-400"), "TestNested", at("210-300"));
  fn(at("220-260"));
  add("holdsProperty", at("210-300"), "test_inner", at("220-260"));
  cls(at("310-350"));
  add("holdsProperty", at("100-400"), "Other", at("310-350"));
  fn(at("320-340"));
  add("holdsProperty", at("310-350"), "test_ignored", at("320-340"));

  cls(at("500-700"));
  add("exportsAs", FILE, "Cases", at("500-700"));
  add("extends", at("500-700"), at("510-514"));
  fn(at("520-560"));
  add("holdsProperty", at("500-700"), "test_works", at("520-560"));
  cls("/t/tests/base.py:0-100");
  add("extends", "/t/tests/base.py:0-100", "/t/tests/base.py:5-20");
  fn("/t/tests/base.py:30-60");
  add(
    "holdsProperty",
    "/t/tests/base.py:0-100",
    "setUp",
    "/t/tests/base.py:30-60",
  );

  cls(at("800-850"));

  const comesTo: Record<string, readonly string[]> = {
    [`${FILE}#test_imported`]: ["/t/tests/helpers.py:0-10"],
    [at("510-514")]: ["/t/tests/base.py:0-100"],
  };
  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: (key, module) =>
      key === "/t/tests/base.py:5-20" && module === "unittest"
        ? ["TestCase"]
        : [],
    shapeOf: () => null,
    textOf: (key) => key,
    literalOf: () => null,
    nameOf: () => null,
    argOf: (key) => ({ kind: "identifier", name: key }),
    comesTo: (key) => comesTo[key] ?? [],
  };
}

function moduleAt(file = FILE): ModuleOps {
  return factModuleOps(file, source(), {
    calls: () => [],
    classes: () => [
      at("100-400"),
      at("210-300"),
      at("310-350"),
      at("500-700"),
      at("800-850"),
    ],
  });
}

function pytest(listed?: string[]): TestCasesMatch {
  return {
    type: "testCases",
    files: {
      matching: ["test_*.py"],
      ...(listed === undefined ? {} : { listed }),
    },
    functions: { pattern: "^test" },
    classes: {
      named: "^Test",
      inherits: [{ from: ["unittest"], named: ["TestCase"] }],
      nested: true,
      methods: { pattern: "^test" },
    },
    before: {
      module: { always: ["setup_module"], forFunctions: ["setup_function"] },
      methods: {
        byName: ["setup_class", "setup_method"],
        byAncestry: ["setUpClass", "setUp"],
      },
    },
  };
}

describe("the test cases a runner collects", () => {
  it("reads the module's own test functions and the test methods of each class it collects by name or ancestry, nested ones under their own title, in source order", () => {
    const found = discoverTestCases(pytest(), moduleAt());

    expect(
      found.map((one) => [one.titles.map((title) => title.text), one.at]),
    ).toEqual([
      [["test_one"], at("0-20")],
      [["TestOrders", "test_cancel"], at("110-150")],
      [["TestOrders", "TestNested", "test_inner"], at("220-260")],
      [["Cases", "test_works"], at("520-560")],
    ]);
    expect(found.every((one) => one.runs.site?.() === one.at)).toBe(true);
  });

  it("reads only a file whose name the runner collects, and only a listed one when the PRDs list files", () => {
    expect(collectsFile(pytest(), FILE)).toBe(true);
    expect(collectsFile(pytest(), "/t/tests/helpers.py")).toBe(false);
    expect(
      discoverTestCases(pytest(), moduleAt("/t/tests/helpers.py")),
    ).toEqual([]);
    expect(
      discoverTestCases(pytest(["tests/test_orders.py"]), moduleAt()),
    ).toHaveLength(4);
    expect(
      discoverTestCases(pytest(["tests/test_refunds.py"]), moduleAt()),
    ).toEqual([]);
  });

  it("gives the setup the runner calls before a case: the module's, then each class's from the outermost in, a base class's included", () => {
    const runs = caseRuns(pytest(), { module: moduleAt() });
    const setUpOf = (key: string) =>
      runs.get(key)?.before.map((fn) => fn.site?.()) ?? null;

    expect(setUpOf(at("0-20"))).toEqual([at("40-60")]);
    expect(setUpOf(at("220-260"))).toEqual([at("40-60"), at("180-200")]);
    expect(setUpOf(at("520-560"))).toEqual([
      at("40-60"),
      "/t/tests/base.py:30-60",
    ]);
    expect(setUpOf(at("160-170"))).toBeNull();
    expect(setUpOf(at("320-340"))).toBeNull();
  });

  it("reads only the forms the match declares, and calls nothing first when it declares no setup", () => {
    const methodsOnly: TestCasesMatch = {
      type: "testCases",
      files: { matching: ["test_*.py"] },
      classes: { named: "^Test", methods: { pattern: "^test" } },
    };
    const module = moduleAt();

    expect(
      discoverTestCases(methodsOnly, module).map((one) =>
        one.titles.map((title) => title.text).join(" > "),
      ),
    ).toEqual(["TestOrders > test_cancel"]);
    expect(
      discoverTestCases(
        { type: "testCases", files: { matching: ["test_*.py"] } },
        module,
      ),
    ).toEqual([]);
    expect(
      caseRuns(methodsOnly, { module }).get(at("110-150"))?.before,
    ).toEqual([]);
    expect(
      caseRuns(methodsOnly, { module: moduleAt("/t/tests/helpers.py") }).size,
    ).toBe(0);
  });

  it("finds the case whatever the PRDs list, since the walk asks about a function it reached", () => {
    const run = caseRuns(pytest(["tests/test_refunds.py"]), {
      module: moduleAt(),
    }).get(at("110-150"));

    expect(run?.found.titles.map((title) => title.text)).toEqual([
      "TestOrders",
      "test_cancel",
    ]);
  });
});
