/**
 * The few lines `suss map` prints under the page's path: the same counts
 * as the page's tiles, so a reader in the terminal sees what the page
 * leads with before opening it.
 */

import { entryNoun, firstPerTable } from "./mapCards.js";

import type { MapModel } from "./mapModel.js";

const LABEL_WIDTH = 14;

export function terminalSummary(model: MapModel): string[] {
  const rest = model.entries.filter((entry) => entry.kind === "rest");
  const fields = model.entries.filter((entry) => entry.kind === "graphql");
  const rows: Array<[string, string[]]> = [];

  if (rest.length > 0 || fields.length === 0) {
    const writing = rest.filter(
      (entry) => firstPerTable(model, entry.reach, "writes").length > 0,
    ).length;
    rows.push([
      "Routes",
      [
        String(rest.length),
        ...(writing > 0 ? [`${writing} write a table`] : []),
      ],
    ]);
  }
  if (fields.length > 0) {
    const called = fields.filter((entry) => entry.callers.length > 0).length;
    rows.push([
      "GraphQL",
      [
        plural(fields.length, "field", "fields"),
        `${called} with a caller here`,
      ],
    ]);
  }

  const variables = new Set(model.envReads.map((read) => read.boundary)).size;
  rows.push(["Tables", [String(model.tables.length)]]);
  rows.push(["Env vars", [String(variables)]]);
  rows.push([
    "Checked",
    [
      plural(model.check.pairs, "pair", "pairs"),
      plural(model.findings.length, "finding", "findings"),
    ],
  ]);
  const { coverage } = model;
  const noun = entryNoun(model);
  rows.push([
    "Not followed",
    [
      `${plural(coverage.unfollowedCalls, "call", "calls")} in ${plural(coverage.withUnfollowed, "function", "functions")}`,
      `${plural(coverage.entriesAffected, noun[0], noun[1])} affected`,
    ],
  ]);

  return rows.map(
    ([label, parts]) => `  ${label.padEnd(LABEL_WIDTH)}${parts.join(" · ")}`,
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
