// flow.ts: `suss inspect --flow` command implementation.
//
// Answers "who serves this request" at the terminal: the entry the
// request came in by, every hop it took with the rule that admitted
// that hop, the unit it landed in, and the handler inside that unit.
//
// Two things this rendering will not do. It will not print a possible
// answer as though it were settled: a chain gated on a condition nobody
// here evaluates says so on the hop that is gated, in the heading above
// it, and on the line that names what serves the request, which is the
// line somebody pastes into a ticket. And it will not report an absence
// it did not find: when nothing serves the request it says where the
// walk stopped and why, whether that is a declared response, the rules
// that refused, or a rule that took the request and sent it somewhere
// nothing here could follow.

import fs from "node:fs";
import path from "node:path";

import { dispatchByType, displayLabel, summaryRef } from "@suss/behavioral-ir";
import { analyzeFlow } from "@suss/checker";

import { parseSummaryFile, readSummariesFromDir } from "./inspect.js";
import { writeJson } from "./jsonStream.js";

import type {
  BehavioralSummary,
  DispatchTable,
  FlowRequest,
  RouterMatchSelector,
  RoutingMatchCondition,
  RoutingMatchRecord,
} from "@suss/behavioral-ir";
import type {
  FlowAnalysis,
  FlowCertainty,
  FlowChain,
  FlowChainsOmitted,
  FlowEnd,
  FlowEntry,
  FlowHop,
  UnfollowedEdge,
} from "@suss/checker";

export interface FlowOptions {
  /** The request as somebody would say it: "GET https://shop.example.com/api/orders/123". */
  request: string;
  file?: string;
  dir?: string;
  /** Which node to start from, when the summaries hold more than one. */
  entry?: string;
  /** Which document's node, when two documents declare that name. */
  scope?: string;
  json?: boolean;
}

/**
 * The condition languages this run can settle, one per manifest reader
 * that emits routing edges. A reader owns the glob rules and the
 * ordering of the language it stamps, so both the selector and the
 * name it answers to come from the reader; assembling the table is all
 * that happens here.
 */
async function routerSelectors(): Promise<Record<string, RouterMatchSelector>> {
  const cloudformation = await import("@suss/contract-cloudformation");
  return {
    [cloudformation.ALB_MATCH_LANGUAGE]: cloudformation.albRouterSelector,
  };
}

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

const SAY_IT_LIKE_THIS =
  'Write the request as a method and a URL, for example: suss inspect --flow "GET https://shop.example.com/api/orders/123"';

type ParsedRequest =
  | { ok: true; request: FlowRequest }
  | { ok: false; message: string };

/** A URL's host and path, or null when the text is neither a URL nor a path. */
function targetOf(raw: string): { host: string | null; path: string } | null {
  if (raw.startsWith("/")) {
    return { host: null, path: raw };
  }

  try {
    const url = new URL(raw);
    return { host: url.hostname, path: url.pathname };
  } catch {
    return null;
  }
}

/**
 * The request a person typed: a method and a URL, or a method and a
 * path when the question names no host. A host-header rule cannot be
 * settled without a host, and the rendering says so rather than
 * guessing one.
 */
export function parseFlowRequest(raw: string): ParsedRequest {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length !== 2) {
    return { ok: false, message: SAY_IT_LIKE_THIS };
  }

  const target = targetOf(words[1]);
  if (target === null || !/^[A-Za-z]+$/.test(words[0])) {
    return { ok: false, message: SAY_IT_LIKE_THIS };
  }

  return {
    ok: true,
    request: {
      method: words[0].toUpperCase(),
      host: target.host,
      path: target.path,
    },
  };
}

function requestLine(request: FlowRequest): string {
  return request.host === null
    ? `${request.method} ${request.path}`
    : `${request.method} https://${request.host}${request.path}`;
}

// ---------------------------------------------------------------------------
// Where to start
// ---------------------------------------------------------------------------

type ChosenEntry =
  | { ok: true; entry: FlowEntry }
  | { ok: false; message: string };

