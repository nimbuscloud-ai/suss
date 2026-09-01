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
  PackDeclarations,
  PatternPack,
  ProjectHelpers,
} from "@suss/extractor";
import type {
  ArgumentPick,
  CallsLink,
  Chain,
  Ending,
  InputRule,
  Link,
  MethodMeaning,
  MethodsLink,
  StatedRule,
  StorageMethod,
} from "./chain.js";
import type { ReceiverOrigin } from "./ops.js";

/**
 * One thing a pack matches, as whichever entry point built it hands it
 * over. `storageCalls` and `sqlStatements` both come out as this.
 */
export interface Match {
  readonly declared: Chain<MethodMeaning>;
}

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
  /**
   * Recognizers written against the adapter directly, run alongside the
   * declared chains. A pack migrating one call at a time keeps what is
   * not declared yet here, and a pack that needs a shape the endings
   * cannot say keeps it here for good. Health reporting counts these as
   * function links, so the cost of staying here is visible.
   */
  recognizers?: InvocationRecognizer[];
  /**
   * Functions the project wrote in front of this library, read once
   * across the project before extraction. What the pack makes of them
   * joins the chains above for the rest of the run.
   */
  projectHelpers?: ProjectHelpers;
}

/**
 * Which walk a chain is dispatched on.
 *
 * A statement written as a tagged template is not an invocation, so the
 * invocation walk never reaches it. The access walk visits calls as
 * well as templates, which is why a chain over statements goes there
 * whichever of the two the source wrote.
 */
const DISPATCHED_ON: Record<Ending["yields"], "invocation" | "access"> = {
  storageAccess: "invocation",
  sqlAccess: "access",
  messageSend: "invocation",
  unitInvoke: "invocation",
};

/** The chains a pack dispatches on one of the two walks. */
function walkedBy(
  chains: readonly Chain<MethodMeaning>[],
  walk: "invocation" | "access",
  recognizedAs: string,
): InvocationRecognizer[] {
  return chains
    .filter((chain) => DISPATCHED_ON[chain.ending.yields] === walk)
    .map((chain) => compile(chain, recognizedAs));
}

/** A pack, assembled from the calls it says it matches. */
export function pack(
  name: string,
  matches: readonly Match[],
  spec: PackSpec,
): PatternPack {
  const chains = matches.map((match) => match.declared);
  const access = walkedBy(chains, "access", spec.recognizedAs);

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
    invocationRecognizers: [
      ...walkedBy(chains, "invocation", spec.recognizedAs),
      ...(spec.recognizers ?? []),
    ],
    ...(access.length === 0 ? {} : { accessRecognizers: access }),
    ...(spec.projectHelpers === undefined
      ? {}
      : { projectHelpers: spec.projectHelpers }),
    declarations: declarationsIn(matches),
  };
}

/**
 * What a set of chains cost, for a pack that assembles itself. A pack
 * part way through the migration still has a hand-rolled walk beside
 * its declarations, and this is how the part that moved is priced.
 */
export function declarationsIn(matches: readonly Match[]): PackDeclarations {
  return { declarations: matches.map((match) => describe(match.declared)) };
}

/** The wire one chain reaches over, whichever ending it has. */
function wireOf(ending: Ending): string {
  if (ending.yields === "messageSend") {
    return ending.wire;
  }
  if (ending.yields === "unitInvoke") {
    return ending.platform;
  }
  return ending.transport ?? ending.system;
}

/**
 * What a declaration is called where it is priced. A storage chain is
 * known by its store rather than by the wire it reaches over, since one
 * wire carries several stores.
 */
function declaredName(ending: Ending): string {
  if (ending.yields === "messageSend") {
    return ending.wire;
  }
  if (ending.yields === "unitInvoke") {
    return ending.platform;
  }
  return ending.system;
}

/** The wire every chain in a pack reaches over. */
function protocolOf(chains: readonly Chain<MethodMeaning>[]): string {
  const wires = new Set(chains.map((chain) => wireOf(chain.ending)));
  const [only] = [...wires];
  if (wires.size !== 1 || only === undefined) {
    throw new Error(
      `a pack reaches ${wires.size} wires (${[...wires].join(", ")}); split it into one pack per wire`,
    );
  }
  return only;
}

/** The modules a file has to reach before any of these chains can match. */
function gateOf(chains: readonly Chain<MethodMeaning>[]): string[] {
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
function originsIn(chain: Chain<MethodMeaning>): ReceiverOrigin[] {
  const found: ReceiverOrigin[] = [];
  for (const link of chain.links) {
    if (link.asks === "start" && link.at.starts === "receiver") {
      found.push(link.at.origin);
    }
    if (link.asks === "interpolates" && link.from !== undefined) {
      found.push(link.from);
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
function describe(chain: Chain<MethodMeaning>): DeclaredMatch {
  const links = chain.links.filter(isFunctionLink);
  const written: WrittenAsCode[] = [
    ...links.map((link) => ({
      asks: link.asks,
      reachesAst: link.from.reachesAst === true,
    })),
    ...rulesIn(chain),
  ];
  return {
    name: declaredName(chain.ending),
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
  link: Link<MethodMeaning>,
): link is Extract<Link<MethodMeaning>, { from: unknown }> {
  return link.asks === "container" && "from" in link;
}

/** The questions a rule inside a meaning settles, by name. */
function rulesIn(chain: Chain<MethodMeaning>): WrittenAsCode[] {
  const link = chain.links.find(
    (candidate): candidate is MethodsLink<MethodMeaning> =>
      candidate.asks === "methods",
  );
  const calls = chain.links.find(
    (candidate): candidate is CallsLink<MethodMeaning> =>
      candidate.asks === "calls",
  );
  const meanings = [
    ...Object.values(link?.table ?? {}),
    ...(calls === undefined ? [] : [calls.meaning]),
  ];
  const written = new Map<string, InputRule>();
  for (const method of meanings) {
    for (const asks of ["selector", "fields"] as const) {
      const rule = ruleFor((method as Partial<StorageMethod>)[asks]);
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
