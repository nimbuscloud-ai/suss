/**
 * The tools a model can call, and what each one returns.
 *
 * The descriptions matter as much as the code. A model reads a tool's
 * description each time it decides whether to call the tool, so the
 * question grammar and the guidance on reading findings go there, and
 * not into a document the model saw once at the start of a session.
 *
 * Every tool only reads. None of them changes a file.
 */

import fs from "node:fs";
import path from "node:path";

import {
  answerQuestion,
  checkAt,
  checkDir,
  intentOutcomes,
  preloadForQuestion,
  stubDraftResult,
  whereReadsCameFrom,
} from "@suss/cli";

import { omissionNote, SHOWN, trim } from "./budget.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BuildReport, Project } from "./project.js";

/** What a tool hands back, in the shape the protocol states. */
export type ToolResult = CallToolResult;

export const ASK_DESCRIPTION = `Ask one question about one boundary in this codebase and get an answer worked out from static analysis of the current code.

Reach for this before changing something other code depends on: a route, a database table, a queue, an environment variable. It answers from summaries the server keeps current as files change, so the answer describes the code as it is right now.

The question must be one of these ten, in these words:
  what can I project from <boundary>   what the boundary declares: the fields a store serves, the statuses a route returns, the env vars a runtime takes. Also written "what does <boundary> declare".
  what reads <boundary>                every unit that reads it, with the file, the line, and the call.
  what writes <boundary>               the same, for writes.
  what invokes <boundary>              the same, for invocations of a function or a queue.
  what calls <unit>                    every unit whose calls resolve to this one.
  what does <unit> reach               every boundary a file or a summary goes through, and whether it reads or writes each.
  what reaches <target>                every boundary whose unit ends up going through the target, however many calls away, with the calls it took. Pass a large limit to see all of them.
  what does <package or unit> provide  every boundary it provides, one per line. A package is spelled by its name, "@suss/checker". Also written "what does <package> export".
  why does <unit> reach <boundary>     the call chain, with each hop proved from source.
  why does <name> at <file>:<line> resolve to <target>   the chain from a written name to the function it comes down to.

A boundary is spelled the way reports spell it: "GET /users/:id", "aws.dynamodb:orders", "postgres:public.users". A unit is a file, a file:line, a summary id, or a function name.

When an item is about a unit that itself provides a boundary, such as an exported function or a route, it says so in a "provides" field, whether or not the unit's own id happens to say the same thing.

Read "found" first. When it is false, "needs" says which input would let suss answer, and that is usually the thing to act on rather than concluding nothing is there. An empty "items" with found true means suss looked and there genuinely is nothing.`;

export const CHECK_DESCRIPTION = `Compare both sides of every boundary in this codebase and report where they disagree: a caller reading a field the provider never returns, a status nothing handles, a queue nobody consumes.

Reach for this after writing code that crosses a boundary, before opening a pull request.

Three lists come back and they mean different things.
  findings  two sides of a boundary disagree.
  intent    the code and a document the team wrote disagree. Only present when the project has intent docs.
  run       the run could not get far enough to compare anything. A "nothingPaired" entry here means no boundary had both sides in this project, so an empty "findings" proves nothing.

Severity says how the run would exit, not what to do. Read the finding's own text before acting, because several kinds have no universal fix. "unhandledProviderCase" fires when a provider can return something no consumer handles, and whether to change the consumer, change the provider, or leave it depends on whether that branch is reachable in this deployment, which suss cannot see. "boundaryFieldUnknown" at warning usually means the contract is behind the code rather than the code being wrong.

Pass a boundary to narrow to one thing when a whole-project report is too much.`;

