/**
 * The trace oracle's command line. Record the spans a test run produces,
 * then compare them with suss's summaries of the same code:
 *
 *   npx tsx tools/trace-oracle/src/cli.ts record --out spans.jsonl <command...>
 *   npx tsx tools/trace-oracle/src/cli.ts report --app <name> --spans spans.jsonl \
 *     --summaries <dir> --source <dir> [--resource key=text] [--entry regex] \
 *     [--json report.json] [--markdown report.md]
 *
 * `record` takes its own options first, and the command starts at the
 * first argument that is not one of them. The command loads its
 * language's OpenTelemetry instrumentation itself; the README shows how
 * for Node, Python and Ruby.
 */

import fs from "node:fs";
import { parseArgs } from "node:util";

import { record } from "./record.js";
import { buildReport, renderMarkdown, renderSummary } from "./report.js";
import { readSpanFile } from "./spans.js";

const USAGE = `trace-oracle record --out <file> [--drain <ms>] <command...>
trace-oracle report --app <name> --spans <file>... --summaries <dir> --source <dir>
                    [--resource key=text] [--entry regex] [--json <file>] [--markdown <file>]`;

const RECORD_OPTIONS = new Set(["--out", "--drain"]);

async function runRecord(args: string[]): Promise<number> {
  const values: Record<string, string> = {};
  let at = 0;
  while (at < args.length && RECORD_OPTIONS.has(args[at] ?? "")) {
    values[(args[at] ?? "").slice(2)] = args[at + 1] ?? "";
    at += 2;
  }
  const out = values.out;
  const command = args.slice(at);
  if (out === undefined || out === "" || command.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const result = await record({
    out,
    command,
    ...(values.drain === undefined ? {} : { drainMs: Number(values.drain) }),
  });
  console.error(
    `trace-oracle: ${result.spans} spans in ${result.requests} exports written to ${out}; the command exited ${result.exitCode}`,
  );
  return result.exitCode;
}

function runReport(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      app: { type: "string" },
      spans: { type: "string", multiple: true },
      summaries: { type: "string" },
      source: { type: "string" },
      resource: { type: "string", multiple: true },
      entry: { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
    },
  });
  if (
    values.app === undefined ||
    values.spans === undefined ||
    values.summaries === undefined ||
    values.source === undefined
  ) {
    console.error(USAGE);
    return 2;
  }
  const spans = values.spans.flatMap((file) => readSpanFile(file));
  const report = buildReport({
    app: values.app,
    spans,
    summariesDir: values.summaries,
    sourceDir: values.source,
    resourceFilters: (values.resource ?? []).map(parseResourceFilter),
    ...(values.entry === undefined
      ? {}
      : { entryPattern: new RegExp(values.entry) }),
  });
  if (values.json !== undefined) {
    fs.writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (values.markdown !== undefined) {
    fs.writeFileSync(values.markdown, renderMarkdown(report));
  }
  console.log(renderSummary(report));
  return 0;
}

function parseResourceFilter(raw: string): { key: string; text: string } {
  const at = raw.indexOf("=");
  if (at <= 0) {
    throw new Error(`--resource takes key=text, got ${raw}`);
  }
  return { key: raw.slice(0, at), text: raw.slice(at + 1) };
}

const COMMANDS: Record<string, (args: string[]) => number | Promise<number>> = {
  record: runRecord,
  report: runReport,
};

const [command, ...rest] = process.argv.slice(2);
const run = command === undefined ? undefined : COMMANDS[command];
if (run === undefined) {
  console.error(USAGE);
  process.exit(2);
}
process.exitCode = await run(rest);
