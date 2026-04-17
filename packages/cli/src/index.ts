// @suss/cli — CLI entry point

import { parseArgs } from "node:util";

import { check, checkDir } from "./check.js";
import { extract } from "./extract.js";
import { inspect, inspectDiff, inspectDir } from "./inspect.js";
import { stub } from "./stub.js";

import type { CheckResult } from "./check.js";
import type { StubSource } from "./stub.js";

const USAGE = `
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
  -f, --framework  Framework name: ts-rest, react-router, express, fastify, fetch, axios (repeatable)
  -o, --output     Write JSON to file instead of stdout
  --files          Specific source files to extract from
  --gaps           Gap handling: strict (default), permissive, silent

Options (check):
  --dir            Directory of summary JSON files (auto-pairs by method+path)
  --json           Emit findings as JSON (default: human-readable)
  -o, --output     Write findings to file instead of stdout
  --fail-on        Exit non-zero threshold: error (default), warning, info, none

Options (stub):
  --from           Stub source kind: openapi (the only one today)
  -o, --output     Write JSON to file instead of stdout

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
    if (args[1] === "--diff") {
      const before = args[2];
      const after = args[3];
      if (before === undefined || after === undefined) {
        console.error("Error: --diff requires two summary file paths");
        console.error(USAGE);
        process.exit(1);
      }
      inspectDiff({ before, after });
    } else if (args[1] === "--dir") {
      const dir = args[2];
      if (dir === undefined) {
        console.error("Error: --dir requires a directory path");
        console.error(USAGE);
        process.exit(1);
      }
      inspectDir({ dir });
    } else {
      const file = args[1];
      if (file === undefined) {
        console.error("Error: inspect requires a summaries JSON file path");
        console.error(USAGE);
        process.exit(1);
      }
      inspect({ file });
    }
  } else if (command === "check") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
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
      console.error(
        `Error: --fail-on must be "error", "warning", "info", or "none"`,
      );
      process.exit(1);
    }

    const shared = {
      ...(values.json === true ? { json: true } : {}),
      ...(values.output !== undefined ? { output: values.output } : {}),
      ...(failOn !== undefined ? { failOn } : {}),
    };

    let result: CheckResult;

    if (values.dir !== undefined) {
      result = checkDir({ dir: values.dir, ...shared });
    } else {
      if (positionals.length < 2) {
        console.error(
          "Error: check requires two summary file paths or --dir <directory>",
        );
        console.error(USAGE);
        process.exit(1);
      }

      result = check({
        providerFile: positionals[0],
        consumerFile: positionals[1],
        ...shared,
      });
    }

    if (result.hasErrors) {
      process.exit(1);
    }
  } else if (command === "stub") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        from: { type: "string" },
        output: { type: "string", short: "o" },
      },
      allowPositionals: true,
    });

    const from = values.from as StubSource | undefined;
    if (from === undefined) {
      console.error("Error: --from is required for stub");
      console.error(USAGE);
      process.exit(1);
    }
    if (from !== "openapi") {
      console.error(
        `Error: unknown --from value "${from}". Supported: openapi`,
      );
      process.exit(1);
    }

    if (positionals.length === 0) {
      console.error("Error: stub requires a spec file path");
      console.error(USAGE);
      process.exit(1);
    }

    await stub({
      from,
      spec: positionals[0],
      ...(values.output !== undefined ? { output: values.output } : {}),
    });
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

export { check, checkDir } from "./check.js";
export { extract } from "./extract.js";
export { inspect, inspectDiff, inspectDir } from "./inspect.js";
export { stub } from "./stub.js";

export type {
  CheckDirOptions,
  CheckOptions,
  CheckResult,
  FailOn,
} from "./check.js";
export type { ExtractOptions } from "./extract.js";
export type { DiffOptions, DirOptions, InspectOptions } from "./inspect.js";
export type { StubOptions, StubSource } from "./stub.js";
