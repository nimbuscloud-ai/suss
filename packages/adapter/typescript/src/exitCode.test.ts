import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTypeScriptAdapter } from "./adapter.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";

/** A runtime the way the Node pack declares one: an exit read in every unit. */
const runtimePack: PatternPack = {
  name: "runtime",
  protocol: "in-process",
  languages: ["typescript"],
  discovery: [],
  terminals: [
    {
      kind: "exit",
      inEveryUnit: true,
      match: { type: "functionCall", functionName: "process.exit" },
      extraction: {
        statusCode: { from: "argument", position: 0 },
        defaultStatusCode: 0,
      },
    },
  ],
  exitCodeWrites: ["process.exitCode"],
  inputMapping: { type: "positionalParams", params: [] },
  // A recognizer is what makes the file's exports roots of the closure.
  invocationRecognizers: [() => null],
};

async function summariesOf(
  files: Record<string, string>,
): Promise<BehavioralSummary[]> {
  const project = createTestProject();
  for (const [name, source] of Object.entries(files)) {
    project.createSourceFile(name, source);
  }
  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [runtimePack],
    cacheDir: null,
  });
  return adapter.extractAll();
}

function unit(summaries: BehavioralSummary[], name: string): BehavioralSummary {
  const found = summaries.find((one) => one.identity.name === name);
  if (found === undefined) {
    throw new Error(`no summary for ${name}`);
  }
  return found;
}

function outputsOf(summary: BehavioralSummary): Transition["output"][] {
  return summary.transitions.map((t) => t.output);
}

describe("how a program exits", () => {
  it("ends a path at process.exit with the code it passes", async () => {
    const summaries = await summariesOf({
      "/cli.ts": `
        export function main(args: string[]): number {
          if (args.length === 0) {
            process.exit(2);
          }
          if (args[0] === "--quiet") {
            process.exit();
          }
          return 0;
        }
      `,
    });
    expect(outputsOf(unit(summaries, "main"))).toEqual([
      { type: "exit", code: { type: "literal", value: 2 } },
      { type: "exit", code: { type: "literal", value: 0 } },
      { type: "return", value: { type: "literal", value: 0, raw: "0" } },
    ]);
    // The return runs only when neither guard fired, so it has both
    // negations, the way it would behind two early returns.
    const [, , returned] = unit(summaries, "main").transitions;
    expect(returned?.conditions).toHaveLength(2);
  });

  it("reads a code the program computes as the text it came from", async () => {
    const summaries = await summariesOf({
      "/cli.ts": `
        export function fail(code: number): void {
          process.exit(code);
        }
      `,
    });
    expect(outputsOf(unit(summaries, "fail"))).toEqual([
      { type: "exit", code: { type: "unresolved", sourceText: "code" } },
    ]);
  });

  it("splits a returned choice into one transition per arm", async () => {
    const summaries = await summariesOf({
      "/cli.ts": `
        export function codeFor(failed: boolean): number {
          return failed ? 1 : 0;
        }
      `,
    });
    const [whenTrue, whenFalse] = unit(summaries, "codeFor").transitions;
    expect(whenTrue?.output).toEqual({
      type: "return",
      value: { type: "literal", value: 1, raw: "1" },
    });
    expect(whenFalse?.output).toEqual({
      type: "return",
      value: { type: "literal", value: 0, raw: "0" },
    });
    expect(whenTrue?.conditions).toHaveLength(1);
    expect(whenFalse?.conditions[0]?.type).toBe("negation");
  });

  it("keeps a choice between two calls as one return, so each call stays an effect", async () => {
    const summaries = await summariesOf({
      "/cli.ts": `
        function one(): number { return 1; }
        function two(): number { return 2; }
        export function pick(first: boolean): number {
          return first ? one() : two();
        }
      `,
    });
    const pick = unit(summaries, "pick");
    expect(pick.transitions).toHaveLength(1);
    const callees = pick.transitions[0]?.effects.flatMap((effect) =>
      effect.type === "invocation" ? [effect.callee] : [],
    );
    expect(callees).toEqual(["one", "two"]);
  });
});

describe("which returns become the exit code", () => {
  const files = {
    "/run.ts": `
      function checkFolder(dir: string): { hasErrors: boolean } {
        return { hasErrors: dir.length === 0 };
      }
      export async function runCheck(args: string[]): Promise<number> {
        const result = checkFolder(args[0] ?? "");
        return result.hasErrors ? 1 : 0;
      }
      async function dispatch(args: string[]): Promise<number> {
        return await runCheck(args.slice(1));
      }
      export async function runCli(args: string[]): Promise<number> {
        const code = await dispatch(args);
        return code;
      }
    `,
    "/bin.ts": `
      import { runCli } from "./run.js";
      runCli(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
      });
    `,
  };

  it("marks every function the code is returned up through, from the .then that sets it", async () => {
    const summaries = await summariesOf(files);
    const marked = summaries
      .filter((one) => one.metadata?.process !== undefined)
      .map((one) => one.identity.name)
      .sort();
    expect(marked).toEqual(["dispatch", "runCheck", "runCli"]);
    expect(unit(summaries, "runCheck").metadata?.process).toEqual({
      exitCodeFrom: "return",
    });
  });

  it("marks the function whose call is the exit's argument", async () => {
    const summaries = await summariesOf({
      "/cli.ts": `
        function main(): number {
          return 3;
        }
        export function start(): void {
          process.exit(main());
        }
      `,
    });
    expect(unit(summaries, "main").metadata?.process).toEqual({
      exitCodeFrom: "return",
    });
    expect(unit(summaries, "start").metadata).toBeUndefined();
  });

  it("marks nothing in a program that never sets its exit code", async () => {
    const summaries = await summariesOf({ "/run.ts": files["/run.ts"] });
    expect(
      summaries.filter((one) => one.metadata?.process !== undefined),
    ).toEqual([]);
  });
});