export const INSPECT_DESCRIPTION = `List the boundaries in this codebase, split into the ones with both sides and the ones with only one.

Reach for this to get oriented in an unfamiliar project, or when suss_check reports no findings and you want to know whether that means the two sides agreed or means nothing was compared.

  paired        both sides are here, and suss_check compared them.
  providerOnly  something serves it and nothing suss can see calls it. Often correct: a public API's callers are in somebody else's repository.
  consumerOnly  something calls it and suss cannot see what serves it. Often another service, and sometimes the two sides spelling one boundary differently, which is worth checking before assuming the first.

Each list shows the first few; counts has the totals.

To read what one boundary does, use suss_ask with "what can I project from <boundary>".`;

export const STATUS_DESCRIPTION = `What this server is answering from: which extract and contract commands ran, which failed, and whether a suss.json chose them or suss picked them the way \`suss init\` would.

Reach for this when an answer looks thinner than the code suggests it should be. A project nothing matched has nothing extracted, and a contract that failed to read means one side of every boundary it declares is missing from every answer.`;

export async function askTool(
  project: Project,
  args: { question: string; limit?: number | undefined },
): Promise<ToolResult> {
  await project.settled();
  const whyPacks = await preloadForQuestion(args.question, project.root);
  const { answer } = answerQuestion({
    question: args.question,
    loaded: project.summaries(),
    project: project.root,
    ...(whyPacks !== undefined ? { whyPacks } : {}),
    json: true,
    output: NOWHERE,
  });
  if (answer === null) {
    return failure(
      `"${args.question}" is not one of the ten questions. The tool description lists them.`,
    );
  }
  const trimmed = trim(answer.items, () => "item", args.limit ?? SHOWN);
  const payload = {
    ...answer,
    items: trimmed.shown,
    ...(trimmed.omitted > 0
      ? {
          omitted: trimmed.omitted,
          note: `${trimmed.omitted} more are not shown. Pass a larger limit to see more.`,
        }
      : {}),
  };
  return said(payload);
}

export async function checkTool(
  project: Project,
  args: { boundary?: string },
): Promise<ToolResult> {
  await project.settled();
  const payload =
    args.boundary === undefined
      ? wholeProject(project.summaryDir)
      : oneBoundary(project.summaryDir, args.boundary);
  return said(payload);
}

function wholeProject(dir: string): Record<string, unknown> {
  const result = checkDir({
    dir,
    json: true,
    output: NOWHERE,
  });
  const trimmed = trim(result.findings, (one) => one.kind);
  return {
    findings: trimmed.shown,
    findingCounts: trimmed.byKind,
    total: result.findings.length,
    ...(trimmed.omitted > 0
      ? {
          omitted: trimmed.omitted,
          note: `Showing ${SHOWN} of ${result.findings.length}. findingCounts has every kind and how many of each. Call this again with a boundary to see the rest for one thing.`,
        }
      : {}),
    ...(result.run !== undefined ? { run: result.run } : {}),
    ...(result.intent !== undefined ? { intent: result.intent } : {}),
  };
}

function oneBoundary(dir: string, at: string): Record<string, unknown> {
  const result = checkAt({ dir, at, json: true, output: NOWHERE });
  const trimmed = trim(result.findings, (one) => one.kind);
  return {
    at,
    matched: result.matched,
    findings: trimmed.shown,
    findingCounts: trimmed.byKind,
    ...(trimmed.omitted > 0
      ? {
          note: omissionNote(
            trimmed.omitted,
            "findings",
            "Narrow the boundary further, or read findingCounts for the whole picture.",
          ),
        }
      : {}),
    ...(result.matched
      ? {}
      : {
          note: `Nothing in this project is at "${at}". A shorter spelling covers more: "GET /users" picks out every route under it.`,
        }),
  };
}

