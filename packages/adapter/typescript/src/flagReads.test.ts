import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

/** A runtime that declares its flag parser, the way the Node pack does. */
const runtimePack: PatternPack = {
  name: "runtime",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
  argumentParsers: [
    {
      module: "node:util",
      name: "parseArgs",
      argument: 0,
      argsKey: "args",
      optionsKey: "options",
    },
  ],
  invocationRecognizers: [() => null],
};

async function readsOf(source: string, name: string) {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/@types/node/util.d.ts",
    `declare module "node:util" {
      export function parseArgs(config: unknown): { values: Record<string, unknown>; positionals: string[] };
    }`,
  );
  project.createSourceFile("/cli.ts", source);
  const summaries: BehavioralSummary[] = await createTypeScriptAdapter({
    project,
    frameworks: [runtimePack],
    cacheDir: null,
  }).extractAll();
  return summaries.find((one) => one.identity.name === name)?.inputReads;
}

describe("the flags a command takes", () => {
  it("reads each option its parser declares as a flag of the argument list", async () => {
    const reads = await readsOf(
      `
      import { parseArgs } from "node:util";
      const failOn = { type: "string" } as const;
      export function runCheck(args: string[]): number {
        const { values } = parseArgs({
          args,
          options: { dir: { type: "string" }, json: { type: "boolean" }, "fail-on": failOn },
        });
        return values.json === true ? 1 : 0;
      }
      `,
      "runCheck",
    );
    expect(reads).toEqual(
      expect.arrayContaining([
        { input: "args", path: ["--dir"] },
        { input: "args", path: ["--json"] },
        { input: "args", path: ["--fail-on"] },
      ]),
    );
  });

  it("reads an aliased import of the parser", async () => {
    const reads = await readsOf(
      `
      import { parseArgs as parse } from "node:util";
      export function run(argv: string[]): void {
        parse({ args: argv, options: { quiet: { type: "boolean" } } });
      }
      `,
      "run",
    );
    expect(reads).toContainEqual({ input: "argv", path: ["--quiet"] });
  });

  it("reads nothing when the arguments come from somewhere other than a parameter", async () => {
    const reads = await readsOf(
      `
      import { parseArgs } from "node:util";
      export function run(): void {
        parseArgs({ args: process.argv.slice(2), options: { quiet: { type: "boolean" } } });
      }
      `,
      "run",
    );
    expect(reads ?? []).toEqual([]);
  });
});
