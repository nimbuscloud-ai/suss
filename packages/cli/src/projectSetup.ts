/**
 * Writes down what `suss init` found, so later commands read the same
 * packs and artifacts without flags.
 *
 * The guided run calls this once the user accepts, and `init --write`
 * calls it without asking. Both write one `suss.json` at the root that
 * lists every project init set up, and the config file for each pack
 * that takes one. A pack that needs a value init cannot work out is left
 * out of `suss.json` with a note, since listing it would stop the whole
 * extract for its language. Whether an existing `suss.json` may be
 * replaced is up to the caller.
 */

import fs from "node:fs";
import path from "node:path";

import { configurationNeed, valuesFor } from "./init.js";
import {
  PROJECT_FILE,
  projectFileFor,
  writeProjectFile,
} from "./projectFile.js";

import type { InitReport, PackConfiguration, PackSuggestion } from "./init.js";

/** A project init set up, and where it is relative to the root. */
export interface SetupTarget {
  directory: string;
  report: InitReport;
}

/** One thing the setup did, for the caller to print its own way. */
export interface SetupLine {
  /** `done` for a file written, `note` for something the user still has to do. */
  tone: "done" | "note";
  text: string;
}

/** What setting up one pack's config came to. */
interface ConfiguredPack {
  pack: string;
  /** False when `suss.json` has to leave the pack out. */
  listed: boolean;
  line: SetupLine | null;
}

/** Writes the setup and says what it wrote. Empty when there was nothing to write. */
export function writeProjectSetup(
  root: string,
  targets: readonly SetupTarget[],
): SetupLine[] {
  const configured: ConfiguredPack[] = [];
  const read = targets.flatMap((target) => {
    const packs = target.report.suggestions.flatMap((suggestion) =>
      suggestion.configuration === undefined
        ? []
        : [configurePack(target, suggestion, suggestion.configuration)],
    );
    configured.push(...packs);
    const leftOut = new Set(
      packs.filter((one) => !one.listed).map((one) => one.pack),
    );
    return projectFileFor(target.report, target.directory, leftOut)?.read ?? [];
  });

  const lines = configured.flatMap((one) =>
    one.line === null ? [] : [one.line],
  );
  if (read.length === 0) {
    return lines;
  }

  writeProjectFile(root, { version: 1, read });
  const commit = lines.some((line) => line.tone === "done")
    ? "Commit it with the pack config files: together they say"
    : "Commit it: it says";
  return [
    ...lines.filter((line) => line.tone === "done"),
    {
      tone: "done",
      text: `Wrote ${PROJECT_FILE}. ${commit} what the project contains, which is the same for everybody.`,
    },
    ...lines.filter((line) => line.tone === "note"),
  ];
}

/**
 * Writes one pack's config file when init can fill it in. A file that is
 * already there is kept as it is, since it has this project's own values.
 */
function configurePack(
  target: SetupTarget,
  suggestion: PackSuggestion,
  configuration: PackConfiguration,
): ConfiguredPack {
  const pack = suggestion.name;
  const shown = path.join(target.directory, configuration.file);
  const file = path.join(target.report.root, configuration.file);
  if (fs.existsSync(file)) {
    return {
      pack,
      listed: true,
      line: {
        tone: "done",
        text: `Kept ${shown}, which was already here, for the ${pack} pack.`,
      },
    };
  }

  const values = valuesFor(configuration, target.report.root);
  if (values !== null) {
    fs.writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
    return {
      pack,
      listed: true,
      line: {
        tone: "done",
        text: `Wrote ${shown} for the ${pack} pack: ${JSON.stringify(values)}.`,
      },
    };
  }

  if (!configuration.required) {
    return { pack, listed: true, line: null };
  }
  return {
    pack,
    listed: false,
    line: {
      tone: "note",
      text: `Left ${pack} out of ${PROJECT_FILE}. It ${configurationNeed(configuration)} ${configuration.why} Write that to ${shown}, as in ${JSON.stringify(configuration.example)}, then run \`suss init --write --overwrite\` to list the pack.`,
    },
  };
}
