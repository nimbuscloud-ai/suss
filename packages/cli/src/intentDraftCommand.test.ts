import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadIntentDoc } from "@suss/contract-intent";

import {
  intentDraft,
  intentDraftResult,
  slug,
  statusOutcomeId,
  toAuthoredShape,
} from "./intentDraftCommand.js";
import { runCli } from "./run.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-infer-intent-"));
  created.push(dir);
  return dir;
}

interface CapturedIO {
  stdout: string;
  stderr: string;
}

async function capture(fn: () => Promise<number>): Promise<{
  exit: number;
  io: CapturedIO;
}> {
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
  let exit: number;
  try {
    exit = await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { exit, io: { stdout: out.join(""), stderr: err.join("") } };
}

// ---------------------------------------------------------------------------
// Summaries to draft from
// ---------------------------------------------------------------------------

const ERROR_BODY: TypeShape = {
  type: "record",
  properties: { error: { type: "text" } },
};

function responds(
  id: string,
  status: number,
  options: { body?: TypeShape; conditions?: Transition["conditions"] } = {},
): Transition {
  return {
    id,
    conditions: options.conditions ?? [],
    output: {
      type: "response",
      statusCode: { type: "literal", value: status },
      body: options.body ?? null,
      headers: {},
    },
    effects: [],
    location: { start: 1, end: 2 },
    isDefault: false,
  };
}

function provider(
  name: string,
  binding: BoundaryBinding,
  transitions: Transition[],
): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/routes.ts",
      range: { start: 1, end: 9 },
      exportName: null,
    },
    identity: { name, exportPath: null, boundaryBinding: binding },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function restProvider(
  method: string,
  routePath: string,
  transitions: Transition[],
): BehavioralSummary {
  return provider(
    `${method} ${routePath}`,
    {
      transport: "http",
      semantics: { name: "rest", method, path: routePath },
      recognition: "test",
    },
    transitions,
  );
}

const missingId: Transition = responds("t400", 400, {
  body: ERROR_BODY,
  conditions: [
    {
      type: "truthinessCheck",
      subject: { type: "input", inputRef: "request.params.id", path: [] },
      negated: true,
    },
  ],
});

function throws(errorType: string | null): Transition {
  return {
    id: `t-throw-${errorType ?? "bare"}`,
    conditions: [],
    output: { type: "throw", exceptionType: errorType, message: null },
    effects: [],
    location: { start: 1, end: 2 },
    isDefault: false,
  };
}

const notFound: Transition = responds("t404", 404, { body: ERROR_BODY });

const found: Transition = responds("t200", 200, {
  body: {
    type: "record",
    properties: { id: { type: "text" }, name: { type: "text" } },
  },
});

const foundAdmin: Transition = responds("t200admin", 200, {
  body: {
    type: "record",
    properties: { id: { type: "text" }, admin: { type: "boolean" } },
  },
});

function firstDocOf(summaries: BehavioralSummary[]) {
  const result = intentDraftResult(summaries, "summaries/code.json");
  const doc = result.drafted[0];
  if (doc === undefined) {
    throw new Error(`nothing drafted: ${JSON.stringify(result.undrafted)}`);
  }
  return { doc, parsed: YAML.parse(doc.yaml), result };
}

/** What a person does to a draft before it is worth checking. */
function curated(yaml: string): unknown {
  const doc = YAML.parse(yaml);
  return {
    ...doc,
    purpose: "Look one user up by id.",
    audience: "web-client",
    source: "inferred, curated",
  };
}

// ---------------------------------------------------------------------------

describe("slug", () => {
  it("turns a boundary key into a file-safe name", () => {
    expect(slug("GET /users/{id}")).toBe("get-users-id");
    expect(slug("fn:@suss/checker::checkAll")).toBe(
      "fn-suss-checker-check-all",
    );
  });
});

