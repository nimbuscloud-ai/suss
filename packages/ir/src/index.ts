// @suss/behavioral-ir — core types and utilities

export type CodeUnitKind =
  | "handler"
  | "loader"
  | "action"
  | "component"
  | "hook"
  | "middleware"
  | "resolver"
  | "consumer"
  | "worker";

export interface SourceLocation {
  file: string;
  range: { start: number; end: number };
  exportName: string | null;
}

export interface BoundaryBinding {
  protocol: string;
  method?: string;
  path?: string;
  framework: string;
  declaredResponses?: number[];
}

export interface CodeUnitIdentity {
  name: string;
  exportPath: string[] | null;
  boundaryBinding: BoundaryBinding | null;
}

export type ComparisonOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
export type OpaqueReason =
  | "complexExpression"
  | "externalFunction"
  | "dynamicValue"
  | "unsupportedSyntax";

export type Derivation =
  | { type: "propertyAccess"; property: string }
  | { type: "methodCall"; method: string; args: string[] }
  | { type: "destructured"; field: string }
  | { type: "awaited" }
  | { type: "indexAccess"; index: string | number };

export type Input =
  | {
      type: "parameter";
      name: string;
      position: number;
      role: string;
      shape: TypeShape | null;
    }
  | {
      type: "injection";
      name: string;
      mechanism: string;
      shape: TypeShape | null;
    }
  | { type: "hookReturn"; hook: string; destructuredFields: string[] }
  | { type: "contextValue"; context: string; accessedFields: string[] }
  | { type: "closure"; name: string };

export type Literal = {
  type: "literal";
  value: string | number | boolean | null;
};

export type ValueRef =
  | { type: "input"; inputRef: string; path: string[] }
  | { type: "dependency"; name: string; accessChain: string[] }
  | { type: "derived"; from: ValueRef; derivation: Derivation }
  | Literal
  | { type: "state"; name: string }
  | { type: "unresolved"; sourceText: string };

export type Predicate =
  | { type: "nullCheck"; subject: ValueRef; negated: boolean }
  | { type: "truthinessCheck"; subject: ValueRef; negated: boolean }
  | { type: "comparison"; left: ValueRef; op: ComparisonOp; right: ValueRef }
  | { type: "typeCheck"; subject: ValueRef; expectedType: string }
  | {
      type: "propertyExists";
      subject: ValueRef;
      property: string;
      negated: boolean;
    }
  | { type: "compound"; op: "and" | "or"; operands: Predicate[] }
  | { type: "negation"; operand: Predicate }
  | { type: "call"; callee: string; args: ValueRef[] }
  | { type: "opaque"; sourceText: string; reason: OpaqueReason };

export type TypeShape =
  | {
      type: "record";
      properties: Record<string, TypeShape>;
      /**
       * Source-text of spread/rest expressions that merge additional fields
       * into this record at runtime (e.g. `{ ...user, admin: true }`). Fields
       * in `properties` are known statically; anything else may be contributed
       * by a spread and is not enumerable here. Absent when the record has no
       * spreads.
       */
      spreads?: Array<{ sourceText: string }>;
    }
  | { type: "array"; items: TypeShape }
  | { type: "text" }
  | { type: "integer" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "union"; variants: TypeShape[] }
  | { type: "ref"; name: string }
  | { type: "unknown" };

export type Output =
  | {
      type: "response";
      statusCode: ValueRef | null;
      body: TypeShape | null;
      headers: Record<string, ValueRef>;
    }
  | { type: "throw"; exceptionType: string | null; message: string | null }
  | { type: "render"; component: string; props?: Record<string, unknown> }
  | { type: "return"; value: TypeShape | null }
  | { type: "delegate"; to: string }
  | { type: "emit"; event: string; payload?: TypeShape }
  | { type: "void" };

export type Effect =
  | {
      type: "mutation";
      target: string;
      operation: "create" | "update" | "delete";
    }
  | { type: "invocation"; callee: string; args: unknown[]; async: boolean }
  | { type: "emission"; event: string; payload?: unknown }
  | { type: "stateChange"; variable: string; newValue?: unknown };

export interface Transition {
  id: string;
  conditions: Predicate[];
  output: Output;
  effects: Effect[];
  location: { start: number; end: number };
  isDefault: boolean;
  confidence?: ConfidenceInfo;
}

export interface Gap {
  type: "unhandledCase";
  conditions: Predicate[];
  consequence: "frameworkDefault" | "implicitThrow" | "fallthrough" | "unknown";
  description: string;
}

export interface ConfidenceInfo {
  source: "inferred_static" | "inferred_ai" | "declared" | "stub";
  level: "high" | "medium" | "low";
}

export interface BehavioralSummary {
  kind: CodeUnitKind;
  location: SourceLocation;
  identity: CodeUnitIdentity;
  inputs: Input[];
  transitions: Transition[];
  gaps: Gap[];
  confidence: ConfidenceInfo;
  metadata?: Record<string, unknown>;
}

export interface SummaryDiff {
  addedTransitions: Transition[];
  removedTransitions: Transition[];
  changedTransitions: Array<{ before: Transition; after: Transition }>;
}

export type FindingKind =
  | "unhandledProviderCase"
  | "deadConsumerBranch"
  | "providerContractViolation"
  | "consumerContractViolation"
  | "lowConfidence";

export type FindingSeverity = "error" | "warning" | "info";

export interface FindingSide {
  summary: string;
  transitionId?: string;
  location: SourceLocation;
}

export interface Finding {
  kind: FindingKind;
  boundary: BoundaryBinding;
  provider: FindingSide;
  consumer: FindingSide;
  description: string;
  severity: FindingSeverity;
}

export function diffSummaries(
  before: BehavioralSummary,
  after: BehavioralSummary,
): SummaryDiff {
  const beforeById = new Map(before.transitions.map((t) => [t.id, t]));
  const afterById = new Map(after.transitions.map((t) => [t.id, t]));

  const addedTransitions: Transition[] = [];
  const removedTransitions: Transition[] = [];
  const changedTransitions: Array<{ before: Transition; after: Transition }> =
    [];

  for (const [id, afterT] of afterById) {
    if (!beforeById.has(id)) {
      addedTransitions.push(afterT);
    }
  }

  for (const [id, beforeT] of beforeById) {
    const afterT = afterById.get(id);
    if (!afterT) {
      removedTransitions.push(beforeT);
    } else if (JSON.stringify(beforeT) !== JSON.stringify(afterT)) {
      changedTransitions.push({ before: beforeT, after: afterT });
    }
  }

  return { addedTransitions, removedTransitions, changedTransitions };
}
