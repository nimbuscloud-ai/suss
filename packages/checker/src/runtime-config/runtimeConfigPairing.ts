// runtimeConfigPairing.ts: pair runtime-config provider summaries
// (CFN/SAM Lambda env-var declarations, ECS task definitions, etc.)
// against config reads in source files within the runtime's declared
// codeScope: `process.env.X` in a Node process, `env.X` on an edge
// worker, whichever pack recognized them.
//
// Three findings:
//   - envVarUnprovided   (error)  : code reads X, runtime doesn't supply
//   - envVarUnused       (warning): runtime supplies X, no code reads
//   - runtimeScopeUnknown (info)  : we could not tell which code the
//                                    runtime runs, so nothing was paired
//
// Soundness: a read pairs against the runtime it runs in, which the
// deployable unit on each side says. Code that gives no unit falls back
// to the runtime's `metadata.codeScope.path`, and only where one
// runtime's path contains it. A service that builds every function from
// the same directory offers that path for all of them, so taking it
// would accuse one read in every function at once.
//
// Ambiguity stops both accusations. A read the directory cannot place
// still counts as somebody reading the variable, so the pass does not
// turn round and tell a runtime that nothing reads what it declares.
//
// The runtime-config boundary collapses two links of a chain: the
// CFN/SAM service ↔ runtime contract, and the runtime ↔ process
// contract: because for pairing purposes the chain is transitive
// (template promises X → runtime gets X → process sees X). The
// stub layer that builds these provider summaries is responsible for
// folding in platform-injected vars (AWS_REGION, etc.) so the
// `provided` set the pairing checks against here is the FULL set the
// process actually receives, not just the template-declared subset.

import {
  type LibraryEnvReads,
  readLibraryEnvReads,
  readRuntimeContractMetadata,
  summaryIdentifier,
} from "@suss/behavioral-ir";
import { fileInCodeScope } from "@suss/ir-core";

import { makeSide } from "../coverage/responseMatch.js";
import { contestedFiles, runsIn, unitsByFile } from "../scope/unitScope.js";
import { isRuntimeConfigProvider, placeRuntimes } from "./placement.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  EnvVarSource,
  Finding,
  RuntimeConfigSemantics,
} from "@suss/behavioral-ir";
import type {
  InteractionIndex,
  InteractionRecord,
} from "../interactions/dispatcher.js";
import type { ComparedPair } from "../pairing/comparedPair.js";
import type { UnitsByFile } from "../scope/unitScope.js";
import type { PlacedRuntime } from "./placement.js";

interface ScopedRuntime {
  runtime: BehavioralSummary;
  binding: BoundaryBinding;
  provided: string[];
  sources: Record<string, EnvVarSource>;
  /**
   * Names read by code under this runtime's directory, whether or not
   * the code could be placed in this runtime. A variable one of them
   * reads is not a variable nothing reads.
   */
  readNames: Set<string>;
}

interface EnvVarRead {
  name: string;
  /** The summary whose effects mentioned the read. */
  summary: BehavioralSummary;
  /** ID of the transition the read appeared in (for finding location). */
  transitionId: string;
  /** The code supplies a fallback, so an absent value is not a defect. */
  defaulted: boolean;
}

/**
 * Run the runtime-config pairing pass over every summary in the set.
 * Provider runtimes pair against in-scope code reads; findings record
 * the boundary the runtime exposes and the consumer summary the read
 * lives in.
 */