describe("intentDraftResult", () => {
  it("names each outcome after its status code", () => {
    const { parsed } = firstDocOf([
      restProvider("GET", "/users/:id", [missingId, notFound, found]),
    ]);

    expect(parsed.transitions.map((t: { id: string }) => t.id)).toEqual([
      "400-bad-request",
      "404-not-found",
      "200-ok",
    ]);
  });

  it("tells two outcomes on the same status apart", () => {
    const { parsed } = firstDocOf([
      restProvider("GET", "/users/:id", [foundAdmin, found]),
    ]);

    expect(parsed.transitions.map((t: { id: string }) => t.id)).toEqual([
      "200-ok",
      "200-ok-2",
    ]);
  });

  it("says which input the branch turned on, rather than its source", () => {
    const { parsed } = firstDocOf([
      restProvider("GET", "/users/:id", [missingId, notFound]),
    ]);

    expect(parsed.transitions[0].when).toEqual([
      { input: "request.params.id", is: "missing" },
    ]);
    expect(parsed.transitions[1].when).toBe("otherwise");
  });

  it("leaves purpose and audience blank, with a hint beside each", () => {
    const { doc, parsed } = firstDocOf([
      restProvider("GET", "/users/:id", [found]),
    ]);

    expect(parsed.source).toBe("inferred");
    expect(parsed.purpose).toBe("");
    expect(parsed.audience).toBe("");
    expect(doc.yaml).toContain(
      'purpose: "" # what this boundary is for, in your words',
    );
    expect(doc.yaml).toContain(
      'audience: "" # who observes it: a customer, an operator, another service',
    );
  });

  it("opens by saying which boundary this is and where it was read", () => {
    const { doc } = firstDocOf([restProvider("GET", "/users/:id", [found])]);

    expect(doc.yaml).toContain("# GET /users/{id}, as the code has it today.");
    expect(doc.yaml).toContain(
      "# Read from src/routes.ts, by way of summaries/code.json.",
    );
    expect(doc.yaml).toContain('set source to "inferred, curated"');
  });

  it("puts a blank line between the parts of the document", () => {
    const { doc } = firstDocOf([restProvider("GET", "/users/:id", [found])]);

    expect(doc.yaml).toContain("kind: boundary\n\nname: ");
    expect(doc.yaml).toContain("source: inferred\n\nboundary:");
    expect(doc.yaml).toMatch(/\n\ntransitions:/);
  });

  it("writes a draft the reader rejects until the blanks are filled", () => {
    const { doc } = firstDocOf([
      restProvider("GET", "/users/:id", [missingId, notFound, found]),
    ]);

    expect(() => loadIntentDoc(YAML.parse(doc.yaml))).toThrow(
      /purpose and audience are still blank/,
    );
  });

  it("writes a draft the reader accepts once they are", () => {
    const { doc } = firstDocOf([
      restProvider("GET", "/users/:id", [missingId, notFound, found]),
    ]);

    const summary = loadIntentDoc(curated(doc.yaml));
    expect(summary.kind).toBe("boundary");
    if (summary.kind === "boundary") {
      expect(summary.outcomes.map((o) => o.status)).toEqual([400, 404, 200]);
      expect(summary.source).toBe("inferred, curated");
    }
  });

  it("spells out a record body property by property", () => {
    const { parsed } = firstDocOf([restProvider("GET", "/users/:id", [found])]);

    expect(parsed.transitions[0].response.body).toEqual({
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
    });
  });

  it("declares no body when the shape is one the schema cannot spell", () => {
    const union: TypeShape = {
      type: "union",
      variants: [{ type: "text" }, { type: "integer" }],
    };
    const { parsed } = firstDocOf([
      restProvider("GET", "/users/:id", [responds("t", 200, { body: union })]),
    ]);

    expect(parsed.transitions[0].response.body).toBeUndefined();
  });

  it("keeps a function-call boundary's package and export path", () => {
    const { parsed } = firstDocOf([
      {
        kind: "library",
        location: {
          file: "src/index.ts",
          range: { start: 1, end: 9 },
          exportName: null,
        },
        identity: {
          name: "checkAll",
          exportPath: ["checkAll"],
          boundaryBinding: {
            transport: "in-process",
            semantics: {
              name: "function-call",
              package: "@suss/checker",
              exportPath: ["checkAll"],
            },
            recognition: "test",
          },
        },
        inputs: [],
        transitions: [
          {
            id: "r",
            conditions: [],
            output: { type: "return", value: { type: "boolean" } },
            effects: [],
            location: { start: 1, end: 2 },
            isDefault: true,
          },
        ],
        gaps: [],
        confidence: { source: "inferred_static", level: "high" },
      },
    ]);

    expect(parsed.boundary).toEqual({
      transport: "in-process",
      semantics: "function-call",
      package: "@suss/checker",
      exportPath: ["checkAll"],
    });
    expect(parsed.transitions[0].returns.body).toEqual({ type: "boolean" });
  });

  it("says what happened for a boundary with no transitions", () => {
    const result = intentDraftResult(
      [restProvider("GET", "/empty", [])],
      "code.json",
    );

    expect(result.drafted).toEqual([]);
    expect(result.undrafted).toEqual([
      {
        boundary: "GET /empty",
        reason: "the summaries record no transition for it",
      },
    ]);
  });

  it("drafts a queue consumer against the channel its code names", () => {
    const result = intentDraftResult(
      [
        {
          kind: "handler",
          location: {
            file: "src/worker.ts",
            range: { start: 1, end: 9 },
            exportName: null,
          },
          identity: {
            name: "orders",
            exportPath: null,
            boundaryBinding: {
              transport: "aws_sqs",
              semantics: {
                name: "message-bus",
                messageBus: "aws_sqs",
                channel: "OrdersQueue",
              },
              recognition: "test",
            },
          },
          inputs: [],
          transitions: [responds("t", 200)],
          gaps: [],
          confidence: { source: "inferred_static", level: "high" },
        },
      ],
      "code.json",
    );

    expect(result.undrafted).toEqual([]);
    expect(result.drafted).toHaveLength(1);
    expect(result.drafted[0].boundary).toBe("bus:aws_sqs OrdersQueue");
    expect(result.drafted[0].yaml).toContain("semantics: message-bus");
    expect(result.drafted[0].yaml).toContain("channel: OrdersQueue");
  });

  it("skips a consumer, which calls a boundary rather than providing one", () => {
    const consumer: BehavioralSummary = {
      ...restProvider("GET", "/users/:id", [found]),
      kind: "client",
    };

    expect(intentDraftResult([consumer], "code.json")).toEqual({
      drafted: [],
      undrafted: [],
    });
  });

  it("names a thrown error type in the outcome id", () => {
    const { parsed } = firstDocOf([
      restProvider("GET", "/users/:id", [
        throws("NotFoundError"),
        throws(null),
      ]),
    ]);

    expect(parsed.transitions.map((t: { id: string }) => t.id)).toEqual([
      "throws-not-found-error",
      "throws",
    ]);
    expect(parsed.transitions[0].throws).toEqual({
      errorType: "NotFoundError",
    });
    expect(parsed.transitions[1].throws).toEqual({});
  });

  it("declares nothing for a transition whose status the code never settles", () => {
    const unsettled: Transition = {
      ...responds("t", 200),
      output: {
        type: "response",
        statusCode: { type: "unresolved", sourceText: "code" },
        body: null,
        headers: {},
      },
    };
    const { doc, parsed } = firstDocOf([
      restProvider("GET", "/users/:id", [found, unsettled]),
    ]);

    expect(parsed.transitions).toHaveLength(1);
    expect(doc.yaml).toContain(
      "# 1 transition(s) here produce nothing this schema can",
    );
  });

  it("declares nothing for a transition that produces no outcome at all", () => {
    const renders: Transition = {
      ...responds("t", 200),
      output: { type: "render", component: "Page" },
    };
    const result = intentDraftResult(
      [restProvider("GET", "/page", [renders])],
      "code.json",
    );

    expect(result.undrafted[0].reason).toBe(
      "no transition of it produces a response, a return, or a throw",
    );
  });

  it("gathers two implementations of one boundary into one document", () => {
    const { parsed, result } = firstDocOf([
      restProvider("GET", "/users/:id", [missingId]),
      restProvider("GET", "/users/:id", [notFound]),
    ]);

    expect(result.drafted).toHaveLength(1);
    expect(parsed.transitions.map((t: { id: string }) => t.id)).toEqual([
      "400-bad-request",
      "404-not-found",
    ]);
  });

  it("reports each protocol boundary intent has no shape for", () => {
    const result = intentDraftResult(
      [
        provider(
          "cart",
          {
            transport: "in-process",
            semantics: {
              name: "storage",
              storageSystem: "dynamodb",
              scope: "table",
              container: "orders",
              accessPath: null,
            },
            recognition: "test",
          },
          [responds("t", 200)],
        ),
        provider(
          "config",
          {
            transport: "in-process",
            semantics: {
              name: "runtime-config",
              deploymentTarget: "lambda",
              instanceName: "orders",
            },
            recognition: "test",
          },
          [responds("t", 200)],
        ),
        provider(
          "user",
          {
            transport: "http",
            semantics: {
              name: "graphql-resolver",
              typeName: "Query",
              fieldName: "user",
            },
            recognition: "test",
          },
          [responds("t", 200)],
        ),
        provider(
          "getUser",
          {
            transport: "http",
            semantics: {
              name: "graphql-operation",
              operationName: "GetUser",
              operationType: "query",
            },
            recognition: "test",
          },
          [responds("t", 200)],
        ),
        provider(
          "latency",
          {
            transport: "in-process",
            semantics: {
              name: "metric",
              metricSystem: "cloudwatch",
              metricType: "latency",
            },
            recognition: "test",
          },
          [responds("t", 200)],
        ),
      ],
      "code.json",
    );

    expect(result.drafted).toEqual([]);
    expect(result.undrafted.map((one) => one.reason)).toEqual([
      "it has no key the checker could pair intent against: a store has no key at all: write it as `- writes: <store>` on an outcome of the boundary that touches it instead",
      "boundary intent declares rest, function-call, message-bus and storage boundaries, and this one is runtime-config",
      "boundary intent declares rest, function-call, message-bus and storage boundaries, and this one is graphql-resolver",
      "boundary intent declares rest, function-call, message-bus and storage boundaries, and this one is graphql-operation",
      "boundary intent declares rest, function-call, message-bus and storage boundaries, and this one is metric",
    ]);
  });

  it("says what happened for a boundary the checker could not pair against", () => {
    const result = intentDraftResult(
      [
        provider(
          "renderPage",
          {
            transport: "in-process",
            semantics: { name: "function-call", module: "src/page.tsx" },
            recognition: "test",
          },
          [responds("t", 200)],
        ),
      ],
      "code.json",
    );

    expect(result.drafted).toEqual([]);
    expect(result.undrafted[0].reason).toContain(
      "no key the checker could pair intent against",
    );
  });
});

