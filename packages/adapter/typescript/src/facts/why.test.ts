// The why session over a small project on disk: point at an
// expression the way the CLI does, and check the witness proof comes
// back as a chain a person could follow, including through a factory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WhySession } from "./why.js";

describe("WhySession", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "factory.ts"),
      [
        "export function makeHandler(fn: () => string) {",
        "  return () => fn();",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "src", "app.ts"),
      [
        'import { makeHandler } from "./factory.js";',
        "",
        "function inner(): string {",
        '  return "ok";',
        "}",
        "",
        "export const handler = makeHandler(inner);",
        "",
        "export function run(): string {",
        "  return handler();",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("explains a resolution through an imported factory", () => {
    const session = new WhySession({ dir });
    const value = session.findExpression("src/app.ts", 10, "handler");
    expect(value).not.toBeNull();

    const explained = session.explain(value as NonNullable<typeof value>);
    expect(explained).not.toBeNull();
    expect(explained?.target.name).toBe("inner");
    expect(explained?.target.file).toBe(path.join("src", "app.ts"));

    const rules = explained?.explanation.steps.map((step) => step.rule);
    expect(rules).toContain("alias");
    expect(rules).toContain("factory unwrap");
    // The factory itself arrived through an import, and that chain
    // shows under the unwrap hop rather than vanishing into it.
    const unwrap = explained?.explanation.steps.find(
      (step) => step.rule === "factory unwrap",
    );
    expect(
      unwrap?.notes.some((note) => note.includes("is imported from")),
    ).toBe(true);
    expect(explained?.stats.baseFacts).toBeGreaterThan(0);
    expect(explained?.stats.evaluateMs).toBeGreaterThanOrEqual(0);
  });

  it("finds the callee of a recorded call inside a line range", () => {
    const session = new WhySession({ dir });
    const callee = session.findCallee("src/app.ts", 9, 11, "handler");
    expect(callee).not.toBeNull();
    expect(callee?.getText()).toBe("handler");
  });

  it("returns null for a name the line does not contain", () => {
    const session = new WhySession({ dir });
    expect(session.findExpression("src/app.ts", 10, "ghost")).toBeNull();
    expect(session.findExpression("src/missing.ts", 1, "handler")).toBeNull();
  });
});