export function checkRuntimeConfig(
  summaries: BehavioralSummary[],
  // Optional pre-built index; the standalone path builds its own.
  // Passing the index lets `checkAll` share one walk across all
  // per-class pairing passes.
  index?: InteractionIndex,
  /** Where to record what this pass compared; see `ComparedPair`. */
  compared?: ComparedPair[],
): Finding[] {
  const findings: Finding[] = [];

  const byFile = unitsByFile(summaries);
  // Index the read sites once so each provider doesn't re-scan the
  // full summary set. Code summaries are everything that ISN'T a
  // runtime-config provider; runtime-config providers don't read env
  // vars themselves (they declare the contract).
  const collected = collectEnvVarReads(
    summaries.filter((s) => !isRuntimeConfigProvider(s)),
    index,
  );
  const codeReads = collected.reads;

  const placement = placeRuntimes(summaries);
  for (const { runtime, binding } of placement.unplaced) {
    findings.push(makeScopeUnknownFinding(runtime, binding));
  }
  const placed = placement.placed;

  const contested = contestedFiles(
    codeReads.map((r) => r.summary),
    placed.map((p) => p.scope),
    byFile,
  );

  const scoped: ScopedRuntime[] = [];
  for (const { runtime, binding, scope } of placed) {
    const inScope = codeReads.filter((r) => runsIn(r.summary, scope, byFile));
    const provided = readProvidedEnvVars(runtime);
    const providedSet = new Set(provided);
    recordCompared(compared, runtime, binding, inScope);

    // envVarUnprovided: one finding per (read site, var); the deduper
    // collapses identical ones later. A read with a fallback is
    // undeclared on purpose and accuses nothing.
    for (const read of inScope) {
      if (
        read.defaulted ||
        providedSet.has(read.name) ||
        contested.has(read.summary.location.file)
      ) {
        continue;
      }
      findings.push(makeUnprovidedFinding(runtime, binding, read));
    }

    scoped.push({
      runtime,
      binding,
      provided,
      sources: readEnvVarSources(runtime),
      readNames: new Set(inScope.map((r) => r.name)),
    });
  }

  // Dynamic imports and require calls are not in the module graph, so
  // a read outside every closure may still run. Counting the name as
  // read everywhere keeps the unused accusation away from it.
  for (const name of unclaimedReadNames(codeReads, placed, byFile)) {
    for (const s of scoped) {
      s.readNames.add(name);
    }
  }

  // A pack-declared library reads its variables from inside
  // node_modules, so a declared name a marker covers counts as read.
  const markers = summaries
    .map(readLibraryEnvReads)
    .filter((m): m is LibraryEnvReads => m !== undefined);
  if (markers.length > 0) {
    for (const s of scoped) {
      for (const name of s.provided) {
        if (markers.some((m) => libraryReads(m, name))) {
          s.readNames.add(name);
        }
      }
    }
  }

  findings.push(...unusedFindings(scoped, collected.sawConfigReadEffect));
  findings.push(...contestedFindings(codeReads, contested, placed, byFile));

  return findings;
}

/**
 * One entry per file whose reads this runtime was asked about, not one
 * per variable: a file reading four variables was compared once.
 */
function recordCompared(
  compared: ComparedPair[] | undefined,
  runtime: BehavioralSummary,
  binding: BoundaryBinding,
  inScope: EnvVarRead[],
): void {
  if (compared === undefined) {
    return;
  }
  const semantics = binding.semantics;
  const key =
    semantics.name === "runtime-config"
      ? `runtime-config:${semantics.instanceName}`
      : `runtime-config:${runtime.identity.name}`;
  const provider = summaryIdentifier(runtime);
  const seen = new Set<string>();
  for (const read of inScope) {
    const consumer = summaryIdentifier(read.summary);
    if (seen.has(consumer)) {
      continue;
    }
    seen.add(consumer);
    compared.push({ key, provider, consumer });
  }
}

function libraryReads(marker: LibraryEnvReads, name: string): boolean {
  if (marker.names?.includes(name) === true) {
    return true;
  }
  return marker.prefixes?.some((prefix) => name.startsWith(prefix)) === true;
}

/**
 * Names read in files that sit under a placed runtime's directory but
 * inside none of their scopes, which can only happen once a closure
 * narrows a scope below its directory.
 */
function unclaimedReadNames(
  codeReads: EnvVarRead[],
  placed: PlacedRuntime[],
  byFile: UnitsByFile,
): Set<string> {
  const names = new Set<string>();
  if (!placed.some((p) => p.scope.closure !== undefined)) {
    return names;
  }

  for (const read of codeReads) {
    const file = read.summary.location.file;
    if (
      read.summary.identity.deployableUnit !== undefined ||
      byFile.has(file)
    ) {
      continue;
    }

    const underSomeDirectory = placed.some((p) =>
      fileInCodeScope(file, p.scope.codeScope),
    );
    const inSomeScope = placed.some((p) =>
      runsIn(read.summary, p.scope, byFile),
    );
    if (underSomeDirectory && !inSomeScope) {
      names.add(read.name);
    }
  }
  return names;
}

/**
 * One finding per summary whose reads went unpaired because several
 * runtimes declare a directory that contains its file. It says what
 * could not be worked out, and blames nothing in the code.
 */
/**
 * Joins a document path to a variable name for a set key. The ASCII
 * unit separator cannot appear in either half, so the two can never
 * run together.
 */