export async function inspectTool(project: Project): Promise<ToolResult> {
  await project.settled();
  const result = checkDir({
    dir: project.summaryDir,
    json: true,
    output: NOWHERE,
  });

  const paired = result.result.pairs.map((pair) => pair.key);
  const providerOnly = result.result.unmatched.providers.map(labelOf);
  const consumerOnly = result.result.unmatched.consumers.map(labelOf);

  const payload = {
    paired: paired.slice(0, SHOWN),
    providerOnly: providerOnly.slice(0, SHOWN),
    consumerOnly: consumerOnly.slice(0, SHOWN),
    counts: {
      paired: paired.length,
      providerOnly: providerOnly.length,
      consumerOnly: consumerOnly.length,
    },
    guide:
      "paired means both sides are here and suss_check compared them. providerOnly means nothing suss can see calls it. consumerOnly means it calls something suss cannot see, which is usually another service or a spelling the two sides disagree on.",
    ...(paired.length + providerOnly.length + consumerOnly.length > SHOWN * 3
      ? {
          note: `Each list shows the first ${SHOWN}. counts has the totals. Ask suss_ask "what does <file> reach" for one file rather than reading the whole list.`,
        }
      : {}),
  };
  return said(payload);
}

/** A boundary as a reader spells it, falling back to the unit's name. */
function labelOf(one: { key: string | null; name: string }): string {
  return one.key ?? one.name;
}

const BUILDING_LINE = "Building: the first extract has not finished yet.";
const REBUILDING_LINE =
  "Rebuilding: a source file changed and the extract is running again.";

export function statusTool(project: Project): ToolResult {
  const report = project.lastBuild();
  const building = project.building();
  return {
    content: [{ type: "text", text: statusText(project, report, building) }],
    structuredContent: { ...report, building } as unknown as Record<
      string,
      unknown
    >,
  };
}

/**
 * Until the first build finishes nothing is known about the project, so
 * the status says only that it is building. During a rebuild the last
 * finished build still describes the project, so its report is shown
 * under the rebuilding line.
 */
function statusText(
  project: Project,
  report: BuildReport,
  building: boolean,
): string {
  if (building && !project.hasBuilt()) {
    return BUILDING_LINE;
  }
  const lines = reportLines(project.root, report);
  return building ? [REBUILDING_LINE, ...lines].join("\n") : lines.join("\n");
}

function reportLines(root: string, report: BuildReport): string[] {
  if (report.ran.length + report.failed.length === 0) {
    return [
      `Nothing in ${root} matched a pack, so nothing was extracted and every answer will be empty. Run \`suss init\` in that directory to see what suss looked for.`,
    ];
  }
  return [
    `Answering from ${report.summaryDir}, rebuilt when a source file changes.`,
    ...(report.configured ? [] : [whereReadsCameFrom(root, false)]),
    ...report.ran.map((one) => `  ran: ${one}`),
    ...report.failed.map((one) => `  failed: ${one}`),
  ];
}

/**
 * One answer, in both forms the protocol asks for.
 *
 * A result with structured data should repeat it as text, so a host that
 * reads only one of the two still gets the answer. Every byte is sent
 * twice, so the callers trim before they call this.
 */
function said(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Where a command writes when the caller wants the return value.
 *
 * These commands write their report as a side effect. Handing them a
 * file nobody reads is less fragile than replacing process.stdout for
 * the length of the call, which a server doing several things at once
 * would get wrong.
 */
const NOWHERE = process.platform === "win32" ? "NUL" : "/dev/null";

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Run a tool, and turn anything it throws into an answer.
 *
 * A thrown error becomes a protocol error, which tells the model the
 * call failed and nothing about what to do next. A model that gets
 * "the summaries could not be read, run suss_status" can act; one that
 * gets a stack trace tries the same call again.
 */
export async function attempt(
  what: string,
  run: () => Promise<ToolResult> | ToolResult,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      `${what} failed: ${message}\n\nCall suss_status to see whether this project extracted at all. A project with no suss.json has nothing to read.`,
    );
  }
}

