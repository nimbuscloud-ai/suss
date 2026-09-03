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

import { ask, preloadForQuestion } from "./ask.js";
import { check, checkDir } from "./check.js";
import { checkAt } from "./checkAt.js";
import { contract } from "./contract.js";
import { corroborate } from "./corroborateCommand.js";
import { extract } from "./extract.js";
import { inspectFlow } from "./flow.js";
import { initInteractive } from "./initInteractive.js";
import { inspect, inspectDiff, inspectDir } from "./inspect.js";
import { intentDraft } from "./intentDraftCommand.js";
import { LANGUAGES, parseLanguage } from "./language.js";
import { prdDraft } from "./prdDraftCommand.js";
import { stubDraft } from "./stubDraftCommand.js";
import { installedVersion, printUpdateNoticeIfBehind } from "./updateNotice.js";
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
  suss check <provider.json> <consumer.json> [--all] [--json] [-o <output>]
  suss check --dir <directory> [--intent <intent-dir>] [--all] [--json] [-o <output>]
  suss check --dir <directory> --at <file[:line] | boundary | summary-id> [--json]
  suss ask "<question>" [--dir <directory> | <summaries.json>] [--all] [--json]
  suss contract --from <source> <spec> [-o <output.json>]
  suss corroborate --experimental [-p <tsconfig> | --dir <directory>] -f <framework> [-o <output.json>]
  suss infer stub <package> [-p <tsconfig> | --dir <directory>] [-o <file | ->]
  suss infer intent --from <summaries.json | directory> [-o <directory> | --into <directory>]
  suss infer prd --from <intent-directory> [-o <directory> | --into <directory>]
  suss --version

Commands:
  init      Work out which packs this project needs and offer to set them up.
            --plain prints the commands instead of asking. Piped or in CI,
            it prints either way.
  extract   Read your source and describe what each boundary does
  inspect   Read a summaries file back in a form meant for people
  check     Compare two sides of a boundary and report what disagrees.
            --at reports on one file, line, boundary, or summary instead
            of the whole folder
  ask       Answer one question about one boundary from summaries on disk
  contract  Describe boundaries from a schema or deploy template
  corroborate  Extract, then run each handler against its own claims
            (experimental). A claim that survives execution is marked
            observed; one that fails carries a concrete counterexample.
  infer     Draft an artifact for you to curate. "infer stub" writes a
            dependency stub skeleton, the checked-in file that states
            what a package suss cannot read does, from the project's
            observed calls into it (TypeScript), imports of it
            (Python), or requires and superclasses spelled from it
            (Ruby). "infer intent" writes one
            boundary intent doc per boundary in a summaries file, saying
            what the code does today, for you to turn into what the team
            meant. "infer prd" reads those once they are curated and
            writes a PRD per boundary, one scenario per outcome, for you
            to say why each is there.

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
                   fastapi, flask-restx, graphql-ruby, and rails.
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
  --allow-empty    A run that finds nothing exits non-zero by default;
                   this opts back into exiting 0
  --fail-on-pack-error  Exit non-zero when a pack throws while it reads

Options (check):
  --allow-empty    A run over --dir that compares nothing exits
                   non-zero by default, which otherwise reads the same
                   as both sides agreeing; this opts back into exiting 0
  --fail-on-unpaired  Exit non-zero when more boundaries went unpaired
                   than this: a count ("25") or a share ("50%")
  --fail-on-unreadable  Exit non-zero when a file in --dir could not be
                   read as summaries, instead of skipping it