const DOCUMENT_NAME_SEPARATOR = "\u001f";

function contestedFindings(
  codeReads: EnvVarRead[],
  contested: ReadonlySet<string>,
  placed: PlacedRuntime[],
  byFile: UnitsByFile,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<BehavioralSummary>();
  for (const read of codeReads) {
    if (!contested.has(read.summary.location.file) || seen.has(read.summary)) {
      continue;
    }
    seen.add(read.summary);
    const candidates = placed.filter((p) =>
      runsIn(read.summary, p.scope, byFile),
    );
    if (candidates.length === 0) {
      continue;
    }
    findings.push(makeContestedScopeFinding(candidates, read.summary));
  }
  return findings;
}

/**
 * envVarUnused: one finding per (runtime, var) declared but never
 * read. Two kinds of declaration are exempt. A var the platform
 * injects (AWS_REGION and the rest) is part of the runtime contract
 * whether or not code reads it. A var a document-level default
 * supplies is a claim about the document, so it is judged over every
 * runtime the document declares and reported once, against the first
 * of them.
 */
function unusedFindings(
  scoped: ScopedRuntime[],
  sawConfigReadEffect: boolean,
): Finding[] {
  // No summary in this run has a config-read effect, so either nothing
  // reads the environment or the run never included the recognizer that
  // records reads. Claiming per variable that no code reads it would be
  // wrong in the second case, so one finding says what is missing.
  if (!sawConfigReadEffect) {
    return recognizerAbsentFindings(scoped);
  }
  const findings: Finding[] = [];
  const readPerDocument = readNamesPerDocument(scoped);
  const reported = new Set<string>();

  for (const entry of scoped) {
    const document = entry.runtime.location.file;
    for (const name of entry.provided) {
      if (entry.readNames.has(name) || entry.sources[name] === "platform") {
        continue;
      }
      if (entry.sources[name] !== "globals") {
        findings.push(makeUnusedFinding(entry.runtime, entry.binding, name));
        continue;
      }
      const key = `${document}${DOCUMENT_NAME_SEPARATOR}${name}`;
      const readHere = readPerDocument.get(document) ?? new Set<string>();
      // A document whose runtimes matched no code at all cannot say
      // that nothing reads the variable, so it says nothing either way.
      if (readHere.size === 0 || readHere.has(name)) {
        continue;
      }
      if (reported.has(key)) {
        continue;
      }
      reported.add(key);
      findings.push(
        makeDocumentUnusedFinding(entry.runtime, entry.binding, name),
      );
    }
  }

  return findings;
}

function readNamesPerDocument(
  scoped: ScopedRuntime[],
): Map<string, Set<string>> {
  const perDocument = new Map<string, Set<string>>();
  for (const entry of scoped) {
    const document = entry.runtime.location.file;
    const names = perDocument.get(document) ?? new Set<string>();
    for (const name of entry.readNames) {
      names.add(name);
    }
    perDocument.set(document, names);
  }
  return perDocument;
}

function readProvidedEnvVars(summary: BehavioralSummary): string[] {
  return readRuntimeContractMetadata(summary)?.envVars ?? [];
}

function readEnvVarSources(
  summary: BehavioralSummary,
): Record<string, EnvVarSource> {
  return readRuntimeContractMetadata(summary)?.envVarSources ?? {};
}

/**
 * Walk every transition's effects looking for `interaction(class:
 * "config-read")` records: the unified shape emitted by
 * `@suss/runtime-node`'s env-var recognizer (and any future
 * config-source recognizer like dotenv). Each record has the
 * env-var name directly; no arg-walking required.
 *
 * Falls back to scanning invocation effect args for the
 * `process.env.X` identifier pattern when no config-read effects are
 * present. This keeps the pairing pass working on summaries
 * extracted before the env-var recognizer existed (or when the
 * node runtime pack isn't in the framework list).
 */
function lookupConfigReads(
  index: InteractionIndex,
): InteractionRecord<"config-read">[] {
  // Inline import-style lookup avoids adding a top-level import; keeps
  // the dispatcher dependency local to this file's helpers.
  const byClass = index.interactionsByClass.get("config-read");
  if (byClass === undefined) {
    return [];
  }
  // config-read interactions can come with any binding semantics in
  // theory, but in practice it's always runtime-config. Flatten the
  // semantics buckets so callers don't need to know about that.
  const out: InteractionRecord<"config-read">[] = [];
  for (const records of byClass.values()) {
    for (const record of records) {
      out.push(record as InteractionRecord<"config-read">);
    }
  }
  return out;
}

