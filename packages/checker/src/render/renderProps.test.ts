import { describe, expect, it } from "vitest";

import { checkRenderProps } from "./renderProps.js";

import type { BehavioralSummary, Input, RenderNode } from "@suss/behavioral-ir";

type InputRead = { input: string; path: string[] };

function component(args: {
  name: string;
  file: string;
  inputs?: Input[];
  inputReads?: InputRead[];
  root?: RenderNode;
}): BehavioralSummary {
  return {
    kind: "component",
    location: {
      file: args.file,
      range: { start: 1, end: 10 },
      exportName: args.name,
    },
    identity: {
      name: args.name,
      exportPath: [args.name],
      boundaryBinding: null,
    },
    inputs: args.inputs ?? [],
    transitions:
      args.root !== undefined
        ? [
            {
              id: "t0",
              conditions: [],
              output: { type: "render", component: args.name, root: args.root },
              effects: [],
              location: { start: 1, end: 10 },
              isDefault: true,
            },
          ]
        : [],
    gaps: [],
    confidence: { source: "inferred", level: "high" },
    ...(args.inputReads !== undefined ? { inputReads: args.inputReads } : {}),
  } as unknown as BehavioralSummary;
}

function param(name: string, role: string = name): Input {
  return {
    type: "parameter",
    name,
    position: 0,
    role,
    shape: null,
  };
}

function rendering(
  tag: string,
  target: { file: string; name: string },
  attrs: Record<string, string>,
): RenderNode {
  return {
    type: "element",
    tag: "div",
    children: [{ type: "element", tag, target, attrs, children: [] }],
  };
}

const avatarTarget = { file: "src/avatar.tsx", name: "Avatar" };

describe("checkRenderProps", () => {
  it("reports a prop the parent passes and the child never reads", () => {
    const parent = component({
      name: "Page",
      file: "src/page.tsx",
      root: rendering("Avatar", avatarTarget, {
        src: '"/me.png"',
        unusedThing: "value",
      }),
    });
    const child = component({
      name: "Avatar",
      file: "src/avatar.tsx",
      inputs: [param("src")],
      inputReads: [{ input: "src", path: [] }],
    });

    const findings = checkRenderProps([parent, child]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("boundaryFieldUnused");
    expect(findings[0].severity).toBe("info");
    expect(findings[0].description).toContain('"unusedThing"');
  });

  it("counts a chain off the props object as a read of its first segment", () => {
    const parent = component({
      name: "Page",
      file: "src/page.tsx",
      root: rendering(
        "Card",
        { file: "src/card.tsx", name: "Card" },
        {
          title: "t",
          body: "b",
        },
      ),
    });
    const child = component({
      name: "Card",
      file: "src/card.tsx",
      inputs: [param("props")],
      inputReads: [{ input: "props", path: ["title"] }],
    });

    const findings = checkRenderProps([parent, child]);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('"body"');
  });

  it("skips the edge when the child uses the props object whole", () => {
    const parent = component({
      name: "Page",
      file: "src/page.tsx",
      root: rendering(
        "Card",
        { file: "src/card.tsx", name: "Card" },
        {
          anything: "x",
        },
      ),
    });
    const child = component({
      name: "Card",
      file: "src/card.tsx",
      inputs: [param("props")],
      inputReads: [{ input: "props", path: [] }],
    });

    expect(checkRenderProps([parent, child])).toEqual([]);
  });

  it("skips the edge when the child binds a rest of the props", () => {
    const parent = component({
      name: "Page",
      file: "src/page.tsx",
      root: rendering(
        "Chip",
        { file: "src/chip.tsx", name: "Chip" },
        {
          className: "x",
          label: "y",
        },
      ),
    });
    const child = component({
      name: "Chip",
      file: "src/chip.tsx",
      inputs: [param("label"), param("rest", "rest")],
      inputReads: [
        { input: "label", path: [] },
        { input: "rest", path: [] },
      ],
    });

    expect(checkRenderProps([parent, child])).toEqual([]);
  });

  it("walks both arms of a conditional and skips a self-render", () => {
    const parent = component({
      name: "Page",
      file: "src/page.tsx",
      root: {
        type: "conditional",
        condition: "ok",
        whenTrue: rendering("Avatar", avatarTarget, { ghost: "x" }),
        whenFalse: {
          type: "element",
          tag: "Page",
          target: { file: "src/page.tsx", name: "Page" },
          attrs: { depth: "1" },
          children: [{ type: "text", value: "hi" }],
        },
      },
    });
    const child = component({
      name: "Avatar",
      file: "src/avatar.tsx",
      inputs: [param("src")],
      inputReads: [{ input: "src", path: [] }],
    });

    const findings = checkRenderProps([parent, child]);
    expect(findings).toHaveLength(1);
    expect(findings[0].description).toContain('"ghost"');
  });

  it("translates a destructure rename back to the passed name", () => {
    const parent = component({
      name: "Row",
      file: "src/row.tsx",
      root: rendering(
        "Avatars",
        { file: "src/avatars.tsx", name: "Avatars" },
        { totalCount: "12" },
      ),
    });
    const child = component({
      name: "Avatars",
      file: "src/avatars.tsx",
      inputs: [param("_totalCount", "totalCount")],
      inputReads: [{ input: "_totalCount", path: [] }],
    });

    expect(checkRenderProps([parent, child])).toEqual([]);
  });

  it("skips plumbing props and a child with nothing recorded", () => {
    const parent = component({
      name: "Page",
      file: "src/page.tsx",
      root: rendering("Avatar", avatarTarget, { key: "k", src: "s" }),
    });
    const silentChild = component({
      name: "Avatar",
      file: "src/avatar.tsx",
      inputs: [param("src")],
    });

    expect(checkRenderProps([parent, silentChild])).toEqual([]);
  });
});