describe("toAuthoredShape", () => {
  it("maps every shape the code can produce onto one the schema spells", () => {
    const cases: Array<[TypeShape, unknown]> = [
      [{ type: "text" }, { type: "string" }],
      [{ type: "integer" }, { type: "integer" }],
      [{ type: "number" }, { type: "number" }],
      [{ type: "boolean" }, { type: "boolean" }],
      [{ type: "null" }, { type: "null" }],
      [{ type: "literal", value: "a" }, { type: "string" }],
      [{ type: "literal", value: true }, { type: "boolean" }],
      [{ type: "literal", value: 3 }, { type: "integer" }],
      [{ type: "literal", value: 3.5 }, { type: "number" }],
      [
        { type: "array", items: { type: "text" } },
        { type: "array", items: { type: "string" } },
      ],
      [{ type: "dictionary", values: { type: "text" } }, { type: "unknown" }],
      [{ type: "undefined" }, { type: "unknown" }],
      [{ type: "unknown" }, { type: "unknown" }],
      [{ type: "ref", name: "User" }, { type: "unknown" }],
      [{ type: "union", variants: [{ type: "text" }] }, { type: "unknown" }],
    ];

    for (const [shape, authored] of cases) {
      expect(toAuthoredShape(shape), shape.type).toEqual(authored);
    }
  });

  it("keeps a field whose shape it cannot spell, saying nothing about it", () => {
    expect(
      toAuthoredShape({
        type: "record",
        properties: { id: { type: "text" }, meta: { type: "unknown" } },
      }),
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" }, meta: { type: "unknown" } },
    });
  });
});

