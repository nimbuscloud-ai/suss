/**
 * What a Ruby framework pack read that serves requests beside its
 * routes, written on every route the pack recognized: the files in its
 * static directories, whatever its routing sends somewhere suss does
 * not read, and each route the routing declares that no action in the
 * run serves. A pack that states nothing doesn't write one, and the
 * checker then doesn't report a call to a missing route in its service.
 */

import path from "node:path";

import { restBinding } from "@suss/behavioral-ir";
import {
  runPackHook,
  stampServedBeside,
  staticDirectoryEntries,
} from "@suss/extractor";
import { boundaryKey, withOptionalFormat } from "@suss/ir-core";

import { servesFormat } from "./discovery.js";

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
    const served = routesServed(summaries, pack.name);
    stampServedBeside(summaries, pack.name, [
      ...staticDirectoryEntries(root, pack.servedBeside.staticDirectories),
      ...patterns.flatMap((pattern) => [
        ...runPackHook(
          tallyOf(pack.name),
          {
            pack: pack.name,
            hook: "routedElsewhere",
            file: pattern.routesFile,
          },
          () => pattern.routedElsewhere?.() ?? [],
          [unreadRouting(pattern.routesFile)],
        ),
        ...runPackHook(
          tallyOf(pack.name),
          {
            pack: pack.name,
            hook: "declaredRoutes",
            file: pattern.routesFile,
          },
          () => routesNothingServes(pack, pattern, served),
          [unreadRouting(pattern.routesFile)],
        ),
      ]),
    ]);
  }
}

/** What a routing read that failed leaves: any path may be served by something suss did not see. */
function unreadRouting(file: string): ServedBesideEntry {
  return { by: "unread", file, line: 1, written: "the routing" };
}

/** The boundary of each summary the pack recognized. */
function routesServed(
  summaries: readonly BehavioralSummary[],
  pack: string,
): Set<string> {
  const served = new Set<string>();
  for (const summary of summaries) {
    const binding = summary.identity.boundaryBinding;
    const key = binding?.recognition === pack ? boundaryKey(binding) : null;
    if (key !== null) {
      served.add(key);
    }
  }
  return served;
}

/**
 * The routes the routing declares that no summary serves, such as one
 * to a controller suss did not recognize. Each may serve its path, so a
 * call to it is not a call to a route the service lacks.
 */
function routesNothingServes(
  pack: RubyPack,
  pattern: ControllerActions,
  served: ReadonlySet<string>,
): ServedBesideEntry[] {
  const entries = new Map<string, ServedBesideEntry>();
  for (const route of pattern.declaredRoutes?.() ?? []) {
    const key = boundaryKey(
      restBinding({
        transport: pack.protocol,
        method: route.method,
        path: route.path,
        recognition: pack.name,
      }),
    );
    if (key === null || served.has(key) || entries.has(key)) {
      continue;
    }
    entries.set(key, {
      by: "unread",
      path: servesFormat(pattern, route)
        ? withOptionalFormat(route.path)
        : route.path,
      methods: [route.method],
      file: pattern.routesFile,
      line: 1,
      written: route.to,
    });
  }
  return [...entries.values()];
}
