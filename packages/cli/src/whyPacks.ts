/**
 * The packs a why question's sessions load. A why answer re-reads the
 * source, and a step only a pack declares, such as a finder giving back
 * one of its model, is explained only when that pack is loaded. So the
 * sessions load the packs an extraction of the project loads when it is
 * not told which: the ones `suss.json` lists, or the ones `suss init`
 * would pick. Each is loaded through the same resolver, stub overlay and
 * project root as in `suss extract`.
 *
 * A pack that cannot be loaded is left out, and the answer says so in a
 * caveat, since a thinner answer with no reason given looks like the
 * code's own doing.
 */

import {
  packSpecFrom,
  resolveFramework,
  resolvePythonPack,
  resolveRubyPack,
} from "./extract.js";
import { LANGUAGE_LABEL } from "./language.js";
import { declaredReads, extractEntryFor } from "./projectRead.js";
import { loadStubs, stubOverlayOf } from "./stubs.js";

import type { PythonPack } from "@suss/adapter-python";
import type { RubyPack } from "@suss/adapter-ruby";
import type { PatternPack } from "@suss/extractor";
import type { Language } from "./language.js";
import type { StubOverlay } from "./stubs.js";

interface PackOf {
  typescript: PatternPack;
  python: PythonPack;
  ruby: RubyPack;
}

/** A pack a why session should have loaded and did not. */
export interface UnloadedPack {
  readonly language: Language;
  readonly spec: string;
  readonly reason: string;
}

export interface WhyPacks {
  readonly packs: { readonly [L in Language]: readonly PackOf[L][] };
  readonly unloaded: readonly UnloadedPack[];
}

export const NO_WHY_PACKS: WhyPacks = {
  packs: { typescript: [], python: [], ruby: [] },
  unloaded: [],
};

const RESOLVE_PACK: {
  [L in Language]: (
    spec: string,
    overlay: StubOverlay,
    root: string,
  ) => Promise<PackOf[L]>;
} = {
  typescript: resolveFramework,
  python: resolvePythonPack,
  ruby: resolveRubyPack,
};

/** The packs an extraction of `root` loads when the command line gives none. */
export async function whyPacksFor(root: string): Promise<WhyPacks> {
  const { reads } = await declaredReads(root);
  const overlay = stubOverlayOf(loadStubs(root));
  const unloaded: UnloadedPack[] = [];
  const load = async <L extends Language>(
    language: L,
  ): Promise<PackOf[L][]> => {
    const loaded: PackOf[L][] = [];
    for (const spec of extractEntryFor(reads, language)?.packs ?? []) {
      try {
        loaded.push(
          await RESOLVE_PACK[language](packSpecFrom(root, spec), overlay, root),
        );
      } catch (error) {
        unloaded.push({ language, spec, reason: firstLineOf(error) });
      }
    }
    return loaded;
  };
  return {
    packs: {
      typescript: await load("typescript"),
      python: await load("python"),
      ruby: await load("ruby"),
    },
    unloaded,
  };
}

/** One caveat for each pack in these languages that did not load. */
export function unloadedPackCaveats(
  whyPacks: WhyPacks,
  languages: ReadonlySet<Language>,
): string[] {
  return whyPacks.unloaded
    .filter((one) => languages.has(one.language))
    .map(
      (one) =>
        `A ${LANGUAGE_LABEL[one.language]} step only ${one.spec} declares is left out, because that pack did not load. ${one.reason}`,
    );
}

function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
