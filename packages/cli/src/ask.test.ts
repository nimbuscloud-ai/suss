import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  packageExportBinding,
  restBinding,
  storageBinding,
  summaryIdentifier,
} from "@suss/behavioral-ir";

import {
  dao,
  dashboard,
  indexContract,
  nestedRoute,
  route,
  routeClient,
} from "./__fixtures__/oneThing.js";
import {
  answerQuestion,
  ask,
  hiddenBehindLine,
  parseQuestion,
  unfollowedCalls,
} from "./ask.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

describe("hiddenBehindLine", () => {
  it("says the one stopped call by its callee", () => {
    expect(
      hiddenBehindLine({ count: 1, callees: ["loadCursor"] }, "a writer"),
    ).toBe(
      "warning: a writer could be hidden behind an unfollowed call to loadCursor elsewhere in this run.",
    );
  });

  it("says one stopped call without a callee as an unfollowed call", () => {
    expect(hiddenBehindLine({ count: 1, callees: [] }, "a reader")).toBe(
      "warning: a reader could be hidden behind an unfollowed call elsewhere in this run.",
    );
  });

  it("lists up to three stopped calls by callee", () => {
    expect(
      hiddenBehindLine({ count: 2, callees: ["a", "b"] }, "a writer"),
    ).toBe(
      "warning: a writer could be hidden behind one of 2 unfollowed calls (a, b) elsewhere in this run. Run with --json to see them.",
    );
  });

  it("keeps the count and drops the list when there are many", () => {
    expect(
      hiddenBehindLine(
        { count: 159, callees: ["a", "b", "c"] },
        "a caller of x",
      ),
    ).toBe(
      "warning: a caller of x could be hidden behind one of 159 unfollowed calls elsewhere in this run. Run with --json to see them.",
    );
  });
});

