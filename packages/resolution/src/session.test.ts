// The proof pass a why session shares: given a fact base and a key,
// it reruns the rules with witnesses and renders the one chain the key
// resolves along, or says nothing when there is no single answer.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { RESOLUTION_RULES } from "./index.js";
import { explainResolvedKey } from "./session.js";

import type { ValueLocation } from "./session.js";

function factsOf(facts: Array<[string, ...string[]]>): Database {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return db;
}

const LOCATIONS: Record<string, ValueLocation> = {
  x: { name: "x", file: "app.py", line: 3 },
  h: { name: "h", file: "app.py", line: 1 },
  handlerFn: { name: "handler", file: "lib.py", line: 7 },
};

const locate = (key: string): ValueLocation | null => LOCATIONS[key] ?? null;
const displayPath = (key: string): string => `<${key}>`;

describe("explainResolvedKey", () => {
  it("renders the chain in source terms and counts what the pass derived", () => {
    const db = factsOf([
      ["func", "handlerFn"],
      ["exportsAs", "lib", "handler", "handlerFn"],
      ["imports", "h", "lib", "handler"],
      ["binds", "x", "h"],
    ]);

    const explained = explainResolvedKey({
      db,
      rules: RESOLUTION_RULES,
      key: "x",
      locate,
      displayPath,
    });

    expect(explained).not.toBeNull();
    expect(explained?.target).toEqual(LOCATIONS.handlerFn);
    expect(explained?.chain).toEqual([
      "x (app.py:3)",
      "h (app.py:1)",
      "handler (lib.py:7)",
    ]);
    expect(explained?.lines).toContain(
      "  h (app.py:1) is imported from <lib> under the name handler",
    );
    expect(explained?.stats.baseFacts).toBe(4);
    expect(explained?.stats.derivedFacts).toBeGreaterThan(0);
    expect(db.size("resolves")).toBe(0);
  });

  it("lets a language's own phrase say a step", () => {
    const db = factsOf([
      ["func", "handlerFn"],
      ["binds", "x", "handlerFn"],
    ]);

    const explained = explainResolvedKey({
      db,
      rules: RESOLUTION_RULES,
      key: "x",
      locate,
      displayPath,
      phrases: {
        alias: ({ tuple, describe }) => ({
          reason: `${describe(tuple[0])} names ${describe(tuple[1])}`,
        }),
      },
    });

    expect(explained?.lines).toContain(
      "  x (app.py:3) names handler (lib.py:7)",
    );
  });

  it("answers nothing for a key that resolves to two functions", () => {
    const db = factsOf([
      ["func", "aFn"],
      ["func", "bFn"],
      ["binds", "x", "either"],
      ["fallbackBranch", "either", "aFn"],
      ["fallbackBranch", "either", "bFn"],
    ]);

    expect(
      explainResolvedKey({
        db,
        rules: RESOLUTION_RULES,
        key: "x",
        locate,
        displayPath,
      }),
    ).toBeNull();
  });

  it("answers nothing when the target was never indexed", () => {
    const db = factsOf([
      ["func", "elsewhereFn"],
      ["binds", "x", "elsewhereFn"],
    ]);

    expect(
      explainResolvedKey({
        db,
        rules: RESOLUTION_RULES,
        key: "x",
        locate,
        displayPath,
      }),
    ).toBeNull();
  });
});
