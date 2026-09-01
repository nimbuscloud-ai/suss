import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { indexContract } from "./__fixtures__/oneThing.js";
import { runCli, USAGE } from "./run.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const pythonFixture = path.join(repoRoot, "fixtures", "python-webapp");
const rubyFixture = path.join(repoRoot, "fixtures", "ruby-graphql");

interface CapturedIO {
  stdout: string;
  stderr: string;
}

async function capture(fn: () => Promise<number>): Promise<{
  exit: number;
  io: CapturedIO;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  let exit: number;
  try {
    exit = await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {
    exit,
    io: { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") },
  };
}

const minimalSummary: BehavioralSummary = {
  kind: "handler",
  location: { file: "x.ts", range: { start: 1, end: 5 }, exportName: "h" },
  identity: {
    name: "h",
    exportPath: ["h"],
    boundaryBinding: {
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/x" },
      recognition: "test",
    },
  },
  inputs: [],
  transitions: [
    {
      id: "h:response:200:t",
      conditions: [],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 1, end: 5 },
      isDefault: true,
    },
  ],
  gaps: [],
  confidence: { source: "inferred_static", level: "high" },
};

const matchingConsumer: BehavioralSummary = {
  ...minimalSummary,
  kind: "client",
  identity: {
    name: "c",
    exportPath: ["c"],
    boundaryBinding: {
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/x" },
      recognition: "test",
    },
  },
  transitions: [
    {
      id: "c:return:none:t",
      conditions: [
        {
          type: "comparison",
          left: {
            type: "derived",
            from: { type: "dependency", name: "fetch", accessChain: [] },
            derivation: { type: "propertyAccess", property: "status" },
          },
          op: "eq",
          right: { type: "literal", value: 200 },
        },
      ],
      output: { type: "return", value: null },
      effects: [],
      location: { start: 1, end: 5 },
      isDefault: false,
    },
  ],
};

// The provider's 200 body has only "code" and the consumer's 200 branch
// reads "message", so the body check reports one error-severity finding.
const mismatchedBodyProvider: BehavioralSummary = {
  ...minimalSummary,
  transitions: [
    {
      ...minimalSummary.transitions[0],
      output: {
        type: "response",
        statusCode: { type: "literal", value: 200 },
        body: { type: "record", properties: { code: { type: "text" } } },
        headers: {},
      },
    },
  ],
};

const mismatchedBodyConsumer: BehavioralSummary = {
  ...matchingConsumer,
  transitions: [
    {
      ...matchingConsumer.transitions[0],
      expectedInput: {
        type: "record",
        properties: {
          body: {
            type: "record",
            properties: { message: { type: "unknown" } },
          },
        },
      },
    },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-runcli-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

function writeJson(name: string, data: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

describe("runCli top-level dispatch", () => {
  it("prints USAGE and exits 0 when no args are given", async () => {
    const { exit, io } = await capture(() => runCli([]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain(USAGE);
  });

  it("prints USAGE and exits 0 for --help", async () => {
    const { exit, io } = await capture(() => runCli(["--help"]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain("Commands:");
  });

  it("prints USAGE and exits 0 for -h", async () => {
    const { exit, io } = await capture(() => runCli(["-h"]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain("extract");
  });

  it("prints USAGE when any command is asked for help", async () => {
    // `check --help` used to come back as an unknown option, and
    // `init --help` ignored the flag and started scanning the repo.
    for (const command of ["check", "extract", "inspect", "init"]) {
      const { exit, io } = await capture(() => runCli([command, "--help"]));
      expect(exit).toBe(0);
      expect(io.stdout).toContain("Commands:");
    }
  });

  it("leaves a help flag after the separator to the command", async () => {
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--", "--help"]),
    );
    expect(exit).not.toBe(0);
    expect(io.stdout).not.toContain("Commands:");
  });

  it("rejects unknown commands with a non-zero exit", async () => {
    const { exit, io } = await capture(() => runCli(["nope"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("nope");
  });

  it("turns a flag typed without its value into a sentence", async () => {
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--flow", "--dir", tmpDir]),
    );

    expect(exit).toBe(1);
    expect(io.stderr).toContain("--flow");
    expect(io.stderr).toContain("Run `suss --help` for the flags.");
    expect(io.stderr).not.toContain("    at ");
  });

  it("lets a throw that is not the person's mistake keep its stack", async () => {
    // Reading a directory in place of a file throws EISDIR.
    await expect(runCli(["inspect", tmpDir])).rejects.toThrow();
  });
});

/** Only the first column counts, so a flag named in a description is skipped. */
function documentedFlags(section: string): string[] {
  const lines = USAGE.split("\n");
  const start = lines.indexOf(`Options (${section}):`);
  expect(start).toBeGreaterThan(-1);
  const flags: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      break;
    }

    const match = /^ {2}(?:-\w, )?(--[a-z0-9-]+)/.exec(line);
    if (match?.[1] !== undefined) {
      flags.push(match[1]);
    }
  }
  return flags;
}

/** Whether the command got past argument parsing with this flag. */
async function parserAccepts(argv: string[]): Promise<boolean> {
  try {
    await capture(() => runCli(argv));
    return true;
  } catch (err) {
    return !/Unknown option/.test(String(err));
  }
}

describe("runCli help text", () => {
  it("lists only extract flags the extract parser takes", async () => {
    for (const flag of documentedFlags("extract")) {
      const accepted = await parserAccepts([
        "extract",
        flag,
        "-f",
        "axios",
        "-p",
        "/nope/tsconfig.json",
      ]);
      expect(accepted, `extract ${flag}`).toBe(true);
    }
  });

  it("lists only corroborate flags the corroborate parser takes", async () => {
    for (const flag of documentedFlags("corroborate")) {
      const accepted = await parserAccepts([
        "corroborate",
        "--experimental",
        flag,
        "-f",
        "express",
        "-p",
        "/nope/tsconfig.json",
      ]);
      expect(accepted, `corroborate ${flag}`).toBe(true);
    }
  });

  it("tells people about --timing and --attempts", () => {
    expect(documentedFlags("extract")).toContain("--timing");
    expect(documentedFlags("corroborate")).toContain("--attempts");
  });
});

describe("runCli extract", () => {
  it("rejects a --project path that does not exist", async () => {
    const { exit, io } = await capture(() =>
      runCli(["extract", "-p", "/nope/tsconfig.json", "-f", "axios"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("tsconfig");
  });

  it("rejects when no --framework (-f) is given", async () => {
    const { exit, io } = await capture(() =>
      runCli(["extract", "-p", "tsconfig.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("-f");
  });

  it("rejects an invalid --gaps value", async () => {
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "-p",
        "tsconfig.json",
        "-f",
        "axios",
        "--gaps",
        "bogus",
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--gaps");
  });

  it("extracts a project to a file and reports timing under --timing", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "consumer.ts"),
      [
        `import axios from "axios";`,
        "export async function loadPet(id: string) {",
        "  const res = await axios.get(\`/pets/\${id}\`);",
        "  return res.data;",
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, module: "esnext" },
        include: ["src"],
      }),
    );
    const outFile = path.join(tmpDir, "out", "summaries.json");
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "-p",
        path.join(tmpDir, "tsconfig.json"),
        "-f",
        "axios",
        "-o",
        outFile,
        "--timing",
        "--no-cache",
      ]),
    );
    expect(exit).toBe(0);
    expect(io.stderr).toContain("Wrote");
    expect(io.stderr).toContain("Timing:");
    const written = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(Array.isArray(written)).toBe(true);
  });

  it("gives a summary an id when the files are named one by one", async () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const source = path.join(srcDir, "consumer.ts");
    fs.writeFileSync(
      source,
      [
        `import axios from "axios";`,
        "export async function loadPet(id: string) {",
        "  const res = await axios.get(`/pets/${id}`);",
        "  return res.data;",
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, module: "esnext" },
        include: ["src"],
      }),
    );

    const outFile = path.join(tmpDir, "byFiles.json");
    const { exit } = await capture(() =>
      runCli([
        "extract",
        "-p",
        path.join(tmpDir, "tsconfig.json"),
        "-f",
        "axios",
        "--files",
        source,
        "-o",
        outFile,
        "--no-cache",
      ]),
    );
    expect(exit).toBe(0);

    const written = JSON.parse(fs.readFileSync(outFile, "utf8")) as Array<{
      identity: { id?: string };
    }>;
    expect(written.length).toBeGreaterThan(0);
    for (const summary of written) {
      expect(summary.identity.id).toBeTypeOf("string");
    }
  });

  it("stops on a misspelled pack option instead of extracting nothing", async () => {
    const config = path.join(tmpDir, "suss.aws-dynamodb.json");
    fs.writeFileSync(
      config,
      JSON.stringify({ requiresImports: ["aws4fetch"] }),
    );
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "--lang",
        "typescript",
        "--dir",
        tmpDir,
        "-f",
        `aws-dynamodb=${config}`,
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("requiresImports");
    expect(io.stderr).toContain(config);
    expect(io.stderr).toContain("The aws-dynamodb pack takes: requiresImport.");
  });

  it("stops on a pack option that is gone, and says what happens now", async () => {
    const config = path.join(tmpDir, "suss.hono.json");
    fs.writeFileSync(
      config,
      JSON.stringify({ registrationHelpers: [{ helperName: "mountHealth" }] }),
    );
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "--lang",
        "typescript",
        "--dir",
        tmpDir,
        "-f",
        `hono=${config}`,
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("registrationHelpers is gone");
    expect(io.stderr).toContain(
      "The hono pack does not take any option from a config file.",
    );
  });

  it("stops on an option a dependency stub states, and says where it goes", async () => {
    const config = path.join(tmpDir, "suss.nestjs-rest.json");
    fs.writeFileSync(
      config,
      JSON.stringify({ classDecorators: ["ApiController"] }),
    );
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "--lang",
        "typescript",
        "--dir",
        tmpDir,
        "-f",
        `nestjs-rest=${config}`,
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain(
      "The classDecorators option describes a dependency",
    );
    expect(io.stderr).toContain("suss infer stub <package>");
    expect(io.stderr).toContain(
      "The nestjs-rest pack does not take any option from a config file.",
    );
  });

  it("rejects a --lang nobody has an adapter for, and says which it takes", async () => {
    const { exit, io } = await capture(() =>
      runCli(["extract", "--lang", "perl", "-f", "express"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("python");
  });

  it("reads a Python project through --lang, and writes the summaries", async () => {
    const outFile = path.join(tmpDir, "python.json");
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "--lang",
        "python",
        "--dir",
        pythonFixture,
        "-f",
        "fastapi",
        "-o",
        outFile,
      ]),
    );
    expect(exit).toBe(0);
    expect(io.stderr).toContain("Wrote");
    const written = JSON.parse(fs.readFileSync(outFile, "utf8")) as Array<{
      identity: { name: string };
    }>;
    expect(written.map((s) => s.identity.name)).toContain("read_item");
  });

  it("keeps reading a subdirectory of a TypeScript monorepo as TypeScript", async () => {
    // Source resolution walks up to the root tsconfig, so language
    // resolution has to agree with it.
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const service = path.join(tmpDir, "scripts");
    fs.mkdirSync(service, { recursive: true });
    fs.writeFileSync(path.join(service, "backfill.py"), "x = 1\n");

    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "--dir",
        service,
        "-f",
        "express",
        "-o",
        path.join(tmpDir, "web.json"),
        "--no-cache",
      ]),
    );
    expect(exit).toBe(0);
    expect(io.stderr).not.toContain("reads TypeScript");
    expect(io.stderr).not.toContain("could not tell what language");
  });

  it("reads a directory with its own pyproject as Python, whatever tsconfig sits above it", async () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const service = path.join(tmpDir, "services", "orders");
    fs.mkdirSync(service, { recursive: true });
    fs.writeFileSync(path.join(service, "pyproject.toml"), "[project]\n");
    fs.cpSync(path.join(pythonFixture, "myapp"), path.join(service, "myapp"), {
      recursive: true,
    });

    const outFile = path.join(tmpDir, "orders.json");
    const { exit } = await capture(() =>
      runCli(["extract", "--dir", service, "-f", "fastapi", "-o", outFile]),
    );
    expect(exit).toBe(0);
    const written = JSON.parse(fs.readFileSync(outFile, "utf8")) as Array<{
      identity: { name: string };
    }>;
    expect(written.map((s) => s.identity.name)).toContain("read_item");
  });

  it("says what a pack needs rather than throwing a stack at somebody", async () => {
    const { exit, io } = await capture(() =>
      runCli([
        "extract",
        "--dir",
        rubyFixture,
        "-f",
        "graphql-ruby",
        "-o",
        path.join(tmpDir, "ruby.json"),
      ]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("needs `root`");
    expect(io.stderr).not.toContain("    at ");
  });
});

describe("runCli inspect", () => {
  it("inspects a summaries file via positional path", async () => {
    const file = writeJson("summaries.json", [minimalSummary]);
    const { exit, io } = await capture(() => runCli(["inspect", file]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain("/x");
  });

  it("rejects inspect with no path", async () => {
    const { exit, io } = await capture(() => runCli(["inspect"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("summaries file");
  });

  it("prints what a store is called and what it serves", async () => {
    const file = writeJson("infra.json", [indexContract]);
    const { exit, io } = await capture(() => runCli(["inspect", file]));
    expect(exit).toBe(0);
    expect(io.stdout).toContain("keyed by publicationId");
    expect(io.stdout).toContain("Serves: publicationId (S), editionId (S)");
  });

  it("says a returned object spreads a value it never read", async () => {
    const spreading: BehavioralSummary = {
      ...minimalSummary,
      transitions: [
        {
          ...(minimalSummary
            .transitions[0] as (typeof minimalSummary.transitions)[number]),
          output: {
            type: "response",
            statusCode: { type: "literal", value: 200 },
            body: {
              type: "record",
              properties: { favorited: { type: "boolean" } },
              spreads: [{ sourceText: "article" }],
            },
            headers: {},
          },
        },
      ],
    };
    const file = writeJson("spread.json", [spreading]);

    const { exit, io } = await capture(() => runCli(["inspect", file]));

    expect(exit).toBe(0);
    // Without this a reader takes "favorited" for the whole response,
    // and everything the spread brings along goes unmentioned.
    expect(io.stdout).toContain("...article");
    expect(io.stdout).toContain("favorited");
  });

  it("turns down a flag inspect does not take, and says where to go", async () => {
    const file = writeJson("summaries.json", [minimalSummary]);
    const { exit, io } = await capture(() =>
      runCli(["inspect", file, "--json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("does not take --json");
    expect(io.stderr).toContain("suss ask --json");
    expect(io.stdout).toBe("");
  });

  it("inspect --diff requires before AND after paths", async () => {
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--diff", "only-one.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--diff");
  });

  it("inspect --diff renders two identical files without failing", async () => {
    const a = writeJson("a.json", [minimalSummary]);
    const b = writeJson("b.json", [minimalSummary]);
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--diff", a, b]),
    );
    expect(exit).toBe(0);
    expect(io.stdout.length).toBeGreaterThan(0);
  });

  it("inspect --dir requires a directory path", async () => {
    const { exit, io } = await capture(() => runCli(["inspect", "--dir"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--dir");
  });

  it("inspect --dir renders the pairings overview", async () => {
    writeJson("a.json", [minimalSummary]);
    writeJson("b.json", [matchingConsumer]);
    const { exit, io } = await capture(() =>
      runCli(["inspect", "--dir", tmpDir]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("1 paired boundary");
    expect(io.stdout).toContain("/x");
  });
});

describe("runCli check", () => {
  it("requires two positional files (or --dir)", async () => {
    const { exit, io } = await capture(() => runCli(["check"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--dir");
  });

  it("rejects an invalid --fail-on value", async () => {
    const { exit, io } = await capture(() =>
      runCli(["check", "--fail-on", "bogus", "p.json", "c.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--fail-on must be");
  });

  it("returns 0 when consumer covers every provider status", async () => {
    const provider = writeJson("provider.json", [minimalSummary]);
    const consumer = writeJson("consumer.json", [matchingConsumer]);
    const { exit } = await capture(() => runCli(["check", provider, consumer]));
    expect(exit).toBe(0);
  });

  it("returns 1 when the checker reports any error finding", async () => {
    const provider = writeJson("provider.json", [mismatchedBodyProvider]);
    const consumer = writeJson("consumer.json", [mismatchedBodyConsumer]);
    const { exit } = await capture(() => runCli(["check", provider, consumer]));
    expect(exit).toBe(1);
  });

  it("--dir reads every JSON file in the directory and pairs them", async () => {
    writeJson("provider.json", [minimalSummary]);
    writeJson("consumer.json", [matchingConsumer]);
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("Compared");
  });

  it("--all names the compared boundaries the default run only counts", async () => {
    writeJson("provider.json", [minimalSummary]);
    writeJson("consumer.json", [matchingConsumer]);

    const plain = await capture(() => runCli(["check", "--dir", tmpDir]));
    const all = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--all"]),
    );

    expect(plain.io.stdout).toContain("Compared 1 boundary.");
    expect(all.io.stdout).toContain("Compared 1 boundary:");
    expect(all.io.stdout.length).toBeGreaterThan(plain.io.stdout.length);
  });

  it("--sussignore applies the named rule file to two-file checks", async () => {
    const provider = writeJson("provider.json", [mismatchedBodyProvider]);
    const consumer = writeJson("consumer.json", [mismatchedBodyConsumer]);
    const ignore = writeJson("rules.yml", null);
    fs.writeFileSync(
      ignore,
      [
        "version: 1",
        "rules:",
        "  - kind: misreadProviderResponse",
        '    boundary: "GET /x"',
        "    reason: the field is optional in the UI, absent means blank",
        "    effect: hide",
      ].join("\n"),
    );
    const { exit } = await capture(() =>
      runCli(["check", provider, consumer, "--sussignore", ignore]),
    );
    // The one error finding is hidden, so the run passes.
    expect(exit).toBe(0);
  });

  it("--no-suppressions ignores an auto-discovered .sussignore", async () => {
    // The working directory has a rule in it that would hide the finding.
    writeJson("provider.json", [mismatchedBodyProvider]);
    writeJson("consumer.json", [mismatchedBodyConsumer]);
    const { exit } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--no-suppressions"]),
    );
    expect(exit).toBe(1);
  });
});

describe("runCli check --at", () => {
  it("needs --dir, and says so", async () => {
    const { exit, io } = await capture(() =>
      runCli(["check", "--at", "src/x.ts"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("needs --dir");
  });

  it("refuses to run alongside --intent", async () => {
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--at", "x.ts", "--intent", "intent/"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("cannot run together");
  });

  it("reports on one file out of the folder", async () => {
    writeJson("provider.json", [minimalSummary]);
    writeJson("consumer.json", [matchingConsumer]);
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--at", "x.ts"]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("x.ts");
    expect(io.stdout).toContain("No findings here.");
  });

  it("exits non-zero when the target matches nothing", async () => {
    writeJson("provider.json", [minimalSummary]);
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--at", "src/nowhere.ts"]),
    );
    expect(exit).toBe(1);
    expect(io.stdout).toContain("Nothing here is at src/nowhere.ts");
  });
});

describe("runCli ask", () => {
  it("needs a question", async () => {
    const { exit, io } = await capture(() => runCli(["ask"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("ask needs a question");
  });

  it("says which boundaries a file reaches", async () => {
    writeJson("provider.json", [minimalSummary]);
    const { exit, io } = await capture(() =>
      runCli(["ask", "what does x.ts reach", "--dir", tmpDir]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain("x.ts");
  });

  it("prints the shapes it takes when the question is not one of them", async () => {
    const { exit, io } = await capture(() =>
      runCli(["ask", "why is x.ts slow", "--dir", tmpDir]),
    );
    expect(exit).toBe(1);
    expect(io.stdout).toContain("one of eight questions");
  });
});

describe("runCli contract", () => {
  const inlineSpec = {
    openapi: "3.0.3",
    info: { title: "users-api", version: "1.0" },
    paths: {
      "/users": {
        get: {
          operationId: "list",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  it("rejects missing --from", async () => {
    const { exit, io } = await capture(() => runCli(["contract", "spec.json"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--from");
  });

  it("rejects an unknown --from value", async () => {
    const { exit, io } = await capture(() =>
      runCli(["contract", "--from", "no-such-source", "spec.json"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("no-such-source");
  });

  it("requires a positional spec path", async () => {
    const { exit, io } = await capture(() =>
      runCli(["contract", "--from", "openapi"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("--from");
  });

  it("loads an OpenAPI spec and writes summaries to -o", async () => {
    const spec = writeJson("spec.json", inlineSpec);
    const out = path.join(tmpDir, "out.json");
    const { exit } = await capture(() =>
      runCli(["contract", "--from", "openapi", spec, "-o", out]),
    );
    expect(exit).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const written = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(Array.isArray(written)).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("loads a CloudFormation template and writes summaries to -o", async () => {
    const tpl = writeJson("template.json", {
      Resources: {
        UsersApi: {
          Type: "AWS::ApiGateway::RestApi",
          Properties: { Body: inlineSpec },
        },
      },
    });
    const out = path.join(tmpDir, "out.json");
    const { exit } = await capture(() =>
      runCli(["contract", "--from", "cloudformation", tpl, "-o", out]),
    );
    expect(exit).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
  });
});

describe("runCli infer", () => {
  it("asks for an artifact kind and rejects unknown ones", async () => {
    const bare = await capture(() => runCli(["infer"]));
    expect(bare.exit).toBe(1);
    expect(bare.io.stderr).toContain("infer stub <package>");

    const unknown = await capture(() => runCli(["infer", "publish"]));
    expect(unknown.exit).toBe(1);
    expect(unknown.io.stderr).toContain('no "infer publish"');
  });

  it("asks for the package when none is given", async () => {
    const { exit, io } = await capture(() => runCli(["infer", "stub"]));
    expect(exit).toBe(1);
    expect(io.stderr).toContain("needs the package");
  });

  it("prints a draft to stdout with -o -", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-stubcli-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(
      path.join(dir, "src", "go.ts"),
      'import { send } from "@acme/wire";\nexport const go = () => send("q");\n',
    );

    const { exit, io } = await capture(() =>
      runCli(["infer", "stub", "@acme/wire", "--dir", dir, "-o", "-"]),
    );
    expect(exit).toBe(0);
    expect(io.stdout).toContain('package: "@acme/wire"');
    expect(io.stdout).toContain('export: "send"');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says stub is not a command, and lists the ones that are", async () => {
    const { exit, io } = await capture(() =>
      runCli(["stub", "draft", "@acme/wire"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain('There is no "stub" command');
    expect(io.stderr).toContain("infer");
  });
});

describe("runCli field-report fixes", () => {
  it("prints the installed version for --version", async () => {
    const { exit, io } = await capture(() => runCli(["--version"]));
    expect(exit).toBe(0);
    expect(io.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("answers ask --dir on a missing directory with a sentence", async () => {
    const missing = path.join(tmpDir, "nowhere");
    const { exit, io } = await capture(() =>
      runCli(["ask", "what reads x", "--dir", missing]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain("No directory at");
    expect(io.stderr).not.toContain("at readSummariesFromDir");
  });

  it("answers an unparseable ask --json question as JSON", async () => {
    writeJson("provider.json", [minimalSummary]);
    const { exit, io } = await capture(() =>
      runCli(["ask", "flurble the wombat", "--dir", tmpDir, "--json"]),
    );
    expect(exit).toBe(1);
    const parsed = JSON.parse(io.stdout) as { answer: null; message: string };
    expect(parsed.answer).toBeNull();
    expect(parsed.message).toContain("questions suss answers");
  });

  it("answers a check --json usage error as JSON on stdout", async () => {
    const missing = path.join(tmpDir, "nowhere");
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", missing, "--json"]),
    );
    expect(exit).toBe(1);
    const parsed = JSON.parse(io.stdout) as { error: string };
    expect(parsed.error).toContain("No directory at");
  });

  it("names the incompleteness note instead of skipping it as unreadable", async () => {
    writeJson("provider.json", [minimalSummary]);
    writeJson("consumer.json", [matchingConsumer]);
    fs.writeFileSync(
      path.join(tmpDir, "provider.incomplete.json"),
      JSON.stringify({ filesWithUnreadableExports: ["src/a.ts"] }),
    );
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir]),
    );
    expect(exit).toBe(0);
    expect(io.stderr).toContain("incomplete");
    expect(io.stderr).not.toContain("could not read as summaries");
  });
});

describe("runCli check floors", () => {
  it("fails on an unreadable file only when asked", async () => {
    writeJson("provider.json", [minimalSummary]);
    writeJson("consumer.json", [matchingConsumer]);
    fs.writeFileSync(path.join(tmpDir, "broken.json"), "{ not json");

    const lax = await capture(() => runCli(["check", "--dir", tmpDir]));
    expect(lax.exit).toBe(0);

    const strict = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--fail-on-unreadable"]),
    );
    expect(strict.exit).toBe(1);
    expect(strict.io.stdout).toContain("could not be read as summaries");
  });

  it("fails when unpaired boundaries pass the floor", async () => {
    writeJson("provider.json", [minimalSummary]);

    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--fail-on-unpaired", "0"]),
    );
    expect(exit).toBe(1);
    expect(io.stdout).toContain("--fail-on-unpaired floor of 0");
  });

  it("passes a floor the run stays under", async () => {
    writeJson("provider.json", [minimalSummary]);
    writeJson("consumer.json", [matchingConsumer]);

    const { exit } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--fail-on-unpaired", "50%"]),
    );
    expect(exit).toBe(0);
  });

  it("rejects a floor it cannot parse", async () => {
    writeJson("provider.json", [minimalSummary]);
    const { exit, io } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--fail-on-unpaired", "lots"]),
    );
    expect(exit).toBe(1);
    expect(io.stderr).toContain('not "lots"');
  });

  it("lists skipped files in the JSON body", async () => {
    writeJson("provider.json", [minimalSummary]);
    fs.writeFileSync(path.join(tmpDir, "broken.json"), "{ not json");

    const { io } = await capture(() =>
      runCli(["check", "--dir", tmpDir, "--json"]),
    );
    const body = JSON.parse(io.stdout) as { skipped: string[] };
    expect(body.skipped.some((one) => one.startsWith("broken.json"))).toBe(
      true,
    );
  });
});
