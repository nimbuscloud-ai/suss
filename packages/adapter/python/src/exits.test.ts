import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-exits-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function extract(source: string): Promise<BehavioralSummary[]> {
  const file = path.join(root, "cli.py");
  fs.writeFileSync(file, source);
  const { summaries } = await extractPythonProject({
    files: [file],
    packs: [],
    roots: [root],
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
  "import sys",
  "",
  "def check(folder):",
  "    if not folder:",
  '        sys.exit("give a folder")',
  "    if folder == '-':",
  "        raise SystemExit(2)",
  "    return 0",
  "",
  "def main():",
  "    return check(sys.argv[1])",
  "",
  "if __name__ == '__main__':",
  "    sys.exit(main())",
  "",
].join("\n");

describe("how a Python program exits", () => {
  it("reads each way a reached function ends the process as an exit with its code", async () => {
    const outputs = unit(await extract(CLI), "check").transitions.map(
      (t) => t.output,
    );
    expect(outputs).toEqual([
      { type: "exit", code: { type: "literal", value: 1 } },
      { type: "exit", code: { type: "literal", value: 2 } },
      { type: "return", value: { type: "literal", value: 0 } },
    ]);
  });

  it("marks the function whose return the process exits with", async () => {
    const summaries = await extract(CLI);
    expect(unit(summaries, "main").metadata?.process).toEqual({
      exitCodeFrom: "return",
    });
    expect(unit(summaries, "check").metadata?.process).toEqual({
      exitCodeFrom: "return",
    });
  });

  it("reads the flags argparse declares as reads of the argument list it parses", async () => {
    const summaries = await extract(
      [
        "import argparse",
        "import sys",
        "",
        "def main(argv):",
        "    parser = argparse.ArgumentParser()",
        '    parser.add_argument("--dir")',
        '    parser.add_argument("-j", "--json", action="store_true")',
        '    parser.add_argument("target")',
        "    args = parser.parse_args(argv)",
        "    return 0",
        "",
        "sys.exit(main(sys.argv[1:]))",
        "",
      ].join("\n"),
    );
    expect(unit(summaries, "main").inputReads).toEqual(
      expect.arrayContaining([
        { input: "argv", path: ["--dir"] },
        { input: "argv", path: ["--json"] },
        { input: "argv", path: ["0"] },
      ]),
    );
  });

  it("reads a bare exit as 0, the builtins as exits, and a computed code as its text", async () => {
    const summaries = await extract(
      [
        "import sys",
        "",
        "def run(mode, code):",
        "    if mode == 'none':",
        "        sys.exit()",
        "    if mode == 'nothing':",
        "        sys.exit(None)",
        "    if mode == 'builtin':",
        "        exit(3)",
        "    if mode == 'quit':",
        "        quit()",
        "    if mode == 'computed':",
        "        sys.exit(code)",
        "    return 0",
        "",
        "sys.exit(run(sys.argv[1], int(sys.argv[2])))",
        "",
      ].join("\n"),
    );
    const outputs = unit(summaries, "run").transitions.map((t) => t.output);
    expect(outputs.slice(0, 5)).toEqual([
      { type: "exit", code: { type: "literal", value: 0 } },
      { type: "exit", code: { type: "literal", value: 0 } },
      { type: "exit", code: { type: "literal", value: 3 } },
      { type: "exit", code: { type: "literal", value: 0 } },
      { type: "exit", code: { type: "unresolved", sourceText: "code" } },
    ]);
  });

  it("reads no flags from a parser the function does not hand its parameter to", async () => {
    const summaries = await extract(
      [
        "import argparse",
        "import sys",
        "",
        "def main(argv):",
        "    parser = argparse.ArgumentParser()",
        '    parser.add_argument("--dir")',
        "    parsers = {}",
        '    parsers["x"] = argparse.ArgumentParser()',
        "    def later(rest):",
        "        return parser.parse_args(rest)",
        "    get_parser().parse_args(argv)",
        "    parser.parse_args(sys.argv)",
        "    return 0",
        "",
        "sys.exit(main(sys.argv[1:]))",
        "",
      ].join("\n"),
    );
    expect(unit(summaries, "main").inputReads ?? []).not.toContainEqual({
      input: "argv",
      path: ["--dir"],
    });
  });

  it("keeps one transition, and no mark, for a reached function that never exits", async () => {
    const summaries = await extract(
      [
        "import sys",
        "",
        "def helper(flag):",
        "    if flag:",
        "        return 1",
        "    return 2",
        "",
        "def main():",
        "    helper(True)",
        "    return 0",
        "",
        "sys.exit(main())",
        "",
      ].join("\n"),
    );
    expect(unit(summaries, "helper").transitions).toHaveLength(1);
    expect(unit(summaries, "helper").metadata?.process).toBeUndefined();
    expect(unit(summaries, "main").metadata?.process).toEqual({
      exitCodeFrom: "return",
    });
  });
});
