import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { readTestMetadata } from "@suss/behavioral-ir";

import { declares, optionsSchema, rspecFramework } from "./index.js";

const FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../../fixtures/covered-by-rspec",
);

async function extract(files?: string[]) {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(FIXTURE),
    packs: [rspecFramework(files === undefined ? {} : { files })],
    workspaceRoot: FIXTURE,
    cacheDir: null,
  });
  return summaries;
}

describe("rspecFramework", () => {
  it("discovers no routes and reads spec files as tests", () => {
    const pack = rspecFramework();
    const cases = pack.tests?.[0]?.cases;
    expect(pack.discovery).toEqual([]);
    expect(cases?.files).toEqual({ matching: ["*_spec.rb"] });
    expect(cases?.calls?.from).toEqual({ origin: "global", paths: ["RSpec"] });
    expect(cases?.calls?.topLevelCases).toBe(false);
  });

  it("runs a let! and a subject! before every example, as the adapter reads them as values too", () => {
    const [pattern] = rspecFramework().tests ?? [];
    const before = pattern?.cases.before?.calls ?? [];
    expect(before).toEqual(expect.arrayContaining(pattern?.eagerValues ?? []));
    expect(before).toEqual(
      expect.arrayContaining(pattern?.subjectNames.eager ?? []),
    );
  });

  it("hands the file list it was given to the pattern", () => {
    expect(
      rspecFramework({ files: ["spec/order_spec.rb"] }).tests?.[0]?.cases.files
        .listed,
    ).toEqual(["spec/order_spec.rb"]);
  });

  it("refuses an option it does not read", () => {
    expect(optionsSchema.safeParse({ file: "x" }).success).toBe(false);
  });

  it("lists no dependency, so suss init never suggests it", () => {
    expect(declares.dependencies).toEqual([]);
  });
});

describe("the covered-by fixture", () => {
  it("reads each example, whether it runs, and what it mocks", async () => {
    const tests = (await extract())
      .filter((one) => one.kind === "test")
      .map((one) => ({
        name: one.identity.name,
        file: one.location.file,
        test: readTestMetadata(one),
      }));

    expect(tests).toEqual([
      {
        name: "Order > cancel > marks the order cancelled",
        file: "spec/models/order_spec.rb",
        test: {},
      },
      {
        name: "Order > cancel > refunds the payment",
        file: "spec/models/order_spec.rb",
        test: {},
      },
      {
        name: "Order > cancel > cancels twice without harm",
        file: "spec/models/order_spec.rb",
        test: { skipped: true },
      },
      {
        name: "Order > a cancelled order > reads back as cancelled",
        file: "spec/models/order_spec.rb",
        test: {},
      },
      {
        name: "Order > is never read",
        file: "spec/models/unlisted_spec.rb",
        test: {},
      },
      {
        name: "Checkout > cancels on a failed checkout",
        file: "spec/services/checkout_spec.rb",
        test: {
          mocks: [
            {
              module: "app/models/order.rb",
              name: "cancel",
              written:
                "allow(Order).to receive(:cancel).and_return({ status: :cancelled })",
            },
          ],
        },
      },
    ]);
  });

  it("reads only the listed spec files", async () => {
    const files = new Set(
      (await extract(["spec/services/checkout_spec.rb"]))
        .filter((one) => one.kind === "test")
        .map((one) => one.location.file),
    );
    expect([...files]).toEqual(["spec/services/checkout_spec.rb"]);
  });
});
