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
import type {
  ArgumentPick,
  Chain,
  InputRule,
  Link,
  MethodsLink,
  StatedRule,
  StorageMethod,
} from "./chain.js";
import type { ReceiverOrigin } from "./ops.js";
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
  /**
   * What the pack itself speaks, when that is not the wire its accesses
   * record. An S3 access goes over the AWS SDK and says so on every
   * effect, while the pack speaks S3.
   */
  protocol?: string;
  /**
   * Further modules whose presence makes a file worth reading, beyond
   * the ones the chains match on. A helper a project reaches by a
   * relative path gives the gate nothing; the library that helper
   * imports gives it something.
   */
  requiresImport?: string[];
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
    protocol: spec.protocol ?? protocolOf(chains),
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: [
      ...new Set([...gateOf(chains), ...(spec.requiresImport ?? [])]),
    ],
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
    for (const origin of originsIn(chain)) {
      for (const module of origin.importedFrom) {
        modules.add(module);
      }
    }
  }
  return [...modules];
}

/**
 * Every origin a chain states. A chain says where its match starts, and
 * a chain about a command says where that command came from as it steps
 * to it, so both are places a module can only be reached from.
 */
function originsIn(chain: Chain<StorageMethod>): ReceiverOrigin[] {
  const found: ReceiverOrigin[] = [];
  for (const link of chain.links) {
    if (link.asks === "start" && link.at.starts === "receiver") {
      found.push(link.at.origin);
    }
    if (link.asks !== "subject") {
      continue;
    }
    for (const step of link.of) {
      if (step.to === "argument" && step.origin !== undefined) {
        found.push(step.origin);
      }
    }
  }
  return found;
}

/** One question a pack settled with code, and how far down it reached. */
interface WrittenAsCode {
  asks: string;
  reachesAst: boolean;
}

/** What one chain cost, as the health report reads it. */
function describe(chain: Chain<StorageMethod>): DeclaredMatch {
  const links = chain.links.filter(isFunctionLink);
  const written: WrittenAsCode[] = [
    ...links.map((link) => ({
      asks: link.asks,
      reachesAst: link.from.reachesAst === true,
    })),
    ...rulesIn(chain),
  ];
  return {
    name: chain.ending.system,
    // A method table with a rule inside it is still a table, so that
    // link stays counted as data and the rule is priced beside it.
    dataLinks: chain.links.length - links.length,
    functionLinks: written.map((rule) => rule.asks),
    astLinks: written
      .filter((rule) => rule.reachesAst)
      .map((rule) => rule.asks),
    example: chain.example,
  };
}

/** Whether a pack wrote this link as code. */
function isFunctionLink(
  link: Link<StorageMethod>,
): link is Extract<Link<StorageMethod>, { from: unknown }> {
  return link.asks === "container" && "from" in link;
}

/** The questions a rule inside the methods table settles, by name. */
function rulesIn(chain: Chain<StorageMethod>): WrittenAsCode[] {
  const link = chain.links.find(
    (candidate): candidate is MethodsLink<StorageMethod> =>
      candidate.asks === "methods",
  );
  const written = new Map<string, InputRule>();
  for (const method of Object.values(link?.table ?? {})) {
    for (const asks of ["selector", "fields"] as const) {
      const rule = ruleFor(method[asks]);
      if (rule !== null) {
        written.set(asks, rule);
      }
    }
  }
  return [...written].map(([asks, from]) => ({
    asks,
    reachesAst: from.reachesAst === true,
  }));
}

/**
 * The rule a method gave for one question, whether it reads the inputs
 * the chain found or a value it pointed itself at. Both are code and
 * both are priced, so the pack health report does not go quiet when a
 * pack moves from one form to the other.
 */
function ruleFor(says: StorageMethod["selector"]): InputRule | null {
  if (typeof says === "function") {
    return says;
  }
  if (says === undefined || Array.isArray(says)) {
    return null;
  }
  const pointed = says as ArgumentPick | StatedRule;
  return "by" in pointed ? pointed.by : null;
}
