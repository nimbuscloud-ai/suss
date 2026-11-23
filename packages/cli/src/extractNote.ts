/**
 * The note a read leaves beside its summaries when it could not read
 * everything: a pack left out for want of an option, a config path that
 * points at nothing, or the read failing outright. `check` turns it into
 * run findings, and the MCP server's status repeats it, so both read it
 * here.
 */

import fs from "node:fs";

import type { PackConfigNeed, PackPathMissing } from "@suss/extractor";
import type { ReadFailure } from "./projectFile.js";

export interface ExtractNote {
  packsNeedingConfig?: PackConfigNeed[];
  packPathsMissing?: PackPathMissing[];
  readFailed?: ReadFailure;
}

/**
 * The note in `file`. A note that is missing or does not parse counts as
 * empty, since its job is to warn and a bad one should not stop a run.
 */
export function readExtractNote(file: string): ExtractNote {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ExtractNote;
  } catch {
    return {};
  }
}
