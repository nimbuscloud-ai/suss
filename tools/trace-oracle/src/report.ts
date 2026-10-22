/**
 * Puts the trace, suss's answers and the grep rival side by side.
 *
 * A trace covers only the paths a test exercised, so the report gives
 * recall on those paths and nothing about precision. A boundary suss
 * reaches from an exercised route that no request reached is listed as
 * not exercised, never as wrong.
 */

import { extractEdges } from "./edges.js";
import { grepEdges, SourceTree } from "./grepRival.js";
import { matchEdges, REASON_LABEL } from "./matcher.js";
import { SussSide } from "./sussSide.js";

import type { EdgeKind, SetAside } from "./edges.js";
import type { GrepVerdict } from "./grepRival.js";
import type { EdgeVerdict, MissReason, NotExercised } from "./matcher.js";
import type { Span } from "./spans.js";

export interface ReportOptions {
  app: string;
  spans: readonly Span[];
  summariesDir: string;
  sourceDir: string;
  resourceFilters?: ReadonlyArray<{ key: string; text: string }>;
  entryPattern?: RegExp;
}

export interface Rate {
  traced: number;
  suss: number;
  grep: number;
}

export interface Report {
  app: string;
  spans: number;
  traces: number;
  routes: {
    /** Routes a request came in on. */
    exercised: number;
    /** Of those, routes suss also has. */
    discovered: number;
    /** Routes suss has in the summaries. */
    inSuss: number;
  };
  recall: Rate;
  /** Recall over the edges whose table the request path did not give. */
  recallSettleable: Rate;
  recallByKind: Partial<Record<EdgeKind, Rate>>;
  missesByReason: Partial<Record<MissReason, number>>;
  /** How many found edges needed the model and table name rule. */
  foundByName: number;
  grepLocated: Record<string, number>;
  verdicts: Array<EdgeVerdict & { grep: Omit<GrepVerdict, "edge"> }>;
  notExercised: NotExercised[];
  setAside: SetAside[];
}

const REASON_ORDER: MissReason[] = [
  "routeNotDiscovered",
  "noPack",
  "nameNotSettled",
  "dynamicDispatch",
  "wrapperOrFactory",
  "other",
];