Options (inspect):
  --dir            Folder of summary files to read, instead of one file
  --diff           Compare two summary files and report what moved
  --json           With --diff, write the diff as JSON for a machine
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
  --at             Report on one thing instead of the whole folder: a file
                   (src/dao.ts), a file and a line (src/dao.ts:43), a
                   boundary (dynamodb:editions#by-publication), or a summary
                   id (pkg::src/dao.ts::byPublication). Needs --dir. Exits
                   non-zero when it matches nothing, since an empty report
                   would read as agreement.
  --intent         Folder of intent docs (*.intent / *.prd) to check the code
                   against. Needs --dir.
  --all            Write out every finding and every list. Without it a run
                   prints the errors in full and counts the rest, because a
                   first run over a repository reports far more at warning
                   and info than at error. --at already prints in full, and
                   --json is unaffected either way.
  --json           Write findings as JSON instead of prose
  -o, --output     Write findings to a file instead of stdout
  --fail-on        Which severity fails the run: error (default), warning,
                   info, none
  --sussignore     Path to a .sussignore file, instead of finding one nearby
  --no-suppressions  Report every finding, ignoring any .sussignore

Options (ask):
  The question is one of ten, in these words:
    what can I project from <boundary>   what the boundary declares
    what reads <boundary>                which units read it
    what writes <boundary>               which units write it
    what invokes <boundary>              which units invoke it
    what calls <unit>                    which units call it
    what does <unit> reach               which boundaries a file or
                                         summary goes through
    what reaches <target>                which boundaries end up going
                                         through the target, however
                                         many calls away
    what does <package or unit> provide  every boundary it provides
    why does <unit> reach <boundary>     the call chain that gets there,
                                         with each hop's resolution
    why does <name> at <file>:<line> resolve to <target>
                                         the chain from a written name
                                         to the function it comes to
  A boundary is written the way reports write it, and a shorter spelling
  matches more: "dynamodb:editions" covers every index on that table.
  --dir            Folder of summary files to read, instead of one file
  --project        Where the source is, for a why question (default: cwd)
  --all            List every unit an answer picked out. Without it a
                   long answer stops after ten and says how many are
                   left. --json is unaffected and always lists all.
  --json           Write the answer as JSON instead of prose
  -o, --output     Write the answer to a file instead of stdout

Options (contract):
  --from           What kind of file to read: openapi, cloudformation,
                   terraform, serverless, storybook, appsync, prisma,
                   graphql, graphql-documents, wrangler. A terraform path
                   may be one .tf file or the directory a module lives
                   in, and a wrangler path may be the directory a Worker
                   lives in
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

Options (infer stub):
  -p, --project    Path to the tsconfig covering the code to read
  --dir            Directory to read when there is no tsconfig, or
                   when the code is Python or Ruby
  -o, --output     Where to write the draft. "-" prints it instead.
                   Default: suss/stubs/<package>.yaml next to the code.
                   A Python package can draft one file per imported
                   module; -o then has to be left off.

Options (infer intent):
  --from           The summaries file to read, from suss extract. Pick the
                   boundaries there, with extract's own --files and -f;
                   infer writes a doc for every boundary it is given.
  -o, --out        Folder the docs go in. Default: intent/. Docs already
                   there are written over, with a warning first.
  --into           The same folder, for a re-inference you want kept apart
                   from what you have curated: it refuses to write where
                   intent docs already are.

Exit codes:
  check exits non-zero when it finds anything at error severity.
  corroborate exits non-zero when a claim is refuted by execution.
  infer stub exits non-zero when the project shows no evidence of the
  package: no calls, no imports, no requires, no superclass.
  infer intent exits non-zero when no boundary could be drafted.

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

    // A --json caller pipes stdout to a parser, so the reason has to
    // arrive as JSON there; the sentence stays on stderr for a person.
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ error: sentence })}\n`);
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
  // Asking any command for help prints the usage. Without this, every
  // command that parses flags strictly rejects `--help` as unknown,
  // and `init` treats it as neither a flag it knows nor a directory
  // and starts scanning the repository instead.
  const flags = args.slice(0, endOfFlags(args));
  if (args.length === 0 || flags.some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (flags.some((a) => a === "--version" || a === "-v")) {
    process.stdout.write(`${installedVersion() ?? "unknown"}\n`);
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
  if (command === "ask") {
    return await runAsk(args.slice(1));
  }
  if (command === "contract") {
    return await runContract(args.slice(1));
  }
  if (command === "corroborate") {
    return await runCorroborate(args.slice(1));
  }
  if (command === "infer") {
    return await runInfer(args.slice(1));
  }
  process.stderr.write(
    `There is no "${command}" command. suss has init, extract, inspect, check, ask, contract, corroborate, and infer.\n`,
  );
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

/** Where `--` ends the flags, or the end of the arguments. */
function endOfFlags(args: string[]): number {
  const separator = args.indexOf("--");
  return separator === -1 ? args.length : separator;
}

/**
 * `--fail-on-empty` used to be the opt-in. A run that finds nothing now
 * fails by default, so the flag is refused with what changed rather
 * than silently ignored.
 */
function refuseFailOnEmpty(): never {
  throw new UsageError(
    "--fail-on-empty is gone. A run that finds nothing now fails by default; pass --allow-empty to opt back into exiting 0.",
  );
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
      "allow-empty": { type: "boolean" },
      "fail-on-empty": { type: "boolean" },
      "fail-on-pack-error": { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values["fail-on-empty"] === true) {
    refuseFailOnEmpty();
  }

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
    ...(values["allow-empty"] === true ? { allowEmpty: true } : {}),
    ...(values["fail-on-pack-error"] === true ? { failOnPackError: true } : {}),
  };

  // extract() reports failure by setting process.exitCode, so each run
  // has to clear it first rather than read a stale failure a previous
  // run in this process left behind.
  process.exitCode = undefined;
  await extract(options);

  return process.exitCode === 1 ? 1 : 0;
}

/** What plain `inspect` takes. `--flow` is handled before this. */
const INSPECT_FLAGS = new Set(["--dir", "--diff", "--flow", "--json"]);

/**
 * A flag inspect does not take, said rather than dropped. `--json` is
 * the one people try, so it gets pointed somewhere: the summaries file
 * is already JSON, and ask gives an answer in JSON.
 */
function inspectFlagMessage(flag: string): string {
  const where =
    flag === "--json"
      ? "inspect prints for people. The summaries file it reads is already JSON, suss ask --json gives an answer in JSON, and suss inspect --diff and --flow both take --json.\n"
      : "";
  return `inspect does not take ${flag}. It takes --dir, --diff, --types, and --flow.\n${where}`;
}

async function runInspect(argv: string[]): Promise<number> {
  if (argv.includes("--flow")) {
    return await runFlow(argv);
  }

  const types = argv.includes("--types");
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--types" && a !== "--json");
  // `--diff` is the one form that takes it. Everything else inspect
  // does reads a file that is already JSON, so the flag is refused
  // here rather than in each branch, where --dir used to drop it.
  if (json && args[0] !== "--diff") {
    process.stderr.write(inspectFlagMessage("--json"));
    return 1;
  }
  const unknown = args.find((a) => a.startsWith("--") && !INSPECT_FLAGS.has(a));
  if (unknown !== undefined) {
    process.stderr.write(inspectFlagMessage(unknown));
    return 1;
  }
  if (args[0] === "--diff") {
    const before = args[1];
    const after = args[2];
    if (before === undefined || after === undefined) {
      process.stderr.write(
        "--diff compares two summary files. Try: suss inspect --diff before.json after.json\n",
      );
      return 1;
    }
    inspectDiff({ before, after, ...(json ? { json } : {}) });
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
      at: { type: "string" },
      intent: { type: "string" },
      all: { type: "boolean" },
      "fail-on": { type: "string" },
      "allow-empty": { type: "boolean" },
      "fail-on-empty": { type: "boolean" },
      "fail-on-unpaired": { type: "string" },
      "fail-on-unreadable": { type: "boolean" },
      sussignore: { type: "string" },
      "no-suppressions": { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values["fail-on-empty"] === true) {
    refuseFailOnEmpty();
  }

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

  // --at is already scoped to one thing, so it prints in full and has
  // nothing to collapse.
  const all = values.all === true ? { all: true } : {};

  const shared = {
    ...(values.json === true ? { json: true } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(failOn !== undefined ? { failOn } : {}),
    ...(values.sussignore !== undefined
      ? { sussignore: values.sussignore }
      : {}),
    ...(values["no-suppressions"] === true ? { noSuppressions: true } : {}),
    ...(values["allow-empty"] === true ? { allowEmpty: true } : {}),
    ...(values["fail-on-unpaired"] !== undefined
      ? { failOnUnpaired: values["fail-on-unpaired"] }
      : {}),
    ...(values["fail-on-unreadable"] === true
      ? { failOnUnreadable: true }
      : {}),
  };

  if (values.at !== undefined && values.dir === undefined) {
    process.stderr.write(
      "--at narrows a run over a folder of summaries, so it needs --dir too. Try: suss check --dir summaries/ --at src/editions/dao.ts:43\n",
    );
    return 1;
  }

  if (values.at !== undefined && values.intent !== undefined) {
    process.stderr.write(
      "--at reports on one thing and --intent scores every boundary intent against the code, so they cannot run together. Run them one at a time.\n",
    );
    return 1;
  }

  if (values.dir !== undefined && values.at !== undefined) {
    const scoped = checkAt({ dir: values.dir, at: values.at, ...shared });
    return scoped.hasErrors ? 1 : 0;
  }

  if (values.dir !== undefined) {
    const result = checkDir({
      dir: values.dir,
      ...shared,
      ...all,
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

  // Two-file check compares every provider against every consumer
  // without building pairs, so it has no empty count to opt out of.
  if (values["allow-empty"] === true) {
    process.stderr.write(
      "--allow-empty needs --dir. Comparing two files checks every provider against every consumer without pairing them, so there is no count of what paired.\n",
    );
    return 1;
  }
  const result = check({
    providerFile: positionals[0],
    consumerFile: positionals[1],
    ...shared,
    ...all,
  });
  return result.hasErrors ? 1 : 0;
}

async function runAsk(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      project: { type: "string" },
      json: { type: "boolean" },
      all: { type: "boolean" },
      output: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });

  // The question comes first, and a summaries file may follow it, the
  // same way `inspect` takes one. No question gets the same treatment
  // as one that matched nothing: the ten it does answer, printed back.
  const question = positionals[0];
  if (question === undefined) {
    return ask({
      question: "",
      ...(values.json === true ? { json: true } : {}),
      ...(values.output !== undefined ? { output: values.output } : {}),
    });
  }

  await preloadForQuestion(question);

  const file = positionals[1];
  return ask({
    question,
    ...(values.dir !== undefined ? { dir: values.dir } : {}),
    ...(values.project !== undefined ? { project: values.project } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(values.json === true ? { json: true } : {}),
    ...(values.all === true ? { all: true } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
  });
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
    "terraform",
    "serverless",
    "storybook",
    "appsync",
    "prisma",
    "graphql",
    "graphql-documents",
    "wrangler",
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

async function runInfer(args: string[]): Promise<number> {
  const sub = args[0];
  const kind = sub === undefined ? undefined : INFER_KINDS[sub];
  if (kind === undefined) {
    process.stderr.write(
      sub === undefined
        ? "infer needs the artifact to draft. Try: suss infer stub <package>\n"
        : `There is no "infer ${sub}". infer has stub, intent and prd.\n`,
    );
    return 1;
  }

  return await kind(args.slice(1));
}

const INFER_KINDS: Record<
  string,
  (args: string[]) => number | Promise<number>
> = {
  stub: runInferStub,
  intent: runInferIntent,
  prd: runInferPrd,
};

async function runInferStub(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      dir: { type: "string" },
      output: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });

  const packageName = positionals[0];
  if (packageName === undefined) {
    process.stderr.write(
      "infer stub needs the package to draft for. Try: suss infer stub @acme/kit\n",
    );
    return 1;
  }

  return await stubDraft({
    package: packageName,
    ...(values.project !== undefined ? { tsconfig: values.project } : {}),
    ...(values.dir !== undefined ? { dir: values.dir } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
  });
}

function runInferIntent(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      out: { type: "string", short: "o" },
      into: { type: "string" },
    },
  });

  if (values.from === undefined) {
    process.stderr.write(
      "infer intent needs --from, the summaries to read. Try: suss infer intent --from summaries.json --out intent/\n",
    );
    return 1;
  }

  return intentDraft({
    from: values.from,
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.into !== undefined ? { into: values.into } : {}),
  });
}

function runInferPrd(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      out: { type: "string", short: "o" },
      into: { type: "string" },
    },
  });

  if (values.from === undefined) {
    process.stderr.write(
      "infer prd needs --from, the curated boundary intent to read. Try: suss infer prd --from intent/\n",
    );
    return 1;
  }

  return prdDraft({
    from: values.from,
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.into !== undefined ? { into: values.into } : {}),
  });
}
