/**
 * What a Ruby framework pack read that serves requests beside its
 * routes, written on every route the pack recognized: the files in its
 * static directories and whatever its routing sends somewhere suss does
 * not read. A pack that states nothing doesn't write one, and the
 * checker then doesn't report a call to a missing route in its service.
 */

import path from "node:path";

import {
  runPackHook,
  stampServedBeside,
  staticDirectoryEntries,
} from "@suss/extractor";

import type { BehavioralSummary, ServedBesideEntry } from "@suss/behavioral-ir";
import type { PackTally } from "@suss/extractor";
import type { ControllerActions, RubyPack } from "./pack.js";

export function stampRubyServedBeside(
  summaries: readonly BehavioralSummary[],
  packs: readonly RubyPack[],
  tallyOf: (pack: string) => PackTally | undefined,
): void {
  for (const pack of packs) {
    if (pack.servedBeside === undefined) {
      continue;
    }
    const patterns = pack.discovery.filter(
      (pattern): pattern is ControllerActions =>
        pattern.type === "controllerActions",
    );
    const routesFile = patterns[0]?.routesFile;
    const root = routesFile === undefined ? "." : path.dirname(routesFile);
    stampServedBeside(summaries, pack.name, [
      ...staticDirectoryEntries(root, pack.servedBeside.staticDirectories),
      ...patterns.flatMap((pattern) =>
        runPackHook(
          tallyOf(pack.name),
          {
            pack: pack.name,
            hook: "routedElsewhere",
            file: pattern.routesFile,
          },
          () => pattern.routedElsewhere?.() ?? [],
          [unreadRouting(pattern.routesFile)],
        ),
      ),
    ]);
  }
}

/** What a routing read that failed leaves: any path may be served by something suss did not see. */
function unreadRouting(file: string): ServedBesideEntry {
  return { by: "unread", file, line: 1, written: "the routing" };
}
