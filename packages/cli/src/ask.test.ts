import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { storageBinding, summaryIdentifier } from "@suss/behavioral-ir";

import {
  dao,
  dashboard,
  indexContract,
  nestedRoute,
  route,
  routeClient,
} from "./__fixtures__/oneThing.js";
import { ask, parseQuestion } from "./ask.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

describe("parseQuestion", () => {
  it("reads each of the four shapes, whatever the case", () => {
    expect(
      parseQuestion("what can I project from aws.dynamodb:editions"),
    ).toEqual({
      shape: "declares",
      subject: "aws.dynamodb:editions",
    });
    expect(parseQuestion("What does GET /editions declare")).toEqual({
      shape: "declares",
      subject: "GET /editions",
    });
    expect(parseQuestion("what reads aws.dynamodb:editions?")).toEqual({
      shape: "reads",
      subject: "aws.dynamodb:editions",
    });
    expect(parseQuestion("what writes bus:aws_sqs orders")).toEqual({
      shape: "writes",
      subject: "bus:aws_sqs orders",
    });
    expect(parseQuestion("what does src/dao.ts reach")).toEqual({
      shape: "reaches",
      subject: "src/dao.ts",
    });
  });

  it("reads the calls shape", () => {
    expect(parseQuestion("what calls src/orderStore.ts")).toEqual({
      shape: "calls",
      subject: "src/orderStore.ts",
    });
  });

  it("reads the two why shapes", () => {
    expect(
      parseQuestion("why does getOrder reach aws.dynamodb:orders"),
    ).toEqual({
      shape: "whyReaches",
      subject: "getOrder",
      object: "aws.dynamodb:orders",
    });
    expect(
      parseQuestion(
        "Why does handler at src/app.ts:12 resolve to createHandler?",
      ),
    ).toEqual({
      shape: "whyResolves",
      subject: "handler",
      at: { file: "src/app.ts", line: 12 },
      object: "createHandler",
    });
  });

  it("refuses a question that is not one of them", () => {
    expect(parseQuestion("why is the store slow")).toBeNull();
    expect(parseQuestion("what happens to aws.dynamodb:editions")).toBeNull();
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
      JSON.stringify([dao, dashboard, route, nestedRoute, routeClient]),
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
      "what can I project from aws.dynamodb:editions#by-publication",
    );

    expect(code).toBe(0);
    expect(output).toContain("declares 3 things");
    expect(output).toContain("field publicationId");
    expect(output).toContain("field title");
    expect(output).not.toContain("wordCount");
  });

  it("lists what reads a store, and where each reader is", () => {
    const { output, code } = answer("what reads aws.dynamodb:editions");

    expect(code).toBe(0);
    expect(output).toContain("2 units read");
    expect(output).toContain("src/editions/dao.ts::byPublication");
    expect(output).toContain("src/editions/dao.ts:30");
    expect(output).toContain("docClient.query");
  });

  it("says plainly when nothing writes the store, and who serves it", () => {
    const { output, code } = answer("what writes aws.dynamodb:editions");

    expect(code).toBe(0);
    expect(output).toContain("Nothing in these summaries writes");
    expect(output).toContain("is provided by");
  });

  it("warns that a unit it could not read might be missing from the answer", () => {
    const { output } = answer("what writes aws.dynamodb:editions");

    expect(output).toContain("so a reader could be hiding in it");
  });

  it("lists the boundaries a file reaches", () => {
    const { output, code } = answer("what does src/editions/dao.ts reach");

    expect(code).toBe(0);
    expect(output).toContain("reaches 1 boundary");
    expect(output).toContain("reads");
    expect(output).toContain("aws.dynamodb:editions#by-publication");
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
      "what can I project from aws.dynamodb:editions#by-publication",
    );

    expect(output).toContain("No summary here provides");
    expect(output).toContain("suss contract --from terraform");
    expect(output).toContain("code here reads it");
  });

  it("does not pretend a boundary it has never seen is empty", () => {
    const { output, code } = answer("what reads aws.dynamodb:authors");

    expect(code).toBe(1);
    expect(output).toContain(
      "Nothing in these summaries is at aws.dynamodb:authors",
    );
    expect(output).toContain("then ask again");
  });

  it("prints the seven shapes back when the question is not one of them", () => {
    const { output, code } = answer("why is the store slow");

    expect(code).toBe(1);
    expect(output).toContain("suss ask takes one of seven questions");
  });

  it("writes JSON an agent can read", () => {
    const { output } = answer("what reads aws.dynamodb:editions", {
      json: true,
    });
    const parsed = JSON.parse(output) as {
      shape: string;
      subject: string;
      found: boolean;
      items: Array<{ unit: string; file: string; line: number; via?: string }>;
      needs: string[];
      caveats: string[];
    };

    expect(parsed.shape).toBe("reads");
    expect(parsed.subject).toBe("aws.dynamodb:editions");
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
        question: "what reads aws.dynamodb:editions",
        file: path.join(dir, "app.json"),
      });
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).toContain("2 units read");
  });

  it("says what it needs when no summaries were given at all", () => {
    expect(() => ask({ question: "what reads aws.dynamodb:editions" })).toThrow(
      /ask needs summaries to read/,
    );
  });
});

