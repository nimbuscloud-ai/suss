// Naming a summary, so something else can refer to it.
//
// A name is not enough. Reading suss's own source produces 404
// summaries that share a name with another one, and a repository of any
// size is worse: two services holding the same `src/handlers.ts` give
// every summary in one an exact twin in the other. Anything that
// followed a call by matching names was guessing which one it meant.
//
// So a summary carries the project it came from, the file it sits in,
// and the path its export is reached by. That is unique across
// everything one run can see, and it reads as something a person could
// have written down.

import fs from "node:fs";
import path from "node:path";

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
  // The files a run reads usually sit under `src`, and the project is
  // whatever declares itself above them. Looking only where the files
  // are called every package `src`.
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

  // One function can hold several summaries, one per thing it
  // consumes, and those share a name, a file and an export path. What
  // tells those apart is the boundary each one is about, which is the
  // same thing that decides what a summary pairs with. An anonymous
  // function has no name to begin with, so where the boundary does not
  // settle it either, the line does.
  settleWith(summaries, (summary) =>
    summary.identity.boundaryBinding === null
      ? null
      : `#${boundaryKey(summary.identity.boundaryBinding)}`,
  );
  settleWith(summaries, (summary) => `@${summary.location.range.start}`);

  nameWhatEachCallReaches(summaries);
}

/**
 * Add something to the ids that more than one summary is using, and
 * leave the ones nothing else claims alone. Short ids stay short, and
 * they survive the code moving.
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

/** The file as the id says it, so the id survives moving the checkout. */
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
  const reached =
    summary.identity.exportPath !== null &&
    summary.identity.exportPath.length > 0
      ? summary.identity.exportPath.join(".")
      : summary.identity.name;
  return workspace === null
    ? `${file}::${reached}`
    : `${workspace}::${file}::${reached}`;
}

/**
 * Point each call at the summary it reaches.
 *
 * A name is answered by the summary in the same file first, since that
 * is where an unqualified call usually goes, and by the run as a whole
 * after that. Two answers mean the name does not decide it, and the
 * call keeps saying only what it said before. A gap a reader can see
 * beats a link that might be wrong.
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
        // A method call names its receiver too, and the last part is
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
