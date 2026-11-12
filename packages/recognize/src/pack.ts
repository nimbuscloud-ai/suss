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

import {
  type CompileOptions,
  compile,
  compileSubUnits,
  modulesOfChain,
} from "./compile.js";

import type {
  DeclaredDiscoveryPattern,
  DeclaredMatch,
  GeneratedModuleSpec,
  InvocationRecognizer,
  PackDeclarations,
  ParameterSupplier,
  PatternPack,
  ProjectHelpers,
} from "@suss/extractor";
import type {
  ArgumentPick,
  CallsLink,
  Chain,
  ContainerRule,
  Ending,
  InputRule,
  Link,
  MethodMeaning,
  MethodsLink,
  RelationsLink,
  StatedRule,
  StorageMethod,
  StorageSystem,
} from "./chain.js";

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
  /**
   * Parameter decorators whose call is the value a container passes in,
   * so a chain can start from the decorator a parameter was written with.
   */
  parameterSuppliers?: ParameterSupplier[];
  /** Where this library's generator writes a copy of its module into the project. */
  generatedModules?: GeneratedModuleSpec;
  /**
   * Files under the project this pack reads that are not source files.
   * The extraction cache keys on their content.
   */
  discoveryInputs?: (files: readonly string[]) => string[];
}

/** One of the two walks an adapter dispatches recognizers on. */
type Walk = "invocation" | "access";

/**
 * Which walk a chain is dispatched on.
 *
 * A statement written as a tagged template is not an invocation, so the
 * invocation walk never reaches it. The access walk visits calls as
 * well as templates, so a chain over statements is dispatched there
 * whether the source wrote a call or a template, unless the chain says
 * its statements are always a call's argument.
 */
const DISPATCHED_ON: ByEnding<Walk> = {
  storageAccess: () => "invocation",
  sqlAccess: (ending) => ending.walk ?? "access",
  messageSend: () => "invocation",
  unitInvoke: () => "invocation",
  schedule: () => "invocation",
  streamWrite: () => "invocation",
  runtimeRead: () => "access",
};

/** The walk a chain is dispatched on. */
function walkOf(chain: Chain<MethodMeaning>): Walk {
  return byEnding(DISPATCHED_ON, chain.ending);
}

/** The chains a pack dispatches on one of the two walks. */
function walkedBy(
  chains: readonly Chain<MethodMeaning>[],
  walk: Walk,
  recognizedAs: string,
): InvocationRecognizer[] {
  return chains
    .filter((chain) => walkOf(chain) === walk)
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
  const subUnits = compileSubUnits(chains);

  return {
    name,
    languages: spec.languages,
    ...passedThrough(spec),
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
    ...(subUnits === null ? {} : { subUnits }),
    declarations: declarationsIn(matches),
  };
}

/** What a spec states that the pack takes as it is. */
const PASSED_THROUGH = [
  "version",
  "projectHelpers",
  "parameterSuppliers",
  "generatedModules",
  "discoveryInputs",
] as const;

type PassedThrough = (typeof PASSED_THROUGH)[number];

/** The fields of `PASSED_THROUGH` the spec states, and none it leaves out. */
function passedThrough(spec: PackSpec): Pick<PatternPack, PassedThrough> {
  const stated = PASSED_THROUGH.filter((field) => spec[field] !== undefined);
  return Object.fromEntries(
    stated.map((field) => [field, spec[field]]),
  ) as Pick<PatternPack, PassedThrough>;
}

/**
 * The `subUnits` hook for a set of chains, for a pack that builds its
 * `PatternPack` by hand. It is the hook `pack()` gives a pack whose
 * chains claim a callback, and it claims nothing when none of them says
 * what a callback written in place becomes.
 */
export function subUnitsOf(
  matches: readonly Match[],
  options: CompileOptions = {},
): NonNullable<PatternPack["subUnits"]> {
  return (
    compileSubUnits(
      matches.map((match) => match.declared),
      options,
    ) ?? NO_CLAIMS
  );
}

const NO_CLAIMS: NonNullable<PatternPack["subUnits"]> = () => [];

/**
 * Describes a set of chains for the pack health report, for a pack that
 * builds its `PatternPack` by hand. A pack partway through moving to
 * declared chains keeps hand-written recognizers beside them, and this
 * reports on the part that has moved.
 */
