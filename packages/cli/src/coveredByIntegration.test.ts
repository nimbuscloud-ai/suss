/**
 * A PRD whose scenarios list the tests that cover them, checked end to
 * end for each runner: `extract -f <runner> --intent` reads only the
 * test files the PRD lists, and `check --intent` reports each way a
 * covering test can fail to back its scenario.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CheckIntentResult } from "@suss/checker-intent";

let root: string;

function write(relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function run(argv: string[]): Promise<number> {
  const swallow = (() => true) as typeof process.stdout.write;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = swallow;
  process.stderr.write = swallow;
  try {
    return await runCli(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const TEST_FILE = `
import { describe, expect, it, vi } from "vitest";
import { cancelOrder } from "./orders";
import { refundOrder } from "./refunds";

describe("cancel", () => {
  it("marks the order cancelled", () => {
    expect(cancelOrder("o-1").status).toBe("cancelled");
  });

  it("refunds the payment", () => {
    expect(refundOrder("o-1")).toBe(true);
  });

  it.skip("cancels twice without harm", () => {
    cancelOrder("o-1");
    cancelOrder("o-1");
  });
});
`;

const MOCKED_TEST_FILE = `
import { it, vi } from "vitest";
import { checkout } from "./checkout";

vi.mock("./orders", () => ({ cancelOrder: () => ({ status: "cancelled" }) }));

it("cancels on a failed checkout", () => {
  checkout("o-1");
});
`;

const PRD = `
kind: prd
title: Cancel an order
purpose: A customer cancels an order they no longer want.
audience: customers
scenarios:
  - title: cancelled
    when: a customer cancels an order
    expect: the order is cancelled
    coveredBy: src/orders.test.ts > cancel > marks the order cancelled
    about: cancelOrder
  - title: renamed test
    when: a customer cancels an order again
    expect: nothing changes
    coveredBy: src/orders.test.ts > cancel > cancels an order twice
    about: cancelOrder
  - title: wrong subject
    when: a refund follows a cancel
    expect: the payment goes back
    coveredBy: src/orders.test.ts > cancel > refunds the payment
    about: cancelOrder
  - title: skipped
    when: an order is cancelled twice
    expect: the second cancel does nothing
    coveredBy: src/orders.test.ts > cancel > cancels twice without harm
    about: cancelOrder
  - title: mocked
    when: a checkout fails
    expect: the order is cancelled
    coveredBy: src/checkout.test.ts > cancels on a failed checkout
    about: cancelOrder
  - title: nothing yet
    when: an order that shipped is cancelled
    expect: the customer is told it is too late
`;

let summaries: BehavioralSummary[];
let intent: CheckIntentResult;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-covered-by-"));
  write("package.json", JSON.stringify({ name: "orders-api" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, module: "esnext" },
      include: ["src"],
    }),
  );
  write(
    "src/orders.ts",
    'export function cancelOrder(id: string) {\n  return { id, status: "cancelled" };\n}\n',
  );
  write(
    "src/refunds.ts",
    "export function refundOrder(id: string) {\n  return id.length > 0;\n}\n",
  );
  write(
    "src/checkout.ts",
    'import { cancelOrder } from "./orders";\nexport function checkout(id: string) {\n  return cancelOrder(id);\n}\n',
  );
  write("src/orders.test.ts", TEST_FILE);
  write("src/checkout.test.ts", MOCKED_TEST_FILE);
  // A test file no PRD lists, which the run should not read as tests.
  write(
    "src/unlisted.test.ts",
    'import { it } from "vitest";\nit("is never read", () => {});\n',
  );
  write("intent/cancel.prd.yaml", PRD);

  const out = path.join(root, "summaries");
  fs.mkdirSync(out);
  expect(
    await run([
      "extract",
      "-p",
      path.join(root, "tsconfig.json"),
      "-f",
      "vitest",
      "--intent",
      path.join(root, "intent"),
      "--no-cache",
      "-o",
      path.join(out, "code.json"),
    ]),
  ).toBe(0);
  summaries = JSON.parse(
    fs.readFileSync(path.join(out, "code.json"), "utf8"),
  ) as BehavioralSummary[];

  const report = path.join(root, "check.json");
  await run([
    "check",
    "--dir",
    out,
    "--intent",
    path.join(root, "intent"),
    "--json",
    "--allow-empty",
    "-o",
    report,
  ]);
  intent = (
    JSON.parse(fs.readFileSync(report, "utf8")) as {
      intent: CheckIntentResult;
    }
  ).intent;
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function findingFor(title: string) {
  return intent.findings.find((one) => one.scenario?.title === title);
}

describe("a PRD whose scenarios list covering tests", () => {
  it("reads only the test files the PRD lists", () => {
    const testFiles = new Set(
      summaries
        .filter((one) => one.kind === "test")
        .map((one) => one.location.file),
    );
    expect([...testFiles].sort()).toEqual([
      "src/checkout.test.ts",
      "src/orders.test.ts",
    ]);
  });

  it("counts a test that reaches its subject as covering the scenario", () => {
    expect(findingFor("cancelled")).toBeUndefined();
    expect(intent.checked).toContainEqual(
      expect.objectContaining({ kind: "prd", covered: 1, unlinked: 1 }),
    );
  });

  it("reports a test whose title changed as missing, with the titles the file has", () => {
    const finding = findingFor("renamed test");
    expect(finding?.kind).toBe("missingCoveringTest");
    expect(finding?.message).toContain("cancel > marks the order cancelled");
  });

  it("reports a test that reaches something else", () => {
    expect(findingFor("wrong subject")?.kind).toBe("testMissesSubject");
  });

  it("reports a skipped test", () => {
    expect(findingFor("skipped")?.kind).toBe("coveringTestSkipped");
  });

  it("reports a test that reaches its subject only through a mock", () => {
    const finding = findingFor("mocked");
    expect(finding?.kind).toBe("testMissesSubject");
    expect(finding?.message).toContain('vi.mock("./orders")');
  });

  it("reports a scenario with neither a link nor a test", () => {
    expect(findingFor("nothing yet")).toMatchObject({
      kind: "unlinkedScenario",
      severity: "warning",
    });
  });
});

/**
 * The same PRD for each runner in another language, over a fixture
 * project with the same orders, refunds and checkout, and the same
 * wording expected for each finding.
 */