export const STUB_DRAFT_DESCRIPTION = `Draft a dependency stub for a package this project uses but suss cannot read into: a compiled binding, a private wrapper, anything without readable source.

For TypeScript the draft is built from the project's own call sites: one performs-call skeleton per export the code reaches, with the argument shapes observed at each site. For a Python project whose routes go through a wrapper module, it drafts a re-exports skeleton per imported module instead. For Ruby it drafts an extends-base skeleton from every require and every class whose superclass is spelled from the package. The semantic blanks are yours to fill from the package's own source, then save the file where the answer says and re-run extract.`;

export const INTENT_OUTCOMES_DESCRIPTION = `List every outcome the project's boundary intent documents declare, as the \`<intent-name>.<outcome-id>\` a PRD scenario puts in its \`link\`.

Call this before writing or editing a \`link\` in a PRD. The two halves of a link are written inside boundary intent documents, so a link composed from the feature description instead of from this list is a guess, and \`suss_check\` reports a wrong one as \`danglingScenarioLink\`.

Each row says:
  link         what to write in the scenario's \`link\`, verbatim.
  intent       the boundary document's own name, the part before the dot.
  boundary     the boundary that document is about, spelled the way reports spell it: "POST /orders/{id}/archive", "fn:@suss/checker::checkAll".
  outcomeId    the outcome's id, the part after the dot.
  description  how the outcome ends and what it turns on: "responds 404 when reads aws.dynamodb:Orders finds nothing".
  file, line   where the id is written, for reading the document itself.

Pass \`boundary\` to keep only the documents whose boundary contains that text.

An outcome an uncurated draft declares is left out and counted in \`note\` instead. Renaming the outcome ids is the first thing curation does, so a link to one of those breaks as soon as somebody picks the draft up.`;

/** The folder `suss check --intent` reads when the caller gives none. */
const DEFAULT_INTENT_DIR = "intent";

export function intentOutcomesTool(
  project: Project,
  args: { intentDir?: string | undefined; boundary?: string | undefined },
): ToolResult {
  const dir = path.resolve(project.root, args.intentDir ?? DEFAULT_INTENT_DIR);
  if (!fs.existsSync(dir)) {
    return failure(
      `There is no folder at ${dir}. Boundary intent lives in intent/ by default; pass intentDir when this project keeps it somewhere else.`,
    );
  }

  const listing = intentOutcomes({
    from: dir,
    ...(args.boundary !== undefined ? { boundary: args.boundary } : {}),
  });
  const trimmed = trim(listing.outcomes, (row) => row.intent);
  const notes = [
    omissionNote(
      trimmed.omitted,
      "outcomes",
      "countsByIntent has every document and how many each declares. Pass a boundary to narrow to one.",
    ),
    draftNote(listing.drafts.length),
  ].filter((note) => note !== undefined);

  return said({
    intentDir: dir,
    outcomes: trimmed.shown,
    total: listing.outcomes.length,
    countsByIntent: trimmed.byKind,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  });
}

function draftNote(drafts: number): string | undefined {
  if (drafts === 0) {
    return undefined;
  }
  return `Left out ${drafts} outcome${drafts === 1 ? "" : "s"} an uncurated draft declares, since curation renames those ids.`;
}

export async function stubDraftTool(
  project: Project,
  args: { package: string },
): Promise<ToolResult> {
  const result = await stubDraftResult({
    package: args.package,
    dir: project.root,
  });
  if (result === null) {
    return failure(
      `No evidence of ${args.package} found under ${project.root}: no calls, no imports, no requires. A stub drafts from those, so there is nothing to draft. Check the package name against the project's own code.`,
    );
  }
  const text =
    result.drafts.length === 1
      ? `Save this to ${result.drafts[0].target} after filling each blank. ${result.exports} exports, from ${result.sites} observed sites.\n\n${result.drafts[0].yaml}`
      : `Save each of these to its own path after filling the blanks. ${result.exports} imported modules, from ${result.sites} observed sites.\n\n${result.drafts
          .map((draft) => `# ${draft.target}\n${draft.yaml}`)
          .join("\n")}`;
  return { content: [{ type: "text", text }] };
}
