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
  TypeShape,
} from "@suss/behavioral-ir";

export type { FrameworkPack, DiscoveryPattern, TerminalPattern, InputMappingPattern } from "./framework.js";

// =============================================================================
// RawCodeStructure — the interface between language adapters and the engine
// =============================================================================

export interface RawParameter {
  name: string;
  position: number;
  role: string;
  typeText: string | null;
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
  async?: boolean;
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
  framework: string;
  responses: Array<{ statusCode: number; schemaName?: string; shape?: unknown }>;
  params?: Record<string, { type: string; required: boolean }>;
}

export interface RawCodeStructure {
  identity: {
    name: string;
    kind: CodeUnitKind;
    file: string;
    range: { start: number; end: number };
    exportName: string | null;
    exportPath: string[] | null;
  };
  boundaryBinding: {
    protocol: string;
    method?: string;
    path?: string;
    framework: string;
  } | null;
  parameters: RawParameter[];
  branches: RawBranch[];
  dependencyCalls: RawDependencyCall[];
  declaredContract: RawDeclaredContract | null;
}

// =============================================================================
// Extractor options
// =============================================================================

export interface ExtractorOptions {
  gapHandling: "strict" | "permissive" | "silent";
}

const DEFAULT_OPTIONS: ExtractorOptions = { gapHandling: "permissive" };

// =============================================================================
// Core assembly function
// =============================================================================

export function assembleSummary(
  raw: RawCodeStructure,
  options: ExtractorOptions = DEFAULT_OPTIONS
): BehavioralSummary {
  const transitions: Transition[] = raw.branches.map((branch, i) => {
    // Conditions with structured: null become opaque predicates — never silently dropped.
    const conditions: Predicate[] = branch.conditions.map((c) => {
      const pred: Predicate = c.structured !== null
        ? c.structured
        : {
            type: "opaque",
            sourceText: c.sourceText,
            reason: "complexExpression",
          };

      return c.polarity === "negative"
        ? { type: "negation", operand: pred }
        : pred;
    });

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
  const confidence = assessConfidence(raw);
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
      boundaryBinding: raw.boundaryBinding ?? null,
    },
    inputs,
    transitions,
    gaps,
    confidence,
    metadata: raw.declaredContract
      ? { declaredContract: raw.declaredContract }
      : undefined,
  };
}

// =============================================================================
// Gap detection
// =============================================================================

export function detectGaps(
  raw: RawCodeStructure,
  transitions: Transition[],
  options: ExtractorOptions
): Gap[] {
  if (options.gapHandling === "silent") return [];

  const gaps: Gap[] = [];

  if (raw.declaredContract) {
    const producedStatuses = new Set(
      transitions.flatMap((t) => {
        if (t.output.type !== "response") return [];
        const sc = t.output.statusCode;
        if (sc?.type === "literal") return [sc.value as number];
        return [];
      })
    );

    for (const declared of raw.declaredContract.responses) {
      if (!producedStatuses.has(declared.statusCode)) {
        gaps.push({
          type: "unhandledCase",
          conditions: [],
          consequence: "frameworkDefault",
          description: `Declared response ${declared.statusCode} is never produced by the handler`,
        });
      }
    }
  }

  return gaps;
}

// =============================================================================
// Confidence
// =============================================================================

export function assessConfidence(raw: RawCodeStructure): ConfidenceInfo {
  let total = 0;
  let opaque = 0;

  for (const branch of raw.branches) {
    for (const condition of branch.conditions) {
      total++;
      if (!condition.structured || condition.structured.type === "opaque") {
        opaque++;
      }
    }
  }

  const ratio = total === 0 ? 0 : opaque / total;
  const level: "high" | "medium" | "low" =
    ratio === 0 ? "high" : ratio < 0.5 ? "medium" : "low";

  return { source: "inferred_static", level };
}

// =============================================================================
// Mapping helpers
// =============================================================================

const terminalConverters: Record<RawTerminal["kind"], (t: RawTerminal) => Output> = {
  response: (t) => {
    const statusCode: ValueRef | null = t.statusCode
      ? t.statusCode.type === "literal"
        ? { type: "literal", value: t.statusCode.value }
        : { type: "unresolved", sourceText: t.statusCode.sourceText }
      : null;
    const body: TypeShape | null = t.body?.typeText
      ? { type: "ref", name: t.body.typeText }
      : null;
    return { type: "response", statusCode, body, headers: {} };
  },
  throw: (t) => ({
    type: "throw",
    exceptionType: t.exceptionType,
    message: t.message,
  }),
  void: (_t) => ({ type: "void" }),
  return: (_t) => ({ type: "return", value: null }),
};

export function terminalToOutput(terminal: RawTerminal): Output {
  return terminalConverters[terminal.kind](terminal);
}

const effectConverters: Record<RawEffect["type"], (e: RawEffect) => Effect> = {
  mutation: (e) => ({ type: "mutation", target: e.target ?? "unknown", operation: "update" }),
  invocation: (e) => ({ type: "invocation", callee: e.callee ?? "unknown", args: [], async: e.async ?? false }),
  emission: (e) => ({ type: "emission", event: e.event ?? "unknown" }),
  stateChange: (e) => ({ type: "stateChange", variable: e.variable ?? "unknown" }),
};

export function effectToIR(effect: RawEffect): Effect {
  return effectConverters[effect.type](effect);
}

export function paramToInput(param: RawParameter): Input {
  return {
    type: "parameter",
    name: param.name,
    position: param.position,
    role: param.role,
    shape: param.typeText ? { type: "ref", name: param.typeText } : null,
  };
}
