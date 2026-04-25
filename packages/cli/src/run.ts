// run.ts — CLI dispatch (testable; returns exit codes, never calls
// process.exit).
//
// index.ts is a thin entry point: it forwards process.argv.slice(2) here,
// awaits the resulting exit code, and wires it to process.exit. Splitting
// the dispatch out lets tests invoke the CLI surface directly without
// subprocess overhead and without the runtime swallowing assertions via
// process.exit.

import { parseArgs } from "node:util";

import { check, checkDir } from "./check.js";
import { extract } from "./extract.js";
import { inspect, inspectDiff, inspectDir } from "./inspect.js";
import { stub } from "./stub.js";

import type { StubSource } from "./stub.js";

export const USAGE = `
Usage:
  suss extract -p <tsconfig> -f <framework> [-f <framework>] [-o <output.json>] [--files <f1> <f2> ...] [--gaps strict|permissive|silent]
  suss inspect <summaries.json>
  suss inspect --dir <directory>
  suss inspect --diff <before.json> <after.json>
  suss check <provider.json> <consumer.json> [--json] [-o <output>]
  suss check --dir <directory> [--json] [-o <output>]
  suss stub --from <source> <spec> [-o <output.json>]

Commands:
  extract   Extract behavioral summaries from TypeScript source files
  inspect   Display human-readable output from a summaries JSON file
  check     Compare summary files and report cross-boundary findings
  stub      Generate behavioral summaries from a declared contract

Options (extract):
  -p, --project    Path to tsconfig.json (required)
  -f, --framework  Framework name. Repeatable. Built-in: ts-rest, react-router,
                   express, fastify, react, apollo, fetch, axios, apollo-client.
                   Custom packs resolve via @suss/framework-<name>.
  -o, --output     Write JSON to file instead of stdout
  --files          Specific source files to extract from
  --gaps           Gap handling: strict (default), permissive, silent

Options (check):
  --dir            Directory of summary JSON files (auto-pairs by method+path)
  --json           Emit findings as JSON (default: human-readable)
  -o, --output     Write findings to file instead of stdout
  --fail-on        Exit non-zero threshold: error (default), warning, info, none

Options (stub):
  --from           Stub source kind: openapi, cloudformation, storybook, appsync
  -o, --output     Write JSON to file instead of stdout

Exit codes:
  check exits non-zero when any error-severity findings are present.
`.trim();

/**
 * Dispatch a CLI invocation. Returns the process exit code; never calls
 * process.exit and never throws for user-visible errors (those go to
 * stderr and yield a non-zero exit code instead).
 *
 * Unhandled exceptions thrown by the underlying subcommands DO propagate
 * — the entry point converts them to "Error: <message>" + exit 1.
 */
export async function runCli(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const command = args[0];

  if (command === "extract") {
    return await runExtract(args.slice(1));
  }
  if (command === "inspect") {
    return runInspect(args.slice(1));
  }
  if (command === "check") {
    return runCheck(args.slice(1));
  }
  if (command === "stub") {
    return await runStub(args.slice(1));
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

async function runExtract(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      framework: { type: "string", short: "f", multiple: true },
      output: { type: "string", short: "o" },
      gaps: { type: "string" },
      files: { type: "string", multiple: true },
      timing: { type: "boolean" },
      "no-cache": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const tsconfig = values.project;
  const frameworks = values.framework ?? [];

  if (tsconfig === undefined) {
    process.stderr.write("Error: --project (-p) is required for extract\n");
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  if (frameworks.length === 0) {
    process.stderr.write("Error: at least one --framework (-f) is required\n");
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const gaps = values.gaps as "strict" | "permissive" | "silent" | undefined;
  if (
    gaps !== undefined &&
    gaps !== "strict" &&
    gaps !== "permissive" &&
    gaps !== "silent"
  ) {
    process.stderr.write(
      `Error: --gaps must be "strict", "permissive", or "silent"\n`,
    );
    return 1;
  }

  // Files can come from --files or positionals
  const files =
    values.files !== undefined && values.files.length > 0
      ? values.files
      : positionals.length > 0
        ? positionals
        : undefined;

  await extract({
    tsconfig,
    frameworks,
    ...(files !== undefined ? { files } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(gaps !== undefined ? { gaps } : {}),
    ...(values.timing === true ? { timing: true } : {}),
    ...(values["no-cache"] === true ? { noCache: true } : {}),
  });
  return 0;
}

function runInspect(args: string[]): number {
  if (args[0] === "--diff") {
    const before = args[1];
    const after = args[2];
    if (before === undefined || after === undefined) {
      process.stderr.write("Error: --diff requires two summary file paths\n");
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    inspectDiff({ before, after });
    return 0;
  }
  if (args[0] === "--dir") {
    const dir = args[1];
    if (dir === undefined) {
      process.stderr.write("Error: --dir requires a directory path\n");
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    inspectDir({ dir });
    return 0;
  }
  const file = args[0];
  if (file === undefined) {
    process.stderr.write(
      "Error: inspect requires a summaries JSON file path\n",
    );
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  inspect({ file });
  return 0;
}

function runCheck(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      output: { type: "string", short: "o" },
      dir: { type: "string" },
      "fail-on": { type: "string" },
    },
    allowPositionals: true,
  });

  const failOn = values["fail-on"] as
    | "error"
    | "warning"
    | "info"
    | "none"
    | undefined;
  if (
    failOn !== undefined &&
    failOn !== "error" &&
    failOn !== "warning" &&
    failOn !== "info" &&
    failOn !== "none"
  ) {
    process.stderr.write(
      `Error: --fail-on must be "error", "warning", "info", or "none"\n`,
    );
    return 1;
  }

  const shared = {
    ...(values.json === true ? { json: true } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(failOn !== undefined ? { failOn } : {}),
  };

  if (values.dir !== undefined) {
    const result = checkDir({ dir: values.dir, ...shared });
    return result.hasErrors ? 1 : 0;
  }

  if (positionals.length < 2) {
    process.stderr.write(
      "Error: check requires two summary file paths or --dir <directory>\n",
    );
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const result = check({
    providerFile: positionals[0],
    consumerFile: positionals[1],
    ...shared,
  });
  return result.hasErrors ? 1 : 0;
}

async function runStub(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      output: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });

  const from = values.from as StubSource | undefined;
  if (from === undefined) {
    process.stderr.write("Error: --from is required for stub\n");
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  if (from !== "openapi" && from !== "cloudformation" && from !== "storybook") {
    process.stderr.write(
      `Error: unknown --from value "${from}". Supported: openapi, cloudformation, storybook\n`,
    );
    return 1;
  }

  if (positionals.length === 0) {
    process.stderr.write("Error: stub requires a spec file path\n");
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  await stub({
    from,
    spec: positionals[0],
    ...(values.output !== undefined ? { output: values.output } : {}),
  });
  return 0;
}
