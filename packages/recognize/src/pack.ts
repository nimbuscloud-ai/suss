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
 * One thing a pack matches, as an entry point returns it. `storageCalls`
 * and `sqlStatements` both return this.
 */
export interface Match {
  readonly declared: Chain<MethodMeaning>;
}

/** What a pack says about itself, beyond the calls it matches. */
export interface PackSpec {
  /** The languages the pack runs on, spelled as the adapters spell them. */
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
   * The pack's own protocol, when it differs from the wire its accesses
   * record. An S3 pack records the AWS SDK as the wire on every effect,
   * and its protocol is S3.
   */
  protocol?: string;
  /**
   * More modules that make a file worth reading, beyond the ones the
   * chains match on. A helper imported by a relative path does not open
   * the import gate, so the pack lists the library the helper imports.
   */
  requiresImport?: string[];
  /**
   * Recognizers written against the adapter directly, run alongside the
   * declared chains. A pack moving to chains one call at a time keeps
   * the calls it has not declared yet here, and a call no ending can
   * describe stays here for good. The pack health report counts these
   * as function links, so a reader sees how many are left.
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
 * well as templates, so a chain over statements is dispatched there
 * whether the source wrote a call or a template.
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
 * Describes a set of chains for the pack health report, for a pack that
 * builds its `PatternPack` by hand. A pack partway through moving to
 * declared chains keeps hand-written recognizers beside them, and this
 * reports on the part that has moved.
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
 * The name a declaration gets in the pack health report. A storage
 * chain goes by its store, because one wire can reach several stores.
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
 * Every origin a chain states: where its match starts, and, for a chain
 * about a command, the module that command was imported from. A file
 * that imports none of these modules cannot match the chain.
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

/** A question a pack settled with a function, and whether it reads the tree. */
interface WrittenAsCode {
  asks: string;
  reachesAst: boolean;
}

/** One chain, counted the way the pack health report counts it. */
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
    // A method table with a rule inside still counts as a data link. The
    // rule is counted on its own, as a function link.
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

/** The questions a rule inside a method's meaning settles, one per entry. */
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
 * the chain found or a value it pointed itself at. Both forms are
 * functions and both are counted, so moving a pack from one form to the
 * other does not hide the rule from the pack health report.
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
