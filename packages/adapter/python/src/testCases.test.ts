import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTestMetadata } from "@suss/behavioral-ir";

import { extractPythonProject, findPythonFiles } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PyTestCases, PythonPack } from "./pack.js";

/** What a pytest pack declares, written out here since the adapter cannot depend on the pack. */
const RUNNER: PyTestCases = {
  filePatterns: ["test_*.py", "*_test.py"],
  functionPrefix: "test",
  classPrefix: "Test",
  caseBaseClasses: ["unittest.TestCase"],
  setUp: {
    module: ["setup_module"],
    function: ["setup_function"],
    testClass: ["setup_class", "setup_method"],
    caseClass: ["setUpClass", "setUp"],
  },
  usesFixtureMarkers: ["pytest.mark.usefixtures"],
  fixtureDecorators: ["pytest.fixture"],
  fixtureNameKeyword: "name",
  autouseKeyword: "autouse",
  sharedFixtureFiles: ["conftest.py"],
  skipDecorators: ["pytest.mark.skip", "pytest.mark.xfail", "unittest.skip"],
  markerVariable: "pytestmark",
  reservedParameters: ["self", "request"],
  mocks: {
    patchers: ["unittest.mock.patch", "unittest.mock.patch.object"],
    fixturePatchers: [
      { fixture: "mocker", methods: ["patch", "patch.object"] },
      { fixture: "monkeypatch", methods: ["setattr"] },
    ],
  },
};

