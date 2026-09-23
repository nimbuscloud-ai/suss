/**
 * Compares Storybook stories with the React components they render.
 *
 * TypeScript already checks a story's arg values against the
 * component's props (`satisfies Meta<typeof Component>`), so this pass
 * leaves those alone. It reports two things TypeScript does not catch.
 * One is a story arg the component does not declare
 * (`boundaryFieldUnknown`), which still happens in `.stories.js` files
 * and after a prop rename. The other is a prop the component branches
 * on that no story supplies (`scenarioCoverageGap`).
 */

import {
  functionCallBinding,
  readStorybookMetadata,
  summaryRef,
} from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Finding,
  Predicate,
  StorybookMetadata,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

function fallbackReactBinding(): BoundaryBinding {
  return functionCallBinding({
    transport: "in-process",
    recognition: "react",
  });
}

export function checkComponentStoryAgreement(
  summaries: BehavioralSummary[],
): Finding[] {
  const stories = summaries.filter((s) => storyMeta(s) !== null);
  if (stories.length === 0) {
    return [];
  }

  const componentsByName = new Map<string, BehavioralSummary[]>();
  for (const s of summaries) {
    if (s.kind !== "component") {
      continue;
    }
    if (storyMeta(s) !== null) {
      continue;
    }
    const bucket = componentsByName.get(s.identity.name) ?? [];
    bucket.push(s);
    componentsByName.set(s.identity.name, bucket);
  }

  // Resolve each story to one component summary once, so both passes
  // agree about which component a story is for.
  const componentOfStory = new Map<BehavioralSummary, BehavioralSummary>();
  const storiesByComponent = new Map<BehavioralSummary, BehavioralSummary[]>();
  for (const story of stories) {
    const meta = storyMeta(story);
    if (meta?.component === undefined) {
      continue;
    }
    const component = resolveComponent(
      componentsByName.get(meta.component) ?? [],
      story,
    );
    if (component === null) {
      continue;
    }
    componentOfStory.set(story, component);
    const bucket = storiesByComponent.get(component) ?? [];
    bucket.push(story);
    storiesByComponent.set(component, bucket);
  }

  const findings: Finding[] = [];

  // Args a story passes that its component does not declare.
  for (const story of stories) {
    const meta = storyMeta(story);
    if (meta?.component === undefined) {
      continue;
    }
    const component = componentOfStory.get(story);
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

  // Props a component branches on that none of its stories supply.
  for (const [component, componentStories] of storiesByComponent) {
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

/**
 * The component a story is about. A story states an identifier name
 * and never follows the import, so two components sharing a name are
 * told apart by the story's own directory, which is where Storybook
 * keeps them. An ambiguous name gets no answer, since checking
 * against the wrong component invents findings (#121).
 */
function resolveComponent(
  candidates: BehavioralSummary[],
  story: BehavioralSummary,
): BehavioralSummary | null {
  if (candidates.length <= 1) {
    return candidates[0] ?? null;
  }

  const storyDir = directoryOf(story.location.file);
  const sameDirectory = candidates.filter(
    (c) => directoryOf(c.location.file) === storyDir,
  );
  return sameDirectory.length === 1
    ? (sameDirectory[0] as BehavioralSummary)
    : null;
}

function directoryOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at === -1 ? "" : file.slice(0, at);
}

function storyMeta(summary: BehavioralSummary): StorybookMetadata | null {
  return readStorybookMetadata(summary) ?? null;
}

/**
 * The prop names that any of the component's transition conditions
 * refer to. The structured predicates are walked, so `user.active`
 * gives `user`. An opaque predicate falls back to a regex over its
 * source text.
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
 * The bare identifiers in the source text of an opaque predicate or an
 * unresolved ref. Reserved words are skipped so `user != null` does not
 * count `null` as a prop.
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

function makeUnknownArgFinding(
  story: BehavioralSummary,
  component: BehavioralSummary,
  argName: string,
  meta: StorybookMetadata,
): Finding {
  return {
    kind: "boundaryFieldUnknown",
    aspect: "construct",
    boundary: component.identity.boundaryBinding ?? fallbackReactBinding(),
    provider: {
      summary: summaryRef(component),
      location: component.location,
    },
    consumer: {
      summary: summaryRef(story),
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
  // The gap is across every story, so the first one fills the
  // consumer side.
  const representative = stories[0];
  const storyNames = stories
    .map((s) => storyMeta(s)?.story ?? s.identity.name)
    .join(", ");
  return {
    kind: "scenarioCoverageGap",
    boundary: component.identity.boundaryBinding ?? fallbackReactBinding(),
    provider: {
      summary: summaryRef(component),
      location: component.location,
    },
    consumer: {
      summary: summaryRef(representative),
      location: representative.location,
    },
    description: `Component "${component.identity.name}" has a conditional branch on prop "${prop}" but no story supplies it (stories: ${storyNames}). The branches depending on "${prop}" have no declared scenario exercising them.`,
    severity: "warning",
  };
}
