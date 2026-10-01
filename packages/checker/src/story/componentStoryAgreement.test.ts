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
      workspace: "web",
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
    confidence: { source: "derived", level: "medium" },
    metadata: {
      component: {
        storybook: {
          story: storyName,
          component: componentName,
          componentModule: {
            workspace: "web",
            file: `src/${componentName}.tsx`,
            name: componentName,
          },
          args,
          provenance: "independent",
        },
      },
    },
  };
}

/** The same story, with its import leading to another module. */
function importingFrom(
  story: BehavioralSummary,
  module: { workspace: string; file: string; name: string } | undefined,
): BehavioralSummary {
  const component = story.metadata?.component as {
    storybook: Record<string, unknown>;
  };
  const { componentModule: _left, ...rest } = component.storybook;
  return {
    ...story,
    metadata: {
      component: {
        storybook:
          module === undefined ? rest : { ...rest, componentModule: module },
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

/** The same summary, extracted from another workspace. */
function inWorkspace(
  summary: BehavioralSummary,
  workspace: string,
): BehavioralSummary {
  return { ...summary, location: { ...summary.location, workspace } };
}

describe("two components sharing one name", () => {
  it("checks a story against the component its import leads to", () => {
    const wanted = inWorkspace(
      makeComponent("Button", [{ name: "label" }]),
      "design",
    );
    const other = makeComponent("Button", [{ name: "caption" }]);
    const story = importingFrom(
      makeStory("Primary", "Button", { label: "Hi" }),
      { workspace: "design", file: "src/Button.tsx", name: "Button" },
    );
    expect(checkComponentStoryAgreement([wanted, other, story])).toEqual([]);
  });

  it("says nothing when the import leads to a component the run did not extract", () => {
    const other = makeComponent("Chip", [{ name: "label" }]);
    const story = importingFrom(
      makeStory("Default", "Chip", { size: '"sm"' }),
      { workspace: "ui", file: "src/Chip/Chip.tsx", name: "Chip" },
    );
    expect(checkComponentStoryAgreement([other, story])).toEqual([]);
  });

  it("never pairs by name a story whose import was not followed", () => {
    const only = makeComponent("Chip", [{ name: "label" }]);
    const story = importingFrom(
      makeStory("Default", "Chip", { size: '"sm"' }),
      undefined,
    );
    expect(checkComponentStoryAgreement([only, story])).toEqual([]);
  });

  it("still flags an unknown arg against the component its import leads to", () => {
    const only = makeComponent("Card", [{ name: "title" }]);
    const story = makeStory("Basic", "Card", { subtitle: "x" });
    const findings = checkComponentStoryAgreement([only, story]);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain("subtitle");
  });
});

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
    expect(findings[0].kind).toBe("boundaryFieldUnknown");
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
    // Wait: the story DOES provide `user`. The gap would be if it
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
      // Opaque predicate: source text includes a reserved-word token
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

  it("does not judge args against a component that collects the rest of its props", () => {
    const component = withRoles(
      makeComponent("Box", [{ name: "padding" }, { name: "props" }]),
      { props: "rest" },
    );
    const story = makeStory("Default", "Box", { children: '"Hello"' });
    expect(checkComponentStoryAgreement([component, story])).toEqual([]);
  });

  it("does not judge args against a component that takes its props whole", () => {
    const component = withRoles(makeComponent("Banner", [{ name: "props" }]), {
      props: "props",
    });
    const story = makeStory("Default", "Banner", { variant: '"info"' });
    expect(checkComponentStoryAgreement([component, story])).toEqual([]);
  });

  it("compares args only with the component's parameters", () => {
    const base = makeComponent("Clock", [{ name: "zone" }]);
    const component: BehavioralSummary = {
      ...base,
      inputs: [
        ...base.inputs,
        { type: "hookReturn", hook: "useNow", destructuredFields: ["now"] },
      ],
    };
    const story = makeStory("Default", "Clock", { zone: '"UTC"', now: "0" });
    const findings = checkComponentStoryAgreement([component, story]);
    expect(findings.map((f) => f.description)).toEqual([
      'Story "Default" provides arg "now" but component "Clock" does not declare it as an input.',
    ]);
  });

  it("reads a renamed prop under the name the story passes", () => {
    const component = withRoles(makeComponent("Toast", [{ name: "_icon" }]), {
      _icon: "icon",
    });
    const story = makeStory("Default", "Toast", { icon: '"bell"' });
    expect(checkComponentStoryAgreement([component, story])).toEqual([]);
  });

  it("counts only the component's own props as gating ones", () => {
    const component = makeComponent(
      "LoadingIndicator",
      [{ name: "size" }],
      [
        conditionalTransition("small", {
          type: "opaque",
          sourceText: "size === Sizes.sm && React.Children.count(kids) > 0",
          reason: "complexExpression",
        }),
      ],
    );
    const story = makeStory("Default", "LoadingIndicator", { size: '"sm"' });
    expect(checkComponentStoryAgreement([component, story])).toEqual([]);
  });
});

function withRoles(
  summary: BehavioralSummary,
  roles: Record<string, string>,
): BehavioralSummary {
  return {
    ...summary,
    inputs: summary.inputs.map((input) =>
      input.type === "parameter" && roles[input.name] !== undefined
        ? { ...input, role: roles[input.name] }
        : input,
    ),
  };
}
