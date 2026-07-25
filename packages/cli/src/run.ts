// run.ts — CLI dispatch (testable; returns exit codes, never calls
// process.exit).
//
// index.ts is a thin entry point: it forwards process.argv.slice(2) here,
// awaits the resulting exit code, and wires it to process.exit. Splitting
// the dispatch out lets tests invoke the CLI surface directly without
// subprocess overhead and without the runtime swallowing assertions via
// process.exit.

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { check, checkDir } from "./check.js";
import { contract } from "./contract.js";
import { extract } from "./extract.js";
import { inspect, inspectDiff, inspectDir } from "./inspect.js";

import type { ContractSource } from "./contract.js";

export const USAGE = `
Usage:
  suss extract [-p <tsconfig>] -f <framework> [-f <framework>] [-o <output.json>] [--files <f1> <f2> ...] [--gaps strict|permissive|silent]
  suss inspect <summaries.json>
  suss inspect --dir <directory>
  suss inspect --diff <before.json> <after.json>
  suss check <provider.json> <consumer.json> [--json] [-o <output>]
  suss check --dir <directory> [--intent <intent-dir>] [--json] [-o <output>]
  suss contract --from <source> <spec> [-o <output.json>]

Commands:
  extract   Read your source and describe what each boundary does
  inspect   Read a summaries file back in a form meant for people
  check     Compare two sides of a boundary and report what disagrees
  contract  Describe boundaries from a schema or deploy template

Options (extract):
  -p, --project    Path to the tsconfig covering the code to read. Without it,
                   suss uses the nearest tsconfig, or reads the current
                   directory when there is none.
  -f, --framework  Which pack to use. Repeatable. Built in: ts-rest,
                   react-router, express, fastify, nestjs-rest, nestjs-graphql,
                   react, apollo, aws-lambda, fetch, axios, apollo-client, node.
                   Other packs resolve as @suss/framework-<name>.
  -o, --output     Write JSON to a file instead of stdout
  --files          Read only these source files
  --gaps           What to do with gaps: strict (default), permissive, silent
  --explain        Show where the summaries came from, file by file and pack by
                   pack. Shown automatically when a run finds nothing.
  --fail-on-empty  Exit non-zero when a run finds nothing

Options (check):
  --dir            Folder of summary files, paired up by method and path
  --intent         Folder of intent docs (*.intent / *.prd) to check the code
                   against. Needs --dir.
  --json           Write findings as JSON instead of prose
  -o, --output     Write findings to a file instead of stdout
  --fail-on        Which severity fails the run: error (default), warning,
                   info, none
  --sussignore     Path to a .sussignore file, instead of finding one nearby
  --no-suppressions  Report every finding, ignoring any .sussignore

Options (contract):
  --from           What kind of file to read: openapi, cloudformation,
                   storybook, appsync, prisma, graphql
  -o, --output     Write JSON to a file instead of stdout

Exit codes:
  check exits non-zero when it finds anything at error severity.
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
  if (command === "contract") {
    return await runContract(args.slice(1));
  }

  process.stderr.write(
    `There is no "${command}" command. suss has extract, inspect, check, and contract.\n`,
  );
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
      explain: { type: "boolean" },
      "fail-on-empty": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const tsconfig = values.project;
  const frameworks = values.framework ?? [];

  if (frameworks.length === 0) {
    process.stderr.write(
      "extract needs at least one pack, so it knows what to look for. Try: suss extract -p tsconfig.json -f express\nRun `suss --help` for the built-in packs.\n",
    );
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
      `--gaps takes "strict", "permissive", or "silent". It got "${gaps}".\n`,
    );
    return 1;
  }

  // A path that was typed and does not exist is a usage error, so it
  // reports like one rather than surfacing as a thrown error.
  if (tsconfig !== undefined && !existsSync(path.resolve(tsconfig))) {
    process.stderr.write(
      `No tsconfig at ${path.resolve(tsconfig)}. Leave -p off to read the current directory instead.\n`,
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
    ...(tsconfig !== undefined ? { tsconfig } : {}),
    frameworks,
    ...(files !== undefined ? { files } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(gaps !== undefined ? { gaps } : {}),
    ...(values.timing === true ? { timing: true } : {}),
    ...(values["no-cache"] === true ? { noCache: true } : {}),
    ...(values.explain === true ? { explain: true } : {}),
    ...(values["fail-on-empty"] === true ? { failOnEmpty: true } : {}),
  });
  return process.exitCode === 1 ? 1 : 0;
}

function runInspect(args: string[]): number {
  if (args[0] === "--diff") {
    const before = args[1];
    const after = args[2];
    if (before === undefined || after === undefined) {
      process.stderr.write(
        "--diff compares two summary files. Try: suss inspect --diff before.json after.json\n",
      );
      return 1;
    }
    inspectDiff({ before, after });
    return 0;
  }
  if (args[0] === "--dir") {
    const dir = args[1];
    if (dir === undefined) {
      process.stderr.write(
        "--dir needs the folder holding your summary files. Try: suss inspect --dir summaries/\n",
      );
      return 1;
    }
    inspectDir({ dir });
    return 0;
  }
  const file = args[0];
  if (file === undefined) {
    process.stderr.write(
      "inspect needs a summaries file to read. Try: suss inspect summaries/api.json, or --dir to read a whole folder.\n",
    );
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
      intent: { type: "string" },
      "fail-on": { type: "string" },
      sussignore: { type: "string" },
      "no-suppressions": { type: "boolean" },
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
    ...(values.sussignore !== undefined
      ? { sussignore: values.sussignore }
      : {}),
    ...(values["no-suppressions"] === true ? { noSuppressions: true } : {}),
  };

  if (values.dir !== undefined) {
    const result = checkDir({
      dir: values.dir,
      ...shared,
      ...(values.intent !== undefined ? { intent: values.intent } : {}),
    });
    return result.hasErrors ? 1 : 0;
  }

  if (values.intent !== undefined) {
    process.stderr.write(
      "--intent checks your intent docs against code summaries, so it needs --dir too. Try: suss check --dir summaries/ --intent intent/\n",
    );
    return 1;
  }

  if (positionals.length < 2) {
    process.stderr.write(
      "check compares two sides of a boundary. Pass both files, or a folder holding them:\n  suss check summaries/api.json summaries/web.json\n  suss check --dir summaries/\n",
    );
    return 1;
  }

  const result = check({
    providerFile: positionals[0],
    consumerFile: positionals[1],
    ...shared,
  });
  return result.hasErrors ? 1 : 0;
}

async function runContract(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      output: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });

  const from = values.from as ContractSource | undefined;
  if (from === undefined) {
    process.stderr.write(
      "contract needs --from, so it knows how to read the file. Try: suss contract --from openapi openapi.yaml\n",
    );
    return 1;
  }
  const SUPPORTED_FROM: ContractSource[] = [
    "openapi",
    "cloudformation",
    "storybook",
    "appsync",
    "prisma",
    "graphql",
  ];
  if (!SUPPORTED_FROM.includes(from)) {
    process.stderr.write(
      `suss cannot read "${from}" contracts. It reads: ${SUPPORTED_FROM.join(", ")}.\n`,
    );
    return 1;
  }

  if (positionals.length === 0) {
    process.stderr.write(
      `contract needs the file to read. Try: suss contract --from ${from} <path>\n`,
    );
    return 1;
  }

  await contract({
    from,
    spec: positionals[0],
    ...(values.output !== undefined ? { output: values.output } : {}),
  });
  return 0;
}
