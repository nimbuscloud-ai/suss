/**
 * tools.ts: what the model can call, and what each one says back.
 *
 * The descriptions matter as much as the code. A model reads them at
 * the moment it decides whether to call something, so this is where the
 * question grammar and the "what does this finding mean" guidance go.
 * A document at the top of a session gets forgotten; a tool description
 * arrives with the decision.
 *
 * Every tool reads. None of them change a file.
 */

import { answerQuestion, checkAt, checkDir } from "@suss/cli";

import { omissionNote, SHOWN, trim } from "./budget.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Project } from "./project.js";

/** What a tool hands back, in the shape the protocol states. */
export type ToolResult = CallToolResult;

export const ASK_DESCRIPTION = `Ask one question about one boundary in this codebase and get an answer worked out from static analysis of the current code.

Reach for this before changing something other code depends on: a route, a database table, a queue, an environment variable. It answers from summaries the server keeps current as files change, so the answer describes the code as it is right now.

The question must be one of these seven, in these words:
  what can I project from <boundary>   what the boundary declares: the fields a store serves, the statuses a route returns, the env vars a runtime takes. Also written "what does <boundary> declare".
  what reads <boundary>                every unit that reads it, with the file, the line, and the call.
  what writes <boundary>               the same, for writes.
  what calls <unit>                    every unit whose calls resolve to this one.
  what does <unit> reach               every boundary a file or a summary goes through, and whether it reads or writes each.
  why does <unit> reach <boundary>     the call chain, with each hop proved from source.
  why does <name> at <file>:<line> resolve to <target>   the chain from a written name to the function it comes down to.

A boundary is spelled the way reports spell it: "GET /users/:id", "aws.dynamodb:orders", "postgres:public.users". A unit is a file, a file:line, a summary id, or a function name.

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

export const STATUS_DESCRIPTION = `What this server is answering from: which extract and contract commands ran, which failed, and whether the project has a suss.json at all.

Reach for this when an answer looks thinner than the code suggests it should be. A project with no suss.json has nothing configured, and a contract that failed to read means one side of every boundary it declares is missing from every answer.`;

export async function askTool(
  project: Project,
  args: { question: string },
): Promise<ToolResult> {
  await project.settled();
  const { answer } = answerQuestion({
    question: args.question,
    dir: project.summaryDir,
    project: project.root,
    json: true,
    output: NOWHERE,
  });
  if (answer === null) {
    return failure(
      `"${args.question}" is not one of the seven questions. The tool description lists them.`,
    );
  }
  const trimmed = trim(answer.items, () => "item");
  const payload = {
    ...answer,
    items: trimmed.shown,
    ...(trimmed.omitted > 0
      ? {
          omitted: trimmed.omitted,
          note: `${trimmed.omitted} more are not shown. Ask about one of the results above to narrow it.`,
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
    failOnEmpty: true,
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

export function statusTool(project: Project): ToolResult {
  const report = project.lastBuild();
  const text = report.configured
    ? [
        `Answering from ${report.summaryDir}, rebuilt when a source file changes.`,
        ...report.ran.map((one) => `  ran: ${one}`),
        ...report.failed.map((one) => `  failed: ${one}`),
      ].join("\n")
    : `${project.root} has no suss.json, so nothing was extracted and every answer will be empty. Run \`suss init\` in that directory.`;
  return {
    content: [{ type: "text", text }],
    structuredContent: report as unknown as Record<string, unknown>,
  };
}

/**
 * One answer, in both forms the protocol asks for.
 *
 * A result with structured data should carry the same thing as text,
 * so a host that reads only one of the two still gets the answer. That
 * means every byte counts twice, which is why the callers trim before
 * they get here rather than after.
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
