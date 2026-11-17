import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { factCallOps, factModuleOps } from "./factOps.js";
import { global, imported, rubyConstants } from "./ops.js";
import {
  caseRuns,
  collectsFile,
  decoratorIsFrom,
  discoverTestCases,
  isRunnerCall,
  mockRead,
} from "./testCases.js";

import type {
  CallOps,
  ClassValueOps,
  ModuleOps,
  TestCasesMatch,
  ValueOps,
} from "@suss/extractor";
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

  add("decoratedWith", at("0-20"), "skip-mark");
  add("objectValue", "class-marks");
  add("holdsProperty", at("100-400"), "pytestmark", "class-marks");
  add("holdsProperty", "class-marks", "0", "class-skip");
  add("writtenEntryAt", "class-marks", "0", "class-skip", "value");
  add("exportsAs", FILE, "pytestmark", "module-mark");

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
    shapeOf: (key) => (key === "class-marks" ? "list" : null),
    spellsGlobal: (key, path) =>
      (key === "skip-mark" || key === "class-skip") &&
      path === "pytest.mark.skip",
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
    decorated: () => [{ key: at("0-20"), name: "test_one" }],
  });
}

/** pytest's skip markers, and the variable that lists markers for every case under it. */
const SKIPS: TestCasesMatch["skips"] = {
  decorators: {
    origins: [{ origin: "global", paths: ["pytest.mark.skip"] }],
    variable: "pytestmark",
  },
};

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
    expect(found.every((one) => one.runs?.site?.() === one.at)).toBe(true);
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

  it("gives each case the markers written on it, its classes from the innermost out and its module, and skips it for one from a skip origin", () => {
    const found = discoverTestCases({ ...pytest(), skips: SKIPS }, moduleAt());

    expect(
      found.map((one) => [
        one.titles.map((title) => title.text).join(" > "),
        one.markers.map((marker) =>
          marker.form === "value" ? marker.value.site?.() : "call",
        ),
        one.skipped,
      ]),
    ).toEqual([
      ["test_one", ["skip-mark", "module-mark"], true],
      ["TestOrders > test_cancel", ["class-skip", "module-mark"], true],
      [
        "TestOrders > TestNested > test_inner",
        ["class-skip", "module-mark"],
        true,
      ],
      ["Cases > test_works", ["module-mark"], false],
    ]);
    const unruled = discoverTestCases(pytest(), moduleAt())[0];
    expect(unruled?.markers).toHaveLength(1);
    expect(unruled?.skipped).toBe(false);
  });

  it("reads a decorator written as a call by its callee, and a value by the call it is when the origin is no global", () => {
    const origin = imported({ from: ["pytest"], named: ["fixture"] });
    const call = { isFrom: (asked: unknown) => asked === origin } as CallOps;

    expect(decoratorIsFrom({ form: "call", call }, [origin])).toBe(true);
    expect(
      decoratorIsFrom(
        { form: "value", value: { asCall: () => call } as ValueOps },
        [origin],
      ),
    ).toBe(true);
    expect(
      decoratorIsFrom({ form: "value", value: {} as ValueOps }, [origin]),
    ).toBe(false);
  });

  it("reads what a patcher replaces by the first mock rule whose argument it writes as a string", () => {
    const patch = global("unittest.mock.patch");
    const by = {
      from: [patch],
      handed: [{ parameter: "mocker", methods: ["patch"] }],
    };
    const rules = [
      { replacesModule: { by, path: { at: 0 } } },
      { replacesMember: { by, member: { at: 1 }, of: { at: 0 } } },
    ];
    const call = (callee: string, args: readonly unknown[]) =>
      ({
        isFrom: (origin: unknown) => origin === patch && callee === "patch",
        calleeText: () => callee,
        valueAt: (at: number) =>
          at < args.length ? ({ evaluated: () => args[at] } as ValueOps) : null,
      }) as unknown as CallOps;
    const takes = (name: string) => name === "mocker";

    expect(mockRead(rules, call("patch", ["a.b.c"]), takes)).toEqual({
      replaces: "path",
      path: "a.b.c",
    });
    expect(mockRead(rules, call("patch", [null, "cancel"]), takes)).toEqual({
      replaces: "member",
      member: "cancel",
      of: 0,
    });
    expect(
      mockRead(rules, call("mocker.patch", ["a.b"]), takes)?.replaces,
    ).toBe("path");
    expect(mockRead(rules, call("mocker.patch", ["a.b"]), () => false)).toBe(
      null,
    );
    expect(mockRead(rules, call("other", ["a.b"]), takes)).toBeNull();
    expect(mockRead(rules, call("patch", [5]), takes)).toBeNull();
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

const RB = "/t/test/order_test.rb";
const rb = (span: string): string => `${RB}:${span}`;

/**
 * `class OrderTest < ActiveSupport::TestCase` with, in source order: a
 * `setup do` block; `def test_one`, which skips inside an `if`, stubs
 * `cancel` on `Order.any_instance` and asserts; a `def setup`; and
 * `test "two" do`, whose block skips as a statement and which the class
 * body declares as the method `test_two`.
 */
function minitestSource(): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  const texts: Record<string, string> = {};
  const call = (key: string, text: string, on?: [string, string]) => {
    add("call", key, `${key}#callee`);
    texts[`${key}#callee`] = text;
    if (on !== undefined) {
      add("readsProperty", `${key}#callee`, on[0], on[1]);
    }
  };
  const cls = rb("0-900");
  add("objectValue", cls);
  add("rbConstantName", cls, "OrderTest");
  add("extends", cls, rb("20-43"));

  call(rb("50-90"), "setup");
  add("callBlock", rb("50-90"), rb("56-90"));
  add("func", rb("56-90"));

  add("func", rb("130-190"));
  add("holdsProperty", cls, "test_one", rb("130-190"));
  call(rb("140-150"), "skip");
  add("bodyCallAt", rb("130-190"), "0", rb("140-150"));
  add("nestedBodyCall", rb("140-150"));
  call(rb("155-170"), "Order.any_instance", ["Order#ref", "any_instance"]);
  call(rb("155-185"), "Order.any_instance.stubs", [rb("155-170"), "stubs"]);
  add("callArg", rb("155-185"), "0", "cancel");
  call(rb("186-189"), "assert_equal");

  add("func", rb("200-250"));
  add("holdsProperty", cls, "setup", rb("200-250"));

  call(rb("300-400"), "test");
  add("callBlock", rb("300-400"), rb("310-400"));
  add("func", rb("310-400"));
  add("holdsProperty", cls, "test_two", rb("310-400"));
  call(rb("320-330"), "skip");
  add("bodyCallAt", rb("310-400"), "0", rb("320-330"));

  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: (key, module) =>
      key === rb("20-43") && module === "ActiveSupport" ? ["TestCase"] : [],
    shapeOf: () => null,
    textOf: (key) => texts[key] ?? key,
    literalOf: () => null,
    nameOf: () => null,
    evaluatedOf: (key) => (key === "cancel" ? key : null),
    argOf: (key) => ({ kind: "identifier", name: key }),
    classBodyCalls: (key) => (key === cls ? [rb("50-90"), rb("300-400")] : []),
  };
}

