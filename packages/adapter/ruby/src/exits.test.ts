import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractRubyProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-exits-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function extract(source: string): Promise<BehavioralSummary[]> {
  const file = path.join(root, "cli.rb");
  fs.writeFileSync(file, source);
  const { summaries } = await extractRubyProject({
    files: [file],
    packs: [],
    workspaceRoot: root,
    cacheDir: null,
  });
  return summaries;
}

function unit(summaries: BehavioralSummary[], name: string): BehavioralSummary {
  const found = summaries.find((one) => one.identity.name === name);
  if (found === undefined) {
    throw new Error(
      `no summary for ${name}: ${summaries.map((one) => one.identity.name).join(", ")}`,
    );
  }
  return found;
}

const CLI = [
  "require 'optparse'",
  "",
  "def check(folder)",
  '  abort "give a folder" if folder.nil?',
  "  exit 2 if folder == '-'",
  "  0",
  "end",
  "",
  "def main(argv)",
  "  options = {}",
  "  OptionParser.new do |opts|",
  '    opts.on("-d", "--dir DIR", "Directory") { |v| options[:dir] = v }',
  '    opts.on("--[no-]json") { |v| options[:json] = v }',
  "  end.parse!(argv)",
  "  check(options[:dir])",
  "end",
  "",
  "exit(main(ARGV))",
  "",
].join("\n");

describe("how a Ruby program exits", () => {
  it("reads each way a reached method ends the process as an exit with its code", async () => {
    const outputs = unit(await extract(CLI), "check").transitions.map(
      (t) => t.output,
    );
    expect(outputs).toEqual(
      expect.arrayContaining([
        { type: "exit", code: { type: "literal", value: 1 } },
        { type: "exit", code: { type: "literal", value: 2 } },
        { type: "return", value: null },
      ]),
    );
  });

  it("records what abort prints to stderr", async () => {
    const check = unit(await extract(CLI), "check");
    const writes = check.transitions.flatMap((t) =>
      t.effects.flatMap((effect) =>
        effect.type === "interaction" &&
        effect.interaction.class === "stream-write"
          ? [effect.callee]
          : [],
      ),
    );
    expect(writes).toContain("abort");
  });

  it("marks the method whose return the process exits with", async () => {
    expect(unit(await extract(CLI), "main").metadata?.process).toEqual({
      exitCodeFrom: "return",
    });
  });

  it("reads the flags OptionParser declares as reads of the argument list it parses", async () => {
    expect(unit(await extract(CLI), "main").inputReads).toEqual(
      expect.arrayContaining([
        { input: "argv", path: ["--dir"] },
        { input: "argv", path: ["--json"] },
      ]),
    );
  });
});