function listEntries(entries: FlowEntry[]): string {
  return entries
    .map((entry) => `  ${entry.name}   (${entry.scope})`)
    .join("\n");
}

/** The entry the caller named, checked against the documents that declare it. */
function namedEntry(
  analysis: FlowAnalysis,
  name: string,
  scope: string | undefined,
): ChosenEntry {
  const scopes = analysis.scopesOf(name);
  if (scopes.length === 0) {
    const known = analysis.entries();
    const suggestion =
      known.length === 0
        ? ""
        : `\nThese summaries can be asked about:\n${listEntries(known)}`;
    return {
      ok: false,
      message: `Nothing in these summaries is called "${name}".${suggestion}`,
    };
  }

  if (scope !== undefined) {
    if (!scopes.includes(scope)) {
      return {
        ok: false,
        message: `No document called "${scope}" declares "${name}". These do:\n${scopes.map((s) => `  ${s}`).join("\n")}`,
      };
    }

    return { ok: true, entry: { name, scope } };
  }

  if (scopes.length > 1) {
    return {
      ok: false,
      message: `${scopes.length} documents declare "${name}", and neither one's rules may answer the other's question:\n${scopes
        .map((s) => `  ${s}`)
        .join(
          "\n",
        )}\nSay which one with --scope, for example: --entry ${name} --scope ${scopes[0]}`,
    };
  }

  return { ok: true, entry: { name, scope: scopes[0] } };
}