function minitest(): TestCasesMatch {
  return {
    type: "testCases",
    files: { matching: ["*_test.rb"] },
    classes: {
      inherits: rubyConstants("ActiveSupport::TestCase"),
      methods: { pattern: "^test_" },
    },
    before: { calls: ["setup"], methods: ["setup"] },
    skips: { statements: ["skip"] },
    runner: { prefixes: ["assert"], names: ["skip"] },
    mocks: [
      {
        replacesMember: {
          by: { methods: ["stub", "stubs"] },
          member: { at: 0 },
          of: "receiver",
        },
      },
    ],
  };
}

describe("a runner that writes its cases as the methods of a test class", () => {
  const module = (): ModuleOps =>
    factModuleOps(RB, minitestSource(), {
      calls: () => [],
      classes: () => [rb("0-900")],
    });
  const ops = (key: string): CallOps => {
    const found = factCallOps(key, minitestSource());
    if (found === null) {
      throw new Error(`no call at ${key}`);
    }
    return found;
  };

  it("records a block's case at the call it is written with, and skips only on a statement of its own", () => {
    const found = discoverTestCases(minitest(), module());

    expect(
      found.map((one) => [one.titles.map((title) => title.text), one.at]),
    ).toEqual([
      [["OrderTest", "test_one"], rb("130-190")],
      [["OrderTest", "test_two"], rb("300-400")],
    ]);
    expect(found.map((one) => one.runs?.site?.())).toEqual([
      rb("130-190"),
      rb("310-400"),
    ]);
    expect(found.map((one) => one.skipped)).toEqual([false, true]);
  });

  it("runs the setup blocks and methods the class writes, in the order it writes them, and tells the runner's calls apart", () => {
    const runs = caseRuns(minitest(), { module: module() });

    expect(runs.get(rb("130-190"))?.before.map((fn) => fn.site?.())).toEqual([
      rb("56-90"),
      rb("200-250"),
    ]);
    expect(runs.get(rb("310-400"))?.found.at).toBe(rb("300-400"));
    expect(isRunnerCall(minitest(), ops(rb("186-189")))).toBe(true);
    expect(isRunnerCall(minitest(), ops(rb("140-150")))).toBe(true);
    expect(isRunnerCall(minitest(), ops(rb("155-185")))).toBe(false);
    expect(isRunnerCall(pytest(), ops(rb("186-189")))).toBe(false);
  });

  it("reads a stub as replacing a member of what it is called on, by its method whatever that is", () => {
    const rules = minitest().mocks ?? [];

    expect(mockRead(rules, ops(rb("155-185")), () => false)).toEqual({
      replaces: "member",
      member: "cancel",
      of: "receiver",
    });
    expect(mockRead(rules, ops(rb("186-189")), () => false)).toBeNull();
  });

  it("finds no case in a method the adapter cannot key", () => {
    const real = module().classes()[0] as ClassValueOps;
    const unkeyed: ClassValueOps = Object.assign(Object.create(real), {
      members: (kind: "instance" | "singleton") =>
        real.members(kind).map((member) => ({
          ...member,
          value: Object.assign(Object.create(member.value), {
            site: undefined,
          }),
        })),
    });
    const one: ModuleOps = Object.assign(Object.create(module()), {
      classes: () => [unkeyed],
    });

    expect(discoverTestCases(minitest(), one)).toEqual([]);
  });
});

