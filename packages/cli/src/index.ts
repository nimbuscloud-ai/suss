// @suss/cli — CLI entry point

import { parseArgs } from "node:util";

import { check } from "./check.js";
import { extract } from "./extract.js";
import { inspect } from "./inspect.js";

const USAGE = `
Usage:
  suss extract -p <tsconfig> -f <framework> [-f <framework>] [-o <output.json>] [--files <f1> <f2> ...] [--gaps strict|permissive|silent]
  suss inspect <summaries.json>
  suss check <provider.json> <consumer.json> [--json] [-o <output>]

Commands:
  extract   Extract behavioral summaries from TypeScript source files
  inspect   Display human-readable output from a summaries JSON file
  check     Compare two summary files and report cross-boundary findings

Options (extract):
  -p, --project    Path to tsconfig.json (required)
  -f, --framework  Framework name: ts-rest, react-router, express (repeatable)
  -o, --output     Write JSON to file instead of stdout
  --files          Specific source files to extract from
  --gaps           Gap handling: strict (default), permissive, silent

Options (check):
  --json           Emit findings as JSON (default: human-readable)
  -o, --output     Write findings to file instead of stdout

Exit codes:
  check exits non-zero when any error-severity findings are present.
`.trim();

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  if (command === "extract") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        project: { type: "string", short: "p" },
        framework: { type: "string", short: "f", multiple: true },
        output: { type: "string", short: "o" },
        gaps: { type: "string" },
        files: { type: "string", multiple: true },
      },
      allowPositionals: true,
    });

    const tsconfig = values.project;
    const frameworks = values.framework ?? [];

    if (tsconfig === undefined) {
      console.error("Error: --project (-p) is required for extract");
      console.error(USAGE);
      process.exit(1);
    }

    if (frameworks.length === 0) {
      console.error("Error: at least one --framework (-f) is required");
      console.error(USAGE);
      process.exit(1);
    }

    const gaps = values.gaps as "strict" | "permissive" | "silent" | undefined;
    if (
      gaps !== undefined &&
      gaps !== "strict" &&
      gaps !== "permissive" &&
      gaps !== "silent"
    ) {
      console.error(
        `Error: --gaps must be "strict", "permissive", or "silent"`,
      );
      process.exit(1);
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
    });
  } else if (command === "inspect") {
    const file = args[1];
    if (file === undefined) {
      console.error("Error: inspect requires a summaries JSON file path");
      console.error(USAGE);
      process.exit(1);
    }

    inspect({ file });
  } else if (command === "check") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        json: { type: "boolean" },
        output: { type: "string", short: "o" },
      },
      allowPositionals: true,
    });

    if (positionals.length < 2) {
      console.error(
        "Error: check requires two summary file paths: <provider.json> <consumer.json>",
      );
      console.error(USAGE);
      process.exit(1);
    }

    const result = check({
      providerFile: positionals[0],
      consumerFile: positionals[1],
      ...(values.json === true ? { json: true } : {}),
      ...(values.output !== undefined ? { output: values.output } : {}),
    });

    if (result.hasErrors) {
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    console.error(USAGE);
    process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

export { check } from "./check.js";
export { extract } from "./extract.js";
export { inspect } from "./inspect.js";

export type { CheckOptions, CheckResult } from "./check.js";
export type { ExtractOptions } from "./extract.js";
export type { InspectOptions } from "./inspect.js";
