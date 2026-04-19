// component-story-agreement.ts — React-specific cross-shape check
// comparing Storybook stub summaries against their inferred component
// summaries.
//
// v0 deliberately focuses on findings TypeScript can't already give
// the user for free. Arg-value type checking against declared prop
// types is TS's job (CSF3's `satisfies Meta<typeof Component>` catches
// it at compile time), so we don't emit those findings — they'd be
// noise.
//
// The behavioral findings worth emitting:
//
//   1. `scenarioArgUnknown` — a story references a prop the component
//      doesn't declare. Still useful for loose-TS configs, `.stories.js`
//      files, or stories that predate a prop rename.
//
//   2. `scenarioCoverageGap` — the component has a conditional branch
//      that depends on a prop, but no story exercises that branch.
//      Genuine behavioral gap: the component's logic has a path
//      nothing verifies.
//
// Richer comparisons (inferred render vs Storybook snapshot, inferred
// handler vs Storybook play function) depend on Phase 2 extensions
// (snapshot reader, play parsing) — they're the direction this file
// grows.

import { functionCallBinding } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

function fallbackReactBinding(): BoundaryBinding {
  return functionCallBinding({
    transport: "in-process",
    recognition: "react",
  });
}

interface StorybookMeta {
  story?: string;
  component?: string;
  args?: Record<string, string>;
  provenance?: string;
}