export function declarationsIn(matches: readonly Match[]): PackDeclarations {
  return { declarations: matches.map((match) => describe(match.declared)) };
}

/**
 * Describes a declared discovery pattern for the pack health report. A
 * field the pack answered with a function, such as a manifest's
 * `entries`, counts as a function link, and every other field as data.
 */
export function describeDiscovery(
  pattern: DeclaredDiscoveryPattern,
): DeclaredMatch {
  const fields = Object.entries(pattern.match).filter(
    ([field]) => field !== "type",
  );
  const functions = fields.filter(([, value]) => typeof value === "function");
  return {
    name: pattern.match.type,
    dataLinks: fields.length - functions.length,
    functionLinks: functions.map(([field]) => field),
    astLinks: [],
    example: null,
  };
}

/** The wire one chain reaches over, whichever ending it has. */
function wireOf(ending: Ending): string {
  return byEnding(WIRE, ending);
}

/** One function per kind of ending, each handed that kind. */
type ByEnding<T> = {
  readonly [K in Ending["yields"]]: (
    ending: Extract<Ending, { yields: K }>,
  ) => T;
};

function byEnding<T>(table: ByEnding<T>, ending: Ending): T {
  return (table[ending.yields] as (ending: Ending) => T)(ending);
}

/**
 * A callback runs in the same process as the call that hands it over,
 * and a process writes its own streams and reads its own runtime.
 */
const WIRE: ByEnding<string> = {
  storageAccess: (ending) => ending.transport ?? systemNamed(ending.system),
  sqlAccess: (ending) => ending.transport ?? systemNamed(ending.system),
  messageSend: (ending) => ending.wire,
  unitInvoke: (ending) => ending.platform,
  schedule: () => "in-process",
  streamWrite: () => "in-process",
  runtimeRead: () => "in-process",
};

/**
 * The name a declaration gets in the pack health report. A storage
 * chain goes by its store, because one wire can reach several stores.
 */
function declaredName(ending: Ending): string {
  return byEnding(DECLARED_NAME, ending);
}

/**
 * The store a chain states, or the one it falls back to when the store
 * is read per project, since no one store is the chain's until a call's
 * file says.
 */
function systemNamed(system: StorageSystem): string {
  return typeof system === "string" ? system : system.otherwise;
}

const DECLARED_NAME: ByEnding<string> = {
  storageAccess: (ending) => systemNamed(ending.system),
  sqlAccess: (ending) => systemNamed(ending.system),
  messageSend: (ending) => ending.wire,
  unitInvoke: (ending) => ending.platform,
  schedule: (ending) => ending.yields,
  streamWrite: (ending) => ending.yields,
  runtimeRead: (ending) => ending.yields,
};

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
  return [...new Set(chains.flatMap((chain) => modulesOfChain(chain)))];
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
      reachesAst: ruleOf(link).reachesAst === true,
    })),
    ...rulesIn(chain),
    ...systemRulesIn(chain.ending),
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

/** A link a pack wrote as code: a container rule, or the rule that reads a call's relations. */
type FunctionLink = ContainerRule | RelationsLink;

/** Whether a pack wrote this link as code. */
function isFunctionLink(link: Link<MethodMeaning>): link is FunctionLink {
  return (
    (link.asks === "container" && "from" in link) || link.asks === "relations"
  );
}

function ruleOf(link: FunctionLink): { reachesAst?: boolean } {
  return "from" in link ? link.from : link.by;
}

/** The questions each ending can settle per project, and what it says for each. */
const SYSTEMS_ASKED: ByEnding<readonly (readonly [string, StorageSystem])[]> = {
  storageAccess: (ending) => [["system", ending.system]],
  sqlAccess: (ending) => [
    ["system", ending.system],
    ["dialect", ending.dialect],
  ],
  messageSend: () => [],
  unitInvoke: () => [],
  schedule: () => [],
  streamWrite: () => [],
  runtimeRead: () => [],
};

/** The questions an ending settles with a rule over the call's file rather than as data. */
function systemRulesIn(ending: Ending): WrittenAsCode[] {
  return byEnding(SYSTEMS_ASKED, ending).flatMap(([asks, system]) =>
    typeof system === "string"
      ? []
      : [{ asks, reachesAst: system.byFile.reachesAst === true }],
  );
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
