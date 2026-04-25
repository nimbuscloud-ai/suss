// runtimeConfigPairing.ts — pair runtime-config provider summaries
// (CFN/SAM Lambda env-var declarations, ECS task definitions, etc.)
// against code reads of `process.env.X` from source files within the
// runtime's declared codeScope.
//
// Three findings:
//   - envVarUnprovided   (error)   — code reads X, runtime doesn't supply
//   - envVarUnused       (warning) — runtime supplies X, no code reads
//   - runtimeScopeUnknown (info)   — runtime has no codeScope; can't pair
//
// Soundness: pairing is keyed on file-path prefix matching against the
// runtime's `metadata.codeScope.path`. Multi-attribution is intentional
// — a shared util file included in two Lambdas pairs against both.

import { makeSide } from "../coverage/responseMatch.js";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Effect,
  Finding,
  RuntimeConfigSemantics,
} from "@suss/behavioral-ir";

interface RuntimeContractMetadata {
  envVars?: string[];
}

interface CodeScopeMetadata {
  kind: "codeUri" | "unknown";
  path?: string;
}

interface EnvVarRead {
  name: string;
  /** The summary whose effects mentioned the read. */
  summary: BehavioralSummary;
  /** ID of the transition the read appeared in (for finding location). */
  transitionId: string;
}

/**
 * Run the runtime-config pairing pass over every summary in the set.
 * Provider runtimes pair against in-scope code reads; findings record
 * the boundary the runtime exposes and the consumer summary the read
 * lives in.
 */
export function checkRuntimeConfig(summaries: BehavioralSummary[]): Finding[] {
  const findings: Finding[] = [];

  const runtimes = summaries.filter(isRuntimeConfigProvider);
  // Index the read sites once so each provider doesn't re-scan the
  // full summary set. Code summaries are everything that ISN'T a
  // runtime-config provider; runtime-config providers don't read env
  // vars themselves (they declare the contract).
  const codeReads = collectEnvVarReads(
    summaries.filter((s) => !isRuntimeConfigProvider(s)),
  );

  for (const runtime of runtimes) {
    const codeScope = readCodeScope(runtime);
    const provided = readProvidedEnvVars(runtime);
    const binding = runtime.identity.boundaryBinding;
    if (binding === null) {
      // Defensive: a runtime-config provider without a boundaryBinding
      // shouldn't exist (the type-narrow above guarantees one). Skip
      // rather than crash.
      continue;
    }

    if (codeScope.kind === "unknown" || codeScope.path === undefined) {
      findings.push(makeScopeUnknownFinding(runtime, binding));
      continue;
    }

    const inScope = codeReads.filter((r) =>
      r.summary.location.file.startsWith(codeScope.path ?? ""),
    );
    const readNames = new Set(inScope.map((r) => r.name));
    const providedSet = new Set(provided);

    // envVarUnprovided — one finding per (read site, var). Multiple
    // reads of the same undeclared var across files emit multiple
    // findings; the deduper later collapses identical ones.
    for (const read of inScope) {
      if (providedSet.has(read.name)) {
        continue;
      }
      findings.push(makeUnprovidedFinding(runtime, binding, read));
    }

    // envVarUnused — one finding per (runtime, var) declared but
    // never read. The "consumer" side here is the runtime itself
    // (degenerate; no code consumer to point at).
    for (const provName of provided) {
      if (readNames.has(provName)) {
        continue;
      }
      findings.push(makeUnusedFinding(runtime, binding, provName));
    }
  }

  return findings;
}

function isRuntimeConfigProvider(summary: BehavioralSummary): boolean {
  return summary.identity.boundaryBinding?.semantics.name === "runtime-config";
}

function readCodeScope(summary: BehavioralSummary): CodeScopeMetadata {
  const raw = (summary.metadata?.codeScope ?? null) as CodeScopeMetadata | null;
  if (raw === null) {
    return { kind: "unknown" };
  }
  return raw;
}

function readProvidedEnvVars(summary: BehavioralSummary): string[] {
  const contract = summary.metadata?.runtimeContract as
    | RuntimeContractMetadata
    | undefined;
  return contract?.envVars ?? [];
}

/**
 * Walk every transition's effects looking for invocation calls whose
 * args reference `process.env.X`. The Gap 5b extractor work emits
 * those references as `EffectArg.identifier { name: "process.env.X" }`.
 * Other transit-time mentions of env vars (in conditions, in
 * non-invocation effects) are skipped — they're rare and the dominant
 * signal is the invocation arg pattern.
 */
function collectEnvVarReads(summaries: BehavioralSummary[]): EnvVarRead[] {
  const reads: EnvVarRead[] = [];
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "invocation") {
          continue;
        }
        collectFromEffect(effect, summary, transition.id, reads);
      }
    }
  }
  return reads;
}

function collectFromEffect(
  effect: Extract<Effect, { type: "invocation" }>,
  summary: BehavioralSummary,
  transitionId: string,
  out: EnvVarRead[],
): void {
  for (const arg of effect.args) {
    collectFromArg(arg, summary, transitionId, out);
  }
}

function collectFromArg(
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
      out.push({ name: match[1], summary, transitionId });
    }
    return;
  }
  // Recurse through `call` arg variants — `log(formatError(process.env.X))`
  // hides the read inside a nested call. Bounded by the args' own
  // recursion depth from the extractor's argument-shape capture.
  if (obj.kind === "call" && Array.isArray(obj.args)) {
    for (const sub of obj.args) {
      collectFromArg(sub, summary, transitionId, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function instanceLabel(semantics: RuntimeConfigSemantics): string {
  return `${semantics.deploymentTarget}/${semantics.instanceName}`;
}

function makeUnprovidedFinding(
  runtime: BehavioralSummary,
  binding: BoundaryBinding,
  read: EnvVarRead,
): Finding {
  const semantics = binding.semantics as RuntimeConfigSemantics;
  return {
    kind: "envVarUnprovided",
    boundary: binding,
    provider: makeSide(runtime),
    consumer: makeSide(read.summary, read.transitionId),
    description: `process.env.${read.name} read by ${read.summary.identity.name} (${instanceLabel(semantics)} scope) but ${semantics.instanceName} declares no ${read.name} in its environment. At runtime this resolves to undefined, changing which execution paths the function takes.`,
    severity: "error",
  };
}

function makeUnusedFinding(
  runtime: BehavioralSummary,
  binding: BoundaryBinding,
  varName: string,
): Finding {
  const semantics = binding.semantics as RuntimeConfigSemantics;
  return {
    kind: "envVarUnused",
    boundary: binding,
    provider: makeSide(runtime),
    // No code consumer to point at; reuse the runtime side so the
    // schema's required `consumer` field is satisfied without
    // inventing a phantom location.
    consumer: makeSide(runtime),
    description: `${semantics.instanceName} declares environment variable ${varName} but no code in its codeScope reads process.env.${varName}.`,
    severity: "warning",
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
