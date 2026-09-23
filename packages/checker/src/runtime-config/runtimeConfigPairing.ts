/**
 * Pairs runtime-config providers, such as a Lambda's declared
 * environment or an ECS task definition, with the config reads in the
 * code each runtime runs: `process.env.X` in Node, `env.X` on a Worker.
 * A read the runtime does not provide is `boundaryFieldUnknown`, a
 * declared variable nothing reads is `boundaryFieldUnused`, and a
 * runtime whose code cannot be placed is `runtimeScopeUnknown`.
 *
 * A read pairs with the runtime its deployable unit says it runs in.
 * Code with no unit falls back to the runtime's code scope, and only
 * when one runtime's scope alone contains the file. The stub layer adds
 * platform variables such as AWS_REGION to what a runtime provides. The
 * runtime-config README covers the rest.
 */

import {
  contestedFiles,
  isRuntimeConfigProvider,
  type LibraryEnvReads,
  placeRuntimes,
  readLibraryEnvReads,
  readRuntimeContractMetadata,
  runsIn,
  summaryIdentifier,
  unitsByFile,
} from "@suss/behavioral-ir";
import { fileInCodeScope } from "@suss/ir-core";

import { makeSide } from "../coverage/responseMatch.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  EnvVarSource,
  Finding,
  PlacedRuntime,
  RuntimeConfigSemantics,
  UnitsByFile,
} from "@suss/behavioral-ir";
import type {
  InteractionIndex,
  InteractionRecord,
} from "../interactions/dispatcher.js";
import type { ComparedPair } from "../pairing/comparedPair.js";

interface ScopedRuntime {
  runtime: BehavioralSummary;
  binding: BoundaryBinding;
  provided: string[];
  sources: Record<string, EnvVarSource>;
  /**
   * Names read by code under this runtime's directory, whether or not
   * the code could be placed in this runtime, so a variable read there
   * is never reported as unused.
   */
  readNames: Set<string>;
}

interface EnvVarRead {
  name: string;
  /** The summary whose effects mentioned the read. */
  summary: BehavioralSummary;
  transitionId: string;
  /** The code supplies a fallback, so an absent value is not a defect. */
  defaulted: boolean;
  /** How the source spelled the read, so a Python finding does not say `process.env`. */
  spelling?: string;
}

/**
 * Run the runtime-config pairing pass over every summary in the set.
 * Provider runtimes pair against in-scope code reads; findings record
 * the boundary the runtime exposes and the consumer summary the read
 * lives in.
 */
export function checkRuntimeConfig(
  summaries: BehavioralSummary[],
  // `checkAll` passes its index so every pairing pass shares one walk.
  index?: InteractionIndex,
  /** Where to record what this pass compared; see `ComparedPair`. */
  compared?: ComparedPair[],
): Finding[] {
  const findings: Finding[] = [];

  const byFile = unitsByFile(summaries);
  // A runtime-config provider declares variables and never reads them,
  // so every other summary counts as code.
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

    // One finding per read site and variable, and dedupe collapses the
    // repeats. A read with a fallback may be left undeclared on purpose.
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
  // a read outside every closure may still run. Its name counts as read
  // everywhere, so it is never reported as unused.
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

    const underSomeDirectory = placed.some(
      (p) =>
        p.scope.codeScope !== undefined &&
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
 * Joins a document path to a variable name for a set key. The ASCII
 * unit separator cannot appear in either half, so the two can never
 * run together.
 */
const DOCUMENT_NAME_SEPARATOR = "\u001f";

/**
 * One finding per summary whose reads went unpaired because several
 * runtimes declare a directory that contains its file. It says what
 * could not be worked out, and blames nothing in the code.
 */
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
 * One `boundaryFieldUnused` per runtime and variable that nothing
 * reads. A variable the platform injects, such as AWS_REGION, is part
 * of the runtime contract and is never reported. A variable that a
 * document-level default supplies is judged over every runtime the
 * document declares, and reported once, against the first of them.
 */
function unusedFindings(
  scoped: ScopedRuntime[],
  sawConfigReadEffect: boolean,
): Finding[] {
  // With no config-read effect in the run, either nothing reads the
  // environment or the recognizer was not run. One finding per document
  // says so, instead of one per variable.
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
      // A document whose runtimes matched no code gives no evidence
      // that the variable goes unread.
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
 * The `config-read` interaction records in the index. Each one has the
 * variable name on it, so no argument needs walking.
 */
function lookupConfigReads(
  index: InteractionIndex,
): InteractionRecord<"config-read">[] {
  const byClass = index.interactionsByClass.get("config-read");
  if (byClass === undefined) {
    return [];
  }
  // Config reads use runtime-config semantics in practice, but the IR
  // allows others, so every semantics bucket is read.
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
  // The index covers every summary, so its records are narrowed to the
  // summaries passed in, which leaves out runtime-config providers.
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
        ...(record.effect.callee === undefined
          ? {}
          : { spelling: record.effect.callee }),
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
              ...(effect.callee === undefined
                ? {}
                : { spelling: effect.callee }),
            });
          }
        }
      }
    }
  }
  // With no config-read effect anywhere, scan call arguments for
  // `process.env.X`, for summaries extracted without the node pack's
  // env-var recognizer.
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

