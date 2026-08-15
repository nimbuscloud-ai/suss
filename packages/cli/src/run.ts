// run.ts: CLI dispatch. It returns exit codes and never calls
// process.exit, so a test can drive it directly.
//
// index.ts is a thin entry point. It forwards process.argv.slice(2)
// here, awaits the exit code, and passes that to process.exit.
// Splitting the dispatch out lets tests drive the CLI surface without
// subprocess overhead, and without the runtime swallowing assertions
// through process.exit.

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { check, checkDir } from "./check.js";
import { contract } from "./contract.js";
import { corroborate } from "./corroborateCommand.js";
import { extract } from "./extract.js";
import { inspectFlow } from "./flow.js";
import { initInteractive } from "./initInteractive.js";
import { inspect, inspectDiff, inspectDir } from "./inspect.js";
import { LANGUAGES, parseLanguage } from "./language.js";
import { printUpdateNoticeIfBehind } from "./updateNotice.js";
import { UsageError } from "./usageError.js";

import type { ContractSource } from "./contract.js";
import type { ExtractOptions } from "./extract.js";

export const USAGE = `
Usage:
  suss init [directory] [--plain]
  suss extract [-p <tsconfig> | --dir <directory>] [--lang typescript|python|ruby] -f <framework>[=<config.json>] [-f <framework>] [-o <output.json>] [--files <f1> <f2> ...] [--gaps strict|permissive|silent]
  suss inspect <summaries.json>
  suss inspect --dir <directory>
  suss inspect --diff <before.json> <after.json>
  suss inspect --flow "<METHOD> <url>" [<summaries.json> | --dir <directory>] [--entry <name>] [--scope <document>] [--json]
  suss check <provider.json> <consumer.json> [--json] [-o <output>]
  suss check --dir <directory> [--intent <intent-dir>] [--json] [-o <output>]
  suss contract --from <source> <spec> [-o <output.json>]
  suss corroborate --experimental [-p <tsconfig> | --dir <directory>] -f <framework> [-o <output.json>]

Commands:
  init      Work out which packs this project needs and offer to set them up.
            --plain prints the commands instead of asking. Piped or in CI,
            it prints either way.
  extract   Read your source and describe what each boundary does
  inspect   Read a summaries file back in a form meant for people
  check     Compare two sides of a boundary and report what disagrees
  contract  Describe boundaries from a schema or deploy template
  corroborate  Extract, then run each handler against its own claims
            (experimental). A claim that survives execution is marked
            observed; one that fails carries a concrete counterexample.

Options (extract):
  -p, --project    Path to the tsconfig covering the code to read. Without it,
                   suss uses the nearest tsconfig, or reads the current
                   directory when there is none.
  --lang           Which language suss reads this project as: typescript,
                   python, or ruby. Without it, suss works that out from
                   what the directory holds, and says so when it cannot.
  -f, --framework  Which pack to use. Repeatable. Built in: hono, express,
                   fastify, ts-rest, nestjs-rest, nestjs-graphql, apollo,
                   aws-lambda, react, react-router, fetch, axios,
                   apollo-client, node, and for the other two languages
                   fastapi, flask-restx, and graphql-ruby.
                   Other packs resolve as @suss/framework-<name>.
                   Write -f <pack>=<config.json> to configure a pack, for
                   example to name the dispatcher your project sends
                   messages through. Each pack documents its own options.
  -o, --output     Write JSON to a file instead of stdout
  --files          Read only these source files
  --gaps           What to do with gaps: permissive (default) records them
                   in the summary, strict does the same and then fails the
                   run if it recorded any, silent skips gap detection
  --timing         Print how long each phase of the run took, to stderr
  --explain        Show where the summaries came from, file by file and pack by
                   pack. Shown automatically when a run finds nothing.
  --fail-on-empty  Exit non-zero when a run finds nothing
  --fail-on-pack-error  Exit non-zero when a pack throws while it reads

Options (inspect):
  --dir            Folder of summary files to read, instead of one file
  --diff           Compare two summary files and report what moved
  --types          Spell out the types a summary names, rather than naming them

Options (inspect --flow):
  --flow           The request to ask about, as a method and a URL:
                   "GET https://shop.example.com/api/orders/123". The answer
                   names the entry it came in by, every hop it took and what
                   admitted that hop, and the handler that serves it. A hop
                   waiting on something the declarations leave open is said to
                   be possible, never settled.
  --dir            Folder of summary files to read, instead of one file
  --entry          Which node the request comes in by, when there is more
                   than one way in
  --scope          Which document's node, when two documents declare the name
  --json           Write the chains as JSON instead of prose

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
                   serverless, storybook, appsync, prisma, graphql,
                   graphql-documents
  -o, --output     Write JSON to a file instead of stdout

Options (corroborate):
  --experimental   Required. The command is early: today it runs REST
                   handlers from the express and fastify packs and only
                   checks claims with a literal status code.
  -p, --project    Path to the tsconfig covering the code to read
  --dir            Directory to read when there is no tsconfig
  -f, --framework  Which pack to use. Repeatable, same names as extract.
  --runs           Verdict runs to aim for per claim (default 25)
  --attempts       Sampling attempts per claim before giving up (default 300)
  -o, --output     Write the annotated summaries to a file

Exit codes:
  check exits non-zero when it finds anything at error severity.
  corroborate exits non-zero when a claim is refuted by execution.

An interactive run ends with one line on stderr when a newer suss is on
the registry. Piped output and CI never see it, and setting
SUSS_NO_UPDATE_NOTICE turns it off everywhere.
`.trim();

