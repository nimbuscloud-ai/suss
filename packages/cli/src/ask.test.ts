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
import { ask, parseQuestion } from "./ask.js";

describe("parseQuestion", () => {
  it("reads each of the four shapes, whatever the case", () => {
    expect(parseQuestion("what can I project from dynamodb:editions")).toEqual({
      shape: "declares",
      subject: "dynamodb:editions",
    });
    expect(parseQuestion("What does GET /editions declare")).toEqual({
      shape: "declares",
      subject: "GET /editions",
    });
    expect(parseQuestion("what reads dynamodb:editions?")).toEqual({
      shape: "reads",
      subject: "dynamodb:editions",
    });
    expect(parseQuestion("what writes bus:sqs orders")).toEqual({
      shape: "writes",
      subject: "bus:sqs orders",
    });
    expect(parseQuestion("what does src/dao.ts reach")).toEqual({
      shape: "reaches",
      subject: "src/dao.ts",
    });
  });

  it("refuses a question that is not one of them", () => {
    expect(parseQuestion("why is the store slow")).toBeNull();
    expect(parseQuestion("what happens to dynamodb:editions")).toBeNull();
  });
});

describe("suss ask", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-"));
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

  function answer(
    question: string,
    options: { json?: boolean } = {},
  ): { output: string; code: number } {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = ask({ question, dir, ...options });
      return { output: chunks.join(""), code };
    } finally {
      process.stdout.write = original;
    }
  }

  it("lists what an index declares", () => {
    const { output, code } = answer(
      "what can I project from dynamodb:editions#by-publication",
    );

    expect(code).toBe(0);
    expect(output).toContain("declares 3 things");
    expect(output).toContain("field publicationId");
    expect(output).toContain("field title");
    expect(output).not.toContain("wordCount");
  });

  it("lists what reads a store, and where each reader is", () => {
    const { output, code } = answer("what reads dynamodb:editions");

    expect(code).toBe(0);
    expect(output).toContain("2 units read");
    expect(output).toContain("src/editions/dao.ts::byPublication");
    expect(output).toContain("src/editions/dao.ts:30");
    expect(output).toContain("docClient.query");
  });

  it("says plainly when nothing writes the store, and who serves it", () => {
    const { output, code } = answer("what writes dynamodb:editions");

    expect(code).toBe(0);
    expect(output).toContain("Nothing in these summaries writes");
    expect(output).toContain("is provided by");
  });

  it("warns that a unit it could not read might be missing from the answer", () => {
    const { output } = answer("what writes dynamodb:editions");

    expect(output).toContain("could be missing from this answer");
  });

  it("lists the boundaries a file reaches", () => {
    const { output, code } = answer("what does src/editions/dao.ts reach");

    expect(code).toBe(0);
    expect(output).toContain("reaches 1 boundary");
    expect(output).toContain("reads");
    expect(output).toContain("dynamodb:editions#by-publication");
    expect(output).toContain("loadCursor");
  });

  it("says which input it would need when nothing declares the boundary", () => {
    const { output, code } = answer("what can I project from GET /editions");

    expect(code).toBe(0);
    expect(output).toContain("Nothing here declares what GET /editions serves");
    expect(output).toContain("declares nothing about it");
  });

  it("says which input it would need when no provider is in the run at all", () => {
    fs.rmSync(path.join(dir, "infra.json"));
    const { output } = answer(
      "what can I project from dynamodb:editions#by-publication",
    );

    expect(output).toContain("No summary here provides");
    expect(output).toContain("suss contract --from terraform");
    expect(output).toContain("code here reads it");
  });

  it("does not pretend a boundary it has never seen is empty", () => {
    const { output, code } = answer("what reads dynamodb:authors");

    expect(code).toBe(1);
    expect(output).toContain(
      "Nothing in these summaries is at dynamodb:authors",
    );
    expect(output).toContain("then ask again");
  });

  it("prints the four shapes back when the question is not one of them", () => {
    const { output, code } = answer("why is the store slow");

    expect(code).toBe(1);
    expect(output).toContain("suss ask takes one of four questions");
  });

  it("writes JSON an agent can read", () => {
    const { output } = answer("what reads dynamodb:editions", { json: true });
    const parsed = JSON.parse(output) as {
      shape: string;
      subject: string;
      found: boolean;
      items: Array<{ unit: string; file: string; line: number; via?: string }>;
      needs: string[];
      caveats: string[];
    };

    expect(parsed.shape).toBe("reads");
    expect(parsed.subject).toBe("dynamodb:editions");
    expect(parsed.found).toBe(true);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toEqual({
      unit: "src/editions/dao.ts::byPublication",
      file: "src/editions/dao.ts",
      line: 30,
      via: "docClient.query",
    });
    expect(parsed.caveats.join(" ")).toContain("loadCursor");
  });

  it("reads one summaries file when given one instead of a folder", () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = ask({
        question: "what reads dynamodb:editions",
        file: path.join(dir, "app.json"),
      });
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).toContain("2 units read");
  });

  it("says what it needs when no summaries were given at all", () => {
    expect(() => ask({ question: "what reads dynamodb:editions" })).toThrow(
      /ask needs summaries to read/,
    );
  });
});