/**
 * A call as RSpec writes it, read only as far as the runner and mock
 * rules ask: a receiver and an argument are a call written in place or a
 * name, and a name evaluates to its own text, as a Ruby symbol does.
 */
interface Written {
  readonly callee: string;
  readonly method?: string;
  readonly on?: Written | string;
  readonly args?: readonly (Written | string)[];
  readonly keywords?: readonly string[];
  /** The method of the call made on what this one gives back. */
  readonly chainedWith?: string;
  /** Written as a value that is neither a call nor a name, such as `[1]`. */
  readonly literal?: boolean;
}

function written(one: Written): CallOps {
  const value = (arg: Written | string): ValueOps =>
    (typeof arg === "string"
      ? { form: () => "name", evaluated: () => arg, source: () => arg }
      : {
          form: () => "other",
          source: () => arg.callee,
          asCall: () => (arg.literal === true ? null : written(arg)),
        }) as unknown as ValueOps;
  return {
    method: () => one.method ?? null,
    calleeText: () => one.callee,
    site: () => one.callee,
    receiverValue: () => (one.on === undefined ? null : value(one.on)),
    valueAt: (at: number) => {
      const arg = one.args?.[at];
      return arg === undefined ? null : value(arg);
    },
    argumentCount: () => one.args?.length ?? 0,
    keywordNames: () => one.keywords ?? [],
    chainedOn: () =>
      one.chainedWith === undefined
        ? null
        : written({ callee: `x.${one.chainedWith}`, method: one.chainedWith }),
  } as unknown as CallOps;
}

