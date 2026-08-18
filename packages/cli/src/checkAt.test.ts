import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dao,
  dashboard,
  indexContract,
  route,
  routeClient,
} from "./__fixtures__/oneThing.js";
import { checkDir } from "./check.js";
import { checkAt } from "./checkAt.js";

describe("suss check --at", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-at-"));
    fs.writeFileSync(
      path.join(dir, "infra.json"),
      JSON.stringify([indexContract]),
    );
    fs.writeFileSync(
      path.join(dir, "app.json"),
      JSON.stringify([dao, dashboard, route, routeClient]),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function report(
    at: string,
    options: { json?: boolean } = {},
  ): {
    output: string;
    result: ReturnType<typeof checkAt>;
  } {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = checkAt({ dir, at, ...options });
      return { output: chunks.join(""), result };
    } finally {
      process.stdout.write = original;
    }
  }

  it("reports on a file, and leaves out what other files disagree about", () => {
    const { output, result } = report("src/editions/dao.ts");

    expect(output).toContain("src/editions/dao.ts");
    expect(output).toContain("wordCount");
    expect(output).not.toContain("503");
    expect(result.matched).toBe(true);
    expect(result.hasErrors).toBe(true);
  });

  it("reports on a file and a line, taking the branch that line falls in", () => {
    const { output, result } = report("src/editions/dao.ts:45");

    expect(output).toContain("line 45");
    expect(output).toContain("1 branch over that line");
    expect(output).toContain("wordCount");
    expect(result.findings).toHaveLength(1);
  });

  it("says the second unit in a file has nothing wrong with it", () => {
    const { output, result } = report("src/editions/dao.ts:78");

    expect(output).toContain("No findings here.");
    expect(output).toContain("aws.dynamodb:editions#by-publication");
    expect(result.findings).toEqual([]);
    expect(result.hasErrors).toBe(false);
  });

  it("leaves out a branch the line does not fall in", () => {
    const inTheBadBranch = report("src/editions/routes.ts:25");
    const inTheGoodOne = report("src/editions/routes.ts:15");

    expect(inTheBadBranch.result.findings).toHaveLength(1);
    expect(inTheBadBranch.output).toContain("503");
    expect(inTheGoodOne.result.findings).toEqual([]);
  });

  it("says which boundary the unit at that line serves", () => {
    const { output } = report("src/editions/routes.ts:15");

    expect(output).toContain("provides src/editions/routes.ts::listEditions");
    expect(output).toContain("GET /editions");
  });

  it("reports on a boundary key, both sides of it", () => {
    const { output, result } = report("aws.dynamodb:editions#by-publication");

    expect(output).toContain("Compared 1 boundary here:");
    expect(output).toContain("src/editions/dao.ts::byPublication");
    expect(output).toContain("src/editions/dao.ts::forDashboard");
    expect(output).not.toContain("503");
    expect(result.findings).toHaveLength(1);
  });

  it("reports on a route the same way", () => {
    const { output } = report("GET /editions");

    expect(output).toContain("503");
    expect(output).not.toContain("wordCount");
  });

  it("reports on a summary id", () => {
    const { result } = report("src/editions/dao.ts::byPublication");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("boundaryFieldUnknown");
  });

  it("says so when the target matches nothing, and does not exit clean", () => {
    const { output, result } = report("src/editions/nowhere.ts");

    expect(output).toContain("Nothing here is at src/editions/nowhere.ts");
    expect(result.matched).toBe(false);
    expect(result.hasErrors).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("says which line the file does cover when the line does not", () => {
    const { output, result } = report("src/editions/dao.ts:5");

    expect(output).toContain("Nothing here covers line 5");
    expect(output).toContain("30-60");
    expect(result.matched).toBe(false);
  });

  it("says what it could not read about the target", () => {
    const { output } = report("src/editions/dao.ts");

    expect(output).toContain("could not read");
    expect(output).toContain("loadCursor");
  });

  it("leaves the gap out when the target has none", () => {
    const { output } = report("src/editions/routes.ts");

    expect(output).not.toContain("loadCursor");
  });

  it("writes the same findings the full run does for that target", () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let full: ReturnType<typeof checkDir>;
    try {
      full = checkDir({ dir });
    } finally {
      process.stdout.write = original;
    }
    chunks.length = 0;

    const scoped = report("src/editions/dao.ts").result;
    const wanted = full.findings.filter(
      (finding) =>
        finding.provider.summary.startsWith("src/editions/dao.ts") ||
        finding.consumer.summary.startsWith("src/editions/dao.ts"),
    );

    expect(scoped.findings).toEqual(wanted);
    for (const finding of scoped.findings) {
      expect(full.findings).toContainEqual(finding);
    }
  });

  it("writes JSON an agent can read", () => {
    const { output } = report("aws.dynamodb:editions#by-publication", {
      json: true,
    });
    const parsed = JSON.parse(output) as {
      at: string;
      matched: boolean;
      target: { kind: string; summaries: string[] };
      touches: Array<{ boundary: string; relations: string[] }>;
      findings: unknown[];
      gaps: Array<{ summary: string }>;
    };

    expect(parsed.at).toBe("aws.dynamodb:editions#by-publication");
    expect(parsed.matched).toBe(true);
    expect(parsed.target.kind).toBe("boundary");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.touches).toContainEqual(
      expect.objectContaining({
        boundary: "aws.dynamodb:editions#by-publication",
        relations: ["reads"],
      }),
    );
    expect(parsed.gaps[0].summary).toBe("src/editions/dao.ts::byPublication");
  });

  it("writes JSON when the target matches nothing", () => {
    const { output } = report("nowhere-at-all", { json: true });
    const parsed = JSON.parse(output) as { matched: boolean; message: string };

    expect(parsed.matched).toBe(false);
    expect(parsed.message).toContain("Nothing here is at nowhere-at-all");
  });
});
