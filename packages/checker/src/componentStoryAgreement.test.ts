import { describe, expect, it } from "vitest";

import { functionCallBinding } from "@suss/behavioral-ir";

import { checkComponentStoryAgreement } from "./componentStoryAgreement.js";

import type {
  BehavioralSummary,
  Predicate,
  Transition,
} from "@suss/behavioral-ir";

function makeComponent(
  name: string,
  inputs: Array<{ name: string; typeText?: string }>,
  transitions: Transition[] = [],
): BehavioralSummary {
  return {
    kind: "component",
    location: {
      file: `src/${name}.tsx`,
      range: { start: 1, end: 10 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: functionCallBinding({
        transport: "in-process",
        recognition: "react",
      }),
    },
    inputs: inputs.map((i) => ({
      type: "parameter",
      name: i.name,
      position: 0,
      role: i.name,
      shape: i.typeText ? { type: "ref", name: i.typeText } : null,
    })),
    transitions,
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function makeStory(
  storyName: string,
  componentName: string,
  args: Record<string, string>,
): BehavioralSummary {
  return {
    kind: "component",
    location: {
      file: `src/${componentName}.stories.tsx`,
      range: { start: 1, end: 5 },
      exportName: storyName,
    },
    identity: {
      name: `${componentName}.${storyName}`,
      exportPath: [storyName],
      boundaryBinding: functionCallBinding({
        transport: "in-process",
        recognition: "react",
      }),
    },
    inputs: [],
    transitions: [
      {
        id: `${componentName}-${storyName}`,
        conditions: [],
        output: { type: "render", component: componentName },
        effects: [],
        location: { start: 1, end: 1 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "stub", level: "medium" },
    metadata: {
      component: {
        storybook: {
          story: storyName,
          component: componentName,
          args,
          provenance: "independent",
        },
      },
    },
  };
}

function conditionalTransition(
  id: string,
  predicate: Predicate,
  isDefault = false,
): Transition {
  return {
    id,
    conditions: [predicate],
    output: { type: "return", value: null },
    effects: [],
    location: { start: 1, end: 1 },
    isDefault,
  };
}

function truthinessOnInput(name: string, negated = false): Predicate {
  return {
    type: "truthinessCheck",
    subject: { type: "input", inputRef: name, path: [] },
    negated,
  };
}

describe("checkComponentStoryAgreement — unknown arg", () => {
  it("returns no findings when all story args exist on the component", () => {
    const component = makeComponent("Button", [
      { name: "label", typeText: "string" },
    ]);
    const story = makeStory("Primary", "Button", { label: '"Click me"' });
    const findings = checkComponentStoryAgreement([component, story]);
    expect(findings).toEqual([]);
  });

  it("flags a story arg the component doesn't declare", () => {
    const component = makeComponent("Button", [
      { name: "label", typeText: "string" },
    ]);
    const story = makeStory("Broken", "Button", {
      label: '"Click me"',
      disabled: "true",
    });
    const findings = checkComponentStoryAgreement([component, story]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("scenarioArgUnknown");
    expect(findings[0].description).toContain("disabled");
    expect(findings[0].description).toContain("Broken");
  });

  it("skips stories that reference a component not in the summaries set", () => {
    const orphan = makeStory("Default", "Missing", { label: '"x"' });
    const findings = checkComponentStoryAgreement([orphan]);
    expect(findings).toEqual([]);
  });

  it("returns empty when no stories exist in the summaries set", () => {
    const component = makeComponent("Button", [
      { name: "label", typeText: "string" },
    ]);
    const findings = checkComponentStoryAgreement([component]);
    expect(findings).toEqual([]);
  });
});

describe("checkComponentStoryAgreement — coverage gap", () => {
  it("flags a prop that gates a conditional branch but no story supplies", () => {
    // UserCard-like: `if (!user) return null;` plus a default render.
    const component = makeComponent(
      "UserCard",
      [{ name: "user", typeText: "User | null" }],
      [
        conditionalTransition("early-return", truthinessOnInput("user", true)),
        {
          id: "render",
          conditions: [],
          output: { type: "render", component: "div" },
          effects: [],
          location: { start: 1, end: 1 },
          isDefault: true,
        },
      ],
    );
    // Story provides a non-null user but omits any null variant.
    // Wait — the story DOES provide `user`. The gap would be if it
    // DIDN'T. Let's have the story omit `user` entirely.
    const story = makeStory("Empty", "UserCard", {});
    const findings = checkComponentStoryAgreement([component, story]);
    const gapFinding = findings.find((f) => f.kind === "scenarioCoverageGap");
    expect(gapFinding).toBeDefined();
    expect(gapFinding?.description).toContain("user");
    expect(gapFinding?.description).toContain("UserCard");
  });

  it("does not flag coverage gaps when stories supply the gating prop", () => {
    const component = makeComponent(
      "UserCard",
      [{ name: "user", typeText: "User | null" }],
      [
        conditionalTransition("early-return", truthinessOnInput("user", true)),
        {
          id: "render",
          conditions: [],
          output: { type: "render", component: "div" },
          effects: [],
          location: { start: 1, end: 1 },
          isDefault: true,
        },
      ],
    );
    const story = makeStory("Loaded", "UserCard", {
      user: "{ id: '1', name: 'x' }",
    });
    const findings = checkComponentStoryAgreement([component, story]);
    const gapFindings = findings.filter(
      (f) => f.kind === "scenarioCoverageGap",
    );
    expect(gapFindings).toEqual([]);
  });

  it("ignores components whose transitions have no conditional subjects", () => {
    const component = makeComponent(
      "Simple",
      [{ name: "label", typeText: "string" }],
      [
        {
          id: "render",
          conditions: [],
          output: { type: "render", component: "div" },
          effects: [],
          location: { start: 1, end: 1 },
          isDefault: true,
        },
      ],
    );
    const story = makeStory("Default", "Simple", { label: '"x"' });
    const findings = checkComponentStoryAgreement([component, story]);
    expect(findings.filter((f) => f.kind === "scenarioCoverageGap")).toEqual(
      [],
    );
  });

  it("ignores reserved words in condition source text", () => {
    // A condition like `user != null` parses into identifiers
    // [user, null]; `null` is reserved and must not register as a
    // "prop the story should supply."
    const component = makeComponent(
      "Widget",
      [{ name: "user" }],
      // Opaque predicate — source text includes a reserved-word token
      // (`null`) and an identifier (`user`). The reserved-word filter
      // means `null` must not register as a gating prop; only `user`
      // should.
      [
        conditionalTransition("guard", {
          type: "opaque",
          sourceText: "user != null",
          reason: "complexExpression",
        }),
      ],
    );
    const story = makeStory("WithUser", "Widget", {
      user: "{ id: '1' }",
    });
    const findings = checkComponentStoryAgreement([component, story]);
    expect(findings.filter((f) => f.kind === "scenarioCoverageGap")).toEqual(
      [],
    );
  });

  it("flags multiple uncovered gating props independently", () => {
    const component = makeComponent(
      "Multi",
      [{ name: "a" }, { name: "b" }],
      [
        conditionalTransition("onA", truthinessOnInput("a")),
        conditionalTransition("onB", truthinessOnInput("b")),
      ],
    );
    // Story supplies neither.
    const story = makeStory("Default", "Multi", {});
    const gapFindings = checkComponentStoryAgreement([component, story])
      .filter((f) => f.kind === "scenarioCoverageGap")
      .map((f) => f.description);
    // Expect both props flagged.
    expect(gapFindings.some((d) => d.includes('"a"'))).toBe(true);
    expect(gapFindings.some((d) => d.includes('"b"'))).toBe(true);
  });
});
