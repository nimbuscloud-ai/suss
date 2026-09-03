/**
 * The why questions across languages, and the crash guard: a thrown
 * adapter error becomes a caveat on the answer, never a stack trace.
 * `@suss/adapter-typescript` is stubbed out so a thrown parse error
 * can be exercised without opening a ts-morph project; Python runs
 * through its own session, on source on disk, since that is the
 * question this change adds an answer to.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { preloadPythonGrammar } from "@suss/adapter-python";
import { storageBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary } from "@suss/behavioral-ir";

let explainThrows: string | null = null;

vi.mock("@suss/adapter-typescript", () => ({
  TypeScriptWhySession: class {
    findExpression() {
      return {};
    }
    findCallee() {
      return {};
    }
    explain() {
      if (explainThrows !== null) {
        throw new Error(explainThrows);
      }
      return null;
    }
  },
}));

const { askWhy } = await import("./askWhy.js");
const { loadedSummaries } = await import("./loadedSummaries.js");

import type { AskOptions, ParsedQuestion } from "./ask.js";

const CONFIDENT = { source: "inferred_static", level: "high" } as const;

/** The caller, whose one call the run resolved to the helper below. */
const caller: BehavioralSummary = {
  kind: "handler",
  location: {
    file: "src/orders.ts",
    range: { start: 3, end: 6 },
    exportName: "getOrder",
  },
  identity: {
    name: "getOrder",
    exportPath: ["getOrder"],
    boundaryBinding: null,
    id: "test::src/orders.ts::getOrder",
  },
  inputs: [],
  transitions: [
    {
      id: "getOrder:default",
      conditions: [],
      output: { type: "return", value: null },
      effects: [
        {
          type: "invocation",
          callee: "readRow",
          args: [],
          async: true,
          summary: "test::src/orderStore.ts::readRow",
        },
      ],
      location: { start: 4, end: 5 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: CONFIDENT,
};

/** The helper, which is where the storage access is written. */
const helper: BehavioralSummary = {
  kind: "library",
  location: {
    file: "src/orderStore.ts",
    range: { start: 1, end: 3 },
    exportName: "readRow",
  },
  identity: {
    name: "readRow",
    exportPath: ["readRow"],
    boundaryBinding: null,
    id: "test::src/orderStore.ts::readRow",
  },
  inputs: [],
  transitions: [
    {
      id: "readRow:default",
      conditions: [],
      output: { type: "return", value: null },
      effects: [
        {
          type: "interaction",
          binding: storageBinding({
            recognition: "aws-dynamodb",
            storageSystem: "aws.dynamodb",
            scope: "default",
            container: "orders",
            accessPath: null,
          }),
          callee: "client.send",
          interaction: {
            class: "storage-access",
            kind: "read",
            fields: [],
            operation: "get",
          },
        },
      ],
      location: { start: 1, end: 3 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: CONFIDENT,
};

describe("askWhy", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-askwhy-"));
    explainThrows = null;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function options(): AskOptions {
    return { question: "", project: dir };
  }

  describe("on Python source", () => {
    beforeAll(async () => {
      await preloadPythonGrammar();
    });

    it("answers a why-resolves question by reading the project directly", () => {
      fs.writeFileSync(
        path.join(dir, "helpers.py"),
        "def fetch():\n    return 1\n",
      );
      fs.writeFileSync(
        path.join(dir, "app.py"),
        "from helpers import fetch\n\nx = fetch()\n",
      );
      const question: ParsedQuestion = {
        shape: "whyResolves",
        subject: "fetch",
        at: { file: "app.py", line: 3 },
        object: "fetch",
      };

      const answer = askWhy(question, options(), () => {
        throw new Error("a resolve question should not load summaries");
      });

      expect(answer.found).toBe(true);
      expect(answer.headline).toContain("resolves to fetch (helpers.py:1)");
    });

    it("says so and exits without a crash when a name is not on that line", () => {
      fs.writeFileSync(path.join(dir, "app.py"), "x = 1\n");
      const question: ParsedQuestion = {
        shape: "whyResolves",
        subject: "nope",
        at: { file: "app.py", line: 1 },
        object: "nope",
      };

      const answer = askWhy(question, options(), () => {
        throw new Error("a resolve question should not load summaries");
      });

      expect(answer.found).toBe(false);
      expect(answer.headline).toContain("Nothing written as nope");
    });
  });

  it("turns a thrown parse error into a caveat instead of a crash", () => {
    fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1;\n");
    explainThrows = "Expected the module specifier to be a string literal";
    const question: ParsedQuestion = {
      shape: "whyResolves",
      subject: "x",
      at: { file: "app.ts", line: 1 },
      object: "y",
    };

    let answer: ReturnType<typeof askWhy> | undefined;
    expect(() => {
      answer = askWhy(question, options(), () => {
        throw new Error("a resolve question should not load summaries");
      });
    }).not.toThrow();

    expect(answer?.found).toBe(false);
    expect(answer?.caveats.join(" ")).toContain(
      "Expected the module specifier to be a string literal",
    );
    expect(answer?.caveats.join(" ")).toContain("--project");
  });

  it("shows a reach chain without its resolution steps when a hop throws, saying so once", () => {
    explainThrows = "Expected the module specifier to be a string literal";
    const question: ParsedQuestion = {
      shape: "whyReaches",
      subject: "getOrder",
      object: "aws.dynamodb:orders",
    };

    let answer: ReturnType<typeof askWhy> | undefined;
    expect(() => {
      answer = askWhy(question, options(), () =>
        loadedSummaries([caller, helper]),
      );
    }).not.toThrow();

    expect(answer?.found).toBe(true);
    expect(answer?.items.map((item) => item.text)).toContain(
      "getOrder -> readRow -> client.send",
    );
    const caveatText = answer?.caveats.join(" ") ?? "";
    expect(caveatText).toContain("does not line up with these summaries");
    expect(caveatText).toContain("--project");
    expect(
      answer?.caveats.filter((c) => c.includes("does not line up")),
    ).toHaveLength(1);
  });
});