function collectEnvVarReads(
  summaries: BehavioralSummary[],
  index?: InteractionIndex,
): { reads: EnvVarRead[]; sawConfigReadEffect: boolean } {
  const reads: EnvVarRead[] = [];
  let sawConfigReadEffect = false;
  // Fast path: when an index is available, query the config-read
  // slice directly instead of walking every transition's effects.
  // Filters by summary identity to keep behavior identical to the
  // walk path (excludes runtime-config providers, since they're
  // already filtered out by the caller).
  if (index !== undefined) {
    const allReads = lookupConfigReads(index);
    const summarySet = new Set(summaries);
    for (const record of allReads) {
      if (!summarySet.has(record.summary)) {
        continue;
      }
      sawConfigReadEffect = true;
      reads.push({
        name: record.effect.interaction.name,
        summary: record.summary,
        transitionId: record.transitionId,
        defaulted: record.effect.interaction.defaulted === true,
      });
    }
  } else {
    for (const summary of summaries) {
      for (const transition of summary.transitions) {
        for (const effect of transition.effects) {
          if (
            effect.type === "interaction" &&
            effect.interaction.class === "config-read"
          ) {
            sawConfigReadEffect = true;
            reads.push({
              name: effect.interaction.name,
              summary,
              transitionId: transition.id,
              defaulted: effect.interaction.defaulted === true,
            });
          }
        }
      }
    }
  }
  // Backward-compat fallback: when no config-read effects exist on
  // any summary in the set, fall back to the legacy invocation-arg
  // scan. Once the process-env recognizer is wired into the dogfood
  // and integration paths, this branch becomes dead and can be
  // removed.
  if (sawConfigReadEffect) {
    return { reads, sawConfigReadEffect };
  }
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation") {
          continue;
        }
        collectFromInvocationLegacy(effect, summary, transition.id, reads);
      }
    }
  }
  return { reads, sawConfigReadEffect };
}

function collectFromInvocationLegacy(
  effect: Extract<Effect, { type: "invocation" }>,
  summary: BehavioralSummary,
  transitionId: string,
  out: EnvVarRead[],
): void {
  for (const arg of effect.args) {
    collectFromArgLegacy(arg, summary, transitionId, out);
  }
}

