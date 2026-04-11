// @suss/extractor — assembly engine

import type {
  BehavioralSummary,
  CodeUnitKind,
  ConfidenceInfo,
  Effect,
  Gap,
  Input,
  Output,
  Predicate,
  Transition,
  TypeShape,
  ValueRef,
} from "@suss/behavioral-ir";

export type {
  BindingExtraction,
  ContractPattern,
  DiscoveryMatch,
  DiscoveryPattern,
  FrameworkPack,
  InputMappingPattern,
  TerminalExtraction,
  TerminalMatch,
  TerminalPattern,
} from "./framework.js";

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
  kind:
    | "response"
    | "throw"
    | "return"
    | "render"
    | "delegate"
    | "emit"
    | "void";
  statusCode:
    | { type: "literal"; value: number }
    | { type: "dynamic"; sourceText: string }
    | null;
  body: { typeText: string | null; shape: unknown } | null;
  exceptionType: string | null;
  message: string | null;
  /** For render terminals: the component being rendered */
  component: string | null;
  /** For delegate terminals: where control is passed */
  delegateTarget: string | null;
  /** For emit terminals: the event/channel name */
  emitEvent: string | null;
  location: { start: number; end: number };
}

export type RawEffect =
  | {
      type: "mutation";
      target: string;
      operation: "create" | "update" | "delete";
    }
  | { type: "invocation"; callee: string; async: boolean }
  | { type: "emission"; event: string }
  | { type: "stateChange"; variable: string };

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
  responses: Array<{
    statusCode: number;
    schemaName?: string;
    shape?: unknown;
  }>;
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
  options: ExtractorOptions = DEFAULT_OPTIONS,
): BehavioralSummary {
  const transitions: Transition[] = raw.branches.map((branch, i) => {
    // Conditions with structured: null become opaque predicates — never silently dropped.
    const conditions: Predicate[] = branch.conditions.map((c) => {
      const pred: Predicate =
        c.structured !== null
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
    ...(raw.declaredContract
      ? { metadata: { declaredContract: raw.declaredContract } }
      : {}),
  };
}

// =============================================================================
// Gap detection
// =============================================================================

export function detectGaps(
  raw: RawCodeStructure,
  transitions: Transition[],
  options: ExtractorOptions,
): Gap[] {
  if (options.gapHandling === "silent") {
    return [];
  }

  const gaps: Gap[] = [];

  if (raw.declaredContract) {
    const producedStatuses = new Set(
      transitions.flatMap((t) => {
        if (t.output.type !== "response") {
          return [];
        }
        const sc = t.output.statusCode;
        if (sc?.type === "literal") {
          return [sc.value as number];
        }
        return [];
      }),
    );
    const declaredStatuses = new Set(
      raw.declaredContract.responses.map((r) => r.statusCode),
    );

    // Declared but never produced
    for (const declared of declaredStatuses) {
      if (!producedStatuses.has(declared)) {
        gaps.push({
          type: "unhandledCase",
          conditions: [],
          consequence: "frameworkDefault",
          description: `Declared response ${declared} is never produced by the handler`,
        });
      }
    }

    // Produced but never declared — contract violation
    for (const produced of producedStatuses) {
      if (!declaredStatuses.has(produced)) {
        gaps.push({
          type: "unhandledCase",
          conditions: [],
          consequence: "unknown",
          description: `Handler produces status ${produced} which is not declared in the ${raw.declaredContract.framework} contract`,
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

const terminalConverters: Record<
  RawTerminal["kind"],
  (t: RawTerminal) => Output
> = {
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
  render: (t) => ({
    type: "render",
    component: t.component ?? "unknown",
  }),
  delegate: (t) => ({
    type: "delegate",
    to: t.delegateTarget ?? "unknown",
  }),
  emit: (t) => ({
    type: "emit",
    event: t.emitEvent ?? "unknown",
  }),
  return: (t) => ({
    type: "return",
    value: t.body?.typeText ? { type: "ref", name: t.body.typeText } : null,
  }),
  void: (_t) => ({ type: "void" }),
};

export function terminalToOutput(terminal: RawTerminal): Output {
  return terminalConverters[terminal.kind](terminal);
}

type EffectConverters = {
  [K in RawEffect["type"]]: (e: Extract<RawEffect, { type: K }>) => Effect;
};

const effectConverters: EffectConverters = {
  mutation: (e) => ({
    type: "mutation",
    target: e.target,
    operation: e.operation,
  }),
  invocation: (e) => ({
    type: "invocation",
    callee: e.callee,
    args: [],
    async: e.async,
  }),
  emission: (e) => ({ type: "emission", event: e.event }),
  stateChange: (e) => ({ type: "stateChange", variable: e.variable }),
};

export function effectToIR(effect: RawEffect): Effect {
  // Narrow then dispatch — the Extract<...> in EffectConverters ensures
  // each converter receives its exact variant.
  return (effectConverters[effect.type] as (e: RawEffect) => Effect)(effect);
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