describe("statusOutcomeId", () => {
  it("keeps a status nobody has a name for as its number", () => {
    expect(statusOutcomeId(499)).toBe("499");
    expect(statusOutcomeId(418)).toBe("418-i-m-a-teapot");
  });
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function summariesFile(dir: string, summaries: BehavioralSummary[]): string {
  const file = path.join(dir, "code.json");
  fs.writeFileSync(file, JSON.stringify(summaries));
  return file;
}

const TWO_ROUTES = [
  restProvider("GET", "/users/:id", [missingId, notFound, found]),
  restProvider("POST", "/users", [responds("c", 201)]),
];

describe("intentDraft", () => {
  it("writes one file per boundary into the folder it was given", async () => {
    const root = tempDir();
    const from = summariesFile(root, TWO_ROUTES);
    const out = path.join(root, "intent");

    const { exit, io } = await capture(async () => intentDraft({ from, out }));

    expect(exit).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual([
      "get-users-id.intent.yaml",
      "post-users.intent.yaml",
    ]);
    expect(io.stdout).toContain("Drafted 2 boundary intent docs");
    expect(io.stdout).toContain("purpose and audience left blank");
  });

  it("reads a folder of summaries, one file per pack", async () => {
    const root = tempDir();
    const from = path.join(root, "summaries");
    fs.mkdirSync(from);
    fs.writeFileSync(
      path.join(from, "routes.json"),
      JSON.stringify([TWO_ROUTES[0]]),
    );
    fs.writeFileSync(
      path.join(from, "more.json"),
      JSON.stringify([TWO_ROUTES[1]]),
    );
    const out = path.join(root, "intent");

    const { exit } = await capture(async () => intentDraft({ from, out }));

    expect(exit).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual([
      "get-users-id.intent.yaml",
      "post-users.intent.yaml",
    ]);
  });

  it("warns before writing over intent docs that are already there", async () => {
    const root = tempDir();
    const from = summariesFile(root, TWO_ROUTES);
    const out = path.join(root, "intent");
    await capture(async () => intentDraft({ from, out }));

    const { exit, io } = await capture(async () => intentDraft({ from, out }));

    expect(exit).toBe(0);
    expect(io.stderr).toContain("already holds 2 intent doc(s)");
    expect(io.stderr).toContain("re-inferring writes over them");
    expect(io.stderr).toContain("--into");
  });

  it("refuses --into a folder that already holds intent docs", async () => {
    const root = tempDir();
    const from = summariesFile(root, TWO_ROUTES);
    const into = path.join(root, "intent");
    await capture(async () => intentDraft({ from, out: into }));

    expect(() => intentDraft({ from, into })).toThrow(/pick a folder/);
  });

  it("refuses --out and --into together", async () => {
    const root = tempDir();
    const from = summariesFile(root, TWO_ROUTES);

    expect(() =>
      intentDraft({
        from,
        out: path.join(root, "a"),
        into: path.join(root, "b"),
      }),
    ).toThrow(/pass one of them/);
  });

  it("exits non-zero and says why when no boundary could be drafted", async () => {
    const root = tempDir();
    const from = summariesFile(root, [restProvider("GET", "/empty", [])]);

    const { exit, io } = await capture(async () =>
      intentDraft({ from, out: path.join(root, "intent") }),
    );

    expect(exit).toBe(1);
    expect(io.stderr).toContain("could be drafted as intent");
    expect(io.stderr).toContain(
      "GET /empty: the summaries record no transition",
    );
  });

  it("counts the boundaries past the ten it writes out", async () => {
    const root = tempDir();
    const from = summariesFile(
      root,
      Array.from({ length: 12 }, (_, n) =>
        restProvider("GET", `/empty/${n}`, []),
      ),
    );

    const { io } = await capture(async () =>
      intentDraft({ from, out: path.join(root, "intent") }),
    );

    expect(io.stderr).toContain("No document for 12 boundaries:");
    expect(io.stderr).toContain("and 2 more");
  });

  it("reports a summaries file that is not there", () => {
    expect(() => intentDraft({ from: "/nope/code.json" })).toThrow(
      /No file or folder at/,
    );
  });
});

describe("suss infer intent", () => {
  it("drafts through the CLI", async () => {
    const root = tempDir();
    const from = summariesFile(root, TWO_ROUTES);
    const out = path.join(root, "intent");

    const { exit, io } = await capture(() =>
      runCli(["infer", "intent", "--from", from, "--out", out]),
    );

    expect(exit).toBe(0);
    expect(io.stdout).toContain("Drafted 2 boundary intent docs");
    expect(fs.existsSync(path.join(out, "get-users-id.intent.yaml"))).toBe(
      true,
    );
  });

  it("asks for --from when it is left off", async () => {
    const { exit, io } = await capture(() => runCli(["infer", "intent"]));

    expect(exit).toBe(1);
    expect(io.stderr).toContain("infer intent needs --from");
  });

  it("names intent when asked for an artifact it does not draft", async () => {
    const { exit, io } = await capture(() => runCli(["infer", "workflow"]));

    expect(exit).toBe(1);
    expect(io.stderr).toContain("infer has stub, intent and prd");
  });
});

// ---------------------------------------------------------------------------
// Effects: what a transition results in, drafted in `suss ask`'s verbs
// ---------------------------------------------------------------------------

const invoicesWrite: Transition["effects"][number] = {
  type: "interaction",
  binding: {
    transport: "aws-sdk",
    semantics: {
      name: "storage",
      storageSystem: "aws.dynamodb",
      scope: "default",
      container: "Invoices",
      accessPath: null,
    },
    recognition: "test",
  },
  callee: "dynamo.send",
  interaction: {
    class: "storage-access",
    kind: "write",
    fields: ["invoiceId"],
    operation: "PutItemCommand",
  },
};

const queueBinding: BoundaryBinding = {
  transport: "aws_sqs",
  semantics: {
    name: "message-bus",
    messageBus: "aws_sqs",
    channel: "billing.invoicePaid",
  },
  recognition: "test",
};

function returnsWriting(id: string): Transition {
  return {
    id,
    conditions: [],
    output: { type: "return", value: null },
    effects: [invoicesWrite],
    location: { start: 1, end: 2 },
    isDefault: true,
  };
}

describe("drafted effects", () => {
  it("writes what the transition reached beside how it ended", () => {
    const { parsed } = firstDocOf([
      provider("InvoiceWorker.handler", queueBinding, [
        returnsWriting("t-return"),
      ]),
    ]);

    expect(parsed.transitions).toEqual([
      {
        id: "returns",
        when: "every call reaches this outcome",
        returns: {},
        results: [{ writes: "aws.dynamodb:Invoices", fields: ["invoiceId"] }],
      },
    ]);
  });

  it("says which columns the access fills and what it keys on", () => {
    const detailed = returnsWriting("t-return");
    detailed.effects = [
      {
        ...invoicesWrite,
        interaction: {
          class: "storage-access",
          kind: "write",
          fields: ["email", "phone"],
          selector: ["invoiceId"],
        },
      },
    ];
    const { parsed } = firstDocOf([
      provider("InvoiceWorker.handler", queueBinding, [detailed]),
    ]);

    expect(parsed.transitions[0].results).toEqual([
      {
        writes: "aws.dynamodb:Invoices",
        fields: ["email", "phone"],
        by: ["invoiceId"],
      },
    ]);
  });

  it("leaves the columns out when the access asked for every one", () => {
    const wildcard = returnsWriting("t-return");
    wildcard.effects = [
      {
        ...invoicesWrite,
        interaction: {
          class: "storage-access",
          kind: "read",
          fields: ["*"],
        },
      },
    ];
    const { parsed } = firstDocOf([
      provider("InvoiceWorker.handler", queueBinding, [wildcard]),
    ]);

    expect(parsed.transitions[0].results).toEqual([
      { reads: "aws.dynamodb:Invoices" },
    ]);
  });

  it("writes one effect for a boundary a transition reaches twice", () => {
    const twice = returnsWriting("t-return");
    twice.effects = [invoicesWrite, invoicesWrite];
    const { parsed } = firstDocOf([
      provider("InvoiceWorker.handler", queueBinding, [twice]),
    ]);

    expect(parsed.transitions[0].results).toHaveLength(1);
  });

  it("makes the effects the whole outcome when the ending is unreadable", () => {
    const unreadable: Transition = {
      id: "t-unreadable",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "unresolved", sourceText: "status" },
        body: null,
        headers: {},
      },
      effects: [invoicesWrite],
      location: { start: 1, end: 2 },
      isDefault: true,
    };
    const { parsed } = firstDocOf([
      provider("InvoiceWorker.handler", queueBinding, [unreadable]),
    ]);

    expect(parsed.transitions[0].id).toBe("writes-aws-dynamodb-invoices");
    expect(parsed.transitions[0].returns).toBeUndefined();
    expect(parsed.transitions[0].results).toHaveLength(1);
  });

  it("names a boundary whose protocol has no block of its own", () => {
    const metricRead = {
      ...invoicesWrite,
      interaction: { class: "message-send" as const },
      binding: {
        transport: "cloudwatch",
        semantics: {
          name: "metric" as const,
          metricSystem: "cloudwatch",
          metricType: "latency",
        },
        recognition: "test",
      },
    };
    const transition = returnsWriting("t-return");
    transition.effects = [metricRead];
    const { parsed } = firstDocOf([
      provider("InvoiceWorker.handler", queueBinding, [transition]),
    ]);

    expect(parsed.transitions[0].results).toEqual([
      { writes: "metric:cloudwatch latency" },
    ]);
  });

  it("leaves out a boundary with no name of its own to write", () => {
    const unnamed = {
      ...invoicesWrite,
      binding: {
        transport: "http",
        semantics: { name: "rest" as const, method: null, path: null },
        recognition: "test",
      },
    };
    const transition = returnsWriting("t-return");
    transition.effects = [unnamed];
    const { parsed } = firstDocOf([
      provider("InvoiceWorker.handler", queueBinding, [transition]),
    ]);

    expect(parsed.transitions[0].results).toBeUndefined();
  });
});