export function checkComponentStoryAgreement(
  summaries: BehavioralSummary[],
): Finding[] {
  const stories = summaries.filter((s) => storyMeta(s) !== null);
  if (stories.length === 0) {
    return [];
  }

  const componentsByName = new Map<string, BehavioralSummary>();
  for (const s of summaries) {
    if (s.kind !== "component") {
      continue;
    }
    if (storyMeta(s) !== null) {
      continue;
    }
    componentsByName.set(s.identity.name, s);
  }

  // Index stories by the component name they target, so the coverage
  // pass can ask "all stories for component X" once per component.
  const storiesByComponent = new Map<string, BehavioralSummary[]>();
  for (const story of stories) {
    const meta = storyMeta(story);
    if (meta?.component === undefined) {
      continue;
    }
    const bucket = storiesByComponent.get(meta.component) ?? [];
    bucket.push(story);
    storiesByComponent.set(meta.component, bucket);
  }

  const findings: Finding[] = [];

  // Pass 1: unknown-arg findings, per story.
  for (const story of stories) {
    const meta = storyMeta(story);
    if (meta?.component === undefined) {
      continue;
    }
    const component = componentsByName.get(meta.component);
    if (component === undefined) {
      continue;
    }
    const inputNames = new Set(
      component.inputs
        .filter((i) => i.type === "parameter")
        .map((i) => (i.type === "parameter" ? i.name : "")),
    );
    for (const argName of Object.keys(meta.args ?? {})) {
      if (!inputNames.has(argName)) {
        findings.push(makeUnknownArgFinding(story, component, argName, meta));
      }
    }
  }

  // Pass 2: coverage gaps, per component. For each prop referenced in
  // a conditional transition, check whether any story supplies a
  // value for that prop. If not, the branches that depend on it go
  // untested.
  for (const [componentName, componentStories] of storiesByComponent) {
    const component = componentsByName.get(componentName);
    if (component === undefined) {
      continue;
    }
    const gatingProps = collectGatingProps(component.transitions);
    if (gatingProps.size === 0) {
      continue;
    }
    const allStoryArgKeys = new Set<string>();
    for (const story of componentStories) {
      const meta = storyMeta(story);
      for (const argName of Object.keys(meta?.args ?? {})) {
        allStoryArgKeys.add(argName);
      }
    }
    for (const prop of gatingProps) {
      if (!allStoryArgKeys.has(prop)) {
        findings.push(
          makeCoverageGapFinding(component, componentStories, prop),
        );
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function storyMeta(summary: BehavioralSummary): StorybookMeta | null {
  const component = summary.metadata?.component;
  if (typeof component !== "object" || component === null) {
    return null;
  }
  const storybook = (component as { storybook?: unknown }).storybook;
  if (typeof storybook !== "object" || storybook === null) {
    return null;
  }
  return storybook as StorybookMeta;
}

/**
 * Pull the set of prop names that gate any of the component's
 * transitions. A prop gates a transition when it's the subject of a
 * condition predicate somewhere in the transition's condition set.
 * Walks the structured `Predicate` / `ValueRef` IR rather than
 * source text, so shapes like `user.active` correctly yield
 * `user` as the gating input. Opaque predicates' source text falls
 * back to a bare-identifier regex when structure is unavailable.
 */
function collectGatingProps(transitions: Transition[]): Set<string> {
  const props = new Set<string>();
  for (const t of transitions) {
    if (t.isDefault && t.conditions.length === 0) {
      continue;
    }
    for (const pred of t.conditions) {
      for (const name of inputsInPredicate(pred)) {
        props.add(name);
      }
    }
  }
  return props;
}

type PredicateInputsTable = {
  [K in Predicate["type"]]: (p: Extract<Predicate, { type: K }>) => string[];
};

const PREDICATE_INPUTS: PredicateInputsTable = {
  nullCheck: (p) => inputsInValueRef(p.subject),
  truthinessCheck: (p) => inputsInValueRef(p.subject),
  comparison: (p) => [
    ...inputsInValueRef(p.left),
    ...inputsInValueRef(p.right),
  ],
  typeCheck: (p) => inputsInValueRef(p.subject),
  propertyExists: (p) => inputsInValueRef(p.subject),
  compound: (p) => p.operands.flatMap(inputsInPredicate),
  negation: (p) => inputsInPredicate(p.operand),
  call: (p) => p.args.flatMap(inputsInValueRef),
  opaque: (p) => rootIdentifiers(p.sourceText),
};

function inputsInPredicate(pred: Predicate): string[] {
  const handler = (
    PREDICATE_INPUTS as unknown as Record<string, (p: Predicate) => string[]>
  )[pred.type];
  return handler(pred);
}

type ValueRefInputsTable = {
  [K in ValueRef["type"]]: (r: Extract<ValueRef, { type: K }>) => string[];
};

const VALUE_REF_INPUTS: ValueRefInputsTable = {
  input: (r) => [r.inputRef],
  derived: (r) => inputsInValueRef(r.from),
  dependency: () => [],
  literal: () => [],
  state: () => [],
  unresolved: (r) => rootIdentifiers(r.sourceText),
};

function inputsInValueRef(ref: ValueRef): string[] {
  const handler = (
    VALUE_REF_INPUTS as unknown as Record<string, (r: ValueRef) => string[]>
  )[ref.type];
  return handler(ref);
}

/**
 * Fallback for opaque predicates / unresolved refs: extract
 * bare-identifier roots from source text. Skips reserved words so
 * `user != null` doesn't register `null` as a gating prop.
 */
function rootIdentifiers(text: string): string[] {
  const matches: string[] = [];
  const re = /(?:^|[^a-zA-Z0-9_$])(!?)([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  for (const m of text.matchAll(re)) {
    const name = m[2];
    if (isReservedWord(name)) {
      continue;
    }
    matches.push(name);
  }
  return matches;
}

const RESERVED = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "instanceof",
  "in",
  "void",
  "return",
  "this",
  "new",
  "await",
  "async",
  "let",
  "const",
  "var",
  "if",
  "else",
]);

function isReservedWord(name: string): boolean {
  return RESERVED.has(name);
}

// ---------------------------------------------------------------------------
// Finding builders
// ---------------------------------------------------------------------------

function makeUnknownArgFinding(
  story: BehavioralSummary,
  component: BehavioralSummary,
  argName: string,
  meta: StorybookMeta,
): Finding {
  return {
    kind: "scenarioArgUnknown",
    boundary: component.identity.boundaryBinding ?? fallbackReactBinding(),
    provider: {
      summary: `${component.location.file}::${component.identity.name}`,
      location: component.location,
    },
    consumer: {
      summary: `${story.location.file}::${story.identity.name}`,
      location: story.location,
    },
    description: `Story "${meta.story ?? story.identity.name}" provides arg "${argName}" but component "${component.identity.name}" does not declare it as an input.`,
    severity: "warning",
  };
}

function makeCoverageGapFinding(
  component: BehavioralSummary,
  stories: BehavioralSummary[],
  prop: string,
): Finding {
  // Pick a representative story for the `consumer` side. The
  // description calls out the uncovered prop rather than a specific
  // story (it's the gap across all stories).
  const representative = stories[0];
  const storyNames = stories
    .map((s) => storyMeta(s)?.story ?? s.identity.name)
    .join(", ");
  return {
    kind: "scenarioCoverageGap",
    boundary: component.identity.boundaryBinding ?? fallbackReactBinding(),
    provider: {
      summary: `${component.location.file}::${component.identity.name}`,
      location: component.location,
    },
    consumer: {
      summary: `${representative.location.file}::${representative.identity.name}`,
      location: representative.location,
    },
    description: `Component "${component.identity.name}" has a conditional branch on prop "${prop}" but no story supplies it (stories: ${storyNames}). The branches depending on "${prop}" have no declared scenario exercising them.`,
    severity: "warning",
  };
}
