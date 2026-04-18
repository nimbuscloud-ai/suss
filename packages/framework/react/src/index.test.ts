import path from "node:path";

import { Project } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";

import { reactFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project — loads fixtures/react/*.tsx in memory
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/react");

function runAdapter(): BehavioralSummary[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      moduleResolution: 100, // Bundler
      skipLibCheck: true,
      // React 17+ automatic runtime; adapter doesn't actually render, just
      // parses JSX, but the compiler needs a JSX mode configured.
      jsx: 4, // ReactJSX
    },
  });
  project.addSourceFilesAtPaths(path.join(fixturesDir, "*.tsx"));

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [reactFramework()],
  });

  return adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Pack-shape structural checks
// ---------------------------------------------------------------------------

describe("reactFramework — pack shape", () => {
  it("exposes component discovery via the default export", () => {
    const pack = reactFramework();
    expect(pack.name).toBe("react");
    expect(pack.discovery).toHaveLength(1);
    expect(pack.discovery[0].kind).toBe("component");
    expect(pack.discovery[0].match).toEqual({
      type: "namedExport",
      names: ["default"],
    });
  });

  it("declares a jsxReturn terminal for render outputs", () => {
    const pack = reactFramework();
    const jsxTerminal = pack.terminals.find((t) => t.kind === "render");
    expect(jsxTerminal).toBeDefined();
    expect(jsxTerminal?.match).toEqual({ type: "jsxReturn" });
  });

  it("declares componentProps input mapping at position 0", () => {
    const pack = reactFramework();
    if (pack.inputMapping.type !== "componentProps") {
      throw new Error("expected componentProps");
    }
    expect(pack.inputMapping.paramPosition).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration — run the adapter against the JSX fixtures
// ---------------------------------------------------------------------------

describe("reactFramework — integration", () => {
  let summaries: BehavioralSummary[];
  beforeAll(() => {
    summaries = runAdapter();
  }, 90_000);

  it("discovers every default-exported component", () => {
    const names = summaries.map((s) => s.identity.name).sort();
    expect(names).toEqual(["Button", "Counter", "Greeting", "Nav", "UserCard"]);
    for (const s of summaries) {
      expect(s.kind).toBe("component");
    }
  });

  it("Counter emits one Input per destructured prop (role = prop name, type resolved)", () => {
    const counter = summaries.find((s) => s.identity.name === "Counter");
    expect(counter).toBeDefined();
    const inputs = counter!.inputs;
    const byName = new Map(
      inputs.map((i) => {
        if (i.type !== "parameter") {
          throw new Error("expected parameter input");
        }
        return [i.name, i] as const;
      }),
    );
    expect([...byName.keys()].sort()).toEqual(["initial", "label", "onChange"]);
    expect(byName.get("label")?.role).toBe("label");
    expect(byName.get("initial")?.role).toBe("initial");
    expect(byName.get("onChange")?.role).toBe("onChange");

    // Types come back as named-ref TypeShapes whose `.name` is the
    // TypeScript-printed type. Exact formatting varies slightly across
    // ts-morph versions, so assert on key substrings rather than
    // exact-string match.
    const labelShape = byName.get("label")?.shape;
    expect(labelShape?.type).toBe("ref");
    if (labelShape?.type === "ref") {
      expect(labelShape.name).toContain("string");
    }
    const initialShape = byName.get("initial")?.shape;
    if (initialShape?.type === "ref") {
      expect(initialShape.name).toContain("number");
    }
    const onChangeShape = byName.get("onChange")?.shape;
    if (onChangeShape?.type === "ref") {
      expect(onChangeShape.name).toContain("=>"); // arrow-function type
    }
  });

  it("Greeting emits a single whole-object Input (non-destructured)", () => {
    const greeting = summaries.find((s) => s.identity.name === "Greeting");
    expect(greeting).toBeDefined();
    const inputs = greeting!.inputs;
    expect(inputs).toHaveLength(1);
    if (inputs[0].type !== "parameter") {
      throw new Error("expected parameter input");
    }
    expect(inputs[0].name).toBe("props");
    expect(inputs[0].role).toBe("props");
  });

  it("UserCard has two transitions: early-return-null and render div", () => {
    const userCard = summaries.find((s) => s.identity.name === "UserCard");
    expect(userCard).toBeDefined();
    const transitions = userCard!.transitions;
    // Source order: early return null first, then render path
    expect(transitions).toHaveLength(2);
    expect(transitions[0].output.type).toBe("return");
    expect(transitions[1].output.type).toBe("render");
    if (transitions[1].output.type === "render") {
      expect(transitions[1].output.component).toBe("div");
    }
    // The render path is the fall-through (no extra condition beyond
    // the implicit negation of the early return).
    expect(transitions[1].isDefault).toBe(true);
  });

  it("Nav renders a fragment (root element name is 'Fragment')", () => {
    const nav = summaries.find((s) => s.identity.name === "Nav");
    expect(nav).toBeDefined();
    expect(nav!.transitions).toHaveLength(1);
    const out = nav!.transitions[0].output;
    expect(out.type).toBe("render");
    if (out.type === "render") {
      expect(out.component).toBe("Fragment");
    }
  });

  it("Button renders a self-closing element wrapped in parens", () => {
    const button = summaries.find((s) => s.identity.name === "Button");
    expect(button).toBeDefined();
    expect(button!.transitions).toHaveLength(1);
    const out = button!.transitions[0].output;
    expect(out.type).toBe("render");
    // <button type="button">...</button> is a regular (not self-closing)
    // JSX element — exercised to confirm getTagNameNode works across
    // both shapes.
    if (out.type === "render") {
      expect(out.component).toBe("button");
    }
  });
});
