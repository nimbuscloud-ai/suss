/**
 * Assembling declared chains into the pack the adapters load.
 *
 * Everything a `PatternPack` needs beyond the chains is either already
 * in them or the same for every declared pack: the modules the client
 * came from are the import gate, the store's wire is the protocol, and
 * a pack of recognizers discovers nothing. What is left is the pack's
 * own name, the languages it runs on, and the name its effects are
 * recognized under, which is the npm package callers install.
 */

import { compile } from "./compile.js";

import type {
  DeclaredMatch,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";
import type { Chain, Link, StorageMethod } from "./chain.js";
import type { StorageCalls } from "./storage.js";

/** What a pack says about itself, beyond the calls it matches. */
export interface PackSpec {
  /** The languages the pack runs on, as the adapters name them. */
  languages: string[];
  /**
   * The name effects from this pack are recorded under, which is the
   * npm package a user installs.
   */
  recognizedAs: string;
  /**
   * What the pack calls this build of itself. The extraction cache keys
   * on it, so a pack that never stamps one serves an earlier build's
   * results after an edit.
   */
  version?: string;
}

/** A pack, assembled from the calls it says it matches. */
export function pack(
  name: string,
  matches: readonly StorageCalls[],
  spec: PackSpec,
): PatternPack {
  const chains = matches.map((match) => match.declared);
  const recognizers: InvocationRecognizer[] = chains.map((chain) =>
    compile(chain, spec.recognizedAs),
  );

  return {
    name,
    languages: spec.languages,
    ...(spec.version === undefined ? {} : { version: spec.version }),
    protocol: protocolOf(chains),
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: gateOf(chains),
    invocationRecognizers: recognizers,
    declarations: { declarations: chains.map(describe) },
  };
}

/** The wire every chain in a pack reaches over. */
function protocolOf(chains: readonly Chain<StorageMethod>[]): string {
  const wires = new Set(
    chains.map((chain) => chain.ending.transport ?? chain.ending.system),
  );
  const [only] = [...wires];
  if (wires.size !== 1 || only === undefined) {
    throw new Error(
      `a pack reaches ${wires.size} wires (${[...wires].join(", ")}); split it into one pack per wire`,
    );
  }
  return only;
}

/** The modules a file has to reach before any of these chains can match. */
function gateOf(chains: readonly Chain<StorageMethod>[]): string[] {
  const modules = new Set<string>();
  for (const chain of chains) {
    for (const link of chain.links) {
      if (link.asks !== "start" || link.at.starts !== "receiver") {
        continue;
      }
      for (const module of link.at.origin.importedFrom) {
        modules.add(module);
      }
    }
  }
  return [...modules];
}

/** What one chain cost, as the health report reads it. */
function describe(chain: Chain<StorageMethod>): DeclaredMatch {
  const functions = chain.links.filter(isFunctionLink);
  return {
    name: chain.ending.system,
    dataLinks: chain.links.length - functions.length,
    functionLinks: functions.map((link) => link.asks),
    astLinks: functions
      .filter((link) => link.from.reachesAst === true)
      .map((link) => link.asks),
    example: chain.example,
  };
}

/** Whether a pack answered this link with code. */
function isFunctionLink(
  link: Link<StorageMethod>,
): link is Extract<Link<StorageMethod>, { asks: "container" }> {
  return link.asks === "container";
}
