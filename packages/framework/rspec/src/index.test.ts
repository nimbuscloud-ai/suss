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
    expect(pack.discovery).toEqual([]);
    expect(pack.tests?.[0]?.filePatterns).toEqual(["*_spec.rb"]);
    expect(pack.tests?.[0]?.files).toBeUndefined();
  });

  it("hands the file list it was given to the pattern", () => {
    expect(
      rspecFramework({ files: ["spec/order_spec.rb"] }).tests?.[0]?.files,
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
