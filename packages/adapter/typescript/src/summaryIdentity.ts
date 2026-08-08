/**
 * Naming a summary, so that something else can point at it.
 *
 * A bare function name is not enough. Reading suss's own source turns up
 * 404 summaries that share a name with another one, and a large
 * repository is worse: two services with the same `src/handlers.ts` give
 * every summary in one an exact twin in the other. Following a call by
 * matching names was always a guess about which one was meant.
 *
 * So the name includes the project the summary came from, the file it is
 * in, and the path its export is reached by. That is unique across
 * everything one run can see, and it still looks like something a person
 * would have written down.
 */

import fs from "node:fs";
import path from "node:path";

import { summaryIdFromParts } from "@suss/behavioral-ir";
import { boundaryKey } from "@suss/ir-core";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/**
 * What a project calls itself.
 *
 * Its package.json name is what a person would say and what a sibling
 * package already imports it by. A project without one falls back to
 * the folder, which is at least what somebody typed.
 */
export function workspaceNameFor(root: string | undefined): string | null {
  if (root === undefined) {
    return null;
  }
  // The files a run reads are usually under `src`, and the project is
  // whatever declares itself above them. Looking only in the directory
  // the files are in named every package `src`.
  let at = path.resolve(root);
  for (let up = 0; up < 12; up += 1) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(at, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        return manifest.name;
      }
    } catch {
      // Nothing here, or nothing readable. Keep going up.
    }
    const parent = path.dirname(at);
    if (parent === at) {
      break;
    }
    at = parent;
  }
  const folder = path.basename(path.resolve(root));
  return folder.length > 0 ? folder : null;
}

/**
 * Give every summary a name of its own, and point each call at the
 * summary it reaches.
 *
 * Reads the set as a whole because a call can only be answered by
 * looking at what else came out of the run.
 */
export function nameSummaries(
  summaries: BehavioralSummary[],
  args: { workspace: string | null; projectRoot: string | undefined },
): void {
  for (const summary of summaries) {
    const file = relativeFile(summary.location.file, args.projectRoot);
    if (args.workspace !== null) {
      summary.location.workspace = args.workspace;
    }
    summary.identity.id = idFor(args.workspace, file, summary);
  }

  // One function can produce several summaries, one per thing it
  // consumes, and those share a name, a file and an export path. The
  // boundary each one is about is what tells them apart, and it is also
  // what decides which summaries pair with each other. An anonymous
  // function has no name to start from, so when the boundary does not
  // separate them either, the line number does.
  settleWith(summaries, (summary) =>
    summary.identity.boundaryBinding === null
      ? null
      : `#${boundaryKey(summary.identity.boundaryBinding)}`,
  );
  settleWith(summaries, (summary) => `@${summary.location.range.start}`);

  nameWhatEachCallReaches(summaries);
}

/**
 * Extend only the ids that more than one summary ended up with, and
 * leave the rest alone. An id nothing collides with stays short, and
 * stays the same when the code around it moves.
 */
function settleWith(
  summaries: BehavioralSummary[],
  discriminator: (summary: BehavioralSummary) => string | null,
): void {
  const claimed = new Map<string, number>();
  for (const summary of summaries) {
    const id = summary.identity.id ?? "";
    claimed.set(id, (claimed.get(id) ?? 0) + 1);
  }
  for (const summary of summaries) {
    if ((claimed.get(summary.identity.id ?? "") ?? 0) <= 1) {
      continue;
    }
    const extra = discriminator(summary);
    if (extra !== null) {
      summary.identity.id = `${summary.identity.id}${extra}`;
    }
  }
}

/** Relative to the project, so the id survives moving the checkout. */
function relativeFile(file: string, projectRoot: string | undefined): string {
  if (projectRoot === undefined || !path.isAbsolute(file)) {
    return file;
  }
  const relative = path.relative(projectRoot, file);
  return relative.startsWith("..") ? file : relative;
}

function idFor(
  workspace: string | null,
  file: string,
  summary: BehavioralSummary,
): string {
  return summaryIdFromParts({
    workspace: workspace ?? undefined,
    file,
    name: summary.identity.name,
    exportPath: summary.identity.exportPath,
  });
}

/**
 * Point each call at the summary it reaches.
 *
 * A name is matched against the summaries in the same file first, since
 * that is where an unqualified call usually goes, and against the whole
 * run after that. Two matches mean the name does not settle it, and the
 * call is left saying only what it said before: a reader can see a
 * missing link, and cannot see a wrong one.
 */
function nameWhatEachCallReaches(summaries: BehavioralSummary[]): void {
  const byName = new Map<string, BehavioralSummary[]>();
  const byFileAndName = new Map<string, BehavioralSummary[]>();
  const remember = (
    index: Map<string, BehavioralSummary[]>,
    key: string,
    summary: BehavioralSummary,
  ): void => {
    const found = index.get(key);
    if (found === undefined) {
      index.set(key, [summary]);
      return;
    }
    found.push(summary);
  };

  for (const summary of summaries) {
    // A label is there for the reader and nothing in the code can call
    // it, so a callee segment that matches one is a coincidence, as
    // `Promise.all` is against a route registered with `.all`.
    if (summary.identity.nameKind === "label") {
      continue;
    }

    remember(byName, summary.identity.name, summary);
    remember(
      byFileAndName,
      `${summary.location.file}::${summary.identity.name}`,
      summary,
    );
  }

  const onlyAnswer = (
    index: Map<string, BehavioralSummary[]>,
    key: string,
  ): BehavioralSummary | null => {
    const found = index.get(key) ?? [];
    return found.length === 1 ? (found[0] as BehavioralSummary) : null;
  };

  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation") {
          continue;
        }
        // A method call includes its receiver, and the last segment is
        // the function, which is what a summary is named after.
        const called = effect.callee.split(".").pop() ?? effect.callee;
        const reached =
          onlyAnswer(byFileAndName, `${summary.location.file}::${called}`) ??
          onlyAnswer(byName, called);
        if (reached?.identity.id !== undefined) {
          effect.summary = reached.identity.id;
        }
      }
    }
  }
}
