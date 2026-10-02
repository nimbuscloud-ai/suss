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

  const componentsByModule = new Map<string, BehavioralSummary[]>();
  for (const s of summaries) {
    if (s.kind !== "component") {
      continue;
    }
    if (storyMeta(s) !== null) {
      continue;
    }
    const key = moduleKey(s.location.workspace, s.location.file);
    const bucket = componentsByModule.get(key) ?? [];
    bucket.push(s);
    componentsByModule.set(key, bucket);
  }

  // Resolve each story to one component summary once, so both passes
  // agree about which component a story is for.
  const componentOfStory = new Map<BehavioralSummary, BehavioralSummary>();
  const storiesByComponent = new Map<BehavioralSummary, BehavioralSummary[]>();
  for (const story of stories) {
    const component = componentOfModule(storyMeta(story), componentsByModule);
    if (component === null) {
      continue;
    }
    componentOfStory.set(story, component);
    const bucket = storiesByComponent.get(component) ?? [];
    bucket.push(story);
    storiesByComponent.set(component, bucket);
  }

  const findings: Finding[] = [];

  // Args a story passes that its component does not declare. A decorator
  // or a render function can take an arg the component never sees, so a
  // story with either says nothing about its args.
  for (const story of stories) {
    const meta = storyMeta(story);
    if (meta?.component === undefined || (meta.argReaders ?? []).length > 0) {
      continue;
    }
    const component = componentOfStory.get(story);
    if (component === undefined) {
      continue;
    }
    const inputNames = declaredProps(component);
    if (inputNames === null) {
      continue;
    }
    for (const argName of Object.keys(meta.args ?? {})) {
      if (!inputNames.has(argName)) {
        findings.push(
          makeUnknownArgFinding(story, component, argName, meta, inputNames),
        );
      }
    }
  }

  // Props a component branches on that none of its stories supply. A
  // render function can pass the component a prop no arg lists, and one
  // the reader could not follow may pass any of them.
  for (const [component, componentStories] of storiesByComponent) {
    const gatingProps = collectGatingProps(component);
    if (
      gatingProps.size === 0 ||
      componentStories.some(rendersWithUnreadProps)
    ) {
      continue;
    }
    const allStoryArgKeys = new Set<string>();
    for (const story of componentStories) {
      const meta = storyMeta(story);
      for (const argName of [
        ...Object.keys(meta?.args ?? {}),
        ...(meta?.renderProps ?? []),
      ]) {
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

function moduleKey(workspace: string | undefined, file: string): string {
  return `${workspace ?? ""}::${file}`;
}

/**
 * The component a story is about: the one declared under that name in
 * the module the story's import leads to. Components in other packages
 * share names, so a story whose import was not followed gets no answer,
 * since checking against the wrong component invents findings (#121).
 */
function componentOfModule(
  meta: StorybookMetadata | null,
  componentsByModule: ReadonlyMap<string, BehavioralSummary[]>,
): BehavioralSummary | null {
  const module = meta?.componentModule;
  if (module === undefined) {
    return null;
  }
  const declared = (
    componentsByModule.get(moduleKey(module.workspace, module.file)) ?? []
  ).filter((c) => c.identity.name === module.name);
  return declared.length === 1 ? (declared[0] as BehavioralSummary) : null;
}

/**
 * The props a component declares, by the name a story passes them
 * under, which a destructure rename keeps in the role. Null when the
 * list is open: a rest binding or a props object taken whole accepts
 * any arg without naming it.
 */
function declaredProps(component: BehavioralSummary): Set<string> | null {
  const names = new Set<string>();
  for (const input of component.inputs) {
    if (input.type !== "parameter") {
      continue;
    }
    if (input.role === "rest" || input.role === "props") {
      return null;
    }
    names.add(input.role ?? input.name);
  }
  return names;
}

function storyMeta(summary: BehavioralSummary): StorybookMetadata | null {
  return readStorybookMetadata(summary) ?? null;
}

function rendersWithUnreadProps(story: BehavioralSummary): boolean {
  const meta = storyMeta(story);
  return (
    meta?.argReaders?.includes("render") === true &&
    meta.renderProps === undefined
  );
}

/**
 * The prop names that any of the component's transition conditions
 * refer to. The structured predicates are walked, so `user.active`
 * gives `user`. An opaque predicate falls back to a regex over its
 * source text, which also finds locals and globals, so a name counts
 * only when it is one of the component's own destructured props.
 */
function collectGatingProps(component: BehavioralSummary): Set<string> {
  const propByBinding = new Map<string, string>();
  for (const input of component.inputs) {
    if (
      input.type === "parameter" &&
      input.role !== "rest" &&
      input.role !== "props"
    ) {
      propByBinding.set(input.name, input.role ?? input.name);
    }
  }

  const props = new Set<string>();
  for (const t of gatedTransitions(component.transitions)) {
    for (const pred of t.conditions) {
      for (const name of inputsInPredicate(pred)) {
        const prop = propByBinding.get(name);
        if (prop !== undefined) {
          props.add(prop);
        }
      }
    }
  }
  return props;
}

function gatedTransitions(transitions: Transition[]): Transition[] {
  return transitions.filter((t) => !(t.isDefault && t.conditions.length === 0));
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

/**
 * The props a component takes come from the names its parameter
 * destructures, so an arg missing from them may still be in the props
 * type. The message says the component never reads it, which is true
 * either way, and lists the props it does take.
 */
function makeUnknownArgFinding(
  story: BehavioralSummary,
  component: BehavioralSummary,
  argName: string,
  meta: StorybookMetadata,
  taken: ReadonlySet<string>,
): Finding {
  const takes =
    taken.size === 0
      ? "it takes no props"
      : `it takes only ${[...taken].map((name) => `"${name}"`).join(", ")}`;
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
    description: `Story "${meta.story ?? story.identity.name}" provides arg "${argName}" but component "${component.identity.name}" never reads it: ${takes}.`,
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