export function buildReport(options: ReportOptions): Report {
  const extraction = extractEdges(options.spans, {
    ...(options.resourceFilters === undefined
      ? {}
      : { resourceFilters: options.resourceFilters }),
    ...(options.entryPattern === undefined
      ? {}
      : { entryPattern: options.entryPattern }),
  });
  const side = new SussSide(options.summariesDir);
  const matched = matchEdges(side, extraction.edges, extraction.routes);
  const grep = grepEdges(
    extraction.edges,
    matched.routesMatched,
    new SourceTree(options.sourceDir),
  );
  const grepByEdge = new Map(grep.map((one) => [one.edge, one]));
  const verdicts = matched.verdicts.map((verdict) => {
    const rival = grepByEdge.get(verdict.edge);
    return {
      ...verdict,
      grep: {
        found: rival?.found ?? false,
        located: rival?.located ?? null,
        files: rival?.files ?? [],
      },
    };
  });

  const rate = (subset: typeof verdicts): Rate => ({
    traced: subset.length,
    suss: subset.filter((one) => one.found).length,
    grep: subset.filter((one) => one.grep.found).length,
  });
  const recallByKind: Partial<Record<EdgeKind, Rate>> = {};
  for (const kind of new Set(verdicts.map((one) => one.kind))) {
    recallByKind[kind] = rate(verdicts.filter((one) => one.kind === kind));
  }
  const missesByReason: Partial<Record<MissReason, number>> = {};
  for (const verdict of verdicts) {
    if (verdict.reason !== undefined) {
      missesByReason[verdict.reason] =
        (missesByReason[verdict.reason] ?? 0) + 1;
    }
  }
  const grepLocated: Record<string, number> = {};
  for (const one of grep) {
    const by = one.located ?? "not located";
    grepLocated[by] = (grepLocated[by] ?? 0) + 1;
  }
  const discovered = [...matched.routesMatched.values()].filter(
    (match) => match.routes.length > 0,
  ).length;
  return {
    app: options.app,
    spans: options.spans.length,
    traces: new Set(options.spans.map((span) => span.traceId)).size,
    routes: {
      exercised: extraction.routes.length,
      discovered,
      inSuss: side.routes.length,
    },
    recall: rate(verdicts),
    recallSettleable: rate(verdicts.filter((one) => !one.tableFromRequest)),
    recallByKind,
    missesByReason,
    foundByName: verdicts.filter((one) => one.agreement === "byName").length,
    grepLocated,
    verdicts,
    notExercised: matched.notExercised,
    setAside: extraction.setAside,
  };
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${Math.round((100 * part) / whole)}%`;
}

function rateCells(rate: Rate): string {
  return `${rate.traced} | ${rate.suss} (${percent(rate.suss, rate.traced)}) | ${rate.grep} (${percent(rate.grep, rate.traced)})`;
}

export function renderSummary(report: Report): string {
  const lines = [
    `${report.app}: ${report.recall.traced} traced edges from ${report.routes.exercised} exercised routes (${report.routes.discovered} of them in suss)`,
    `  suss found ${report.recall.suss} (${percent(report.recall.suss, report.recall.traced)}), grep found ${report.recall.grep} (${percent(report.recall.grep, report.recall.traced)})`,
    `  less the ${report.recall.traced - report.recallSettleable.traced} edges whose table the request path gives: suss ${report.recallSettleable.suss} of ${report.recallSettleable.traced}, grep ${report.recallSettleable.grep}`,
  ];
  for (const reason of REASON_ORDER) {
    const count = report.missesByReason[reason];
    if (count !== undefined) {
      lines.push(`  missed, ${REASON_LABEL[reason]}: ${count}`);
    }
  }
  lines.push(
    `  not exercised: ${report.notExercised.length} boundaries suss reaches from exercised routes`,
  );
  return lines.join("\n");
}

export function renderMarkdown(report: Report): string {
  const lines = [
    `# ${report.app}`,
    "",
    `${report.spans} spans in ${report.traces} traces. ${report.routes.exercised} routes were exercised, and suss has ${report.routes.discovered} of them among its ${report.routes.inSuss} routes.`,
    "",
    "| Edge kind | Traced | suss | grep |",
    "| --- | --- | --- | --- |",
    `| all | ${rateCells(report.recall)} |`,
    `| all, less tables the request path gives | ${rateCells(report.recallSettleable)} |`,
  ];
  for (const [kind, rate] of Object.entries(report.recallByKind)) {
    lines.push(`| ${kind} | ${rateCells(rate)} |`);
  }
  lines.push(
    "",
    `${report.foundByName} found edges agreed only by the model and table name rule.`,
    "",
    "## Misses by reason",
    "",
    "| Reason | Edges |",
    "| --- | --- |",
  );
  for (const reason of REASON_ORDER) {
    const count = report.missesByReason[reason];
    if (count !== undefined) {
      lines.push(`| ${REASON_LABEL[reason]} | ${count} |`);
    }
  }
  for (const reason of REASON_ORDER) {
    const missed = report.verdicts.filter((one) => one.reason === reason);
    if (missed.length === 0) {
      continue;
    }
    lines.push("", `### ${REASON_LABEL[reason]}`, "");
    for (const one of missed) {
      lines.push(`- \`${one.edge}\` (${one.library}): ${one.detail ?? ""}`);
    }
  }
  lines.push("", "## Found", "");
  for (const one of report.verdicts.filter((verdict) => verdict.found)) {
    const through = one.via?.through.length
      ? `, through ${one.via.through.join(", then ")}`
      : "";
    lines.push(
      `- \`${one.edge}\` as ${one.via?.label ?? "?"}${one.agreement === "byName" ? " (by name)" : ""}${through}`,
    );
  }
  lines.push(
    "",
    "## Not exercised",
    "",
    "suss reaches these from a route the trace exercised, and no request in the trace reached them. A trace covers only the paths the tests ran, so these are not wrong.",
    "",
  );
  for (const one of report.notExercised) {
    lines.push(`- \`${one.route}\` reaches \`${one.boundary}\``);
  }
  lines.push(
    "",
    "## Grep rival",
    "",
    "| Handler file located by | Edges |",
    "| --- | --- |",
  );
  for (const [by, count] of Object.entries(report.grepLocated)) {
    lines.push(`| ${by} | ${count} |`);
  }
  lines.push("", "## Spans set aside", "", "| Why | Spans |", "| --- | --- |");
  for (const one of report.setAside) {
    lines.push(`| ${one.reason} | ${one.count} |`);
  }
  return `${lines.join("\n")}\n`;
}
