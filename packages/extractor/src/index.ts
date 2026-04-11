// @suss/extractor — assembly engine

import type {
  BehavioralSummary,
  CodeUnitKind,
  Transition,
  Gap,
  ConfidenceInfo,
  Input,
  Predicate,
  Output,
  Effect,
  ValueRef,
} from "@suss/behavioral-ir";

export type { FrameworkPack, DiscoveryPattern, TerminalPattern } from "./framework.js";

export interface RawParameter {
  name: string;
  position: number;
  role: "request" | "response" | "next" | "context" | "param" | "body" | "query" | "generic";
  typeText: string;
}

export interface RawCondition {
  sourceText: string;
  structured: Predicate | null;
  polarity: "positive" | "negative";
  source: "explicit" | "earlyReturn" | "earlyThrow" | "catchBlock";
}

export interface RawTerminal {
  kind: "response" | "throw" | "return" | "void";
  statusCode: { type: "literal"; value: number } | { type: "dynamic"; sourceText: string } | null;
  body: { typeText: string | null; shape: unknown } | null;
  exceptionType: string | null;
  message: string | null;
  location: { start: number; end: number };
}

export interface RawEffect {
  type: "mutation" | "invocation" | "emission" | "stateChange";
  target?: string;
  callee?: string;
  event?: string;
  variable?: string;
}

export interface RawBranch {
  conditions: RawCondition[];
  terminal: RawTerminal;
  effects: RawEffect[];
  location: { start: number; end: number };
  isDefault: boolean;
}

export interface RawDependencyCall {
  name: string;
  assignedTo: string | null;
  async: boolean;
  returnType: string | null;
  location: { start: number; end: number };
}

export interface RawDeclaredContract {
  responses: Array<{ statusCode: number; schemaName?: string; shape?: unknown }>;
}

export interface RawCodeStructure {
  identity: {
    name: string;
    kind: CodeUnitKind;
    file: string;
    range: { start: number; end: number };
    exportName: string;
    exportPath: string[];
  };
  boundaryBinding?: {
    protocol: string;
    method?: string;
    path?: string;
    framework: string;
  };
  parameters: RawParameter[];
  branches: RawBranch[];
  dependencyCalls: RawDependencyCall[];
  declaredContract: RawDeclaredContract | null;
}

export interface ExtractorOptions {
  gapHandling: "strict" | "permissive" | "silent";
}

const DEFAULT_OPTIONS: ExtractorOptions = { gapHandling: "permissive" };

export function terminalToOutput(terminal: RawTerminal): Output {
  if (terminal.kind === "response") {
    const statusCode =
      terminal.statusCode?.type === "literal" ? terminal.statusCode.value : null;
    return { type: "response", statusCode, body: terminal.body };
  }
  if (terminal.kind === "throw") {
    return { type: "throw", exceptionType: terminal.exceptionType, message: terminal.message };
  }
  if (terminal.kind === "void") {
    return { type: "void" };
  }
  return { type: "return", value: terminal.body };
}

export function effectToIR(effect: RawEffect): Effect {
  if (effect.type === "mutation") {
    return { type: "mutation", target: effect.target ?? "unknown", operation: "write" };
  }
  if (effect.type === "invocation") {
    return { type: "invocation", callee: effect.callee ?? "unknown", args: [] };
  }
  if (effect.type === "emission") {
    return { type: "emission", event: effect.event ?? "unknown" };
  }
  return { type: "stateChange", variable: effect.variable ?? "unknown" };
}

export function paramToInput(param: RawParameter): Input {
  return { type: "parameter", name: param.name, position: param.position };
}

export function mapKind(kind: CodeUnitKind): CodeUnitKind {
  return kind;
}

export function detectGaps(
  raw: RawCodeStructure,
  transitions: Transition[],
  options: ExtractorOptions
): Gap[] {
  if (options.gapHandling === "silent") return [];

  const gaps: Gap[] = [];

  if (raw.declaredContract) {
    const producedStatuses = new Set(
      transitions
        .map((t) => (t.output.type === "response" ? (t.output as { type: "response"; statusCode: number | null }).statusCode : null))
        .filter((s): s is number => s !== null)
    );

    for (const declared of raw.declaredContract.responses) {
      if (!producedStatuses.has(declared.statusCode)) {
        gaps.push({
          type: "unhandledCase",
          conditions: [],
          consequence: `HTTP ${declared.statusCode}`,
          description: `Declared response ${declared.statusCode} is never produced by the handler`,
        });
      }
    }
  }

  return gaps;
}

export function assessConfidence(
  raw: RawCodeStructure,
  transitions: Transition[]
): ConfidenceInfo {
  let totalPredicates = 0;
  let opaquePredicates = 0;

  for (const branch of raw.branches) {
    for (const condition of branch.conditions) {
      totalPredicates++;
      if (!condition.structured || condition.structured.type === "opaque") {
        opaquePredicates++;
      }
    }
  }

  const ratio = totalPredicates === 0 ? 0 : opaquePredicates / totalPredicates;
  const level: "high" | "medium" | "low" = ratio === 0 ? "high" : ratio < 0.5 ? "medium" : "low";

  return { source: "predicate-analysis", level };
}

let _transitionCounter = 0;

export function assembleSummary(
  raw: RawCodeStructure,
  options: ExtractorOptions = DEFAULT_OPTIONS
): BehavioralSummary {
  const transitions: Transition[] = raw.branches.map((branch, i) => {
    const conditions: Predicate[] = branch.conditions
      .map((c) => c.structured)
      .filter((p): p is Predicate => p !== null);

    return {
      id: `${raw.identity.name}:${i}`,
      conditions,
      output: terminalToOutput(branch.terminal),
      effects: branch.effects.map(effectToIR),
      location: branch.location,
      isDefault: branch.isDefault,
    };
  });

  const gaps = detectGaps(raw, transitions, options);
  const confidence = assessConfidence(raw, transitions);
  const inputs: Input[] = raw.parameters.map(paramToInput);

  return {
    kind: raw.identity.kind,
    location: {
      file: raw.identity.file,
      range: raw.identity.range,
      exportName: raw.identity.exportName,
    },
    identity: {
      name: raw.identity.name,
      exportPath: raw.identity.exportPath,
      boundaryBinding: raw.boundaryBinding
        ? {
            protocol: raw.boundaryBinding.protocol,
            method: raw.boundaryBinding.method,
            path: raw.boundaryBinding.path,
            framework: raw.boundaryBinding.framework,
          }
        : undefined,
    },
    inputs,
    transitions,
    gaps,
    confidence,
  };
}
