import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { intentOutcomes, intentOutcomesCommand } from "./intentOutcomes.js";
import { UsageError } from "./usageError.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-intent-outcomes-"));
  created.push(dir);
  return dir;
}

function capture(fn: () => number): {
  exit: number;
  io: { stdout: string; stderr: string };
} {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = fn();
    return { exit, io: { stdout: out.join(""), stderr: err.join("") } };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const REST_INTENT = `
kind: boundary
name: archive-order
purpose: Archive an order so it leaves the active list.
audience: the operations console
source: author
boundary:
  transport: http
  semantics: rest
  method: POST
  path: /orders/:id/archive
transitions:
  - id: archived
    when:
      - reads: aws.dynamodb:Orders
        finds: something
    response:
      status: 200
  - id: already-archived
    when:
      - reads: aws.dynamodb:Orders
        finds: nothing
    response:
      status: 404
`;

const STORE_INTENT = `
kind: boundary
name: order-writer
purpose: Write an order row.
audience: the archive job
source: author
boundary:
  semantics: function-call
  package: "@acme/orders"
  exportPath: ["writeOrder"]
transitions:
  - id: written
    when: called with an order
    results:
      - writes: aws.dynamodb:Orders
        by: [orderId]
`;

const DRAFT_INTENT = `
kind: boundary
name: get-report
purpose: ""
audience: ""
source: inferred
boundary:
  transport: http
  semantics: rest
  method: GET
  path: /report
transitions:
  - id: 200-ok
    when: every call reaches this outcome
    response:
      status: 200
`;

const PRD = `
kind: prd
title: Archiving an order
purpose: An operator can take an order off the active list.
audience: the operations team
source: author
scenarios:
  - when: the order is active
    expect: it leaves the active list
    link: archive-order.archived
`;

function folderWith(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe("intentOutcomes", () => {
  it("spells each outcome the way a PRD scenario links to it", () => {
    const dir = folderWith({ "archive.intent.yaml": REST_INTENT });

    const listing = intentOutcomes({ from: dir });
    expect(listing.outcomes.map((row) => row.link)).toEqual([
      "archive-order.archived",
      "archive-order.already-archived",
    ]);
  });

  it("says the boundary and the line the id is written on", () => {
    const dir = folderWith({ "archive.intent.yaml": REST_INTENT });

    const [first] = intentOutcomes({ from: dir }).outcomes;
    expect(first.boundary).toBe("POST /orders/{id}/archive");
    expect(first.file).toBe(path.join(dir, "archive.intent.yaml"));
    expect(first.line).toBe(13);
  });

  it("describes a response outcome by its status and its condition", () => {
    const dir = folderWith({ "archive.intent.yaml": REST_INTENT });

    const [, second] = intentOutcomes({ from: dir }).outcomes;
    expect(second.description).toBe(
      "responds 404 when reads aws.dynamodb:Orders finds nothing",
    );
  });

  it("describes an outcome with no ending by what it did", () => {
    const dir = folderWith({ "writer.intent.yaml": STORE_INTENT });

    const [row] = intentOutcomes({ from: dir }).outcomes;
    expect(row.description).toBe(
      "writes aws.dynamodb:Orders when called with an order",
    );
  });

  it("skips a PRD, which links to outcomes rather than declaring any", () => {
    const dir = folderWith({
      "archive.intent.yaml": REST_INTENT,
      "archive.prd.yaml": PRD,
    });

    expect(intentOutcomes({ from: dir }).outcomes).toHaveLength(2);
  });

  it("keeps an uncurated draft's ids apart from the settled ones", () => {
    const dir = folderWith({
      "archive.intent.yaml": REST_INTENT,
      "report.intent.yaml": DRAFT_INTENT,
    });

    const listing = intentOutcomes({ from: dir });
    expect(listing.outcomes.map((row) => row.intent)).toEqual([
      "archive-order",
      "archive-order",
    ]);
    expect(listing.drafts.map((row) => row.link)).toEqual([
      "get-report.200-ok",
    ]);
  });

  it("keeps only the boundaries a filter picks out", () => {
    const dir = folderWith({
      "archive.intent.yaml": REST_INTENT,
      "writer.intent.yaml": STORE_INTENT,
    });

    const listing = intentOutcomes({ from: dir, boundary: "writeOrder" });
    expect(listing.outcomes.map((row) => row.link)).toEqual([
      "order-writer.written",
    ]);
  });

  it("refuses a folder that is not there", () => {
    expect(() =>
      intentOutcomes({ from: path.join(tempDir(), "nope") }),
    ).toThrow(UsageError);
  });
});

describe("intentOutcomesCommand", () => {
  it("groups the lines under the file each came from", () => {
    const dir = folderWith({ "archive.intent.yaml": REST_INTENT });

    const { exit, io } = capture(() => intentOutcomesCommand({ from: dir }));
    expect(exit).toBe(0);
    expect(io.stdout).toContain(path.join(dir, "archive.intent.yaml"));
    expect(io.stdout).toContain("archive-order.archived");
    expect(io.stdout).toContain("POST /orders/{id}/archive");
  });

  it("writes the rows as JSON for --json", () => {
    const dir = folderWith({ "archive.intent.yaml": REST_INTENT });

    const { exit, io } = capture(() =>
      intentOutcomesCommand({ from: dir, json: true }),
    );
    expect(exit).toBe(0);
    const rows = JSON.parse(io.stdout) as Array<{ link: string }>;
    expect(rows.map((row) => row.link)).toEqual([
      "archive-order.archived",
      "archive-order.already-archived",
    ]);
  });

  it("leaves a draft's ids out of the JSON and counts them on stderr", () => {
    const dir = folderWith({
      "archive.intent.yaml": REST_INTENT,
      "report.intent.yaml": DRAFT_INTENT,
    });

    const { io } = capture(() =>
      intentOutcomesCommand({ from: dir, json: true }),
    );
    expect(JSON.parse(io.stdout)).toHaveLength(2);
    expect(io.stderr).toContain("Left out 1 outcome an inferred draft");
  });

  it("prints a draft's ids under a line saying they are not settled", () => {
    const dir = folderWith({ "report.intent.yaml": DRAFT_INTENT });

    const { exit, io } = capture(() => intentOutcomesCommand({ from: dir }));
    expect(exit).toBe(1);
    expect(io.stdout).toContain("These ids are not settled");
    expect(io.stdout).toContain("get-report.200-ok");
    expect(io.stderr).toContain("No curated boundary intent in");
  });

  it("exits non-zero with one line when the folder has no boundary intent", () => {
    const dir = folderWith({ "archive.prd.yaml": PRD });

    const { exit, io } = capture(() => intentOutcomesCommand({ from: dir }));
    expect(exit).toBe(1);
    expect(io.stdout).toBe("");
    expect(io.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(io.stderr).toContain("No boundary intent in");
  });

  it("says which file it skipped rather than failing the whole folder", () => {
    const dir = folderWith({
      "archive.intent.yaml": REST_INTENT,
      "broken.intent.yaml": "kind: boundary\n",
    });

    const { exit, io } = capture(() => intentOutcomesCommand({ from: dir }));
    expect(exit).toBe(0);
    expect(io.stderr).toContain("could not be read");
    expect(io.stdout).toContain("archive-order.archived");
  });
});