describe("suss ask, pointing at one thing", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-one-"));
    fs.writeFileSync(
      path.join(dir, "app.json"),
      JSON.stringify([dao, dashboard, route, nestedRoute, routeClient]),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function answer(question: string): { output: string; code: number } {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = ask({ question, dir });
      return { output: chunks.join(""), code };
    } finally {
      process.stdout.write = original;
    }
  }

  it("says a spelling could mean several boundaries, and which", () => {
    const { output, code } = answer("what does editions reach");

    expect(code).toBe(1);
    expect(output).toContain("could mean");
    expect(output).toContain("GET /editions");
    expect(output).toContain("GET /editions/{id}/comments");
  });

  it("takes the route it spells exactly over the one it is part of", () => {
    const { output, code } = answer("what does GET /editions reach");

    expect(code).toBe(0);
    expect(output).not.toContain("could mean");
    expect(output).not.toContain("comments");
  });

  it("leaves out the boundary a unit provides when asked what it reaches", () => {
    const { output } = answer("what does GET /editions reach");

    expect(output).not.toContain("provides GET /editions");
  });

  it("reaches what a unit's calls reach, and says which call got there", () => {
    const calling: BehavioralSummary = {
      ...route,
      transitions: route.transitions.map((transition, index) =>
        index === 0
          ? {
              ...transition,
              effects: [
                {
                  type: "invocation",
                  callee: "byPublication",
                  args: [],
                  async: true,
                  summary: summaryIdentifier(dao),
                },
              ],
            }
          : transition,
      ),
    };
    fs.writeFileSync(
      path.join(dir, "app.json"),
      JSON.stringify([calling, dao]),
    );

    const { output, code } = answer("what does GET /editions reach");

    expect(code).toBe(0);
    expect(output).toContain("aws.dynamodb:editions");
    expect(output).toContain("by calling byPublication");
  });

  it("takes a handler by its function name as well as its route", () => {
    const byName = answer("what does listEditions reach");
    const byRoute = answer("what does GET /editions reach");

    expect(byName.code).toBe(0);
    // Each answer says back what it was asked about; the rest matches.
    expect(byName.output.replace("listEditions", "GET /editions")).toBe(
      byRoute.output,
    );
  });
});

describe("suss ask in symbols", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-short-"));
    fs.writeFileSync(
      path.join(dir, "app.json"),
      JSON.stringify([dao, dashboard, route, routeClient]),
    );
    fs.writeFileSync(
      path.join(dir, "infra.json"),
      JSON.stringify([indexContract]),
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

  it("reads each symbol form as the question it stands for", () => {
    expect(parseQuestion("<- src/editions/dao.ts")).toEqual(
      parseQuestion("what calls src/editions/dao.ts"),
    );
    expect(parseQuestion("src/editions/dao.ts ->")).toEqual(
      parseQuestion("what does src/editions/dao.ts reach"),
    );
    expect(parseQuestion("r<- aws.dynamodb:editions")).toEqual(
      parseQuestion("what reads aws.dynamodb:editions"),
    );
    expect(parseQuestion("w<- aws.dynamodb:editions")).toEqual(
      parseQuestion("what writes aws.dynamodb:editions"),
    );
    expect(parseQuestion("getOrder -> aws.dynamodb:orders ?")).toEqual(
      parseQuestion("why does getOrder reach aws.dynamodb:orders"),
    );
  });

  it("answers the same thing either way, in text and in JSON", () => {
    const short = answer("r<- aws.dynamodb:editions");
    const written = answer("what reads aws.dynamodb:editions");

    expect(short.code).toBe(written.code);
    expect(short.output).toBe(written.output);

    const shortJson = JSON.parse(
      answer("r<- aws.dynamodb:editions", { json: true }).output,
    ) as Record<string, unknown>;
    const writtenJson = JSON.parse(
      answer("what reads aws.dynamodb:editions", { json: true }).output,
    ) as Record<string, unknown>;

    // Every field but the question as typed, which each one echoes.
    expect({ ...shortJson, question: null }).toEqual({
      ...writtenJson,
      question: null,
    });
  });

  it("turns down a symbol question it cannot read", () => {
    expect(parseQuestion("<-")).toBeNull();
    expect(parseQuestion("<- a b")).toBeNull();
    expect(parseQuestion("a -> b")).toBeNull();
    expect(parseQuestion("-> src/dao.ts")).toBeNull();
  });
});