function runner(extra: Partial<PyTestCases> = {}): PythonPack {
  return {
    name: "pytest",
    protocol: "in-process",
    discovery: [],
    tests: [{ ...RUNNER, ...extra }],
  };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-tests-"));
  write("app/__init__.py", "");
  write(
    "app/orders.py",
    [
      "def cancel_order(order_id):",
      "    return archive(order_id)",
      "",
      "def archive(order_id):",
      "    return order_id",
      "",
      "class OrderService:",
      "    def cancel(self, order_id):",
      "        return cancel_order(order_id)",
    ].join("\n"),
  );
  write(
    "app/checkout.py",
    [
      "from app.orders import cancel_order",
      "",
      "def checkout(order_id):",
      "    return cancel_order(order_id)",
    ].join("\n"),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, text: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${text}\n`);
}

async function extract(
  packs: PythonPack[] = [runner()],
): Promise<BehavioralSummary[]> {
  const { summaries } = await extractPythonProject({
    files: findPythonFiles(root),
    packs,
    roots: [root],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

function testNamed(
  summaries: readonly BehavioralSummary[],
  name: string,
): BehavioralSummary {
  const found = summaries.find(
    (one) => one.kind === "test" && one.identity.name === name,
  );
  if (found === undefined) {
    throw new Error(
      `no test ${name}; tests: ${summaries
        .filter((one) => one.kind === "test")
        .map((one) => one.identity.name)
        .join(", ")}`,
    );
  }
  return found;
}

/** Each call the unit makes, with an arrow when it was linked to a summary. */
function callsOf(unit: BehavioralSummary): string[] {
  return unit.transitions.flatMap((transition) =>
    transition.effects.flatMap((effect) =>
      effect.type === "invocation"
        ? [`${effect.callee}${effect.summary === undefined ? "" : " ->"}`]
        : [],
    ),
  );
}

describe("pytest tests as test units", () => {
  it("names a test by its classes and then its own name", async () => {
    write(
      "tests/test_orders.py",
      [
        "from app.orders import cancel_order",
        "",
        "def test_cancels():",
        "    cancel_order('o-1')",
        "",
        "class TestCancel:",
        "    class TestTwice:",
        "        def test_changes_nothing(self):",
        "            cancel_order('o-1')",
        "",
        "    def helper(self):",
        "        pass",
        "",
        "class Helpers:",
        "    def test_not_collected(self):",
        "        pass",
      ].join("\n"),
    );
    const summaries = await extract();
    const tests = summaries.filter((one) => one.kind === "test");

    expect(tests.map((one) => one.identity.name).sort()).toEqual([
      "TestCancel > TestTwice > test_changes_nothing",
      "test_cancels",
    ]);
    expect(tests[0]?.identity.boundaryBinding).toBeNull();
    expect(callsOf(testNamed(summaries, "test_cancels"))).toEqual([
      "cancel_order ->",
    ]);
  });

  it("leaves the module alone when its first line is a test", async () => {
    write(
      "tests/conftest.py",
      "import pytest\n\n@pytest.fixture\ndef order():\n    return 1",
    );
    write("tests/test_first.py", "def test_first(order):\n    pass");
    const [withPack, without] = [await extract(), await extract([])];
    const loads = (summaries: BehavioralSummary[]) =>
      summaries.filter((one) => one.kind === "module-init").length;

    expect(loads(withPack)).toBe(loads(without));
  });

  it("reads nothing as a test without the pack", async () => {
    write("tests/test_orders.py", "def test_cancels():\n    pass");
    const summaries = await extract([]);
    expect(summaries.some((one) => one.kind === "test")).toBe(false);
  });

  it("reads only the files on the list, and only files pytest collects", async () => {
    write("tests/test_orders.py", "def test_listed():\n    pass");
    write("tests/test_refunds.py", "def test_unlisted():\n    pass");
    write("tests/helpers.py", "def test_not_a_test_file():\n    pass");
    const summaries = await extract([
      runner({ files: ["tests/test_orders.py"] }),
    ]);
    expect(
      summaries
        .filter((one) => one.kind === "test")
        .map((one) => one.identity.name),
    ).toEqual(["test_listed"]);
  });

  it("collects a TestCase subclass whatever its name, and runs setUp first", async () => {
    write(
      "tests/base.py",
      [
        "import unittest",
        "",
        "class OrdersCase(unittest.TestCase):",
        "    pass",
      ].join("\n"),
    );
    write(
      "tests/test_service.py",
      [
        "from app.orders import OrderService, archive",
        "from tests.base import OrdersCase",
        "",
        "class ServiceChecks(OrdersCase):",
        "    def setUp(self):",
        "        archive('o-0')",
        "",
        "    def test_cancel(self):",
        "        OrderService().cancel('o-1')",
      ].join("\n"),
    );
    const summaries = await extract();
    const test = testNamed(summaries, "ServiceChecks > test_cancel");
    expect(callsOf(test)[0]).toBe("setUp ->");
  });

  it("follows a test into the fixtures it asks for, through conftest and an import", async () => {
    write(
      "tests/conftest.py",
      [
        "import pytest",
        "from app.orders import cancel_order",
        "",
        "@pytest.fixture",
        "def cancelled():",
        "    return cancel_order('o-1')",
        "",
        "@pytest.fixture(autouse=True)",
        "def clean_slate():",
        "    pass",
      ].join("\n"),
    );
    write(
      "tests/fixtures.py",
      [
        "import pytest",
        "from app.checkout import checkout",
        "",
        "@pytest.fixture(name='paid')",
        "def paid_order(cancelled):",
        "    return checkout('o-2')",
      ].join("\n"),
    );
    write(
      "tests/api/test_orders.py",
      [
        "from tests.fixtures import paid_order",
        "",
        "def test_reads(paid, request):",
        "    pass",
      ].join("\n"),
    );
    const summaries = await extract();
    const test = testNamed(summaries, "test_reads");

    expect(callsOf(test)).toEqual(["clean_slate ->", "paid ->"]);
    const fixture = summaries.find((one) => one.identity.name === "paid_order");
    expect(fixture === undefined ? [] : callsOf(fixture)).toEqual([
      "cancelled ->",
      "checkout ->",
    ]);
  });

  it("marks a test skipped by its decorator, its class, or the module's pytestmark", async () => {
    write(
      "tests/test_skips.py",
      [
        "import pytest",
        "import unittest",
        "",
        "@pytest.mark.skip(reason='later')",
        "def test_decorated():",
        "    pass",
        "",
        "@unittest.skip('later')",
        "class TestSkippedClass:",
        "    def test_inside(self):",
        "        pass",
        "",
        "def test_runs():",
        "    pass",
      ].join("\n"),
    );
    write(
      "tests/test_marked.py",
      [
        "import pytest",
        "",
        "pytestmark = [pytest.mark.xfail]",
        "",
        "def test_expected_to_fail():",
        "    pass",
      ].join("\n"),
    );
    const summaries = await extract();
    const skipped = (name: string) =>
      readTestMetadata(testNamed(summaries, name))?.skipped === true;

    expect(skipped("test_decorated")).toBe(true);
    expect(skipped("TestSkippedClass > test_inside")).toBe(true);
    expect(skipped("test_expected_to_fail")).toBe(true);
    expect(skipped("test_runs")).toBe(false);
  });

  it("records each patcher as the file and member it replaces", async () => {
    write(
      "tests/test_mocks.py",
      [
        "from unittest import mock",
        "from unittest.mock import patch",
        "from app.orders import OrderService",
        "from app import checkout",
        "",
        "@patch('app.checkout.cancel_order')",
        "def test_decorated(cancel):",
        "    checkout.checkout('o-1')",
        "",
        "def test_in_body():",
        "    with mock.patch.object(OrderService, 'cancel'):",
        "        pass",
        "",
        "def test_mocker(mocker, monkeypatch):",
        "    mocker.patch('app.orders.archive')",
        "    monkeypatch.setattr(checkout, 'checkout', None)",
      ].join("\n"),
    );
    const summaries = await extract();
    const mocksOf = (name: string) =>
      readTestMetadata(testNamed(summaries, name))?.mocks;

    expect(mocksOf("test_decorated")).toEqual([
      {
        module: "app/orders.py",
        name: "cancel_order",
        written: "patch('app.checkout.cancel_order')",
      },
    ]);
    expect(mocksOf("test_in_body")).toEqual([
      {
        module: "app/orders.py",
        name: "cancel",
        written: "mock.patch.object(OrderService, 'cancel')",
      },
    ]);
    expect(mocksOf("test_mocker")).toEqual([
      {
        module: "app/orders.py",
        name: "archive",
        written: "mocker.patch('app.orders.archive')",
      },
      {
        module: "app/checkout.py",
        name: "checkout",
        written: "monkeypatch.setattr(checkout, 'checkout', None)",
      },
    ]);
  });

  it("runs the fixtures a usefixtures marker lists, from the test, its class or pytestmark", async () => {
    write(
      "tests/conftest.py",
      [
        "import pytest",
        "from unittest.mock import patch",
        "from app.orders import cancel_order, archive",
        "",
        "@pytest.fixture",
        "def cancelled():",
        "    cancel_order('o-1')",
        "",
        "@pytest.fixture",
        "def archived():",
        "    archive('o-1')",
        "",
        "@pytest.fixture",
        "def no_archive():",
        "    with patch('app.orders.archive'):",
        "        yield",
      ].join("\n"),
    );
    write(
      "tests/test_marked.py",
      [
        "import pytest",
        "",
        "pytestmark = pytest.mark.usefixtures('archived')",
        "",
        "@pytest.mark.usefixtures('cancelled', 'no_archive')",
        "def test_reads(cancelled):",
        "    pass",
        "",
        "@pytest.mark.usefixtures('cancelled')",
        "class TestOrders:",
        "    def test_lists(self):",
        "        pass",
      ].join("\n"),
    );
    const summaries = await extract();

    expect(callsOf(testNamed(summaries, "test_reads"))).toEqual([
      "no_archive ->",
      "archived ->",
      "cancelled ->",
    ]);
    expect(callsOf(testNamed(summaries, "TestOrders > test_lists"))).toEqual([
      "cancelled ->",
      "archived ->",
    ]);
    expect(
      readTestMetadata(testNamed(summaries, "test_reads"))?.mocks?.map(
        (one) => one.name,
      ),
    ).toEqual(["archive"]);
  });

  it("runs the module's and each class's setup before a test, a base class's included", async () => {
    write(
      "tests/base.py",
      [
        "import unittest",
        "from app.orders import archive",
        "",
        "class OrdersCase(unittest.TestCase):",
        "    @classmethod",
        "    def setUpClass(cls):",
        "        archive('o-0')",
      ].join("\n"),
    );
    write(
      "tests/test_setup.py",
      [
        "from app.orders import cancel_order, archive",
        "from tests.base import OrdersCase",
        "",
        "def setup_module(module):",
        "    archive('o-1')",
        "",
        "def setup_function(function):",
        "    cancel_order('o-1')",
        "",
        "def test_plain():",
        "    pass",
        "",
        "class TestOrders:",
        "    def setup_method(self, method):",
        "        cancel_order('o-2')",
        "",
        "    def test_in_class(self):",
        "        pass",
        "",
        "class OrderChecks(OrdersCase):",
        "    def test_case(self):",
        "        pass",
      ].join("\n"),
    );
    const summaries = await extract();

    expect(callsOf(testNamed(summaries, "test_plain"))).toEqual([
      "setup_module ->",
      "setup_function ->",
    ]);
    expect(callsOf(testNamed(summaries, "TestOrders > test_in_class"))).toEqual(
      ["setup_module ->", "setup_method ->"],
    );
    expect(callsOf(testNamed(summaries, "OrderChecks > test_case"))).toEqual([
      "setup_module ->",
      "setUpClass ->",
    ]);
  });

  it("counts a patch in a fixture the test runs through", async () => {
    write(
      "tests/test_through.py",
      [
        "import pytest",
        "from unittest.mock import patch",
        "",
        "@pytest.fixture",
        "def no_archive():",
        "    with patch('app.orders.archive'):",
        "        yield",
        "",
        "def test_cancel(no_archive):",
        "    pass",
      ].join("\n"),
    );
    const summaries = await extract();
    expect(
      readTestMetadata(testNamed(summaries, "test_cancel"))?.mocks?.map(
        (one) => one.name,
      ),
    ).toEqual(["archive"]);
  });

  it("keeps a patch of a package outside the project as written", async () => {
    write(
      "tests/test_outside.py",
      [
        "from unittest.mock import patch",
        "",
        "@patch('requests.get')",
        "def test_fetch(get):",
        "    pass",
      ].join("\n"),
    );
    const summaries = await extract();
    expect(readTestMetadata(testNamed(summaries, "test_fetch"))?.mocks).toEqual(
      [{ module: "requests", name: "get", written: "patch('requests.get')" }],
    );
  });
});
