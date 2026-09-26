import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { emitRequireFacts } from "./facts.js";
import { parseRuby } from "./parser.js";

import type { RbNode } from "./parser.js";

async function requiresOf(
  source: string,
  known: readonly string[],
): Promise<string[][]> {
  const tree = await parseRuby(source);
  const db = new Database();
  emitRequireFacts(
    db,
    "/app/jobs/report_job.rb",
    tree.rootNode as unknown as RbNode,
    new Set(known),
  );
  return db.facts("importsFile").map((row) => row.map(String));
}

describe("emitRequireFacts", () => {
  it("records a require_relative of a file in the run as a file the requiring file imports", async () => {
    expect(
      await requiresOf('require_relative "../models/orders"\n', [
        "/app/models/orders.rb",
      ]),
    ).toEqual([["/app/jobs/report_job.rb", "/app/models/orders.rb"]]);
  });

  it("records nothing for a file outside the run or a plain require", async () => {
    expect(
      await requiresOf('require_relative "vendored"\nrequire "json"\n', []),
    ).toEqual([]);
  });
});