describe("suss ask why", () => {
  let summariesDir: string;
  let projectDir: string;

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

  beforeEach(() => {
    summariesDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-why-s-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-why-p-"));
    fs.writeFileSync(
      path.join(summariesDir, "code.json"),
      JSON.stringify([caller, helper]),
    );
    fs.mkdirSync(path.join(projectDir, "src"));
    fs.writeFileSync(
      path.join(projectDir, "src", "orderStore.ts"),
      [
        "export async function readRow(location: { table: string }) {",
        "  return { Item: location.table };",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(projectDir, "src", "orders.ts"),
      [
        'import { readRow } from "./orderStore.js";',
        "",
        "export const getOrder = async () => {",
        '  const row = await readRow({ table: "orders" });',
        "  return row;",
        "};",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    fs.rmSync(summariesDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function answerWhy(
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
      const code = ask({
        question,
        dir: summariesDir,
        project: projectDir,
        ...options,
      });
      return { output: chunks.join(""), code };
    } finally {
      process.stdout.write = original;
    }
  }

  it("prints the chain from the unit to the boundary, with each hop's resolution", () => {
    const { output, code } = answerWhy(
      "why does getOrder reach aws.dynamodb:orders",
    );

    expect(code).toBe(0);
    expect(output).toContain("getOrder reaches aws.dynamodb:orders");
    expect(output).toContain("getOrder -> readRow -> client.send");
    expect(output).toContain("calls readRow, and that call runs readRow");
    expect(output).toContain(
      "is imported from src/orderStore.ts under the name readRow",
    );
    expect(output).toContain("reads aws.dynamodb:orders through client.send");
  });

  it("writes the chain, the hops, and the cost as JSON", () => {
    const { output, code } = answerWhy(
      "why does getOrder reach aws.dynamodb:orders",
      { json: true },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(output) as {
      found: boolean;
      chain: string[];
      hops: Array<{
        callee: string;
        resolution?: {
          steps: Array<{ rule: string }>;
          cost: { evaluateMs: number; baseFacts: number };
        };
      }>;
    };
    expect(parsed.found).toBe(true);
    expect(parsed.chain).toEqual(["getOrder", "readRow", "client.send"]);
    expect(parsed.hops).toHaveLength(1);
    const rules = parsed.hops[0].resolution?.steps.map((step) => step.rule);
    expect(rules).toContain("import");
    expect(parsed.hops[0].resolution?.cost.baseFacts).toBeGreaterThan(0);
  });

  it("says so and exits 1 when the run does not contain the boundary", () => {
    const { output, code } = answerWhy("why does getOrder reach kafka:orders");

    expect(code).toBe(1);
    expect(output).toContain(
      "Nothing in these summaries goes through kafka:orders",
    );
  });

  it("explains what a written name resolves to, and why", () => {
    const { output, code } = answerWhy(
      "why does readRow at src/orders.ts:4 resolve to readRow",
    );

    expect(code).toBe(0);
    expect(output).toContain("resolves to readRow (src/orderStore.ts:1)");
    expect(output).toContain("is declared as");
    expect(output).toContain(
      "is imported from src/orderStore.ts under the name readRow",
    );
  });

  it("says what the name does resolve to when the asked target is wrong", () => {
    const { output, code } = answerWhy(
      "why does readRow at src/orders.ts:4 resolve to somethingElse",
    );

    expect(code).toBe(1);
    expect(output).toContain("not somethingElse");
    expect(output).toContain("resolves to readRow (src/orderStore.ts:1)");
  });

  it("still prints the unit chain when the source is missing", () => {
    fs.rmSync(path.join(projectDir, "src"), { recursive: true, force: true });
    const { output, code } = answerWhy(
      "why does getOrder reach aws.dynamodb:orders",
    );

    expect(code).toBe(0);
    expect(output).toContain("getOrder -> readRow -> client.send");
    expect(output).toContain("without their resolution steps");
  });
});

describe("suss ask what calls", () => {
  const CONFIDENT = { source: "inferred_static", level: "high" } as const;

  /** The storage layer somebody asks about the callers of. */
  const wrapper: BehavioralSummary = {
    kind: "library",
    location: {
      file: "src/orderStore.ts",
      range: { start: 14, end: 25 },
      exportName: "readRow",
    },
    identity: {
      name: "readRow",
      exportPath: ["readRow"],
      boundaryBinding: null,
      id: "repo::src/orderStore.ts::readRow",
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: CONFIDENT,
  };

  /** The one unit whose call the run resolved to the wrapper. */
  const handler: BehavioralSummary = {
    kind: "handler",
    location: {
      file: "src/orders.ts",
      range: { start: 6, end: 17 },
      exportName: "getOrder",
    },
    identity: {
      name: "getOrder",
      exportPath: ["getOrder"],
      boundaryBinding: null,
      id: "repo::src/orders.ts::getOrder",
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
            summary: "repo::src/orderStore.ts::readRow",
            args: [],
            async: true,
          },
        ],
        location: { start: 8, end: 16 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };

  /** A unit whose walk stopped at a call it could not resolve. */
  const stopped: BehavioralSummary = {
    kind: "handler",
    location: {
      file: "src/report.ts",
      range: { start: 1, end: 10 },
      exportName: "buildReport",
    },
    identity: {
      name: "buildReport",
      exportPath: ["buildReport"],
      boundaryBinding: null,
      id: "repo::src/report.ts::buildReport",
    },
    inputs: [],
    transitions: [],
    gaps: [
      {
        type: "unfollowedCall",
        conditions: [],
        consequence: "unknown",
        description: "suss could not settle which function load is.",
      },
    ],
    confidence: CONFIDENT,
  };

  function askCalls(
    question: string,
    summaries: BehavioralSummary[],
    options: { json?: boolean } = {},
  ): { output: string; code: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-calls-"));
    fs.writeFileSync(path.join(dir, "code.json"), JSON.stringify(summaries));
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
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("lists the callers with the file, the line, and the call", () => {
    const { output, code } = askCalls("what calls src/orderStore.ts", [
      wrapper,
      handler,
    ]);

    expect(code).toBe(0);
    expect(output).toContain("1 unit calls repo::src/orderStore.ts::readRow:");
    expect(output).toContain(
      "repo::src/orders.ts::getOrder (src/orders.ts:6) calls readRow",
    );
  });

  it("writes the callers as JSON", () => {
    const { output } = askCalls(
      "what calls src/orderStore.ts",
      [wrapper, handler],
      { json: true },
    );
    const parsed = JSON.parse(output) as {
      found: boolean;
      items: Array<{ unit: string; file: string; line: number; call: string }>;
    };

    expect(parsed.found).toBe(true);
    expect(parsed.items).toEqual([
      {
        unit: "repo::src/orders.ts::getOrder",
        file: "src/orders.ts",
        line: 6,
        call: "readRow",
      },
    ]);
  });

  it("says nothing calls a unit, plainly, when every call was followed", () => {
    const { output, code } = askCalls("what calls src/orders.ts", [
      wrapper,
      handler,
    ]);

    expect(code).toBe(0);
    expect(output).toContain(
      "Nothing in these summaries calls repo::src/orders.ts::getOrder.",
    );
    expect(output).not.toContain("could be hiding");
  });

  it("says a caller could be hiding behind an unfollowed call", () => {
    const { output, code } = askCalls("what calls src/orderStore.ts", [
      wrapper,
      stopped,
    ]);

    expect(code).toBe(0);
    expect(output).toContain("Nothing in these summaries calls");
    expect(output).toContain("suss met a call it could not follow in one unit");
    expect(output).toContain("could be hiding there");
  });

  it("exits 1 for a unit no summary spells", () => {
    const { output, code } = askCalls("what calls src/nowhere.ts", [wrapper]);

    expect(code).toBe(1);
    expect(output).toContain("No summary here is src/nowhere.ts");
  });
});

describe("suss ask across a grounded name", () => {
  const CONFIDENT = { source: "inferred_static", level: "high" } as const;

  /** A wrapper whose access says only where the table name comes from. */
  const wrapper: BehavioralSummary = {
    kind: "library",
    location: {
      file: "src/orderStore.ts",
      range: { start: 14, end: 25 },
      exportName: "putRow",
    },
    identity: {
      name: "putRow",
      exportPath: ["putRow"],
      boundaryBinding: null,
      id: "repo::src/orderStore.ts::putRow",
    },
    inputs: [
      {
        type: "parameter",
        name: "location",
        position: 0,
        role: null,
        shape: null,
      },
    ],
    transitions: [
      {
        id: "putRow:default",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: storageBinding({
              recognition: "aws-dynamodb",
              storageSystem: "aws.dynamodb",
              scope: "default",
              container: "{location.table}",
              accessPath: null,
            }),
            callee: "client.send",
            interaction: {
              class: "storage-access",
              kind: "write",
              fields: ["email"],
              operation: "put",
            },
          },
        ],
        location: { start: 15, end: 24 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };

  /** The caller that says which table, as a literal argument. */
  const handler: BehavioralSummary = {
    kind: "handler",
    location: {
      file: "src/orders.ts",
      range: { start: 6, end: 17 },
      exportName: "subscribe",
    },
    identity: {
      name: "subscribe",
      exportPath: ["subscribe"],
      boundaryBinding: null,
      id: "repo::src/orders.ts::subscribe",
    },
    inputs: [],
    transitions: [
      {
        id: "subscribe:default",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "invocation",
            callee: "putRow",
            summary: "repo::src/orderStore.ts::putRow",
            args: [
              {
                kind: "object",
                fields: {
                  table: { kind: "string", value: "prod-subscribers-v1" },
                },
              },
            ],
            async: true,
          },
        ],
        location: { start: 8, end: 16 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };

  /** The table as the deployment declares it. */
  const provider: BehavioralSummary = {
    kind: "library",
    location: {
      file: "infra/tables.tf",
      range: { start: 1, end: 10 },
      exportName: null,
    },
    identity: {
      name: "aws_dynamodb_table.subscribers",
      exportPath: null,
      boundaryBinding: storageBinding({
        recognition: "terraform",
        storageSystem: "aws.dynamodb",
        scope: "default",
        container: "prod-subscribers-v1",
        accessPath: null,
      }),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: { fieldSet: "partial", fields: [{ name: "email" }] },
    },
  };

  function askGrounded(
    question: string,
    summaries: BehavioralSummary[],
  ): { output: string; code: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-ground-"));
    fs.writeFileSync(path.join(dir, "code.json"), JSON.stringify(summaries));
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = ask({ question, dir });
      return { output: chunks.join(""), code };
    } finally {
      process.stdout.write = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("finds the writer under the deployed name and says how", () => {
    const { output, code } = askGrounded(
      "what writes aws.dynamodb:prod-subscribers-v1",
      [wrapper, handler, provider],
    );

    expect(code).toBe(0);
    expect(output).toContain("repo::src/orderStore.ts::putRow");
    expect(output).toContain(
      "which grounds to prod-subscribers-v1 via repo::src/orders.ts::subscribe",
    );
    expect(output).toContain("is provided by");
  });

  it("finds the same pair asked by the reference spelling", () => {
    const { output, code } = askGrounded(
      "what writes aws.dynamodb:{location.table}",
      [wrapper, handler, provider],
    );

    expect(code).toBe(0);
    expect(output).toContain("repo::src/orderStore.ts::putRow");
    expect(output).toContain(
      "which grounds to prod-subscribers-v1 via repo::src/orders.ts::subscribe",
    );
    expect(output).toContain("is provided by");
  });

  it("says which input would connect a deployed name nothing grounds", () => {
    const { output, code } = askGrounded(
      "what writes aws.dynamodb:prod-subscribers-v1",
      [wrapper],
    );

    expect(code).toBe(1);
    expect(output).toContain("Nothing in these summaries is at");
    expect(output).toContain(
      "the name is whatever its caller passes. No caller in these summaries settles it",
    );
  });
});
