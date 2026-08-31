import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadIntentDoc } from "@suss/contract-intent";

import { prdDraft, prdDraftResult } from "./prdDraftCommand.js";

import type { IntentSummary } from "@suss/intent-ir";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-infer-prd-"));
  created.push(dir);
  return dir;
}

async function capture(fn: () => Promise<number>): Promise<{
  exit: number;
  io: { stdout: string; stderr: string };
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
  try {
    const exit = await fn();
    return { exit, io: { stdout: out.join(""), stderr: err.join("") } };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** Fill in the words a drafted PRD leaves, the way a person would. */
function curatePrd(file: string): void {
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf-8")
      .replace(/^title: "".*$/m, "title: One thing")
      .replace(/^purpose: "".*$/m, "purpose: It matters.")
      .replace(/^audience: "".*$/m, "audience: the team")
      .replaceAll(/^(\s*)- when: "".*$/gm, "$1- when: a caller asks")
      .replaceAll(/^(\s*)expect: "".*$/gm, "$1expect: they are told")
      .replace(/^source: inferred$/m, 'source: "inferred, curated"'),
  );
}

/** A boundary document a person has already curated. */
function curatedIntent(name: string): string {
  return [
    "kind: boundary",
    `name: ${name}`,
    "purpose: Look one up.",
    "audience: the team",
    "source: author",
    "boundary:",
    "  semantics: rest",
    "  method: GET",
    `  path: /${name}`,
    "transitions:",
    "  - id: found",
    "    when: always",
    "    response:",
    "      status: 200",
    "",
  ].join("\n");
}

function boundaryIntent(name: string, outcomeIds: string[]): IntentSummary {
  return {
    kind: "boundary",
    name,
    purpose: "Look one invoice up.",
    audience: "the billing team",
    source: "inferred, curated",
    boundary: {
      transport: "http",
      semantics: { name: "rest", method: "GET", path: "/invoices/{id}" },
      recognition: "intent",
    },
    outcomes: outcomeIds.map((id) => ({
      id,
      when: "",
      conditions: [],
      kind: "response",
      status: 200,
      body: null,
      errorType: null,
      effects: [],
    })),
  };
}

function prd(links: string[]): IntentSummary {
  return {
    kind: "prd",
    title: "Invoice lookup",
    purpose: "Callers can see one invoice.",
    audience: "the billing team",
    source: "author",
    scenarios: links.map((link) => ({
      title: null,
      when: "a caller asks",
      expect: "they are told",
      link: [link],
    })),
  };
}

const firstOf = (intents: IntentSummary[]) =>
  prdDraftResult(intents, "intent/").drafted[0];

describe("prdDraftResult", () => {
  it("writes one scenario per outcome, linked by name and id", () => {
    const doc = firstOf([
      boundaryIntent("invoice-lookup", ["no-such-invoice", "invoice-returned"]),
    ]);

    expect(doc.file).toBe("invoice-lookup.prd.yaml");
    expect(doc.scenarios).toBe(2);
    const parsed = YAML.parse(doc.yaml) as {
      kind: string;
      scenarios: Array<{ link: string }>;
    };
    expect(parsed.kind).toBe("prd");
    expect(parsed.scenarios.map((one) => one.link)).toEqual([
      "invoice-lookup.no-such-invoice",
      "invoice-lookup.invoice-returned",
    ]);
  });

  it("leaves the words blank, with a hint beside each", () => {
    const doc = firstOf([boundaryIntent("invoice-lookup", ["returned"])]);

    expect(doc.yaml).toContain(
      'title: "" # what this document covers, in your words',
    );
    expect(doc.yaml).toContain('purpose: "" # why it matters');
    expect(doc.yaml).toContain('audience: "" # who cares about it');
    expect(doc.yaml).toContain('- when: "" # the situation, in your words');
    expect(doc.yaml).toContain(
      'expect: "" # what should happen, in your words',
    );
  });

  it("says which boundary intent it covers and where that was read", () => {
    const doc = firstOf([boundaryIntent("invoice-lookup", ["returned"])]);

    expect(doc.yaml).toContain(
      "# Why invoice-lookup behaves the way it does, for somebody to write.",
    );
    expect(doc.yaml).toContain("read from intent/");
  });

  it("writes a draft the reader rejects until the blanks are filled", () => {
    const doc = firstOf([boundaryIntent("invoice-lookup", ["returned"])]);

    expect(() => loadIntentDoc(YAML.parse(doc.yaml))).toThrow(
      /title, purpose, audience, when and expect are still blank/,
    );
  });

  it("leaves a boundary intent a scenario already points at alone", () => {
    const result = prdDraftResult(
      [
        boundaryIntent("invoice-lookup", ["returned"]),
        boundaryIntent("invoice-intake", ["recorded"]),
        prd(["invoice-lookup.returned"]),
      ],
      "intent/",
    );

    expect(result.drafted.map((one) => one.intent)).toEqual(["invoice-intake"]);
    expect(result.covered).toEqual(["invoice-lookup"]);
  });
});

describe("the infer prd command", () => {
  it("refuses a folder of uncurated drafts and says to curate first", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "one.intent.yaml"),
      [
        "kind: boundary",
        "name: one",
        'purpose: ""',
        'audience: ""',
        "source: inferred",
        "boundary:",
        "  semantics: rest",
        "  method: GET",
        "  path: /one",
        "transitions:",
        "  - id: 200-ok",
        "    when: always",
        "    response:",
        "      status: 200",
        "",
      ].join("\n"),
    );

    expect(() => prdDraft({ from: dir })).toThrow(
      /has to load before this can write one/,
    );
  });

  it("writes beside the intent it read, when nowhere else is given", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "one.intent.yaml"),
      [
        "kind: boundary",
        "name: one",
        "purpose: Look one up.",
        "audience: the team",
        "source: author",
        "boundary:",
        "  semantics: rest",
        "  method: GET",
        "  path: /one",
        "transitions:",
        "  - id: found",
        "    when: always",
        "    response:",
        "      status: 200",
        "",
      ].join("\n"),
    );

    expect(prdDraft({ from: dir })).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "one.intent.yaml",
      "one.prd.yaml",
    ]);
    expect(fs.readFileSync(path.join(dir, "one.prd.yaml"), "utf-8")).toContain(
      "link: one.found",
    );
  });
  it("says there is no folder there", () => {
    expect(() => prdDraft({ from: path.join(tempDir(), "nowhere") })).toThrow(
      /No folder at/,
    );
  });

  it("says nothing needs one when every intent already has a scenario", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "one.intent.yaml"), curatedIntent("one"));
    expect(prdDraft({ from: dir })).toBe(0);
    curatePrd(path.join(dir, "one.prd.yaml"));

    const { exit, io } = await capture(async () => prdDraft({ from: dir }));

    expect(exit).toBe(1);
    expect(io.stderr).toContain("needs a PRD");
    expect(io.stderr).toContain("already have a scenario pointing at them");
    expect(io.stderr).toContain("  - one");
  });

  it("refuses --into where PRDs already are", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "one.intent.yaml"), curatedIntent("one"));
    fs.writeFileSync(path.join(dir, "two.intent.yaml"), curatedIntent("two"));
    expect(prdDraft({ from: dir, out: dir })).toBe(0);
    curatePrd(path.join(dir, "one.prd.yaml"));
    fs.rmSync(path.join(dir, "two.prd.yaml"));

    expect(() => prdDraft({ from: dir, into: dir })).toThrow(
      /already holds 1 PRD/,
    );
  });
});