/** Where the request comes in: what the caller named, or the one way in the summaries hold. */
function chooseEntry(
  analysis: FlowAnalysis,
  options: FlowOptions,
): ChosenEntry {
  if (options.entry !== undefined) {
    return namedEntry(analysis, options.entry, options.scope);
  }

  const entries = analysis.entries();
  if (entries.length === 0) {
    return {
      ok: false,
      message:
        "These summaries declare no routing edges, so there is no flow to walk. Read a deploy template first, for example: suss contract --from cloudformation template.yaml -o summaries/infra.json",
    };
  }

  if (entries.length > 1) {
    return {
      ok: false,
      message: `${entries.length} ways in, so say which one with --entry:\n${listEntries(entries)}`,
    };
  }

  return { ok: true, entry: entries[0] };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** How a condition reads: the field, what it compares against, and whether anyone settled it. */
function conditionText(condition: RoutingMatchCondition): string {
  const field = condition.field ?? "a condition with no field";
  const values = condition.values.join(", ");
  const stated = values === "" ? field : `${field} ${values}`;
  return condition.evaluated ? stated : `${stated} (not evaluated here)`;
}

function matchText(match: RoutingMatchRecord): string {
  const parts = [
    ...(match.priority !== undefined ? [`priority ${match.priority}`] : []),
    ...match.conditions.map(conditionText),
  ];
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

const HOP_REASONS: Record<FlowHop["edge"], (hop: FlowHop) => string> = {
  routesTo: (hop) => {
    if (hop.match === undefined) {
      return hop.certainty === "certain"
        ? "forwarded here"
        : "may forward here";
    }

    const takes = hop.certainty === "certain" ? "takes it" : "may take it";
    return `${hop.match.matchId} ${takes}${matchText(hop.match)}`;
  },
  fronts: (hop) => `${hop.from} fronts it`,
  belongsTo: (hop) => `${hop.to} belongs to ${hop.from}`,
};

function hopLine(hop: FlowHop): string {
  return `    -> ${hop.to}   ${HOP_REASONS[hop.edge](hop)}`;
}

/** A response as it reads: the status, the type, and the body a client gets. */
function responseText(
  end: Extract<FlowEnd, { type: "answers" }>,
  certainty: FlowCertainty,
): string {
  const answers = certainty === "certain" ? "answers" : "may answer";
  const response = end.answer.response;
  if (response === undefined) {
    return `${end.router} ${answers} it itself`;
  }

  const parts = [
    ...(response.statusCode !== undefined ? [`${response.statusCode}`] : []),
    ...(response.contentType !== undefined ? [response.contentType] : []),
    ...(response.body !== undefined ? [JSON.stringify(response.body)] : []),
  ];
  const said =
    parts.length === 0 ? (response.type ?? "no response") : parts.join(" ");
  return `${end.router} ${answers} it itself: ${said}`;
}

function refusedLines(matches: RoutingMatchRecord[]): string {
  return matches
    .map((match) => `      ${match.matchId}${matchText(match)}`)
    .join("\n");
}

/**
 * Where a reference went, and why nobody could follow it. A reader that
 * names the node itself as the reference (a target group nothing
 * registers behind) has already said which node this is, so the line
 * does not repeat it.
 */
function unfollowedLines(node: string, edges: UnfollowedEdge[]): string {
  return edges
    .map((edge) => {
      const who = edge.matchId === null ? "the wiring" : edge.matchId;
      const to =
        edge.reference === null || edge.reference === node
          ? ""
          : ` to ${edge.reference}`;
      const why =
        edge.reason === null ? "nothing here answers to it" : edge.reason;
      return `      ${who} sends it on${to}: ${why}`;
    })
    .join("\n");
}

/** A serving claim, named the way a person reads code: the handler, what it serves, and where it is written. */
function claimLine(
  ref: string,
  certainty: FlowCertainty,
  byRef: Map<string, BehavioralSummary>,
): string {
  const answers = certainty === "certain" ? "answers it" : "may answer it";
  const summary = byRef.get(ref);
  if (summary === undefined) {
    return `    ${ref} ${answers}`;
  }

  const binding = summary.identity.boundaryBinding;
  const serves = binding === null ? "" : `: ${displayLabel(binding)}`;
  return `    ${summary.identity.name} ${answers}${serves}   (${summary.location.file})`;
}

interface FlowRenderContext {
  request: FlowRequest;
  byRef: Map<string, BehavioralSummary>;
}

interface EndContext extends FlowRenderContext {
  /**
   * The certainty of the chain this ending closes, which is what every
   * line of it has to read as. A hop nobody could settle leaves the
   * whole chain unsettled, and a terminal line saying a handler answers
   * the request is the line somebody pastes into a ticket.
   */
  certainty: FlowCertainty;
}

function renderEnd(end: FlowEnd, context: EndContext): string {
  const settled = context.certainty === "certain";
  const renderers: DispatchTable<FlowEnd, string> = {
    serves: (served) =>
      [
        `  ${served.unit} ${settled ? "serves it" : "may serve it"}`,
        ...served.claims.map((claim) =>
          claimLine(claim.ref, context.certainty, context.byRef),
        ),
      ].join("\n"),
    answers: (answered) => `  ${responseText(answered, context.certainty)}`,
    unserved: (unserved) =>
      `  ${unserved.unit} ${settled ? "takes it" : "may take it"}, and nothing suss can read inside it answers ${context.request.method} ${context.request.path}`,
    unfollowed: (lost) =>
      [
        `  ${lost.node} ${settled ? "sends it on" : "may send it on"}, and suss cannot follow where:`,
        unfollowedLines(lost.node, lost.edges),
      ].join("\n"),
    stops: (stopped) => {
      const reached = settled
        ? `Nothing below ${stopped.node} takes it`
        : `If the request gets to ${stopped.node}, nothing below it takes it`;
      if (stopped.refused.length === 0) {
        return `  ${reached}: nothing below it is declared`;
      }

      return [
        `  ${reached}. What is declared there:`,
        refusedLines(stopped.refused),
      ].join("\n");
    },
    loops: (looped) => `  The wiring loops back to ${looped.node}`,
  };
  return dispatchByType(renderers, end);
}

function renderChain(chain: FlowChain, context: FlowRenderContext): string {
  return [
    `  ${chain.entry}`,
    ...chain.hops.map(hopLine),
    renderEnd(chain.end, { ...context, certainty: chain.certainty }),
  ].join("\n");
}

/**
 * What to call a group of chains. A group nothing serves says so
 * first, and a group whose hops are unsettled never claims to have
 * settled anything.
 */
function heading(certainty: FlowCertainty, chains: FlowChain[]): string {
  const openEnded =
    certainty === "possible"
      ? ", once something the declarations leave open is decided at run time"
      : ", as the declarations settle it";
  if (chains.some((chain) => chain.end.type === "serves")) {
    return `What serves it${openEnded}:`;
  }

  if (chains.some((chain) => chain.end.type === "answers")) {
    return `Nothing serves it. What answers it instead${openEnded}:`;
  }

  if (chains.some((chain) => chain.end.type === "unfollowed")) {
    return "Nothing suss can name serves it. Where the trail ends:";
  }

  return `Nothing serves it. Where the request stops${openEnded}:`;
}

/**
 * What was left out, when the walk found more chains than an answer
 * keeps. The count is a floor once the walk stopped enumerating, and it
 * says so, because a wrong number reads worse than a bounded one.
 */
function omittedLine(omitted: FlowChainsOmitted): string {
  const count = omitted.exact
    ? `${omitted.count}`
    : `more than ${omitted.count}`;
  const chains = omitted.count === 1 && omitted.exact ? "chain" : "chains";
  return `and ${count} more ${chains} not shown; ask about a node further in with --entry to see them.`;
}

function renderFlow(
  request: FlowRequest,
  entry: FlowEntry,
  view: { chains: FlowChain[]; omitted: FlowChainsOmitted },
  byRef: Map<string, BehavioralSummary>,
): string {
  const context: FlowRenderContext = { request, byRef };
  const lines = [
    requestLine(request),
    `in by ${entry.name}, declared in ${entry.scope}`,
  ];
  if (view.chains.length === 0) {
    lines.push(
      "",
      `Nothing serves it: ${entry.name} hands ${request.method} ${request.path} to nothing at all.`,
    );
    return `${lines.join("\n")}\n`;
  }

  for (const certainty of ["certain", "possible"] as FlowCertainty[]) {
    const group = view.chains.filter((chain) => chain.certainty === certainty);
    if (group.length === 0) {
      continue;
    }

    lines.push("", heading(certainty, group));
    for (const chain of group) {
      lines.push("", renderChain(chain, context));
    }
  }

  if (view.omitted.count > 0) {
    lines.push("", omittedLine(view.omitted));
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** The summaries to walk, read the way the rest of inspect reads them. */
function readSummaries(options: FlowOptions): BehavioralSummary[] | null {
  if (options.dir !== undefined) {
    return readSummariesFromDir(options.dir);
  }

  if (options.file === undefined) {
    return null;
  }

  const file = path.resolve(options.file);
  return parseSummaryFile(file, fs.readFileSync(file, "utf-8"));
}

/**
 * Ask who serves one request. Returns the exit code: a request nothing
 * serves is an answer, not a failure, so only a question suss could
 * not read exits non-zero.
 */
export async function inspectFlow(options: FlowOptions): Promise<number> {
  const parsed = parseFlowRequest(options.request);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    return 1;
  }

  const summaries = readSummaries(options);
  if (summaries === null) {
    process.stderr.write(
      '--flow reads summaries the way the rest of inspect does. Pass a file or a folder: suss inspect --flow "GET /api/orders/1" summaries/infra.json\n',
    );
    return 1;
  }

  const analysis = analyzeFlow(
    summaries,
    parsed.request,
    await routerSelectors(),
  );
  const chosen = chooseEntry(analysis, options);
  if (!chosen.ok) {
    process.stderr.write(`${chosen.message}\n`);
    return 1;
  }

  const view = analysis.from(chosen.entry.name, chosen.entry.scope);
  if (options.json === true) {
    await writeJson({
      value: {
        request: parsed.request,
        entry: chosen.entry,
        chains: view.chains,
        omitted: view.omitted,
      },
      indent: 2,
    });
    return 0;
  }

  const byRef = new Map(
    summaries.map((summary) => [summaryRef(summary), summary]),
  );
  process.stdout.write(renderFlow(parsed.request, chosen.entry, view, byRef));
  return 0;
}