const RSPEC_RUNNER: TestCasesMatch = {
  type: "testCases",
  files: { matching: ["*_spec.rb"] },
  runner: { names: ["expect", "eq", "allow"], prefixes: ["be_"], chains: true },
  mocks: [
    {
      replacesMessages: {
        by: { methods: ["to"] },
        targets: ["allow"],
        messages: ["receive", "receive_messages"],
        of: { at: 0 },
      },
    },
    { replacesConstant: { by: { methods: ["stub_const"] }, name: { at: 0 } } },
    {
      standsIn: {
        by: { methods: ["instance_double"] },
        of: { at: 0 },
        becomes: "as_stubbed_const",
      },
    },
  ],
};

describe("a runner whose calls chain, and the mocks RSpec writes", () => {
  const expectX: Written = { callee: "expect", args: ["x"] };
  const allowOrder: Written = { callee: "allow", args: ["Order"] };
  const to = (on: Written, arg: Written): Written => ({
    callee: `${on.callee}.to`,
    method: "to",
    on,
    args: [arg],
  });

  it("reads a call made on what a runner call gives back as the runner's, from the name the chain starts at", () => {
    const runs = (one: Written) => isRunnerCall(RSPEC_RUNNER, written(one));
    expect(runs(to(expectX, { callee: "eq", args: ["y"] }))).toBe(true);
    expect(runs({ callee: "be_valid" })).toBe(true);
    expect(
      runs({ callee: "order.cancel", method: "cancel", on: "order" }),
    ).toBe(false);
    expect(
      runs({ callee: "x.save", method: "save", on: { callee: "build" } }),
    ).toBe(false);
    expect(
      runs({
        callee: "[1].each",
        method: "each",
        on: { callee: "[1]", literal: true },
      }),
    ).toBe(false);
    const { chains: _chains, ...onSelf } = RSPEC_RUNNER.runner ?? {};
    expect(
      isRunnerCall(
        { ...RSPEC_RUNNER, runner: onSelf },
        written(to(expectX, { callee: "eq" })),
      ),
    ).toBe(false);
  });

  it("reads the members a message expectation replaces on what its target is given", () => {
    const receive: Written = {
      callee: "receive(:cancel).and_return",
      method: "and_return",
      on: { callee: "receive", args: ["cancel"] },
    };
    const messages: Written = {
      callee: "receive_messages",
      keywords: ["cancel", "refund"],
    };
    const read = (one: Written) =>
      mockRead(RSPEC_RUNNER.mocks ?? [], written(one), () => false);
    expect(read(to(allowOrder, receive))).toEqual({
      replaces: "members",
      members: ["cancel"],
      receiverArgument: 0,
    });
    expect(read(to(allowOrder, messages))).toMatchObject({
      members: ["cancel", "refund"],
    });
    expect(read(to(expectX, receive))).toBeNull();
    expect(read(to(allowOrder, { callee: "eq", args: ["y"] }))).toBeNull();
    expect(read(to(allowOrder, { callee: "[]", literal: true }))).toBeNull();
  });

  it("reads a constant a stub replaces by name, and a stand-in that becomes one only when it is made the constant", () => {
    const read = (one: Written) =>
      mockRead(RSPEC_RUNNER.mocks ?? [], written(one), () => false);
    expect(read({ callee: "stub_const", args: ["Order"] })).toEqual({
      replaces: "constant",
      at: 0,
    });
    expect(read({ callee: "instance_double", args: ["Order"] })).toEqual({
      replaces: "standIn",
      at: null,
    });
    expect(
      read({
        callee: "instance_double",
        args: ["Order"],
        chainedWith: "as_stubbed_const",
      }),
    ).toEqual({ replaces: "standIn", at: 0 });
  });
});
