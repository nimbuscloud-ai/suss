/**
 * `suss map`: read a project the way a bare `suss check` does, check it,
 * and write one HTML page that shows what the code serves and touches.
 *
 * With no `--dir`, it reads the project from `suss.json`, or from what
 * `suss init` would pick, and keeps the summaries next to the page so a
 * reader can ask suss about any number on it. With `--dir`, it maps
 * summaries already written. A run that pairs nothing still writes the
 * page and exits 0, because the page is worth reading without a pair.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { mapFolderFor } from "@suss/extractor";

import { checkDirectory } from "../check.js";
import { languageOfFile } from "../language.js";
import { loadedSummaries } from "../loadedSummaries.js";
import { readEntryIndex, readProjectFile } from "../projectFile.js";
import {
  clearEarlierReads,
  commandFor,
  readProjectSaying,
} from "../projectRead.js";
import { UsageError } from "../usageError.js";
import { pickCards } from "./mapCards.js";
import { buildMapModel } from "./mapModel.js";
import { renderMapPage } from "./mapPage.js";
import { terminalSummary } from "./mapSummary.js";
import { absoluteFile } from "./mapUnits.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { MapModel, MapRead } from "./mapModel.js";

export async function runMap(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      out: { type: "string", short: "o" },
    },
    allowPositionals: true,
  });
  if (positionals.length > 1) {
    throw new UsageError(
      `map reads one project. It got ${positionals.join(", ")}. Try: suss map ${positionals[0]}`,
    );
  }

  const root = path.resolve(positionals[0] ?? process.cwd());
  const folder = mapFolderFor(root);
  const summariesDir =
    values.dir === undefined
      ? await readInto(root, path.join(folder, "summaries"))
      : path.resolve(values.dir);
  if (summariesDir === null) {
    process.stderr.write(
      `Nothing in ${root} matched a pack, so there is nothing to map. Run \`suss init\` to see what suss looked for, or pass --dir with summaries you wrote.\n`,
    );
    return 1;
  }

  const checked = checkDirectory({ dir: summariesDir });
  const { reads, readOf } = readsOf(
    root,
    checked.summaries,
    checked.sourceFile,
  );
  const model = buildMapModel({
    projectName: path.basename(root),
    loaded: loadedSummaries(checked.summaries),
    check: checked.result,
    reads,
    readOf,
  });
  const cards = pickCards(model);
  const out = path.resolve(values.out ?? path.join(folder, "map.html"));
  const page = renderMapPage(model, cards, {
    summariesDir: shownPath(summariesDir),
    sourceLines: sourceReader(model),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);

  process.stdout.write(
    `${[`suss map wrote ${shownPath(out)}`, ...terminalSummary(model)].join("\n")}\n`,
  );
  return 0;
}

/** Reads the project into `dir`, replacing what an earlier map left there. Null when no pack matched. */
async function readInto(root: string, dir: string): Promise<string | null> {
  clearEarlierReads(dir);
  const report = await readProjectSaying(root, dir, true);
  if (report === null) {
    return null;
  }
  process.stderr.write("\n");
  return dir;
}

/**
 * One read per summary file, in the order `suss.json` lists them. A file
 * an `--out-dir` extract wrote is numbered by its entry, which says the
 * folder its paths start from and the packs it used. A file named any
 * other way is placed in the first folder where its first unit's file is.
 */
function readsOf(
  root: string,
  summaries: readonly BehavioralSummary[],
  sourceFile: ReadonlyMap<BehavioralSummary, string>,
): { reads: MapRead[]; readOf: Map<BehavioralSummary, number> } {
  const project = readProjectFile(root);
  const files = [...new Set(sourceFile.values())].sort(
    (a, b) =>
      (readEntryIndex(a) ?? Number.MAX_SAFE_INTEGER) -
        (readEntryIndex(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
  );
  const byFile = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const file = sourceFile.get(summary) ?? "";
    byFile.set(file, [...(byFile.get(file) ?? []), summary]);
  }

  const folders = [
    root,
    ...(project?.read ?? []).flatMap((entry) =>
      entry.kind === "extract" ? [path.resolve(root, entry.dir ?? ".")] : [],
    ),
  ];
  const reads = files.map((file): MapRead => {
    const index = readEntryIndex(file);
    const entry = index === null ? undefined : project?.read[index];
    if (entry !== undefined) {
      return {
        file,
        label: commandFor(entry),
        root:
          entry.kind === "extract"
            ? path.resolve(root, entry.dir ?? ".")
            : root,
        packs: entry.kind === "extract" ? entry.packs : [],
        spec: entry.kind === "contract",
      };
    }
    const first = (byFile.get(file) ?? []).find(
      (summary) => languageOfFile(summary.location.file) !== null,
    );
    return {
      file,
      label: file,
      root:
        first === undefined
          ? null
          : (folders.find((folder) =>
              fs.existsSync(path.join(folder, first.location.file)),
            ) ?? null),
      packs: [],
      spec: first === undefined,
    };
  });

  const index = new Map(files.map((file, at) => [file, at]));
  const readOf = new Map<BehavioralSummary, number>();
  for (const summary of summaries) {
    readOf.set(summary, index.get(sourceFile.get(summary) ?? "") ?? 0);
  }
  return { reads, readOf };
}

/** Lines of a unit's file for the finding cards, each file read once. */
function sourceReader(
  model: MapModel,
): (unit: number, start: number, end: number) => string[] {
  const files = new Map<string, string[]>();
  return (unit, start, end) => {
    const found = model.units[unit];
    const file = found === undefined ? null : absoluteFile(found, model.reads);
    if (file === null) {
      return [];
    }
    if (!files.has(file)) {
      files.set(file, readLines(file));
    }
    return (files.get(file) ?? []).slice(start - 1, end);
  };
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

/** A path as a reader in the working directory would type it. */
function shownPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative !== "" && !relative.startsWith("..") ? relative : file;
}