/** Returns the exit code rather than calling process.exit, so tests can run it. */
export async function runCli(args: string[]): Promise<number> {
  try {
    const code = await dispatch(args);
    await printUpdateNoticeIfBehind();
    return code;
  } catch (err) {
    const sentence = asSentence(err);
    if (sentence === null) {
      throw err;
    }

    process.stderr.write(`${sentence}\n`);
    return 1;
  }
}

/**
 * What to print for a throw a person caused, or null when the throw is a
 * bug in suss. Node's own argument parser counts: an unquoted flag value
 * reaches it as a TypeError whose message is already the right sentence.
 */
function asSentence(err: unknown): string | null {
  if (err instanceof UsageError) {
    return err.message;
  }

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")) {
    return `${(err as Error).message}\nRun \`suss --help\` for the flags.`;
  }

  return null;
}

async function dispatch(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const command = args[0];

  if (command === "init") {
    return await runInit(args.slice(1));
  }
  if (command === "extract") {
    return await runExtract(args.slice(1));
  }
  if (command === "inspect") {
    return await runInspect(args.slice(1));
  }
  if (command === "check") {
    return runCheck(args.slice(1));
  }
  if (command === "contract") {
    return await runContract(args.slice(1));
  }
  if (command === "corroborate") {
    return await runCorroborate(args.slice(1));
  }

  process.stderr.write(
    `There is no "${command}" command. suss has init, extract, inspect, check, contract, and corroborate.\n`,
  );
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

async function runInit(args: string[]): Promise<number> {
  const plain = args.includes("--plain");
  const dir = args.find((a) => !a.startsWith("-"));
  return await initInteractive({
    ...(dir !== undefined ? { dir } : {}),
    ...(plain ? { plain: true } : {}),
  });
}

async function runExtract(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      dir: { type: "string" },
      lang: { type: "string" },
      framework: { type: "string", short: "f", multiple: true },
      output: { type: "string", short: "o" },
      gaps: { type: "string" },
      files: { type: "string", multiple: true },
      timing: { type: "boolean" },
      "datalog-profile": { type: "boolean" },
      "no-cache": { type: "boolean" },
      explain: { type: "boolean" },
      "fail-on-empty": { type: "boolean" },
      "fail-on-pack-error": { type: "boolean" },
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

  const lang =
    values.lang === undefined ? undefined : parseLanguage(values.lang);
  if (values.lang !== undefined && lang === null) {
    process.stderr.write(
      `--lang takes ${LANGUAGES.join(", ")}. It got "${values.lang}".\n`,
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

  if (tsconfig !== undefined && !existsSync(path.resolve(tsconfig))) {
    process.stderr.write(
      `No tsconfig at ${path.resolve(tsconfig)}. Leave -p off to read the current directory instead.\n`,
    );
    return 1;
  }

  if (values.dir !== undefined && !existsSync(path.resolve(values.dir))) {
    process.stderr.write(`No directory at ${path.resolve(values.dir)}.\n`);
    return 1;
  }

  const files =
    values.files !== undefined && values.files.length > 0
      ? values.files
      : positionals.length > 0
        ? positionals
        : undefined;

  const options: ExtractOptions = {
    ...(tsconfig !== undefined ? { tsconfig } : {}),
    ...(values.dir !== undefined ? { dir: values.dir } : {}),
    ...(lang !== undefined && lang !== null ? { lang } : {}),
    frameworks,
    ...(files !== undefined ? { files } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(gaps !== undefined ? { gaps } : {}),
    ...(values.timing === true ? { timing: true } : {}),
    ...(values["datalog-profile"] === true ? { datalogProfile: true } : {}),
    ...(values["no-cache"] === true ? { noCache: true } : {}),
    ...(values.explain === true ? { explain: true } : {}),
    ...(values["fail-on-empty"] === true ? { failOnEmpty: true } : {}),
    ...(values["fail-on-pack-error"] === true ? { failOnPackError: true } : {}),
  };

  await extract(options);

  return process.exitCode === 1 ? 1 : 0;
}

async function runInspect(argv: string[]): Promise<number> {
  if (argv.includes("--flow")) {
    return await runFlow(argv);
  }

  const types = argv.includes("--types");
  const args = argv.filter((a) => a !== "--types");
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
    inspectDir({ dir, ...(types ? { types } : {}) });
    return 0;
  }
  const file = args[0];
  if (file === undefined) {
    process.stderr.write(
      "inspect needs a summaries file to read. Try: suss inspect summaries/api.json, or --dir to read a whole folder.\n",
    );
    return 1;
  }
  inspect({ file, ...(types ? { types } : {}) });
  return 0;
}

async function runFlow(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      flow: { type: "string" },
      dir: { type: "string" },
      entry: { type: "string" },
      scope: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.flow === undefined || values.flow === "") {
    process.stderr.write(
      'inspect --flow needs the request to ask about. Try: suss inspect --flow "GET https://shop.example.com/api/orders/123" --dir summaries/\n',
    );
    return 1;
  }

  return await inspectFlow({
    request: values.flow,
    ...(values.dir !== undefined ? { dir: values.dir } : {}),
    ...(positionals.length > 0 ? { file: positionals[0] } : {}),
    ...(values.entry !== undefined ? { entry: values.entry } : {}),
    ...(values.scope !== undefined ? { scope: values.scope } : {}),
    ...(values.json === true ? { json: true } : {}),
  });
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

async function runCorroborate(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      experimental: { type: "boolean" },
      project: { type: "string", short: "p" },
      dir: { type: "string" },
      framework: { type: "string", short: "f", multiple: true },
      output: { type: "string", short: "o" },
      runs: { type: "string" },
      attempts: { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.experimental !== true) {
    process.stderr.write(
      "corroborate is experimental, and its scope and output will change. Pass --experimental to run it anyway.\n",
    );
    return 1;
  }

  const frameworks = values.framework ?? [];
  if (frameworks.length === 0) {
    process.stderr.write(
      "corroborate needs at least one pack, so it knows what to look for. Try: suss corroborate --experimental -f express\n",
    );
    return 1;
  }

  const tsconfig = values.project;
  if (tsconfig !== undefined && !existsSync(path.resolve(tsconfig))) {
    process.stderr.write(
      `No tsconfig at ${path.resolve(tsconfig)}. Leave -p off to read the current directory instead.\n`,
    );
    return 1;
  }
  if (values.dir !== undefined && !existsSync(path.resolve(values.dir))) {
    process.stderr.write(`No directory at ${path.resolve(values.dir)}.\n`);
    return 1;
  }

  const runs = values.runs !== undefined ? Number(values.runs) : undefined;
  const attempts =
    values.attempts !== undefined ? Number(values.attempts) : undefined;
  if (runs !== undefined && !(Number.isInteger(runs) && runs > 0)) {
    process.stderr.write("--runs takes a positive whole number.\n");
    return 1;
  }
  if (attempts !== undefined && !(Number.isInteger(attempts) && attempts > 0)) {
    process.stderr.write("--attempts takes a positive whole number.\n");
    return 1;
  }

  const result = await corroborate({
    ...(tsconfig !== undefined ? { tsconfig } : {}),
    ...(values.dir !== undefined ? { dir: values.dir } : {}),
    frameworks,
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
  });
  return result.refuted > 0 ? 1 : 0;
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
    "serverless",
    "storybook",
    "appsync",
    "prisma",
    "graphql",
    "graphql-documents",
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