function instanceLabel(semantics: RuntimeConfigSemantics): string {
  return `${semantics.deploymentTarget ?? "runtime"}/${semantics.instanceName ?? "unnamed"}`;
}

/**
 * How code on each deployment target writes a read. A Node process
 * reads `process.env`, and an edge worker gets its configuration as an
 * argument. A finding that told a worker's author to look at
 * `process.env` would point at something that does not exist.
 */
const CONFIG_READ_PREFIX: Record<DeploymentTarget, string> = {
  lambda: "process.env.",
  "ecs-task": "process.env.",
  container: "process.env.",
  "k8s-deployment": "process.env.",
  worker: "env.",
};

type DeploymentTarget = NonNullable<RuntimeConfigSemantics["deploymentTarget"]>;

/**
 * The read as the provider's deployment target writes it. The code at
 * a read does not record its target and the provider does, so the
 * provider's target is used. With none, `process.env` is the usual form.
 */
function readSpelling(semantics: RuntimeConfigSemantics, name: string): string {
  const target = semantics.deploymentTarget;
  const prefix =
    target === undefined ? "process.env." : CONFIG_READ_PREFIX[target];
  return `${prefix}${name}`;
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
    description: `${read.spelling ?? readSpelling(semantics, read.name)} read by ${read.summary.identity.name} (${instanceLabel(semantics)} scope) but ${semantics.instanceName} declares no ${read.name} in its environment. At runtime this resolves to undefined, changing which execution paths the function takes.`,
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
    // No code reads it, so the runtime fills the required consumer side.
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
    description: `${semantics.instanceName} (${semantics.deploymentTarget}) has no codeScope; cannot verify whether code in this runtime reads its declared environment variables. ${whyUnplaced(runtime)}`,
    severity: "info",
  };
}

/**
 * Why nothing placed this runtime, based on what it does declare. For a
 * unit that gives an image or an entry point, the template advice would
 * send the reader somewhere with nothing to change.
 */
function whyUnplaced(runtime: BehavioralSummary): string {
  const contract = readRuntimeContractMetadata(runtime);
  if (contract?.image !== undefined) {
    return `It runs the image ${contract.image}, which is built outside this repository, so no code here is known to be its own.`;
  }
  if (contract?.entryPoint !== undefined) {
    return `Its entry point is ${contract.entryPoint}, which matches no module in this run. Extracting the code the deployment packages would place it.`;
  }
  return "Add Metadata.SussCodeScope to the resource (or use SAM CodeUri) to enable env-var pairing.";
}