const OTHER_RUNNERS = [
  {
    runner: "pytest",
    lang: "python",
    fixture: "covered-by-pytest",
    mock: 'patch("app.checkout.cancel_order")',
    subject: "app/orders.py::cancel_order",
    titlesListed: "TestCancel::test_marks_the_order_cancelled",
  },
  {
    runner: "rspec",
    lang: "ruby",
    fixture: "covered-by-rspec",
    mock: "allow(Order).to receive(:cancel).and_return({ status: :cancelled })",
    subject: "app/models/order.rb::Order.cancel",
    titlesListed: "Order > cancel > marks the order cancelled",
  },
  {
    runner: "minitest",
    lang: "ruby",
    fixture: "covered-by-minitest",
    mock: "Order.stub(:cancel, { status: :cancelled })",
    subject: "app/models/order.rb::Order.cancel",
    titlesListed: "OrderTest > test_marks_the_order_cancelled",
  },
];

const FIXTURES = path.resolve(import.meta.dirname, "../../../fixtures");

describe.each(OTHER_RUNNERS)("a PRD listing $runner tests", (each) => {
  const project = path.join(FIXTURES, each.fixture);
  let tests: BehavioralSummary[];
  let result: CheckIntentResult;
  let out: string;

  beforeAll(async () => {
    out = fs.mkdtempSync(
      path.join(os.tmpdir(), `suss-covered-by-${each.runner}-`),
    );
    const summaries = path.join(out, "summaries");
    fs.mkdirSync(summaries);
    expect(
      await run([
        "extract",
        "--lang",
        each.lang,
        "--dir",
        project,
        "-f",
        each.runner,
        "--intent",
        path.join(project, "intent"),
        "--no-cache",
        "-o",
        path.join(summaries, "code.json"),
      ]),
    ).toBe(0);
    tests = (
      JSON.parse(
        fs.readFileSync(path.join(summaries, "code.json"), "utf8"),
      ) as BehavioralSummary[]
    ).filter((one) => one.kind === "test");

    const report = path.join(out, "check.json");
    await run([
      "check",
      "--dir",
      summaries,
      "--intent",
      path.join(project, "intent"),
      "--json",
      "--allow-empty",
      "-o",
      report,
    ]);
    result = (
      JSON.parse(fs.readFileSync(report, "utf8")) as {
        intent: CheckIntentResult;
      }
    ).intent;
  }, 120_000);

  afterAll(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  const messageFor = (title: string) =>
    result.findings.find((one) => one.scenario?.title === title);

  it("reads only the test files the PRD lists", () => {
    expect(tests.some((one) => one.location.file.includes("unlisted"))).toBe(
      false,
    );
  });

  it("counts the tests that reach the subject, directly or through a fixture", () => {
    expect(messageFor("cancelled")).toBeUndefined();
    expect(messageFor("through a fixture")).toBeUndefined();
    expect(result.checked).toContainEqual(
      expect.objectContaining({ kind: "prd", covered: 2, unlinked: 1 }),
    );
  });

  it("reports a missing, a skipped and a mocked test with the wording vitest gets", () => {
    expect(messageFor("renamed test")?.kind).toBe("missingCoveringTest");
    expect(messageFor("renamed test")?.message).toContain(
      `has that title. Tests there: ${each.titlesListed}`,
    );
    expect(messageFor("wrong subject")?.message).toMatch(
      new RegExp(`, which never reaches ${each.subject}\\.$`),
    );
    expect(messageFor("skipped")?.message).toMatch(
      /, which is marked to be skipped, so it does not run\.$/,
    );
    expect(messageFor("mocked")?.kind).toBe("testMissesSubject");
    expect(messageFor("mocked")?.message).toContain(
      `reaches ${each.subject} only through a call its mocks replace (${each.mock})`,
    );
  });
});