describe("unfollowedCalls", () => {
  it("counts a stopped call that recorded no callee", () => {
    const summary = {
      gaps: [
        {
          type: "unfollowedCall",
          conditions: [],
          consequence: "unknown",
          description: "prose",
        },
      ],
    } as unknown as BehavioralSummary;
    expect(unfollowedCalls([summary])).toEqual({ count: 1, callees: [] });
  });
});

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
    expect(parseQuestion("what reaches src/dao.ts")).toEqual({
      shape: "reachedBy",
      subject: "src/dao.ts",
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
    options: { json?: boolean; all?: boolean } = {},
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

  it("stops a long answer after ten units and says how many are left", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      ...dao,
      location: { ...dao.location, file: `src/reader${i}.ts` },
      identity: {
        ...dao.identity,
        name: `read${i}`,
        exportPath: [`read${i}`],
        id: `repo::src/reader${i}.ts::read${i}`,
      },
    }));
    fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(many));

    const collapsed = answer("what reads aws.dynamodb:editions");
    expect(collapsed.output).toContain("14 units read");
    expect(collapsed.output).toContain("... and 4 more");
    expect(collapsed.output).toContain("--all");
    expect(collapsed.output).not.toContain("read11 (");

    const full = answer("what reads aws.dynamodb:editions", { all: true });
    expect(full.output).toContain("read11 (");
    expect(full.output).not.toContain("and 4 more");
  });

  it("names a unit by its symbol, since the file follows in the location", () => {
    const { output } = answer("what reads aws.dynamodb:editions");

    expect(output).toMatch(/ {2}byPublication \(src\/editions\/dao\.ts:\d+\)/);
    expect(output).not.toContain("::src/editions/dao.ts::byPublication");
  });

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
    expect(output).toContain(
      "warning: src/editions/dao.ts:30 byPublication: unfollowed call to loadCursor",
    );
    expect(output).toContain("src/editions/dao.ts:30");
    expect(output).toContain("docClient.query");
  });

  it("prints one line for a caller recorded with and without its call", () => {
    // A client's own binding says it reads the route, and its fetch
    // effect says the same read through the call. One unit doing one
    // thing at one boundary is one line, and the line that says which
    // call it went through is the one worth keeping.
    fs.writeFileSync(
      path.join(dir, "caller.json"),
      JSON.stringify([
        {
          kind: "client",
          location: {
            file: "web/login.ts",
            range: { start: 1, end: 30 },
            exportName: "login",
          },
          identity: {
            name: "login",
            exportPath: ["login"],
            boundaryBinding: restBinding({
              transport: "http",
              recognition: "fetch",
              method: "POST",
              path: "/login",
            }),
          },
          inputs: [],
          transitions: [
            {
              id: "login:call",
              conditions: [],
              output: { type: "return", value: null },
              effects: [
                {
                  type: "interaction",
                  binding: restBinding({
                    transport: "http",
                    recognition: "fetch",
                    method: "POST",
                    path: "/login",
                  }),
                  callee: "fetch",
                  interaction: { class: "service-call", method: "POST" },
                },
              ],
              location: { start: 5, end: 15 },
              isDefault: true,
            },
          ],
          gaps: [],
          confidence: { source: "inferred_static", level: "high" },
        },
      ]),
    );

    const { output } = answer("what reads POST /login");
    expect(output).toContain("1 unit reads");
    expect(output).toContain("through fetch");
    expect(output.match(/web\/login\.ts:1/g) ?? []).toHaveLength(1);
  });

  it("says plainly when nothing writes the store, and who serves it", () => {
    const { output, code } = answer("what writes aws.dynamodb:editions");

    expect(code).toBe(0);
    expect(output).toContain("Nothing in these summaries writes");
    expect(output).toContain("is provided by");
  });

  it("says which call it could not follow, so a reader can judge the gap", () => {
    const { output } = answer("what writes aws.dynamodb:editions");

    // The name is the point: a count of units reads the same whatever
    // was asked, and stops working as a warning.
    expect(output).toContain("unfollowed call to loadCursor");
  });

  it("says a writer could be hiding when the question was who writes", () => {
    // This used to say "a reader" whatever was asked, so an answer
    // about who writes a table warned about a hidden reader.
    expect(answer("what writes aws.dynamodb:editions").output).toContain(
      "a writer could be hidden behind",
    );
  });

  it("lists the boundaries a file reaches", () => {
    const { output, code } = answer("what does src/editions/dao.ts reach");

    expect(code).toBe(0);
    expect(output).toContain("reaches 1 boundary");
    expect(output).toContain("reads");
    expect(output).toContain("aws.dynamodb:editions#by-publication");
    expect(output).toContain("loadCursor");
  });

  it("says nothing reaches a store when its only reader serves no boundary", () => {
    // The dao goes through the table and provides nothing of its own,
    // and nothing here calls the dao, so no boundary is downstream.
    const { output, code } = answer("what reaches aws.dynamodb:editions");

    expect(code).toBe(0);
    expect(output).toContain("Nothing in these summaries reaches");
  });

  it("says what a route returns, for a boundary read from code", () => {
    // The contract readers answer for a boundary somebody wrote a spec
    // for. A route says the same thing by returning it, and a caller
    // should not have to care which of the two the answer came from.
    const { output, code } = answer("what can I project from GET /editions");

    expect(code).toBe(0);
    expect(output).toContain("GET /editions declares");
    expect(output).toContain("response 200");
    expect(output).toContain("response 503");
  });

  it("says the expression when the status is decided at run time, and lists the body fields", () => {
    // A status the run could not settle is reported as the expression
    // that decides it. A reader who knows the code can finish the
    // thought, and a reader who does not learns there is another branch.
    fs.writeFileSync(
      path.join(dir, "forwarder.json"),
      JSON.stringify([
        {
          kind: "handler",
          location: {
            file: "src/auth/login.ts",
            range: { start: 1, end: 40 },
            exportName: "POST",
          },
          identity: {
            name: "POST",
            exportPath: ["POST"],
            boundaryBinding: restBinding({
              transport: "http",
              recognition: "nextjs",
              method: "POST",
              path: "/login",
            }),
          },
          inputs: [],
          transitions: [
            {
              id: "POST:dynamic",
              conditions: [],
              output: {
                type: "response",
                statusCode: {
                  type: "unresolved",
                  sourceText: "statusForErrors(result)",
                },
                body: {
                  type: "record",
                  properties: { errors: { type: "literal", value: true } },
                },
                headers: {},
              },
              effects: [],
              location: { start: 10, end: 12 },
              isDefault: false,
            },
            {
              id: "POST:nostatus",
              conditions: [],
              output: {
                type: "response",
                statusCode: null,
                body: null,
                headers: {},
              },
              effects: [],
              location: { start: 20, end: 22 },
              isDefault: true,
            },
          ],
          gaps: [],
          confidence: { source: "inferred_static", level: "high" },
        },
      ]),
    );

    const { output } = answer("what can I project from POST /login");

    expect(output).toContain("decided by statusForErrors(result)");
    expect(output).toContain("(errors)");
    // A response with no status at all says nothing worth listing.
    expect(output).toContain("declares 1 thing");
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

  it("prints the shapes back when the question is not one of them", () => {
    const { output, code } = answer("why is the store slow");

    expect(code).toBe(1);
    expect(output).toContain("suss ask takes one of ten questions");
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

describe("suss ask over a folder holding a file that is not summaries", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-mixed-"));
    fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify([dao]));
    fs.writeFileSync(path.join(dir, "report.json"), "not json{");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the summaries and says which file it skipped", () => {
    const out: string[] = [];
    const errors: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      errors.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = ask({ question: "what reads aws.dynamodb:editions", dir });
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }

    expect(code).toBe(0);
    expect(out.join("")).toContain("byPublication");
    expect(errors.join("")).toContain("report.json");
  });

  it("turns down a folder where nothing is summaries", () => {
    fs.rmSync(path.join(dir, "app.json"));

    expect(() =>
      ask({ question: "what reads aws.dynamodb:editions", dir }),
    ).toThrow(/Nothing in .* is a summaries file/);
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

  it("finds a caller recorded through a package-export binding", () => {
    const provider: BehavioralSummary = {
      ...wrapper,
      identity: {
        ...wrapper.identity,
        boundaryBinding: {
          transport: "in-process",
          semantics: {
            name: "function-call",
            package: "@demo/store",
            exportPath: ["readRow"],
          },
          recognition: "package-exports",
        },
      },
    } as BehavioralSummary;
    const boundCaller: BehavioralSummary = {
      ...handler,
      kind: "caller",
      location: { ...handler.location, file: "src/web.ts" },
      identity: {
        name: "loadOrder",
        exportPath: ["loadOrder"],
        id: "repo::src/web.ts::loadOrder",
        boundaryBinding: {
          transport: "in-process",
          semantics: {
            name: "function-call",
            package: "@demo/store",
            exportPath: ["readRow"],
          },
          recognition: "package-exports",
        },
      },
      transitions: [],
    } as BehavioralSummary;

    const { output, code } = askCalls("what calls src/orderStore.ts", [
      provider,
      boundCaller,
    ]);

    expect(code).toBe(0);
    expect(output).toContain("loadOrder");
    expect(output).toContain("fn:@demo/store::readRow");
  });

  it("leaves the subject's own internal calls out of the caller list", () => {
    const sibling: BehavioralSummary = {
      ...handler,
      location: { ...handler.location, file: "src/orderStore.ts" },
      identity: {
        ...handler.identity,
        name: "refresh",
        exportPath: ["refresh"],
        id: "repo::src/orderStore.ts::refresh",
      },
    } as BehavioralSummary;

    const { output } = askCalls("what calls src/orderStore.ts", [
      wrapper,
      sibling,
    ]);

    expect(output).toContain("Nothing in these summaries calls");
  });

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
    expect(output).not.toContain("could be hidden");
  });

  it("says a caller could be hiding behind an unfollowed call", () => {
    const { output, code } = askCalls("what calls src/orderStore.ts", [
      wrapper,
      stopped,
    ]);

    expect(code).toBe(0);
    expect(output).toContain("Nothing in these summaries calls");
    expect(output).toContain("warning: a caller of");
    expect(output).toContain("could be hidden behind");
  });

  it("exits 1 for a unit no summary spells", () => {
    const { output, code } = askCalls("what calls src/nowhere.ts", [wrapper]);

    expect(code).toBe(1);
    expect(output).toContain("No summary here is src/nowhere.ts");
  });

  it("says the boundary a caller itself provides, after its location", () => {
    const exported: BehavioralSummary = {
      ...handler,
      identity: {
        ...handler.identity,
        boundaryBinding: {
          transport: "in-process",
          semantics: {
            name: "function-call",
            package: "@demo/orders",
            exportPath: ["getOrder"],
          },
          recognition: "package-exports",
        },
      },
    } as BehavioralSummary;

    const { output } = askCalls("what calls src/orderStore.ts", [
      wrapper,
      exported,
    ]);

    expect(output).toContain(
      "(src/orders.ts:6, provides fn:@demo/orders::getOrder) calls readRow",
    );
  });

  it("leaves provides off a caller that is not itself an export", () => {
    const { output } = askCalls("what calls src/orderStore.ts", [
      wrapper,
      handler,
    ]);

    expect(output).not.toContain("provides");
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
    // One workspace in the answer, so the unit is named by its symbol
    // and the file comes from the location beside it.
    expect(output).toContain("putRow (src/orderStore.ts:");
    expect(output).not.toContain("repo::src/orderStore.ts::putRow (");
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
    expect(output).toContain("putRow (src/orderStore.ts:");
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

describe("suss ask about a table one call writes several ways", () => {
  const commentBinding = () =>
    storageBinding({
      recognition: "prisma",
      storageSystem: "postgresql",
      scope: "default",
      container: "Comment",
      accessPath: null,
    });

  /** A comment table, whose relation to Article declares the foreign key. */
  const commentTable: BehavioralSummary = {
    kind: "library",
    location: {
      file: "schema.prisma",
      range: { start: 1, end: 10 },
      exportName: null,
    },
    identity: {
      name: "Comment",
      exportPath: null,
      boundaryBinding: commentBinding(),
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "declared", level: "high" },
    metadata: {
      storageContract: {
        fieldSet: "exhaustive",
        fields: [
          { name: "body" },
          { name: "articleId" },
          {
            name: "article",
            type: "Article",
            derived: true,
            relationKey: ["articleId"],
          },
        ],
      },
    },
  };

  /** The create itself, and the foreign key its nested connect sets. */
  const writeEffects = [
    {
      type: "interaction" as const,
      binding: commentBinding(),
      callee: "prisma.comment.create",
      interaction: {
        class: "storage-access" as const,
        kind: "write" as const,
        fields: ["body"],
        operation: "create",
      },
    },
    {
      type: "interaction" as const,
      binding: commentBinding(),
      callee: "prisma.comment.create",
      interaction: {
        class: "storage-access" as const,
        kind: "write" as const,
        fields: [],
        relationPath: ["article"],
        relationKey: true,
        operation: "connect",
      },
    },
  ];

  const addComment: BehavioralSummary = {
    kind: "handler",
    location: {
      file: "src/article.service.ts",
      range: { start: 473, end: 500 },
      exportName: "addComment",
    },
    identity: {
      name: "addComment",
      exportPath: ["addComment"],
      boundaryBinding: null,
      id: "repo::src/article.service.ts::addComment",
    },
    inputs: [],
    transitions: [
      {
        id: "addComment:default",
        conditions: [],
        output: { type: "return", value: null },
        effects: writeEffects,
        location: { start: 474, end: 499 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };

  it("says the unit once, however many accesses reach the table", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-once-"));
    fs.writeFileSync(
      path.join(dir, "code.json"),
      JSON.stringify([commentTable, addComment]),
    );
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      ask({ question: "what writes postgresql:Comment", dir });
    } finally {
      process.stdout.write = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const output = chunks.join("");

    expect(output).toContain("1 unit writes postgresql:Comment");
    expect(output.match(/addComment/g)).toHaveLength(1);
  });
});

describe("suss ask what reaches, over a chain", () => {
  let dir: string;

  /** The dao, respelled as another unit, so the shape stays valid. */
  const like = (
    name: string,
    binding: BehavioralSummary["identity"]["boundaryBinding"],
    effects: unknown[],
  ): BehavioralSummary =>
    ({
      ...dao,
      location: { ...dao.location, file: `src/${name}.ts`, exportName: name },
      identity: {
        ...dao.identity,
        name,
        exportPath: [name],
        id: `repo::src/${name}.ts::${name}`,
        boundaryBinding: binding,
      },
      transitions: [{ ...dao.transitions[0], effects }],
    }) as unknown as BehavioralSummary;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-reaches-"));
    const writer = like("writeOrder", null, dao.transitions[0].effects);
    const service = like("orderService", null, [
      {
        type: "invocation",
        callee: "writeOrder",
        summary: "repo::src/writeOrder.ts::writeOrder",
        args: [],
        async: false,
      },
    ]);
    const postOrders = like(
      "postOrders",
      restBinding({
        transport: "http",
        recognition: "test",
        method: "POST",
        path: "/orders",
      }),
      [
        {
          type: "invocation",
          callee: "orderService",
          summary: "repo::src/orderService.ts::orderService",
          args: [],
          async: false,
        },
      ],
    );
    fs.writeFileSync(
      path.join(dir, "app.json"),
      JSON.stringify([writer, service, postOrders]),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const answer = (question: string): { output: string; code: number } => {
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
  };

  it("names the route two calls above the read, and the calls it took", () => {
    const { output, code } = answer("what reaches aws.dynamodb:editions");

    expect(code).toBe(0);
    expect(output).toContain("POST /orders");
    expect(output).toContain("orderService");
    expect(output).toContain("writeOrder");
  });

  it("says so when the subject is not in these summaries", () => {
    const { output, code } = answer("what reaches aws.dynamodb:absent");

    expect(code).toBe(1);
    expect(output).toContain("Nothing here is at");
  });

  it("says what boundary the route at the top of the chain provides", () => {
    const { answer: json } = answerQuestion({
      question: "what reaches aws.dynamodb:editions",
      dir,
      output: path.join(dir, "answer.txt"),
    });
    const items = json?.items as
      | Array<{ boundary: string; provides?: string }>
      | undefined;

    expect(items).toEqual([
      expect.objectContaining({
        boundary: "POST /orders",
        provides: "POST /orders",
      }),
    ]);
  });
});

describe("suss ask what does X reach, when a hop is itself a package export", () => {
  const CONFIDENT = { source: "inferred_static", level: "high" } as const;

  const readRowExport = packageExportBinding({
    recognition: "package-exports",
    packageName: "@demo/orderstore",
    exportPath: ["readRow"],
  });

  const readRow: BehavioralSummary = {
    kind: "library",
    location: {
      file: "src/orderStore.ts",
      range: { start: 1, end: 3 },
      exportName: "readRow",
    },
    identity: {
      name: "readRow",
      exportPath: ["readRow"],
      boundaryBinding: readRowExport,
      id: "repo::src/orderStore.ts::readRow",
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

  const getOrder: BehavioralSummary = {
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
            args: [],
            async: true,
            summary: "repo::src/orderStore.ts::readRow",
          },
        ],
        location: { start: 4, end: 5 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };

  it("says what boundary the unit that does the reaching itself provides", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-reaches-export-"));
    fs.writeFileSync(
      path.join(dir, "code.json"),
      JSON.stringify([getOrder, readRow]),
    );
    try {
      const { answer: json } = answerQuestion({
        question: "what does getOrder reach",
        dir,
        output: path.join(dir, "answer.txt"),
      });
      const items = json?.items as
        | Array<{ unit: string; boundary: string; provides?: string }>
        | undefined;

      expect(items).toEqual([
        expect.objectContaining({
          unit: "repo::src/orderStore.ts::readRow",
          boundary: "aws.dynamodb:orders",
          provides: "fn:@demo/orderstore::readRow",
        }),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suss ask about one function, however it is spelled", () => {
  const CONFIDENT = { source: "inferred_static", level: "high" } as const;
  const evaluateExport = packageExportBinding({
    recognition: "package-exports",
    packageName: "@demo/datalog",
    exportPath: ["evaluate"],
  });
  const analyzeExport = packageExportBinding({
    recognition: "package-exports",
    packageName: "@demo/checker",
    exportPath: ["analyzeFlow"],
  });

  /** One summary, spelled the way the package-exports pack writes them. */
  function unit(spec: {
    kind: BehavioralSummary["kind"];
    file: string;
    name: string;
    id: string;
    line?: number;
    binding?: BehavioralSummary["identity"]["boundaryBinding"];
    calls?: Array<{ callee: string; summary?: string }>;
  }): BehavioralSummary {
    const start = spec.line ?? 1;
    return {
      kind: spec.kind,
      location: {
        file: spec.file,
        range: { start, end: start + 9 },
        exportName: spec.name,
      },
      identity: {
        name: spec.name,
        exportPath: [spec.name],
        boundaryBinding: spec.binding ?? null,
        id: spec.id,
      },
      inputs: [],
      transitions: [
        {
          id: `${spec.name}:default`,
          conditions: [],
          output: { type: "return", value: null },
          effects: (spec.calls ?? []).map((call) => ({
            type: "invocation" as const,
            callee: call.callee,
            args: [],
            async: false,
            ...(call.summary !== undefined ? { summary: call.summary } : {}),
          })),
          location: { start, end: start + 9 },
          isDefault: true,
        },
      ],
      gaps: [],
      confidence: CONFIDENT,
    } as BehavioralSummary;
  }

  const evaluate = unit({
    kind: "library",
    file: "packages/datalog/src/index.ts",
    name: "evaluate",
    id: "repo::packages/datalog/src/index.ts::evaluate",
    binding: evaluateExport,
  });
  const evaluateCall = {
    callee: "evaluate",
    summary: "repo::packages/datalog/src/index.ts::evaluate",
  };

  /** Bound to evaluate through its import, and calls it in its body. */
  const reachesBase = unit({
    kind: "caller",
    file: "packages/ruby/src/storage.ts",
    name: "reachesBase",
    id: "repo::packages/ruby/src/storage.ts::reachesBase",
    line: 66,
    binding: evaluateExport,
    calls: [evaluateCall],
  });
  const storageEffects = unit({
    kind: "caller",
    file: "packages/ruby/src/storage.ts",
    name: "storageEffects",
    id: "repo::packages/ruby/src/storage.ts::storageEffects",
    line: 121,
    calls: [
      {
        callee: "reachesBase",
        summary: "repo::packages/ruby/src/storage.ts::reachesBase",
      },
    ],
  });

  /** Bound to evaluate, with a body the run never read. */
  const boundOnly = unit({
    kind: "caller",
    file: "packages/resolution/src/onDemand.test.ts",
    name: "boundOnly",
    id: "repo::packages/resolution/src/onDemand.test.ts::boundOnly",
    line: 182,
    binding: evaluateExport,
  });

  /** One function, two summaries: the export it provides and the one it calls. */
  const analyzeFlowProvider = unit({
    kind: "library",
    file: "packages/checker/src/reachability.ts",
    name: "analyzeFlow",
    id: "repo::packages/checker/src/reachability.ts::analyzeFlow#fn:@demo/checker::analyzeFlow",
    line: 413,
    binding: analyzeExport,
    calls: [evaluateCall],
  });
  const analyzeFlowCaller = unit({
    kind: "caller",
    file: "packages/checker/src/reachability.ts",
    name: "analyzeFlow",
    id: "repo::packages/checker/src/reachability.ts::analyzeFlow#fn:@demo/datalog::evaluate",
    line: 413,
    binding: evaluateExport,
    calls: [evaluateCall],
  });

  const all = [
    evaluate,
    reachesBase,
    storageEffects,
    boundOnly,
    analyzeFlowProvider,
    analyzeFlowCaller,
  ];

  function answer(
    question: string,
    summaries: BehavioralSummary[],
  ): {
    code: number;
    headline: string;
    items: Array<{ unit: string }>;
    json: Record<string, unknown>;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-one-"));
    fs.writeFileSync(path.join(dir, "code.json"), JSON.stringify(summaries));
    try {
      const { exitCode, answer: json } = answerQuestion({
        question,
        dir,
        output: path.join(dir, "answer.txt"),
      });
      if (json === null) {
        throw new Error(`not a question suss answers: ${question}`);
      }
      return {
        code: exitCode,
        headline: json.headline,
        items: json.items as Array<{ unit: string }>,
        json,
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const callers = (question: string): string[] =>
    answer(question, all)
      .items.map((item) => item.unit)
      .sort();

  it("lists the callers of the subject, not the callers of what it calls", () => {
    expect(callers("what calls reachesBase")).toEqual([
      "repo::packages/ruby/src/storage.ts::storageEffects",
    ]);
  });

  it("gives the bare name, the export spelling, and the reads question one answer", () => {
    const byName = callers("what calls evaluate");

    expect(byName).toEqual([
      "repo::packages/checker/src/reachability.ts::analyzeFlow#fn:@demo/checker::analyzeFlow",
      "repo::packages/resolution/src/onDemand.test.ts::boundOnly",
      "repo::packages/ruby/src/storage.ts::reachesBase",
    ]);
    expect(callers("what calls fn:@demo/datalog::evaluate")).toEqual(byName);
    expect(callers("what reads fn:@demo/datalog::evaluate")).toEqual(byName);
  });

  it("says what a caller itself provides, apart from what its id happens to say", () => {
    const items = answer("what calls evaluate", all).items as Array<{
      unit: string;
      provides?: string;
    }>;

    const provider = items.find(
      (item) =>
        item.unit ===
        "repo::packages/checker/src/reachability.ts::analyzeFlow#fn:@demo/checker::analyzeFlow",
    );
    const plain = items.find(
      (item) => item.unit === "repo::packages/ruby/src/storage.ts::reachesBase",
    );

    expect(provider?.provides).toBe("fn:@demo/checker::analyzeFlow");
    expect(plain?.provides).toBeUndefined();
  });

  it("says when a bare name could mean several functions, and which", () => {
    const twin = unit({
      kind: "library",
      file: "packages/other/src/index.ts",
      name: "evaluate",
      id: "repo::packages/other/src/index.ts::evaluate",
    });

    const { code, headline } = answer("what calls evaluate", [...all, twin]);

    expect(code).toBe(1);
    expect(headline).toContain("could mean 2 functions");
    expect(headline).toContain("repo::packages/other/src/index.ts::evaluate");
  });

  it("counts a direct caller that provides an export among what reaches the target", () => {
    const { items } = answer("what reaches fn:@demo/datalog::evaluate", all);

    expect(items.map((item) => item.unit)).toContain(
      "repo::packages/checker/src/reachability.ts::analyzeFlow#fn:@demo/checker::analyzeFlow",
    );
  });

  it("follows a chain of eleven calls to the target", () => {
    const chain: BehavioralSummary[] = [evaluate];
    let callee = evaluateCall;
    for (let hop = 1; hop <= 11; hop += 1) {
      const name = `hop${hop}`;
      const id = `repo::src/${name}.ts::${name}`;
      chain.push(
        unit({
          kind: hop === 11 ? "handler" : "library",
          file: `src/${name}.ts`,
          name,
          id,
          calls: [callee],
          ...(hop === 11
            ? {
                binding: restBinding({
                  transport: "http",
                  recognition: "test",
                  method: "GET",
                  path: "/top",
                }),
              }
            : {}),
        }),
      );
      callee = { callee: name, summary: id };
    }

    const { items } = answer("what reaches fn:@demo/datalog::evaluate", chain);

    expect(items).toEqual([
      expect.objectContaining({
        unit: "repo::src/hop11.ts::hop11",
        boundary: "GET /top",
        through: [
          "hop10",
          "hop9",
          "hop8",
          "hop7",
          "hop6",
          "hop5",
          "hop4",
          "hop3",
          "hop2",
          "hop1",
          "evaluate",
        ],
      }),
    ]);
  });

  it("answers why with the one-step chain when the subject calls the target", () => {
    const { code, headline, json } = answer(
      "why does fn:@demo/checker::analyzeFlow reach fn:@demo/datalog::evaluate",
      all,
    );

    expect(code).toBe(0);
    expect(headline).toBe("analyzeFlow reaches fn:@demo/datalog::evaluate:");
    expect(json.chain).toEqual(["analyzeFlow", "evaluate"]);
    expect(json.hops).toEqual([
      expect.objectContaining({
        from: "repo::packages/checker/src/reachability.ts::analyzeFlow#fn:@demo/checker::analyzeFlow",
        callee: "evaluate",
        to: "repo::packages/datalog/src/index.ts::evaluate",
        fromProvides: "fn:@demo/checker::analyzeFlow",
        toProvides: "fn:@demo/datalog::evaluate",
      }),
    ]);
  });

  it("answers why with the same chain what reaches reports", () => {
    const { code, json } = answer(
      "why does storageEffects reach fn:@demo/datalog::evaluate",
      all,
    );

    expect(code).toBe(0);
    expect(json.chain).toEqual(["storageEffects", "reachesBase", "evaluate"]);
    expect(
      (json.hops as Array<{ from: string; to: string | null }>).map((hop) => [
        hop.from,
        hop.to,
      ]),
    ).toEqual([
      [
        "repo::packages/ruby/src/storage.ts::storageEffects",
        "repo::packages/ruby/src/storage.ts::reachesBase",
      ],
      [
        "repo::packages/ruby/src/storage.ts::reachesBase",
        "repo::packages/datalog/src/index.ts::evaluate",
      ],
    ]);
    expect(
      (json.hops as Array<{ fromProvides?: string; toProvides?: string }>).map(
        (hop) => [hop.fromProvides, hop.toProvides],
      ),
    ).toEqual([
      [undefined, undefined],
      [undefined, "fn:@demo/datalog::evaluate"],
    ]);
  });

  it("refuses a why question whose bare subject could mean two functions", () => {
    const twin = unit({
      kind: "library",
      file: "packages/other/src/index.ts",
      name: "analyzeFlow",
      id: "repo::packages/other/src/index.ts::analyzeFlow",
      calls: [evaluateCall],
    });

    const { code, headline } = answer(
      "why does analyzeFlow reach fn:@demo/datalog::evaluate",
      [...all, twin],
    );

    expect(code).toBe(1);
    expect(headline).toContain("could mean 2 functions");
    expect(headline).toContain(
      "repo::packages/other/src/index.ts::analyzeFlow",
    );
  });

  it("answers why when the target is a plain function rather than an export", () => {
    const { code, headline, json } = answer(
      "why does storageEffects reach reachesBase",
      all,
    );

    expect(code).toBe(0);
    expect(headline).toBe(
      "storageEffects reaches repo::packages/ruby/src/storage.ts::reachesBase:",
    );
    expect(json.chain).toEqual(["storageEffects", "reachesBase"]);
  });

  it("says which functions do reach the target when the subject does not", () => {
    const { code, headline, json } = answer(
      "why does boundOnly reach reachesBase",
      all,
    );

    expect(code).toBe(1);
    expect(headline).toBe(
      "Nothing in these summaries says boundOnly reaches repo::packages/ruby/src/storage.ts::reachesBase.",
    );
    expect(json.needs).toEqual([
      "repo::packages/ruby/src/storage.ts::reachesBase is where storageEffects goes, and no call chain here connects boundOnly to it.",
    ]);
  });

  it("ends the chain at the binding when nothing here provides the export", () => {
    const { code, json } = answer(
      "why does boundOnly reach fn:@demo/datalog::evaluate",
      all.filter((summary) => summary !== evaluate),
    );

    expect(code).toBe(0);
    expect(json.chain).toEqual(["boundOnly", "fn:@demo/datalog::evaluate"]);
    expect(json.hops).toEqual([
      expect.objectContaining({ to: null, recorded: "bound" }),
    ]);
  });
});

describe("suss ask over a call passed by name to a parameter", () => {
  const CONFIDENT = { source: "inferred_static", level: "high" } as const;

  /**
   * A function reached only by being passed to something that calls it
   * back, and one that touches a boundary of its own, so a "what does
   * X reach" question over its caller has something to show.
   */
  const recordMountStatement: BehavioralSummary = {
    kind: "library",
    location: {
      file: "src/routers.ts",
      range: { start: 30, end: 39 },
      exportName: "recordMountStatement",
    },
    identity: {
      name: "recordMountStatement",
      exportPath: ["recordMountStatement"],
      boundaryBinding: null,
      id: "repo::src/routers.ts::recordMountStatement",
    },
    inputs: [],
    transitions: [
      {
        id: "recordMountStatement:default",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: storageBinding({
              recognition: "aws-dynamodb",
              storageSystem: "aws.dynamodb",
              scope: "default",
              container: "mounts",
              accessPath: null,
            }),
            callee: "client.send",
            interaction: {
              class: "storage-access",
              kind: "write",
              fields: [],
              operation: "put",
            },
          },
        ],
        location: { start: 31, end: 33 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };

  /** Calls its own `visit` parameter, at position 1, as `visit(stmt)`. */
  const walkStatements: BehavioralSummary = {
    kind: "library",
    location: {
      file: "src/routers.ts",
      range: { start: 1, end: 13 },
      exportName: "walkStatements",
    },
    identity: {
      name: "walkStatements",
      exportPath: ["walkStatements"],
      boundaryBinding: null,
      id: "repo::src/routers.ts::walkStatements",
    },
    inputs: [],
    transitions: [
      {
        id: "walkStatements:default",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "invocation",
            callee: "visit",
            calleeParameter: 1,
            args: [],
            async: false,
          },
        ],
        location: { start: 3, end: 5 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };

  /** Passes `recordMountStatement` into `walkStatements`'s `visit` parameter. */
  const collectMounts: BehavioralSummary = {
    kind: "handler",
    location: {
      file: "src/routers.ts",
      range: { start: 15, end: 28 },
      exportName: "collectMounts",
    },
    identity: {
      name: "collectMounts",
      exportPath: ["collectMounts"],
      boundaryBinding: null,
      id: "repo::src/routers.ts::collectMounts",
    },
    inputs: [],
    transitions: [
      {
        id: "collectMounts:default",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "invocation",
            callee: "walkStatements",
            summary: "repo::src/routers.ts::walkStatements",
            argsSummary: { "1": "repo::src/routers.ts::recordMountStatement" },
            args: [],
            async: false,
          },
        ],
        location: { start: 16, end: 17 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: CONFIDENT,
  };

  const summaries = [recordMountStatement, walkStatements, collectMounts];

  function answer(
    question: string,
    json = false,
  ): { output: string; code: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-passed-"));
    fs.writeFileSync(path.join(dir, "code.json"), JSON.stringify(summaries));
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = ask({ question, dir, json });
      return { output: chunks.join(""), code };
    } finally {
      process.stdout.write = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("says the unit that passes the callback calls it, for what calls", () => {
    const { output, code } = answer("what calls recordMountStatement");

    expect(code).toBe(0);
    expect(output).toContain("collectMounts");
  });

  it("reaches the boundary the passed function touches", () => {
    const { output, code } = answer("what does collectMounts reach");

    expect(code).toBe(0);
    expect(output).toContain("aws.dynamodb:mounts");
  });

  it("spells the hop through the parameter, for why does", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-passed-why-"));
    fs.writeFileSync(path.join(dir, "code.json"), JSON.stringify(summaries));
    try {
      const { exitCode, answer: json } = answerQuestion({
        question: "why does collectMounts reach recordMountStatement",
        dir,
        output: path.join(dir, "answer.txt"),
      });
      expect(exitCode).toBe(0);
      expect(json?.headline).toBe(
        "collectMounts reaches repo::src/routers.ts::recordMountStatement:",
      );
      expect(json?.hops).toEqual([
        expect.objectContaining({
          callee: "walkStatements, which calls it as visit",
          recorded: "passed",
        }),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an argument passed into an unresolved callee harmless", () => {
    const mapCall: BehavioralSummary = {
      ...collectMounts,
      identity: {
        ...collectMounts.identity,
        name: "runAll",
        exportPath: ["runAll"],
        id: "repo::src/routers.ts::runAll",
      },
      transitions: [
        {
          ...collectMounts.transitions[0],
          effects: [
            {
              type: "invocation",
              callee: "arr.map",
              argsSummary: {
                "0": "repo::src/routers.ts::recordMountStatement",
              },
              args: [],
              async: false,
            },
          ],
        },
      ],
    } as BehavioralSummary;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-unresolved-"));
    fs.writeFileSync(
      path.join(dir, "code.json"),
      JSON.stringify([recordMountStatement, mapCall]),
    );
    try {
      const { exitCode, answer: json } = answerQuestion({
        question: "what calls recordMountStatement",
        dir,
        output: path.join(dir, "answer.txt"),
      });
      expect(exitCode).toBe(0);
      expect(json?.items).toEqual([]);
      expect(json?.headline).toBe(
        "Nothing in these summaries calls repo::src/routers.ts::recordMountStatement.",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suss ask what X provides", () => {
  const CONFIDENT = { source: "inferred_static", level: "high" } as const;

  function exported(spec: {
    file: string;
    name: string;
    line: number;
    packageName: string;
  }): BehavioralSummary {
    return {
      kind: "library",
      location: {
        file: spec.file,
        range: { start: spec.line, end: spec.line + 5 },
        exportName: spec.name,
      },
      identity: {
        name: spec.name,
        exportPath: [spec.name],
        boundaryBinding: packageExportBinding({
          recognition: "package-exports",
          packageName: spec.packageName,
          exportPath: [spec.name],
        }),
        id: `repo::${spec.file}::${spec.name}`,
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: CONFIDENT,
    } as BehavioralSummary;
  }

  const analyzeFlow = exported({
    file: "packages/checker/src/flow/reachability.ts",
    name: "analyzeFlow",
    line: 400,
    packageName: "@suss/checker",
  });
  const checkAll = exported({
    file: "packages/checker/src/index.ts",
    name: "checkAll",
    line: 12,
    packageName: "@suss/checker",
  });
  const evaluate = exported({
    file: "packages/datalog/src/index.ts",
    name: "evaluate",
    line: 5,
    packageName: "@suss/datalog",
  });

  function answer(
    question: string,
    summaries: BehavioralSummary[],
  ): { output: string; code: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-provides-"));
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

  it("lists every boundary a package provides, wherever its exports sit", () => {
    const { output, code } = answer("what does @suss/checker provide", [
      analyzeFlow,
      checkAll,
      evaluate,
    ]);

    expect(code).toBe(0);
    expect(output).toContain("@suss/checker provides 2 boundaries:");
    expect(output).toContain(
      "fn:@suss/checker::analyzeFlow, from analyzeFlow (packages/checker/src/flow/reachability.ts:400)",
    );
    expect(output).toContain(
      "fn:@suss/checker::checkAll, from checkAll (packages/checker/src/index.ts:12)",
    );
    expect(output).not.toContain("@suss/datalog");
  });

  it("answers the export alias the same way as provide", () => {
    const summaries = [analyzeFlow, checkAll];
    const provide = answer("what does @suss/checker provide", summaries);
    const exportAlias = answer("what does @suss/checker export", summaries);

    expect(exportAlias.output).toBe(provide.output);
  });

  it("lists the boundaries a file provides", () => {
    const { output, code } = answer(
      "what does src/editions/routes.ts provide",
      [route, nestedRoute],
    );

    expect(code).toBe(0);
    expect(output).toContain("provides 2 boundaries:");
    expect(output).toContain("GET /editions, from listEditions");
    expect(output).toContain("GET /editions/{id}/comments, from listComments");
  });

  it("says plainly when the subject only consumes boundaries", () => {
    const { output, code } = answer("what does byPublication provide", [dao]);

    expect(code).toBe(0);
    expect(output).toContain(
      "Nothing here says byPublication provides a boundary.",
    );
    expect(output).toContain("only consume boundaries");
  });

  it("says a file that only consumes consumes, even though its path has a slash", () => {
    const { output, code } = answer("what does src/editions/dao.ts provide", [
      dao,
    ]);

    expect(code).toBe(0);
    expect(output).toContain(
      "The units src/editions/dao.ts picked out only consume boundaries.",
    );
    expect(output).not.toContain("package-exports");
  });

  it("points at extracting package exports when only a caller of the package is here", () => {
    const caller: BehavioralSummary = {
      kind: "caller",
      location: {
        file: "src/uses.ts",
        range: { start: 1, end: 5 },
        exportName: "callsIt",
      },
      identity: {
        name: "callsIt",
        exportPath: ["callsIt"],
        boundaryBinding: packageExportBinding({
          recognition: "package-exports",
          packageName: "@suss/missing",
          exportPath: ["doThing"],
        }),
        id: "repo::src/uses.ts::callsIt",
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: CONFIDENT,
    };

    const { output, code } = answer("what does @suss/missing provide", [
      caller,
    ]);

    expect(code).toBe(0);
    expect(output).toContain(
      "Nothing here says @suss/missing provides a boundary.",
    );
    expect(output).toContain(
      "No summary here provides @suss/missing. Extract the package that exports it with -f package-exports",
    );
  });

  it("says so when nothing here is at the subject at all", () => {
    const { output, code } = answer("what does nowhere.ts provide", [dao]);

    expect(code).toBe(1);
    expect(output).toContain("Nothing in these summaries is at nowhere.ts");
  });
});

describe("suss ask, when a subject picks out more than one boundary", () => {
  const CONFIDENT = { source: "inferred_static", level: "high" } as const;

  function exported(spec: {
    file: string;
    name: string;
    line: number;
    packageName: string;
  }): BehavioralSummary {
    return {
      kind: "library",
      location: {
        file: spec.file,
        range: { start: spec.line, end: spec.line + 5 },
        exportName: spec.name,
      },
      identity: {
        name: spec.name,
        exportPath: [spec.name],
        boundaryBinding: packageExportBinding({
          recognition: "package-exports",
          packageName: spec.packageName,
          exportPath: [spec.name],
        }),
        id: `repo::${spec.file}::${spec.name}`,
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: CONFIDENT,
    } as BehavioralSummary;
  }

  const analyzeFlow = exported({
    file: "packages/checker/src/flow/reachability.ts",
    name: "analyzeFlow",
    line: 400,
    packageName: "@suss/checker",
  });
  const checkAll = exported({
    file: "packages/checker/src/index.ts",
    name: "checkAll",
    line: 12,
    packageName: "@suss/checker",
  });
  const evaluate = exported({
    file: "packages/datalog/src/index.ts",
    name: "evaluate",
    line: 5,
    packageName: "@suss/datalog",
  });

  function answer(
    question: string,
    summaries: BehavioralSummary[],
    options: { json?: boolean } = {},
  ): { output: string; code: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ask-ambiguous-"));
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

  it("refuses a package name as the declares subject, and points at what it provides", () => {
    const { output, code } = answer("what does @suss/checker declare", [
      analyzeFlow,
      checkAll,
      evaluate,
    ]);

    expect(code).toBe(1);
    expect(output).toContain(
      "@suss/checker could mean 2 boundaries here: fn:@suss/checker::analyzeFlow, fn:@suss/checker::checkAll. Ask about one of them.",
    );
    expect(output).toContain(
      "@suss/checker is a package. suss ask 'what does @suss/checker provide' lists what it exports.",
    );
    expect(output).not.toContain("@suss/datalog");
  });

  it("says the same refusal in JSON, with the hint under needs and no items", () => {
    const { output, code } = answer(
      "what does @suss/checker declare",
      [analyzeFlow, checkAll, evaluate],
      { json: true },
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(output) as {
      found: boolean;
      headline: string;
      items: unknown[];
      needs: string[];
    };
    expect(parsed.found).toBe(false);
    expect(parsed.items).toEqual([]);
    expect(parsed.headline).toContain(
      "@suss/checker could mean 2 boundaries here",
    );
    expect(parsed.needs).toEqual([
      "@suss/checker is a package. suss ask 'what does @suss/checker provide' lists what it exports.",
    ]);
  });

  it("does not refuse a subject that still picks out exactly one boundary", () => {
    const { output, code } = answer("what does analyzeFlow declare", [
      analyzeFlow,
      checkAll,
      evaluate,
    ]);

    expect(code).toBe(0);
    expect(output).not.toContain("could mean");
    expect(output).toContain(
      "Nothing here declares what fn:@suss/checker::analyzeFlow serves.",
    );
  });

  it("refuses the same package name as a reads subject", () => {
    const { output, code } = answer("what reads @suss/checker", [
      analyzeFlow,
      checkAll,
    ]);

    expect(code).toBe(1);
    expect(output).toContain(
      "@suss/checker could mean 2 boundaries here: fn:@suss/checker::analyzeFlow, fn:@suss/checker::checkAll. Ask about one of them.",
    );
  });
});