function collectFromArgLegacy(
  arg: unknown,
  summary: BehavioralSummary,
  transitionId: string,
  out: EnvVarRead[],
): void {
  if (typeof arg !== "object" || arg === null) {
    return;
  }
  const obj = arg as { kind?: string; name?: string; args?: unknown[] };
  if (obj.kind === "identifier" && typeof obj.name === "string") {
    const match = obj.name.match(/^process\.env\.(\w+)$/);
    if (match !== null) {
      out.push({ name: match[1], summary, transitionId, defaulted: false });
    }
    return;
  }
  if (obj.kind === "call" && Array.isArray(obj.args)) {
    for (const sub of obj.args) {
      collectFromArgLegacy(sub, summary, transitionId, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function instanceLabel(semantics: RuntimeConfigSemantics): string {
  return `${semantics.deploymentTarget}/${semantics.instanceName}`;
}

/**
 * How code on each deployment medium spells a read. A Node process
 * reaches for `process.env`; an edge worker is handed its configuration
 * as an argument, and a finding that told its author to look at
 * `process.env` would send them somewhere that does not exist.
 */
const CONFIG_READ_PREFIX: Record<
  RuntimeConfigSemantics["deploymentTarget"],
  string
> = {
  lambda: "process.env.",
  "ecs-task": "process.env.",
  container: "process.env.",
  "k8s-deployment": "process.env.",
  worker: "env.",
};

function readSpelling(semantics: RuntimeConfigSemantics, name: string): string {
  return `${CONFIG_READ_PREFIX[semantics.deploymentTarget]}${name}`;
}

function makeUnprovidedFinding(
  runtime: BehavioralSummary,
  binding: BoundaryBinding,
  read: EnvVarRead,
): Finding {
  const semantics = binding.semantics as RuntimeConfigSemantics;
  return {
    kind: "boundaryFieldUnknown",
    aspect: "read",
    boundary: binding,
    provider: makeSide(runtime),
    consumer: makeSide(read.summary, read.transitionId),
    description: `${readSpelling(semantics, read.name)} read by ${read.summary.identity.name} (${instanceLabel(semantics)} scope) but ${semantics.instanceName} declares no ${read.name} in its environment. At runtime this resolves to undefined, changing which execution paths the function takes.`,
    severity: "error",
  };
}

/**
 * One finding per document whose runtimes declare variables, saying the run
 * recorded no environment read anywhere rather than judging each variable.
 */
function recognizerAbsentFindings(scoped: ScopedRuntime[]): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const entry of scoped) {
    const document = entry.runtime.location.file;
    const declared = entry.provided.filter(
      (name) => entry.sources[name] !== "platform",
    );
    if (declared.length === 0 || reported.has(document)) {
      continue;
    }
    reported.add(document);
    findings.push({
      kind: "boundaryFieldUnused",
      boundary: entry.binding,
      provider: makeSide(entry.runtime),
      consumer: makeSide(entry.runtime),
      description: `${document} declares environment variables and these summaries record no environment read anywhere, so whether code reads them was not checked. If the code reads process.env, extract with the node pack in the framework list (-f node) so the reads are in the summaries.`,
      severity: "info",
    });
  }
  return findings;
}

function makeUnusedFinding(
  runtime: BehavioralSummary,
  binding: BoundaryBinding,
  varName: string,
): Finding {
  const semantics = binding.semantics as RuntimeConfigSemantics;
  return {
    kind: "boundaryFieldUnused",
    boundary: binding,
    provider: makeSide(runtime),
    // No code consumer to point at; reuse the runtime side so the
    // schema's required `consumer` field is satisfied without
    // inventing a phantom location.
    consumer: makeSide(runtime),
    description: `${semantics.instanceName} declares environment variable ${varName} but no code in its codeScope reads ${readSpelling(semantics, varName)}.`,
    severity: "warning",
  };
}

function makeDocumentUnusedFinding(
  runtime: BehavioralSummary,
  binding: BoundaryBinding,
  varName: string,
): Finding {
  return {
    kind: "boundaryFieldUnused",
    boundary: binding,
    // The declaration belongs to the document rather than to any one
    // runtime, and a finding needs two sides, so it is reported
    // against the first runtime the document declares.
    provider: makeSide(runtime),
    consumer: makeSide(runtime),
    description: `${runtime.location.file} declares environment variable ${varName} for every runtime it holds, and no code in any of their codeScopes reads process.env.${varName}.`,
    severity: "warning",
  };
}

/**
 * Where the candidate runtimes were declared, for a reader who wants to
 * go and narrow one of them. A stack that embeds others spreads its
 * runtimes over more templates than anyone wants listed in a sentence,
 * so past one it only says how many.
 */
function whereDeclared(candidates: PlacedRuntime[]): string {
  const files = new Set(candidates.map((c) => c.runtime.location.file));
  if (files.size === 1) {
    return `in ${[...files][0]}`;
  }
  return `across ${files.size} templates`;
}

function makeContestedScopeFinding(
  candidates: PlacedRuntime[],
  code: BehavioralSummary,
): Finding {
  // A finding needs a boundary and there are several, so it uses the
  // first candidate's and counts the rest in its description.
  const representative = candidates[0];
  return {
    kind: "runtimeScopeUnknown",
    boundary: representative.binding,
    provider: makeSide(representative.runtime),
    consumer: makeSide(code),
    description: `${candidates.length} runtimes declared ${whereDeclared(candidates)} name a source directory holding ${code.location.file}, and nothing says which of them runs ${code.identity.name}, so its process.env reads were checked against none of them. Discovering ${code.identity.name} under a template entry, or giving each runtime a CodeUri of its own, would place it.`,
    severity: "info",
  };
}

function makeScopeUnknownFinding(
  runtime: BehavioralSummary,
  binding: BoundaryBinding,
): Finding {
  const semantics = binding.semantics as RuntimeConfigSemantics;
  return {
    kind: "runtimeScopeUnknown",
    boundary: binding,
    provider: makeSide(runtime),
    consumer: makeSide(runtime),
    description: `${semantics.instanceName} (${semantics.deploymentTarget}) has no codeScope; cannot verify whether code in this runtime reads its declared environment variables. Add Metadata.SussCodeScope to the resource (or use SAM CodeUri) to enable env-var pairing.`,
    severity: "info",
  };
}
